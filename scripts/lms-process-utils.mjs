import { spawn } from 'node:child_process';

export function collectOutput(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  return {
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

/**
 * Spawn em GRUPO (detached): o filho vira lider do grupo de processos e a unidade
 * de execucao passa a ser o grupo — `sh -c '...' &` nao orfana netos quando o
 * timeout chega. P3-3 da revisao da Fase 2: matar so o shell deixava um `pnpm test`
 * pendurado rodando indefinidamente.
 */
export function spawnEmGrupo(command, args, options = {}) {
  return spawn(command, args, { detached: true, ...options });
}

/**
 * Sinal vai para o GRUPO inteiro (-pid), com fallback ao filho quando grupos
 * nao estao disponiveis (Windows) ou o grupo ja se foi (ESRCH).
 */
export function matarGrupo(child, signal = 'SIGTERM') {
  if (!child.pid) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (erro) {
    if (erro.code === 'ESRCH') return; // o grupo ja morreu
    child.kill(signal);
  }
}
