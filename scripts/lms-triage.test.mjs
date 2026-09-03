import test from 'node:test';
import assert from 'node:assert/strict';

import { precisaRevisao } from './lms-triage.mjs';

test('dispensa diff so de markdown', () => {
  const r = precisaRevisao(['docs/README.md', 'CHANGELOG.md']);
  assert.equal(r.revisar, false);
  assert.match(r.motivo, /documenta|isen/i);
});

// P2-2 da revisao da Fase 2: a triagem e a MESMA regra de isencao do gate —
// INERTES propria era copia mais permissiva (svg/png...) e criava deadlock:
// trigger dispensava, gate barrava por scorecard ausente.
test('asset sem caminho de execucao fora do default isento e revisado (P2-2)', () => {
  assert.equal(precisaRevisao(['apps/erp-web/public/logo.svg']).revisar, true);
});

test('nonExemptPaths do projeto vira revisao mesmo sendo inertes (P2-2)', () => {
  const config = { exemptPaths: ['\\.md$'], nonExemptPaths: ['^rules\\.md$'] };
  assert.equal(precisaRevisao(['docs/a.md'], config).revisar, false);
  assert.equal(precisaRevisao(['docs/x.md', 'rules.md'], config).revisar, true);
});

test('exige revisao quando ha codigo junto da documentacao', () => {
  assert.equal(precisaRevisao(['docs/README.md', 'services/api/src/routes/rooms.ts']).revisar, true);
});

test('exige revisao para migration, mesmo sozinha', () => {
  assert.equal(precisaRevisao(['services/api/migrations/20260901_x.sql']).revisar, true);
});

test('exige revisao para workflow de CI e para hook', () => {
  assert.equal(precisaRevisao(['.github/workflows/ci.yml']).revisar, true);
  // Aqui o hook mora em hooks/ (nota de migracao: .claude/hooks/ -> hooks/).
  assert.equal(precisaRevisao(['hooks/local-merge-score-gate.sh']).revisar, true);
});

test('exige revisao quando nao ha informacao de diff', () => {
  assert.equal(precisaRevisao([]).revisar, true);
});

test('exige revisao para o proprio LMS', () => {
  assert.equal(precisaRevisao(['scripts/lms-scorecard.mjs']).revisar, true);
});
