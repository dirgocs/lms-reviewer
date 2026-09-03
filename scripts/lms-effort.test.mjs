import test from 'node:test';
import assert from 'node:assert/strict';

import { effortPara } from './lms-effort.mjs';

test('diff comum revisa em high', () => {
  assert.equal(effortPara(['apps/erp-web/src/components/ui/button.tsx'], {}), 'high');
});

test('caminho de auth/tenant/fiscal sobe para xhigh', () => {
  assert.equal(effortPara(['services/fiscal/backend/app/auth.py'], {}), 'xhigh');
  assert.equal(effortPara(['services/api/src/pos/actor.ts'], {}), 'xhigh');
  assert.equal(effortPara(['services/api/migrations/20260901_rls.sql'], {}), 'xhigh');
});

test('LMS_EFFORT sobrescreve', () => {
  assert.equal(effortPara(['services/fiscal/backend/app/auth.py'], { LMS_EFFORT: 'medium' }), 'medium');
});

test('LMS_EFFORT invalido e ignorado', () => {
  assert.equal(effortPara(['a.ts'], { LMS_EFFORT: 'turbo' }), 'high');
});
