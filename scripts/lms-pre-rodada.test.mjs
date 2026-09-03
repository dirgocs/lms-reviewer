import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { comandoDeTeste, runPreRodada } from './lms-pre-rodada.mjs';

const execFile = promisify(execFileCallback);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(raiz, 'scripts', 'lms-pre-rodada.mjs');

// Task 1 da Fase 4: suíte vermelha recusa a rodada (exit 11) antes de gastar cota.
// Falha de ferramenta (inexistente, timeout) NÃO é vermelho — avisa e segue, mesmo
// precedente da triagem: erro de infra nunca decide sozinho.

test('comandoDeTeste: string vira {cmd,args}, objeto normaliza, ausente e lixo viram null (Task 1)', () => {
  assert.deepEqual(comandoDeTeste({ testCommand: 'pnpm test' }), { cmd: 'pnpm test', args: [] });
  assert.deepEqual(
    comandoDeTeste({ testCommand: { cmd: 'pnpm', args: ['test', 'unit'] } }),
    { cmd: 'pnpm', args: ['test', 'unit'] },
  );
  assert.equal(comandoDeTeste({}), null);
  assert.equal(comandoDeTeste({ testCommand: 42 }), null);
  assert.equal(comandoDeTeste(null), null);
});

test('sem testCommand a rodada é pulada com aviso (Task 1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-pre-'));
  const r = await runPreRodada({ root, env: {} });
  assert.equal(r.status, 'pulado');
  assert.match(r.saida, /sem testCommand/i);
});

test('comando vermelho recusa a rodada (Task 1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-pre-'));
  const config = { testCommand: { cmd: 'node', args: ['-e', 'process.exit(1)'] } };
  const r = await runPreRodada({ root, env: {}, config });
  assert.equal(r.status, 'vermelho');
  assert.ok(r.saida.length > 0, 'saida vai para o stderr do trigger');
});

test('comando verde passa (Task 1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-pre-'));
  const config = { testCommand: { cmd: 'node', args: ['-e', 'process.exit(0)'] } };
  const r = await runPreRodada({ root, env: {}, config });
  assert.equal(r.status, 'verde');
});

test('comando inexistente é erro de ferramenta: avisa e segue (Task 1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-pre-'));
  const config = { testCommand: { cmd: 'comando-que-nao-existe-lms', args: [] } };
  const r = await runPreRodada({ root, env: {}, config });
  assert.equal(r.status, 'erro');
  assert.match(r.saida, /ferramenta|nao encontrado|ENOENT/i);
});

test('timeout mata o GRUPO — o neto nao sobrevive (Task 1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-pre-'));
  const alvo = join(root, 'neto-sobreviveu.txt');
  const config = {
    testCommand: {
      cmd: 'node',
      args: ['-e', `require('node:child_process').spawn('sh', ['-c', 'sleep 1.2 && touch "${alvo}"'], { stdio: 'ignore' }); setInterval(() => {}, 1000);`],
    },
  };
  const r = await runPreRodada({ root, env: { LMS_TEST_TIMEOUT_MS: '300' }, config });
  assert.equal(r.status, 'erro', 'timeout é falha de ferramenta: avisa e segue');
  await sleep(1_500);
  const sobreviveu = await stat(alvo).then(() => true, () => false);
  assert.equal(sobreviveu, false, 'neto sobreviveu ao timeout do degrau de teste');
});

test('LMS_TEST_GATE=0 pula o degrau (Task 1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-pre-'));
  const config = { testCommand: { cmd: 'node', args: ['-e', 'process.exit(1)'] } };
  const r = await runPreRodada({ root, env: { LMS_TEST_GATE: '0' }, config });
  assert.equal(r.status, 'pulado');
});

// CLI: exit 11 no vermelho, 0 nos demais (pulado/verde/erro-de-ferramenta).
test('CLI sai 11 no vermelho e 0 nos demais (Task 1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-pre-cli-'));
  const rodar = async (configJson) => {
    if (configJson) await writeFile(join(root, 'lms.config.json'), JSON.stringify(configJson));
    return execFile(process.execPath, [cli, '--root', root], { cwd: root })
      .then((r) => ({ ...r, code: 0 }))
      .catch((e) => e);
  };
  const vermelho = await rodar({ testCommand: { cmd: 'node', args: ['-e', 'process.exit(1)'] } });
  assert.equal(vermelho.code, 11, `${vermelho.stdout}\n${vermelho.stderr}`);
  assert.match(String(vermelho.stderr), /node -e/);
  const verde = await rodar({ testCommand: { cmd: 'node', args: ['-e', 'process.exit(0)'] } });
  assert.equal(verde.code, 0);
  const pulado = await rodar(null);
  assert.equal(pulado.code, 0);
});
