import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { abaixoDosPisos, carregarCasos, compararAchados, runEval } from './lms-eval.mjs';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Task 7 da Fase 4: o próprio LMS precisa de régua — recall de P1 real e taxa de
// falso-positivo conhecido, sobre corpus versionado e anonimizado.

test('carregarCasos le o corpus versionado do pacote (Task 7)', async () => {
  const casos = await carregarCasos(join(raiz, 'evals'));
  assert.equal(casos.length, 3, 'o corpus inicial tem 3 casos curados');
  for (const caso of casos) {
    assert.ok(caso.slug);
    assert.ok(caso.patch.length > 0);
    assert.ok(Array.isArray(caso.esperado.p1));
  }
});

test('corpus vazio é erro, nunca 100% de recall (Task 7)', async () => {
  const vazio = await mkdtemp(join(tmpdir(), 'lms-eval-vazio-'));
  await mkdir(join(vazio, 'casos'), { recursive: true });
  await assert.rejects(() => carregarCasos(vazio), /nenhum caso/i);
});

test('compararAchados: recall e FP sobre o corpus (Task 7)', () => {
  const esperado = {
    p1: [
      { id: 'tenant-1', lens: 'code-safety', path: 'src/pos/emissao.ts' },
      { id: 'paridade-1', lens: 'code-structure', path: 'src/pos/preview.ts' },
    ],
    fp_conhecidos: [{ lens: 'code-safety', path: 'src/webhooks/handler.ts' }],
  };
  // P3-1 da revisao da Fase 4: recall casa apenas achado P1 — um P3 de estilo no
  // mesmo arquivo/lente nao conta como se o P1 tivesse sido achado.
  // P3-5: taxa_fp tem por denominador o fp_conhecidos do corpus, nao o total
  // reportado (que dilui com ruido).
  const obtidos = [
    { lens: 'code-safety', path: 'src/pos/emissao.ts:88', severity: 'P1' },
    { lens: 'code-structure', path: 'src/pos/preview.ts:1', severity: 'P3' },
    { lens: 'code-safety', path: 'src/webhooks/handler.ts:10', severity: 'P1' },
  ];
  const r = compararAchados(esperado, obtidos);
  assert.equal(r.recall_p1, 0.5, 'P3 de estilo nao conta como P1 achado');
  assert.equal(r.taxa_fp, 1); // 1 de 1 fp_conhecido apareceu
});

test('abaixoDosPisos: pisos por env com defaults 0.8/0.2 (Task 7)', () => {
  assert.equal(abaixoDosPisos({ recall_p1: 1, taxa_fp: 0 }, {}), false);
  assert.equal(abaixoDosPisos({ recall_p1: 0.5, taxa_fp: 0 }, {}), true, 'recall abaixo de 0.8');
  assert.equal(abaixoDosPisos({ recall_p1: 1, taxa_fp: 0.5 }, {}), true, 'FP acima de 0.2');
  assert.equal(
    abaixoDosPisos({ recall_p1: 0.5, taxa_fp: 0.5 }, { LMS_EVAL_RECALL_MIN: '0.4', LMS_EVAL_FP_MAX: '1' }),
    false,
    'piso de recall configuravel',
  );
  assert.equal(abaixoDosPisos({ recall_p1: 0.5, taxa_fp: 0.5 }, {}), true, 'FP acima de 0.2 reprova');
});

test('runEval roda o provider por caso e compara (Task 7)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lms-eval-run-'));
  const casos = join(dir, 'casos');
  const slug = 'caso-fixo';
  await mkdir(join(casos, slug), { recursive: true });
  await writeFile(
    join(casos, slug, 'patch.diff'),
    'diff --git a/src/pos/emissao.ts b/src/pos/emissao.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/pos/emissao.ts\n@@ -0,0 +1,3 @@\n+export async function emitir(id) {\n+  return db.emissao.findUnique({ where: { id } });\n+}\n',
  );
  await writeFile(
    join(casos, slug, 'esperado.json'),
    JSON.stringify({ p1: [{ id: 'tenant-1', lens: 'code-safety', path: 'src/pos/emissao.ts' }], fp_conhecidos: [] }),
  );

  const collect = async () => ({
    kind: 'ok',
    candidate: {
      score: 4, target: 5, p0: 0, p1: 1, p2: 0,
      reviewer: 'grok', base: 'HEAD', autonomy: 'reviewer', fallow: 'pass',
      lenses: { 'code-safety': { p0: 0, p1: 1, p2: 0 }, 'code-structure': { p0: 0, p1: 0, p2: 0 }, 'code-quality': { p0: 0, p1: 0, p2: 0 }, 'code-efficiency': { p0: 0, p1: 0, p2: 0 } },
      coverage: [{ surface: 'arquivos alterados', total: 1, inspected: 1 }],
      inspected: [{ path: 'src/pos/emissao.ts', line: 1, quote: 'export async function emitir(id) {' }],
      findings: [{ id: 'tenant-1', lens: 'code-safety', severity: 'P1', confidence: 90, path: 'src/pos/emissao.ts:2', title: 'sem filtro de tenant', why: 'w' }],
      at: new Date().toISOString(),
    },
  });
  const r = await runEval({ dir, env: {}, collect });
  assert.equal(r.casos, 1);
  assert.equal(r.recall_p1, 1);
  assert.equal(r.taxa_fp, 0);
});
