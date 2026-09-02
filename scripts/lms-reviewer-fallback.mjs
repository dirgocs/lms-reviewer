import { spawn } from 'node:child_process';
import { collectOutput } from './lms-process-utils.mjs';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { scorecardError, scorecardFormError } from './lms-scorecard.mjs';
import { reviewSubject } from './lms-subject.mjs';
import { inspectionError } from './lms-inspection.mjs';
import { loadConfig, projectRoot } from './lms-config.mjs';

const execFile = promisify(execFileCallback);
const PROVIDERS = ['claude', 'grok', 'codex', 'pi'];

function envList(env, key, fallback) {
  return (env[key] ?? fallback)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function providerModels(env) {
  return {
    claude: env.LMS_CLAUDE_MODEL ?? 'claude-opus-4-8',
    grok: env.LMS_GROK_MODEL ?? 'grok-4.6',
    // sol, nunca terra: terra é tier de execução intermediária — review exige
    // modelo melhor ou do nível do autor (diretriz Master 2026-08-16).
    codex: env.LMS_CODEX_MODEL ?? 'gpt-5.6-sol',
    pi: env.LMS_PI_MODEL ?? 'z-ai/glm-5.3-flash',
  };
}

function providerBins(env) {
  return {
    claude: env.LMS_CLAUDE_BIN ?? 'claude',
    grok: env.LMS_GROK_BIN ?? 'grok',
    codex: env.LMS_CODEX_BIN ?? 'codex',
    pi: env.LMS_PI_BIN ?? 'pi',
  };
}

function timeoutMs(env) {
  const timeoutSec = Number(env.LMS_REVIEWER_TIMEOUT_SEC ?? 900);
  return Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 900_000;
}

export function providerConfig(env = process.env) {
  return {
    order: envList(env, 'LMS_REVIEWER_ORDER', 'claude,grok,codex'),
    claudeEffort: env.LMS_CLAUDE_EFFORT,
    // `xhigh`, não `high` (diretriz Master 2026-08-27). Review é o trabalho mais
    // difícil da cadeia: o revisor tem de refutar código já defendido em comentário,
    // e cada rodada perdida custa 8–20 min. Esforço a mais aqui é barato comparado
    // com achado que passa.
    codexEffort: env.LMS_CODEX_EFFORT ?? 'xhigh',
    models: providerModels(env),
    bins: providerBins(env),
    timeoutMs: timeoutMs(env),
  };
}

export function commandFor(provider, config) {
  const model = config.models[provider];
  const common = { command: config.bins[provider], input: config.prompt };
  if (provider === 'claude') {
    return {
      ...common,
      args: [
        '--model',
        model,
        // effort configurável: refutador Fable roda em medium por decisão do
        // Master (2026-08-19); default preserva o comportamento anterior
        '--effort',
        config.claudeEffort ?? 'high',
        '--print',
        '--output-format',
        'json',
        '--no-session-persistence',
        '--permission-mode',
        'plan',
        '--tools',
        'Read,Grep,Glob',
      ],
    };
  }
  if (provider === 'grok') {
    return {
      ...common,
      args: [
        '--model',
        model,
        // medium de propósito: empiricamente o grok-4.6 revisa melhor em medium
        // do que em high (decisão do Master, 2026-08-15).
        '--reasoning-effort',
        'medium',
        '--single',
        config.prompt,
        '--output-format',
        'json',
        '--permission-mode',
        'plan',
        '--tools',
        'Read,Grep,Glob',
      ],
      input: null,
    };
  }
  if (provider === 'pi') {
    return {
      command: config.bins.pi,
      args: [
        '--provider',
        process.env.LMS_PI_PROVIDER ?? 'openrouter',
        '--model',
        model,
        '--thinking',
        process.env.LMS_PI_THINKING ?? 'high',
        '--tools',
        'read,grep,find',
        '--mode',
        'json',
        '--no-session',
        '-p',
        config.prompt,
      ],
      input: null,
    };
  }
  if (provider === 'codex') {
    // `codex exec` puro, não `codex exec review`. O subcomando `review` tem schema
    // de saída próprio e ignora o prompt quando ele vem por stdin sem `-`, então
    // nunca produzia o scorecard deste projeto. O prompt vai como argumento.
    return {
      ...common,
      args: [
        'exec',
        '--model',
        model,
        '-c',
        `model_reasoning_effort="${config.codexEffort ?? 'xhigh'}"`,
        // Sandbox read-only: o codex le arquivos executando shell (cat, sed), entao
        // ele PRECISA de shell. O que nao pode e mutacao — e isso o sandbox garante,
        // melhor do que uma instrucao em prosa.
        '-s',
        'read-only',
        '--json',
        config.prompt,
      ],
      input: null,
    };
  }
  throw new Error(`unknown LMS provider: ${provider}`);
}

const DIFF_STAT_LIMIT = 12_000;

/** Artefato GERADO não é código para revisar — e pior, empurra o código humano para
 *  fora do mapa. `packages/api-db-client/generated` sozinho respondia por 168 dos 286
 *  arquivos deste diff; ordenado por caminho, ele consumia o teto de
 *  `DIFF_STAT_LIMIT` ANTES de chegar em `services/`, e os 71 arquivos do ERP e do
 *  fiscal simplesmente não apareciam para nenhum reviewer. Um mapa truncado não avisa
 *  que truncou: a cadeia parecia estar revisando tudo. */
const CAMINHOS_GERADOS = [
  ':(exclude)packages/api-db-client/generated/**',
  // Pathspec exige a '/' literal: `**/pnpm-lock.yaml` NAO casa o lockfile da RAIZ —
  // justamente o do bump de dependencia, o caso mais comum. A raiz precisa do proprio
  // padrao nos DOIS lugares (exclusao aqui, contagem do aviso abaixo).
  ':(exclude)pnpm-lock.yaml',
  ':(exclude)**/pnpm-lock.yaml',
  ':(exclude)graphify-out/**',
];

/**
 * O que mudou, para ir DENTRO do prompt.
 *
 * Nenhum reviewer tem `git`. Sem esta lista, eles não sabem o que mudou: o Grok
 * pensava "do I have a bash tool? I only have read_file, list_dir, grep", se
 * enrolava, e a chamada terminava em `stopReason: Cancelled`. Dar o mapa aqui e
 * deixar as ferramentas de leitura para abrir os arquivos resolve sem conceder
 * mutação a um reviewer.
 */
export async function diffContext(root, base) {
  const run = async (args) => {
    try {
      const { stdout } = await execFile('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
      return stdout.trim();
    } catch {
      return '';
    }
  };
  const stat = await run(['diff', '--stat', `${base}...HEAD`, '--', '.', ...CAMINHOS_GERADOS]);
  const commitados = await run([
    'diff',
    '--name-status',
    `${base}...HEAD`,
    '--',
    '.',
    ...CAMINHOS_GERADOS,
  ]);
  const log = await run(['log', '--oneline', `${base}..HEAD`]);
  const gerados = (
    await run([
      'diff',
      '--name-only',
      `${base}...HEAD`,
      '--',
      'packages/api-db-client/generated',
      'pnpm-lock.yaml',
      '**/pnpm-lock.yaml',
      'graphify-out',
    ])
  )
    .split('\n')
    .filter(Boolean).length;

  // Árvore suja e arquivos novos entram no contexto. Antes o revisor via só
  // `base...HEAD` e julgava um mapa desatualizado: foi assim que ele reportou como
  // ausente um `-s read-only` que já estava no disco. O `subject` do gate já conta
  // essas mudanças, então revisar sem elas seria bloquear por algo que ninguém viu.
  const sujos = await run(['diff', '--name-status', 'HEAD', '--', '.', ...CAMINHOS_GERADOS]);
  const novosArquivos = (await run(['ls-files', '--others', '--exclude-standard']))
    .split('\n')
    .map((linha) => linha.trim())
    .filter(Boolean);
  const novos = novosArquivos.map((caminho) => `A\t${caminho}`).join('\n');
  const names = [commitados, sujos, novos].filter(Boolean).join('\n');
  const numstat = [
    await run(['diff', '--numstat', `${base}...HEAD`, '--', '.', ...CAMINHOS_GERADOS]),
    await run(['diff', '--numstat', 'HEAD', '--', '.', ...CAMINHOS_GERADOS]),
  ]
    .filter(Boolean)
    .join('\n');
  const linhasRastreadas = numstat.split('\n').reduce((total, linha) => {
    const [adicoes, remocoes] = linha.split('\t');
    return total + (Number(adicoes) || 0) + (Number(remocoes) || 0);
  }, 0);
  const linhasNovas = (
    await Promise.all(
      novosArquivos.map(async (caminho) => {
        try {
          const conteudo = await readFile(join(root, caminho), 'utf8');
          return conteudo === ''
            ? 0
            : conteudo.split('\n').length - Number(conteudo.endsWith('\n'));
        } catch {
          return 0;
        }
      }),
    )
  ).reduce((total, linhas) => total + linhas, 0);
  const changedLines = linhasRastreadas + linhasNovas;

  const clip = (text, limit) =>
    text.length > limit ? `${text.slice(0, limit)}\n… (truncado)` : text;

  // Só o que dá para ABRIR: caminho deletado não pode ser inspecionado, então
  // exigir que ele apareça em `inspected` seria exigir o impossível.
  //
  // Rename vem como `R100<TAB>antigo<TAB>novo`: o que existe no disco é o ÚLTIMO
  // campo. Juntar tudo depois do status guardava os dois caminhos como uma string
  // só, e aí inspecionar o arquivo novo era recusado.
  const paths = new Set(
    names
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('D'))
      .map((line) => {
        const fields = line
          .split('\t')
          .map((field) => field.trim())
          .filter(Boolean);
        return fields.at(-1) ?? '';
      })
      .filter(Boolean),
  );

  // Corte silencioso lê-se como "revisei tudo". Quando o mapa não coube, ou quando
  // artefato gerado ficou de fora, o reviewer precisa SABER — é a diferença entre
  // "não há mais nada" e "não te mostrei o resto".
  const truncou = (t) => t.length > DIFF_STAT_LIMIT;
  const avisos = [
    gerados > 0
      ? `Fora do mapa de propósito: ${gerados} arquivo(s) de artefato gerado ` +
        '(packages/api-db-client/generated, lockfiles, graphify-out). Não são código ' +
        'para revisar; não os abra e não os cite em `inspected`.'
      : '',
    truncou(names) || truncou(stat)
      ? 'ATENÇÃO: a lista abaixo foi TRUNCADA no limite do prompt — existem arquivos ' +
        'alterados que ela não mostra. Trate-a como amostra, não como inventário.'
      : '',
  ].filter(Boolean);

  const text = [
    'Commits nesta branch:',
    clip(log, 4_000) || '(nenhum)',
    '',
    ...(avisos.length ? [...avisos, ''] : []),
    'Arquivos alterados (A=add M=modify D=delete) — inclui o que ainda não foi commitado:',
    clip(names, DIFF_STAT_LIMIT) || '(nenhum)',
    '',
    'Diffstat:',
    clip(stat, DIFF_STAT_LIMIT) || '(vazio)',
  ].join('\n');

  return { text, paths, changedFiles: paths.size, changedLines };
}

// Migration é append-only, e sem esta regra a cadeia não converge: o diff de uma
// branch carrega migrations que JÁ rodaram em dev e prod, o revisor as lê como
// código novo e acha defeito num arquivo que ninguém pode editar — o runner
// recusa arquivo aplicado que mudou depois. Cada rodada achava o próximo defeito
// teórico na mesma história imutável, e tratar achado nunca terminava.
// Só entra no prompt quando o projeto declara `migrationsPath` em lms.config.json.
// Sem isso a regra mandaria o revisor isentar uma pasta que não existe no repo —
// uma isenção gratuita no gate.
function regraMigrationAplicada(root = projectRoot()) {
  const { migrationsPath, dbStateGate } = loadConfig(root);
  if (!migrationsPath) return [];
  return [
    'Migrations are append-only history, not editable code. A file under',
    `${migrationsPath} may already have run on dev and prod even when it looks`,
    'new in this diff, and the runner refuses a file whose checksum changed after the',
    'fact — editing or reordering one is impossible, not merely discouraged.',
    'So: report what a NEW migration must do. A defect whose only fix is rewriting or',
    'reordering an existing migration file is out of scope — do not score it.',
    ...(dbStateGate
      ? [`The live database state is covered separately by ${dbStateGate} in CI.`]
      : []),
  ];
}

export function reviewPrompt(
  base,
  _reviewer = '<claude|grok|codex>',
  changed = '',
  outputPath = '',
) {
  // O contrato tem de ser LITERAL. A versão anterior pedia "um JSON com reviewer,
  // score, target, base..." em prosa, e os três providers falhavam na validação:
  // escreviam `reviewer: "Claude Opus 4.8"`, omitiam `base`, ou embrulhavam em cerca
  // markdown. Mostrar o objeto exato custa alguns tokens e elimina a classe de erro.
  return [
    `Review the current branch against ${base} using four lenses: code-safety,`,
    'code-structure, code-quality, code-efficiency.',
    '',
    outputPath
      ? // Na TUI o revisor GRAVA o scorecard: é o único arquivo que ele pode tocar, e é
        // também o sinal de que terminou — o runner espera esse arquivo aparecer.
        `Do NOT commit, push, open a PR, run Greptile, or change runtime state. The ONLY file you may write is ${outputPath}.`
      : 'Do NOT edit files, commit, push, open a PR, run Greptile, or change runtime state.',
    '',
    'You CAN read files with whatever tools you have (file readers, grep, or shell',
    'commands like cat/sed). The changed files are listed below — open the ones that',
    'matter before judging.',
    '',
    'Before judging code-safety: identify WHICH isolation mechanism this code path',
    'actually uses, then look for where it is missing. Do not assume. This repo has',
    'two, and they are not interchangeable: Postgres RLS bound to the JWT via',
    'get_current_tenant_id(), and — in services/fiscal/backend, which connects as the',
    'database owner and is therefore NOT subject to RLS — an explicit tenant_id filter',
    'written into every query. A finding that names the wrong mechanism is noise.',
    'The same rule applies to the other lenses: name the surface, then sweep it.',
    '',
    '--- WHAT CHANGED ---',
    changed || '(no diff information available)',
    '--- END ---',
    '',
    'Output rules — a deviation makes the review be discarded:',
    outputPath
      ? `  1. Write EXACTLY ONE JSON object to ${outputPath} — the file must contain the` +
        '     object and nothing else. No prose, no markdown fences, no ``` of any kind.'
      : '  1. Print EXACTLY ONE JSON object and nothing else. No prose before or after,' +
        ' no markdown fences, no ``` of any kind.',
    '  2. Do NOT include "reviewer", "base", "at", "autonomy" or "fallow" — the runner',
    '     fills those in. Anything you write there is overwritten.',
    '  3. "target" MUST be 5. "score" and every count MUST be integers.',
    '  4. The four lens keys MUST be exactly: "code-safety", "code-structure",',
    '     "code-quality", "code-efficiency".',
    '  5. Top-level p0/p1/p2 MUST equal the sum of the same field across the lenses.',
    '  6. "findings" MUST list EVERY distinct actionable finding (confidence >= 80)',
    '     you found in this single review — never only the worst one. Rounds are',
    '     expensive: one review reporting five findings beats five rounds reporting',
    '     one each. Different root causes are different entries.',
    '  7. "inspected" is your PROOF OF READING and is verified against disk. For each',
    '     distinct file you opened give {path, line, quote}: `line` is the 1-based line',
    '     number (a small off-by-one is tolerated) and `quote` is that line copied',
    '     VERBATIM (at least ~12 chars). At least 3 files, or all of them when the diff',
    '     has fewer. Deleted paths do not count. A quote that is not found near that line',
    '     invalidates the whole review, so copy real lines instead of guessing.',
    '  8. "coverage" declares WHAT YOU SWEPT and how much: one entry per surface,',
    '     {surface, total, inspected}. A surface is an enumerable family — "routes with',
    '     a path parameter", "queries that do not mention tenant", "changed files".',
    '     `total` is how many exist, `inspected` how many you actually opened. Sweep',
    '     the whole surface when it fits; when it does not, say the real number',
    '     instead of inflating. Declaring inspected < total is an honest, accepted',
    '     answer.',
    '  9. "verified" is the opposite of "findings": what you CHECKED and holds CORRECT,',
    '     with a quote verified on disk just like "inspected". One entry per claim:',
    '     {claim, path, line, quote}. Write specific, attackable claims ("every handler',
    '     in issuers.py resolves by (id, tenant_id)"), never vague praise ("the code is',
    '     good"). At least one entry. A second reviewer will be paid to try to knock',
    '     these claims down, so do not assert what you did not check.',
    '',
    ...regraMigrationAplicada(),
    '',
    'Scoring: count only findings with confidence >= 80 that this diff introduced.',
    'Score 5 means zero actionable findings. If you find real problems, report them and',
    'score below 5 — a low score is a valid, expected answer and blocks publication.',
    'Do NOT inflate the score to make it pass.',
    '',
    'Exact shape:',
    '{',
    '  "score": 5,',
    '  "target": 5,',
    '  "p0": 0,',
    '  "p1": 0,',
    '  "p2": 0,',
    '  "inspected": [',
    '    { "path": "path/from/the/list.ts", "line": 42, "quote": "export function foo(bar) {" },',
    '    { "path": "another/one.ts", "line": 7, "quote": "import { thing } from \'./thing\';" },',
    '    { "path": "a/third.ts", "line": 130, "quote": "const LIMIT = 12_000;" }',
    '  ],',
    '  "coverage": [',
    '    { "surface": "changed files in this diff", "total": 7, "inspected": 7 },',
    '    { "surface": "route handlers touched", "total": 3, "inspected": 3 }',
    '  ],',
    '  "verified": [',
    '    { "claim": "every handler with {id} resolves the object by (id, tenant_id)",',
    '      "path": "path/from/the/list.py", "line": 909,',
    '      "quote": "issuer = _get_issuer_or_404(issuer_id, ctx.tenant_id, db)" }',
    '  ],',
    '  "lenses": {',
    '    "code-safety": { "p0": 0, "p1": 0, "p2": 0 },',
    '    "code-structure": { "p0": 0, "p1": 0, "p2": 0 },',
    '    "code-quality": { "p0": 0, "p1": 0, "p2": 0 },',
    '    "code-efficiency": { "p0": 0, "p1": 0, "p2": 0 }',
    '  },',
    '  "findings": [',
    '    { "lens": "code-safety", "severity": "P1", "confidence": 90,',
    '      "path": "path/to/file.ts:42", "title": "short title",',
    '      "why": "why it matters", "fix": "suggested fix" }',
    '  ]',
    '}',
  ].join('\n');
}

async function mergeBase(root, candidate) {
  try {
    const { stdout } = await execFile('git', ['merge-base', 'HEAD', candidate], { cwd: root });
    return stdout.trim() ? candidate : null;
  } catch {
    return null;
  }
}

async function resolveBase(root) {
  const candidates = await Promise.all(
    ['origin/master', 'origin/main', 'master', 'main'].map((candidate) =>
      mergeBase(root, candidate),
    ),
  );
  const resolved = candidates.find(Boolean);
  if (resolved) return resolved;
  return fallbackBase(root);
}

async function fallbackBase(root) {
  try {
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD~1'], { cwd: root });
    return stdout.trim() || 'HEAD~1';
  } catch {
    return 'HEAD~1';
  }
}

function parseJsonText(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonCandidate(value) {
  if (value && typeof value === 'object') return value;
  return typeof value === 'string' ? parseJsonText(value) : null;
}

/**
 * JSONL: um objeto JSON por linha.
 *
 * `codex exec --json` transmite eventos assim (`thread.started`, `item.completed`,
 * `turn.completed`), e o scorecard vem dentro do `agent_message`. Tratar o stdout
 * inteiro como um objeto único falha, e o recorte do primeiro `{` ao último `}`
 * junta eventos distintos e não parseia — era por isso que o codex sempre dava
 * "scorecard must be a JSON object".
 */
function candidatesFromLines(value, seen, aceita = ehScorecard) {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'));
  if (lines.length < 2) return [];
  return lines.flatMap((line) => {
    const parsed = parseJsonCandidate(line);
    return parsed ? candidatesFrom(parsed, seen, aceita) : [];
  });
}

function candidatesFromText(value, seen, aceita = ehScorecard) {
  const parsed = parseJsonText(value);
  if (parsed) return candidatesFrom(parsed, seen, aceita);
  const lines = candidatesFromLines(value, seen, aceita);
  if (lines.length > 0) return lines;
  const embedded = embeddedJson(value);
  return embedded ? candidatesFrom(embedded, seen, aceita) : [];
}

function embeddedJson(value) {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  return start >= 0 && end > start ? parseJsonCandidate(value.slice(start, end + 1)) : null;
}

function nestedValues(value) {
  // `agent_message` e onde o codex poe o conteudo do turno; sem ele a varredura
  // parava em `item` e devolvia null — furo que valia para o scorecard tambem,
  // nao so para o contraditorio.
  const keys = ['result', 'message', 'content', 'text', 'last_message', 'item', 'agent_message'];
  const keyed = keys.filter((key) => key in value).map((key) => value[key]);
  return Array.isArray(value) ? [...keyed, ...value] : keyed;
}

function nestedCandidates(value, seen, aceita = ehScorecard) {
  return nestedValues(value).flatMap((item) => candidatesFrom(item, seen, aceita));
}

/** Um scorecard se reconhece por estas chaves. */
const ehScorecard = (value) => ['score', 'target', 'reviewer'].some((key) => key in value);

function ownCandidate(value, aceita) {
  return aceita(value) ? [value] : [];
}

/**
 * `aceita` diz o que conta como candidato. A varredura — aninhamento, JSONL, texto
 * com prosa em volta — vale igual para scorecard e para o veredito do contraditório:
 * os mesmos providers embrulham as duas coisas do mesmo jeito, e um parser ingênuo
 * para o contraditório o faria falhar ABERTO, mantendo o 5/5 em silêncio.
 */
function candidatesFrom(value, seen = new Set(), aceita = ehScorecard) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return candidatesFromText(value, seen, aceita);
  return objectCandidates(value, seen, aceita);
}

function objectCandidates(value, seen, aceita = ehScorecard) {
  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  return [...ownCandidate(value, aceita), ...nestedCandidates(value, seen, aceita)];
}

export function normalizeProviderOutput(stdout, stderr = '') {
  const candidates = [...candidatesFrom(stdout), ...candidatesFrom(stderr)];
  return candidates.at(-1) ?? null;
}

function runCommand({ command, args, input, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const { getStdout, getStderr } = collectOutput(child);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 250).unref();
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout: getStdout(), stderr: getStderr() });
    };
    child.on('error', (error) =>
      finish({ kind: error.code === 'ENOENT' ? 'missing-cli' : 'error', error }),
    );
    child.on('close', (code, signal) => {
      if (timedOut) finish({ kind: 'timeout', code, signal });
      else if (code !== 0) finish({ kind: 'exit', code, signal });
      else finish({ kind: 'ok', code, signal });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function writeScorecard(root, value) {
  const dir = join(root, '.lms');
  await mkdir(dir, { recursive: true });
  const temporary = join(dir, `last.json.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, join(dir, 'last.json'));
}

function telemetryData(round, estagio, provider, config, value) {
  const direct = ['p0', 'p1', 'p2'].every((key) => Number.isInteger(value?.[key]));
  const extras = Array.isArray(value?.extra_findings) ? value.extra_findings : [];
  const findings = value?.refuted === true ? [value, ...extras] : [];
  const count = (severity) => findings.filter((finding) => finding.severity === severity).length;
  const p0 = direct ? value.p0 : count('P0');
  const p1 = direct ? value.p1 : count('P1');
  const p2 = direct ? value.p2 : count('P2');
  let findingsCount = findings.length;
  if (direct) findingsCount = Array.isArray(value.findings) ? value.findings.length : p0 + p1 + p2;
  return {
    ...round,
    estagio,
    provider,
    modelo: config.models?.[provider] ?? '',
    p0,
    p1,
    p2,
    findings_count: findingsCount,
  };
}

async function logAttempt(root, provider, result, durationMs, extra = '', dados = {}) {
  const dir = join(root, '.lms');
  await mkdir(dir, { recursive: true });
  const suffix = extra ? ` ${extra}` : '';
  await appendFile(
    join(dir, 'fallback.log'),
    `${new Date().toISOString()} provider=${provider} result=${result} duration_ms=${durationMs}${suffix}\n`,
    'utf8',
  );
  await appendFile(
    join(dir, 'history.jsonl'),
    `${JSON.stringify({
      ...dados,
      provider,
      resultado: result,
      duration_ms: durationMs,
      at: new Date().toISOString(),
      // Compatibilidade com consumidores do histórico parcial anterior.
      result,
      durationMs,
    })}\n`,
    'utf8',
  );
}

const POLITICA_ATIVA = (env = process.env) => env.LMS_SEVERITY_POLICY === '1';

const CAMPANHA_PADRAO = { semanticRounds: 0, lastCount: null, stalled: 0 };

async function campanha(root) {
  try {
    return JSON.parse(await readFile(join(root, '.lms', 'severity-campaign.json'), 'utf8'));
  } catch {
    return { ...CAMPANHA_PADRAO };
  }
}

async function salvarCampanha(root, estado) {
  const dir = join(root, '.lms');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'severity-campaign.json'), JSON.stringify(estado), 'utf8');
}

async function apagarCampanha(root) {
  await rm(join(root, '.lms', 'severity-campaign.json'), { force: true });
}

/** Achado P2 válido para a fila: P2 declarada, confiança >= 80 e ACIONÁVEL.
 *
 *  Acionável exige path, título e justificativa (achado da rodada 90): a
 *  validação de forma do scorecard não olha o conteúdo dos findings, então um
 *  P2 vazio virava aceite 5/5 com uma linha inútil na fila — a saída malformada
 *  do reviewer deixava de ser rejeitada e o débito ficava intratável. Sem os
 *  três campos, o achado NÃO enfileira: cai no caminho normal e bloqueia. */
function eP2Enfileiravel(achado) {
  const severidade = String(achado?.severity ?? '')
    .trim()
    .toUpperCase();
  if (severidade !== 'P2' || Number(achado?.confidence ?? 80) < 80) return false;
  const naoVazio = (valor) => String(valor ?? '').trim().length > 0;
  if (!naoVazio(achado?.path) || !naoVazio(achado?.title) || !naoVazio(achado?.why)) return false;
  // Confiança tem de ser NÚMERO FINITO (achado da rodada 92): `Number('alto')` é
  // NaN, e `NaN < 80` é false — a checagem anterior deixava passar confiança
  // inválida. E `path` precisa de linha: sem `arquivo:linha` a dívida na fila
  // não é rastreável até o ponto do defeito.
  const confianca = Number(achado?.confidence ?? 80);
  if (!Number.isFinite(confianca)) return false;
  return /:\d+/.test(String(achado.path));
}

async function commitDeOrigem(root) {
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: root });
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Fila P2 (KDT-136 fase C): append-only, um JSON por achado. */
async function enfileirarP2(root, achados, round, commit) {
  if (achados.length === 0) return 0;
  const dir = join(root, '.lms');
  await mkdir(dir, { recursive: true });
  const linhas = achados.map((achado) =>
    JSON.stringify({
      path: achado.path ?? '',
      title: achado.title ?? '',
      lens: achado.lens ?? '',
      confidence: Number(achado.confidence ?? 80),
      // `why` e `fix` vão junto (achado da rodada 90): o achado sai do scorecard
      // ao virar aceite, então a fila passa a ser a ÚNICA memória do débito —
      // sem a justificativa e a correção sugerida, quem for pagar depois não tem
      // como saber por que aquilo era defeito.
      why: achado.why ?? '',
      fix: achado.fix ?? '',
      commit,
      round_id: round.round_id,
    }),
  );
  await appendFile(join(dir, 'p2-queue.jsonl'), `${linhas.join('\n')}\n`, 'utf8');
  return achados.length;
}

/** Identidade estável de um achado — `structuredClone` cria objetos NOVOS, então
 *  comparar por referência nunca casa (achado da rodada 91: o scorecard aceito
 *  ficava com score 5, p2=0 e os P2 ainda listados em `findings`). */
function chaveDoAchado(achado) {
  return `${achado?.path ?? ''}|${achado?.title ?? ''}|${achado?.lens ?? ''}`;
}

/** Rodada P2-only vira aceite: os P2 saem do scorecard (score volta a 5) e a fila registra. */
function neutralizarP2(scorecard, enfileirados) {
  const proximo = structuredClone(scorecard);
  const chaves = new Set(enfileirados.map(chaveDoAchado));
  proximo.findings = (proximo.findings ?? []).filter(
    (finding) => !chaves.has(chaveDoAchado(finding)),
  );
  proximo.p2 -= enfileirados.length;
  for (const achado of enfileirados) {
    const lens = LENSES.includes(achado.lens) ? achado.lens : 'code-quality';
    if (proximo.lenses[lens]) proximo.lenses[lens].p2 -= 1;
  }
  proximo.score = Math.max(proximo.score, 5);
  return proximo;
}

function childEnvironment(env, provider, base) {
  return {
    ...process.env,
    ...env,
    LMS_HOOK_SKIP: '1',
    LMS_SKIP: '1',
    LMS_REVIEWER_PROVIDER: provider,
    LMS_REVIEWER_BASE: base,
    CI: '1',
  };
}

/**
 * Veredito do fallow, obtido pelo RUNNER — não declarado pelo reviewer.
 *
 * O reviewer roda sem shell e não tem como executar o audit; pedir que ele
 * "informe o fallow" só produziria um campo inventado. Quem tem shell aqui é o
 * runner, então é ele que mede. Isso também é o que liga LMS e fallow de verdade:
 * antes o campo era opcional e um `"skipped"` deixava um 5/5 conviver com o fallow
 * bloqueando o push por regressão.
 */
async function fallowOnce(root, gate, baseline) {
  const current = join(tmpdir(), `lms-fallow-${process.pid}-${Date.now()}.json`);
  try {
    await execFile(
      'sh',
      ['-c', `pnpm exec fallow --format json --quiet > ${JSON.stringify(current)}`],
      {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const { stdout } = await execFile('node', [gate, baseline, current], { cwd: root });
    // Exit 0 não basta: o gate também sai 0 quando um dos envelopes está malformado,
    // avisando e sem comparar nada. Aprovar nesse caso seria aceitar a AUSÊNCIA de
    // medição como medição limpa. Só a confirmação explícita conta.
    return /no regression/i.test(stdout) ? 'pass' : 'regressed';
  } catch (error) {
    // Saída não-zero do GATE é regressão medida; qualquer outra falha (fallow não
    // rodou, envelope não foi escrito, processo morreu) é ausência de medição. As
    // duas bloqueiam, mas dizer qual foi é o que evita caçar regressão inexistente.
    return error?.stdout && /regress/i.test(error.stdout) ? 'regressed' : 'unmeasured';
  } finally {
    await rm(current, { force: true }).catch(() => {});
  }
}

/**
 * Veredito do fallow para o scorecard. `unmeasured` é tentado duas vezes porque já
 * houve falha transitória: o mesmo comando, reproduzido em seguida à mão, dava
 * `no regression` e exit 0 — e o push tinha sido bloqueado como se houvesse
 * regressão. Continua bloqueando (não medir não pode virar aprovação), mas agora o
 * log diz que faltou medição, não que o código piorou.
 */
async function fallowVerdict(root, { log = console.error } = {}) {
  // Caminho do gate vem de lms.config.json — era hardcoded no monorepo de origem.
  // Projeto que não configura `fallow.gate` simplesmente não tem essa medição, e
  // cai no mesmo `no-changes` que já valia quando o arquivo não existia.
  const { fallow } = loadConfig(root);
  if (!fallow.gate) return 'no-changes';
  const gate = join(root, fallow.gate);
  const baseline = join(root, fallow.baseline);
  if (!existsSync(gate) || !existsSync(baseline)) return 'no-changes';

  let outcome = await fallowOnce(root, gate, baseline);
  if (outcome === 'unmeasured') {
    log('lms: fallow não pôde ser medido; repetindo uma vez antes de bloquear…');
    outcome = await fallowOnce(root, gate, baseline);
  }
  if (outcome === 'pass') return 'pass';
  log(
    outcome === 'regressed'
      ? 'lms: fallow acusou REGRESSÃO — o código piorou contra o baseline.'
      : 'lms: fallow NÃO PÔDE SER MEDIDO duas vezes — isto não é regressão, é falta de medição.',
  );
  return 'fail';
}

/**
 * O reviewer abriu algum arquivo, ou só chutou zeros?
 *
 * O codex expôs a necessidade disto: devolvia 5/5 com `reasoning_tokens: 152`, sem
 * um único evento de ferramenta — aprovação automática vestida de revisão. Pedir a
 * lista do que ele abriu é verificável: os caminhos têm de estar entre os arquivos
 * alterados, e inventar caminho é detectável.
 *
 * O piso é `min(3, arquivos abríveis)`: um diff de um arquivo não consegue — nem
 * deveria — apresentar três, e caminho deletado não pode ser aberto (por isso
 * `changedPaths` já exclui as deleções). Contagem por caminho DISTINTO, senão
 * repetir o mesmo arquivo três vezes satisfaria a prova sem provar nada.
 */
export function stampScorecard(parsed, provider, fallow, base, extra = {}) {
  if (!parsed) return null;
  // O runner crava os fatos objetivos: quem revisou, contra qual base, quando, e o
  // que o fallow mediu. O modelo julga o codigo — nao tem relogio confiavel nem
  // shell, e ja errou `at` com data no futuro e `base` omitido.
  return {
    ...parsed,
    reviewer: provider,
    base,
    fallow,
    autonomy: 'reviewer',
    at: new Date().toISOString(),
    ...extra,
  };
}

/**
 * Coleta headless: roda o CLI do provider com o prompt no stdin e lê o JSON do stdout.
 * É uma das duas estratégias de coleta — a outra (`lms-reviewer-tmux.mjs`) dirige a TUI
 * do provider em tmux. Tudo o que vem DEPOIS de obter o candidato — prova de leitura,
 * validação de forma, veredito, gravação — é o mesmo nos dois casos e mora aqui.
 */
export async function collectHeadless({
  root,
  provider,
  config,
  base,
  prompt,
  env,
  // O extrator padrao so aceita objeto com forma de scorecard. O contraditorio tem
  // forma propria ({refuted, confidence, ...}), entao quem chama diz como ler.
  parse = normalizeProviderOutput,
}) {
  const command = commandFor(provider, { ...config, base, prompt });
  const result = await runCommand({
    ...command,
    cwd: root,
    env: childEnvironment(env, provider, base),
    timeoutMs: config.timeoutMs,
  });
  if (result.kind !== 'ok') return { kind: result.kind };
  return { kind: 'ok', candidate: parse(result.stdout, result.stderr) };
}

export async function attemptProvider({
  root,
  provider,
  config,
  base,
  prompt,
  env,
  fallow,
  changedPaths,
  collect = collectHeadless,
  subject,
  autonomy = 'reviewer',
  round,
  origemCommit = '',
}) {
  if (!PROVIDERS.includes(provider)) {
    return { accepted: false, attempt: { provider, result: 'unknown-provider' } };
  }
  const rodada = round ?? {
    round_id: randomUUID(),
    subject: subject ?? '',
    base,
    changed_files: changedPaths?.size ?? 0,
    changed_lines: 0,
  };
  const started = Date.now();
  const result = await collect({ root, provider, config, base, prompt, env });
  const durationMs = Date.now() - started;
  if (result.kind !== 'ok') {
    await logAttempt(
      root,
      provider,
      result.kind,
      durationMs,
      '',
      telemetryData(rodada, 'reviewer', provider, config),
    );
    return { accepted: false, attempt: { provider, result: result.kind, durationMs } };
  }

  const scorecard = stampScorecard(result.candidate, provider, fallow, base, { subject, autonomy });

  // Primeiro: o provider fez o trabalho? Só a FORMA importa aqui — e "fez o
  // trabalho" inclui ter aberto arquivos, não só ter emitido JSON.
  const formError =
    scorecardFormError(scorecard, { reviewer: provider, base, subject }) ??
    (scorecard ? await inspectionError(scorecard, changedPaths ?? new Set(), root) : null);
  if (formError) {
    await logAttempt(
      root,
      provider,
      'invalid-output',
      durationMs,
      `reason=${formError.replaceAll(' ', '_')}`,
      telemetryData(rodada, 'reviewer', provider, config, scorecard),
    );
    return {
      accepted: false,
      attempt: { provider, result: 'invalid-output', reason: formError, durationMs },
    };
  }

  // Política de severidade (LMS_SEVERITY_POLICY=1): P2 do reviewer com confianca >= 80
  // nao derruba o score sozinho — entra na fila e, se a rodada era P2-ONLY, vira aceite.
  // P0/P1 seguem bloqueando exatamente como antes.
  let p2Queued = 0;
  let scorecardVeredito = scorecard;
  // Os contadores NÃO são a fonte da verdade (achado da rodada 91): a validação
  // de forma não reconcilia `findings` com `p0/p1`, então um scorecard com
  // `p0:0,p1:0` e um P0/P1 real na lista passaria — a fila levaria o P2, o
  // contador zeraria e o bloqueante seria publicado como aceite. Conta e lista
  // precisam CONCORDAR que não há bloqueante.
  const bloqueanteNaLista = (achado) => {
    const bruta = String(achado?.severity ?? '')
      .trim()
      .toUpperCase();
    return bruta === 'P0' || bruta === 'P1';
  };
  if (
    POLITICA_ATIVA(env) &&
    Array.isArray(scorecard.findings) &&
    scorecard.p0 === 0 &&
    scorecard.p1 === 0 &&
    !scorecard.findings.some(bloqueanteNaLista)
  ) {
    const p2s = scorecard.findings.filter(eP2Enfileiravel);
    if (p2s.length > 0) {
      p2Queued = await enfileirarP2(root, p2s, rodada, origemCommit);
      scorecardVeredito = neutralizarP2(scorecard, p2s);
    }
  }

  const verdictError = scorecardError(scorecardVeredito, { reviewer: provider, base, subject });

  // Reprovacao vai para o disco na hora: ela BLOQUEIA, entao persistir e seguro e
  // util. Aceite NAO: enquanto o contraditorio roda — minutos — um 5/5 gravado seria
  // lido pelo gate e liberaria o push sem a segunda opiniao, que e exatamente o que
  // o contraditorio existe para impedir. Quem grava o aceite e o runFallback, depois
  // que a refutacao falha em derruba-lo.
  if (verdictError) {
    await writeScorecard(root, scorecardVeredito);
    await logAttempt(
      root,
      provider,
      'rejected',
      durationMs,
      `reason=${verdictError.replaceAll(' ', '_')}`,
      {
        ...telemetryData(rodada, 'reviewer', provider, config, scorecard),
        score: scorecard.score,
        autonomy: scorecard.autonomy,
      },
    );
    return {
      accepted: false,
      rejected: true,
      scorecard: scorecardVeredito,
      attempt: { provider, result: 'rejected', reason: verdictError, durationMs },
    };
  }

  await logAttempt(root, provider, 'accepted', durationMs, `score=${scorecardVeredito.score}`, {
    ...telemetryData(rodada, 'reviewer', provider, config, scorecardVeredito),
    score: scorecardVeredito.score,
    autonomy: scorecard.autonomy,
  });
  return {
    accepted: true,
    scorecard: scorecardVeredito,
    p2Queued,
    attempt: { provider, result: 'accepted', durationMs },
  };
}

/**
 * Qual modelo escreveu o diff. O SKILL manda revisor ≠ autor, mas o runner nunca
 * aplicou: o claude revisou vários diffs escritos pelo claude — o mesmo raciocínio
 * que produziu o defeito julgando o defeito, só que em outra sessão.
 *
 * A detecção é por variável de ambiente do próprio CLI, então funciona sem ninguém
 * configurar nada; `LMS_AUTHOR` sobrescreve quando a inferência não serve.
 */
export function authorProvider(env = process.env) {
  if (env.LMS_AUTHOR) return env.LMS_AUTHOR.trim();
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  if (env.CODEX_HOME || env.CODEX_SANDBOX) return 'codex';
  if (env.GROK_HOME || env.GROK_SESSION_ID) return 'grok';
  return '';
}

const LENSES = ['code-safety', 'code-structure', 'code-quality', 'code-efficiency'];

/**
 * Prompt do contraditório. A cadeia para no PRIMEIRO scorecard válido, então um
 * aceite frouxo publica sem que ninguém olhe de novo — e o custo de discordar é
 * zero para quem aprova. Aqui um segundo provider é pago para DERRUBAR o 5/5.
 *
 * O pedido é assimétrico de propósito: quem refuta precisa apontar defeito concreto
 * com caminho e linha. "Não gostei" não derruba nada.
 */
/**
 * Le o veredito do contraditorio com a MESMA varredura do scorecard.
 *
 * Um parser ingenuo aqui falharia aberto: com o JSONL do codex ou o embrulho do
 * claude, o objeto viria null, `derrubou` seria false e o 5/5 se manteria em
 * silencio — contraditorio que falha aberto e pior que nao ter contraditorio.
 */
export function parseRefutation(stdout = '', stderr = '') {
  const aceita = (value) => 'refuted' in value;
  const candidatos = [
    ...candidatesFrom(stdout, new Set(), aceita),
    ...candidatesFrom(stderr, new Set(), aceita),
  ];
  return candidatos.at(-1) ?? null;
}

export function refutePrompt(base, provider, changed, outputPath = '') {
  return [
    `Um revisor deu 5/5 para as mudancas desta branch contra ${base} — ou seja,`,
    'declarou que nao ha nenhum achado acionavel. Seu trabalho e tentar DERRUBAR esse',
    'veredito, nao confirma-lo.',
    '',
    'Procure defeito real: bug, furo de seguranca, contrato quebrado, caso de borda',
    'ignorado, teste ausente para logica nova. Abra os arquivos antes de julgar.',
    '',
    ...regraMigrationAplicada(),
    '',
    '--- WHAT CHANGED ---',
    changed || '(no diff information available)',
    '--- END ---',
    '',
    'Regras de saida:',
    outputPath
      ? `  1. Escreva EXATAMENTE UM objeto JSON em ${outputPath}, e nada mais.`
      : '  1. Imprima EXATAMENTE UM objeto JSON e nada mais.',
    '  2. "refuted" true SO se voce tem defeito concreto com confianca >= 80.',
    '     Nao encontrar defeito e uma resposta legitima e esperada: responda false.',
    '  3. Quando refutar, "path" (com linha), "severity" e "why" sao OBRIGATORIOS: sem',
    '     defeito concreto apontado, seu veredito nao derruba nada — alegacao vazia',
    '     nao bloqueia mudanca sa. "title", "fix", "confidence" e "lens" sao desejaveis.',
    '  4. Se a sua alegacao puder ser demonstrada por um comando (suite que falha,',
    '     lint que acusa, build que quebra), inclua "proof": {"command": "...",',
    '     "expect": "fail"|"pass"}. O runner RODA esse comando: se o resultado nao',
    '     bater com o esperado, sua refutacao cai. Comandos aceitos sao os gates do',
    '     projeto (pnpm test*, pnpm lint, node --test scripts/...).',
    '  5. "inspected" e sua PROVA DE LEITURA e e conferida no disco, exatamente como',
    '     a do reviewer: para cada arquivo aberto de {path, line, quote}, com a linha',
    '     copiada VERBATIM. Sem prova valida, um veredito de CONFIRMACAO nao conta',
    '     como segunda opiniao. Um achado de REFUTACAO sem inspected so vale se vier',
    '     completo — severity, why e path com :linha real de um arquivo do diff — e',
    '     essa exigencia vale para cada item de extra_findings tambem.',
    '  6. Encontrou MAIS DE UM defeito? O mais grave vai nos campos do topo e CADA UM',
    '     dos demais vira um item de "extra_findings" ({severity, path, title, why,',
    '     fix}). Liste TODOS nesta unica rodada — rodada e cara, e um defeito que voce',
    '     viu e nao reportou vai custar uma rodada inteira depois.',
    '',
    'Forma exata:',
    '{',
    '  "refuted": false,',
    '  "confidence": 0,',
    '  "severity": "P0" | "P1" | "P2",',
    `  "lens": "${LENSES.join('" | "')}",`,
    '  "path": "caminho/do/arquivo.ts:42",',
    '  "title": "resumo em uma linha",',
    '  "why": "por que isto e um defeito real",',
    '  "inspected": [',
    '    { "path": "arquivo/do/diff.ts", "line": 42, "quote": "linha copiada verbatim" }',
    '  ],',
    '  "extra_findings": [',
    '    { "severity": "P2", "path": "outro/arquivo.ts:7", "title": "resumo",',
    '      "why": "por que e defeito", "fix": "como corrigir" }',
    '  ]',
    '}',
    `Voce e o provider "${provider}".`,
  ].join('\n');
}

/**
 * Aplica a refutacao ao scorecard: o 5/5 vira 4 com o achado do refutador somado a
 * lente e ao agregado. Precisa somar certo, senao o proprio validador recusa por
 * inconsistencia — e a refutacao viraria "scorecard invalido" em vez de reprovacao.
 */
export function applyRefutation(scorecard, refutation, contexto = {}) {
  const { changedPaths, root = process.cwd() } = contexto;
  const proximo = structuredClone(scorecard);
  proximo.score = Math.min(proximo.score, 4);
  // Todos os achados da rodada entram no scorecard — o principal e os
  // extra_findings. Um defeito visto e nao registrado custava uma rodada
  // inteira depois (era o gargalo nº 1 de eficiencia da cadeia).
  // Cada extra passa pelo MESMO crivo do achado principal: obrigatorios,
  // confianca >= 80 e ancora path:linha num arquivo do diff — sem isso um
  // P0 alucinado em arquivo inexistente viraria achado oficial (achado LMS).
  const extras = (Array.isArray(refutation.extra_findings) ? refutation.extra_findings : []).filter(
    (extra) =>
      camposAusentes(extra, REFUTACAO_OBRIGATORIOS).length === 0 &&
      confiancaDe(extra) >= 80 &&
      ancoradoNoDiff(extra, changedPaths, root),
  );
  for (const achado of [refutation, ...extras]) {
    const lens = LENSES.includes(achado.lens) ? achado.lens : 'code-quality';
    // Severidade REAL e normalizada: 'p2'/'low'/'P3' viravam P1 e inflavam o
    // agregado (achado do LMS) — desconhecido cai para P2, o peso conservador.
    const bruta = String(achado.severity ?? '')
      .trim()
      .toUpperCase();
    const severity = ['P0', 'P1', 'P2'].includes(bruta) ? bruta : 'P2';
    const campo = severity.toLowerCase();
    proximo.lenses[lens][campo] += 1;
    proximo[campo] += 1;
    proximo.findings = [
      ...(proximo.findings ?? []),
      {
        lens,
        severity,
        confidence: achado.confidence ?? 80,
        path: achado.path ?? '',
        title: achado.title ?? 'refutacao do contraditorio',
        why: achado.why ?? '',
        refutedBy: refutation.refutedBy,
      },
    ];
  }
  return proximo;
}

/**
 * Contraditório: um segundo provider e pago para DERRUBAR o 5/5.
 *
 * Vive fora do runFallback de proposito — inline, o laco da cadeia passou do limite
 * de complexidade do fallow, e um gate que engorda o codigo que ele mesmo mede e
 * autofagia.
 */

/**
 * Traduz o que o refutador devolveu em UM desfecho.
 *
 * `upheld` significa "olhou, provou que leu, e nao achou defeito" — so isso. Timeout,
 * CLI ausente, veredito malformado, prova invalida ou confianca abaixo do piso NAO
 * sao concordancia; registra-los como tal inventaria consenso e corromperia o unico
 * sinal que o historico existe para dar.
 */

/**
 * Refutacao so derruba com defeito CONCRETO: caminho, titulo e porque.
 *
 * Sem isto, `{refuted:true, confidence:80, inspected:[...]}` bloqueava uma mudanca sa
 * — o gate ficava indisponivel por alegacao vazia, que e o espelho do problema que a
 * prova de leitura resolve do outro lado.
 */

/**
 * Comandos que uma refutacao pode pedir para provar sua alegacao.
 *
 * Lista fechada de proposito: o comando vem da SAIDA DE UM MODELO, e executar shell
 * arbitrario a partir dali seria entregar a maquina a quem escreve o veredito. Tudo
 * fora da lista e tratado como nao verificavel, nao como erro.
 */
const PROVAS_PERMITIDAS = [
  /^pnpm test(:[\w-]+)?$/,
  /^pnpm --filter [\w@/-]+ (test|lint|typecheck|gate|build)$/,
  /^pnpm (lint|dox-check|check:erp)$/,
  /^node --test scripts\/[\w.-]+$/,
  /^node scripts\/[\w.-]+(\.mjs|\.js)$/,
];

/**
 * Verifica a alegacao da refutacao rodando o comando que ela mesma indicou.
 *
 * Existe porque uma refutacao ALUCINADA bloqueava indefinidamente: o codex afirmou
 * "a suite tem oito falhas" sobre uma suite que passava 34/34, e nao havia como
 * contestar — a palavra do refutador era final. Alegacao mecanica agora se prova
 * sozinha ou nao vale.
 *
 * Devolve: 'confirmada' | 'derrubada' | 'nao-verificavel'.
 */
async function verificarProva(root, prova, env = process.env) {
  const comando = String(prova?.command ?? '').trim();
  const esperado = String(prova?.expect ?? '').trim();
  if (!comando || !['fail', 'pass'].includes(esperado)) return 'nao-verificavel';
  if (!PROVAS_PERMITIDAS.some((padrao) => padrao.test(comando))) return 'nao-verificavel';

  try {
    // Roda no MESMO ambiente da revisao: uma prova executada noutro contexto pode
    // passar ou falhar por motivo que nada tem a ver com o codigo em julgamento.
    await execFile('sh', ['-c', comando], {
      cwd: root,
      env: { ...process.env, ...env },
      timeout: 10 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return esperado === 'pass' ? 'confirmada' : 'derrubada';
  } catch {
    return esperado === 'fail' ? 'confirmada' : 'derrubada';
  }
}

/**
 * Obrigatorio vs secundario num achado de refutacao (KDT-94).
 *
 * Aproveitavel = da para agir: `refuted`, `severity`, `path`, `why` e `inspected`.
 * `fix`, `title`, `confidence` e `lens` ausentes viram AVISO — nao destroem o
 * achado. Antes, `title` ausente rebaixava a refutacao a weak-refute e um furo de
 * autorizacao real foi descartado em silencio enquanto o gate culpava a ferramenta.
 */
const REFUTACAO_OBRIGATORIOS = ['severity', 'path', 'why'];
const REFUTACAO_SECUNDARIOS = ['fix', 'title', 'confidence', 'lens'];

function camposAusentes(veredito, campos) {
  return campos.filter((campo) => String(veredito?.[campo] ?? '').trim().length === 0);
}

/** O achado com os campos que vieram — e so eles. */
function resumoAchado(veredito) {
  return [
    veredito?.severity && `[${veredito.severity}]`,
    veredito?.path,
    veredito?.title,
    veredito?.why,
  ]
    .filter(Boolean)
    .join(' — ');
}

/**
 * Payload incompleto com conteudo real e o OPOSTO de lixo: ha achado para tratar.
 * Misturar os dois num so `invalid-output` fazia o operador reagir "a ferramenta
 * quebrou" — e o conteudo mais valioso da revisao morria sem ser lido.
 */
function classificarVeredito(kind, veredito, provaInvalida, derrubou, faltando, temConteudo) {
  if (kind !== 'ok') return kind;
  if (!veredito || typeof veredito.refuted !== 'boolean') return 'invalid-output';
  if (veredito.refuted && faltando.length > 0 && temConteudo) return 'payload-incompleto';
  if (provaInvalida) return 'invalid-output';
  if (derrubou) return 'refuted';
  return veredito.refuted ? 'weak-refute' : 'upheld';
}

/**
 * O achado e MOSTRADO ao operador, com o que veio; o que faltou vira aviso. E isto
 * que transforma "refutador falhou, tenta de novo" em "ha um defeito para tratar".
 */
function imprimirAchado(refutador, veredito, avisos, faltando, log = console.error) {
  log(`lms: achado do refutador (${refutador}): ${resumoAchado(veredito)}`);
  if (String(veredito?.fix ?? '').trim()) log(`lms:   fix sugerido: ${veredito.fix}`);
  for (const extra of Array.isArray(veredito?.extra_findings) ? veredito.extra_findings : []) {
    log(`lms:   achado adicional: ${resumoAchado(extra)}`);
    if (String(extra?.fix ?? '').trim()) log(`lms:     fix: ${extra.fix}`);
  }
  if (faltando.length > 0) log(`lms:   payload incompleto — faltou: ${faltando.join(', ')}`);
  if (avisos.length > 0)
    log(`lms:   aviso — sem campo secundario: ${avisos.join(', ')} (nao invalida o achado)`);
}

/**
 * Quem nao conseguiu nem rodar nesta rodada esta fora: insistir nele troca segunda
 * opiniao por outra falha. Quem devolveu lixo uma vez continua elegivel.
 */
export function escolherRefutador({ ordem, attempts, provider, autor, env = process.env }) {
  const naoRodou = new Set(
    attempts
      .filter((tentativa) => ['timeout', 'exit', 'missing-cli', 'error'].includes(tentativa.result))
      .map((tentativa) => tentativa.provider),
  );
  const elegivel = (outro) => outro !== provider && outro !== autor && !naoRodou.has(outro);
  const usados = new Set(attempts.map((tentativa) => tentativa.provider));
  const cruzado = ordem.find((outro) => elegivel(outro) && !usados.has(outro)) ?? ordem.find(elegivel);
  if (cruzado) return cruzado;
  // Exceção EXPLÍCITA (decisão do Master, 2026-08-27, sob apagão de cota dupla —
  // grok no limite semanal e OpenAI na janela de 5h): o mesmo provedor pode
  // refutar a si quando é o ÚNICO vivo E a env opta. Contexto novo ainda dá valor
  // adversarial real (o prompt manda DERRUBAR), mas os pontos cegos correlacionam —
  // por isso nunca é o padrão, e o desfecho fica carimbado `de=<provider>` no log,
  // visível na auditoria. Sem a env, o aceite continua morrendo `sem-refutador`,
  // que é o fail-closed correto.
  if (env.LMS_REFUTADOR_MESMO_PROVIDER === '1' && !naoRodou.has(provider)) return provider;
  return undefined;
}

/**
 * Traduz o JSON do refutador em veredito: o que faltou, o que so avisa, e se a
 * alegacao tem forca para derrubar o aceite.
 *
 * Vive separado de `contestar` porque sao dois assuntos: aqui e julgamento do
 * conteudo, la e orquestracao (escolher quem, chamar, registrar, gravar).
 */
/**
 * `inspected` invalido NAO descarta um achado concreto cujo path aponta um
 * arquivo DESTE diff: severity+path:linha+why especificos ja sao evidencia de
 * leitura equivalente, e o desfecho antigo (`payload-incompleto`) bloqueava
 * igual mas queimava a rodada — ~40% das rodadas do refutador morriam nesse
 * detalhe de schema, o gargalo nº 2 de eficiencia da cadeia. Refutacao SEM
 * achado concreto continua exigindo a prova. Sem mapa de diff (fixture, base
 * exotica) a ancora degrada para existencia no disco, mesma tolerancia da
 * prova de leitura.
 */
function ancoradoNoDiff(veredito, changedPaths, root) {
  const bruto = String(veredito?.path ?? '').trim();
  // rsplit: só o ÚLTIMO ':' separa a linha — imune a qualquer ':' futuro no path
  const idx = bruto.lastIndexOf(':');
  const pathDoAchado = (idx > 0 ? bruto.slice(0, idx) : bruto).trim();
  const linha = Number(idx > 0 ? bruto.slice(idx + 1) : NaN);
  // `arquivo.ts` seco nao ancora: sem :linha valida DENTRO do arquivo, um
  // `{path, why:"parece errado"}` vago derrubaria o gate sem nenhuma
  // evidencia de leitura (achado do LMS sobre a propria regra).
  if (!pathDoAchado || !Number.isInteger(linha) || linha < 1) return false;
  const noDiff = changedPaths?.size
    ? changedPaths.has(pathDoAchado)
    : existsSync(join(root, pathDoAchado));
  if (!noDiff) return false;
  try {
    const total = readFileSync(join(root, pathDoAchado), 'utf8').split('\n').length;
    return linha <= total;
  } catch {
    return false;
  }
}

// Confianca AUSENTE nao e confianca zero: quem afirma defeito com severity,
// path e why esta alegando com convicao — o default fica no piso.
function confiancaDe(veredito) {
  return String(veredito?.confidence ?? '').trim() === '' ? 80 : Number(veredito.confidence);
}

async function avaliarRefutacao({ root, env, veredito, provaInvalida, changedPaths }) {
  const alegou = veredito?.refuted === true;
  const obrigatoriosFaltando = alegou ? camposAusentes(veredito, REFUTACAO_OBRIGATORIOS) : [];
  // A ancora so supre inspected AUSENTE. Inspected PRESENTE e invalido e
  // citacao inventada — mentira comprovada nao ganha passe livre (achado LMS).
  const trouxeInspected = Array.isArray(veredito?.inspected) && veredito.inspected.length > 0;
  const achadoAncoradoNoDiff =
    alegou &&
    obrigatoriosFaltando.length === 0 &&
    !trouxeInspected &&
    ancoradoNoDiff(veredito, changedPaths, root);
  const faltando = alegou
    ? [...obrigatoriosFaltando, ...(provaInvalida && !achadoAncoradoNoDiff ? ['inspected'] : [])]
    : [];
  const avisos = alegou ? camposAusentes(veredito, REFUTACAO_SECUNDARIOS) : [];
  // Conteudo real = apontou ONDE (`path`) ou POR QUE (`why`). `title` NAO conta:
  // titulo e rotulo, nao evidencia, e `payload-incompleto` BLOQUEIA. Se um titulo
  // solto bastasse, `{refuted:true, title:"..."}` — o que um modelo devolve quando
  // nao tem nada a dizer — travaria a publicacao em vez de cair em weak-refute,
  // que e o desfecho certo para alegacao vazia. O contraditorio pegou exatamente
  // isso: transformar saida vazia de modelo em indisponibilidade do gate.
  const temConteudo = alegou && camposAusentes(veredito, ['path', 'why']).length < 2;

  const alegaDefeito = alegou && faltando.length === 0 && confiancaDe(veredito) >= 80;

  // Apelacao: alegacao mecanica se prova sozinha ou nao vale. Sem isto, uma refutacao
  // alucinada bloqueia para sempre — aconteceu: "a suite tem oito falhas" sobre uma
  // suite que passava 34/34, sem nenhuma forma de contestar.
  const prova = alegaDefeito ? await verificarProva(root, veredito.proof, env) : 'nao-verificavel';
  return {
    faltando,
    avisos,
    temConteudo,
    derrubou: alegaDefeito && prova !== 'derrubada',
    prova,
    ancorado: achadoAncoradoNoDiff,
  };
}

/**
 * Prova mecanica dos extras roda ANTES de persistir (achado do LMS): um extra
 * com `proof` desmentida pelo proprio comando nao vira achado oficial.
 */
async function extrasComprovados(root, env, veredito) {
  const extras = Array.isArray(veredito.extra_findings) ? veredito.extra_findings : [];
  const validos = [];
  for (const extra of extras) {
    if (extra?.proof && (await verificarProva(root, extra.proof, env)) === 'derrubada') continue;
    validos.push(extra);
  }
  return validos;
}

/** Política de severidade no CONTRADITÓRIO: P2 do refutador (principal ou extras
 *  válidos) não derruba o aceite — enfileira. Basta um P0/P1 (conf ≥80) no
 *  veredito inteiro para derrubar como hoje. Extraída de `contestar` (fallow:
 *  ciclomática 24 → a função-mãe volta ao teto). */
async function politicaDeSeveridadeDoContraditorio({
  root,
  env,
  veredito,
  derrubou,
  desfecho,
  round,
  origemCommit,
  provaDerrubada = false,
}) {
  if (!POLITICA_ATIVA(env) || !veredito) {
    return { p2Queued: 0, derrubouEfetivo: derrubou, desfecho };
  }
  const extrasValidos = await extrasComprovados(root, env, veredito);
  const todos = [veredito, ...extrasValidos];
  // P2 mecanicamente DESMENTIDO não vira dívida (achado da rodada 91): quando a
  // própria prova do achado o contradiz (`prova === 'derrubada'`), enfileirá-lo
  // gravaria débito falso — e sem a prova, que a fila não guarda, ele pareceria
  // legítimo depois.
  const achadosP2 = provaDerrubada ? [] : todos.filter(eP2Enfileiravel);
  // O contrato do bloqueante é o MESMO do refutador (achado da rodada 91):
  // REFUTACAO_OBRIGATORIOS é severity+path+why — `title` é secundário. Exigir
  // título aqui rebaixava um P1 legítimo sem título quando vinha acompanhado de
  // um P2 completo: a política zerava `derrubou` e o 5/5 original ia ao ar.
  const temBloqueante = todos.some((achado) => {
    const bruta = String(achado?.severity ?? '')
      .trim()
      .toUpperCase();
    if (bruta !== 'P0' && bruta !== 'P1') return false;
    if (confiancaDe(achado) < 80) return false;
    return camposAusentes(achado, REFUTACAO_OBRIGATORIOS).length === 0;
  });
  if (achadosP2.length === 0 || temBloqueante) {
    return { p2Queued: 0, derrubouEfetivo: derrubou, desfecho };
  }
  const p2Queued = await enfileirarP2(root, achadosP2, round, origemCommit);
  // Achado P2 registrado, nao derrubou: o desfecho 'refuted' (calculado antes
  // da politica) diria ao aceite que o contraditorio derrubou — e liberaria
  // uncontested. P2 julgado e arquivado e 'weak-refute': julgou, nao derrubou.
  return {
    p2Queued,
    derrubouEfetivo: false,
    desfecho: desfecho === 'refuted' ? 'weak-refute' : desfecho,
  };
}

/** Piloto Pi em SOMBRA (KDT-136): roda ALÉM do refutador real quando LMS_PI_SHADOW=1.
 *  O veredito da sombra NÃO decide nada — grava a própria linha no history.jsonl
 *  (estágio 'refutador-sombra') para comparar providers antes de migrar. */
async function rodarSombraDoRefutador({
  collectShadow,
  env,
  root,
  config,
  base,
  changed,
  refutador,
  round,
  attempts,
  changedPaths,
}) {
  if (!collectShadow || env.LMS_PI_SHADOW !== '1') return;
  // Teto PRÓPRIO, curto (achado da rodada 91): a sombra herdava o timeout cheio
  // de reviewer e ficava no caminho crítico da publicação — um piloto que não
  // decide nada podia somar mais 15 min a TODA rodada bem-sucedida. Estourou o
  // teto? A telemetria da sombra se perde; o desfecho real nunca espera por ela.
  const tetoSombra = Number(env.LMS_PI_SHADOW_TIMEOUT_SEC ?? 180) * 1000;
  const iniciouSombra = Date.now();
  // O teto vai no CONFIG, não numa corrida de promessas (achado da rodada 92):
  // `Promise.race` só para de esperar — o processo do Pi continuaria vivo com o
  // timer de 15 min dele, segurando o runner até lá. Quem mata o filho é o
  // runCommand, pelo timeoutMs que ele recebe.
  const contraSombra = await collectShadow({
    root,
    provider: 'pi',
    config: { ...config, timeoutMs: tetoSombra },
    base,
    prompt: refutePrompt(base, 'pi', changed, ''),
    env,
    parse: parseRefutation,
  });
  const durationSombra = Date.now() - iniciouSombra;
  const vereditoSombra = contraSombra.kind === 'ok' ? contraSombra.candidate : null;
  let resultadoSombra = contraSombra.kind;
  if (vereditoSombra) {
    // MESMO contrato do refutador real (achado da rodada 92): sem isto, um
    // `{refuted:false}` seco — sem prova de leitura, sem campos — entrava no
    // histórico como "segunda opinião que sustentou", e um payload malformado
    // entrava como refutação. O piloto existe para COMPARAR providers; medir a
    // sombra com régua mais frouxa que a do titular torna a comparação inútil.
    const provaInvalidaSombra = await inspectionError(vereditoSombra, changedPaths ?? new Set(), root);
    const faltandoSombra = camposAusentes(vereditoSombra, REFUTACAO_OBRIGATORIOS);
    if (provaInvalidaSombra || faltandoSombra.length > 0) {
      resultadoSombra = 'shadow-invalid-output';
    } else {
      resultadoSombra = vereditoSombra.refuted === true ? 'shadow-refuted' : 'shadow-upheld';
    }
  }
  await logAttempt(root, 'pi', resultadoSombra, durationSombra, `de=${refutador} sombra`, {
    ...telemetryData(round, 'refutador-sombra', 'pi', config, vereditoSombra),
    modelo: env.LMS_PI_MODEL ?? 'gpt-5.6-sol',
    sombraDe: refutador,
  });
  attempts.push({ provider: 'pi', result: resultadoSombra, durationMs: durationSombra });
}

async function contestar({
  root,
  config,
  env,
  collect,
  ordem,
  autor,
  provider,
  base,
  changed,
  outputPathFor,
  attempts,
  scorecard,
  changedPaths,
  round,
  origemCommit = '',
  collectShadow = null,
}) {
  const refutador = escolherRefutador({ ordem, attempts, provider, autor });

  if (!refutador) {
    return { derrubou: false, refutador: null, desfecho: 'sem-refutador' };
  }

  const iniciou = Date.now();
  const contra = await collect({
    root,
    provider: refutador,
    config,
    base,
    prompt: refutePrompt(base, refutador, changed, outputPathFor(refutador)),
    env,
    parse: parseRefutation,
  });
  const durationMs = Date.now() - iniciou;

  const veredito = contra.kind === 'ok' ? contra.candidate : null;
  // A prova de leitura vale para o refutador tambem. Sem ela, um `{refuted:false}`
  // seco — de quem nao abriu arquivo nenhum — contaria como segunda opiniao e
  // liberaria o push: contraditorio de fachada e pior que nenhum, porque parece
  // rigor. Mesma verificacao do reviewer, mesmo arquivo de regras.
  const provaInvalida = veredito
    ? await inspectionError(veredito, changedPaths ?? new Set(), root)
    : 'sem veredito';

  const { faltando, avisos, temConteudo, derrubou, prova, ancorado } = await avaliarRefutacao({
    root,
    env,
    veredito,
    provaInvalida,
    changedPaths,
  });
  // A ancora no diff supre a prova de leitura tambem na classificacao — senao o
  // mesmo achado que 'derrubou' aprovou morreria aqui como invalid-output.
  let desfecho =
    prova === 'derrubada'
      ? 'refutacao-nao-comprovada'
      : classificarVeredito(
          contra.kind,
          veredito,
          provaInvalida && !ancorado,
          derrubou,
          faltando,
          temConteudo,
        );

  if (desfecho === 'refuted' || desfecho === 'payload-incompleto') {
    imprimirAchado(refutador, veredito, avisos, faltando);
  }

  const politica = await politicaDeSeveridadeDoContraditorio({
    root,
    env,
    veredito,
    derrubou,
    desfecho,
    round,
    origemCommit,
    provaDerrubada: prova === 'derrubada',
  });
  const { p2Queued, derrubouEfetivo } = politica;
  desfecho = politica.desfecho;

  await logAttempt(root, refutador, desfecho, durationMs, `de=${provider}`, {
    ...telemetryData(round, 'refutador', refutador, config, veredito),
    refuted: derrubouEfetivo,
    contested: provider,
  });
  attempts.push({ provider: refutador, result: desfecho, durationMs });

  await rodarSombraDoRefutador({
    collectShadow,
    env,
    root,
    config,
    base,
    changed,
    refutador,
    round,
    attempts,
    changedPaths,
  });

  if (!derrubouEfetivo) {
    return {
      derrubou: false,
      refutador,
      desfecho,
      faltando,
      achado: desfecho === 'payload-incompleto' ? resumoAchado(veredito) : undefined,
      p2Queued,
    };
  }

  // O 5/5 vira 4 com o achado somado e o scorecard gravado passa a BLOQUEAR: deixar
  // o aceite no disco liberaria o push seguinte e a refutacao seria decorativa.
  await writeScorecard(
    root,
    applyRefutation(
      scorecard,
      {
        ...veredito,
        extra_findings: await extrasComprovados(root, env, veredito),
        refutedBy: refutador,
      },
      { changedPaths, root },
    ),
  );
  return {
    derrubou: true,
    refutador,
    titulo: resumoAchado(veredito) || 'defeito encontrado',
    p2Queued,
    // Quantos defeitos ESTA refutação trouxe — é o número que mede o plateau da
    // campanha quando quem derruba é o contraditório (rodada 92).
    totalAchados: 1 + (await extrasComprovados(root, env, veredito)).length,
  };
}

/**
 * Tres desfechos sem segunda opiniao, tres reacoes — e a mensagem diz qual (KDT-94):
 * refutador nao respondeu (destravar e re-rodar), lixo irrecuperavel (re-rodar, nada
 * foi perdido), achado com payload incompleto (LER o achado e tratar o codigo). A
 * mensagem antiga tratava os tres como um so e induzia ao bypass exatamente quando
 * havia achado real em aberto.
 */
function motivoSemSegundaOpiniao(provider, { desfecho, refutador, faltando = [], achado }) {
  const prefixo = `aceite de ${provider} sem segunda opiniao (contraditorio: ${desfecho}).`;
  if (desfecho === 'payload-incompleto') {
    return `${prefixo} O refutador (${refutador}) ENCONTROU um possivel defeito, mas o payload veio sem: ${faltando.join(', ')}. Achado preservado: ${achado}. Leia o achado e trate o codigo — nao use LMS_ALLOW_UNCONTESTED para descartar um achado real.`;
  }
  if (desfecho === 'invalid-output') {
    return `${prefixo} O refutador (${refutador}) respondeu, mas sem veredito aproveitavel — nenhum achado foi perdido. Re-rode a cadeia. LMS_ALLOW_UNCONTESTED=1 segue sendo assuncao consciente de risco.`;
  }
  return `${prefixo} O refutador nao chegou a responder — nenhum achado foi perdido. Destrave o refutador (CLI, timeout, elegibilidade) e re-rode. LMS_ALLOW_UNCONTESTED=1 segue sendo assuncao consciente de risco.`;
}

/**
 * Desfecho de um aceite: ele so publica se o contraditorio TIVER JULGADO.
 *
 * Vive fora do laco porque inline ele estourou o limite de complexidade do fallow —
 * gate que engorda o codigo que ele mede e autofagia.
 */
// Desfecho de um aceite: ele so publica se o contraditorio TIVER JULGADO.
//
// Vive fora do laco porque inline ele estourou o limite de complexidade do fallow —
// gate que engorda o codigo que ele mede e autofagia.
async function resolverAceite({ root, env, provider, attempt, attempts, contraditorio }) {
  if (contraditorio.derrubou) {
    // Rodada derrubada pelo CONTRADITÓRIO também é rodada semântica (achado da
    // rodada 91): contava só a reprovação do revisor primário, então campanhas
    // decididas pelo refutador nunca chegavam ao plateau/teto e a escalada
    // prometida ao Master nunca disparava.
    const escalada = await avaliarCampanhaAposRejeicao({
      root,
      env,
      attempt,
      totalAchados: contraditorio.totalAchados ?? 1,
    });
    return {
      ok: false,
      rejectedBy: contraditorio.refutador,
      reason: `contraditorio derrubou o 5/5 de ${provider}: ${contraditorio.titulo}`,
      ...(escalada ? { escalated: true, escalationReason: escalada } : {}),
      attempts,
    };
  }

  // "Olhou e nao derrubou" libera. "Nao consegui olhar" — timeout, CLI ausente,
  // veredito malformado, ninguem elegivel — nao e concordancia: e ausencia de segunda
  // opiniao, e sem ela nao se publica. Mesmo principio que vale para o fallow.
  const julgou = ['upheld', 'weak-refute', 'refutacao-nao-comprovada'].includes(
    contraditorio.desfecho,
  );
  if (!julgou && env.LMS_ALLOW_UNCONTESTED !== '1') {
    return {
      ok: false,
      uncontested: true,
      reason: motivoSemSegundaOpiniao(provider, contraditorio),
      attempts,
    };
  }

  // So agora o aceite vira arquivo: antes disto o gate leria um 5/5 sem contraditorio
  // e liberaria o push na janela em que ele ainda rodava.
  await writeScorecard(root, attempt.scorecard);
  if (POLITICA_ATIVA(env)) await apagarCampanha(root);
  const p2Queued = (attempt.p2Queued ?? 0) + (contraditorio.p2Queued ?? 0);
  return {
    ok: true,
    acceptedBy: provider,
    contestedBy: contraditorio.refutador,
    attempts,
    p2Queued,
  };
}

export async function runFallback({
  root = process.cwd(),
  base,
  env = process.env,
  collect = collectHeadless,
  collectShadow = null,
  // Coleta por arquivo (tmux) precisa dizer ao revisor ONDE gravar; a headless lê o
  // stdout e não tem destino. Uma função por provider mantém as duas no mesmo caminho.
  outputPathFor = () => '',
} = {}) {
  const resolvedBase = base ?? (await resolveBase(root));
  const config = providerConfig(env);
  const {
    text: changed,
    paths: changedPaths,
    changedFiles,
    changedLines,
  } = await diffContext(root, resolvedBase);
  const fallow = await fallowVerdict(root);
  const subject = await reviewSubject(root, resolvedBase);
  const round = {
    round_id: randomUUID(),
    subject,
    base: resolvedBase,
    changed_files: changedFiles,
    changed_lines: changedLines,
  };
  const attempts = [];
  const origemCommit = POLITICA_ATIVA(env) ? await commitDeOrigem(root) : '';

  // Autor fora da cadeia. Se sobrar ninguém, revisa mesmo assim — mas o scorecard
  // sai marcado `self`, que é a categoria fraca e aparece em voz alta no gate, em
  // vez de se disfarçar de revisão independente.
  const autor = authorProvider(env);
  const independentes = config.order.filter((provider) => provider !== autor);
  const ordem = independentes.length > 0 ? independentes : config.order;
  const autonomy = independentes.length > 0 ? 'reviewer' : 'self';
  if (autonomy === 'self') {
    console.error(
      `lms: nenhum revisor independente de "${autor}" disponivel — scorecard sai como self`,
    );
  }

  for (const provider of ordem) {
    // Prompt por provider: o validador exige `reviewer` igual ao nome do provider,
    // então o prompt tem de dizer qual string usar.
    const prompt = reviewPrompt(resolvedBase, provider, changed, outputPathFor(provider));
    const attempt = await attemptProvider({
      root,
      provider,
      config,
      base: resolvedBase,
      prompt,
      env,
      fallow,
      changedPaths,
      collect,
      subject,
      autonomy,
      round,
      origemCommit,
    });
    attempts.push(attempt.attempt);
    if (attempt.accepted) {
      const contraditorio = await contestar({
        root,
        config,
        env,
        collect,
        ordem,
        autor,
        provider,
        base: resolvedBase,
        changed,
        outputPathFor,
        attempts,
        scorecard: attempt.scorecard,
        changedPaths,
        round,
        origemCommit,
        collectShadow,
      });
      return resolverAceite({ root, env, provider, attempt, attempts, contraditorio });
    }

    // Reprovação é veredito, não falha: encerra a cadeia. Continuar seria
    // "shopping" por um reviewer que aprove.
    if (attempt.rejected) {
      const escalada = await avaliarCampanhaAposRejeicao({ root, env, attempt });
      if (escalada) {
        return { ok: false, rejectedBy: provider, escalated: true, reason: escalada, attempts };
      }
      return { ok: false, rejectedBy: provider, reason: attempt.attempt.reason, attempts };
    }
  }
  return { ok: false, acceptedBy: null, attempts };
}

/** Convergência por severidade (KDT-136): só rodada SEMÂNTICA conta para
 *  plateau/teto — falha técnica de provider nunca chega aqui (só rejected).
 *  Teto NUNCA libera P0/P1 pendente: escalonamento é para o Master, não passe.
 *  Devolve o motivo da escalada, ou null para reprovar normalmente. Extraída de
 *  `runFallback` (fallow: ciclomática 15 → a função-mãe volta ao teto). */
async function avaliarCampanhaAposRejeicao({ root, env, attempt, totalAchados = null }) {
  if (!POLITICA_ATIVA(env)) return null;
  const estado = await campanha(root);
  estado.semanticRounds += 1;
  // `totalAchados` explícito para a rodada derrubada pelo CONTRADITÓRIO (achado
  // da rodada 92): ali o `attempt` é o do revisor ACEITO, cujos contadores são
  // zero — medir o plateau por eles registrava 0 em toda rodada do refutador e
  // escalava na terceira, mesmo com os achados dele diminuindo de verdade.
  const total =
    totalAchados ?? attempt.scorecard.p0 + attempt.scorecard.p1 + attempt.scorecard.p2;
  estado.stalled = estado.lastCount !== null && total >= estado.lastCount ? estado.stalled + 1 : 0;
  estado.lastCount = total;
  await salvarCampanha(root, estado);
  let motivo = null;
  if (estado.semanticRounds >= 4) {
    motivo = 'teto de 4 rodadas semânticas — ESCALAR AO MASTER (teto nunca libera P0/P1 pendente)';
  } else if (estado.stalled >= 2) {
    motivo = 'plateau de 2 rodadas sem melhora — ESCALAR AO MASTER (teto nunca libera P0/P1 pendente)';
  }
  if (motivo) console.error(`lms: ${motivo}`);
  return motivo;
}

/**
 * Traduz o desfecho da cadeia para quem le no terminal. Compartilhado pelos dois
 * runners porque a mensagem ERRADA custa caro: dizer "todos falharam" quando um
 * revisor aceitou manda a pessoa rodar a cadeia de novo em vez de destravar o
 * refutador. Duplicar isso em dois arquivos ja tinha comecado a divergir.
 */
export function reportarDesfecho(result, prefixo) {
  if (result.ok) {
    console.log(`${prefixo}: accepted by ${result.acceptedBy}`);
    if (result.p2Queued > 0) {
      console.log(
        `${prefixo}: ${result.p2Queued} achado P${result.p2Queued > 1 ? '2s' : '2'} enfileirado${result.p2Queued > 1 ? 's' : ''} em .lms/p2-queue.jsonl`,
      );
    }
    return 0;
  }
  if (result.uncontested) {
    console.error(`${prefixo}: ${result.reason}`);
    return 1;
  }
  if (result.rejectedBy) {
    // Distinguir importa: aqui o reviewer FUNCIONOU e reprovou. Ler isto como
    // "reviewer quebrado" foi o que mascarou o problema por muito tempo.
    console.error(`${prefixo}: ${result.rejectedBy} rejected the change — ${result.reason}`);
    console.error(`${prefixo}: scorecard written to .lms/last.json; address the findings.`);
    return 1;
  }
  console.error(`${prefixo}: nenhum revisor produziu scorecard valido`);
  for (const attempt of result.attempts ?? []) {
    console.error(
      `  ${attempt.provider}: ${attempt.result}${attempt.reason ? ` — ${attempt.reason}` : ''}`,
    );
  }
  return 1;
}

async function main() {
  const result = await runFallback({ root: process.cwd(), base: undefined, env: process.env });
  process.exitCode = reportarDesfecho(result, 'lms-reviewer-fallback');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
