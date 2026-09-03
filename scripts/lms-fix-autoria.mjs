/**
 * Quem escreveu o que, para tirar do julgamento so quem produziu.
 *
 * `authorProvider` exclui o provider INTEIRO da cadeia. Com fix por revisor isso
 * queima um revisor a cada correcao: em tres correcoes nao sobra ninguem e o
 * scorecard cai para `self`, a categoria fraca. A exclusao passa a olhar o delta.
 *
 * Fix revertido (`rejected-scope`) nao conta: nada dele sobrou no disco.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PERSISTIU = new Set(['fixed', 'claimed']);

export async function autoresPorArquivo(root) {
  const mapa = new Map();
  let texto;
  try {
    texto = await readFile(join(root, '.lms', 'fixes.jsonl'), 'utf8');
  } catch {
    return mapa;
  }
  for (const linha of texto.split('\n')) {
    if (!linha.trim()) continue;
    let registro;
    try {
      registro = JSON.parse(linha);
    } catch {
      continue;
    }
    if (!PERSISTIU.has(registro.outcome)) continue;
    for (const arquivo of registro.arquivos ?? []) {
      if (!mapa.has(arquivo)) mapa.set(arquivo, new Set());
      mapa.get(arquivo).add(registro.provider);
    }
  }
  return mapa;
}

export function providerPodeRevisar(provider, changedPaths, autores) {
  return !changedPaths.some((path) => autores.get(path)?.has(provider));
}
