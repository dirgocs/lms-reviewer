import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, resetConfigCache } from './lms-config.mjs';

function projeto(conteudo) {
  const root = mkdtempSync(join(tmpdir(), 'lms-config-'));
  if (conteudo !== undefined) {
    writeFileSync(join(root, 'lms.config.json'), conteudo, 'utf8');
  }
  resetConfigCache();
  return root;
}

test('projeto sem lms.config.json não ganha regra de migration nem gate de fallow', () => {
  const config = loadConfig(projeto());
  assert.equal(config.migrationsPath, null);
  assert.equal(config.dbStateGate, null);
  assert.equal(config.fallow.gate, null);
});

test('lê os caminhos declarados pelo projeto', () => {
  const config = loadConfig(
    projeto(
      JSON.stringify({
        migrationsPath: 'services/api/migrations/',
        dbStateGate: 'scripts/db-exposure-gate.mjs',
        fallow: { gate: 'apps/pdv-mobile/scripts/fallow-regression-gate.mjs' },
      }),
    ),
  );
  assert.equal(config.migrationsPath, 'services/api/migrations/');
  assert.equal(config.dbStateGate, 'scripts/db-exposure-gate.mjs');
  assert.equal(config.fallow.gate, 'apps/pdv-mobile/scripts/fallow-regression-gate.mjs');
  // baseline tem default porque o projeto de origem sempre usou esse caminho
  assert.equal(config.fallow.baseline, '.fallow/baseline.json');
});

test('config quebrada não derruba o gate nem vira isenção: cai no default vazio', () => {
  const config = loadConfig(projeto('{ isto não é json'));
  assert.equal(config.migrationsPath, null);
  assert.equal(config.fallow.gate, null);
});

test('valor não-string é descartado em vez de virar caminho inválido', () => {
  const config = loadConfig(
    projeto(JSON.stringify({ migrationsPath: 42, dbStateGate: '   ' })),
  );
  assert.equal(config.migrationsPath, null);
  assert.equal(config.dbStateGate, null);
});
