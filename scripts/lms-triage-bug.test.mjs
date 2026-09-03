import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

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
