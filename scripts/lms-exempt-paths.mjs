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

export function isExempt(files, { exemptPaths, nonExemptPaths }) {
  const lista = files.map((f) => f.trim()).filter(Boolean);
  if (lista.length === 0) return false;
  const isentos = exemptPaths.map((re) => new RegExp(re));
  const nunca = nonExemptPaths.map((re) => new RegExp(re));
  if (!lista.every((f) => isentos.some((re) => re.test(f)))) return false;
  if (lista.some((f) => nunca.some((re) => re.test(f)))) return false;
  return true;
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
