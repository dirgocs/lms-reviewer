/**
 * Quem corrige cada achado.
 *
 * A forma do achado responde: se `fix` e um diff, quem achou tem o contexto do
 * tamanho exato do defeito e corrige melhor que o orquestrador, que precisaria
 * re-derivar tudo a partir de um resumo em prosa. Se `fix` e uma decisao, o revisor
 * nao conhece o plano e escala.
 */
import { CAMINHOS_DE_RISCO } from './lms-effort.mjs';

/**
 * O fix NUNCA escreve aqui.
 *
 * Um agente com mandato de corrigir e incentivo de passar no gate, com acesso de
 * escrita ao gate, edita o gate. Mesma razao pela qual PROVAS_PERMITIDAS e allowlist
 * fechada: o que sai do modelo nao manda no que julga o modelo.
 *
 * Nota de migracao: .claude/hooks/ e .agents/skills/local-merge-score/ deste
 * monorepo sao hooks/ e skills/local-merge-score/ aqui.
 */
export const CAMINHOS_PROIBIDOS = [
  /^\.lms\//,
  /^\.claude\/hooks\//,
  /^hooks\//,
  /^scripts\/lms-/,
  /^scripts\/db-exposure-gate/,
  /^scripts\/local-merge-score/,
  /^skills\/local-merge-score\//,
  // P2-4 da revisao da Fase 3: o mapeamento documentado (.agents/.claude ->
  // skills/) e o pacote instalado no consumidor sao o MESMO gate — sem eles,
  // um achado apontando para a fonte roteava como corrigivel pelo revisor.
  /^\.agents\/skills\/local-merge-score\//,
  /^\.claude\/skills\/local-merge-score\//,
  /node_modules\/@dirgocs\/lms-reviewer\//,
  /^\.git\//,
  /^\.husky\//,
];

export function caminhoProibido(path) {
  const limpo = String(path ?? '').replace(/^\.\//, '').trim();
  return CAMINHOS_PROIBIDOS.some((re) => re.test(limpo));
}

export function arquivosDoAchado(finding) {
  const bruto = Array.isArray(finding?.path) ? finding.path : [finding?.path];
  return [
    ...new Set(
      bruto
        .filter((p) => typeof p === 'string' && p.trim())
        .map((p) => p.split(':')[0].trim().replace(/^\.\//, '')),
    ),
  ];
}

// Um `fix` que fala de decisao, e nao de edicao, e o sinal de que o revisor nao tem
// o contexto necessario: ele nao conhece o plano do produto.
const PEDE_DECISAO = /\b(decid|avali|discut|considerar se|remover a rota|repensar|arquitetur|escolher entre)/i;

const MIN_FIX = 20;

export function corrigivelPeloRevisor(finding) {
  // Fase 4 Task 6: fix pontual nao fecha classe recorrente — o acceptance do
  // achado estrutural exige o teste da CLASSE, decisao de desenho do orquestrador.
  if (finding?.recurrence) {
    return { ok: false, motivo: 'classe recorrente exige decisao de desenho' };
  }
  const arquivos = arquivosDoAchado(finding);
  if (arquivos.length === 0) return { ok: false, motivo: 'achado sem arquivo citado' };
  if (arquivos.some(caminhoProibido)) {
    return { ok: false, motivo: 'achado toca o proprio gate — correcao e do Master' };
  }
  if (arquivos.some((p) => CAMINHOS_DE_RISCO.test(p))) {
    return { ok: false, motivo: 'caminho de risco (auth/tenant/fiscal/migration) — vai para o orquestrador' };
  }
  const fix = String(finding?.fix ?? '').trim();
  if (fix.length < MIN_FIX) return { ok: false, motivo: 'sem fix acionavel descrito' };
  if (PEDE_DECISAO.test(fix)) {
    return { ok: false, motivo: 'o fix pede decisao, nao edicao — vai para o orquestrador' };
  }
  return { ok: true, motivo: 'fix localizado nos arquivos citados' };
}
