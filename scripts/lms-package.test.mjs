import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const skill = readFileSync(join(root, 'skills/local-merge-score/SKILL.md'), 'utf8');

test('v1.4 expoe todos os comandos usados pelo consumidor', () => {
  assert.equal(pkg.version, '1.4.1');
  assert.deepEqual(pkg.bin, {
    'lms-trigger': './scripts/lms-reviewer-trigger.sh',
    'lms-reviewer': './scripts/lms-reviewer-spawn.sh',
    'lms-reviewer-tmux': './scripts/lms-reviewer-tmux.mjs',
    'lms-push-gate': './scripts/lms-push-gate.mjs',
    'lms-exempt-paths': './scripts/lms-exempt-paths.mjs',
    // P3-1 da revisao da Fase 3: o consumidor dispara bins, nao scripts internos.
    'lms-fix': './scripts/lms-fix.mjs',
    'lms-reverificar': './scripts/lms-reverificar.mjs',
    'lms-eval': './scripts/lms-eval.mjs',
    'lms-triage-bug': './scripts/lms-triage-bug.mjs',
  });
});

test('artefato publicado inclui hook, skill, docs e config de exemplo', () => {
  // Fase 5: o corpus de eval viaja no artefato — sem ele `lms-eval` (e `--bugs`)
  // nao tem regua nenhuma para medir no consumidor.
  for (const path of ['scripts/', 'hooks/', 'skills/', 'docs/', 'evals/', 'lms.config.example.json', 'README.md', 'CHANGELOG.md']) {
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

// Task 9 da Fase 5: a triagem de bug e interface publica — precisa estar
// documentada no README (tabela de binarios) e na SKILL, com o invariante.
test('README e SKILL documentam a triagem de bug (Task 9)', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.match(readme, /lms-triage-bug/, 'a tabela de binarios inclui o bin novo');

  assert.match(skill, /## Triagem de bug/, 'a SKILL tem a secao da triagem');
  assert.match(skill, /onde olhar/i, 'o invariante: o agente influencia onde olhar');
  assert.match(skill, /pnpm exec lms-triage-bug/, 'a SKILL documenta o bin, nao o script interno');
  assert.match(skill, /\.lms\/veredito\.json/, 'como esperar o veredito');
});

test('CHANGELOG registra a 1.4.0 com a triagem de bug (Task 9)', () => {
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## \[1\.4\.1\]/);
  assert.match(changelog, /## \[1\.4\.0\]/);
  assert.match(changelog, /lms-triage-bug/);
});
