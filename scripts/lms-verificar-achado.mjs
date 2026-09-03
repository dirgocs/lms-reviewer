/**
 * Verificacao adversarial POR ACHADO.
 *
 * O contraditorio existente ataca o SCORECARD e caca falso-negativo: aceite frouxo.
 * Este estagio ataca CADA ACHADO e caca falso-positivo — que hoje so tem um filtro,
 * `confidence >= 80`, declarado pelo mesmo agente que achou. E o mesmo conflito de
 * interesse que ja foi removido do lado do aceite, intacto do lado do achado.
 *
 * O verificador so REBAIXA. Poder deletar um achado abriria caminho novo para
 * enfraquecer o gate — viraria "shopping por um verificador que descarta".
 */
export const MAX_VERIFICACOES = 5;

const VEREDITOS = new Set(['CONFIRMED', 'PLAUSIBLE', 'FALSE_POSITIVE']);

export function verificarPrompt(finding, base, changed = '') {
  return [
    `A reviewer flagged the finding below on the current branch against ${base}.`,
    'Your job is to try to DEMOLISH it, not to agree with it.',
    '',
    '--- FINDING ---',
    `severity: ${finding.severity}   confidence: ${finding.confidence}`,
    `path: ${finding.path}`,
    `title: ${finding.title}`,
    `why: ${finding.why}`,
    finding.precondition ? `precondition: ${finding.precondition}` : '',
    '--- END FINDING ---',
    '',
    changed ? `--- CHANGED FILES ---\n${changed}\n--- END ---\n` : '',
    'Open the cited file and decide. Do NOT review the rest of the diff — one finding,',
    'one verdict. Do NOT edit files, commit, push or change runtime state.',
    '',
    'Verdicts:',
    '  CONFIRMED      — you opened the file and the defect is really there.',
    '  PLAUSIBLE      — could be real, but you could not confirm it from the code.',
    '  FALSE_POSITIVE — it is NOT a defect, and you can prove it with a command.',
    '',
    'FALSE_POSITIVE without a proof that runs is treated as CONFIRMED. Do not claim it',
    'unless you can name a command from the project gates that demonstrates your point.',
    '',
    'Output EXACTLY ONE JSON object, no prose, no markdown fences:',
    '{',
    `  "id": "${finding.id}",`,
    '  "verdict": "CONFIRMED",',
    '  "why": "what you found when you opened the file",',
    '  "inspected": [{ "path": "src/a.ts", "line": 42, "quote": "the line, verbatim" }],',
    '  "proof": { "command": "pnpm --filter @karibu/api test", "expect": "pass" }',
    '}',
    '"proof" is optional and only meaningful for FALSE_POSITIVE.',
  ].filter(Boolean).join('\n');
}

/**
 * Aplica o veredito ao achado. Falha FECHADA em todo caminho duvidoso: veredito
 * ausente, malformado, de OUTRO achado (P1-2 da revisao da Fase 2 — o id tem de
 * casar, senao um output lido por varias verificacoes rebaixa o que ninguem
 * abriu), ou FALSE_POSITIVE sem prova que rode = o achado continua bloqueando.
 * Ausencia de segunda opiniao nao absolve.
 */
export function aplicarVeredito(finding, veredito, provaResultado) {
  const idConfere = !veredito || finding.id === undefined || veredito.id === finding.id;
  const bruto = veredito && VEREDITOS.has(veredito.verdict) && idConfere ? veredito.verdict : 'CONFIRMED';
  let verdict = bruto;
  if (bruto === 'FALSE_POSITIVE') {
    verdict = provaResultado === 'confirmada' ? 'PLAUSIBLE' : 'CONFIRMED';
  }
  return {
    ...finding,
    verdict,
    verdict_by: veredito?.verificador ?? null,
    verdict_why: veredito?.why ?? 'sem segunda opiniao — mantido como CONFIRMED',
  };
}
