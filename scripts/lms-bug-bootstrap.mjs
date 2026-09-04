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
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const TETO_AGENTES = 6;
const IGNORADOS = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', '__pycache__']);
const ESCALAR_PADRAO = 'orchestrator';

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
    propostas.push({
      nome,
      prefixo,
      descricao: `Sinais de runtime vindos de ${prefixo}`,
      motivo,
      match: {
        paths: [comoRegex(prefixo)],
        // Sinal estrutural: o nome da superfície costuma aparecer no stack trace.
        sinal: [prefixo.split('/').at(-1)].filter(Boolean),
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
  const linhas = ['---', `nome: ${proposta.nome}`, `descricao: ${proposta.descricao ?? proposta.nome}`];

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

/**
 * `pergunta(texto, default)` é injetável: teste sem TTY. Resposta vazia = default.
 * Autônomo (`yes: true`) não pergunta nada e grava.
 */
export async function runBootstrap({
  root = process.cwd(),
  dir = '.agents/bug-triage',
  guided = false,
  yes = false,
  pergunta,
} = {}) {
  const propostasIniciais = proporAgentes(await varrerRepo(root));
  if (propostasIniciais.length === 0) {
    console.error('lms-bug-bootstrap: nada a propor — repo sem superfície reconhecida');
    return { propostas: [], escritos: 0, confirmado: false };
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
    return { propostas, escritos: 0, confirmado: false };
  }

  const pasta = join(root, dir);
  await mkdir(pasta, { recursive: true });
  for (const proposta of propostas) {
    await writeFile(join(pasta, `${proposta.nome}.md`), renderizarAgente(proposta), 'utf8');
  }
  console.error(`lms-bug-bootstrap: nada roda até você commitar estes arquivos (${dir}/)`);
  return { propostas, escritos: propostas.length, confirmado: true };
}
