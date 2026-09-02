#!/usr/bin/env node
/**
 * Identidade do que foi revisado.
 *
 * O gate validava o scorecard por IDADE (2h) e pelo NOME do ref base — nada amarrava
 * o parecer ao código que o revisor viu. Na prática: consegue-se um 5/5, commita-se
 * outra coisa nas duas horas seguintes e o push passa. A própria mensagem do gate
 * admitia isso em prosa ("re-score if code changed after the scorecard"), o que é um
 * pedido ao agente, não uma trava.
 *
 * `reviewSubject` resume o diff inteiro — commits e árvore suja — num hash. O runner
 * carimba, o gate recalcula e recusa quando não bate.
 */
import { createHash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

async function git(root, args) {
  try {
    const { stdout } = await execFile('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

/**
 * Hash do que está sendo publicado: commits desde a base, mudanças não commitadas e
 * conteúdo dos arquivos novos ainda não rastreados.
 *
 * A árvore suja entra porque o contexto do revisor hoje é `base...HEAD` e ignora o
 * working tree — sem incluí-la aqui, a amarra teria o mesmo buraco que ela fecha.
 */
export async function reviewSubject(root = process.cwd(), base = 'origin/master') {
  // Fora de um repositório git não há como saber o que mudou. Devolver hash de
  // conteúdo vazio faria o gate exigir um subject que não significa nada; devolver
  // vazio diz "não sei", e a checagem se dispensa — mesma convenção que a prova de
  // leitura já usa quando não há informação de diff.
  const dentroDeRepo = await git(root, ['rev-parse', '--git-dir']);
  if (!dentroDeRepo.trim()) return '';

  // CONTEÚDO por caminho, e não texto de diff. As duas formas anteriores carregavam
  // a POSIÇÃO da fronteira junto com os bytes: a soma `base...HEAD` + `diff HEAD`
  // mudava quando os mesmos bytes eram apenas commitados, e mesmo um diff único
  // contra o merge-base ainda mudava quando um arquivo NOVO saía de "não rastreado"
  // (hasheado como caminho+conteúdo) para "rastreado" (hasheado como texto de diff).
  // Efeito real das duas: revisão limpa feita na árvore suja morria no commit, e o
  // push re-rodava a cadeia inteira (mediana histórica de 10,3 min) para reler
  // bytes idênticos.
  //
  // A forma estável é uma só: para cada caminho que difere do merge-base — rastreado
  // ou não — entra `caminho\0conteúdo-atual-do-disco` (vazio para deleção). Commit,
  // stage e untracked viram embalagem; o hash muda quando bytes mudam, e SÓ quando
  // bytes mudam.
  const mergeBase = (await git(root, ['merge-base', base, 'HEAD'])).trim();
  const alterados = (await git(root, ['diff', '--name-only', mergeBase || base, '--']))
    .split('\n')
    .map((linha) => linha.trim())
    .filter(Boolean);

  // `status --porcelain` colapsa diretório não rastreado numa linha só (`?? dir/`),
  // então mudar arquivo dentro dele não mexia no hash — metade da amarra da árvore
  // suja ficava furada. `ls-files --others` lista arquivo a arquivo, recursivamente.
  const naoRastreados = (await git(root, ['ls-files', '--others', '--exclude-standard']))
    .split('\n')
    .map((linha) => linha.trim())
    .filter(Boolean);

  const caminhos = [...new Set([...alterados, ...naoRastreados])].sort();
  const partes = [];
  for (const caminho of caminhos) {
    // Nome não basta: o mesmo arquivo pode mudar de conteúdo sem mudar de nome, e o
    // revisor precisa ser refeito quando isso acontece. Deleção entra como vazio.
    partes.push(caminho, await readFile(join(root, caminho), 'utf8').catch(() => ''));
  }

  return createHash('sha256').update(partes.join('\0')).digest('hex').slice(0, 16);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2] ?? 'origin/master';
  console.log(await reviewSubject(process.cwd(), base));
}
