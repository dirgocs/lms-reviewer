import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isExempt } from './lms-exempt-paths.mjs';
import { loadConfig, resetConfigCache } from './lms-config.mjs';

function config(raw) {
  const root = mkdtempSync(join(tmpdir(), 'lms-exempt-config-'));
  writeFileSync(join(root, 'lms.config.json'), JSON.stringify(raw));
  resetConfigCache();
  return loadConfig(root);
}

test('somente paths isentos passam; vazio e conjunto misto falham fechados', () => {
  const rules = config({ exemptPaths: ['^docs/', '\\.(md|txt)$'] });
  assert.equal(isExempt(['docs/guia.md', 'README.md'], rules), true);
  assert.equal(isExempt([], rules), false);
  assert.equal(isExempt(['README.md', 'src/index.ts'], rules), false);
});

test('nonExemptPaths prevalece sobre prefixo isento', () => {
  const rules = config({
    exemptPaths: ['^corpus/'],
    nonExemptPaths: ['^corpus/.*\\.xsd$'],
  });
  assert.equal(isExempt(['corpus/manual.pdf'], rules), true);
  assert.equal(isExempt(['corpus/schema.xsd'], rules), false);
});

test('nonExemptPaths invalido descarta toda a config e nao abre isencao', () => {
  const rules = config({
    exemptPaths: ['^corpus/'],
    nonExemptPaths: ['['],
  });
  assert.equal(isExempt(['corpus/schema.xsd'], rules), false);
});
