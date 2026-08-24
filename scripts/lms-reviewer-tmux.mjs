#!/usr/bin/env node
/**
 * Cadeia de revisores do LMS dirigindo a TUI de cada provider em tmux, no lugar da
 * invocação headless.
 *
 * Por que TUI e não headless: metade dos defeitos da cadeia headless era atrito de
 * invocação, não de revisão — `codex exec review` ignorando o prompt vindo por stdin,
 * JSONL de eventos precisando de extrator próprio, prompt citando `Read/Grep/Glob`
 * (nomes de ferramenta do Claude) e desarmando o Codex, que lê arquivo executando
 * shell. Na TUI cada agente usa as ferramentas nativas dele e nada disso existe.
 *
 * O que NÃO muda: prompt, prova de leitura (`lms-inspection.mjs`), validação de forma,
 * veredito e gravação do scorecard continuam vindo de `lms-reviewer-fallback.mjs`.
 * Aqui só troca COMO o candidato JSON é obtido — em vez de ler o stdout do processo,
 * o revisor grava um arquivo e este runner espera por ele.
 *
 * Contrato com o revisor: escrever `.lms/candidates/<provider>.json` e parar.
 */
import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { reportarDesfecho, runFallback } from './lms-reviewer-fallback.mjs';

const execFile = promisify(execFileCb);

/**
 * Uma sessão tmux POR ÁRVORE DE TRABALHO.
 *
 * Com nome fixo, dois worktrees revisando ao mesmo tempo — que é o caso normal num swarm —
 * caem na mesma sessão e disputam as janelas `lms-<provider>`. O segundo mata a janela do
 * primeiro, e o resultado chega como `contraditorio: invalid-output`: mensagem que culpa o
 * refutador por uma colisão de infraestrutura. Aconteceu em quatro publicações seguidas, e
 * numa delas quase descartou um achado P1 real de autorização.
 *
 * O sufixo vem do caminho da raiz, não do nome do diretório: dois worktrees podem se chamar
 * `kdt91` em pastas diferentes, e o que precisa ser único é a árvore.
 */
export function sessionNameFor(root) {
  if (process.env.LMS_TMUX_SESSION) return process.env.LMS_TMUX_SESSION;
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 8);
  return `lms-review-${digest}`;
}

const SESSION = sessionNameFor(process.cwd());
const POLL_MS = Number(process.env.LMS_TMUX_POLL_MS ?? 4000);
/** Teto por revisor. O grok levou 76s e o codex 153s nas medições do handoff. */
const TIMEOUT_MS = Number(process.env.LMS_TMUX_TIMEOUT_MS ?? 15 * 60 * 1000);
/** A TUI precisa terminar de subir antes de receber texto; abaixo disto o send-keys se perde. */
const BOOT_MS = Number(process.env.LMS_TMUX_BOOT_MS ?? 10_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tmux(args, { check = true } = {}) {
  try {
    const { stdout } = await execFile('tmux', args);
    return stdout;
  } catch (error) {
    if (check) throw error;
    return '';
  }
}

/**
 * Comando da TUI por provider. Todos rodam com aprovação automática porque a janela é
 * não-assistida, e todos são revisores: leem, julgam e gravam UM arquivo.
 *
 * Publicar é o que um revisor nunca pode fazer, e cada CLI trava isso de um jeito
 * diferente — não existe flag comum. A primeira versão deste arquivo só travava o grok
 * e afirmava no comentário que cobria todos; a própria cadeia pegou a mentira na
 * revisão inicial. Agora, um por um:
 */
function tuiCommand(provider, model) {
  if (provider === 'claude') {
    // Anthropic recusa headless com skip-permissions; na TUI é o caminho suportado.
    // --disallowedTools é a trava equivalente ao --deny do grok.
    return [
      'claude', '--dangerously-skip-permissions', '--model', model,
      '--disallowedTools', 'Bash(git push:*)', '--disallowedTools', 'Bash(gh pr:*)',
    ];
  }
  if (provider === 'codex') {
    // Sem deny por ferramenta no codex: a trava é o sandbox. `workspace-write` deixa
    // gravar o candidato (read-only não deixaria) e corta a rede, então `git push` e
    // `gh pr` não têm como sair. Bypass total daria shell irrestrito numa janela
    // não-assistida.
    return [
      'codex', '--sandbox', 'workspace-write', '--ask-for-approval', 'never',
      '--model', model, '-c', 'model_reasoning_effort=high',
    ];
  }
  return [
    // medium de propósito: empiricamente o grok-4.6 revisa melhor em medium (Master, 2026-08-15).
    'grok', '--model', model, '--reasoning-effort', 'medium', '--always-approve',
    '--deny', 'Bash(git push:*)', '--deny', 'Bash(gh pr:*)',
  ];
}

async function killWindow(provider) {
  await tmux(['kill-window', '-t', `${SESSION}:lms-${provider}`], { check: false });
}

/**
 * Dispara a TUI do provider e espera o arquivo do candidato aparecer.
 *
 * O prompt vai por ARQUIVO, nunca digitado: prosa longa colada numa TUI submete cedo na
 * primeira quebra de linha. O send-keys só aponta onde ler.
 */
async function collectTmux({ root, provider, config, prompt }) {
  const promptPath = join(root, '.lms', 'review-prompt.md');
  const outPath = join(root, '.lms', 'candidates', `${provider}.json`);
  const relOut = `.lms/candidates/${provider}.json`;

  await mkdir(dirname(outPath), { recursive: true });
  await rm(outPath, { force: true });
  await writeFile(promptPath, prompt, 'utf8');

  const model = config.models[provider];
  const window = `lms-${provider}`;

  const sessions = await tmux(['list-sessions', '-F', '#S'], { check: false });
  if (!sessions.split('\n').includes(SESSION)) {
    await tmux(['new-session', '-d', '-s', SESSION, '-n', 'runner']);
  }
  await killWindow(provider);
  await tmux(['new-window', '-t', SESSION, '-n', window, '-c', root, ...tuiCommand(provider, model)]);

  await sleep(BOOT_MS);
  // A instrucao NAO diz "scorecard": a mesma coleta serve ao contraditorio, cujo JSON
  // tem outra forma. Pedir scorecard ali faria o agente gravar um, o veredito viria
  // sem `refuted`, e o contraditorio falharia ABERTO — decorativo justamente no
  // caminho principal.
  await tmux([
    'send-keys', '-t', `${SESSION}:${window}`, '-l',
    `Leia .lms/review-prompt.md e execute exatamente o que ele pede. `
    + `Grave o JSON que ele especifica em ${relOut} e pare. Nao altere nenhum outro arquivo.`,
  ]);
  await sleep(1000);
  await tmux(['send-keys', '-t', `${SESSION}:${window}`, 'Enter']);

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (!existsSync(outPath)) continue;
    // Arquivo recém-criado pode estar pela metade: JSON inválido aqui não é veredito,
    // é escrita em andamento — segue esperando até o teto.
    try {
      const candidate = JSON.parse(await readFile(outPath, 'utf8'));
      await killWindow(provider);
      return { kind: 'ok', candidate };
    } catch {
      continue;
    }
  }

  // Deixa o painel VIVO no timeout: é a única pista de onde o revisor empacou, e
  // `tmux attach -t lms-review` mostra a tela real. Matar aqui apagaria a evidência.
  return { kind: 'timeout' };
}

async function main() {
  const result = await runFallback({
    root: process.cwd(),
    env: process.env,
    collect: collectTmux,
    outputPathFor: (provider) => `.lms/candidates/${provider}.json`,
  });
  process.exitCode = reportarDesfecho(result, 'lms-reviewer-tmux');
  if (process.exitCode === 1 && !result.rejectedBy && !result.uncontested) {
    console.error(`  Paineis vivos ficam em: tmux attach -t ${SESSION}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

export { collectTmux };
