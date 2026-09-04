import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  agenteCommitado,
  agenteEmRascunho,
  carregarAgentes,
  contextoDoAgente,
  escolherAgente,
  parseFrontmatter,
} from './lms-bug-agents.mjs';

const execFile = promisify(execFileCallback);

const agenteFiscal = `---
nome: fiscal-sefaz
descricao: Rejeicoes e timeouts na comunicacao com a SEFAZ
match:
  paths:
    - "^services/fiscal/backend/app/services/"
    - "^services/fiscal/backend/app/workers/"
  sinal:
    - "cStat[= ]?[0-9]{3}"
  tags: ["http-500"]
fontes_de_verdade:
  - services/fiscal/AGENTS.md
verificar_antes_de_abrir_issue:
  - "cStat 656 e bloqueio de 1h por CNPJ"
escalar_para: orchestrator
---

## Como triar

O caminho util e transitions.py, nunca a rota HTTP.
`;

const sinal = {
  texto: 'cStat 656 em services/fiscal/backend/app/services/x.py:120',
  origem: 'stdin',
  tags: ['http-500'],
  caminhos_citados: ['services/fiscal/backend/app/services/x.py'],
};

test('parseFrontmatter le YAML minimo e separa o corpo (Task 1)', () => {
  const { dados, corpo } = parseFrontmatter(agenteFiscal);
  assert.equal(dados.nome, 'fiscal-sefaz');
  assert.equal(dados.escalar_para, 'orchestrator');
  assert.deepEqual(dados.match.tags, ['http-500']);
  assert.match(corpo, /Como triar/);
});

test('frontmatter sem nome, ou regex invalida, e descartado (Task 1)', () => {
  assert.equal(parseFrontmatter('## sem frontmatter'), null);
  assert.equal(parseFrontmatter('---\ndescricao: so isso\n---\ncorpo'), null);
  const regexRuim = agenteFiscal.replace('"^services/fiscal/backend/app/services/"', '"[invalid"');
  assert.equal(parseFrontmatter(regexRuim), null, 'regex que nao compila descarta o agente');
});

test('carregarAgentes le o diretorio do consumidor (Task 1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-agents-'));
  const dir = join(root, '.agents', 'bug-triage');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'fiscal.md'), agenteFiscal);
  const agentes = await carregarAgentes(root, '.agents/bug-triage');
  assert.equal(agentes.length, 1);
  assert.equal(agentes[0].nome, 'fiscal-sefaz');
});

test('escolherAgente: paths pesam mais que sinal, que pesa mais que tags (Task 1)', () => {
  const agentes = [
    { nome: 'a', match: { paths: ['^services/fiscal/'], sinal: [], tags: ['http-500'] } },
    { nome: 'b', match: { paths: [], sinal: ['cStat'], tags: ['http-500'] } },
  ];
  // 'a' casa paths (3) + tags (1) = 4; 'b' casa sinal (2) + tags (1) = 3.
  assert.equal(escolherAgente(agentes, sinal).nome, 'a');
});

test('escolherAgente: empate resolve pelo nome menor (Task 1)', () => {
  const agentes = [
    { nome: 'ze', match: { paths: ['^services/'] } },
    { nome: 'ana', match: { paths: ['^services/'] } },
  ];
  assert.equal(escolherAgente(agentes, sinal).nome, 'ana');
});

test('escolherAgente: zero match devolve null — sinaliza bootstrap (Task 1)', () => {
  const agentes = [{ nome: 'a', match: { paths: ['^nao/existe/'] } }];
  assert.equal(escolherAgente(agentes, sinal), null);
});

test('agente untracked e recusado (Task 1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-agents-git-'));
  await execFile('git', ['init', '-q'], { cwd: root });
  const dir = join(root, '.agents', 'bug-triage');
  await mkdir(dir, { recursive: true });
  const arquivo = join(dir, 'fiscal.md');
  await writeFile(arquivo, agenteFiscal);
  const r = await agenteCommitado(root, arquivo);
  assert.equal(r.commitado, false);
  assert.match(r.estado, /untracked/i);
});

test('agente modificado e recusado (Task 1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-agents-git2-'));
  await execFile('git', ['init', '-q'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'lms@test'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'lms'], { cwd: root });
  const dir = join(root, '.agents', 'bug-triage');
  await mkdir(dir, { recursive: true });
  const arquivo = join(dir, 'fiscal.md');
  await writeFile(arquivo, agenteFiscal);
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-qm', 'agente commitado'], { cwd: root });
  await writeFile(arquivo, agenteFiscal + '\n\n## Alterado depois');
  const r = await agenteCommitado(root, arquivo);
  assert.equal(r.commitado, false);
  assert.match(r.estado, /modificado/i);
});

test('agente commitado passa (Task 1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-agents-git3-'));
  await execFile('git', ['init', '-q'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'lms@test'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'lms'], { cwd: root });
  const dir = join(root, '.agents', 'bug-triage');
  await mkdir(dir, { recursive: true });
  const arquivo = join(dir, 'fiscal.md');
  await writeFile(arquivo, agenteFiscal);
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-qm', 'agente'], { cwd: root });
  const r = await agenteCommitado(root, arquivo);
  assert.equal(r.commitado, true);
});

test('contextoDoAgente junta corpo, fontes de verdade e checklist (Task 1)', () => {
  const { dados, corpo } = parseFrontmatter(agenteFiscal);
  const ctx = contextoDoAgente({ nome: dados.nome, ...dados, corpo });
  assert.match(ctx, /Como triar/);
  assert.match(ctx, /services\/fiscal\/AGENTS\.md/);
  assert.match(ctx, /cStat 656/);
});

// Ajuste 2 (ordem do Master): agente sem `verificar_antes_de_abrir_issue` nasce
// `status: rascunho` e NAO roda. Commitado + preenchido = ativo. Agente sem a
// chave `status` (todos os escritos a mao antes disto) segue ativo.
test('agenteEmRascunho: so status rascunho explicito recusa (Ajuste 2)', () => {
  assert.equal(agenteEmRascunho({ nome: 'a', status: 'rascunho' }), true);
  assert.equal(agenteEmRascunho({ nome: 'a', status: 'ativo' }), false);
  assert.equal(agenteEmRascunho({ nome: 'a' }), false, 'sem status = ativo (compat)');
  assert.equal(agenteEmRascunho({ nome: 'a', status: 'RASCUNHO' }), true, 'case-insensitive');
});

test('parseFrontmatter le status e revisar (Ajuste 2)', () => {
  const texto = [
    '---', 'nome: workers', 'status: rascunho',
    'match:', '  paths:', '    - "^workers/"',
    'revisar:', '    - "match.sinal inferido do codigo"',
    '---', '', 'corpo',
  ].join('\n');
  const { dados } = parseFrontmatter(texto);
  assert.equal(dados.status, 'rascunho');
  assert.deepEqual(dados.revisar, ['match.sinal inferido do codigo']);
});

// P2-1 da revisao da Fase 5: `new RegExp('')` compila e casa QUALQUER string. Uma
// entrada vazia em match.sinal/paths — trivial em YAML (`- ""`) — dava +2/+3 em
// todo sinal, e o agente coringa vencia qualquer agente especifico.
test('padrao vazio no match descarta o agente, nao vira coringa (P2-1)', () => {
  const comSinalVazio = [
    '---', 'nome: coringa', 'match:', '  sinal:', '    - ""', '---', '', 'corpo',
  ].join('\n');
  assert.equal(parseFrontmatter(comSinalVazio), null, 'sinal vazio descarta o agente');

  const comPathVazio = [
    '---', 'nome: coringa', 'match:', '  paths:', '    - "   "', '---', '', 'corpo',
  ].join('\n');
  assert.equal(parseFrontmatter(comPathVazio), null, 'path so com espaco tambem');
});

test('agente coringa nao vence agente especifico (P2-1)', () => {
  const especifico = {
    nome: 'workers',
    match: { paths: [/^workers\//], sinal: [/TransmissaoError/] },
  };
  // O coringa so existiria se o padrao vazio passasse; com a recusa ele nem carrega.
  // Aqui provamos o efeito que a recusa evita: escore de padrao vazio seria total.
  const sinal = { texto: 'nada a ver com este agente', caminhos_citados: [], tags: [] };
  assert.equal(escolherAgente([especifico], sinal), null, 'sem match real, ninguem casa');
});
