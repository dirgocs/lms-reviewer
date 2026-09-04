/**
 * Agentes de debug do consumidor (Fase 5).
 *
 * Um `.md` por superfície em `.agents/bug-triage/`, com frontmatter YAML mínimo
 * (parser próprio, zero dependência nova): `match` pontua paths/sinal/tags sobre o
 * sinal normalizado, e o corpo markdown entra no prompt como contexto — o pacote
 * não interpreta inteligência de domínio, só a carrega do repo que a escreveu.
 *
 * SÓ AGENTE COMMITADO RODA (untracked/modificado → recusa nomeada): instrução que
 * orienta o veredito não pode ser editável no mesmo turno em que é lida — mesma
 * razão da CAMINHOS_PROIBIDOS de lms-fix-routing.mjs.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

function str(valor) {
  return typeof valor === 'string' && valor.trim() ? valor.trim() : null;
}

/** Lista de strings com regex compilada; item ruim descarta o CONJUNTO (regexList). */
function listaDeRegex(valor, chave) {
  if (!Array.isArray(valor) || !valor.every((item) => typeof item === 'string')) {
    throw new TypeError(`${chave} precisa ser array de strings`);
  }
  return valor.map((padrao) => {
    // P2-1 da revisao da Fase 5: `new RegExp('')` compila e casa QUALQUER string.
    // Uma entrada vazia (trivial em YAML: `- ""`, ou um `- ` orfao) daria escore
    // em todo sinal, e o agente coringa venceria qualquer agente especifico —
    // entregando contexto de dominio errado ao prompt e `escalar_para` errado a
    // rota. Padrao vazio e defeito de escrita, nao curinga.
    if (!padrao.trim()) throw new TypeError(`${chave} tem padrao vazio (casaria tudo)`);
    return new RegExp(padrao);
  });
}

/**
 * YAML mínimo com aninhamento por INDENTAÇÃO: `chave: valor` escalar, listas
 * `- item` e arrays inline `["a", "b"]`. Sem `nome`, ou com regex que não
 * compila, devolve null — agente descartado, nunca "match parcial"
 * (disciplina de lms-config.mjs:regexList).
 */
export function parseFrontmatter(texto) {
  const bruto = String(texto ?? '');
  const abertura = bruto.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!abertura) return null;

  const raiz = {};
  const pilha = [{ indent: -1, obj: raiz }];
  const strip = (item) => item.replace(/^["']|["']$/g, '').trim();

  for (const linhaBruta of abertura[1].split('\n')) {
    if (!linhaBruta.trim()) continue;
    const indent = (linhaBruta.match(/^ */) ?? [''])[0].length;
    while (pilha.length > 1 && indent <= pilha.at(-1).indent) pilha.pop();
    const topo = pilha.at(-1).obj;
    const linha = linhaBruta.trim();

    if (linha.startsWith('- ')) {
      // O objeto corrente ('chave:' vazio) e o container da lista — converte {}
      // em [] na primeira ocorrencia e substitui a propriedade no pai.
      let alvo = topo;
      if (!Array.isArray(alvo)) {
        if (typeof alvo === 'object' && alvo !== null && Object.keys(alvo).length === 0) {
          alvo = [];
          const pai = pilha.at(-2).obj;
          const chaveNoPai = Object.keys(pai).find((k) => pai[k] === topo);
          if (!chaveNoPai) return null;
          pai[chaveNoPai] = alvo;
          pilha.at(-1).obj = alvo;
        } else {
          return null;
        }
      }
      alvo.push(strip(linha.slice(2)));
      continue;
    }

    const doisPontos = linha.indexOf(':');
    if (doisPontos === -1) return null;
    const chave = linha.slice(0, doisPontos).trim();
    const valor = linha.slice(doisPontos + 1).trim();
    if (valor === '') {
      topo[chave] = {};
      pilha.push({ indent, obj: topo[chave] });
      continue;
    }
    if (valor.startsWith('[') && valor.endsWith(']')) {
      topo[chave] = valor.slice(1, -1).split(',').map((item) => strip(item)).filter(Boolean);
      continue;
    }
    topo[chave] = strip(valor);
  }

  if (!str(raiz.nome)) return null;
  try {
    if (raiz.match && typeof raiz.match === 'object' && !Array.isArray(raiz.match)) {
      if (raiz.match.paths !== undefined) {
        raiz.match.paths = listaDeRegex(raiz.match.paths, 'match.paths');
      }
      if (raiz.match.sinal !== undefined) {
        raiz.match.sinal = listaDeRegex(raiz.match.sinal, 'match.sinal');
      }
    }
  } catch {
    return null;
  }
  return { dados: raiz, corpo: bruto.slice(abertura[0].length).trim() };
}

/** Agentes válidos do diretório; frontmatter inválido é descartado com aviso. */
export async function carregarAgentes(root, dir = '.agents/bug-triage') {
  const pasta = join(root, dir);
  let entradas;
  try {
    entradas = await readdir(pasta, { withFileTypes: true });
  } catch {
    return [];
  }
  const agentes = [];
  for (const entrada of entradas
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const caminho = join(pasta, entrada.name);
    const texto = await readFile(caminho, 'utf8');
    const parseado = parseFrontmatter(texto);
    if (!parseado) {
      console.error(`lms-bug-agents: ${entrada.name} descartado — frontmatter inválido`);
      continue;
    }
    agentes.push({ arquivo: caminho, ...parseado.dados, corpo: parseado.corpo });
  }
  return agentes;
}

/**
 * Agente em RASCUNHO nao roda. O bootstrap escreve `status: rascunho` quando nao
 * tem o que so o consumidor sabe (`verificar_antes_de_abrir_issue`): sem essa
 * lista o agente orienta onde olhar sem dizer o que conferir, que e exatamente o
 * jeito de produzir triagem confiante e errada.
 *
 * Ausencia de `status` e ATIVO: agente escrito a mao antes disto nao para de
 * funcionar por causa de uma chave nova.
 */
export function agenteEmRascunho(agente) {
  return String(agente?.status ?? '').trim().toLowerCase() === 'rascunho';
}

/**
 * Só agente COMMITADO roda. Untracked/modificado → recusa nomeada, com o estado.
 */
export async function agenteCommitado(root, arquivo) {
  const relativo = arquivo.startsWith(root + '/') ? arquivo.slice(root.length + 1) : arquivo;
  try {
    await execFile('git', ['ls-files', '--error-unmatch', relativo], { cwd: root });
  } catch {
    return { commitado: false, estado: 'untracked' };
  }
  try {
    const { stdout } = await execFile('git', ['status', '--porcelain', relativo], { cwd: root });
    if (stdout.trim()) {
      return { commitado: false, estado: 'modificado' };
    }
  } catch {
    return { commitado: false, estado: 'git indisponível' };
  }
  return { commitado: true, estado: 'commitado' };
}

/** Escore do match: paths×3 sobre caminhos citados, sinal×2 sobre o texto, tags×1. */
function escore(agente, sinal) {
  let total = 0;
  const texto = String(sinal?.texto ?? '');
  const citados = Array.isArray(sinal?.caminhos_citados) ? sinal.caminhos_citados : [];
  const regexDe = (padrao) =>
    padrao instanceof RegExp ? padrao : new RegExp(String(padrao));
  for (const padrao of agente.match?.paths ?? []) {
    const re = regexDe(padrao);
    if (citados.some((c) => re.test(c))) total += 3;
  }
  for (const padrao of agente.match?.sinal ?? []) {
    if (regexDe(padrao).test(texto)) total += 2;
  }
  for (const tag of agente.match?.tags ?? []) {
    if ((sinal?.tags ?? []).includes(tag)) total += 1;
  }
  return total;
}

/**
 * Vence o maior escore > 0; empate resolve pelo nome menor. Zero match → null
 * (aí fala o bootstrap, não "match parcial").
 */
export function escolherAgente(agentes, sinal) {
  const candidatos = agentes
    .map((agente) => ({ agente, pontos: escore(agente, sinal) }))
    .filter((c) => c.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos || a.agente.nome.localeCompare(b.agente.nome));
  return candidatos[0]?.agente ?? null;
}

/** Contexto do prompt: corpo markdown + fontes de verdade + checklist pré-issue. */
export function contextoDoAgente(agente) {
  const fontes = (agente.fontes_de_verdade ?? []).map((f) => `- ${f}`).join('\n');
  const checklist = (agente.verificar_antes_de_abrir_issue ?? [])
    .map((item) => `- ${item}`)
    .join('\n');
  return [
    `--- AGENTE: ${agente.nome} ---`,
    agente.descricao ? `descrição: ${agente.descricao}` : '',
    '',
    corpoTexto(agente),
    fontes ? `\nFontes de verdade (consulte antes de afirmar):\n${fontes}` : '',
    checklist ? `\nSEMPRE confira antes de abrir issue:\n${checklist}` : '',
  ].filter(Boolean).join('\n');
}

function corpoTexto(agente) {
  return typeof agente.corpo === 'string' ? agente.corpo : '';
}
