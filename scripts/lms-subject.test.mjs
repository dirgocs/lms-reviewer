import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { reviewSubject } from './lms-subject.mjs';
import { scorecardError } from './lms-scorecard.mjs';
import { authorProvider } from './lms-reviewer-fallback.mjs';

const execFile = promisify(execFileCb);

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'lms-subject-'));
  const git = (...args) => execFile('git', args, { cwd: root });
  await git('init', '-q');
  await git('config', 'user.email', 'teste@karibu');
  await git('config', 'user.name', 'teste');
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf8');
  await git('add', '.');
  await git('commit', '-qm', 'base');
  return { root, git };
}

test('o subject muda quando o codigo muda, em commit ou na arvore suja', async () => {
  const { root, git } = await repo();
  try {
    const base = 'HEAD';
    const inicial = await reviewSubject(root, base);

    // Arquivo novo ainda nao rastreado ja conta: e por onde codigo entra sem passar
    // por commit, e o revisor precisa ser refeito.
    await writeFile(join(root, 'novo.ts'), 'export const novo = 1;\n', 'utf8');
    const comNaoRastreado = await reviewSubject(root, base);
    assert.notEqual(comNaoRastreado, inicial, 'arquivo novo deveria mudar o subject');

    // Mudar o CONTEUDO do arquivo novo, sem mudar o nome, tambem muda.
    await writeFile(join(root, 'novo.ts'), 'export const novo = 2;\n', 'utf8');
    assert.notEqual(await reviewSubject(root, base), comNaoRastreado);

    // Arquivo dentro de DIRETORIO nao rastreado: `status --porcelain` colapsa isso
    // em `?? dir/`, entao o conteudo aninhado nao entrava no hash.
    await mkdir(join(root, 'pasta-nova'), { recursive: true });
    await writeFile(join(root, 'pasta-nova', 'aninhado.ts'), 'export const x = 1;\n', 'utf8');
    const comAninhado = await reviewSubject(root, base);
    await writeFile(join(root, 'pasta-nova', 'aninhado.ts'), 'export const x = 2;\n', 'utf8');
    assert.notEqual(
      await reviewSubject(root, base),
      comAninhado,
      'mudar arquivo dentro de diretorio nao rastreado deveria mudar o subject',
    );

    // Alteracao em arquivo rastreado, sem commit.
    await writeFile(join(root, 'a.ts'), 'export const a = 99;\n', 'utf8');
    const sujo = await reviewSubject(root, base);
    assert.notEqual(sujo, comNaoRastreado);

    // E commitar tambem muda (o diff base...HEAD passa a incluir).
    await git('add', '.');
    await git('commit', '-qm', 'mudanca');
    assert.notEqual(await reviewSubject(root, base), sujo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scorecard de outro diff nao autoriza publicacao', () => {
  const valido = {
    reviewer: 'grok',
    base: 'origin/master',
    subject: 'aaaaaaaaaaaaaaaa',
    at: new Date().toISOString(),
    autonomy: 'reviewer',
    fallow: 'pass',
    score: 5,
    target: 5,
    p0: 0,
    p1: 0,
    p2: 0,
    lenses: {
      'code-safety': { p0: 0, p1: 0, p2: 0 },
      'code-structure': { p0: 0, p1: 0, p2: 0 },
      'code-quality': { p0: 0, p1: 0, p2: 0 },
      'code-efficiency': { p0: 0, p1: 0, p2: 0 },
    },
    inspected: [{ path: 'a.ts', line: 1, quote: 'export const a = 1;' }],
  };
  const opts = { reviewer: 'grok', base: 'origin/master' };

  assert.equal(scorecardError(valido, { ...opts, subject: 'aaaaaaaaaaaaaaaa' }), null);
  assert.match(
    scorecardError(valido, { ...opts, subject: 'bbbbbbbbbbbbbbbb' }) ?? '',
    /reviewed a different diff/,
  );
  // Scorecard antigo, sem subject: nao passa quando o gate sabe calcular o atual.
  const { subject, ...semSubject } = valido;
  assert.match(
    scorecardError(semSubject, { ...opts, subject: 'aaaaaaaaaaaaaaaa' }) ?? '',
    /no subject/,
  );
  // Sem informacao de diff (repo sem git, teste), a checagem e dispensada.
  assert.equal(scorecardError(semSubject, opts), null);
});

test('o modelo autor e identificado pelo ambiente do proprio CLI', () => {
  assert.equal(authorProvider({ CLAUDECODE: '1' }), 'claude');
  assert.equal(authorProvider({ CODEX_HOME: '/x' }), 'codex');
  assert.equal(authorProvider({ GROK_SESSION_ID: 'x' }), 'grok');
  assert.equal(authorProvider({ LMS_AUTHOR: 'grok', CLAUDECODE: '1' }), 'grok', 'override explicito vence');
  assert.equal(authorProvider({}), '');
});
