#!/usr/bin/env node
/**
 * Golden set de evals do próprio LMS (Fase 4).
 *
 * Os relatórios de fechamento aprovavam trocas de prompt e providers novos por
 * leitura, sem medida de recall nem de falso-positivo. Aqui o corpus versionado
 * (`evals/casos/`) é a régua: cada caso tem o diff revisado e o esperado —
 * achado real esperado (conta recall) e falso-positivo conhecido (se aparecer,
 * conta FP). Título nunca é chave; casamento por (lens, path) + id.
 *
 * Regra de processo (spec §3.3): trocar `reviewPrompt` ou acrescentar provider a
 * `LMS_REVIEWER_ORDER` exige rodada de `lms-eval` registrada no CHANGELOG.
 * Exit 1 abaixo dos pisos (`LMS_EVAL_RECALL_MIN` 0.8, `LMS_EVAL_FP_MAX` 0.2).
 */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { collectHeadless, providerConfig, reviewPrompt } from './lms-reviewer-fallback.mjs';

const execFile = promisify(execFileCallback);

function pathSemLinha(path) {
  return String(path ?? '').split(':')[0].trim();
}

/**
 * Carrega o corpus. CORPUS VAZIO É ERRO: recall de 100% sobre zero casos é a
 * métrica mais mentirosa possível — o piso precisa de casos para medir contra.
 */
export async function carregarCasos(dir) {
  const casosDir = join(dir, 'casos');
  let entradas;
  try {
    entradas = await readdir(casosDir, { withFileTypes: true });
  } catch (erro) {
    throw new Error(`corpus de eval ausente ou ilegível (${casosDir}): ${erro.message}`);
  }
  const casos = [];
  for (const entrada of entradas.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const pasta = join(casosDir, entrada.name);
    const patch = await readFile(join(pasta, 'patch.diff'), 'utf8');
    let esperado;
    try {
      esperado = JSON.parse(await readFile(join(pasta, 'esperado.json'), 'utf8'));
    } catch (erro) {
      // Falha fechada e nomeada: esperado malformado inutiliza o caso como régua.
      throw new Error(`esperado.json malformado no caso '${entrada.name}': ${erro.message}`);
    }
    casos.push({ slug: entrada.name, patch, esperado });
  }
  if (casos.length === 0) {
    throw new Error(`nenhum caso em ${casosDir} — recall sobre corpus vazio é 100% falso; cure casos primeiro`);
  }
  return casos;
}

/**
 * Compara o esperado com os achados reportados. Casamento por (lens, path-sem-
 * linha); `id` decide quando ambos têm id estável. `fp_conhecidos` que aparecerem
 * contam FP — reportar classe já derrubada é falso-positivo, não rigor.
 */
export function compararAchados(esperado, obtidos) {
  const obtidosNorm = (Array.isArray(obtidos) ? obtidos : []).map((f) => ({
    lens: f.lens ?? '',
    path: pathSemLinha(f.path),
  }));
  const casa = (alvo) =>
    obtidosNorm.some(
      (o) => o.lens === alvo.lens && o.path === pathSemLinha(alvo.path),
    );

  const esperadosP1 = esperado.p1 ?? [];
  let encontrados = 0;
  for (const alvo of esperadosP1) {
    if (casa(alvo)) encontrados += 1;
  }
  const fpsEncontrados = (esperado.fp_conhecidos ?? []).filter(casa).length;
  const totalEsperado = esperadosP1.length;
  const totalReportado = obtidosNorm.length;

  return {
    recall_p1: totalEsperado > 0 ? encontrados / totalEsperado : 1,
    taxa_fp: totalReportado > 0 ? fpsEncontrados / totalReportado : 0,
    encontrados,
    total_esperado: totalEsperado,
    fps_encontrados: fpsEncontrados,
    total_reportado: totalReportado,
    por_caso: [{ recall_p1: totalEsperado > 0 ? encontrados / totalEsperado : 1, taxa_fp: totalReportado > 0 ? fpsEncontrados / totalReportado : 0 }],
  };
}

/** Pisos: recall mínimo e teto de falso-positivo, configuráveis por env. */
export function abaixoDosPisos(resultado, env = process.env) {
  const recallMin = Number(env?.LMS_EVAL_RECALL_MIN ?? 0.8);
  const fpMax = Number(env?.LMS_EVAL_FP_MAX ?? 0.2);
  return resultado.recall_p1 < recallMin || resultado.taxa_fp > fpMax;
}

function aggregate(casos) {
  const totalEsperado = casos.reduce((s, c) => s + c.total_esperado, 0);
  const encontrados = casos.reduce((s, c) => s + c.encontrados, 0);
  const totalReportado = casos.reduce((s, c) => s + c.total_reportado, 0);
  const fps = casos.reduce((s, c) => s + c.fps_encontrados, 0);
  return {
    recall_p1: totalEsperado > 0 ? encontrados / totalEsperado : 1,
    taxa_fp: totalReportado > 0 ? fps / totalReportado : 0,
  };
}

/**
 * Roda o provider contra o corpus: cada caso é aplicado num repo temporário e o
 * prompt de revisão vê o diff; os achados reportados são comparados ao esperado.
 */
export async function runEval({ dir, env = process.env, collect = collectHeadless } = {}) {
  const casos = await carregarCasos(dir);
  const config = providerConfig(env);
  const provider = config.order[0];
  const porCaso = [];
  const comparacoes = [];

  for (const caso of casos) {
    const root = await mkdtemp(join(tmpdir(), 'lms-eval-caso-'));
    await execFile('git', ['init', '-q'], { cwd: root });
    await execFile('git', ['config', 'user.email', 'eval@lms'], { cwd: root });
    await execFile('git', ['config', 'user.name', 'eval'], { cwd: root });
    const patchPath = join(root, 'caso.patch');
    await writeFile(patchPath, caso.patch);
    await execFile('git', ['apply', '--whitespace=nowarn', patchPath], { cwd: root });

    const prompt = reviewPrompt('HEAD', provider, caso.patch);
    const saida = await collect({
      root, provider, config, base: 'HEAD', env, prompt,
    }).catch(() => ({ kind: 'error' }));
    const findings = saida.kind === 'ok' ? (saida.candidate?.findings ?? []) : [];

    const comparacao = compararAchados(caso.esperado, findings);
    porCaso.push({ slug: caso.slug, ...comparacao });
    comparacoes.push(comparacao);
  }

  const { recall_p1, taxa_fp } = aggregate(comparacoes);
  return {
    casos: casos.length,
    recall_p1,
    taxa_fp,
    por_caso: porCaso.map((c) => ({ slug: c.slug, recall_p1: c.recall_p1, taxa_fp: c.taxa_fp })),
  };
}

async function main() {
  // carregarCasos acrescenta 'casos' ao dir passado: aqui o dir e a RAIZ do pacote.
  const raizPacote = dirname(dirname(fileURLToPath(import.meta.url)));
  const resultado = await runEval({ dir: raizPacote, env: process.env });
  console.log(JSON.stringify(resultado, null, 2));
  if (abaixoDosPisos(resultado, process.env)) {
    console.error('lms-eval: abaixo dos pisos de recall/falso-positivo — não registre a troca de prompt/provider');
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
