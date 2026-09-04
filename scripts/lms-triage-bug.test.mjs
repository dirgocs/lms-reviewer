import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { resetConfigCache } from './lms-config.mjs';
import { lerPrecedentes } from './lms-precedentes.mjs';
import { runTriageBug } from './lms-triage-bug.mjs';
import {
  achadoDoSinal,
  caminhosDoSinal,
  normalizarSinal,
  parseTriagem,
  triagemPrompt,
} from './lms-triage-bug.mjs';

const execFile = promisify(execFileCallback);

const sinal = {
  texto: 'cStat 656 em services/fiscal/backend/app/services/x.py:120\nHTTP 500',
  origem: 'stdin',
  tags: ['http-500'],
  caminhos_citados: ['services/fiscal/backend/app/services/x.py'],
};

const agente = {
  nome: 'fiscal-sefaz',
  escalar_para: 'orchestrator',
  corpo: '## Como triar\nO caminho util e transitions.py.',
  fontes_de_verdade: ['services/fiscal/AGENTS.md'],
  verificar_antes_de_abrir_issue: ['cStat 656 e bloqueio de 1h'],
};

// Task 3 da Fase 5: o sinal de runtime vira um achado do contrato do scorecard.

test('normalizarSinal: tags so de padroes agnosticos (Task 3)', () => {
  const r = normalizarSinal('HTTP 500 no worker\nTraceback (most recent call last)\nSEFAZ rejeitou', 'stdin');
  assert.ok(r.tags.includes('http-500'));
  assert.ok(r.tags.includes('traceback'));
  assert.equal(r.tags.includes('sefaz'), false, 'vocabulario de dominio nunca vira tag');
  assert.equal(r.origem, 'stdin');
});

test('caminhosDoSinal: so o que existe no disco (Task 3)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-triage-'));
  await mkdir(join(root, 'services/api/src'), { recursive: true });
  await writeFile(join(root, 'services/api/src/x.py'), 'linha1\nlinha2\n');
  const caminhos = await caminhosDoSinal(
    'at services/api/src/x.py:2 e services/api/src/inexistente.py:9 e ghost.py:1',
    root,
  );
  assert.deepEqual(caminhos, ['services/api/src/x.py']);
  await rm(root, { recursive: true, force: true });
});

test('triagemPrompt traz contexto do agente, precedentes e proibe path inventado (Task 3)', () => {
  const p = triagemPrompt(sinal, agente, ['- **cStat 999** — precedentes anteriores']);
  assert.match(p, /Como triar/);
  assert.match(p, /cStat 999/);
  assert.match(p, /caminho/i);
  assert.match(p, /HTTP 500/);
});

test('parseTriagem extrai um JSON com forma de achado (Task 3)', () => {
  const bruto = 'lixo {"lens":"code-safety","path":"x.py:1","title":"t","why":"w"} fim';
  assert.equal(parseTriagem(bruto, '').title, 't');
  assert.equal(parseTriagem('{"score": 5}', ''), null);
});

test('achadoDoSinal: passa findingsShapeError e id bate findingId (Task 3)', async () => {
  const { findingsShapeError, findingId } = await import('./lms-scorecard.mjs');
  const parsed = {
    path: 'services/fiscal/backend/app/services/x.py:120',
    title: 'emissao sem filtro de tenant',
    why: 'a query nao escopa por tenant',
    fix: 'somar tenantId ao where',
  };
  const achado = achadoDoSinal(parsed, sinal, agente, 'grok');
  assert.equal(findingsShapeError({ findings: [achado] }), null);
  assert.equal(achado.id, findingId(achado));
  assert.equal(achado.origem.tipo, 'runtime');
  assert.equal(achado.origem.agente, 'fiscal-sefaz');
  assert.match(achado.origem.sinal, /^sha256:/);
  assert.equal(achado.found_by, 'grok');
  assert.equal(achado.lens, 'code-safety');
  assert.equal(achado.confidence, 70);
});

test('achadoDoSinal: path sem linha ou inexistente no disco e recusado (Task 3)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-triage-'));
  assert.throws(
    () => achadoDoSinal({ path: 'x.py', title: 't', why: 'w' }, sinal, agente, 'grok'),
    /linha/i,
  );
  await rm(root, { recursive: true, force: true });
});

async function repoComSinal() {
  const root = await mkdtemp(join(tmpdir(), 'lms-triage-run-'));
  await execFile('git', ['init', '-q'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'lms@test'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'lms'], { cwd: root });
  await mkdir(join(root, 'workers'), { recursive: true });
  await writeFile(join(root, 'workers', 'x.py'), 'linha1\nlinha2\nlinha3\n');
  await writeFile(join(root, 'sinal.log'), 'HTTP 500 em workers/x.py:2\ncStat 656\n');
  const dir = join(root, '.agents', 'bug-triage');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'workers.md'),
    '---\nnome: workers\ndescricao: workers\nmatch:\n  paths:\n    - "^workers/"\n---\n\nTriar workers.\n',
  );
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-qm', 'repo com agente commitado'], { cwd: root });
  return root;
}

// Task 4 da Fase 5: o achado da triagem passa SEMPRE pelo verificador da Fase 2
// (LMS_VERIFY=0 recusa a triagem inteira) e grava .lms/bug-<id>.json. Nenhum
// veredito novo: CONFIRMED = verificado; PLAUSIBLE = backlog (nunca some).
test('runTriageBug: sinal vira achado verificado e gravado (Task 4)', async () => {
  const root = await repoComSinal();
  const collect = async ({ prompt }) => {
    if (prompt.includes('DEMOLISH')) {
      // Verificador real ecoa o id do achado (fail-closed da Fase 3: id divergente
      // conta como CONFIRMED).
      const id = (prompt.match(/"id": "([^"]+)"/) ?? [])[1] ?? '???';
      return { kind: 'ok', candidate: { id, verdict: 'PLAUSIBLE', why: 'nao reproduzi' } };
    }
    return {
      kind: 'ok',
      candidate: { path: 'workers/x.py:2', lens: 'code-safety', title: 'quebra no worker', why: 'o stack cita workers/x.py:2', fix: 'corrigir o loop' },
    };
  };
  const r = await runTriageBug({ root, env: {}, collect, argv: [join(root, 'sinal.log')] });
  assert.equal(r.achado.path, 'workers/x.py:2');
  assert.equal(r.outcome, 'backlog', 'PLAUSIBLE vira backlog e nao some');
  assert.equal(r.verificador, true, 'passou pelo verificador');
  const gravado = JSON.parse(await readFile(join(root, '.lms', `bug-${r.achado.id}.json`), 'utf8'));
  assert.equal(gravado.outcome, 'backlog');
  assert.equal(gravado.achado.id, r.achado.id);
});

test('runTriageBug: LMS_VERIFY=0 recusa a triagem inteira (Task 4)', async () => {
  const root = await repoComSinal();
  let chamou = false;
  const collect = async () => { chamou = true; return { kind: 'ok', candidate: null }; };
  const r = await runTriageBug({ root, env: { LMS_VERIFY: '0' }, collect, argv: [join(root, 'sinal.log')] });
  assert.equal(r.exitCode, 1);
  assert.equal(chamou, false, 'abrir issue sem contraditorio e o buraco');
});

test('runTriageBug: sinal vazio recusa com exit 2 (Task 4)', async () => {
  const root = await repoComSinal();
  await writeFile(join(root, 'sinal.log'), '');
  const r = await runTriageBug({ root, env: {}, collect: async () => ({ kind: 'ok', candidate: null }), argv: [join(root, 'sinal.log')] });
  assert.equal(r.exitCode, 2);
  assert.match(r.motivo, /caminho|agente|sinal/i);
});

// Task 5 da Fase 5: --init dispara o bootstrap; o auto-init so acontece com o
// diretorio vazio/ausente — diretorio com agente que NAO casou nunca gera arquivo.
test('runTriageBug: --init roda o bootstrap e nao tria (Task 5)', async () => {
  const root = await repoComSinal();
  let triou = false;
  const r = await runTriageBug({
    root,
    env: {},
    collect: async () => { triou = true; return { kind: 'ok', candidate: null }; },
    argv: ['--init'],
    pergunta: async () => 'y',
  });
  assert.equal(r.exitCode, 0);
  assert.equal(triou, false, '--init nao tria sinal nenhum');
  // P1-2: o fixture ja tem `workers.md` commitado, entao a proposta homonima e
  // PULADA em vez de regravada — `--init` nunca apaga o que o consumidor escreveu.
  assert.ok(r.bootstrap.pulados.includes('workers.md'), 'agente existente e pulado, nao sobrescrito');
  assert.equal(r.bootstrap.escritos, 0);
});

test('runTriageBug: auto-init com diretorio ausente propoe agentes (Task 5)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-triage-auto-'));
  await execFile('git', ['init', '-q'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'lms@test'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'lms'], { cwd: root });
  await mkdir(join(root, 'workers'), { recursive: true });
  await writeFile(join(root, 'workers', 'fila.py'), 'linha1\n');
  await writeFile(join(root, 'sinal.log'), 'HTTP 500 sem caminho citado\n');
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-qm', 'fix: repo sem agentes'], { cwd: root });

  const r = await runTriageBug({
    root,
    env: {},
    collect: async () => ({ kind: 'ok', candidate: null }),
    argv: [join(root, 'sinal.log')],
    pergunta: async () => 'y',
  });
  assert.equal(r.exitCode, 2, 'a triagem falhou; o bootstrap so ajuda a sair do zero');
  assert.ok(r.bootstrap?.escritos >= 1, 'diretorio ausente dispara o auto-init');
  await rm(root, { recursive: true, force: true });
});

test('runTriageBug: agente que nao casou NAO dispara auto-init (Task 5)', async () => {
  const root = await repoComSinal();
  await writeFile(join(root, 'sinal.log'), 'HTTP 500 sem caminho citado nem match\n');
  const r = await runTriageBug({
    root,
    env: {},
    collect: async () => ({ kind: 'ok', candidate: null }),
    argv: [join(root, 'sinal.log')],
    pergunta: async () => 'y',
  });
  assert.equal(r.exitCode, 2);
  assert.equal(r.bootstrap, undefined, 'nenhum agente cobre o sinal != gerar arquivos');
  await rm(root, { recursive: true, force: true });
});

// Spec §3.1: a entrada e caminho de arquivo OU stdin (`kubectl logs … | lms-triage-bug`).
// Os dois caminhos precisam dar o MESMO achado — a origem muda, o achado nao.
test('runTriageBug: stdin e arquivo dao o mesmo achado (Task 4)', async () => {
  const texto = 'HTTP 500 em workers/x.py:2\ncStat 656\n';
  const collect = async ({ prompt }) => {
    if (prompt.includes('DEMOLISH')) {
      const id = (prompt.match(/"id": "([^"]+)"/) ?? [])[1] ?? '???';
      return { kind: 'ok', candidate: { id, verdict: 'CONFIRMED', why: 'reproduzi' } };
    }
    return {
      kind: 'ok',
      candidate: { path: 'workers/x.py:2', lens: 'code-safety', title: 'quebra no worker', why: 'o stack cita workers/x.py:2', fix: 'corrigir o loop' },
    };
  };

  const rootArquivo = await repoComSinal();
  const doArquivo = await runTriageBug({
    root: rootArquivo, env: {}, collect, argv: [join(rootArquivo, 'sinal.log')],
  });

  const rootStdin = await repoComSinal();
  const doStdin = await runTriageBug({
    root: rootStdin, env: {}, collect, argv: [], stdin: async () => texto,
  });

  assert.equal(doStdin.exitCode, 0, 'stdin e entrada valida');
  assert.equal(doStdin.achado.id, doArquivo.achado.id, 'mesmo sinal, mesmo achado');
  assert.equal(doStdin.achado.origem.sinal, doArquivo.achado.origem.sinal, 'mesmo hash do sinal');
  assert.match(doStdin.achado.path, /workers\/x\.py:2/);
  await rm(rootArquivo, { recursive: true, force: true });
  await rm(rootStdin, { recursive: true, force: true });
});

// Task 6 da Fase 5: um passo novo ANTES da regra da Fase 3 — o `escalar_para` do
// agente casado vence quando declarado; sem ele, corrigivelPeloRevisor decide.
async function repoComAgente({ escalarPara, tracker } = {}) {
  const root = await repoComSinal();
  await writeFile(
    join(root, '.agents', 'bug-triage', 'workers.md'),
    [
      '---', 'nome: workers', 'descricao: workers', 'match:', '  paths:', '    - "^workers/"',
      ...(escalarPara ? [`escalar_para: ${escalarPara}`] : []),
      '---', '', 'Triar workers.', '',
    ].join('\n'),
  );
  if (tracker) {
    await writeFile(
      join(root, 'lms.config.json'),
      JSON.stringify({ bugAgents: { tracker } }, null, 2),
    );
  }
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-q', '--allow-empty', '-m', 'agente atualizado'], { cwd: root });
  resetConfigCache();
  return root;
}

const collectConfirmado = async ({ prompt }) => {
  if (prompt.includes('DEMOLISH')) {
    const id = (prompt.match(/"id": "([^"]+)"/) ?? [])[1] ?? '???';
    return { kind: 'ok', candidate: { id, verdict: 'CONFIRMED', why: 'reproduzi' } };
  }
  return {
    kind: 'ok',
    candidate: { path: 'workers/x.py:2', lens: 'code-safety', title: 'quebra no worker', why: 'o stack cita workers/x.py:2', fix: 'corrigir o loop' },
  };
};

test('rota: escalar_para do agente vence a regra da Fase 3 (Task 6)', async () => {
  const root = await repoComAgente({ escalarPara: 'orchestrator-fiscal' });
  const r = await runTriageBug({ root, env: {}, collect: collectConfirmado, argv: [join(root, 'sinal.log')] });
  assert.equal(r.rota, 'orchestrator-fiscal');
  await rm(root, { recursive: true, force: true });
});

test('rota: sem escalar_para, a Fase 3 decide (Task 6)', async () => {
  const root = await repoComAgente();
  const r = await runTriageBug({ root, env: {}, collect: collectConfirmado, argv: [join(root, 'sinal.log')] });
  assert.ok(['revisor', 'orquestrador'].includes(r.rota), 'rota vem de corrigivelPeloRevisor');
  await rm(root, { recursive: true, force: true });
});

test('tracker configurado abre issue; falha do tracker nao derruba a triagem (Task 6)', async () => {
  const root = await repoComAgente({ tracker: 'github' });
  const r = await runTriageBug({
    root, env: {}, collect: collectConfirmado, argv: [join(root, 'sinal.log')],
    exec: async () => ({ stdout: 'https://github.com/o/r/issues/9\n', stderr: '', code: 0 }),
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.issue.aberta, true);
  assert.equal(r.issue.url, 'https://github.com/o/r/issues/9');
  const gravado = JSON.parse(await readFile(join(root, '.lms', `bug-${r.achado.id}.json`), 'utf8'));
  assert.equal(gravado.issue.url, 'https://github.com/o/r/issues/9');
  await rm(root, { recursive: true, force: true });
});

test('tracker que falha avisa e segue — o achado fica gravado (Task 6)', async () => {
  const root = await repoComAgente({ tracker: 'github' });
  const r = await runTriageBug({
    root, env: {}, collect: collectConfirmado, argv: [join(root, 'sinal.log')],
    exec: async () => { const e = new Error('spawn gh ENOENT'); e.code = 'ENOENT'; throw e; },
  });
  assert.equal(r.exitCode, 0, 'falha de ferramenta nunca decide');
  assert.equal(r.issue.aberta, false);
  const gravado = JSON.parse(await readFile(join(root, '.lms', `bug-${r.achado.id}.json`), 'utf8'));
  assert.equal(gravado.achado.id, r.achado.id, 'o achado fica em .lms mesmo sem issue');
  await rm(root, { recursive: true, force: true });
});

// Task 7 da Fase 5: triagem errada vira precedente DAQUELE agente, em
// .lms/precedentes-bug/<agente>.md — nunca no corpus global do diff.
const collectDerrubado = async ({ prompt }) => {
  if (prompt.includes('DEMOLISH')) {
    const id = (prompt.match(/"id": "([^"]+)"/) ?? [])[1] ?? '???';
    return { kind: 'ok', candidate: { id, verdict: 'PLAUSIBLE', why: 'nao reproduzi o 500 com o payload' } };
  }
  return {
    kind: 'ok',
    candidate: { path: 'workers/x.py:2', lens: 'code-safety', title: 'quebra no worker', why: 'o stack cita workers/x.py:2', fix: 'corrigir o loop' },
  };
};

test('triagem derrubada registra precedente do agente, nao no global (Task 7)', async () => {
  const root = await repoComAgente();
  const r = await runTriageBug({ root, env: {}, collect: collectDerrubado, argv: [join(root, 'sinal.log')] });
  assert.equal(r.outcome, 'backlog');

  const doAgente = await lerPrecedentes(root, { relativo: '.lms/precedentes-bug/workers.md' });
  assert.equal(doAgente.length, 1, 'a triagem derrubada virou precedente do agente');
  assert.match(doAgente[0], /quebra no worker/);
  assert.deepEqual(await lerPrecedentes(root), [], 'o corpus global do diff segue intacto');
  await rm(root, { recursive: true, force: true });
});

test('triagem confirmada NAO vira precedente (Task 7)', async () => {
  const root = await repoComAgente();
  const r = await runTriageBug({ root, env: {}, collect: collectConfirmado, argv: [join(root, 'sinal.log')] });
  assert.equal(r.outcome, 'verificado');
  assert.deepEqual(
    await lerPrecedentes(root, { relativo: '.lms/precedentes-bug/workers.md' }),
    [],
    'so triagem errada vira memoria',
  );
  await rm(root, { recursive: true, force: true });
});

test('a proxima triagem do mesmo agente le os precedentes dele (Task 7)', async () => {
  const root = await repoComAgente();
  await runTriageBug({ root, env: {}, collect: collectDerrubado, argv: [join(root, 'sinal.log')] });

  let promptDaTriagem = '';
  const collectEspiao = async (args) => {
    if (!args.prompt.includes('DEMOLISH')) promptDaTriagem = args.prompt;
    return collectDerrubado(args);
  };
  await runTriageBug({ root, env: {}, collect: collectEspiao, argv: [join(root, 'sinal.log')] });
  assert.match(promptDaTriagem, /PRECEDENTES deste agente/);
  assert.match(promptDaTriagem, /quebra no worker/);
  await rm(root, { recursive: true, force: true });
});

// Ajuste 2 (ordem do Master): o runner RECUSA executar agente em rascunho, com
// mensagem dizendo o que preencher. Rascunho nao dispara auto-init: o agente
// existe, so nao esta pronto — gerar arquivos por cima seria a resposta errada.
test('runTriageBug recusa agente em rascunho dizendo o que preencher (Ajuste 2)', async () => {
  const root = await repoComSinal();
  await writeFile(
    join(root, '.agents', 'bug-triage', 'workers.md'),
    [
      '---', 'nome: workers', 'descricao: workers', 'status: rascunho',
      'match:', '  paths:', '    - "^workers/"',
      '---', '', 'Triar workers.', '',
    ].join('\n'),
  );
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-q', '--allow-empty', '-m', 'agente em rascunho'], { cwd: root });
  resetConfigCache();

  let chamou = false;
  const r = await runTriageBug({
    root, env: {},
    collect: async () => { chamou = true; return { kind: 'ok', candidate: null }; },
    argv: [join(root, 'sinal.log')],
  });
  assert.equal(r.exitCode, 1, 'rascunho recusa, nao tria');
  assert.equal(chamou, false, 'nenhum provider e invocado');
  assert.match(r.motivo, /rascunho/i);
  assert.match(r.motivo, /verificar_antes_de_abrir_issue/, 'a mensagem diz o que preencher');
  assert.match(r.motivo, /status/, 'e diz como ativar');
  assert.equal(r.bootstrap, undefined, 'agente em rascunho nao dispara bootstrap');
  await rm(root, { recursive: true, force: true });
});

test('agente commitado e preenchido roda normalmente (Ajuste 2)', async () => {
  const root = await repoComSinal();
  await writeFile(
    join(root, '.agents', 'bug-triage', 'workers.md'),
    [
      '---', 'nome: workers', 'descricao: workers', 'status: ativo',
      'match:', '  paths:', '    - "^workers/"',
      'verificar_antes_de_abrir_issue:', '    - "conferir a fila antes de culpar a rota"',
      '---', '', 'Triar workers.', '',
    ].join('\n'),
  );
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-q', '--allow-empty', '-m', 'agente ativo'], { cwd: root });
  resetConfigCache();

  const r = await runTriageBug({ root, env: {}, collect: collectConfirmado, argv: [join(root, 'sinal.log')] });
  assert.equal(r.exitCode, 0);
  assert.equal(r.outcome, 'verificado');
  await rm(root, { recursive: true, force: true });
});

// P2-4 (irmao) da revisao da Fase 5: a spec §3.1 promete "linha inexistente e
// recusada antes de sair", mas nada conferia a linha no disco — `citationsDiskError`
// exige que a QUOTE case o arquivo, e a quote da triagem vem do log, nunca do
// codigo. O achado inventado passava e virava issue.
test('path inventado pelo modelo e recusado antes de virar achado (P2-4)', async () => {
  const root = await repoComSinal();
  const r = await runTriageBug({
    root, env: {},
    collect: async () => ({
      kind: 'ok',
      candidate: { path: 'servico/inexistente.py:12', lens: 'code-safety', title: 't', why: 'inventado' },
    }),
    argv: [join(root, 'sinal.log')],
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.motivo, /não existe no disco/);
  await rm(root, { recursive: true, force: true });
});

test('linha alem do fim do arquivo e recusada (P2-4)', async () => {
  const root = await repoComSinal();
  const r = await runTriageBug({
    root, env: {},
    collect: async () => ({
      kind: 'ok',
      candidate: { path: 'workers/x.py:999', lens: 'code-safety', title: 't', why: 'linha que nao existe' },
    }),
    argv: [join(root, 'sinal.log')],
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.motivo, /linha 999 não existe/);
  await rm(root, { recursive: true, force: true });
});

// P3-3 da revisao da Fase 5: `..` no caminho citado saia da raiz e ainda entrava
// como "conferido no disco".
test('path com .. fora da raiz e recusado (P3-3)', async () => {
  const root = await repoComSinal();
  const r = await runTriageBug({
    root, env: {},
    collect: async () => ({
      kind: 'ok',
      candidate: { path: '../outro-repo/x.py:1', lens: 'code-safety', title: 't', why: 'fora da raiz' },
    }),
    argv: [join(root, 'sinal.log')],
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.motivo, /fora da raiz/);
  await rm(root, { recursive: true, force: true });
});

test('caminhosDoSinal ignora caminho que sai da raiz (P3-3)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-raiz-'));
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(join(root, 'app', 'ok.py'), 'linha1\n');
  const caminhos = await caminhosDoSinal(
    'erro em app/ok.py:1 e em ../../etc/passwd.py:1\n',
    root,
  );
  assert.deepEqual(caminhos, ['app/ok.py'], 'so o que esta sob a raiz e conferido');
  await rm(root, { recursive: true, force: true });
});

// P3-1 da revisao da Fase 5: `achadoDoSinal` LANCA (path sem linha, forma
// invalida) e o runner nao capturava. O main() morria com rejeicao nao tratada:
// fail-closed no codigo de saida, mas sem a linha `recusada — ...` que todos os
// outros desfechos tem.
test('relato que nao vira achado recusa com motivo, nao com excecao (P3-1)', async () => {
  const root = await repoComSinal();
  const r = await runTriageBug({
    root, env: {},
    // `why` presente (passa o parse) mas path sem `:linha`: achadoDoSinal lanca.
    collect: async () => ({
      kind: 'ok',
      candidate: { path: 'workers/x.py', lens: 'code-safety', title: 't', why: 'sem linha nenhuma' },
    }),
    argv: [join(root, 'sinal.log')],
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.motivo, /linha/i, 'o motivo nomeia o que faltou');
  await rm(root, { recursive: true, force: true });
});
