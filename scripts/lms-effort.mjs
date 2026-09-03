/**
 * Profundidade da revisao a partir do raio do diff.
 *
 * O sinal ja existia e era usado pela metade: o orient calcula `riskHints` e a
 * rubrica so o usa para LIMITAR o score. Se o diff toca auth/tenant/fiscal a ponto
 * de o score nao poder passar de 3, ele tambem merece uma revisao mais funda — nao
 * a mesma revisao com o teto mais baixo.
 */
const NIVEIS = new Set(['medium', 'high', 'xhigh']);

// Mesma familia do riskRe de local-merge-score-orient.mjs, mantida aqui porque o
// runner nao importa o orient (que e um script de terminal, com process.chdir).
export const CAMINHOS_DE_RISCO =
  /(fiscal|auth|rls|tenant|payment|acquirer|tenantId|tenant_id|middleware\/auth|prisma|migrations\/|certs?\/|signer|webhook|\/pos\/)/i;

export function effortPara(paths, env = process.env) {
  const forcado = String(env.LMS_EFFORT ?? '').trim();
  if (NIVEIS.has(forcado)) return forcado;
  const risco = (paths ?? []).some((p) => CAMINHOS_DE_RISCO.test(p));
  return risco ? 'xhigh' : 'high';
}
