import test from 'node:test';
import assert from 'node:assert/strict';

import { escopoViolado } from './lms-fix-escopo.mjs';

test('aceita fix restrito aos arquivos permitidos', () => {
  assert.equal(escopoViolado(['src/a.ts'], ['src/a.ts', 'src/b.ts']), null);
});

test('recusa arquivo fora da lista', () => {
  const e = escopoViolado(['src/a.ts', 'src/z.ts'], ['src/a.ts']);
  assert.match(e, /src\/z\.ts/);
  assert.match(e, /fora do escopo/i);
});

test('recusa caminho proibido mesmo se estiver na lista permitida', () => {
  const e = escopoViolado(['scripts/lms-scorecard.mjs'], ['scripts/lms-scorecard.mjs']);
  assert.match(e, /proibido/i);
});

test('fix que nao mudou nada e violacao, nao sucesso', () => {
  const e = escopoViolado([], ['src/a.ts']);
  assert.match(e, /nenhum arquivo/i);
});
