import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  abaixoDosPisos,
  abaixoDosPisosBug,
  carregarCasos,
  compararAchados,
  compararTriagem,
  runEval,
  runEvalBugs,
} from './lms-eval.mjs';

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

// Task 8 da Fase 5: régua de TRIAGEM. `carregarCasos` deixa de fixar
// `casos/patch.diff`, e o corpus de bugs mede acerto de match de agente e de
// localização — o corpus de revisão continua carregando igual.
test('carregarCasos parametrizado nao quebra o corpus de revisao (Task 8)', async () => {
  const padrao = await carregarCasos(join(raiz, 'evals'));
  const explicito = await carregarCasos(join(raiz, 'evals'), {
    sub: 'casos', arquivo: 'patch.diff', campo: 'patch',
  });
  assert.deepEqual(explicito.map((c) => c.slug), padrao.map((c) => c.slug));
  assert.equal(explicito[0].patch, padrao[0].patch);
});

test('carregarCasos le o corpus de bugs com sinal.txt (Task 8)', async () => {
  const bugs = await carregarCasos(join(raiz, 'evals'), {
    sub: 'bugs', arquivo: 'sinal.txt', campo: 'sinal',
  });
  assert.equal(bugs.length, 3, 'o corpus de bugs tem 3 casos curados');
  for (const caso of bugs) {
    assert.ok(caso.sinal.length > 0, 'o sinal e o insumo da triagem');
    assert.ok(caso.esperado.agente, 'esperado nomeia o agente que deveria casar');
    assert.ok(caso.esperado.path, 'esperado nomeia a localizacao');
    assert.ok(Array.isArray(caso.esperado.nao_deve));
  }
});

test('corpus de bugs vazio e erro (Task 8)', async () => {
  const vazio = await mkdtemp(join(tmpdir(), 'lms-eval-bugs-vazio-'));
  await mkdir(join(vazio, 'bugs'), { recursive: true });
  await assert.rejects(
    () => carregarCasos(vazio, { sub: 'bugs', arquivo: 'sinal.txt', campo: 'sinal' }),
    /nenhum caso/i,
  );
});

test('compararTriagem: acerto de match e de localizacao; nao_deve reprova (Task 8)', () => {
  const esperado = { agente: 'workers', path: 'workers/x.py', nao_deve: ['certificado expirado'] };

  const cheio = compararTriagem(esperado, {
    agente: 'workers',
    achado: { path: 'workers/x.py:2', why: 'o retry nao tem teto' },
  });
  assert.equal(cheio.match, 1, 'agente esperado casou');
  assert.equal(cheio.path, 1, 'path-sem-linha bate');
  assert.equal(cheio.nao_deve, 0);

  const erradoDeAgente = compararTriagem(esperado, {
    agente: 'api',
    achado: { path: 'workers/x.py:2', why: 'o retry nao tem teto' },
  });
  assert.equal(erradoDeAgente.match, 0);
  assert.equal(erradoDeAgente.path, 1, 'localizacao e medida separada do match');

  const proibido = compararTriagem(esperado, {
    agente: 'workers',
    achado: { path: 'workers/x.py:2', why: 'o certificado expirado derrubou o worker' },
  });
  assert.equal(proibido.nao_deve, 1, 'citar o nao_deve reprova, como fp_conhecidos');

  const semAchado = compararTriagem(esperado, { agente: null, achado: null });
  assert.equal(semAchado.match, 0);
  assert.equal(semAchado.path, 0);
});

test('abaixoDosPisosBug: pisos por env com defaults 0.8/0.6 (Task 8)', () => {
  assert.equal(abaixoDosPisosBug({ match: 0.8, path: 0.6 }, {}), false);
  assert.equal(abaixoDosPisosBug({ match: 0.7, path: 0.9 }, {}), true, 'match abaixo de 0.8');
  assert.equal(abaixoDosPisosBug({ match: 1, path: 0.5 }, {}), true, 'path abaixo de 0.6');
  assert.equal(
    abaixoDosPisosBug({ match: 0.5, path: 0.5 }, { LMS_EVAL_BUG_MATCH_MIN: '0.4', LMS_EVAL_BUG_PATH_MIN: '0.4' }),
    false,
    'pisos configuraveis por env',
  );
});

test('runEvalBugs tria cada sinal contra os agentes do repo sob teste (Task 8)', async () => {
  // Repo sob teste: os agentes sao do consumidor, nunca do pacote.
  const root = await mkdtemp(join(tmpdir(), 'lms-eval-bugs-'));
  await mkdir(join(root, 'workers'), { recursive: true });
  await writeFile(join(root, 'workers', 'x.py'), 'linha1\nlinha2\n');
  await mkdir(join(root, '.agents/bug-triage'), { recursive: true });
  await writeFile(
    join(root, '.agents/bug-triage', 'workers.md'),
    '---\nnome: workers\ndescricao: workers\nmatch:\n  paths:\n    - "^workers/"\n---\n\nTriar workers.\n',
  );

  const corpus = await mkdtemp(join(tmpdir(), 'lms-eval-corpus-'));
  await mkdir(join(corpus, 'bugs', 'worker-sem-teto'), { recursive: true });
  await writeFile(join(corpus, 'bugs', 'worker-sem-teto', 'sinal.txt'), 'HTTP 500 em workers/x.py:2\n');
  await writeFile(
    join(corpus, 'bugs', 'worker-sem-teto', 'esperado.json'),
    JSON.stringify({ agente: 'workers', path: 'workers/x.py', lens: 'code-safety', severity: 'P1', nao_deve: [] }),
  );

  const resultado = await runEvalBugs({
    dir: corpus,
    root,
    env: {},
    collect: async () => ({
      kind: 'ok',
      candidate: { path: 'workers/x.py:2', lens: 'code-safety', title: 'retry sem teto', why: 'o stack cita workers/x.py:2' },
    }),
  });

  assert.equal(resultado.casos, 1);
  assert.equal(resultado.match, 1, 'o agente esperado casou');
  assert.equal(resultado.path, 1, 'a localizacao bate');
  assert.equal(resultado.por_caso[0].slug, 'worker-sem-teto');
});
