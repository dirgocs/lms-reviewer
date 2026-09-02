import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { escreverArquivosCitados } from './lms-test-fixtures.mjs';
import { join } from 'node:path';

import { PI_SYSTEM_PROMPT, collectPi } from './lms-reviewer-pi.mjs';
import { runFallback } from './lms-reviewer-fallback.mjs';

const base = 'origin/master';

const fakePi = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

// stdin tem de estar em /dev/null (stdio ignore): o pi REAL trava lendo stdin.
let stdin = '';
try { stdin = readFileSync(0, 'utf8'); } catch { stdin = '<fd-0-fechado>'; }
appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n');

if (process.env.FAKE_PI_MODE === 'exit') process.exit(17);
if (process.env.FAKE_PI_MODE === 'timeout') await new Promise(() => {});

const prova = [{ path: 'a.ts', line: 1, quote: 'export const alpha = 1; // linha citada' }];
const veredito = process.env.FAKE_PI_MODE === 'refute'
  ? {
      refuted: true, confidence: 99, severity: 'P0', lens: 'code-safety',
      path: 'a.ts:1', title: 'achado da sombra', why: 'a sombra viu caso de borda',
      inspected: prova,
    }
  : { refuted: false, confidence: 0, inspected: prova };
console.log(JSON.stringify(veredito));
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lms-pi-'));
  const bin = join(root, 'fake-pi.mjs');
  const log = join(root, 'pi-calls.log');
  await escreverArquivosCitados(root);
  await writeFile(bin, fakePi, 'utf8');
  await chmod(bin, 0o755);
  // O collectPi nao passa por childEnvironment: o env que chega E o env do spawn.
  // Em producao o runner tmux passa process.env inteiro; o teste espelha isso.
  const env = { ...process.env, LMS_PI_BIN: bin, FAKE_PI_LOG: log };
  return { root, env, log, bin };
}

const provaDeLeitura = [
  { path: 'a.ts', line: 1, quote: 'export const alpha = 1; // linha citada' },
  { path: 'b.ts', line: 1, quote: 'export const bravo = 2; // linha citada' },
  { path: 'c.ts', line: 1, quote: 'export const charlie = 3; // linha citada' },
];

function scorecardFake() {
  const zero = { p0: 0, p1: 0, p2: 0 };
  return {
    score: 5,
    target: 5,
    p0: 0,
    p1: 0,
    p2: 0,
    lenses: {
      'code-safety': zero,
      'code-structure': { ...zero },
      'code-quality': { ...zero },
      'code-efficiency': { ...zero },
    },
    findings: [],
    inspected: provaDeLeitura,
  };
}

async function historico(root) {
  const bruto = await readFile(join(root, '.lms', 'history.jsonl'), 'utf8');
  return bruto
    .trim()
    .split('\n')
    .map((linha) => JSON.parse(linha));
}

/** Reviewer fake que aprova 5/5 e refutador que sustenta — o par padrão dos
 *  testes de sombra (o fallow acusou o clone; a fonte única mora aqui). */
function collectQueAprova() {
  return async ({ prompt }) => ({
    kind: 'ok',
    candidate: prompt.includes('DERRUBAR')
      ? { refuted: false, confidence: 0, inspected: provaDeLeitura }
      : scorecardFake(),
  });
}

test('collectPi invoca o pi com flags de sombra, stdin nulo e contrato do refutador', async () => {
  const { root, env, log } = await fixture();
  try {
    const result = await collectPi({
      root,
      provider: 'pi',
      config: { models: {}, bins: {}, timeoutMs: 5000 },
      base,
      prompt:
        'DERRUBAR o 5/5. Campos obrigatorios: refuted severity path title why. inspected: quote VERBATIM de cada arquivo aberto.',
      env,
    });
    assert.equal(result.kind, 'ok');

    const [chamada] = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((linha) => JSON.parse(linha));
    assert.equal(chamada.stdin, '', '< /dev/null: o pi real trava lendo stdin');
    assert.equal(chamada.argv[0], '--provider');
    assert.equal(chamada.argv[1], 'openai-codex');
    assert.equal(chamada.argv[2], '--model');
    assert.equal(chamada.argv[3], 'gpt-5.6-sol');
    assert.equal(chamada.argv[4], '--thinking');
    assert.equal(chamada.argv[5], 'xhigh');
    // tools somente-leitura: a allowlist e explicita no comando, nao so em prosa
    assert.deepEqual(
      chamada.argv.slice(chamada.argv.indexOf('--tools'), chamada.argv.indexOf('--tools') + 2),
      ['--tools', 'read,grep,find'],
    );
    assert.equal(chamada.argv.includes('--no-session'), true);
    assert.equal(chamada.argv.includes('--mode'), true);
    assert.equal(chamada.argv[chamada.argv.indexOf('--mode') + 1], 'json');
    // system prompt carrega o MESMO contrato do refutador: campos + prova de leitura
    assert.equal(
      chamada.argv[chamada.argv.indexOf('--append-system-prompt') + 1],
      PI_SYSTEM_PROMPT,
    );
    assert.match(PI_SYSTEM_PROMPT, /inspected/);
    assert.match(PI_SYSTEM_PROMPT, /refuted/);
    assert.match(PI_SYSTEM_PROMPT, /VERBATIM|verbatim/);
    // o prompt do refutador vai em -p
    assert.equal(chamada.argv[chamada.argv.indexOf('-p') + 1].includes('DERRUBAR'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('collectPi parseia o veredito do refutador a partir do stdout do pi', async () => {
  const { root, env } = await fixture();
  try {
    const result = await collectPi({
      root,
      provider: 'pi',
      config: { models: {}, bins: {}, timeoutMs: 5000 },
      base,
      prompt: 'DERRUBAR o 5/5',
      env: { ...env, FAKE_PI_MODE: 'refute' },
    });
    assert.equal(result.kind, 'ok');
    assert.equal(result.candidate.refuted, true);
    assert.equal(result.candidate.severity, 'P0');
    assert.equal(result.candidate.path, 'a.ts:1');
    assert.equal(result.candidate.inspected[0].path, 'a.ts');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sombra do pi grava linha refutador-sombra no historico e nao decide nada', async () => {
  const { root, env } = await fixture();
  try {
    const collect = collectQueAprova();
    // A sombra GRITA um P0 — e o aceite tem de continuar de pe.
    const collectShadow = async () => ({
      kind: 'ok',
      candidate: {
        refuted: true,
        confidence: 99,
        severity: 'P0',
        lens: 'code-safety',
        path: 'a.ts:1',
        title: 'achado da sombra',
        why: 'a sombra nunca decide',
        inspected: provaDeLeitura,
      },
    });
    const result = await runFallback({
      root,
      base,
      env: { ...env, LMS_PI_SHADOW: '1' },
      collect,
      collectShadow,
    });
    assert.equal(result.ok, true, 'veredito da sombra nao decide nada');

    const linhas = await historico(root);
    const sombra = linhas.find((linha) => linha.estagio === 'refutador-sombra');
    assert.ok(sombra, 'sombra grava a propria linha no history.jsonl');
    assert.equal(sombra.provider, 'pi');
    assert.equal(sombra.resultado, 'shadow-refuted');
    assert.equal(sombra.modelo, 'gpt-5.6-sol');
    assert.equal(sombra.p0, 1, 'telemetria da sombra registra o achado');
    assert.equal(sombra.findings_count, 1);
    assert.equal(sombra.round_id, linhas[0].round_id, 'mesma rodada do refutador');
    assert.equal(
      sombra.sombraDe,
      linhas.find((linha) => linha.estagio === 'refutador').provider,
      'sombra acompanha quem foi o refutador real',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sem LMS_PI_SHADOW nenhuma coleta de sombra acontece', async () => {
  const { root, env } = await fixture();
  try {
    const collect = collectQueAprova();
    const collectShadow = async () => {
      throw new Error('sombra nao devia ser chamada');
    };
    const result = await runFallback({ root, base, env, collect, collectShadow });
    assert.equal(result.ok, true);
    const linhas = await historico(root);
    assert.equal(
      linhas.some((linha) => linha.estagio === 'refutador-sombra'),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('falha tecnica da sombra vira linha de historico e nao toca o desfecho', async () => {
  const { root, env } = await fixture();
  try {
    const collect = collectQueAprova();
    const collectShadow = async () => ({ kind: 'exit', code: 17 });
    const result = await runFallback({
      root,
      base,
      env: { ...env, LMS_PI_SHADOW: '1' },
      collect,
      collectShadow,
    });
    assert.equal(result.ok, true);
    const sombra = (await historico(root)).find((linha) => linha.estagio === 'refutador-sombra');
    assert.ok(sombra);
    assert.equal(sombra.resultado, 'exit');
    assert.equal(sombra.p0, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
