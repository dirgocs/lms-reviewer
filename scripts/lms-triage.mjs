#!/usr/bin/env node
/**
 * Vale a pena acordar tres revisores por este diff?
 *
 * Deterministico de proposito. Um modelo de triagem seria mais esperto e menos
 * previsivel — e a pergunta aqui e barata: o diff toca caminho de execucao?
 *
 * Falha FECHADA: sem informacao de diff, ou na duvida, revisa. Uma revisao a mais
 * custa tokens; uma a menos custa o gate.
 */
import { changedOpenablePaths } from './lms-inspection.mjs';

// Extensoes sem caminho de execucao. `.sql` NAO entra: migration muda o banco.
const INERTES = /\.(md|mdx|txt|rst|adoc|svg|png|jpe?g|gif|webp|ico|woff2?|ttf)$/i;

// Caminhos que exigem revisao mesmo parecendo inertes: mexer no proprio gate,
// no CI ou nas regras que o revisor le e exatamente o que ninguem deve fazer
// sem segunda opiniao.
const SEMPRE_REVISAR = [
  /^\.github\/workflows\//,
  /^\.claude\/hooks\//,
  /^hooks\//,
  /^scripts\/(lms-|db-exposure-gate|local-merge-score)/,
  /^skills\/local-merge-score\//,
  /^\.greptile\//,
  /(^|\/)migrations\//,
  /(^|\/)(AGENTS|CLAUDE)\.md$/,
];

export function precisaRevisao(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { revisar: true, motivo: 'sem informacao de diff' };
  }
  const obrigatorio = paths.find((p) => SEMPRE_REVISAR.some((re) => re.test(p)));
  if (obrigatorio) return { revisar: true, motivo: `toca superficie sensivel: ${obrigatorio}` };

  const comExecucao = paths.filter((p) => !INERTES.test(p));
  if (comExecucao.length === 0) {
    return { revisar: false, motivo: 'diff apenas de documentacao e assets, sem caminho de execucao' };
  }
  return { revisar: true, motivo: `${comExecucao.length} arquivo(s) com caminho de execucao` };
}

async function main() {
  const i = process.argv.indexOf('--base');
  const base = i >= 0 ? process.argv[i + 1] : 'origin/master';
  const paths = [...await changedOpenablePaths(process.cwd(), base)];
  const { revisar, motivo } = precisaRevisao(paths);
  console.error(`lms-triage: ${revisar ? 'revisar' : 'dispensada'} — ${motivo}`);
  process.exitCode = revisar ? 0 : 10;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
