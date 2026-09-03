/**
 * Re-verificação incremental do fix (Fase 4).
 *
 * Depois de um fix, acordar a cadeia inteira para reconferir achados que o próprio
 * revisor abriu custa 15-30 min; re-verificar custa 2-5. A pergunta é estreita:
 * ESTES IDS continuam abertos?
 *
 * Fail-closed em todo caminho (mesma doutrina do P3-2 da Fase 3): id ausente ou
 * desconhecido na resposta = `open`; `closed` só vale depois de o verificador
 * independente da Fase 2 não o derrubar; e este estágio NUNCA mexe em
 * `score`/agregado/`coverage` nem emite scorecard 5/5 — aceite final sai só de
 * `runFallback` completo.
 */

/**
 * Prompt da re-verificação. Entra os achados em aberto (com o `acceptance` que
 * define fechamento) e o diff do fix; sai um objeto com `results`.
 */
export function reverificarPrompt(findings, diff) {
  const lista = findings
    .map((f) =>
      [
        `id: ${f.id}`,
        `severity: ${f.severity}`,
        `path: ${f.path}`,
        `title: ${f.title}`,
        ...(Array.isArray(f.acceptance) && f.acceptance.length
          ? ['acceptance criteria:', ...f.acceptance.map((c) => `  - ${c}`)]
          : []),
      ].join('\n'),
    )
    .join('\n---\n');
  return [
    'You reviewed this branch earlier and opened the findings below. The fixes have',
    'since been applied. Your ONLY question now: for each id, is the finding CLOSED',
    '(the acceptance criteria hold) or still OPEN?',
    '',
    '--- FINDINGS ---',
    lista,
    '--- END FINDINGS ---',
    '',
    '--- DIFF OF THE FIX ---',
    diff || '(no diff information available)',
    '--- END DIFF ---',
    '',
    'Do NOT re-review the whole diff, do NOT look for NEW findings, do NOT score.',
    'Only decide, per id, whether the acceptance criteria now hold.',
    '',
    'Output EXACTLY ONE JSON object, no prose, no markdown fences:',
    '{',
    '  "results": [',
    '    { "id": "<id>", "status": "closed", "why": "one sentence", "evidence": "file/line or command" },',
    '    { "id": "<id>", "status": "open", "why": "what still fails" }',
    '  ]',
    '}',
    'Every id listed above MUST appear exactly once. Unknown ids and new findings are',
    'ignored and treated as OPEN (fail-closed).',
  ].join('\n');
}

/** Extrator do relato de re-verificação: só objeto com `results` vale. */
export function parseReverificacao(stdout = '', stderr = '') {
  const aceita = (value) => 'results' in value;
  const candidatos = [
    ...candidatesFrom(stdout, new Set(), aceita),
    ...candidatesFrom(stderr, new Set(), aceita),
  ];
  return candidatos.at(-1) ?? null;
}

import { candidatesFrom } from './lms-reviewer-fallback.mjs';

/**
 * Aplica o relato ao scorecard. PURA e fail-closed:
 * - id sem resposta, ou id da resposta que não existe no scorecard, ou status
 *   diferente de 'closed' → `open`;
 * - `closed` que o verificador independente derrubou (CONFIRMED) volta a `open`;
 * - NUNCA altera `score`, `p0/p1/p2`, `coverage` nem acrescenta/remover achados —
 *   só anota `reverificado`/`reverificado_por` em cada achado.
 */
export function aplicarReverificacao(scorecard, results, verificados = []) {
  const resposta = new Map(
    (Array.isArray(results) ? results : [])
      .filter((r) => r && typeof r === 'object')
      .map((r) => [r.id, r]),
  );
  const derrubados = new Set(
    (Array.isArray(verificados) ? verificados : [])
      .filter((v) => v && v.verdict === 'CONFIRMED')
      .map((v) => v.id),
  );
  const findings = (scorecard.findings ?? []).map((finding) => {
    const respostaDoId = resposta.get(finding.id);
    const fechou =
      respostaDoId?.status === 'closed' && !derrubados.has(finding.id);
    return {
      ...finding,
      reverificado: fechou ? 'closed' : 'open',
      ...(respostaDoId
        ? {
            reverificado_por: respostaDoId.why ?? '',
            reverificado_evidencia: respostaDoId.evidence ?? '',
          }
        : {}),
    };
  });
  return { ...scorecard, findings };
}

// Task 4 da Fase 4: wiring com o verificador da Fase 2 — fechamento so vale
// quando o verificador independente nao derruba, e NUNCA publica scorecard.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  candidatesFrom as _candidatesFrom,
  collectHeadless,
  providerConfig,
  verificarAchados,
} from './lms-reviewer-fallback.mjs';
import { naoRastreados } from './lms-fix-escopo.mjs';

const execFile = promisify(execFileCallback);
void _candidatesFrom;

/**
 * O lote de fixes a re-verificar: linhas ainda nao consumidas, marcadas
 * fixed/claimed. Marco = da PRIMEIRA linha (cobre o lote inteiro); arquivos =
 * uniao. null = nada a re-verificar (ou linha sem marco/arquivos).
 */
export function loteDeFix(linhas, consumidas = 0) {
  const rows = (Array.isArray(linhas) ? linhas : []).slice(consumidas);
  const fixRows = rows.filter((l) => l.outcome === 'fixed' || l.outcome === 'claimed');
  if (fixRows.length === 0) return null;
  const marco = String(fixRows[0].marco ?? '').trim();
  const arquivos = [
    ...new Set(fixRows.flatMap((l) => l.arquivos ?? [])),
  ].filter((p) => typeof p === 'string' && p.trim());
  if (!marco || arquivos.length === 0) return null;
  return { marco, arquivos, total: rows.length };
}

/**
 * Roda a re-verificacao sobre o ultimo fix registrado.
 *
 * Entradas: `.lms/last.json` (achados CONFIRMED) + `.lms/fixes.jsonl` (ultima linha
 * fixed/claimed com `marco`). Falha fechada: sem marco, sem scorecard ou com
 * `LMS_VERIFY=0` → recusa (fechar sem contraditorio e o buraco).
 *
 * NUNCA grava `.lms/last.json`, NUNCA emite `accepted` — o aceite final sai so de
 * `runFallback` completo.
 */
export async function runReverificacao({
  root = process.cwd(),
  env = process.env,
  collect = collectHeadless,
} = {}) {
  if (String(env.LMS_VERIFY ?? '1') === '0') {
    const motivo = 'LMS_VERIFY=0 — fechar sem contraditorio e o buraco';
    console.error(`lms-reverificar: recusada — ${motivo}`);
    return { status: 'recusada', motivo, abertos: [], fechados: [] };
  }

  let scorecard;
  try {
    scorecard = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
  } catch (erro) {
    const motivo = `scorecard ausente ou invalido (${erro.message})`;
    console.error(`lms-reverificar: recusada — ${motivo}`);
    return { status: 'recusada', motivo, abertos: [], fechados: [] };
  }

  // P2-3 da revisao da Fase 4: runFix grava UMA linha por achado — o diff tem de
  // cobrir o LOTE inteiro (marco da PRIMEIRA linha do lote), senao os fixes
  // anteriores somem e a rodada cheia volta a ser obrigatoria. O lote comeca nas
  // linhas ainda nao consumidas por uma re-verificacao anterior.
  let linhas = [];
  let consumidas = 0;
  try {
    linhas = (await readFile(join(root, '.lms', 'fixes.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((linha) => JSON.parse(linha));
    consumidas = JSON.parse(await readFile(join(root, '.lms', 'reverificacao.json'), 'utf8')).linhasConsumidas ?? 0;
  } catch {}
  const lote = loteDeFix(linhas, consumidas);
  if (!lote) {
    const motivo = 'nenhum fix novo a re-verificar (ou linha sem marco/arquivos)';
    console.error(`lms-reverificar: recusada — ${motivo}`);
    return { status: 'recusada', motivo, abertos: [], fechados: [] };
  }

  const alvos = (scorecard.findings ?? []).filter(
    (f) => (f.verdict ?? 'CONFIRMED') === 'CONFIRMED',
  );
  if (alvos.length === 0) {
    return { status: 'ok', abertos: [], fechados: [], results: [] };
  }

  // O mesmo revisor que abriu o achado re-verifica (spec §3.1).
  const provider = alvos[0].found_by ?? scorecard.reviewer;

  // Diff do lote, limitado aos arquivos das linhas do fix.
  let diffTexto = '';
  try {
    const { stdout } = await execFile(
      'git',
      ['diff', lote.marco, '--', ...lote.arquivos],
      { cwd: root, maxBuffer: 32 * 1024 * 1024 },
    );
    diffTexto = stdout;
  } catch {}
  // Untracked criados pelo fix nao aparecem no diff: conteudo entra como bloco.
  for (const caminho of (await naoRastreados(root)).filter((p) => lote.arquivos.includes(p))) {
    try {
      const conteudo = await readFile(join(root, caminho), 'utf8');
      diffTexto += `\n--- novo arquivo: ${caminho} ---\n${conteudo}\n`;
    } catch {}
  }

  const prompt = reverificarPrompt(alvos, diffTexto);
  const saida = await collect({
    root,
    provider,
    config: providerConfig(env),
    base: scorecard.base,
    env,
    prompt,
    parse: parseReverificacao,
    promptPath: join(root, '.lms', 'reverificar-prompt.md'),
    outPath: join(root, '.lms', 'reverificar.json'),
  }).catch(() => ({ kind: 'error' }));
  const relato = saida.kind === 'ok' ? saida.candidate : null;
  const results = Array.isArray(relato?.results) ? relato.results : [];

  // Achados declarados closed passam pelo verificador da Fase 2 (so rebaixa):
  // veredito CONFIRMED = o defeito segue vivo = volta a open.
  const fechadosPeloRelato = results
    .filter((r) => r.status === 'closed' && alvos.some((a) => a.id === r.id))
    .map((r) => r.id);
  let verificados = [];
  if (fechadosPeloRelato.length > 0) {
    const mini = { ...scorecard, findings: alvos.filter((a) => fechadosPeloRelato.includes(a.id)) };
    const config = providerConfig(env);
    const verificado = await verificarAchados({
      root,
      config,
      env,
      collect,
      ordem: config.order,
      autor: '',
      provider,
      base: scorecard.base,
      changed: diffTexto,
      scorecard: mini,
      outputPathFor: () => '',
      attempts: [],
    });
    verificados = verificado.findings.map((f) => ({ id: f.id, verdict: f.verdict }));
  }

  const aplicado = aplicarReverificacao(scorecard, results, verificados);
  const fechados = aplicado.findings.filter((f) => f.reverificado === 'closed').map((f) => f.id);
  const abertos = aplicado.findings.filter((f) => f.reverificado === 'open').map((f) => f.id);

  await mkdir(join(root, '.lms'), { recursive: true });
  await writeFile(
    join(root, '.lms', 'reverificacao.json'),
    `${JSON.stringify({ at: new Date().toISOString(), reviewer: provider, results, abertos, fechados, linhasConsumidas: linhas.length }, null, 2)}\n`,
    'utf8',
  );
  return { status: 'ok', abertos, fechados, results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const resultado = await runReverificacao({ root: process.cwd(), env: process.env });
  console.log(JSON.stringify(resultado, null, 2));
  process.exitCode = resultado.status === 'ok' ? 0 : 1;
}
