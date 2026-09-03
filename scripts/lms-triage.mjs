#!/usr/bin/env node
/**
 * Vale a pena acordar tres revisores por este diff?
 *
 * Deterministico de proposito. Um modelo de triagem seria mais esperto e menos
 * previsivel — e a pergunta aqui e barata: o diff toca caminho de execucao?
 *
 * Falha FECHADA: sem informacao de diff, ou na duvida, revisa. Uma revisao a mais
 * custa tokens; uma a menos custa o gate.
 *
 * P2-2 da revisao da Fase 2: a isencao e a MESMA regra do gate (`isExempt` +
 * `lms.config.json`), nao uma copia — copia divergindo para o lado permissivo
 * virava bypass silencioso, e divergindo para o rigor virava deadlock (trigger
 * dispensa, gate barra por scorecard ausente).
 */
import { changedOpenablePaths } from './lms-inspection.mjs';
import { isExempt } from './lms-exempt-paths.mjs';
import { DEFAULT_EXEMPT_PATHS, loadConfig } from './lms-config.mjs';

// Caminhos que exigem revisao mesmo quando o diff e isento: mexer no proprio
// gate, no CI ou nas regras que o revisor le e exatamente o que ninguem deve
// fazer sem segunda opiniao.
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

export function precisaRevisao(
  paths,
  config = { exemptPaths: DEFAULT_EXEMPT_PATHS, nonExemptPaths: [] },
) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { revisar: true, motivo: 'sem informacao de diff' };
  }
  const obrigatorio = paths.find((p) => SEMPRE_REVISAR.some((re) => re.test(p)));
  if (obrigatorio) return { revisar: true, motivo: `toca superficie sensivel: ${obrigatorio}` };

  if (isExempt(paths, config)) {
    return { revisar: false, motivo: 'diff isento: apenas documentacao e assets, sem caminho de execucao' };
  }
  return { revisar: true, motivo: `${paths.length} arquivo(s) fora da regra de isencao do gate` };
}

async function main() {
  const i = process.argv.indexOf('--base');
  const base = i >= 0 ? process.argv[i + 1] : 'origin/master';
  const paths = [...await changedOpenablePaths(process.cwd(), base)];
  const { revisar, motivo } = precisaRevisao(paths, loadConfig(process.cwd()));
  console.error(`lms-triage: ${revisar ? 'revisar' : 'dispensada'} — ${motivo}`);
  process.exitCode = revisar ? 0 : 10;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
