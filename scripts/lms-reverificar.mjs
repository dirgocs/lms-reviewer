/**
 * Re-verificação incremental do fix (Fase 4).
 *
 * Depois de um fix, acordar a cadeia inteira para reconferir achados que o próprio
 * revisor abriu custa 15-30 min; re-verificar custa 2-5. A pergunta é estreita:
 * ESTES IDS continuam abertos?
 *
 * Fail-closed em todo caminho (mesma doutrina do P3-2 da Fase 3): id ausente ou
 * desconhecido na resposta = `open`; `closed` só vale depois de o verificador
 * independente da Fase 2 não o derrubar; e este estágio NUNCA mexe em
 * `score`/agregado/`coverage` nem emite scorecard 5/5 — aceite final sai só de
 * `runFallback` completo.
 */

/**
 * Prompt da re-verificação. Entra os achados em aberto (com o `acceptance` que
 * define fechamento) e o diff do fix; sai um objeto com `results`.
 */
export function reverificarPrompt(findings, diff) {
  const lista = findings
    .map((f) =>
      [
        `id: ${f.id}`,
        `severity: ${f.severity}`,
        `path: ${f.path}`,
        `title: ${f.title}`,
        ...(Array.isArray(f.acceptance) && f.acceptance.length
          ? ['acceptance criteria:', ...f.acceptance.map((c) => `  - ${c}`)]
          : []),
      ].join('\n'),
    )
    .join('\n---\n');
  return [
    'You reviewed this branch earlier and opened the findings below. The fixes have',
    'since been applied. Your ONLY question now: for each id, is the finding CLOSED',
    '(the acceptance criteria hold) or still OPEN?',
    '',
    '--- FINDINGS ---',
    lista,
    '--- END FINDINGS ---',
    '',
    '--- DIFF OF THE FIX ---',
    diff || '(no diff information available)',
    '--- END DIFF ---',
    '',
    'Do NOT re-review the whole diff, do NOT look for NEW findings, do NOT score.',
    'Only decide, per id, whether the acceptance criteria now hold.',
    '',
    'Output EXACTLY ONE JSON object, no prose, no markdown fences:',
    '{',
    '  "results": [',
    '    { "id": "<id>", "status": "closed", "why": "one sentence", "evidence": "file/line or command" },',
    '    { "id": "<id>", "status": "open", "why": "what still fails" }',
    '  ]',
    '}',
    'Every id listed above MUST appear exactly once. Unknown ids and new findings are',
    'ignored and treated as OPEN (fail-closed).',
  ].join('\n');
}

/** Extrator do relato de re-verificação: só objeto com `results` vale. */
export function parseReverificacao(stdout = '', stderr = '') {
  const aceita = (value) => 'results' in value;
  const candidatos = [
    ...candidatesFrom(stdout, new Set(), aceita),
    ...candidatesFrom(stderr, new Set(), aceita),
  ];
  return candidatos.at(-1) ?? null;
}

import { candidatesFrom } from './lms-reviewer-fallback.mjs';

/**
 * Aplica o relato ao scorecard. PURA e fail-closed:
 * - id sem resposta, ou id da resposta que não existe no scorecard, ou status
 *   diferente de 'closed' → `open`;
 * - `closed` que o verificador independente derrubou (CONFIRMED) volta a `open`;
 * - NUNCA altera `score`, `p0/p1/p2`, `coverage` nem acrescenta/remover achados —
 *   só anota `reverificado`/`reverificado_por` em cada achado.
 */
export function aplicarReverificacao(scorecard, results, verificados = []) {
  const resposta = new Map(
    (Array.isArray(results) ? results : [])
      .filter((r) => r && typeof r === 'object')
      .map((r) => [r.id, r]),
  );
  const derrubados = new Set(
    (Array.isArray(verificados) ? verificados : [])
      .filter((v) => v && v.verdict === 'CONFIRMED')
      .map((v) => v.id),
  );
  const findings = (scorecard.findings ?? []).map((finding) => {
    const respostaDoId = resposta.get(finding.id);
    const fechou =
      respostaDoId?.status === 'closed' && !derrubados.has(finding.id);
    return {
      ...finding,
      reverificado: fechou ? 'closed' : 'open',
      ...(respostaDoId
        ? {
            reverificado_por: respostaDoId.why ?? '',
            reverificado_evidencia: respostaDoId.evidence ?? '',
          }
        : {}),
    };
  });
  return { ...scorecard, findings };
}

// Task 4 da Fase 4: wiring com o verificador da Fase 2 — fechamento so vale
// quando o verificador independente nao derruba, e NUNCA publica scorecard.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  candidatesFrom as _candidatesFrom,
  collectHeadless,
  providerConfig,
  verificarAchados,
} from './lms-reviewer-fallback.mjs';
import { collectTmux } from './lms-reviewer-tmux.mjs';
import { naoRastreados } from './lms-fix-escopo.mjs';

/**
 * P2-5 da revisao da Fase 4: manterJanela era codigo morto — nenhum chamador
 * passava e o bin rodava sempre headless. A re-verificacao roda na TUI (modo
 * padrao de producao, com contexto preservado); headless so com a env explicita.
 */
export function coletaDaReverificacao(env = process.env) {
  return (env.LMS_REVIEWER_MODE ?? 'tmux') === 'headless' ? collectHeadless : collectTmux;
}

const execFile = promisify(execFileCallback);
void _candidatesFrom;

/**
 * O lote de fixes a re-verificar: linhas ainda nao consumidas, marcadas
 * fixed/claimed. Marco = da PRIMEIRA linha (cobre o lote inteiro); arquivos =
 * uniao. null = nada a re-verificar (ou linha sem marco/arquivos).
 */
export function loteDeFix(linhas, consumidas = 0) {
  const rows = (Array.isArray(linhas) ? linhas : []).slice(consumidas);
  const fixRows = rows.filter((l) => l.outcome === 'fixed' || l.outcome === 'claimed');
  if (fixRows.length === 0) return null;
  const marco = String(fixRows[0].marco ?? '').trim();
  const arquivos = [
    ...new Set(fixRows.flatMap((l) => l.arquivos ?? [])),
  ].filter((p) => typeof p === 'string' && p.trim());
  if (!marco || arquivos.length === 0) return null;
  return { marco, arquivos, total: rows.length };
}

/**
 * Roda a re-verificacao sobre o ultimo fix registrado.
 *
 * Entradas: `.lms/last.json` (achados CONFIRMED) + `.lms/fixes.jsonl` (ultima linha
 * fixed/claimed com `marco`). Falha fechada: sem marco, sem scorecard ou com
 * `LMS_VERIFY=0` → recusa (fechar sem contraditorio e o buraco).
 *
 * NUNCA grava `.lms/last.json`, NUNCA emite `accepted` — o aceite final sai so de
 * `runFallback` completo.
 */
/**
 * Alvos da re-verificacao a partir dos seletores da linha de comando.
 *
 * 1.4.1: nao existia seletor nenhum — a re-verificacao pegava todo CONFIRMED, e
 * `pnpm lms:reverificar <ids>` nao tinha como ser usado. Alem do `id`, aceita o
 * par `path:linha` (e o `path` sozinho), que e o seletor que o humano TEM na mao
 * quando le o achado no relatorio.
 *
 * Seletor que nao casa volta em `desconhecidos` em vez de sumir: pedir a
 * re-verificacao de um id errado e nao receber nada de volta e pior que o erro.
 */
export function selecionarAlvos(findings, seletores = []) {
  const confirmados = (Array.isArray(findings) ? findings : []).filter(
    (f) => (f.verdict ?? 'CONFIRMED') === 'CONFIRMED',
  );
  const limpos = seletores.map((s) => String(s ?? '').trim()).filter(Boolean);
  if (limpos.length === 0) return { alvos: confirmados, desconhecidos: [] };

  const casa = (finding, seletor) => {
    if (finding.id && finding.id === seletor) return true;
    const path = String(finding.path ?? '').trim();
    if (!path) return false;
    // `path:linha` exato, ou `path` sem linha cobrindo qualquer linha dele.
    return path === seletor || path.split(':')[0] === seletor;
  };

  const alvos = [];
  const desconhecidos = [];
  for (const seletor of limpos) {
    const casados = confirmados.filter((f) => casa(f, seletor));
    if (casados.length === 0) {
      desconhecidos.push(seletor);
      continue;
    }
    for (const finding of casados) if (!alvos.includes(finding)) alvos.push(finding);
  }
  return { alvos, desconhecidos };
}

export async function runReverificacao({
  seletores = [],
  root = process.cwd(),
  env = process.env,
  collect,
} = {}) {
  const coleta = collect ?? coletaDaReverificacao(env);
  if (String(env.LMS_VERIFY ?? '1') === '0') {
    const motivo = 'LMS_VERIFY=0 — fechar sem contraditorio e o buraco';
    console.error(`lms-reverificar: recusada — ${motivo}`);
    return { status: 'recusada', motivo, abertos: [], fechados: [] };
  }

  let scorecard;
  try {
    scorecard = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
  } catch (erro) {
    const motivo = `scorecard ausente ou invalido (${erro.message})`;
    console.error(`lms-reverificar: recusada — ${motivo}`);
    return { status: 'recusada', motivo, abertos: [], fechados: [] };
  }

  // P2-3 da revisao da Fase 4: runFix grava UMA linha por achado — o diff tem de
  // cobrir o LOTE inteiro (marco da PRIMEIRA linha do lote), senao os fixes
  // anteriores somem e a rodada cheia volta a ser obrigatoria. O lote comeca nas
  // linhas ainda nao consumidas por uma re-verificacao anterior.
  let linhas = [];
  let consumidas = 0;
  try {
    linhas = (await readFile(join(root, '.lms', 'fixes.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((linha) => JSON.parse(linha));
    consumidas = JSON.parse(await readFile(join(root, '.lms', 'reverificacao.json'), 'utf8')).linhasConsumidas ?? 0;
  } catch {}
  const lote = loteDeFix(linhas, consumidas);
  if (!lote) {
    const motivo = 'nenhum fix novo a re-verificar (ou linha sem marco/arquivos)';
    console.error(`lms-reverificar: recusada — ${motivo}`);
    return { status: 'recusada', motivo, abertos: [], fechados: [] };
  }

  const { alvos, desconhecidos } = selecionarAlvos(scorecard.findings, seletores);
  // Seletor que nao casou nao pode passar batido: quem pediu a re-verificacao de
  // um id errado receberia "nada a fazer" e concluiria que o achado fechou.
  if (desconhecidos.length > 0) {
    const motivo = `seletor sem achado CONFIRMED correspondente: ${desconhecidos.join(', ')}`;
    console.error(`lms-reverificar: recusada — ${motivo}`);
    return { status: 'recusada', motivo, abertos: [], fechados: [] };
  }
  if (alvos.length === 0) {
    return { status: 'ok', abertos: [], fechados: [], results: [] };
  }

  // P2-7 da revisao da Fase 4: agrupar por found_by — CADA revisor re-verifica os
  // proprios achados; um collect so entregaria achados de outros revisores a quem
  // nunca viu o raciocinio original.
  const grupos = new Map();
  for (const finding of alvos) {
    const quem = finding.found_by ?? scorecard.reviewer;
    if (!grupos.has(quem)) grupos.set(quem, []);
    grupos.get(quem).push(finding);
  }

  // Diff do lote, limitado aos arquivos das linhas do fix.
  let diffTexto = '';
  try {
    const { stdout } = await execFile(
      'git',
      ['diff', lote.marco, '--', ...lote.arquivos],
      { cwd: root, maxBuffer: 32 * 1024 * 1024 },
    );
    diffTexto = stdout;
  } catch {}
  // Untracked criados pelo fix nao aparecem no diff: conteudo entra como bloco.
  for (const caminho of (await naoRastreados(root)).filter((p) => lote.arquivos.includes(p))) {
    try {
      const conteudo = await readFile(join(root, caminho), 'utf8');
      diffTexto += `\n--- novo arquivo: ${caminho} ---\n${conteudo}\n`;
    } catch {}
  }

  const results = [];
  const verificados = [];
  for (const [provider, grupo] of grupos) {
    const prompt = reverificarPrompt(grupo, diffTexto);
    const saida = await coleta({
      root,
      provider,
      config: providerConfig(env),
      base: scorecard.base,
      env,
      prompt,
      parse: parseReverificacao,
      // P2-5: caminhos proprios + janela preservada — a re-verificacao roda na TUI
      // do mesmo revisor, com o contexto da rodada original.
      promptPath: join(root, '.lms', 'reverificar-prompt.md'),
      outPath: join(root, '.lms', 'reverificar.json'),
      manterJanela: true,
    }).catch(() => ({ kind: 'error' }));
    const relato = saida.kind === 'ok' ? saida.candidate : null;
    for (const item of (Array.isArray(relato?.results) ? relato.results : [])) {
      results.push(item);
    }

    // Achados declarados closed passam pelo verificador da Fase 2 (so rebaixa):
    // veredito CONFIRMED = o defeito segue vivo = volta a open.
    const fechadosPeloRelato = (Array.isArray(relato?.results) ? relato.results : [])
      .filter((r) => r.status === 'closed' && grupo.some((a) => a.id === r.id))
      .map((r) => r.id);
    if (fechadosPeloRelato.length === 0) continue;
    const mini = { ...scorecard, findings: grupo.filter((a) => fechadosPeloRelato.includes(a.id)) };
    const config = providerConfig(env);
    const verificado = await verificarAchados({
      root,
      config,
      env,
      collect: coleta,
      ordem: config.order,
      autor: '',
      provider,
      base: scorecard.base,
      changed: diffTexto,
      scorecard: mini,
      outputPathFor: (p) => join(root, '.lms', `reverificar-verificacao-${p}.json`),
      attempts: [],
      manterJanela: true,
    });
    verificados.push(...verificado.findings.map((f) => ({ id: f.id, verdict: f.verdict })));
  }

  const aplicado = aplicarReverificacao(scorecard, results, verificados);
  const fechados = aplicado.findings.filter((f) => f.reverificado === 'closed').map((f) => f.id);
  const abertos = aplicado.findings.filter((f) => f.reverificado === 'open').map((f) => f.id);

  await mkdir(join(root, '.lms'), { recursive: true });
  await writeFile(
    join(root, '.lms', 'reverificacao.json'),
    `${JSON.stringify({ at: new Date().toISOString(), reviewer: [...grupos.keys()].join('+'), results, abertos, fechados, linhasConsumidas: linhas.length }, null, 2)}\n`,
    'utf8',
  );
  return { status: 'ok', abertos, fechados, results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const resultado = await runReverificacao({
    root: process.cwd(),
    env: process.env,
    // Aceita id e o par path:linha — o seletor que o humano tem na mao.
    seletores: process.argv.slice(2).filter((arg) => !arg.startsWith('--')),
  });
  console.log(JSON.stringify(resultado, null, 2));
  process.exitCode = resultado.status === 'ok' ? 0 : 1;
}
