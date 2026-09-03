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
