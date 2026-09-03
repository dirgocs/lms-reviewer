import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';

import { matarGrupo, spawnEmGrupo } from './lms-process-utils.mjs';

const execFile = promisify(execFileCallback);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// P3-3 da revisao da Fase 2: o timeout que mata so o shell deixa o NETO vivo —
// um `pnpm test` pendurado sobrevivia ao SIGTERM do pai e continuava queimando CPU.
// spawn detached + kill do grupo com -pid mata a arvore inteira.
test('matarGrupo derruba a arvore inteira, nao so o processo pai', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-grupo-'));
  const sentinela = join(root, 'neto-sobreviveu.txt');
  const scriptPath = join(root, 'neto.sh');
  await writeFile(scriptPath, [
    '#!/bin/sh',
    'sleep 1 && touch "$ALVO" &',
    'wait',
  ].join('\n'), 'utf8');
  await execFile('chmod', ['+x', scriptPath]);

  const child = spawnEmGrupo('sh', [scriptPath], { env: { ...process.env, ALVO: sentinela } });
  const fechou = new Promise((resolve) => child.on('close', resolve));
  // Timeout de 100 ms mata o grupo bem antes do `sleep 1` terminar.
  setTimeout(() => matarGrupo(child, 'SIGKILL'), 100);
  await fechou;
  await sleep(1_500); // tempo de sobra para um neto orfao ter escrito a sentinela

  const sobreviveu = await stat(sentinela).then(() => true, () => false);
  assert.equal(sobreviveu, false, 'neto sobreviveu ao kill do grupo');
});

// P2-7 da revisao da Fase 3: detached tira os CLIs do grupo do terminal — sem
// registro + purge no saida, um Ctrl+C/morte do pai deixava o filho vivo.
test('matarFilhosRegistados derruba os filhos vigiados', async () => {
  const { vigiarFilho, matarFilhosRegistados } = await import('./lms-process-utils.mjs');
  const root = await mkdtemp(join(tmpdir(), 'lms-purga-'));
  const sentinela = join(root, 'filho-sobreviveu.txt');
  const scriptPath = join(root, 'teimoso.sh');
  await writeFile(scriptPath, '#!/bin/sh\nsleep 1 && touch "$ALVO" &\nwait\n', 'utf8');
  await execFile('chmod', ['+x', scriptPath]);

  const child = spawnEmGrupo('sh', [scriptPath], { env: { ...process.env, ALVO: sentinela } });
  vigiarFilho(child);
  const fechou = new Promise((resolve) => child.on('close', resolve));
  matarFilhosRegistados('SIGKILL');
  await fechou;
  await sleep(1_500);

  const sobreviveu = await stat(sentinela).then(() => true, () => false);
  assert.equal(sobreviveu, false, 'filho registrado sobreviveu a saida do pai');
});
