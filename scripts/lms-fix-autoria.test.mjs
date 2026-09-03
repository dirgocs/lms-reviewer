import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { autoresPorArquivo, providerPodeRevisar } from './lms-fix-autoria.mjs';

async function repoCom(linhas) {
  const root = await mkdtemp(join(tmpdir(), 'lms-autoria-'));
  await mkdir(join(root, '.lms'), { recursive: true });
  await writeFile(join(root, '.lms/fixes.jsonl'), linhas.map((l) => JSON.stringify(l)).join('\n'));
  return root;
}

test('sem arquivo de fixes, ninguem e autor', async () => {
  const m = await autoresPorArquivo(await mkdtemp(join(tmpdir(), 'lms-vazio-')));
  assert.equal(m.size, 0);
});

test('mapeia arquivo para quem o corrigiu', async () => {
  const root = await repoCom([
    { id: 'a1', provider: 'grok', outcome: 'fixed', arquivos: ['src/a.ts'] },
  ]);
  const m = await autoresPorArquivo(root);
  assert.deepEqual([...m.get('src/a.ts')], ['grok']);
});

test('fix revertido nao gera autoria', async () => {
  const root = await repoCom([
    { id: 'a1', provider: 'grok', outcome: 'rejected-scope', arquivos: ['src/a.ts'] },
  ]);
  assert.equal((await autoresPorArquivo(root)).size, 0);
});

test('provider que escreveu um dos arquivos nao revisa', () => {
  const autores = new Map([['src/a.ts', new Set(['grok'])]]);
  assert.equal(providerPodeRevisar('grok', ['src/a.ts', 'src/b.ts'], autores), false);
  assert.equal(providerPodeRevisar('claude', ['src/a.ts', 'src/b.ts'], autores), true);
});
