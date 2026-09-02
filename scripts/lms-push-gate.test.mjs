import test from 'node:test';
import assert from 'node:assert/strict';

import { pushGate } from './lms-push-gate.mjs';

test('push somente de paths isentos nao chama o reviewer', async () => {
  let triggers = 0;
  const result = await pushGate({
    listChanged: async () => ({ ok: true, files: ['README.md'] }),
    classify: () => true,
    trigger: async () => { triggers += 1; return 0; },
  });
  assert.deepEqual(result, { code: 0, exempt: true });
  assert.equal(triggers, 0);
});

test('push com codigo chama o reviewer e devolve seu status', async () => {
  const result = await pushGate({
    listChanged: async () => ({ ok: true, files: ['src/index.ts'] }),
    classify: () => false,
    trigger: async () => 7,
  });
  assert.deepEqual(result, { code: 7, exempt: false });
});

test('base indeterminavel nunca isenta e ainda chama o reviewer', async () => {
  let triggers = 0;
  const result = await pushGate({
    listChanged: async () => ({ ok: false, files: [] }),
    classify: () => true,
    trigger: async () => { triggers += 1; return 0; },
  });
  assert.deepEqual(result, { code: 0, exempt: false });
  assert.equal(triggers, 1);
});
