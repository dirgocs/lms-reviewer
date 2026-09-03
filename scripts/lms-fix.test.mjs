import test from 'node:test';
import assert from 'node:assert/strict';

import { fixPrompt } from './lms-fix.mjs';

const achado = {
  id: 'a1', severity: 'P1', path: 'src/a.ts:42',
  title: 'falta filtro de tenant', why: 'a query nao escopa por tenant',
  fix: 'somar tenantId a clausula where da consulta',
  acceptance: ['a query cita tenantId'],
};

test('fixPrompt lista os arquivos permitidos e proibe sair deles', () => {
  const p = fixPrompt(achado, ['src/a.ts']);
  assert.match(p, /src\/a\.ts/);
  assert.match(p, /ONLY these files/);
  assert.match(p, /reverted/i);
});

test('fixPrompt proibe pontuar de novo', () => {
  const p = fixPrompt(achado, ['src/a.ts']);
  assert.match(p, /do not re-?review|do not score/i);
});

test('fixPrompt carrega os criterios de aceite quando existem', () => {
  assert.match(fixPrompt(achado, ['src/a.ts']), /a query cita tenantId/);
});

// Task 4 Step 5: o valor destes testes esta em exercitar o git DE VERDADE — a
// reversao e o comportamento que precisa funcionar quando importa.
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { corrigirAchado } from './lms-fix.mjs';

const execFile = promisify(execFileCallback);

async function repoGit() {
  const root = await mkdtemp(join(tmpdir(), 'lms-fix-'));
  await execFile('git', ['init', '-q'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'lms@test'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'lms'], { cwd: root });
  await writeFile(join(root, 'a.ts'), 'const original = 1;\n');
  await writeFile(join(root, 'b.ts'), 'const vizinho = 2;\n');
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-qm', 'inicial'], { cwd: root });
  return root;
}

const alvo = {
  id: 'a1', severity: 'P1', path: 'a.ts:1', title: 'defeito localizado',
  why: 'a linha esta errada', fix: 'trocar o valor da constante para 2',
};

test('fix dentro do escopo e aceito como claimed sem prova', async () => {
  const root = await repoGit();
  const collect = async () => {
    await writeFile(join(root, 'a.ts'), 'const original = 2;\n');
    return { kind: 'ok', candidate: { outcome: 'fixed', what: 'troquei o valor' } };
  };
  const r = await corrigirAchado({ root, finding: alvo, provider: 'grok', config: {}, env: {}, collect });
  assert.equal(r.outcome, 'claimed');
  assert.match(await readFile(join(root, 'a.ts'), 'utf8'), /original = 2/);
});

test('fix que toca arquivo vizinho e revertido INTEIRO', async () => {
  const root = await repoGit();
  const collect = async () => {
    await writeFile(join(root, 'a.ts'), 'const original = 2;\n');
    await writeFile(join(root, 'b.ts'), 'const vizinho = 99;\n');
    return { kind: 'ok', candidate: { outcome: 'fixed', what: 'aproveitei e arrumei o vizinho' } };
  };
  const r = await corrigirAchado({ root, finding: alvo, provider: 'grok', config: {}, env: {}, collect });
  assert.equal(r.outcome, 'rejected-scope');
  assert.match(r.motivo, /b\.ts/);
  // A parte "boa" tambem volta: aceitar metade seria deixar o agente negociar o limite.
  assert.match(await readFile(join(root, 'a.ts'), 'utf8'), /original = 1/);
  assert.match(await readFile(join(root, 'b.ts'), 'utf8'), /vizinho = 2/);
});

test('fix que nao mudou nada e recusado, nao celebrado', async () => {
  const root = await repoGit();
  const collect = async () => ({ kind: 'ok', candidate: { outcome: 'fixed', what: 'nada' } });
  const r = await corrigirAchado({ root, finding: alvo, provider: 'grok', config: {}, env: {}, collect });
  assert.equal(r.outcome, 'rejected-scope');
  assert.match(r.motivo, /nenhum arquivo/i);
});

test('achado em caminho de risco nem chega a invocar o provider', async () => {
  const root = await repoGit();
  let chamou = false;
  const collect = async () => { chamou = true; return { kind: 'ok', candidate: {} }; };
  const r = await corrigirAchado({
    root, provider: 'grok', config: {}, env: {}, collect,
    finding: { ...alvo, path: 'services/fiscal/backend/app/auth.py:80' },
  });
  assert.equal(chamou, false);
  assert.equal(r.outcome, 'skipped');
});
