import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lerPrecedentes, registrarPrecedente, TETO_PRECEDENTES } from './lms-precedentes.mjs';

async function repoTemporario() {
  const root = await mkdtemp(join(tmpdir(), 'lms-prec-'));
  // Nota de migracao: .agents/skills/... -> skills/... neste repositorio.
  await mkdir(join(root, 'skills/local-merge-score/references'), { recursive: true });
  return root;
}

test('le zero precedentes quando o arquivo nao existe', async () => {
  assert.deepEqual(await lerPrecedentes(await repoTemporario()), []);
});

test('registra e le de volta', async () => {
  const root = await repoTemporario();
  await registrarPrecedente(root, {
    classe: 'DoS por payload grande',
    motivo: 'fora de escopo do gate: resource exhaustion nao bloqueia publicacao',
    origem: 'grok 2026-09-01',
  });
  const linhas = await lerPrecedentes(root);
  assert.equal(linhas.length, 1);
  assert.match(linhas[0], /DoS por payload grande/);
  assert.match(linhas[0], /grok 2026-09-01/);
});

test('nao duplica a mesma classe', async () => {
  const root = await repoTemporario();
  const p = { classe: 'mesma classe', motivo: 'motivo suficientemente longo aqui', origem: 'x' };
  await registrarPrecedente(root, p);
  await registrarPrecedente(root, p);
  assert.equal((await lerPrecedentes(root)).length, 1);
});

test('respeita o teto descartando o mais antigo', async () => {
  const root = await repoTemporario();
  for (let i = 0; i < TETO_PRECEDENTES + 5; i += 1) {
    await registrarPrecedente(root, { classe: `classe ${i}`, motivo: 'motivo longo o suficiente', origem: 'x' });
  }
  const linhas = await lerPrecedentes(root);
  assert.equal(linhas.length, TETO_PRECEDENTES);
  assert.equal(linhas.some((l) => l.includes('classe 0')), false);
});
