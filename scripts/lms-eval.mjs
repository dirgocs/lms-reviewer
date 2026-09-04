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
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { collectHeadless, providerConfig, reviewPrompt } from './lms-reviewer-fallback.mjs';
import { carregarAgentes, escolherAgente } from './lms-bug-agents.mjs';
import { loadConfig } from './lms-config.mjs';
import { caminhosDoSinal, normalizarSinal, parseTriagem, triagemPrompt } from './lms-triage-bug.mjs';

const execFile = promisify(execFileCallback);

function pathSemLinha(path) {
  return String(path ?? '').split(':')[0].trim();
}

/**
 * Carrega o corpus. CORPUS VAZIO É ERRO: recall de 100% sobre zero casos é a
 * métrica mais mentirosa possível — o piso precisa de casos para medir contra.
 */
export async function carregarCasos(dir, { sub = 'casos', arquivo = 'patch.diff', campo = 'patch' } = {}) {
  const casosDir = join(dir, sub);
  let entradas;
  try {
    entradas = await readdir(casosDir, { withFileTypes: true });
  } catch (erro) {
    throw new Error(`corpus de eval ausente ou ilegível (${casosDir}): ${erro.message}`);
  }
  const casos = [];
  for (const entrada of entradas.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const pasta = join(casosDir, entrada.name);
    const conteudo = await readFile(join(pasta, arquivo), 'utf8');
    let esperado;
    try {
      esperado = JSON.parse(await readFile(join(pasta, 'esperado.json'), 'utf8'));
    } catch (erro) {
      // Falha fechada e nomeada: esperado malformado inutiliza o caso como régua.
      throw new Error(`esperado.json malformado no caso '${entrada.name}': ${erro.message}`);
    }
    casos.push({ slug: entrada.name, [campo]: conteudo, esperado });
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
  // P3-1 da revisao da Fase 4: recall casa apenas achado P1 — um P3 de estilo no
  // mesmo arquivo/lente nao conta como se o P1 esperado tivesse sido achado.
  const obtidosNorm = (Array.isArray(obtidos) ? obtidos : [])
    .filter((f) => f.severity === 'P1')
    .map((f) => ({
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
  const fpsConhecidos = esperado.fp_conhecidos ?? [];
  const fpsEncontrados = fpsConhecidos.filter(casa).length;
  const totalEsperado = esperadosP1.length;
  // P3-5 da revisao da Fase 4: denominador = fp_conhecidos do corpus. O total
  // reportado dilui com ruido: 20 achados quaisquer + o FP ficava em 0.05.
  const taxaFp = fpsConhecidos.length > 0 ? fpsEncontrados / fpsConhecidos.length : 0;

  return {
    recall_p1: totalEsperado > 0 ? encontrados / totalEsperado : 1,
    taxa_fp: taxaFp,
    encontrados,
    total_esperado: totalEsperado,
    fps_encontrados: fpsEncontrados,
    total_reportado: obtidosNorm.length,
  };
}

/** Pisos: recall mínimo e teto de falso-positivo, configuráveis por env. */
export function abaixoDosPisos(resultado, env = process.env) {
  const recallMin = Number(env?.LMS_EVAL_RECALL_MIN ?? 0.8);
  const fpMax = Number(env?.LMS_EVAL_FP_MAX ?? 0.2);
  return resultado.recall_p1 < recallMin || resultado.taxa_fp > fpMax;
}

/**
 * Regua da TRIAGEM (spec §3.6), separada de compararAchados: mede acerto de
 * MATCH (agente escolhido = esperado) e acerto de LOCALIZACAO (path-sem-linha),
 * medidos de forma independente — casar o agente errado no arquivo certo e um
 * defeito diferente de casar o agente certo no arquivo errado.
 *
 * `nao_deve` e o analogo de `fp_conhecidos`: classe que a triagem NAO pode citar.
 */
export function compararTriagem(esperado, resultado) {
  const agenteObtido = resultado?.agente ?? null;
  const achado = resultado?.achado ?? null;
  const match = agenteObtido && agenteObtido === esperado?.agente ? 1 : 0;
  const path = achado && pathSemLinha(achado.path) === pathSemLinha(esperado?.path) ? 1 : 0;

  const texto = achado
    ? `${achado.title ?? ''} ${achado.why ?? ''} ${achado.fix ?? ''}`.toLowerCase()
    : '';
  const proibidos = Array.isArray(esperado?.nao_deve) ? esperado.nao_deve : [];
  const nao_deve = proibidos.some((classe) => texto.includes(String(classe).toLowerCase())) ? 1 : 0;

  return { match, path, nao_deve };
}

/** Pisos da triagem: acerto de match e de localizacao, configuraveis por env. */
export function abaixoDosPisosBug(resultado, env = process.env) {
  const matchMin = Number(env?.LMS_EVAL_BUG_MATCH_MIN ?? 0.8);
  const pathMin = Number(env?.LMS_EVAL_BUG_PATH_MIN ?? 0.6);
  return resultado.match < matchMin || resultado.path < pathMin;
}

/**
 * Roda a triagem contra cada `sinal.txt`: sem aplicar patch e sem repo temporario
 * — o repo SOB TESTE (`root`) e quem tem os agentes, porque a inteligencia de
 * dominio mora no consumidor. Uma triagem que cita `nao_deve` reprova o caso
 * inteiro, como fp_conhecidos no corpus de revisao.
 */
export async function runEvalBugs({ dir, root = process.cwd(), env = process.env, collect = collectHeadless } = {}) {
  const casos = await carregarCasos(dir, { sub: 'bugs', arquivo: 'sinal.txt', campo: 'sinal' });
  const config = providerConfig(env);
  const provider = config.order[0];
  const agentes = await carregarAgentes(root, loadConfig(root).bugAgents.dir);
  const porCaso = [];

  for (const caso of casos) {
    const sinal = normalizarSinal(caso.sinal, `arquivo:${caso.slug}/sinal.txt`);
    sinal.caminhos_citados = await caminhosDoSinal(caso.sinal, root);
    const agente = escolherAgente(agentes, sinal);

    const saida = await collect({
      root, provider, config, base: 'HEAD', env,
      prompt: triagemPrompt(sinal, agente, []),
      parse: parseTriagem,
    }).catch(() => ({ kind: 'error' }));
    const achado = saida.kind === 'ok' ? (saida.candidate ?? null) : null;

    porCaso.push({ slug: caso.slug, ...compararTriagem(caso.esperado, { agente: agente?.nome ?? null, achado }) });
  }

  const soma = (chave) => porCaso.reduce((s, c) => s + c[chave], 0);
  return {
    casos: casos.length,
    match: soma('match') / casos.length,
    path: soma('path') / casos.length,
    // Citar classe proibida nao entra na media: reprova direto, como fp_conhecidos.
    nao_deve: soma('nao_deve'),
    por_caso: porCaso,
  };
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
    // P3-2 da revisao da Fase 4: cada caso cria um repo git em /tmp — sem o rm,
    // cada rodada de eval deixava N repos para tras.
    await rm(root, { recursive: true, force: true });
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
  // carregarCasos acrescenta o subdiretorio ao dir passado: aqui o dir e a RAIZ do pacote.
  const raizPacote = dirname(dirname(fileURLToPath(import.meta.url)));

  if (process.argv.slice(2).includes('--bugs')) {
    const resultado = await runEvalBugs({
      dir: join(raizPacote, 'evals'),
      root: process.cwd(),
      env: process.env,
    });
    console.log(JSON.stringify(resultado, null, 2));
    if (resultado.nao_deve > 0 || abaixoDosPisosBug(resultado, process.env)) {
      console.error('lms-eval: triagem abaixo dos pisos de match/localizacao (ou citou classe de nao_deve)');
      process.exitCode = 1;
    }
    return;
  }

  const resultado = await runEval({ dir: join(raizPacote, 'evals'), env: process.env });
  console.log(JSON.stringify(resultado, null, 2));
  if (abaixoDosPisos(resultado, process.env)) {
    console.error('lms-eval: abaixo dos pisos de recall/falso-positivo — não registre a troca de prompt/provider');
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
