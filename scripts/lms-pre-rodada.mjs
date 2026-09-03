#!/usr/bin/env node
/**
 * Suíte verde como pré-condição de rodada (Fase 4).
 *
 * A triagem só pergunta SE o diff merece revisão; nunca SE O DIFF ESTÁ DE PÉ.
 * Suíte vermelha consumia três providers para produzir achados que o node --test
 * daria de graça. Este degrau roda o `testCommand` de `lms.config.json` antes de
 * gastar cota.
 *
 * Falha FECHADA onde importa: vermelho = rodada recusada (exit 11, nenhum provider).
 * Falha de FERRAMENTA (comando inexistente, timeout) NÃO decide: avisa e segue —
 * mesmo precedente da triagem, erro de infra nunca decide sozinho.
 * A chave é opcional por desenho: repo sem suíte não declara `testCommand` e o
 * degrau é pulado com aviso.
 *
 * CLI: exit 0 (pulado/verde/erro-de-ferramenta) · exit 11 (vermelho).
 */
import { spawnEmGrupo, matarGrupo } from './lms-process-utils.mjs';

/** Últimas N linhas de um texto — o que o trigger mostra no stderr do exit 11. */
export function cauda(texto, linhas = 20) {
  const partes = String(texto ?? '').split('\n').filter((l) => l.trim().length > 0);
  return partes.slice(-linhas).join('\n');
}

/** { cmd, args } | null — aceita string ("pnpm test") ou objeto { cmd, args }. */
export function comandoDeTeste(config) {
  const valor = config?.testCommand ?? null;
  if (!valor) return null;
  if (typeof valor === 'string' && valor.trim()) {
    return { cmd: valor.trim(), args: [] };
  }
  if (
    valor && typeof valor === 'object' && typeof valor.cmd === 'string' && valor.cmd.trim() &&
    Array.isArray(valor.args) && valor.args.every((a) => typeof a === 'string')
  ) {
    return { cmd: valor.cmd.trim(), args: [...valor.args] };
  }
  return null;
}

/**
 * Roda o comando de teste com timeout PRÓPRIO em GRUPO (spawn detached +
 * kill -pid): o runner de teste spawna árvore, e matar só o `sh` deixa neto
 * órfão — mesmo defeito do P1-4 da Fase 3, no mesmo lugar de produção.
 */
export async function runPreRodada({ root = process.cwd(), env = process.env, config }) {
  if (String(env.LMS_TEST_GATE ?? '1') === '0') {
    return { status: 'pulado', saida: 'lms-pre-rodada: desligado por LMS_TEST_GATE=0' };
  }
  const comando = comandoDeTeste(config) ?? comandoDeTeste(carregarConfigSeguro(root));
  if (!comando) {
    return { status: 'pulado', saida: 'lms-pre-rodada: sem testCommand em lms.config.json — degrau pulado' };
  }

  const timeoutMs = Number(env.LMS_TEST_TIMEOUT_MS) > 0
    ? Number(env.LMS_TEST_TIMEOUT_MS)
    : 10 * 60 * 1000;

  return new Promise((resolve) => {
    let timedOut = false;
    let saidaBruta = '';
    const child = spawnEmGrupo(comando.cmd, comando.args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const acumular = (chunk) => { saidaBruta += chunk; };
    child.stdout.on('data', acumular);
    child.stderr.on('data', acumular);
    const timer = setTimeout(() => {
      timedOut = true;
      matarGrupo(child, 'SIGTERM');
      setTimeout(() => matarGrupo(child, 'SIGKILL'), 250).unref();
    }, timeoutMs);
    child.on('error', (erro) => {
      clearTimeout(timer);
      resolve({
        status: 'erro',
        saida: `lms-pre-rodada: falha de ferramenta (${erro.code ?? erro.message}) — avisa e segue`,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          status: 'erro',
          saida: 'lms-pre-rodada: timeout — falha de ferramenta, avisa e segue',
        });
        return;
      }
      if (code === 0) {
        resolve({ status: 'verde', saida: 'lms-pre-rodada: suíte verde' });
        return;
      }
      // Vermelho = rodada recusada. Falha do TESTE é veredito, não ferramenta.
      // O header carrega exit + comando: o stderr do exit 11 tem de ser acionável
      // mesmo quando a suíte morre sem imprimir nada.
      resolve({
        status: 'vermelho',
        saida: `suíte vermelha (exit ${code}) — comando: ${comando.cmd} ${comando.args.join(' ')}` +
          (saidaBruta.trim() ? `\n${cauda(saidaBruta)}` : ''),
      });
    });
  });
}

import { loadConfig } from './lms-config.mjs';

function carregarConfigSeguro(root) {
  try {
    return loadConfig(root);
  } catch {
    return {};
  }
}

async function main() {
  const i = process.argv.indexOf('--root');
  const root = i >= 0 ? process.argv[i + 1] : process.cwd();
  const { status, saida } = await runPreRodada({ root, env: process.env });
  if (status !== 'verde') console.error(`lms-pre-rodada: ${status}${saida ? `\n${saida}` : ''}`);
  process.exitCode = status === 'vermelho' ? 11 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
