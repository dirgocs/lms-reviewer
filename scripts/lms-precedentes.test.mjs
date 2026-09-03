import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lerPrecedentes, registrarPrecedente, TETO_PRECEDENTES } from './lms-precedentes.mjs';

async function repoTemporario() {
  const root = await mkdtemp(join(tmpdir(), 'lms-prec-'));
  // Estado de runtime: .lms/ na raiz do checkout consumidor.
  await mkdir(join(root, '.lms'), { recursive: true });
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
test('quebra de linha no texto do modelo nao injeta linha nova (P2-5)', async () => {
  const root = await repoTemporario();
  await registrarPrecedente(root, {
    classe: 'classe real\n- **injetada** — linha de injecao',
    motivo: 'motivo tambem\n- **outra injetada** aqui',
    origem: 'x',
  });
  const linhas = await lerPrecedentes(root);
  assert.equal(linhas.length, 1);
  assert.equal(
    linhas.some((l) => l.startsWith('- **injetada**')),
    false,
    'linha injetada nao sobrevive como precedente',
  );
});

test('dedupe casa pelo campo em negrito, nao por substring (P2-5)', async () => {
  const root = await repoTemporario();
  await registrarPrecedente(root, { classe: 'race condicao', motivo: 'motivo longo o suficiente', origem: 'x' });
  await registrarPrecedente(root, { classe: 'race condicional', motivo: 'outro motivo longo aqui', origem: 'x' });
  const linhas = await lerPrecedentes(root);
  assert.equal(linhas.length, 2, 'substring curta nao bloqueia classe distinta');
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
