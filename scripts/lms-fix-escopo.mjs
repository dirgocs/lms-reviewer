/**
 * Guarda de escopo do fix.
 *
 * O risco real do fix por revisor nao e o conserto errado — e o "ja que estou aqui".
 * Um agente com escrita e um mandato refatora mais do que o achado. A guarda e
 * mecanica: o diff que o fix produziu tem de caber nos arquivos que o achado citou.
 *
 * Violacao reverte o fix INTEIRO. Aceitar a parte boa de um fix que estourou o escopo
 * seria deixar o agente negociar o proprio limite.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { caminhoProibido } from './lms-fix-routing.mjs';

const execFile = promisify(execFileCallback);

export function escopoViolado(alterados, permitidos) {
  const proibido = alterados.find(caminhoProibido);
  if (proibido) return `o fix escreveu em caminho proibido: ${proibido}`;
  if (alterados.length === 0) return 'o fix nao alterou nenhum arquivo';
  const permitidoSet = new Set(permitidos);
  const fora = alterados.filter((p) => !permitidoSet.has(p));
  return fora.length > 0
    ? `o fix alterou arquivo fora do escopo do achado: ${fora.slice(0, 5).join(', ')}`
    : null;
}

/** Arquivos que mudaram na arvore desde `desde` (SHA de `git stash create`). */
export async function arquivosAlterados(root, desde) {
  const args = desde
    ? ['diff', '--name-only', desde]
    : ['status', '--porcelain'];
  const { stdout } = await execFile('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return stdout
    .split('\n')
    .map((linha) => (desde ? linha.trim() : linha.slice(3).trim()))
    .filter(Boolean);
}

/**
 * Desfaz o fix, arquivo por arquivo.
 *
 * `git checkout --` nos rastreados e `git clean -f` nos novos, NUNCA `reset --hard`:
 * a arvore e compartilhada com o Master e com outras lanes, e um reset apagaria
 * trabalho que nao e do fix.
 */
export async function reverter(root, arquivos) {
  for (const arquivo of arquivos) {
    try {
      await execFile('git', ['checkout', '--', arquivo], { cwd: root });
    } catch {
      // Arquivo novo nao tem versao anterior para restaurar: some com clean.
      await execFile('git', ['clean', '-f', '--', arquivo], { cwd: root }).catch(() => {});
    }
  }
}
