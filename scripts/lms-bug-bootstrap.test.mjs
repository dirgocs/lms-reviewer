import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { carregarAgentes } from './lms-bug-agents.mjs';
import {
  deveBootstrapar,
  proporAgentes,
  renderizarAgente,
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
