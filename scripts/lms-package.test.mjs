import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('v1.1 expoe todos os comandos usados pelo consumidor', () => {
  assert.equal(pkg.version, '1.1.0');
  assert.deepEqual(pkg.bin, {
    'lms-trigger': './scripts/lms-reviewer-trigger.sh',
    'lms-reviewer': './scripts/lms-reviewer-spawn.sh',
    'lms-reviewer-tmux': './scripts/lms-reviewer-tmux.mjs',
    'lms-push-gate': './scripts/lms-push-gate.mjs',
    'lms-exempt-paths': './scripts/lms-exempt-paths.mjs',
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
