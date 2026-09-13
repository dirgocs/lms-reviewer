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

test('codePaths inverte a regra: isento salvo codigo; nonExemptPaths ainda manda (Master 2026-09-13)', () => {
  const rules = config({
    codePaths: ['^(apps|packages|services)/.*\\.(ts|tsx|py|sql|prisma)$', '(^|/)migrations/'],
    nonExemptPaths: ['^corpus/.*\\.xsd$'],
  });
  // bump de devDependency + lockfile + doc + hook: nada de codigo -> isento
  assert.equal(isExempt(['package.json', 'pnpm-lock.yaml', 'services/AGENTS.md', '.husky/pre-push'], rules), true);
  // um arquivo de codigo no meio acorda a cadeia
  assert.equal(isExempt(['package.json', 'services/api/src/routes/pos-fiscal.ts'], rules), false);
  assert.equal(isExempt(['services/api/migrations/20260913_x.sql'], rules), false);
  // nonExemptPaths continua prioritario mesmo fora de codePaths
  assert.equal(isExempt(['corpus/schema.xsd'], rules), false);
  // vazio segue fechado
  assert.equal(isExempt([], rules), false);
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
