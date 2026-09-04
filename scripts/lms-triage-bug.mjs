#!/usr/bin/env node
/**
 * Triagem de bug (Fase 5): o sinal de runtime vira um achado do contrato.
 *
 * O LMS julga diff; o que chega de runtime (log de exceção, 500, rejeição da
 * SEFAZ, texto de issue) não tinha entrada — virava prosa no chat. Aqui o sinal é
 * normalizado, os caminhos citados são conferidos NO DISCO, o agente de domínio
 * do consumidor orienta ONDE olhar, e o achado resultante passa SEMPRE pelo
 * verificador adversarial da Fase 2 (Task 4). Nenhum veredito novo: não pontua,
 * não escreve .lms/last.json, não desbloqueia push.
 *
 * CLI: `lms-triage-bug sinal.log` ou `kubectl logs … | lms-triage-bug`.
 */
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { citationShapeError, citationsDiskError } from './lms-inspection.mjs';
import { findingsShapeError, findingId } from './lms-scorecard.mjs';
import { verificarAchados, providerConfig, collectHeadless } from './lms-reviewer-fallback.mjs';
import { loadConfig } from './lms-config.mjs';
import { corrigivelPeloRevisor } from './lms-fix-routing.mjs';
import {
  agenteCommitado,
  carregarAgentes,
  escolherAgente,
} from './lms-bug-agents.mjs';
import { deveBootstrapar, runBootstrap } from './lms-bug-bootstrap.mjs';
import { abrirIssue } from './lms-tracker.mjs';
import { lerPrecedentes, registrarPrecedente } from './lms-precedentes.mjs';

/**
 * Corpus de precedentes DAQUELE agente (spec §3.5). Nunca o `.lms/precedentes.md`
 * global: memoria de falso-positivo de diff e de dominio nao se misturam.
 */
function precedentesDoAgente(nome) {
  const limpo = String(nome ?? 'sem-agente').toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'sem-agente';
  return `.lms/precedentes-bug/${limpo}.md`;
}

/**
 * Tags de padrões ESTRUTURAIS agnósticos (código HTTP, nome de exceção,
 * Traceback, panic:) — nunca vocabulário de domínio (spec §3.1).
 */
const PADROES_DE_TAG = [
  [/\b(http[- ]?)(5\d\d|4\d\d)\b/gi, (m) => `http-${m[2]}`],
  [/\bTraceback\b/gi, () => 'traceback'],
  [/\bpanic:/gi, () => 'panic'],
  [/\b(Error|Exception)\s*:\s*([A-Za-z][\w-]{2,30})/g, (m) => m[2].toLowerCase()],
];

/** Normaliza o sinal: texto, origem e tags de padrões agnósticos. */
export function normalizarSinal(texto, origem = 'stdin') {
  const bruto = String(texto ?? '');
  const tags = new Set();
  for (const [padrao, extrair] of PADROES_DE_TAG) {
    padrao.lastIndex = 0;
    let match;
    while ((match = padrao.exec(bruto)) !== null) {
      tags.add(extrair(match).toLowerCase());
    }
  }
  return {
    texto: bruto,
    origem,
    tags: [...tags],
  };
}

/** Caminhos citados por regex de stack trace, filtrados pelo que existe no disco. */
export async function caminhosDoSinal(texto, root = process.cwd()) {
  const bruto = String(texto ?? '');
  const encontrados = new Set();
  const padrao = /(?:at |File ")?([A-Za-z0-9_./-]+\.(?:py|ts|tsx|js|mjs|go|rb|java|cs)):(\d+)/g;
  let m;
  while ((m = padrao.exec(bruto)) !== null) {
    const caminho = m[1].replace(/^\.\//, '');
    const linha = Number(m[2]);
    const absoluto = resolve(root, caminho);
    try {
      await access(absoluto);
      if (!encontrados.has(caminho)) encontrados.add(caminho);
      void linha;
    } catch {
      // caminho citado que não existe no disco não entra (mesmo princípio de
      // citationsDiskError): path inventado morre aqui.
    }
  }
  return [...encontrados];
}

/** Prompt da triagem: contexto do agente + precedentes daquele agente + sinal. */
export function triagemPrompt(sinal, agente, precedentes = []) {
  return [
    'Tri a runtime signal below into ONE finding of the LMS scorecard contract.',
    'The agent context tells you WHERE to look and what to verify — follow it.',
    '',
    '--- SINAL ---',
    String(sinal?.texto ?? ''),
    `tags: ${(sinal?.tags ?? []).join(', ')}`,
    `caminhos citados (já conferidos no disco): ${(sinal?.caminhos_citados ?? []).join(', ') || '(nenhum)'}`,
    '--- END ---',
    '',
    contextoTexto(agente),
    precedentes.length
      ? [
          '--- PRECEDENTES deste agente: triagens já derrubadas ---',
          'Nao repita estas classes. Se achar que o caso e excecao, diga POR QUE.',
          ...precedentes,
          '--- END ---',
        ].join('\n')
      : '',
    '',
    'Rules:',
    '- Cite a path WITH a line number that exists on disk. A path you invent fails',
    '  the disk check and the triage is discarded.',
    '- severity is P0/P1/P2; confidence is 0-100. Runtime signal default: P1/70 —',
    '  the independent verifier will try to demolish your finding either way.',
    '- Do NOT score, do NOT write a scorecard, do NOT fix anything.',
    '',
    'Output EXACTLY ONE JSON object, no prose, no markdown fences:',
    '{',
    '  "path": "services/x.py:120",',
    '  "lens": "code-safety",',
    '  "title": "short title",',
    '  "why": "why this is a defect, anchored in the signal",',
    '  "fix": "what to change",',
    '  "precondition": "when it happens (optional)",',
    '  "acceptance": ["how to verify the fix"]',
    '}',
  ].filter(Boolean).join('\n');
}

function contextoTexto(agente) {
  if (!agente) return '';
  return [
    agente.corpo ?? '',
    (agente.fontes_de_verdade ?? []).length
      ? `Fontes de verdade:\n${agente.fontes_de_verdade.map((f) => `- ${f}`).join('\n')}`
      : '',
    (agente.verificar_antes_de_abrir_issue ?? []).length
      ? `SEMPRE confira antes de abrir issue:\n${agente.verificar_antes_de_abrir_issue.map((i) => `- ${i}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n');
}


/** Extrator do relato de triagem: um JSON com forma de achado (path + why). */
export function parseTriagem(stdout = '', stderr = '') {
  const texto = `${stdout}\n${stderr}`;
  const candidatos = [];
  const padrao = /\{[^{}]*\}/g;
  let m;
  while ((m = padrao.exec(texto)) !== null) {
    try {
      const objeto = JSON.parse(m[0]);
      if (objeto && typeof objeto === 'object' && !Array.isArray(objeto) &&
          typeof objeto.path === 'string' && typeof objeto.why === 'string') {
        candidatos.push(objeto);
      }
    } catch {}
  }
  return candidatos.at(-1) ?? null;
}

/**
 * O relato vira achado do contrato: `findingId`, origem runtime assinada, e o
 * `path` CONFERIDO no disco com linha (recusa antes de sair). Achado sem caminho
 * existente citado e sem agente que case nem chega aqui (exit 2 no runner).
 */
export function achadoDoSinal(parsed, sinal, agente, provider) {
  if (!parsed || typeof parsed !== 'object') {
    throw new TypeError('triagem sem relato de achado');
  }
  const caminhoLimpo = String(parsed.path ?? '').trim();
  const partes = caminhoLimpo.split(':');
  const pathSemLinha = partes[0].trim();
  const linha = Number(partes[1]);
  if (!Number.isInteger(linha) || linha < 1) {
    throw new Error(`achado precisa de path com linha 1-based (recebido: "${caminhoLimpo}")`);
  }
  const citação = { path: pathSemLinha, line: linha, quote: parsed.quote ?? sinal.texto.split('\n')[0] ?? 'sem citação' };
  const erroDeForma = citationShapeError([citação], 'triagem');
  if (erroDeForma) throw new Error(`triagem recusada: ${erroDeForma}`);

  const achado = {
    lens: typeof parsed.lens === 'string' && parsed.lens.trim() ? parsed.lens.trim() : 'code-safety',
    severity: 'P1',
    confidence: 70,
    path: caminhoLimpo,
    title: String(parsed.title ?? '').trim(),
    why: String(parsed.why ?? '').trim(),
    ...(parsed.fix ? { fix: String(parsed.fix).trim() } : {}),
    ...(parsed.precondition ? { precondition: String(parsed.precondition) } : {}),
    ...(Array.isArray(parsed.acceptance) ? { acceptance: parsed.acceptance.map(String) } : []),
    origem: {
      tipo: 'runtime',
      sinal: `sha256:${createHash('sha256').update(String(sinal.texto ?? '')).digest('hex')}`,
      agente: agente?.nome ?? '(sem agente)',
    },
    found_by: provider ?? '',
  };

  // O id é derivado (Fase 1), nunca vindo do modelo.
  achado.id = findingId(achado);
  const erro = findingsShapeError({ findings: [achado] });
  if (erro) throw new Error(`achado da triagem inválido: ${erro}`);
  return achado;
}

/**
 * Sinal por pipe (`kubectl logs … | lms-triage-bug`). Terminal interativo não é
 * sinal: devolve vazio em vez de travar esperando um EOF que ninguém vai dar —
 * o runner então recusa com exit 2 nomeando "sinal vazio".
 */
async function lerStdin() {
  if (process.stdin.isTTY) return '';
  let texto = '';
  process.stdin.setEncoding('utf8');
  for await (const pedaco of process.stdin) texto += pedaco;
  return texto;
}

// Task 4 da Fase 5: wiring — o achado da triagem passa SEMPRE pelo verificador da
// Fase 2. LMS_VERIFY=0 recusa a triagem inteira (exit 1): abrir issue sem
// contraditório é o buraco. Nenhum veredito novo: CONFIRMED = verificado,
// PLAUSIBLE = backlog (nunca some), FALSE_POSITIVE provado = recusado.
export async function runTriageBug({
  root = process.cwd(),
  env = process.env,
  collect = collectHeadless,
  argv = [],
  pergunta,
  stdin = lerStdin,
  exec,
} = {}) {
  // Task 5: --init é bootstrap, não triagem — sai antes de tudo, inclusive do
  // gate de LMS_VERIFY: gerar arquivo de agente não abre issue nenhuma.
  if (argv.includes('--init')) {
    const config = loadConfig(root);
    const bootstrap = await runBootstrap({
      root,
      dir: config.bugAgents.dir,
      guided: argv.includes('--guided') || config.bugAgents.guided,
      yes: argv.includes('--yes'),
      pergunta,
    });
    return { exitCode: 0, bootstrap, abertos: [], fechados: [] };
  }

  if (String(env.LMS_VERIFY ?? '1') === '0') {
    const motivo = 'LMS_VERIFY=0 — abrir issue sem contraditório é o buraco';
    console.error(`lms-triage-bug: recusada — ${motivo}`);
    return { exitCode: 1, motivo, abertos: [], fechados: [] };
  }

  // Sinal: arquivo (primeiro argumento que não é flag) ou stdin. Nada mais —
  // sem coleta, sem watcher (spec §6). A origem muda; o achado, não.
  const caminhoSinal = argv.find((arg) => !arg.startsWith('--'));
  let texto = '';
  let origem = 'stdin';
  if (caminhoSinal) {
    origem = `arquivo:${resolve(root, caminhoSinal)}`;
    texto = await readFile(resolve(root, caminhoSinal), 'utf8');
  } else {
    texto = await stdin();
  }

  const config = loadConfig(root);
  const sinalBase = normalizarSinal(texto, origem);
  sinalBase.caminhos_citados = await caminhosDoSinal(texto, root);

  const agentes = await carregarAgentes(root, config.bugAgents.dir);
  const agente = escolherAgente(agentes, sinalBase);
  if (agente) {
    const guarda = await agenteCommitado(root, agente.arquivo);
    if (!guarda.commitado) {
      const motivo = `agente '${agente.nome}' não está commitado (${guarda.estado})`;
      console.error(`lms-triage-bug: recusada — ${motivo}`);
      return { exitCode: 1, motivo, abertos: [], fechados: [] };
    }
  }

  if (!sinalBase.texto.trim() || (sinalBase.caminhos_citados.length === 0 && !agente)) {
    const motivo = [
      sinalBase.texto.trim() ? null : 'sinal vazio',
      sinalBase.caminhos_citados.length === 0 ? 'nenhum caminho existente citado no sinal' : null,
      agente ? null : 'nenhum agente casa com o sinal (rode lms-triage-bug --init)',
    ].filter(Boolean).join('; ');
    console.error(`lms-triage-bug: recusada — ${motivo}`);

    // Auto-init (spec §3.3): só com sinal que tem texto, nenhum agente casando E o
    // diretório vazio/ausente. Diretório com agente que não casou NÃO dispara — a
    // resposta certa ali é "nenhum agente cobre este sinal", não gerar arquivos.
    if (sinalBase.texto.trim() && !agente && await deveBootstrapar(root, config.bugAgents.dir)) {
      const bootstrap = await runBootstrap({
        root,
        dir: config.bugAgents.dir,
        guided: config.bugAgents.guided,
        pergunta,
      });
      return { exitCode: 2, motivo, bootstrap, abertos: [], fechados: [] };
    }
    return { exitCode: 2, motivo, abertos: [], fechados: [] };
  }

  const chainConfig = providerConfig(env);
  const provider = chainConfig.order[0];
  // Task 7: a proxima triagem que casar este agente le o que ja foi derrubado nele.
  const relativoPrecedentes = agente ? precedentesDoAgente(agente.nome) : null;
  const precedentes = relativoPrecedentes
    ? await lerPrecedentes(root, { relativo: relativoPrecedentes })
    : [];
  const prompt = triagemPrompt(sinalBase, agente, precedentes);
  const saida = await collect({
    root, provider, config: chainConfig, base: 'HEAD', env,
    prompt, parse: parseTriagem,
  }).catch(() => ({ kind: 'error' }));
  const relato = saida.kind === 'ok' ? saida.candidate : null;
  if (!relato) {
    const motivo = 'triagem sem relato parseável (fail-closed)';
    console.error(`lms-triage-bug: recusada — ${motivo}`);
    return { exitCode: 1, motivo, abertos: [], fechados: [] };
  }

  const achado = achadoDoSinal(relato, sinalBase, agente, provider);

  // Verificador adversarial da Fase 2: ordena, respeita MAX_VERIFICACOES e chama
  // aplicarVeredito. CONFIRMED = verificado; PLAUSIBLE = backlog (nunca some).
  const mini = { reviewer: provider, base: 'HEAD', findings: [achado] };
  const verificado = await verificarAchados({
    root,
    config: chainConfig,
    env,
    collect,
    ordem: chainConfig.order,
    autor: '',
    provider,
    base: 'HEAD',
    changed: sinalBase.caminhos_citados.join(', '),
    scorecard: mini,
    outputPathFor: (p) => join(root, '.lms', `bug-verificacao-${p}.json`),
    attempts: [],
  });
  const final = verificado.findings[0];
  const outcome = final.verdict === 'CONFIRMED'
    ? 'verificado'
    : final.verdict === 'PLAUSIBLE' ? 'backlog' : 'recusado';

  // Task 7: triagem errada (PLAUSIBLE em backlog, ou FALSE_POSITIVE provado) vira
  // memoria daquele agente — e o que impede o mesmo match errado na proxima vez.
  if (relativoPrecedentes && outcome !== 'verificado') {
    await registrarPrecedente(root, {
      classe: final.title,
      motivo: `${outcome} pelo verificador: ${final.verdict_why ?? final.why ?? 'sem prova'}`,
      origem: `triagem/${agente.nome}`,
    }, { relativo: relativoPrecedentes });
  }

  // Rota: escalar_para do agente vence quando declarado (Task 6 aprofunda o
  // rastreador); senão a regra da Fase 3 decide como sempre.
  const rota = agente?.escalar_para
    ?? (corrigivelPeloRevisor(final).ok ? 'revisor' : 'orquestrador');

  // Task 6: o rastreador é um extra. `none` (default) não chama binário nenhum, e
  // qualquer falha aqui avisa e segue — o achado fica em .lms/ de todo jeito.
  const issue = await abrirIssue(config.bugAgents.tracker, final, { env, exec, agente });

  const registro = {
    at: new Date().toISOString(),
    outcome,
    rota,
    agente: agente?.nome ?? null,
    verificador: true,
    issue,
    achado: final,
  };
  await mkdir(join(root, '.lms'), { recursive: true });
  await writeFile(
    join(root, '.lms', `bug-${final.id}.json`),
    `${JSON.stringify(registro, null, 2)}\n`,
    'utf8',
  );
  return { ...registro, exitCode: 0 };
}

/**
 * Prompt do bootstrap. Sem TTY não há pergunta: `runBootstrap` cai no default
 * (`n`) e nada é escrito — só `--yes` grava em não-interativo, nunca por omissão.
 */
async function perguntarNoTerminal(texto, padrao = '') {
  if (!process.stdin.isTTY) return padrao;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(`${texto}${padrao ? ` [${padrao}]` : ''} `);
  } finally {
    rl.close();
  }
}

async function main() {
  const resultado = await runTriageBug({
    root: process.cwd(),
    env: process.env,
    argv: process.argv.slice(2),
    pergunta: perguntarNoTerminal,
  });
  console.log(JSON.stringify(resultado, null, 2));
  process.exitCode = resultado.exitCode ?? 0;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
