import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { diffContext } from './lms-reviewer-fallback.mjs';

/** Repo temporario com um commit base e um commit que mexe em codigo humano E em
 *  artefato gerado — o formato exato que cegou a cadeia por 34 rodadas. */
function repoComArtefatoGerado({ lockfileNaRaiz = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lms-diff-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(root, 'seed'), 'x\n');
  git('add', 'seed');
  git('commit', '-qm', 'seed');
  const base = git('rev-parse', 'HEAD').trim();

  mkdirSync(join(root, 'services/api/src'), { recursive: true });
  mkdirSync(join(root, 'packages/api-db-client/generated/prisma/models'), { recursive: true });
  writeFileSync(join(root, 'services/api/src/rota.ts'), 'export const a = 1\n');
  // muitos arquivos gerados: e o VOLUME deles que empurrava o codigo humano para fora
  for (let i = 0; i < 200; i += 1) {
    writeFileSync(
      join(root, `packages/api-db-client/generated/prisma/models/Modelo${i}.ts`),
      `export type M${i} = { campo: string }\n`,
    );
  }
  if (lockfileNaRaiz) writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  git('add', '-A');
  git('commit', '-qm', 'mudanca');
  return { root, base };
}

test('artefato gerado sai do mapa, e o codigo humano entra', async () => {
  const { root, base } = repoComArtefatoGerado();
  const { text, paths } = await diffContext(root, base);

  assert.ok(
    text.includes('services/api/src/rota.ts'),
    'o arquivo de services PRECISA aparecer — era exatamente ele que sumia',
  );
  assert.ok(
    !text.includes('generated/prisma/models/Modelo0.ts'),
    'artefato gerado nao e codigo para revisar',
  );
  assert.ok(
    [...paths].some((p) => p === 'services/api/src/rota.ts'),
    'o caminho humano continua valido para `inspected`',
  );
  assert.ok(
    ![...paths].some((p) => p.includes('generated/prisma')),
    'inspecionar artefato gerado nao conta como prova de leitura',
  );
});

test('o mapa AVISA o que ficou de fora — corte silencioso le-se como "revisei tudo"', async () => {
  const { root, base } = repoComArtefatoGerado();
  const { text } = await diffContext(root, base);

  assert.match(text, /Fora do mapa de propósito: 200 arquivo\(s\) de artefato gerado/);
  assert.match(text, /não os cite em `inspected`/);
});

test('lockfile NA RAIZ tambem e artefato: sai do mapa e entra na contagem', async () => {
  // Pathspec do git exige a '/' literal: `**/pnpm-lock.yaml` casa `sub/pnpm-lock.yaml`
  // mas NAO a raiz — e bump de dependencia (o caso mais comum de lockfile) e na raiz.
  const { root, base } = repoComArtefatoGerado({ lockfileNaRaiz: true });
  const { text, paths } = await diffContext(root, base);

  assert.ok(!text.includes('pnpm-lock.yaml'), 'o lockfile da raiz nao e codigo para revisar');
  assert.match(
    text,
    /Fora do mapa de propósito: 201 arquivo\(s\)/,
    'o lockfile da raiz tem de entrar na CONTAGEM do aviso, nao so sair do mapa',
  );
  assert.ok(![...paths].includes('pnpm-lock.yaml'), 'lockfile nao vale como prova de leitura');
});
