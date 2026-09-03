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
import { collectPi } from './lms-reviewer-pi.mjs';

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
export function tuiCommand(provider, model) {
  if (provider === 'claude') {
    // Anthropic recusa headless com skip-permissions; na TUI é o caminho suportado.
    // --disallowedTools é a trava equivalente ao --deny do grok.
    return [
      'claude',
      '--dangerously-skip-permissions',
      '--model',
      model,
      '--disallowedTools',
      'Bash(git push:*)',
      '--disallowedTools',
      'Bash(gh pr:*)',
    ];
  }
  if (provider === 'pi') {
    // TUI do Pi: GLM via OpenRouter. Allowlist de tools sem bash/edit/write — a
    // janela é não-assistida e o refutador não publica.
    return [
      process.env.LMS_PI_BIN ?? 'pi',
      '--provider',
      process.env.LMS_PI_PROVIDER ?? 'openrouter',
      '--model',
      model,
      '--thinking',
      process.env.LMS_PI_THINKING ?? 'high',
      '--tools',
      'read,grep,find',
      '--exclude-tools',
      'bash,edit,write',
    ];
  }
  if (provider === 'codex') {
    // Sem deny por ferramenta no codex: a trava é o sandbox. `workspace-write` deixa
    // gravar o candidato (read-only não deixaria) e corta a rede, então `git push` e
    // `gh pr` não têm como sair. Bypass total daria shell irrestrito numa janela
    // não-assistida.
    return [
      'codex',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
      // Mesma env e mesmo padrão do runner headless (lms-reviewer-fallback.mjs):
      // xhigh por diretriz do Master (2026-08-27). Divergir aqui fez o refutador
      // rodar em high por uma rodada inteira sem ninguém pedir.
      '--model',
      model,
      '-c',
      `model_reasoning_effort=${process.env.LMS_CODEX_EFFORT ?? 'xhigh'}`,
    ];
  }
  // grok sem cota (Master, 2026-08-27, até 01/09): LMS_GROK_BIN aponta um TUI
  // substituto (pi + glm-5.3-flash) que carrega os próprios flags. Os flags
  // abaixo são do CLI do grok e não fazem sentido para outro binário, então o
  // override é tudo-ou-nada — e por isso o runner NÃO consegue verificar a
  // trava de publicação do substituto por inspeção (achado da rodada 85). A
  // responsabilidade fica explícita: LMS_GROK_BIN_TRAVADO=1 atesta que o
  // binário carrega a própria trava (ex.: allowlist de tools sem bash). Sem o
  // atestado, o override é RECUSADO e a janela sobe com o grok de sempre —
  // fail-closed, no mesmo padrão do LMS_REFUTADOR_MESMO_PROVIDER.
  if (process.env.LMS_GROK_BIN && process.env.LMS_GROK_BIN_TRAVADO === '1') {
    return [process.env.LMS_GROK_BIN];
  }
  if (process.env.LMS_GROK_BIN) {
    console.error(
      'lms-reviewer-tmux: LMS_GROK_BIN ignorado sem LMS_GROK_BIN_TRAVADO=1 '
      + '(atestado de que o TUI substituto carrega a própria trava de publicação)',
    );
  }
  return [
    // medium de propósito: empiricamente o grok-4.6 revisa melhor em medium (Master, 2026-08-15).
    'grok',
    '--model',
    model,
    '--reasoning-effort',
    'medium',
    '--always-approve',
    '--deny',
    'Bash(git push:*)',
    '--deny',
    'Bash(gh pr:*)',
  ];
}

async function killWindow(provider) {
  await tmux(['kill-window', '-t', `${SESSION}:lms-${provider}`], { check: false });
}

/** O texto do pane mostra um agente TRABALHANDO?
 *
 * Marcadores de execucao dos tres TUIs (claude: "esc to interrupt"; codex:
 * "Working"/"interrupt"; grok: "Waiting for response"). Presenca do TEXTO do prompt
 * nao basta: ele tambem aparece parado na caixa de input quando o Enter foi engolido.
 * Exportado puro para ser testavel sem tmux. */
export function promptEstaRodando(pane) {
  return /Working|interrupt|Waiting for response|Thinking|Esc to cancel/i.test(pane);
}

/** Envia o prompt e espera prova de que ele ENTROU; reenvia ate 3 vezes.
 *
 * Retentativa 1+ manda so Enter primeiro: se o texto ficou preso na caixa de input
 * (banner engoliu apenas o Enter), submeter o que ja esta la evita duplicar a
 * instrucao. So depois reenvia o texto completo. */
async function enviarPromptAteEntrar(window, relOut, relPrompt = '.lms/review-prompt.md') {
  const texto =
    `Leia ${relPrompt} e execute exatamente o que ele pede. ` +
    `Grave o JSON que ele especifica em ${relOut} e pare. Nao altere nenhum outro arquivo.`;
  for (let tentativa = 0; tentativa < 3; tentativa += 1) {
    if (tentativa === 0) {
      await tmux(['send-keys', '-t', `${SESSION}:${window}`, '-l', texto]);
      await sleep(1000);
    }
    await tmux(['send-keys', '-t', `${SESSION}:${window}`, 'Enter']);
    for (let i = 0; i < 10; i += 1) {
      await sleep(3000);
      const pane = await tmux(['capture-pane', '-p', '-t', `${SESSION}:${window}`], {
        check: false,
      });
      if (promptEstaRodando(pane)) return true;
    }
    // Nada rodando em 30s: reenvia o texto inteiro na proxima volta.
    if (tentativa > 0) {
      await tmux(['send-keys', '-t', `${SESSION}:${window}`, '-l', texto]);
      await sleep(1000);
    }
  }
  return false;
}

/**
 * Dispara a TUI do provider e espera o arquivo do candidato aparecer.
 *
 * O prompt vai por ARQUIVO, nunca digitado: prosa longa colada numa TUI submete cedo na
 * primeira quebra de linha. O send-keys só aponta onde ler.
 */
/**
 * Extrai o candidato do arquivo com o MESMO parser de quem chama (P3-2).
 *
 * Sem parse: JSON.parse, o comportamento anterior. Com parse: o extrator do
 * chamador (ex.: veredito do verificador por achado) decide o que vale — um
 * scorecard antigo no mesmo arquivo NAO e veredito, e o poll segue ate o teto.
 */
export function lerCandidato(texto, parse = null) {
  try {
    if (!parse) return JSON.parse(texto);
    return parse(texto, '') ?? null;
  } catch {
    // Escrita em andamento ou texto sem a forma esperada: nao e veredito —
    // o poll continua ate o teto (falha fechada).
    return null;
  }
}

/**
 * Relativo ao root, para o send-keys que aparece na TUI.
 */
function relativoAoRoot(caminho, root) {
  return caminho.startsWith(root + '/') ? caminho.slice(root.length + 1) : caminho;
}

/**
 * Caminhos do prompt e do candidato, por CHAMADOR (Fase 4 Task 2): a
 * re-verificacao roda na mesma janela e nao pode pisar o par da revisao
 * principal. Defaults = comportamento de hoje.
 */
export function caminhosDaColeta(root, provider, { promptPath, outPath } = {}) {
  return {
    promptPath: promptPath ?? join(root, '.lms', 'review-prompt.md'),
    outPath: outPath ?? join(root, '.lms', 'candidates', `${provider}.json`),
  };
}

async function collectTmux({
  root, provider, config, prompt, parse = null,
  promptPath: promptPathOverride,
  outPath: outPathOverride,
  manterJanela = false,
}) {
  const { promptPath, outPath } = caminhosDaColeta(root, provider, {
    promptPath: promptPathOverride,
    outPath: outPathOverride,
  });
  const relOut = relativoAoRoot(outPath, root);

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
  await tmux([
    'new-window',
    '-t',
    SESSION,
    '-n',
    window,
    '-c',
    root,
    ...tuiCommand(provider, model),
  ]);

  await sleep(BOOT_MS);
  // A instrucao NAO diz "scorecard": a mesma coleta serve ao contraditorio, cujo JSON
  // tem outra forma. Pedir scorecard ali faria o agente gravar um, o veredito viria
  // sem `refuted`, e o contraditorio falharia ABERTO — decorativo justamente no
  // caminho principal.
  //
  // E o envio e CONFIRMADO, nao cego: banner de quota e modal de update engolem o
  // send-keys em silencio, e ja custaram duas rodadas — o painel ficava parado ate o
  // teto de 40 min com o prompt perdido. O deadline do candidato so comeca a contar
  // DEPOIS de o prompt comprovadamente entrar; antes disso o tempo era consumido por
  // uma espera que nunca ia produzir nada.
  const entrou = await enviarPromptAteEntrar(window, relOut, relPrompt);
  if (!entrou) {
    console.error(`lms-reviewer-tmux: prompt nao entrou na TUI de ${provider} apos 3 tentativas`);
    return { kind: 'timeout' };
  }

  const deadline = Date.now() + TIMEOUT_MS;
  // Aceitar o PRIMEIRO JSON parseável era um bug caro: o revisor grava o candidato
  // em mais de um passo (um JSON válido sem `inspected`, depois o completo), o poll
  // pegava a primeira versão e a rodada morria como "payload-incompleto" — com o
  // arquivo COMPLETO no disco segundos depois. 25 ocorrências e ~118 min no
  // histórico; a rodada 62 quase perdeu um aceite 5/5 assim. O candidato só vale
  // quando duas leituras consecutivas devolvem os MESMOS bytes parseáveis.
  let leituraAnterior = null;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (!existsSync(outPath)) continue;
    // Arquivo recém-criado pode estar pela metade: JSON inválido aqui não é veredito,
    // é escrita em andamento — segue esperando até o teto.
    try {
      const texto = await readFile(outPath, 'utf8');
      // P3-2 da revisao da Fase 2: o candidato sai pelo parse de QUEM CHAMA — o
      // verificador por achado pede extrator de veredito, e o scorecard antigo do
      // provider no mesmo arquivo nao pode ser lido como veredito. Sem parse,
      // comportamento anterior (JSON.parse).
      const candidate = lerCandidato(texto, parse);
      if (!candidate) {
        // Parser nao achou o que procurava (escrita em andamento ou arquivo sem a
        // forma esperada): nao e veredito, segue esperando ate o teto.
        leituraAnterior = texto;
        continue;
      }
      if (texto !== leituraAnterior) {
        leituraAnterior = texto;
        continue;
      }
      // Fase 4 Task 2: manterJanela preserva a TUI com contexto — a re-verificacao
      // reusa a sessao em vez de acordar um processo virgem.
      if (!manterJanela) await killWindow(provider);
      return { kind: 'ok', candidate };
    } catch {
      leituraAnterior = null;
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
    collectShadow: collectPi,
    outputPathFor: (provider) => `.lms/candidates/${provider}.json`,
  });
  process.exitCode = reportarDesfecho(result, 'lms-reviewer-tmux');
  if (process.exitCode === 1 && !result.rejectedBy && !result.uncontested) {
    console.error(`  Paineis vivos ficam em: tmux attach -t ${SESSION}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

export { collectTmux };
