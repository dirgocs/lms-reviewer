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

// Fase 5 Task 2: bugAgents na config — dir, tracker (allowlist) e guided.
test('bugAgents: defaults quando ausente, tracker fora da allowlist cai para none (Task 2)', () => {
  const vazio = loadConfig(projeto());
  assert.deepEqual(vazio.bugAgents, { dir: '.agents/bug-triage', tracker: 'none', trackerOpcoes: {}, guided: false });

  const jira = loadConfig(projeto(JSON.stringify({ bugAgents: { tracker: 'jira' } })));
  assert.deepEqual(jira.bugAgents, { dir: '.agents/bug-triage', tracker: 'none', trackerOpcoes: {}, guided: false });

  const custom = loadConfig(
    projeto(JSON.stringify({ bugAgents: { dir: 'debug/agents', tracker: 'github', guided: true } })),
  );
  assert.deepEqual(custom.bugAgents, { dir: 'debug/agents', tracker: 'github', trackerOpcoes: {}, guided: true });
});

// Ajuste 3 (ordem do Master): `bugAgents.tracker` aceita tambem a forma objeto,
// `{ "linear": { "teamId": "..." } }`, sem quebrar a forma string. O nome do
// tracker continua saindo como string em `tracker`; as opcoes vao em
// `trackerOpcoes`, para todo o codigo que ja le `tracker` seguir igual.
test('bugAgents.tracker aceita objeto com opcoes do tracker (Ajuste 3)', () => {
  const objeto = loadConfig(
    projeto(JSON.stringify({ bugAgents: { tracker: { linear: { teamId: 'time-9' } } } })),
  );
  assert.equal(objeto.bugAgents.tracker, 'linear');
  assert.deepEqual(objeto.bugAgents.trackerOpcoes, { teamId: 'time-9' });

  const string = loadConfig(projeto(JSON.stringify({ bugAgents: { tracker: 'github' } })));
  assert.equal(string.bugAgents.tracker, 'github');
  assert.deepEqual(string.bugAgents.trackerOpcoes, {}, 'forma string segue sem opcoes');

  // Allowlist continua fechada: nome fora dela cai em none, nao roda comando.
  const desconhecido = loadConfig(
    projeto(JSON.stringify({ bugAgents: { tracker: { jira: { projeto: 'X' } } } })),
  );
  assert.equal(desconhecido.bugAgents.tracker, 'none');
  assert.deepEqual(desconhecido.bugAgents.trackerOpcoes, {});

  // Objeto com mais de um tracker e ambiguo: cai em none em vez de escolher sozinho.
  const ambiguo = loadConfig(
    projeto(JSON.stringify({ bugAgents: { tracker: { linear: {}, github: {} } } })),
  );
  assert.equal(ambiguo.bugAgents.tracker, 'none');
});
