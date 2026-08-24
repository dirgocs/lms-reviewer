import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commandFor,
  providerConfig,
  runFallback,
} from './lms-reviewer-fallback.mjs';

const base = 'origin/master';

const fakeProvider = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

const provider = process.env.LMS_REVIEWER_PROVIDER;
const mode = process.env['FAKE_' + provider.toUpperCase() + '_MODE'] || 'valid';
appendFileSync(process.env.FAKE_CALL_LOG, provider + '\\n');

if (mode === 'exit') process.exit(17);
if (mode === 'timeout') await new Promise(() => {});
// O prompt chega por stdin (claude, grok) OU como argumento (codex, cujo \`exec\`
// ignora stdin sem \`-\`). O fake precisa olhar os dois, senao o contraditorio no
// codex nunca reconhece que esta sendo chamado para refutar.
// Leitura SINCRONA do fd 0: com listeners assincronos ha corrida — se o stdin ja
// terminou antes de o 'end' ser registrado, a promessa nunca resolve e o fake trava
// ate o timeout. readFileSync nao tem esse buraco.
let doStdin = '';
try { doStdin = readFileSync(0, 'utf8'); } catch {}
const prompt = doStdin || process.argv.slice(2).join(' ');

const provaDeLeitura = [
  { path: 'a.ts', line: 1, quote: 'export const alpha = 1; // linha citada' },
  { path: 'b.ts', line: 1, quote: 'export const bravo = 2; // linha citada' },
  { path: 'c.ts', line: 1, quote: 'export const charlie = 3; // linha citada' },
];

// O prompt do contraditorio pede para DERRUBAR o 5/5. O fake responde o que um
// refutador honesto responde por padrao: olhei, provo que li, e nao achei defeito.
// Regra por prefixo em vez de lista: cada modo novo de refutacao ja entrou aqui
// esquecido duas vezes, e o sintoma era o fake responder 'nao achei defeito'.
if (prompt.includes('DERRUBAR') && !mode.startsWith('refute')) {
  console.log(JSON.stringify({ refuted: false, confidence: 0, inspected: provaDeLeitura }));
  process.exit(0);
}

// Refutador que alega defeito E indica como prova-lo. O runner roda o comando: se o
// resultado nao bater com o esperado, a refutacao cai.
if (prompt.includes('DERRUBAR') && mode === 'refute-com-prova') {
  console.log(JSON.stringify({
    refuted: true, confidence: 95, severity: 'P1', lens: 'code-quality',
    path: 'a.ts:1', title: 'alegacao que se prova sozinha', why: 'a suite quebra',
    inspected: provaDeLeitura,
    proof: { command: 'node scripts/prova.mjs', expect: 'fail' },
  }));
  process.exit(0);
}

// Refutador que alega defeito sem apontar nenhum: prova de leitura valida, mas
// nem path, nem title, nem why.
if (prompt.includes('DERRUBAR') && mode === 'refute-vazio') {
  console.log(JSON.stringify({ refuted: true, confidence: 90, inspected: provaDeLeitura }));
  process.exit(0);
}

// Refutador que nao abriu arquivo nenhum: veredito seco, sem prova.
if (prompt.includes('DERRUBAR') && mode === 'refute-sem-prova') {
  console.log(JSON.stringify({ refuted: false, confidence: 0 }));
  process.exit(0);
}

// Refutador que achou defeito real mas o payload veio sem um campo OBRIGATORIO
// (severity). O achado nao pode ser descartado em silencio (KDT-94).
if (prompt.includes('DERRUBAR') && mode === 'refute-incompleto') {
  console.log(JSON.stringify({
    refuted: true, confidence: 95,
    path: 'a.ts:1', why: 'furo de autorizacao real, com prova de leitura',
    inspected: provaDeLeitura,
  }));
  process.exit(0);
}

// Refutador que mandou so o essencial: sem fix, title, confidence e lens. Campo
// secundario ausente nao pode destruir o achado (KDT-94).
if (prompt.includes('DERRUBAR') && mode === 'refute-so-essencial') {
  console.log(JSON.stringify({
    refuted: true, severity: 'P1',
    path: 'a.ts:1', why: 'caso de borda ignorado na logica nova',
    inspected: provaDeLeitura,
  }));
  process.exit(0);
}
// Refutador com achado COMPLETO mas sem prova de leitura: o path do achado
// aponta arquivo do diff — ancora suficiente, a rodada nao pode ser queimada.
if (prompt.includes('DERRUBAR') && mode === 'refute-ancorado-sem-inspected') {
  console.log(JSON.stringify({
    refuted: true, confidence: 95, severity: 'P1', lens: 'code-safety',
    path: 'a.ts:1', title: 'defeito concreto sem prova de leitura',
    why: 'furo real apontado com arquivo e linha do diff',
  }));
  process.exit(0);
}
// Refutador que encontrou VARIOS defeitos numa rodada: principal + extras.
if (prompt.includes('DERRUBAR') && mode === 'refute-com-extras') {
  console.log(JSON.stringify({
    refuted: true, confidence: 95, severity: 'P1', lens: 'code-quality',
    path: 'a.ts:1', title: 'principal', why: 'defeito principal',
    inspected: provaDeLeitura,
    extra_findings: [
      { severity: 'P0', lens: 'code-safety', path: 'b.ts:1', title: 'extra grave', why: 'segundo defeito' },
      { severity: 'P2', path: 'c.ts:1', title: 'extra menor', why: 'terceiro defeito' },
    ],
  }));
  process.exit(0);
}
// Refutador com achado completo mas prova de leitura INVENTADA: quote que nao
// existe no arquivo. Mentira comprovada nao pode virar refutacao valida.
if (prompt.includes('DERRUBAR') && mode === 'refute-inspected-falso') {
  console.log(JSON.stringify({
    refuted: true, confidence: 95, severity: 'P1', lens: 'code-safety',
    path: 'a.ts:1', title: 'achado com prova falsa', why: 'alegacao com citacao inventada',
    inspected: [{ path: 'a.ts', line: 1, quote: 'linha que nao existe no arquivo' }],
  }));
  process.exit(0);
}
// Refutador que mandou SO titulo, com prova de leitura valida. Titulo e rotulo,
// nao evidencia: nao pode virar payload-incompleto, que bloqueia.
if (prompt.includes('DERRUBAR') && mode === 'refute-so-titulo') {
  console.log(JSON.stringify({
    refuted: true, title: 'algo parece errado', inspected: provaDeLeitura,
  }));
  process.exit(0);
}
// Modo do contraditorio: devolve o veredito de refutacao em vez de um scorecard.
if (mode === 'refute') {
  console.log(JSON.stringify({
    refuted: true, confidence: 95, severity: 'P1', lens: 'code-quality',
    path: 'a.ts:1', title: 'defeito que o primeiro reviewer nao viu',
    why: 'contraditorio encontrou caso de borda ignorado',
    inspected: provaDeLeitura,
  }));
  process.exit(0);
}
if (mode === 'invalid') {
  console.log('not-json');
  process.exit(0);
}

const score = mode === 'low' ? 4 : 5;
const inspected = mode === 'no-inspection'
  ? []
  : [
      { path: 'a.ts', line: 1, quote: 'export const alpha = 1; // linha citada' },
      { path: 'b.ts', line: 1, quote: 'export const bravo = 2; // linha citada' },
      { path: 'c.ts', line: 1, quote: 'export const charlie = 3; // linha citada' },
    ];
const zeroLens = { p0: 0, p1: 0, p2: 0 };
console.log(JSON.stringify({
  reviewer: provider,
  score,
  target: 5,
  base: process.env.LMS_REVIEWER_BASE,
  p0: 0,
  p1: 0,
  p2: 0,
  lenses: {
    'code-safety': zeroLens,
    'code-structure': zeroLens,
    'code-quality': zeroLens,
    'code-efficiency': zeroLens,
  },
  at: new Date().toISOString(),
  inspected,
}));
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lms-fallback-'));
  const bin = join(root, 'fake-provider.mjs');
  const log = join(root, 'calls.log');
  // A prova de leitura e conferida contra o disco, entao os arquivos citados pelo
  // fake precisam existir de verdade.
  await writeFile(join(root, 'a.ts'), 'export const alpha = 1; // linha citada\n', 'utf8');
  await writeFile(join(root, 'b.ts'), 'export const bravo = 2; // linha citada\n', 'utf8');
  await writeFile(join(root, 'c.ts'), 'export const charlie = 3; // linha citada\n', 'utf8');
  // Script que a "prova" da refutacao executa. O exit vem do ambiente, entao o teste
  // decide se a alegacao se sustenta ou se desmente sozinha.
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(
    join(root, 'scripts', 'prova.mjs'),
    'process.exit(Number(process.env.FAKE_PROVA_EXIT ?? 0));\n',
    'utf8',
  );
  await writeFile(bin, fakeProvider, 'utf8');
  await chmod(bin, 0o755);
  const env = {
    LMS_CLAUDE_BIN: bin,
    LMS_GROK_BIN: bin,
    LMS_CODEX_BIN: bin,
    LMS_REVIEWER_ORDER: 'claude,grok,codex',
    LMS_REVIEWER_TIMEOUT_SEC: '1',
    FAKE_CALL_LOG: log,
  };
  return { root, env, log };
}

test('builds exact High commands for all providers', () => {
  const config = providerConfig({
    LMS_CLAUDE_MODEL: 'claude-opus-4-8',
    LMS_GROK_MODEL: 'grok-4.6',
    LMS_CODEX_MODEL: 'gpt-5.6-sol',
  });

  assert.deepEqual(commandFor('claude', { ...config, base, prompt: 'review' }).args, [
    '--model', 'claude-opus-4-8', '--effort', 'high',
    '--print', '--output-format', 'json', '--no-session-persistence',
    '--permission-mode', 'plan', '--tools', 'Read,Grep,Glob',
  ]);
  assert.deepEqual(commandFor('grok', { ...config, base, prompt: 'review' }).args, [
    '--model', 'grok-4.6', '--reasoning-effort', 'medium', '--single', 'review',
    '--output-format', 'json', '--permission-mode', 'plan', '--tools', 'Read,Grep,Glob',
  ]);
  const codex = commandFor('codex', { ...config, base, prompt: 'review' });
  assert.equal(codex.args.includes('gpt-5.6-sol'), true);
  assert.equal(codex.args.includes('model_reasoning_effort="high"'), true);
  assert.equal(codex.args.includes('-'), false);
});

test('falls back from Claude failure to Grok and stops on accepted 5/5', async () => {
  const { root, env, log } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit' },
    });
    assert.equal(result.acceptedBy, 'grok');
    // O contraditorio chama um TERCEIRO provider para tentar derrubar o 5/5. O fake
    // devolve scorecard (sem `refuted`), entao o aceite se mantem — mas o codex e
    // chamado, e e isso que distingue aceite contestado de aceite sozinho.
    assert.equal(result.contestedBy, 'codex');
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['claude', 'grok', 'codex']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed output falls through, but a low score STOPS the chain', async () => {
  // Antes isto esperava que score baixo caisse para o proximo provider — e era
  // exatamente o defeito: reprovacao legitima virava "reviewer quebrado", os tres
  // "falhavam" e o push passava. Reprovacao encerra a cadeia; continuar seria
  // procurar quem aprove.
  const { root, env, log } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: {
        ...env,
        FAKE_CLAUDE_MODE: 'invalid',
        FAKE_GROK_MODE: 'low',
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.rejectedBy, 'grok');
    assert.equal(result.acceptedBy, undefined);
    // codex nunca e chamado: o grok ja deu o veredito.
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['claude', 'grok']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a review that opened no files is discarded as invalid output', async () => {
  // O codex expos esta necessidade: devolvia 5/5 com reasoning_tokens=152 e zero
  // ferramentas. Sem prova de leitura, o parecer nao vale.
  const { root, env, log } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'no-inspection', FAKE_GROK_MODE: 'no-inspection', FAKE_CODEX_MODE: 'no-inspection' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.rejectedBy, undefined);
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.result),
      ['invalid-output', 'invalid-output', 'invalid-output'],
    );
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['claude', 'grok', 'codex']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('falls through timeout and unavailable provider to Codex', async () => {
  const { root, env, log } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: {
        ...env,
        FAKE_CLAUDE_MODE: 'timeout',
        LMS_GROK_BIN: join(root, 'missing-grok'),
      },
    });
    // claude deu timeout e o grok nem existe: sobra o proprio codex, que aceitou.
    // Sem refutador elegivel nao ha segunda opiniao — e sem ela nao se publica, pelo
    // mesmo principio que vale para o fallow. O override consciente existe e e alto.
    assert.equal(result.ok, false);
    assert.equal(result.uncontested, true);
    assert.match(result.reason ?? '', /sem-refutador/);
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['claude', 'codex']);

    // Com o override, o mesmo cenario publica — deliberadamente.
    const comOverride = await runFallback({
      root,
      base,
      env: {
        ...env,
        FAKE_CLAUDE_MODE: 'timeout',
        LMS_GROK_BIN: join(root, 'missing-grok'),
        LMS_ALLOW_UNCONTESTED: '1',
      },
    });
    assert.equal(comOverride.acceptedBy, 'codex');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Prepara um scorecard já existente e roda a cadeia — o par que os dois testes de
 *  sobrescrita compartilham. */
async function withExistingScorecard(previous, modes) {
  const { root, env } = await fixture();
  const scorecardPath = join(root, '.lms', 'last.json');
  await mkdir(join(root, '.lms'), { recursive: true });
  await writeFile(scorecardPath, previous, 'utf8');
  const result = await runFallback({ root, base, env: { ...env, ...modes } });
  return { root, scorecardPath, result };
}

test('blocks and preserves an existing scorecard when every provider fails', async () => {
  const { root, scorecardPath, result } = await withExistingScorecard('{"previous":"valid"}', {
    FAKE_CLAUDE_MODE: 'exit',
    FAKE_GROK_MODE: 'invalid',
    FAKE_CODEX_MODE: 'invalid',
  });
  try {
    assert.equal(result.acceptedBy, null);
    assert.equal(result.ok, false);
    assert.equal(await readFile(scorecardPath, 'utf8'), '{"previous":"valid"}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a rejection OVERWRITES an older scorecard', async () => {
  // Preservar um scorecard aprovado antigo enquanto o reviewer atual reprova seria o
  // pior caso: o gate leria o antigo e liberaria o push. O veredito novo manda.
  const { root, scorecardPath, result } = await withExistingScorecard('{"previous":"approved"}', {
    FAKE_CLAUDE_MODE: 'low',
  });
  try {
    assert.equal(result.rejectedBy, 'claude');
    const written = JSON.parse(await readFile(scorecardPath, 'utf8'));
    assert.equal(written.score, 4);
    assert.equal(written.reviewer, 'claude');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inspection floor adapts to the diff size and paths must belong to it', async () => {
  // Cobertura detalhada da prova (citacao fabricada, aspas, off-by-one) vive em
  // lms-inspection.test.mjs. Aqui fica o que e especifico do runner: o piso desce
  // para diffs pequenos, e caminho fora do diff e recusado.
  const { inspectionError } = await import('./lms-inspection.mjs');
  const root = await mkdtemp(join(tmpdir(), 'lms-inspect-'));
  try {
    await writeFile(join(root, 'only.ts'), 'const primeira = "linha real aqui";\n', 'utf8');
    await writeFile(join(root, 'a.ts'), 'const alpha = "conteudo verdadeiro";\n', 'utf8');
    await writeFile(join(root, 'b.ts'), 'const bravo = "outro conteudo real";\n', 'utf8');
    await writeFile(join(root, 'c.ts'), 'const charlie = "terceiro conteudo";\n', 'utf8');

    const one = { path: 'only.ts', line: 1, quote: 'const primeira = "linha real aqui";' };
    assert.equal(await inspectionError({ inspected: [one] }, new Set(['only.ts']), root), null);

    const threeFiles = new Set(['a.ts', 'b.ts', 'c.ts']);
    const three = [
      { path: 'a.ts', line: 1, quote: 'const alpha = "conteudo verdadeiro";' },
      { path: 'b.ts', line: 1, quote: 'const bravo = "outro conteudo real";' },
      { path: 'c.ts', line: 1, quote: 'const charlie = "terceiro conteudo";' },
    ];
    assert.equal(await inspectionError({ inspected: three }, threeFiles, root), null);

    // Mesmo arquivo repetido nao vira tres.
    assert.match(
      (await inspectionError({ inspected: [three[0], three[0], three[0]] }, threeFiles, root)) ?? '',
      /at least 3 distinct/,
    );

    // Contexto nao substitui cobertura: citar dois arquivos do diff mais um de fora
    // (aqui um caminho deletado) nao fecha o piso de tres. Ler fora do diff passou a
    // ser permitido — o que nao pode e usar isso para cobrir menos do diff.
    assert.match(
      (await inspectionError(
        { inspected: [three[0], three[1], { path: 'gone.ts', line: 1, quote: 'qualquer coisa longa' }] },
        threeFiles,
        root,
      )) ?? '',
      /must cover at least 3 changed file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


/** Le `.lms/history.jsonl` — os dois testes do contraditorio precisam do mesmo. */
async function historico(root) {
  const bruto = await readFile(join(root, '.lms', 'history.jsonl'), 'utf8');
  return bruto.trim().split('\n').map((linha) => JSON.parse(linha));
}

test('o contraditorio derruba um 5/5 e o scorecard gravado passa a bloquear', async () => {
  const { root, env } = await fixture();
  try {
    // claude falha, grok aceita 5/5, codex entra como contraditorio e refuta.
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute' },
    });

    assert.equal(result.ok, false, 'refutacao com confianca >= 80 deve bloquear');
    assert.equal(result.rejectedBy, 'codex');
    assert.match(result.reason ?? '', /contraditorio derrubou/);

    // O que fica no disco tem de BLOQUEAR: deixar o aceite gravado liberaria o push
    // na tentativa seguinte, e a refutacao teria sido decorativa.
    const gravado = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
    assert.equal(gravado.score, 4);
    assert.equal(gravado.p1, 1);
    assert.equal(gravado.lenses['code-quality'].p1, 1);
    assert.equal(gravado.findings.at(-1).refutedBy, 'codex');

    // E o historico registra o desfecho, que e o sinal para ver reviewer complacente.
    assert.equal((await historico(root)).some((linha) => linha.result === 'refuted'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('achado concreto ancorado no diff derruba mesmo sem inspected', async () => {
  const { root, env } = await fixture();
  try {
    // Antes isto virava payload-incompleto: bloqueava igual, mas queimava a
    // rodada e o estado ficava "sem segunda opiniao". Achado com severity,
    // path (arquivo do diff) e why especificos E evidencia de leitura.
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute-ancorado-sem-inspected' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.rejectedBy, 'codex');
    assert.equal((await historico(root)).some((linha) => linha.result === 'refuted'), true);
    const gravado = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
    assert.equal(gravado.score, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inspected inventado nao ganha o passe da ancora', async () => {
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute-inspected-falso' },
    });
    // bloqueia (fail-closed), mas NAO como refutacao valida: prova falsa
    // detectada nao pode gravar scorecard de refutacao.
    assert.equal(result.ok, false);
    assert.equal((await historico(root)).some((l) => l.result === 'refuted'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extra_findings entram todos no scorecard numa unica rodada', async () => {
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute-com-extras' },
    });
    assert.equal(result.ok, false);
    const gravado = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
    // principal (P1 quality) + extra P0 safety + extra P2 (severidade REAL)
    const refutados = gravado.findings.filter((f) => f.refutedBy === 'codex');
    assert.equal(refutados.length, 3, 'todos os achados da rodada persistem');
    assert.equal(gravado.p0, 1);
    assert.equal(gravado.lenses['code-safety'].p0, 1);
    assert.equal(gravado.p1, 1);
    assert.equal(gravado.p2, 1, 'P2 permanece P2 — nao e promovido');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('falha do contraditorio bloqueia e nao vira consenso no historico', async () => {
  const { root, env } = await fixture();
  try {
    // grok aceita; o contraditorio (codex) nem roda — binario ausente.
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', LMS_CODEX_BIN: join(root, 'missing-codex') },
    });

    // Nao conseguir segunda opiniao BLOQUEIA: o mesmo principio do fallow — nao medir
    // nao vira aprovacao. Liberar aqui seria fail-open no unico ponto que existe para
    // impedir que um aceite passe sozinho.
    assert.equal(result.ok, false, 'sem segunda opiniao nao se publica');
    assert.equal(result.uncontested, true);
    assert.match(result.reason ?? '', /sem segunda opiniao/);
    // Caso 1 de KDT-94: refutador NAO RESPONDEU — a mensagem diz isso e diz que
    // nenhum achado foi perdido, em vez de induzir ao bypass.
    assert.match(result.reason ?? '', /nao chegou a responder/);
    const contraditorio = (await historico(root)).at(-1);
    assert.equal(contraditorio.provider, 'codex');
    assert.notEqual(contraditorio.result, 'upheld', 'CLI ausente nao e concordancia');
    assert.equal(contraditorio.result, 'missing-cli');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refutador sem prova de leitura nao conta como segunda opiniao', async () => {
  const { root, env } = await fixture();
  try {
    // O codex entra como contraditorio e responde `{refuted:false}` seco, sem ter
    // aberto arquivo nenhum. Isso NAO pode autorizar: contraditorio de fachada e
    // pior que nenhum, porque parece rigor.
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute-sem-prova' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.uncontested, true);
    assert.match(result.reason ?? '', /invalid-output/);
    // Caso 2 de KDT-94: respondeu lixo irrecuperavel — nao havia achado no payload,
    // e a mensagem diz isso em vez de deixar duvida sobre conteudo perdido.
    assert.match(result.reason ?? '', /nenhum achado foi perdido/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('campo secundario ausente nao destroi a refutacao: o achado derruba o 5/5', async () => {
  const { root, env } = await fixture();
  try {
    // O refutador mandou so o essencial: refuted, severity, path, why, inspected.
    // Sem fix, title, confidence e lens — e o achado vale mesmo assim: confianca
    // ausente assume o piso, lens e title tem default. Antes isto virava weak-refute
    // e o conteudo era descartado em silencio.
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute-so-essencial' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.rejectedBy, 'codex');
    assert.match(result.reason ?? '', /contraditorio derrubou/);
    assert.match(result.reason ?? '', /a\.ts:1/, 'o achado aparece com os campos que vieram');
    const gravado = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
    assert.equal(gravado.score, 4);
    assert.equal(gravado.findings.at(-1).refutedBy, 'codex');
    assert.equal((await historico(root)).at(-1).result, 'refuted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('payload incompleto preserva o achado, bloqueia e diz o que fazer', async () => {
  const { root, env } = await fixture();
  try {
    // Caso 3 de KDT-94: o refutador ENCONTROU algo mas faltou `severity`
    // (obrigatorio). Continua fail-closed — mas o desfecho e distinto de lixo e a
    // mensagem carrega o achado, em vez de culpar a ferramenta e induzir ao bypass.
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute-incompleto' },
    });
    assert.equal(result.ok, false, 'payload incompleto continua bloqueando');
    assert.equal(result.uncontested, true);
    assert.match(result.reason ?? '', /payload-incompleto/);
    assert.match(result.reason ?? '', /ENCONTROU/);
    assert.match(result.reason ?? '', /veio sem: severity/);
    assert.match(result.reason ?? '', /furo de autorizacao real/, 'o achado e mostrado ao operador');
    assert.equal((await historico(root)).at(-1).result, 'payload-incompleto');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refutacao so com titulo nao bloqueia: titulo e rotulo, nao evidencia', async () => {
  const { root, env } = await fixture();
  try {
    // Achado do contraditorio sobre o proprio KDT-94: como `payload-incompleto`
    // BLOQUEIA, aceitar titulo como "conteudo real" transformaria a saida vazia
    // tipica de um modelo — {refuted:true, title:"..."} — em gate travado. Conteudo
    // real e apontar ONDE (path) ou POR QUE (why).
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute-so-titulo' },
    });

    assert.equal(result.ok, true, 'titulo solto nao pode indisponibilizar o gate');
    assert.equal((await historico(root)).at(-1).result, 'weak-refute');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refutacao sem defeito concreto nao bloqueia mudanca sa', async () => {
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute-vazio' },
    });

    // Alegar defeito sem apontar qual nao pode derrubar: seria indisponibilidade do
    // gate por alegacao vazia, espelho do problema que a prova de leitura resolve.
    assert.equal(result.ok, true, 'alegacao vazia nao derruba');
    assert.equal((await historico(root)).at(-1).result, 'weak-refute');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refutacao alucinada cai quando a propria prova a desmente', async () => {
  const { root, env } = await fixture();
  try {
    // O refutador alega "a suite quebra" e indica o comando. O comando passa (exit 0),
    // entao a alegacao se desmente sozinha e o aceite segue. Foi exatamente este o
    // caso real: "oito falhas" sobre uma suite que passava 34/34, sem apelacao.
    const result = await runFallback({
      root,
      base,
      env: {
        ...env,
        FAKE_CLAUDE_MODE: 'exit',
        FAKE_CODEX_MODE: 'refute-com-prova',
        FAKE_PROVA_EXIT: '0',
      },
    });
    assert.equal(result.ok, true, 'alegacao desmentida pela propria prova nao bloqueia');
    assert.equal((await historico(root)).at(-1).result, 'refutacao-nao-comprovada');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refutacao com prova que se sustenta bloqueia', async () => {
  const { root, env } = await fixture();
  try {
    // Mesmo veredito, mas agora o comando falha de verdade: a alegacao se sustenta e
    // o push e bloqueado. A apelacao nao pode virar escotilha para ignorar defeito.
    const result = await runFallback({
      root,
      base,
      env: {
        ...env,
        FAKE_CLAUDE_MODE: 'exit',
        FAKE_CODEX_MODE: 'refute-com-prova',
        FAKE_PROVA_EXIT: '1',
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.rejectedBy, 'codex');
    assert.equal((await historico(root)).at(-1).result, 'refuted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
