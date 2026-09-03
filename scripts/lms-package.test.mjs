import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const skill = readFileSync(join(root, 'skills/local-merge-score/SKILL.md'), 'utf8');

test('v1.2 expoe todos os comandos usados pelo consumidor', () => {
  assert.equal(pkg.version, '1.2.0');
  assert.deepEqual(pkg.bin, {
    'lms-trigger': './scripts/lms-reviewer-trigger.sh',
    'lms-reviewer': './scripts/lms-reviewer-spawn.sh',
    'lms-reviewer-tmux': './scripts/lms-reviewer-tmux.mjs',
    'lms-push-gate': './scripts/lms-push-gate.mjs',
    'lms-exempt-paths': './scripts/lms-exempt-paths.mjs',
    // P3-1 da revisao da Fase 3: o consumidor dispara bins, nao scripts internos.
    'lms-fix': './scripts/lms-fix.mjs',
  });
});

test('artefato publicado inclui hook, skill, docs e config de exemplo', () => {
  for (const path of ['scripts/', 'hooks/', 'skills/', 'docs/', 'lms.config.example.json', 'README.md', 'CHANGELOG.md']) {
    assert.ok(pkg.files.includes(path), `package files precisa incluir ${path}`);
  }
});

test('todos os bins e o hook sao executaveis', () => {
  for (const path of [...Object.values(pkg.bin), './hooks/local-merge-score-gate.sh']) {
    assert.notEqual(statSync(join(root, path)).mode & 0o111, 0, `${path} precisa ser executavel`);
  }
});

test('hook resolve mecanica no pacote, nunca em scripts vendorizados do consumidor', () => {
  const hook = readFileSync(join(root, 'hooks/local-merge-score-gate.sh'), 'utf8');
  assert.doesNotMatch(hook, /\$ROOT\/scripts\/lms-/);
  assert.match(hook, /PACKAGE_ROOT/);
});

test('spawn abre tmux sem pxpipe e sem scripts/ do consumidor', () => {
  const spawn = readFileSync(join(root, 'scripts/lms-reviewer-spawn.sh'), 'utf8');
  assert.doesNotMatch(spawn, /pxpipe/i);
  assert.doesNotMatch(spawn, /PXPIPE/);
  assert.doesNotMatch(spawn, /\$ROOT\/scripts\//);
  assert.doesNotMatch(spawn, /\.agents\/skills\/local-merge-score/);
  assert.match(spawn, /tmux new-session/);
  assert.equal(existsSync(join(root, 'scripts/lib/resolve-pxpipe-models.sh')), false);
});

test('skill documenta somente a interface publica instalada no consumidor', () => {
  assert.doesNotMatch(skill, /\.claude\/hooks\/local-merge-score-gate\.sh/);
  assert.doesNotMatch(skill, /scripts\/lms-reviewer-(?:spawn|trigger)\.sh/);
  assert.doesNotMatch(skill, /scripts\/lms-reviewer-fallback\.mjs/);
  assert.match(skill, /pnpm exec lms-reviewer/);
  assert.match(skill, /pnpm exec lms-trigger/);
  assert.doesNotMatch(skill, /pnpm lms:(?:reviewer|trigger)/);
  assert.doesNotMatch(skill, /pnpm local:review/);
  assert.doesNotMatch(skill, /pxpipe/i);
  const goalLoop = readFileSync(join(root, 'skills/local-merge-score/references/goal-loop.md'), 'utf8');
  const hook = readFileSync(join(root, 'hooks/local-merge-score-gate.sh'), 'utf8');
  assert.doesNotMatch(goalLoop, /pnpm local:review/);
  assert.doesNotMatch(hook, /pnpm local:review/);
  assert.match(skill, /node_modules\/@dirgocs\/lms-reviewer\/hooks\/local-merge-score-gate\.sh/);
});

test('skill recebe regras de negocio do projeto consumidor', () => {
  assert.doesNotMatch(skill, /Karibu project rules/);
  assert.doesNotMatch(skill, /hotel_id/);
  assert.match(skill, /AGENTS\.md/);
  assert.match(skill, /lms\.config\.json/);
});
