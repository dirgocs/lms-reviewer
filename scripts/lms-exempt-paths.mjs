#!/usr/bin/env node
// LMS pontua CODIGO. Este script decide se um conjunto de arquivos tem o que pontuar.
//
//   printf '%s\n' <arquivos> | lms-exempt-paths
//     exit 0  -> isento: TODO arquivo casa com `exemptPaths` e NENHUM com `nonExemptPaths`
//     exit 1  -> nao isento (inclui conjunto vazio)
//
// Duas familias de path nao tem o que pontuar por default: doc pura (markdown, texto,
// docs/) — as quatro lentes do scorecard nao se aplicam. O que mais e isento e fato do
// PROJETO (skills de agente, corpus oficial imutavel) e vem de `lms.config.json`:
//
//   exemptPaths     lista de ERE; isento so se TODO arquivo casa com pelo menos uma
//   nonExemptPaths  lista de ERE; qualquer arquivo que case NUNCA e isento, avaliada
//                   depois — e o jeito de abrir excecao dentro de um prefixo isento
//                   (ex.: XSD dentro de um corpus de documentacao que o runtime carrega)
//
//   codePaths       lista de ERE; quando declarada INVERTE a regra: tudo e isento, salvo
//                   o conjunto que tenha ao menos um arquivo casando aqui (ou em
//                   nonExemptPaths). O LMS pontua codigo; doc, tooling de agente, bump
//                   de devDependency e lockfile nao acordam revisor (Master, 2026-09-13).
//
// MISTO continua barrado, de proposito: isentar mistura deixaria qualquer diff pegar
// carona numa linha de markdown.
//
// Conjunto VAZIO nao e isento. Nao conseguir listar os arquivos nao prova que nao ha
// codigo — prova que nao se sabe. Falha fechada.
//
// A regra mora aqui e em nenhum outro lugar: ela e usada pelo `lms-push-gate` (o gate
// que barra o push de verdade) e pelo `hooks/local-merge-score-gate.sh` (que orienta o
// agente). Duas copias divergiriam, e a que divergisse para o lado permissivo viraria
// um bypass silencioso.
//
// As ERE sao compiladas como RegExp do JS. O dialeto que a regra original usava era o
// do `grep -E`; o subconjunto comum (ancoras, grupos, alternancia, classes, `\.`)
// cobre o que uma regra de path precisa — nao use classes POSIX `[[:alpha:]]` nem
// backreference.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lms-config.mjs';

export function isExempt(files, { exemptPaths, nonExemptPaths, codePaths = [] }) {
  const lista = files.map((f) => f.trim()).filter(Boolean);
  if (lista.length === 0) return false;
  const nunca = nonExemptPaths.map((re) => new RegExp(re));
  if (lista.some((f) => nunca.some((re) => re.test(f)))) return false;
  // Lógica invertida (diretriz Master 2026-09-13): o projeto declara o que é CÓDIGO
  // e tudo o mais — doc, tooling de agente, bump de devDependency, lockfile, hook —
  // é isento. Só um arquivo de código no conjunto acorda a cadeia. Antes, o bump do
  // próprio lms-reviewer em package.json disparava rodada de revisores.
  if (codePaths.length > 0) {
    const codigo = codePaths.map((re) => new RegExp(re));
    return !lista.some((f) => codigo.some((re) => re.test(f)));
  }
  const isentos = exemptPaths.map((re) => new RegExp(re));
  return lista.every((f) => isentos.some((re) => re.test(f)));
}

function main() {
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    // stdin fechado/ausente e o mesmo que conjunto vazio: nao isento.
  }
  const config = loadConfig();
  process.exit(isExempt(input.split('\n'), config) ? 0 : 1);
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
