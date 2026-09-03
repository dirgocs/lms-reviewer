/**
 * Classe repetida vira achado estrutural (Fase 4).
 *
 * KDT-68 queimou 8 rodadas; cinco foram da MESMA classe ("paridade
 * preview×emissão") — o revisor abria o próximo exemplo da família a cada rodada
 * e ninguém tinha mandato para exigir o teste que fecha a classe. É a doutrina
 * "fix the principle, not the example" com mecanismo: a mesma lens no mesmo
 * prefixo de diretório (dois segmentos) em 3 rodadas consecutivas deixa de ser
 * coincidência e vira um P1 estrutural cujo acceptance é o teste da classe.
 *
 * O achado é do RUNNER: só acrescenta (nunca remove), bloqueia como qualquer P1
 * e o contraditório existente pode derrubá-lo.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Classe de um achado: lens + prefixo de dois segmentos do path. Path com menos
 * de dois segmentos usa o path inteiro — "a.ts" sozinho já é específico demais
 * para esconder uma família.
 */
export function classeDe(finding) {
  const lens = String(finding?.lens ?? '').trim() || 'code-quality';
  const limpo = String(finding?.path ?? '').split(':')[0].trim().replace(/^\.\//, '');
  const segmentos = limpo.split('/').filter(Boolean);
  const prefixo = segmentos.length >= 2 ? segmentos.slice(0, 2).join('/') : (limpo || '(sem path)');
  return `${lens}:${prefixo}`;
}

/**
 * Classes reincidentes: presentes em TODAS as últimas `janela` rodadas
 * consecutivas do histórico (rodadas em ordem cronológica, com `achados`).
 */
export function classesReincidentes(historico, { janela = 3 } = {}) {
  const rodadas = (Array.isArray(historico) ? historico : []).slice(-janela);
  if (rodadas.length < janela) return [];

  const porRodada = rodadas.map((rodada) => {
    const mapa = new Map();
    for (const achado of rodada.achados ?? []) {
      const classe = classeDe(achado);
      if (!mapa.has(classe)) mapa.set(classe, []);
      mapa.get(classe).push(achado.id);
    }
    return mapa;
  });

  const reincidentes = [];
  for (const classe of porRodada[0].keys()) {
    if (!porRodada.slice(1).every((mapa) => mapa.has(classe))) continue;
    const ids = porRodada.flatMap((mapa) => mapa.get(classe) ?? []);
    reincidentes.push({ classe, ids, rounds: rodadas.length });
  }
  return reincidentes;
}

/** O achado sintético: P1, do runner, com acceptance de TESTE da classe. */
export function achadoEstrutural(reincidente) {
  const [lens, prefixo] = reincidente.classe.split(/:(?=.)/);
  const id = `classe:${reincidente.classe}`;
  return {
    id,
    severity: 'P1',
    lens,
    path: `${prefixo}/`,
    title: `classe recorrente: ${lens} em ${prefixo}`,
    why: `a mesma classe de achado reincidiu em ${reincidente.rounds} rodadas consecutivas (${reincidente.ids.length} ocorrências) — corrigir ocorrências isoladas não fecha a família`,
    fix: 'escrever o teste que fecha a classe (propriedade, paridade ou tabela de cobertura) e rodar as correções sob ele',
    found_by: 'runner',
    confidence: 100,
    acceptance: [
      'um teste que feche a CLASSE (propriedade, paridade ou tabela de cobertura) — corrigir só as ocorrências citadas não fecha este achado',
    ],
    recurrence: { rounds: reincidente.rounds, ids: reincidente.ids },
  };
}

/**
 * As rodadas de `.lms/history.jsonl` que carregam achados (Task 5), em ordem
 * cronológica. Achados SINTÉTICOS (id 'classe:...') ficam FORA: o sintético é
 * recriado pelo runner a cada rodada — contá-lo como ocorrência manteria a
 * classe reincidente para sempre, em deadlock.
 */
export async function historicoDeRodadas(root, subject = '') {
  let texto;
  try {
    texto = await readFile(join(root, '.lms', 'history.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const rodadas = [];
  for (const linha of texto.split('\n')) {
    if (!linha.trim()) continue;
    let registro;
    try {
      registro = JSON.parse(linha);
    } catch {
      continue;
    }
    // P2-1 da revisao da Fase 4: recorrência é escopada por subject — rodadas de
    // outra branch (outro diff) não contam para a série.
    if (subject && registro.subject !== subject) continue;
    if (!Array.isArray(registro.achados)) continue;
    const achados = registro.achados.filter(
      (a) => typeof a.id !== 'string' || !a.id.startsWith('classe:'),
    );
    // P1-2 da revisao da Fase 4: rodada limpa (achados []) ENTRA — é ela que
    // quebra a série. Descartá-la mantinha o sintético bloqueando para sempre.
    rodadas.push({ achados });
  }
  return rodadas;
}
