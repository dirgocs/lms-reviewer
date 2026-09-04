import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { carregarAgentes } from './lms-bug-agents.mjs';
import {
  deveBootstrapar,
  proporAgentes,
  renderizarAgente,
  sinaisDoCodigo,
  runBootstrap,
  varrerRepo,
} from './lms-bug-bootstrap.mjs';

const execFile = promisify(execFileCallback);

/**
 * Repo fixture: duas superficies com codigo (worker e rota) e historia de `fix:`
 * concentrada em uma delas — e o que a varredura precisa achar.
 */
async function repoBootstrap() {
  const root = await mkdtemp(join(tmpdir(), 'lms-bootstrap-'));
  await execFile('git', ['init', '-q'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'lms@test'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'lms'], { cwd: root });
  await mkdir(join(root, 'services/api'), { recursive: true });
  await mkdir(join(root, 'services/workers'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), '# Agentes\nRegras do repo.\n');
  await writeFile(join(root, 'services/api/rotas.py'), '@app.get("/nota")\ndef nota():\n  pass\n');
  await writeFile(join(root, 'services/workers/fila.py'), 'def processar():\n  pass\n');
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-qm', 'feat: base'], { cwd: root });
  for (let i = 0; i < 3; i += 1) {
    await writeFile(join(root, 'services/workers/fila.py'), `def processar():\n  pass # v${i}\n`);
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-qm', 'fix: ajusta worker'], { cwd: root });
  }
  return root;
}

test('varrerRepo acha topologia, instrucoes e a historia de fix (Task 5)', async () => {
  const root = await repoBootstrap();
  const varredura = await varrerRepo(root);
  assert.ok(varredura.diretorios.includes('services'), 'topologia de 1o nivel');
  assert.ok(varredura.instrucoes.includes('AGENTS.md'), 'AGENTS.md do repo');
  const fixes = [...varredura.fixesPorDiretorio.entries()];
  assert.ok(
    fixes.some(([prefixo, n]) => prefixo === 'services/workers' && n >= 3),
    'a historia de fix aponta a superficie que mais quebra',
  );
  await rm(root, { recursive: true, force: true });
});

test('proporAgentes: entre 1 e 6 propostas, cada uma com motivo (Task 5)', async () => {
  const root = await repoBootstrap();
  const propostas = proporAgentes(await varrerRepo(root));
  assert.ok(propostas.length >= 1, 'piso 1');
  assert.ok(propostas.length <= 6, 'teto 6');
  for (const proposta of propostas) {
    assert.ok(proposta.nome, 'proposta tem nome');
    assert.ok(proposta.motivo.length > 5, 'motivo obrigatorio');
    assert.ok(proposta.match.paths.length > 0, 'proposta tem caminho de match');
  }
  // A superficie com historia de fix vence a ordem: e a que mais dói.
  assert.match(propostas[0].motivo, /commits `fix:`/);
  await rm(root, { recursive: true, force: true });
});

test('renderizarAgente produz frontmatter que carregarAgentes le de volta (Task 5)', async () => {
  const root = await repoBootstrap();
  const [proposta] = proporAgentes(await varrerRepo(root));
  const texto = renderizarAgente({
    ...proposta,
    fontes_de_verdade: ['AGENTS.md'],
    verificar_antes_de_abrir_issue: ['conferir a fila antes de culpar a rota'],
    escalar_para: 'orchestrator',
  });
  const pasta = join(root, '.agents/bug-triage');
  await mkdir(pasta, { recursive: true });
  await writeFile(join(pasta, `${proposta.nome}.md`), texto, 'utf8');

  const [agente] = await carregarAgentes(root, '.agents/bug-triage');
  assert.equal(agente.nome, proposta.nome, 'o agente renderizado volta pelo parser');
  assert.equal(agente.escalar_para, 'orchestrator');
  assert.deepEqual(agente.fontes_de_verdade, ['AGENTS.md']);
  assert.deepEqual(agente.verificar_antes_de_abrir_issue, [
    'conferir a fila antes de culpar a rota',
  ]);
  assert.ok(agente.match.paths.every((r) => r instanceof RegExp), 'paths compilam');
  await rm(root, { recursive: true, force: true });
});

test('runBootstrap autonomo: nada e escrito sem confirmacao (Task 5)', async () => {
  const root = await repoBootstrap();
  const resultado = await runBootstrap({
    root,
    guided: false,
    yes: false,
    pergunta: async () => 'n',
  });
  assert.equal(resultado.confirmado, false);
  assert.equal(resultado.escritos, 0);
  assert.ok(resultado.propostas.length >= 1, 'propos mesmo sem confirmar');
  assert.deepEqual(await carregarAgentes(root, '.agents/bug-triage'), [], 'nada no disco');
  await rm(root, { recursive: true, force: true });
});

test('runBootstrap confirmado escreve os agentes no dir da config (Task 5)', async () => {
  const root = await repoBootstrap();
  const resultado = await runBootstrap({
    root,
    dir: 'debug/agentes',
    guided: false,
    yes: true,
  });
  assert.equal(resultado.confirmado, true);
  assert.ok(resultado.escritos >= 1);
  const agentes = await carregarAgentes(root, 'debug/agentes');
  assert.equal(agentes.length, resultado.escritos, 'todo agente escrito e valido');
  await rm(root, { recursive: true, force: true });
});

test('--guided pergunta com default inferido e resposta vazia mantem o default (Task 5)', async () => {
  const root = await repoBootstrap();
  const perguntas = [];
  const resultado = await runBootstrap({
    root,
    guided: true,
    yes: false,
    // Toda resposta vazia, menos a confirmacao final: o default inferido tem de
    // bastar para escrever um agente valido — o trabalho e corrigir, nao redigir.
    pergunta: async (texto, padrao) => {
      perguntas.push({ texto, padrao });
      return texto.includes('Confirma') ? 'y' : '';
    },
  });
  assert.ok(perguntas.length >= 5, 'o modo guiado pergunta (spec §3.3)');
  const comDefault = perguntas.filter((p) => p.padrao);
  assert.ok(comDefault.length >= 4, 'as perguntas chegam com default inferido do codigo');
  assert.ok(resultado.escritos >= 1, 'resposta vazia usa o default inferido');
  const agentes = await carregarAgentes(root, '.agents/bug-triage');
  assert.deepEqual(
    agentes.map((a) => a.nome).sort(),
    resultado.propostas.map((p) => p.nome).sort(),
    'o agente guiado e valido no parser',
  );
  await rm(root, { recursive: true, force: true });
});

test('--guided: resposta preenchida vence o default inferido (Task 5)', async () => {
  const root = await repoBootstrap();
  const resultado = await runBootstrap({
    root,
    guided: true,
    yes: false,
    pergunta: async (texto, padrao) => {
      if (texto.includes('Confirma')) return 'y';
      if (texto.includes('escalar')) return 'orchestrator-fiscal';
      return padrao ?? '';
    },
  });
  assert.ok(resultado.escritos >= 1);
  const agentes = await carregarAgentes(root, '.agents/bug-triage');
  assert.ok(
    agentes.every((a) => a.escalar_para === 'orchestrator-fiscal'),
    'a resposta do usuario vence a inferencia',
  );
  await rm(root, { recursive: true, force: true });
});

// Spec §3.3: auto-init dispara por diretorio VAZIO/ausente. Diretorio com agente
// que nao casou NAO dispara — a resposta certa e "nenhum agente cobre este sinal",
// nao gerar arquivos por cima do que o consumidor ja escreveu.
test('auto-init so com diretorio vazio ou ausente (Task 5)', async () => {
  const root = await repoBootstrap();
  const pasta = join(root, '.agents/bug-triage');

  assert.equal(await deveBootstrapar(root, '.agents/bug-triage'), true, 'ausente dispara');

  await mkdir(pasta, { recursive: true });
  assert.equal(await deveBootstrapar(root, '.agents/bug-triage'), true, 'vazio dispara');

  await writeFile(
    join(pasta, 'api.md'),
    ['---', 'nome: api', 'match:', '  paths:', '    - "^services/api/"', '---', '', 'corpo'].join('\n'),
    'utf8',
  );
  assert.equal(
    await deveBootstrapar(root, '.agents/bug-triage'),
    false,
    'agente que nao casou NAO dispara bootstrap',
  );
  await rm(root, { recursive: true, force: true });
});

// Ajuste 1 (ordem do Master): heuristica barata sobre os arquivos da superficie —
// so o que o CODIGO JA NOMEIA (classe de excecao, codigo de erro literal,
// mensagem de raise/throw). Nada de adivinhar dominio alem disso, e o que sai
// vem marcado para revisao.
async function repoComSinaisNoCodigo() {
  const root = await mkdtemp(join(tmpdir(), 'lms-sinais-'));
  await execFile('git', ['init', '-q'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'lms@test'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'lms'], { cwd: root });
  await mkdir(join(root, 'services/workers'), { recursive: true });
  await writeFile(
    join(root, 'services/workers/emissao.py'),
    [
      'class TransmissaoError(Exception):',
      '    pass',
      '',
      'def emitir(lote):',
      '    if lote.status == "E0123":',
      '        raise TransmissaoError("lote rejeitado pela transmissao")',
      '    if lote.cStat == 656:',
      '        raise TransmissaoError("bloqueio temporario")',
      '',
    ].join('\n'),
  );
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-qm', 'fix: ajusta emissao'], { cwd: root });
  return root;
}

test('sinaisDoCodigo colhe excecao, codigo literal e mensagem de raise (Ajuste 1)', async () => {
  const root = await repoComSinaisNoCodigo();
  const sinais = await sinaisDoCodigo(root, 'services/workers');
  assert.ok(sinais.includes('TransmissaoError'), 'classe de excecao que o codigo levanta');
  assert.ok(sinais.some((s) => s.includes('E0123')), 'codigo de erro literal');
  assert.ok(sinais.some((s) => /lote rejeitado/.test(s)), 'mensagem de raise');
  // Nada inventado: so identificadores que existem no arquivo.
  const fonte = await readFile(join(root, 'services/workers/emissao.py'), 'utf8');
  for (const sinal of sinais) {
    const literal = sinal.replace(/\\(.)/g, '$1');
    assert.ok(fonte.includes(literal), `'${sinal}' precisa existir no codigo, nao ser adivinhado`);
  }
  // Toda entrada compila como regex — match.sinal e compilado por parseFrontmatter.
  for (const sinal of sinais) assert.doesNotThrow(() => new RegExp(sinal));
  await rm(root, { recursive: true, force: true });
});

test('proporAgentes usa os sinais do codigo e marca para revisar (Ajuste 1)', async () => {
  const root = await repoComSinaisNoCodigo();
  const propostas = await proporAgentes(await varrerRepo(root));
  const proposta = propostas.find((p) => p.prefixo === 'services/workers');
  assert.ok(proposta, 'a superficie com historia de fix vira proposta');
  assert.ok(
    proposta.match.sinal.some((s) => s.includes('TransmissaoError')),
    'o sinal inferido entra no match',
  );
  assert.ok(
    proposta.revisar.some((r) => /match\.sinal/.test(r)),
    'o que foi inferido sai marcado para revisao',
  );
  await rm(root, { recursive: true, force: true });
});

test('agente proposto nasce em rascunho e o runner o recusa ate ser preenchido (Ajuste 1+2)', async () => {
  const root = await repoComSinaisNoCodigo();
  const resultado = await runBootstrap({ root, guided: false, yes: true });
  assert.ok(resultado.escritos >= 1);

  const agentes = await carregarAgentes(root, '.agents/bug-triage');
  assert.ok(agentes.length >= 1);
  for (const agente of agentes) {
    assert.equal(agente.status, 'rascunho', 'sem checklist de dominio, nasce rascunho');
    assert.ok(agente.revisar?.length, 'o que a heuristica inferiu fica declarado');
  }
  await rm(root, { recursive: true, force: true });
});

test('proposta com checklist preenchido sai ativa (Ajuste 1+2)', async () => {
  const root = await repoComSinaisNoCodigo();
  const [proposta] = await proporAgentes(await varrerRepo(root));
  const texto = renderizarAgente({
    ...proposta,
    verificar_antes_de_abrir_issue: ['conferir o piso de retry antes de culpar a transmissao'],
  });
  const pasta = join(root, '.agents/bug-triage');
  await mkdir(pasta, { recursive: true });
  await writeFile(join(pasta, `${proposta.nome}.md`), texto, 'utf8');

  const [agente] = await carregarAgentes(root, '.agents/bug-triage');
  assert.equal(agente.status, 'ativo', 'checklist preenchido = ativo');
  await rm(root, { recursive: true, force: true });
});

// P1-2 da revisao da Fase 5: `--init` nao tinha guarda nenhuma (a de "nao gerar
// por cima" so existia no auto-init) e `renderizarAgente` emite
// `verificar_antes_de_abrir_issue` vazio — justamente a verdade que so o
// consumidor tem. Rodar `--init` de novo apagava o checklist escrito a mao.
async function repoComAgenteArtesanal() {
  const root = await repoBootstrap();
  const pasta = join(root, '.agents/bug-triage');
  await mkdir(pasta, { recursive: true });
  const [proposta] = proporAgentes(await varrerRepo(root));
  await writeFile(
    join(pasta, `${proposta.nome}.md`),
    [
      '---', `nome: ${proposta.nome}`, 'descricao: escrito a mao', 'status: ativo',
      'match:', '  paths:', '    - "^services/workers/"',
      'verificar_antes_de_abrir_issue:',
      '    - "conferir o piso de retry na fila antes de culpar o codigo"',
      '---', '', 'Triagem artesanal.', '',
    ].join('\n'),
    'utf8',
  );
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-qm', 'agente artesanal'], { cwd: root });
  return { root, nome: proposta.nome };
}

test('bootstrap nao sobrescreve agente existente (P1-2)', async () => {
  const { root, nome } = await repoComAgenteArtesanal();
  const resultado = await runBootstrap({ root, guided: false, yes: true });

  const texto = await readFile(join(root, '.agents/bug-triage', `${nome}.md`), 'utf8');
  assert.match(texto, /conferir o piso de retry/, 'a verdade de dominio escrita a mao sobrevive');
  assert.match(texto, /Triagem artesanal/, 'o corpo do consumidor sobrevive');
  assert.ok(resultado.pulados.includes(`${nome}.md`), 'o pulado e nomeado, nao silencioso');
  await rm(root, { recursive: true, force: true });
});

test('bootstrap escreve so o nome novo, ao lado do que ja existe (P1-2)', async () => {
  const { root, nome } = await repoComAgenteArtesanal();
  const resultado = await runBootstrap({ root, guided: false, yes: true });

  const agentes = await carregarAgentes(root, '.agents/bug-triage');
  const nomes = agentes.map((a) => a.nome);
  assert.ok(nomes.includes(nome), 'o existente continua la');
  assert.equal(
    resultado.escritos + resultado.pulados.length,
    resultado.propostas.length,
    'toda proposta ou foi escrita ou foi pulada com nome',
  );
  for (const escrito of resultado.escritos ? nomes : []) assert.ok(escrito);
  await rm(root, { recursive: true, force: true });
});

test('--force sobrescreve, mas so quando pedido explicitamente (P1-2)', async () => {
  const { root, nome } = await repoComAgenteArtesanal();
  const resultado = await runBootstrap({ root, guided: false, yes: true, force: true });

  const texto = await readFile(join(root, '.agents/bug-triage', `${nome}.md`), 'utf8');
  assert.doesNotMatch(texto, /Triagem artesanal/, '--force explicito regrava');
  assert.equal(resultado.pulados.length, 0);
  await rm(root, { recursive: true, force: true });
});
