import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { precisaRevisao } from './lms-triage.mjs';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

// P3-4 da revisao da Fase 2: o contrato do CLI — exit 10 e "dispensada", 0 e
// revisar. 1 fica reservado para "algo deu errado".
test('CLI sai 10 quando dispensa', async () => {
  const rodar = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), 'lms-triage-cli-'));
  try {
    await rodar('git', ['init', '-q'], { cwd: root });
    await rodar('git', ['config', 'user.email', 't@t'], { cwd: root });
    await rodar('git', ['config', 'user.name', 't'], { cwd: root });
    await rodar('git', ['commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'leia.md'), '# doc\n', 'utf8');
    await rodar('git', ['add', 'docs'], { cwd: root });
    await rodar('git', ['commit', '-q', '-m', 'doc'], { cwd: root });
    const dispensada = await rodar(process.execPath, [resolve(raiz, 'scripts/lms-triage.mjs'), '--base', 'HEAD~1'], { cwd: root }).catch((e) => e);
    assert.equal(dispensada.code, 10);
    assert.match(String(dispensada.stderr), /dispensada/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
