/**
 * Bootstrap de agentes de triagem de bug (Fase 5).
 *
 * Dispara por `lms-triage-bug --init` OU automaticamente quando nenhum agente
 * casa E o diretório está vazio/ausente — nunca quando existe agente que não
 * casou: aí a resposta certa é "nenhum agente cobre este sinal", não gerar
 * arquivos por cima do que o consumidor já escreveu.
 *
 * Autônomo (default): propõe de 1 a 6 agentes, cada um com MOTIVO, imprime a
 * lista e pede UMA confirmação no fim — nada é escrito antes dela, e nada roda
 * até os arquivos serem commitados (lms-bug-agents.mjs:agenteCommitado).
 * Guiado (`--guided`): as mesmas perguntas feitas ao usuário, cada uma já com o
 * default inferido do código — o trabalho é corrigir, não redigir.
 *
 * O pacote infere ONDE olhar (topologia, história de `fix:`, instruções do repo);
 * a verdade de domínio (`verificar_antes_de_abrir_issue`) fica em branco de
 * propósito: inventá-la seria embutir inteligência de domínio no gate.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const TETO_AGENTES = 6;
const IGNORADOS = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', '__pycache__']);
const ESCALAR_PADRAO = 'orchestrator';
const EXT_DE_CODIGO = /\.(py|ts|tsx|js|mjs|go|rb|java|cs|php|rs|kt)$/;
const TETO_SINAIS = 6;
const TETO_ARQUIVOS_LIDOS = 40;
const TETO_BYTES = 256 * 1024;

/** Escapa para ERE literal: o sinal e compilado por parseFrontmatter. */
function comoLiteral(texto) {
  return String(texto).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sinais que o CODIGO JA NOMEIA na superficie: classe de excecao levantada,
 * codigo de erro literal (E0123 e parentes) e mensagem de `raise`/`throw`.
 *
 * O limite e deliberado: o pacote nao adivinha vocabulario de dominio, so colhe
 * o que esta escrito. Tudo que sai daqui vai marcado em `revisar` — heuristica
 * barata acerta o suficiente para dar ponto de partida, nunca para virar verdade.
 */
export async function sinaisDoCodigo(root, prefixo) {
  const encontrados = new Map();
  const guardar = (bruto) => {
    const limpo = String(bruto ?? '').trim();
    if (limpo.length < 4 || limpo.length > 60) return;
    if (!encontrados.has(limpo)) encontrados.set(limpo, comoLiteral(limpo));
  };

  let lidos = 0;
  async function varrer(dir, profundidade) {
    if (lidos >= TETO_ARQUIVOS_LIDOS || profundidade > 2) return;
    let entradas;
    try {
      entradas = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entrada of entradas) {
      if (lidos >= TETO_ARQUIVOS_LIDOS) return;
      if (entrada.name.startsWith('.') || IGNORADOS.has(entrada.name)) continue;
      const caminho = join(dir, entrada.name);
      if (entrada.isDirectory()) {
        await varrer(caminho, profundidade + 1);
        continue;
      }
      if (!entrada.isFile() || !EXT_DE_CODIGO.test(entrada.name)) continue;
      let texto;
      try {
        texto = await readFile(caminho, 'utf8');
      } catch {
        continue;
      }
      lidos += 1;
      if (texto.length > TETO_BYTES) continue;

      // Classe de excecao: declarada, levantada ou lancada.
      for (const m of texto.matchAll(/\bclass\s+([A-Z]\w*(?:Error|Exception|Fault))\b/g)) guardar(m[1]);
      for (const m of texto.matchAll(/\b(?:raise|throw\s+new)\s+([A-Z]\w{3,40})\s*[(:]/g)) guardar(m[1]);
      // Codigo de erro literal: E0123, ERR-404, HTTP502 e parentes.
      for (const m of texto.matchAll(/\b([A-Z][A-Z0-9]{0,5}[-_]?\d{3,5})\b/g)) guardar(m[1]);
      // Mensagem de raise/throw: o inicio basta para casar o texto no log.
      for (const m of texto.matchAll(/\b(?:raise|throw\s+new)\s+\w+\s*\(\s*(?:f?["'\`])([^"'\`\n]{8,})/g)) {
        guardar(m[1].slice(0, 40).trim());
      }
    }
  }
  await varrer(join(root, prefixo), 0);

  return [...encontrados.values()].slice(0, TETO_SINAIS);
}

/** Escapa o prefixo para entrar como ERE literal no `match.paths` do agente. */
function comoRegex(prefixo) {
  return `^${prefixo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`;
}

/** Nome de agente a partir do caminho da superfície: kebab, sem colisão de arquivo. */
function nomeDaSuperficie(prefixo) {
  const bruto = prefixo.split('/').filter(Boolean).slice(-2).join('-');
  return bruto.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    || 'superficie';
}

/**
 * Varre o repo: topologia (1º/2º nível), instruções (`AGENTS.md`/`CLAUDE.md`),
 * superfícies onde bug chega de fora (rota, worker/fila, banco, integração),
 * gates existentes e a história de `fix:` — os arquivos que mais quebram.
 */
export async function varrerRepo(root = process.cwd()) {
  const varredura = {
    root,
    diretorios: [],
    instrucoes: [],
    superficies: new Map(), // prefixo -> Set de sinais estruturais ('rota', 'worker', …)
    gates: [],
    fixesPorDiretorio: new Map(),
    sinaisPorSuperficie: new Map(),
  };

  const marcar = (relativo, tipo) => {
    const partes = relativo.split('/');
    const prefixo = partes.slice(0, Math.min(2, partes.length - 1)).join('/');
    if (!prefixo) return;
    if (!varredura.superficies.has(prefixo)) varredura.superficies.set(prefixo, new Set());
    varredura.superficies.get(prefixo).add(tipo);
  };

  async function listar(dir, profundidade) {
    let entradas;
    try {
      entradas = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entrada of entradas) {
      if (entrada.name.startsWith('.') || IGNORADOS.has(entrada.name)) continue;
      const relativo = join(dir, entrada.name).slice(root.length + 1);
      if (entrada.isDirectory()) {
        if (profundidade < 2) varredura.diretorios.push(relativo);
        if (profundidade < 3) await listar(join(dir, entrada.name), profundidade + 1);
        continue;
      }
      if (!entrada.isFile()) continue;
      if (entrada.name === 'AGENTS.md' || entrada.name === 'CLAUDE.md') {
        varredura.instrucoes.push(relativo);
      }
      if (relativo === 'lms.config.json' || relativo.startsWith('.github/workflows/')) {
        varredura.gates.push(relativo);
      }
      if (/(worker|queue|fila|cron|celery|bullmq)/i.test(entrada.name)) marcar(relativo, 'worker');
      if (/(rota|route|handler|controller|api|view)/i.test(entrada.name)) marcar(relativo, 'rota');
      if (/(migration|schema|repository|supabase)/i.test(entrada.name)) marcar(relativo, 'banco');
      if (/(client|webhook|integrac|adapter|gateway)/i.test(entrada.name)) marcar(relativo, 'integracao');
    }
  }
  await listar(root, 0);

  // A história é a melhor pista de onde o bug volta: `git log --grep '^fix'`.
  try {
    const { stdout } = await execFile(
      'git',
      ['log', '--grep', '^fix', '--name-only', '--pretty=format:', '-n', '400'],
      { cwd: root, maxBuffer: 32 * 1024 * 1024 },
    );
    for (const linha of stdout.split('\n')) {
      const limpa = linha.trim();
      if (!limpa || !limpa.includes('/')) continue;
      const partes = limpa.split('/');
      const prefixo = partes.slice(0, Math.min(2, partes.length - 1)).join('/');
      if (!prefixo) continue;
      varredura.fixesPorDiretorio.set(
        prefixo,
        (varredura.fixesPorDiretorio.get(prefixo) ?? 0) + 1,
      );
    }
  } catch {
    // Repo sem git (ou sem commits) só perde a pista da história — a topologia basta.
  }

  // Sinais que o codigo ja nomeia, por superficie candidata. Fica aqui (e nao em
  // proporAgentes) para a proposta seguir sendo funcao pura sobre a varredura.
  const candidatas = new Set([
    ...varredura.superficies.keys(),
    ...varredura.fixesPorDiretorio.keys(),
  ]);
  for (const prefixo of candidatas) {
    const sinais = await sinaisDoCodigo(root, prefixo);
    if (sinais.length) varredura.sinaisPorSuperficie.set(prefixo, sinais);
  }

  return varredura;
}

/** Fonte de verdade mais próxima da superfície; senão a instrução da raiz. */
function fontesPara(prefixo, instrucoes) {
  const proximas = instrucoes.filter((i) => prefixo.startsWith(i.split('/').slice(0, -1).join('/')));
  const escolhidas = proximas.length ? proximas : instrucoes;
  return escolhidas.slice(0, 2);
}

/**
 * Propostas: uma por superfície onde bug chega de fora, piso 1 e teto 6, cada uma
 * com MOTIVO. Ordem: o que mais quebrou na história primeiro; depois a topologia.
 */
export function proporAgentes(varredura) {
  const propostas = [];
  const prefixosVistos = new Set();

  const adicionar = (prefixo, motivo, tipos = []) => {
    if (propostas.length >= TETO_AGENTES || prefixosVistos.has(prefixo)) return;
    prefixosVistos.add(prefixo);
    const nome = nomeDaSuperficie(prefixo);
    // O que o codigo ja nomeia vence o nome da pasta: `TransmissaoError` casa um
    // stack trace, `workers` casa qualquer coisa. Mas e inferencia — sai marcado.
    const doCodigo = varredura.sinaisPorSuperficie?.get(prefixo) ?? [];
    const sinal = doCodigo.length
      ? doCodigo
      : [prefixo.split('/').at(-1)].filter(Boolean);
    propostas.push({
      nome,
      prefixo,
      descricao: `Sinais de runtime vindos de ${prefixo}`,
      motivo,
      revisar: doCodigo.length
        ? [`match.sinal inferido do codigo desta superficie (${doCodigo.length} padroes) — confirme antes de ativar`]
        : [],
      match: {
        paths: [comoRegex(prefixo)],
        sinal,
      },
      fontes_de_verdade: fontesPara(prefixo, varredura.instrucoes),
      // Verdade de domínio é do consumidor: fica em branco para ele preencher.
      verificar_antes_de_abrir_issue: [],
      escalar_para: ESCALAR_PADRAO,
      tipos,
    });
  };

  for (const [prefixo, contagem] of [...varredura.fixesPorDiretorio.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    adicionar(
      prefixo,
      `${contagem} commits \`fix:\` tocando ${prefixo}`,
      [...(varredura.superficies.get(prefixo) ?? [])],
    );
  }

  for (const [prefixo, tipos] of [...varredura.superficies.entries()].sort()) {
    adicionar(prefixo, `superfície de ${[...tipos].sort().join('/')} em ${prefixo}`, [...tipos]);
  }

  // Piso 1: repo sem história e sem superfície reconhecida ainda merece um agente.
  if (propostas.length === 0) {
    for (const diretorio of varredura.diretorios.slice(0, TETO_AGENTES)) {
      adicionar(diretorio, `diretório de código sem agente de triagem: ${diretorio}`);
    }
  }

  return propostas;
}

/** Texto do agente com o frontmatter do molde da spec §3.2. */
export function renderizarAgente(proposta) {
  const lista = (itens) => itens.map((item) => `    - "${String(item).replace(/"/g, "'")}"`);
  // Sem a verdade de dominio o agente orienta ONDE olhar sem dizer O QUE conferir
  // — e o jeito de produzir triagem confiante e errada. Nasce rascunho e o runner
  // recusa ate ser preenchido (lms-bug-agents.mjs:agenteEmRascunho).
  const status = (proposta.verificar_antes_de_abrir_issue ?? []).length ? 'ativo' : 'rascunho';
  const linhas = [
    '---',
    `nome: ${proposta.nome}`,
    `descricao: ${proposta.descricao ?? proposta.nome}`,
    `status: ${status}`,
  ];

  linhas.push('match:', '  paths:', ...lista(proposta.match.paths));
  if (proposta.match.sinal?.length) linhas.push('  sinal:', ...lista(proposta.match.sinal));
  if (proposta.match.tags?.length) {
    linhas.push(`  tags: [${proposta.match.tags.map((t) => `"${t}"`).join(', ')}]`);
  }
  if (proposta.fontes_de_verdade?.length) {
    linhas.push('fontes_de_verdade:', ...lista(proposta.fontes_de_verdade));
  }
  if (proposta.verificar_antes_de_abrir_issue?.length) {
    linhas.push('verificar_antes_de_abrir_issue:', ...lista(proposta.verificar_antes_de_abrir_issue));
  }
  if (proposta.revisar?.length) linhas.push('revisar:', ...lista(proposta.revisar));
  if (proposta.escalar_para) linhas.push(`escalar_para: ${proposta.escalar_para}`);
  linhas.push('---', '');

  linhas.push(
    '## Como triar',
    '',
    `Proposto por: ${proposta.motivo ?? 'bootstrap'}.`,
    '',
    'Descreva aqui o caminho útil do sinal nesta superfície (qual arquivo olhar,',
    'qual estado conferir) e preencha `verificar_antes_de_abrir_issue` com o que',
    'SEMPRE precisa ser conferido antes de abrir issue — é a verdade de domínio',
    'que o pacote não tem como inferir.',
    '',
    ...(status === 'rascunho'
      ? [
          '> **Rascunho.** Este agente NÃO roda enquanto `status: rascunho`.',
          '> Preencha `verificar_antes_de_abrir_issue`, troque `status` para `ativo`',
          '> e commite — só agente commitado e preenchido tria.',
          '',
        ]
      : []),
    ...(proposta.revisar?.length
      ? ['> Revise antes de ativar:', ...proposta.revisar.map((r) => `> - ${r}`), '']
      : []),
  );
  return linhas.join('\n');
}

/**
 * Auto-init dispara SÓ com o diretório vazio/ausente. Diretório com agente que
 * não casou não dispara: gerar arquivo por cima do que o consumidor escreveu
 * esconderia o diagnóstico certo ("nenhum agente cobre este sinal").
 */
export async function deveBootstrapar(root, dir = '.agents/bug-triage') {
  try {
    const entradas = await readdir(join(root, dir), { withFileTypes: true });
    return !entradas.some((e) => e.isFile() && e.name.endsWith('.md'));
  } catch {
    return true;
  }
}

const CONFIRMACOES = new Set(['y', 'yes', 's', 'sim']);

async function existe(caminho) {
  try {
    await access(caminho);
    return true;
  } catch {
    return false;
  }
}

/**
 * `pergunta(texto, default)` é injetável: teste sem TTY. Resposta vazia = default.
 * Autônomo (`yes: true`) não pergunta nada e grava.
 */
export async function runBootstrap({
  root = process.cwd(),
  dir = '.agents/bug-triage',
  guided = false,
  yes = false,
  force = false,
  pergunta,
} = {}) {
  const propostasIniciais = proporAgentes(await varrerRepo(root));
  if (propostasIniciais.length === 0) {
    console.error('lms-bug-bootstrap: nada a propor — repo sem superfície reconhecida');
    return { propostas: [], escritos: 0, pulados: [], confirmado: false };
  }

  const perguntar = async (texto, padrao = '') => {
    if (typeof pergunta !== 'function') return padrao;
    const resposta = await pergunta(texto, padrao);
    const limpa = String(resposta ?? '').trim();
    return limpa === '' ? padrao : limpa;
  };

  let propostas = propostasIniciais;

  if (guided) {
    // Spec §3.3: as mesmas perguntas, cada uma já com o default inferido.
    const nomes = await perguntar(
      'Quais superfícies recebem bug de fora?',
      propostas.map((p) => p.nome).join(', '),
    );
    const escolhidos = new Set(nomes.split(',').map((n) => n.trim()).filter(Boolean));
    const filtradas = propostas.filter((p) => escolhidos.has(p.nome));
    if (filtradas.length) propostas = filtradas;

    for (const proposta of propostas) {
      const paths = await perguntar(
        `[${proposta.nome}] quais caminhos o sinal cita?`,
        proposta.match.paths.join(', '),
      );
      proposta.match.paths = paths.split(',').map((p) => p.trim()).filter(Boolean);

      const sinal = await perguntar(
        `[${proposta.nome}] que padrão de texto identifica o sinal?`,
        (proposta.match.sinal ?? []).join(', '),
      );
      proposta.match.sinal = sinal.split(',').map((s) => s.trim()).filter(Boolean);

      const fontes = await perguntar(
        `[${proposta.nome}] fonte de verdade do domínio?`,
        (proposta.fontes_de_verdade ?? []).join(', '),
      );
      proposta.fontes_de_verdade = fontes.split(',').map((f) => f.trim()).filter(Boolean);

      // Sem default de propósito: é a verdade de domínio que só o consumidor tem.
      const conferir = await perguntar(
        `[${proposta.nome}] o que SEMPRE conferir antes de abrir issue? (uma por ';')`,
        '',
      );
      proposta.verificar_antes_de_abrir_issue = conferir
        .split(';').map((c) => c.trim()).filter(Boolean);

      proposta.escalar_para = await perguntar(
        `[${proposta.nome}] quando não for fix local, escalar para quem?`,
        proposta.escalar_para ?? ESCALAR_PADRAO,
      );
    }
  }

  // Lista + motivo antes da confirmação: o usuário decide vendo o porquê de cada um.
  console.error(`lms-bug-bootstrap: ${propostas.length} agente(s) proposto(s) em ${dir}/`);
  for (const proposta of propostas) {
    console.error(`  - ${proposta.nome}: ${proposta.motivo}`);
  }

  const confirmado = yes
    || CONFIRMACOES.has((await perguntar('Confirma e grava estes agentes? (y/N)', 'n')).toLowerCase());

  if (!confirmado) {
    console.error('lms-bug-bootstrap: nada escrito');
    return { propostas, escritos: 0, pulados: [], confirmado: false };
  }

  const pasta = join(root, dir);
  await mkdir(pasta, { recursive: true });

  // P1-2 da revisao da Fase 5: NUNCA escrever por cima de agente que ja existe.
  // O arquivo gerado sai com `verificar_antes_de_abrir_issue` vazio — e a verdade
  // de dominio que so o consumidor tem —, entao regravar apaga exatamente o que
  // nao da para recuperar. Escreve so nome novo; `--force` e a unica forma de
  // sobrescrever, e e explicita.
  const escritos = [];
  const pulados = [];
  for (const proposta of propostas) {
    const arquivo = join(pasta, `${proposta.nome}.md`);
    if (!force && await existe(arquivo)) {
      pulados.push(`${proposta.nome}.md`);
      continue;
    }
    await writeFile(arquivo, renderizarAgente(proposta), 'utf8');
    escritos.push(`${proposta.nome}.md`);
  }

  if (pulados.length) {
    console.error(
      `lms-bug-bootstrap: ${pulados.length} agente(s) ja existiam e foram PULADOS `
      + `(${pulados.join(', ')}) — use --force para sobrescrever, ciente de que isso `
      + 'apaga o verificar_antes_de_abrir_issue escrito a mao',
    );
  }
  if (escritos.length) {
    console.error(`lms-bug-bootstrap: nada roda até você commitar estes arquivos (${dir}/)`);
  }
  return { propostas, escritos: escritos.length, pulados, confirmado: true };
}
