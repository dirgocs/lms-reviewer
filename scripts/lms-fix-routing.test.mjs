import test from 'node:test';
import assert from 'node:assert/strict';

import { arquivosDoAchado, caminhoProibido, corrigivelPeloRevisor } from './lms-fix-routing.mjs';

const achado = (over = {}) => ({
  id: 'a1', lens: 'code-safety', severity: 'P1', confidence: 90,
  path: 'services/api/src/routes/pos-reference.ts:1547',
  title: 'lock sem checagem de posse',
  why: 'printer_id nao e validado contra o tenant',
  fix: 'resolver a impressora por (id, tenantId) antes do INSERT',
  ...over,
});

test('arquivosDoAchado tira o numero da linha', () => {
  assert.deepEqual(arquivosDoAchado(achado()), ['services/api/src/routes/pos-reference.ts']);
});

test('arquivosDoAchado aceita lista de caminhos', () => {
  assert.deepEqual(
    arquivosDoAchado(achado({ path: ['a.ts:1', 'b.ts:2'] })),
    ['a.ts', 'b.ts'],
  );
});

test('achado localizado e corrigivel pelo revisor', () => {
  assert.equal(corrigivelPeloRevisor(achado()).ok, true);
});

test('achado em caminho de risco vai para o orquestrador', () => {
  const r = corrigivelPeloRevisor(achado({ path: 'services/fiscal/backend/app/auth.py:80' }));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /risco/i);
});

test('achado sem fix acionavel vai para o orquestrador', () => {
  const r = corrigivelPeloRevisor(achado({ fix: 'decidir se a rota deve existir' }));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /decis/i);
});

test('achado sem campo fix vai para o orquestrador', () => {
  const r = corrigivelPeloRevisor(achado({ fix: undefined }));
  assert.equal(r.ok, false);
});

test('achado em caminho proibido nunca e corrigivel', () => {
  assert.equal(corrigivelPeloRevisor(achado({ path: 'scripts/lms-scorecard.mjs:10' })).ok, false);
  assert.equal(corrigivelPeloRevisor(achado({ path: 'hooks/x.sh:1' })).ok, false);
});

test('caminhoProibido cobre o gate inteiro', () => {
  for (const p of [
    '.lms/last.json', 'hooks/local-merge-score-gate.sh',
    'scripts/lms-fix.mjs', 'scripts/db-exposure-gate.mjs', '.git/config',
  ]) {
    assert.equal(caminhoProibido(p), true, p);
  }
  assert.equal(caminhoProibido('services/api/src/routes/rooms.ts'), false);
});
