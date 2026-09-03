import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
