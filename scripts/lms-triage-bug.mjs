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
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { citationShapeError, citationsDiskError } from './lms-inspection.mjs';
import { findingsShapeError, findingId } from './lms-scorecard.mjs';

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
