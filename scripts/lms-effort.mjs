/**
 * Profundidade da revisao a partir do raio do diff.
 *
 * O sinal ja existia e era usado pela metade: o orient calcula `riskHints` e a
 * rubrica so o usa para LIMITAR o score. Se o diff toca auth/tenant/fiscal a ponto
 * de o score nao poder passar de 3, ele tambem merece uma revisao mais funda — nao
 * a mesma revisao com o teto mais baixo.
 */
/**
 * Niveis validos de esforco (politica do Master, 2026-09-05): a profundidade sobe
 * com a complexidade, e `max` NAO existe — queima cota sem ganho de revisao e ja
 * apareceu em env de lane. Recusado com mensagem, nunca aceito em silencio.
 */
export const NIVEIS_DE_EFFORT = Object.freeze(['low', 'medium', 'high', 'xhigh']);
const NIVEIS = new Set(NIVEIS_DE_EFFORT);

/**
 * Normaliza o valor de uma env de esforco. Devolve o nivel valido, ou null (com
 * aviso nomeando a env) para qualquer outra coisa — quem chama cai no default.
 */
export function effortValido(valor, chave = 'LMS_EFFORT') {
  const limpo = String(valor ?? '').trim().toLowerCase();
  if (!limpo) return null;
  if (NIVEIS.has(limpo)) return limpo;
  console.error(
    `lms: ${chave}="${valor}" invalido (aceitos: ${NIVEIS_DE_EFFORT.join('|')}); usando o default`,
  );
  return null;
}

// Mesma familia do riskRe de local-merge-score-orient.mjs, mantida aqui porque o
// runner nao importa o orient (que e um script de terminal, com process.chdir).
export const CAMINHOS_DE_RISCO =
  /(fiscal|auth|rls|tenant|payment|acquirer|tenantId|tenant_id|middleware\/auth|prisma|migrations\/|certs?\/|signer|webhook|\/pos\/)/i;

export function effortPara(paths, env = process.env) {
  const forcado = effortValido(env.LMS_EFFORT, 'LMS_EFFORT');
  if (forcado) return forcado;
  const risco = (paths ?? []).some((p) => CAMINHOS_DE_RISCO.test(p));
  return risco ? 'xhigh' : 'high';
}
