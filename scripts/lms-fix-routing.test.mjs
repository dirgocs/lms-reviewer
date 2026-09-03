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

// P2-4 da revisao da Fase 3: o comentario do proprio modulo documenta o
// mapeamento (.agents/.claude -> skills/) mas a lista so cobria metade — no repo
// consumidor, .agents/ e a FONTE e node_modules e onde o pacote vive.
test('denylist cobre o mapeamento inteiro que ela documenta (P2-4)', () => {
  for (const p of [
    '.agents/skills/local-merge-score/SKILL.md',
    '.claude/skills/local-merge-score/SKILL.md',
    'node_modules/@dirgocs/lms-reviewer/scripts/lms-fix.mjs',
  ]) {
    assert.equal(caminhoProibido(p), true, p);
  }
  // e o roteador nunca manda o revisor corrigir o proprio pacote
  assert.equal(corrigivelPeloRevisor(achado({ path: '.agents/skills/local-merge-score/SKILL.md:1' })).ok, false);
});

// Fase 4 Task 6: fix pontual nao fecha classe recorrente — vai para o orquestrador.
test('classe recorrente nao e corrigivel pelo revisor (Task 6)', () => {
  const r = corrigivelPeloRevisor(achado({
    id: 'classe:code-safety:services/api',
    path: 'services/api/',
    title: 'classe recorrente: code-safety em services/api',
    fix: 'escrever o teste que fecha a classe e rodar as correcoes sob ele',
    recurrence: { rounds: 3, ids: ['a', 'b', 'c'] },
  }));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /classe recorrente/i);
});
