import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { collectOutput } from './lms-process-utils.mjs';
const execFilePromisificado = promisify(execFileCallback);
const sourceRoot = process.cwd();
const trigger = join(sourceRoot, 'scripts', 'lms-reviewer-trigger.sh');

async function fixture(initialScorecard) {
  const root = await mkdtemp(join(tmpdir(), 'lms-trigger-'));
  await mkdir(join(root, '.lms'), { recursive: true });
  // O projeto consumidor NAO recebe copias em <root>/scripts. O trigger executado
  // a partir do pacote deve resolver validador e runner ao lado de si mesmo.
  // A prova de leitura e conferida no disco, entao o arquivo citado tem de existir
  // dentro da raiz temporaria onde o trigger roda.
  await writeFile(join(root, 'a.ts'), 'export const citado = 42; // linha citada verbatim\n', 'utf8');
  await writeFile(join(root, '.lms', 'last.json'), JSON.stringify(initialScorecard));

  const runner = join(root, 'fake-runner.mjs');
  await writeFile(runner, `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
// A cadeia real grava .lms/veredito.json DURANTE a rodada (runFallback ->
// registrarVeredito). O fake faz o mesmo: pre-escrever o arquivo antes do trigger
// simularia um veredito VELHO, que e justamente o que P1-1 proibe propagar.
if (process.env.LMS_TEST_RUNNER_VEREDITO) {
  await writeFile(process.env.LMS_REVIEWER_ROOT + '/.lms/veredito.json', JSON.stringify({
    estado: process.env.LMS_TEST_RUNNER_VEREDITO, reviewer: 'claude', refutador: 'grok',
  }));
}
if (process.env.LMS_TEST_RUNNER_MODE === 'fail') process.exit(9);
await writeFile(process.env.LMS_REVIEWER_ROOT + '/.lms/last.json', JSON.stringify({
  reviewer: 'grok', score: 5, target: 5, base: 'HEAD~1', p0: 0, p1: 0, p2: 0,
  lenses: {
    'code-safety': { p0: 0, p1: 0, p2: 0 },
    'code-structure': { p0: 0, p1: 0, p2: 0 },
    'code-quality': { p0: 0, p1: 0, p2: 0 },
    'code-efficiency': { p0: 0, p1: 0, p2: 0 },
  }, at: new Date().toISOString(), autonomy: 'reviewer', fallow: 'pass', coverage: [{ surface: 'arquivos alterados', total: 3, inspected: 3 }], verified: [{ claim: 'o modulo exporta a constante citada', path: 'a.ts', line: 1, quote: 'export const citado = 42; // linha citada verbatim' }],
    inspected: [{ path: 'a.ts', line: 1, quote: 'export const citado = 42; // linha citada verbatim' }],
}));
`);
  await chmod(runner, 0o755);
  return { root, runner };
}

function runTrigger({ root, runner, extraEnv = {} }) {
  return new Promise((resolve) => {
    const child = spawn('bash', [trigger], {
      cwd: root,
      env: {
        ...process.env,
        LMS_REVIEWER_ROOT: root,
        LMS_REVIEWER_RUNNER: runner,
        LMS_HOOK_MAX_AGE_SEC: '7200',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const { getStdout, getStderr } = collectOutput(child);
    child.on('close', (code) => resolve({ code, stdout: getStdout(), stderr: getStderr() }));
  });
}

test('accepts a valid fresh scorecard without starting the runner', async () => {
  const { root, runner } = await fixture({
    reviewer: 'grok', score: 5, target: 5, base: 'HEAD~1', p0: 0, p1: 0, p2: 0,
    lenses: {
      'code-safety': { p0: 0, p1: 0, p2: 0 },
      'code-structure': { p0: 0, p1: 0, p2: 0 },
      'code-quality': { p0: 0, p1: 0, p2: 0 },
      'code-efficiency': { p0: 0, p1: 0, p2: 0 },
    }, at: new Date().toISOString(), autonomy: 'reviewer', fallow: 'pass', coverage: [{ surface: 'arquivos alterados', total: 3, inspected: 3 }], verified: [{ claim: 'o modulo exporta a constante citada', path: 'a.ts', line: 1, quote: 'export const citado = 42; // linha citada verbatim' }],
    inspected: [{ path: 'a.ts', line: 1, quote: 'export const citado = 42; // linha citada verbatim' }],
  });
  try {
    const result = await runTrigger({ root, runner, extraEnv: { LMS_TEST_RUNNER_MODE: 'fail' } });
    assert.equal(result.code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolves validator from the package when consumer has no LMS scripts', async () => {
  const { root, runner } = await fixture({
    reviewer: 'grok', score: 5, target: 5, base: 'HEAD~1', p0: 0, p1: 0, p2: 0,
    lenses: {
      'code-safety': { p0: 0, p1: 0, p2: 0 },
      'code-structure': { p0: 0, p1: 0, p2: 0 },
      'code-quality': { p0: 0, p1: 0, p2: 0 },
      'code-efficiency': { p0: 0, p1: 0, p2: 0 },
    }, at: new Date().toISOString(), autonomy: 'reviewer', fallow: 'pass', coverage: [{ surface: 'arquivos alterados', total: 3, inspected: 3 }], verified: [{ claim: 'o modulo exporta a constante citada', path: 'a.ts', line: 1, quote: 'export const citado = 42; // linha citada verbatim' }],
    inspected: [{ path: 'a.ts', line: 1, quote: 'export const citado = 42; // linha citada verbatim' }],
  });
  try {
    const result = await runTrigger({ root, runner, extraEnv: { LMS_TEST_RUNNER_MODE: 'fail' } });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runs the fallback runner when the scorecard is invalid', async () => {
  const { root, runner } = await fixture({ score: 4 });
  try {
    const result = await runTrigger({ root, runner });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /scorecard accepted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks after runner failure and prints manual recovery', async () => {
  const { root, runner } = await fixture({ score: 4 });
  try {
    const result = await runTrigger({
      root,
      runner,
      extraEnv: { LMS_TEST_RUNNER_MODE: 'fail' },
    });
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /pnpm lms:reviewer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves explicit bypass variables', async () => {
  const { root, runner } = await fixture({ score: 0 });
  try {
    const result = await runTrigger({
      root,
      runner,
      extraEnv: { LMS_SKIP: '1', LMS_TEST_RUNNER_MODE: 'fail' },
    });
    assert.equal(result.code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Item (3) do relatorio do fix-review: o contrato do CLI da triagem (exit 10) esta
// testado, mas o WIRING no shell — set +e, so 10 dispensa, e o runner NAO roda —
// nao estava. Aqui o diff (HEAD~1..HEAD) e so de documentacao, o scorecard e
// invalido e o runner fake SAI 9: sem a triagem, o trigger falharia; com ela, sai 0
// sem tocar o runner.
test('triagem dispensando (exit 10) encerra o trigger sem chamar o runner', async () => {
  const { root, runner } = await fixture({ score: 4 });
  try {
    await execFilePromisificado('git', ['init', '-q'], { cwd: root });
    await execFilePromisificado('git', ['config', 'user.email', 'lms@test'], { cwd: root });
    await execFilePromisificado('git', ['config', 'user.name', 'lms'], { cwd: root });
    await execFilePromisificado('git', ['add', '.'], { cwd: root });
    await execFilePromisificado('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: root });
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'leia.md'), '# doc\n', 'utf8');
    await execFilePromisificado('git', ['add', 'docs'], { cwd: root });
    await execFilePromisificado('git', ['commit', '-q', '-m', 'doc'], { cwd: root });

    const result = await runTrigger({
      root,
      runner,
      extraEnv: { LMS_TEST_RUNNER_MODE: 'fail', LMS_REVIEWER_BASE: 'HEAD~1' },
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /dispensada pela triagem/);
    // O runner que falha jamais foi chamado: quem encerrou foi a triagem.
    assert.doesNotMatch(result.stdout, /scorecard accepted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves explicit bypass variables', async () => {
  const { root, runner } = await fixture({ score: 0 });
  try {
    const result = await runTrigger({
      root,
      runner,
      extraEnv: { LMS_SKIP: '1', LMS_TEST_RUNNER_MODE: 'fail' },
    });
    assert.equal(result.code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Task 10 da Fase 5 (evidencia KDT-68): quem espera a cadeia precisa de UMA linha
// estavel para esperar. `LMS VEREDITO: <estado>` e sempre a ultima linha do stderr.
function ultimaLinha(texto) {
  return String(texto).trimEnd().split('\n').at(-1);
}

test('scorecard OK imprime LMS VEREDITO: accepted como ultima linha e sai 0 (Task 10)', async () => {
  const { root, runner } = await fixture({
    reviewer: 'grok', score: 5, target: 5, base: 'HEAD~1', p0: 0, p1: 0, p2: 0,
    lenses: {
      'code-safety': { p0: 0, p1: 0, p2: 0 },
      'code-structure': { p0: 0, p1: 0, p2: 0 },
      'code-quality': { p0: 0, p1: 0, p2: 0 },
      'code-efficiency': { p0: 0, p1: 0, p2: 0 },
    }, at: new Date().toISOString(), autonomy: 'reviewer', fallow: 'pass', coverage: [{ surface: 'arquivos alterados', total: 3, inspected: 3 }], verified: [{ claim: 'o modulo exporta a constante citada', path: 'a.ts', line: 1, quote: 'export const citado = 42; // linha citada verbatim' }],
    inspected: [{ path: 'a.ts', line: 1, quote: 'export const citado = 42; // linha citada verbatim' }],
  });
  try {
    const r = await runTrigger({ root, runner, extraEnv: { LMS_TEST_RUNNER_MODE: 'fail' } });
    assert.equal(r.code, 0);
    assert.equal(ultimaLinha(r.stderr), 'LMS VEREDITO: accepted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cadeia que morre sem gravar veredito sai 1 com estado timeout (Task 10)', async () => {
  const { root, runner } = await fixture({ reviewer: 'grok', score: 2 });
  try {
    const r = await runTrigger({ root, runner, extraEnv: { LMS_TEST_RUNNER_MODE: 'fail' } });
    assert.equal(r.code, 1);
    assert.equal(ultimaLinha(r.stderr), 'LMS VEREDITO: timeout', 'fail-closed: sem veredito gravado, timeout');
    const veredito = JSON.parse(await readFile(join(root, '.lms', 'veredito.json'), 'utf8'));
    assert.equal(veredito.estado, 'timeout', 'o trigger grava o que faltou');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('veredito gravado pelo runner e o que o trigger propaga (Task 10)', async () => {
  const { root, runner } = await fixture({ reviewer: 'grok', score: 2 });
  try {
    const r = await runTrigger({
      root,
      runner,
      extraEnv: { LMS_TEST_RUNNER_MODE: 'fail', LMS_TEST_RUNNER_VEREDITO: 'refuted' },
    });
    assert.equal(r.code, 1);
    assert.equal(ultimaLinha(r.stderr), 'LMS VEREDITO: refuted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// P1-1 da revisao da Fase 5: `finalizar` sem argumento lia o estado de um
// veredito.json que NUNCA era invalidado. Rodada aceita no passado deixava um
// arquivo que autorizava a falha seguinte — bypass do gate sem LMS_SKIP, sem
// --no-verify e sem intencao do usuario.
test('veredito accepted VELHO nao libera push quando o gate reprova (P1-1)', async () => {
  const { root, runner } = await fixture({ reviewer: 'grok', score: 2 });
  try {
    await writeFile(
      join(root, '.lms', 'veredito.json'),
      JSON.stringify({ estado: 'accepted', reviewer: 'claude', score: 5 }),
    );
    const r = await runTrigger({ root, runner, extraEnv: { LMS_TEST_RUNNER_MODE: 'fail' } });
    assert.equal(r.code, 1, 'aceite de rodada anterior NUNCA autoriza a rodada atual');
    assert.notEqual(ultimaLinha(r.stderr), 'LMS VEREDITO: accepted');
    const veredito = JSON.parse(await readFile(join(root, '.lms', 'veredito.json'), 'utf8'));
    assert.notEqual(veredito.estado, 'accepted', 'o arquivo velho nao sobrevive a rodada');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// P2-3 da revisao da Fase 5: a guarda `[ ! -f ]` nunca corrigia arquivo velho, e
// quem esperava em `until [ -f .lms/veredito.json ]` lia o desfecho da rodada
// ANTERIOR — o mesmo prejuizo que a Task 10 existia para eliminar.
test('veredito do trigger reflete a rodada atual, nao a anterior (P2-3)', async () => {
  const { root, runner } = await fixture({
    reviewer: 'grok', score: 5, target: 5, base: 'HEAD~1', p0: 0, p1: 0, p2: 0,
    lenses: {
      'code-safety': { p0: 0, p1: 0, p2: 0 },
      'code-structure': { p0: 0, p1: 0, p2: 0 },
      'code-quality': { p0: 0, p1: 0, p2: 0 },
      'code-efficiency': { p0: 0, p1: 0, p2: 0 },
    }, at: new Date().toISOString(), autonomy: 'reviewer', fallow: 'pass', coverage: [{ surface: 'arquivos alterados', total: 3, inspected: 3 }], verified: [{ claim: 'o modulo exporta a constante citada', path: 'a.ts', line: 1, quote: 'export const citado = 42; // linha citada verbatim' }],
    inspected: [{ path: 'a.ts', line: 1, quote: 'export const citado = 42; // linha citada verbatim' }],
  });
  try {
    await writeFile(
      join(root, '.lms', 'veredito.json'),
      JSON.stringify({ estado: 'rejected', reviewer: 'codex' }),
    );
    const r = await runTrigger({ root, runner, extraEnv: { LMS_TEST_RUNNER_MODE: 'fail' } });
    assert.equal(r.code, 0);
    assert.equal(ultimaLinha(r.stderr), 'LMS VEREDITO: accepted');
    const veredito = JSON.parse(await readFile(join(root, '.lms', 'veredito.json'), 'utf8'));
    assert.equal(veredito.estado, 'accepted', 'quem espera precisa ler o desfecho DESTA rodada');
    assert.equal(veredito.reviewer, null, 'nada da rodada anterior vaza');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

