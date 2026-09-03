import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aplicarReverificacao,
  parseReverificacao,
  reverificarPrompt,
} from './lms-reverificar.mjs';

const scorecard = () => ({
  reviewer: 'grok',
  score: 3,
  target: 5,
  base: 'origin/master',
  p0: 0,
  p1: 1,
  p2: 0,
  coverage: [{ surface: 'arquivos alterados', total: 3, inspected: 3 }],
  findings: [
    { id: 'aaa111', lens: 'code-safety', severity: 'P1', confidence: 90,
      path: 'src/a.ts:42', title: 'falta filtro de tenant', why: 'a query nao escopa',
      acceptance: ['a query cita tenantId'], verdict: 'CONFIRMED' },
    { id: 'bbb222', lens: 'code-quality', severity: 'P2', confidence: 85,
      path: 'src/b.ts:7', title: 'nome confuso', why: 'legibilidade', verdict: 'CONFIRMED' },
  ],
});

// Task 3 da Fase 4: re-verificacao incremental fail-closed.

test('aplicarReverificacao: closed nao altera score nem agregado nem coverage (Task 3)', () => {
  const antes = scorecard();
  const depois = aplicarReverificacao(
    antes,
    [{ id: 'aaa111', status: 'closed', why: 'o filtro foi adicionado', evidence: 'linha 43 cita tenantId' }],
    [],
  );
  assert.equal(depois.score, antes.score);
  assert.equal(depois.p1, antes.p1);
  assert.deepEqual(depois.coverage, antes.coverage);
  const achado = depois.findings.find((f) => f.id === 'aaa111');
  assert.equal(achado.reverificado, 'closed');
  // Os DEMAIS achados ficam intactos e abertos por default.
  assert.equal(depois.findings.find((f) => f.id === 'bbb222').reverificado, 'open');
});

test('aplicarReverificacao: id ausente na resposta continua open (Task 3)', () => {
  const depois = aplicarReverificacao(
    scorecard(),
    [{ id: 'aaa111', status: 'closed', why: 'x', evidence: 'y' }],
    [],
  );
  assert.equal(depois.findings.find((f) => f.id === 'bbb222').reverificado, 'open');
});

test('aplicarReverificacao: id desconhecido na resposta é ignorado (Task 3)', () => {
  const depois = aplicarReverificacao(
    scorecard(),
    [{ id: 'zzz999', status: 'closed', why: 'inventado', evidence: 'x' }],
    [],
  );
  assert.equal(depois.findings.length, 2, 'nenhum achado novo entra no scorecard');
});

test('aplicarReverificacao: closed derrubado pelo verificador volta a open (Task 3)', () => {
  const depois = aplicarReverificacao(
    scorecard(),
    [{ id: 'aaa111', status: 'closed', why: 'fechei', evidence: 'x' }],
    [{ id: 'aaa111', verdict: 'CONFIRMED' }],
  );
  assert.equal(depois.findings.find((f) => f.id === 'aaa111').reverificado, 'open');
});

test('aplicarReverificacao: closed sustentado pelo verificador permanece closed (Task 3)', () => {
  const depois = aplicarReverificacao(
    scorecard(),
    [{ id: 'aaa111', status: 'closed', why: 'fechei', evidence: 'x' }],
    [{ id: 'aaa111', verdict: 'PLAUSIBLE' }],
  );
  assert.equal(depois.findings.find((f) => f.id === 'aaa111').reverificado, 'closed');
});

test('reverificarPrompt lista ids, severidade, acceptance e o diff, e proibe re-review (Task 3)', () => {
  const achados = scorecard().findings;
  const p = reverificarPrompt(achados, 'diff --git a/src/a.ts');
  assert.match(p, /aaa111/);
  assert.match(p, /bbb222/);
  assert.match(p, /falta filtro de tenant/);
  assert.match(p, /a query cita tenantId/);
  assert.match(p, /diff --git/);
  assert.match(p, /closed|open/);
  assert.match(p, /do not re-?review|nao re-revise|ONLY/i);
});

test('parseReverificacao extrai o objeto com results e ignora o resto (Task 3)', () => {
  const bruto = 'lixo {"results":[{"id":"aaa111","status":"closed"}]} fim';
  assert.deepEqual(parseReverificacao(bruto, ''), { results: [{ id: 'aaa111', status: 'closed' }] });
  assert.equal(parseReverificacao('{"score": 5}', ''), null);
});
