#!/usr/bin/env node
/**
 * Piloto Pi em SOMBRA para o refutador (KDT-136 fase C).
 *
 * `collectPi` invoca o CLI `pi` headless (prompt mode) com o MESMO contrato de
 * payload do refutador atual — campos, `inspected` com quotes reais verificadas
 * contra o disco — e devolve o veredito parseado.
 *
 * SOMBRA significa: o veredito NÃO decide nada. Quem decide o push continua
 * sendo o refutador tmux; a sombra só enriquece o history.jsonl
 * (`estagio: "refutador-sombra"`) para comparar providers antes de migrar.
 *
 * Manha conhecida do pi: sem `< /dev/null` ele trava lendo stdin. Aqui o
 * stdin nasce `stdio: 'ignore'` — equivalente literal ao redirecionamento.
 */
import { spawn } from 'node:child_process';
import { parseRefutation } from './lms-reviewer-fallback.mjs';

export const PI_SYSTEM_PROMPT = [
  'Você é o contraditório de um gate de revisão de código. Ferramentas somente-leitura',
  '(read, grep, find) — você NUNCA edita arquivos nem altera estado de runtime.',
  'Leia os arquivos do diff antes de julgar. O JSON de refutação tem contrato exato:',
  '{ "refuted": boolean, "severity": "P0"|"P1"|"P2", "lens": string, "path": "arquivo:linha",',
  '  "title": string, "why": string, "confidence": number, "proof"?: object,',
  '  "extra_findings"?: array, "inspected": array }',
  '"inspected" é sua PROVA DE LEITURA e é verificada contra o disco: para cada arquivo',
  'distinto que você abriu, { "path", "line", "quote" } com a linha copiada VERBATIM',
  '(pelo menos ~12 caracteres). Quote inventada invalida todo o parecer.',
  'Imprima EXATAMENTE UM objeto JSON e nada mais — sem prosa, sem cerca markdown.',
].join('\n');

function piCommand({ prompt, env }) {
  return {
    command: env.LMS_PI_BIN ?? 'pi',
    args: [
      '--provider',
      'openai-codex',
      '--model',
      env.LMS_PI_MODEL ?? 'gpt-5.6-sol',
      '--thinking',
      'xhigh',
      '--tools',
      'read,grep,find',
      '--append-system-prompt',
      PI_SYSTEM_PROMPT,
      '--mode',
      'json',
      '--no-session',
      '-p',
      prompt,
    ],
  };
}

export async function collectPi({
  root,
  provider: _provider,
  config,
  base: _base,
  prompt,
  env = process.env,
  parse = parseRefutation,
}) {
  const { command, args } = piCommand({ prompt, env });
  const result = await new Promise((resolve) => {
    let timedOut = false;
    // stdin 'ignore' = < /dev/null: sem isso o pi real trava lendo stdin.
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (dado) => stdout.push(dado));
    child.stderr.on('data', (dado) => stderr.push(dado));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 250).unref();
    }, config.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ kind: error.code === 'ENOENT' ? 'missing-cli' : 'error', error });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (timedOut) resolve({ kind: 'timeout', out, err });
      else if (code !== 0) resolve({ kind: 'exit', code, out, err });
      else resolve({ kind: 'ok', out, err });
    });
  });
  if (result.kind !== 'ok') return { kind: result.kind };
  return { kind: 'ok', candidate: parse(result.out, result.err) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.error('lms-reviewer-pi: use collectPi() a partir do runner; nada a fazer standalone.');
  process.exitCode = 1;
}
