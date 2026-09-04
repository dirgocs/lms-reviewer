import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { TRACKERS, corpoDaIssue, tituloDaIssue, abrirIssue } from './lms-tracker.mjs';

const achado = {
  id: 'abc123',
  lens: 'code-safety',
  severity: 'P1',
  confidence: 70,
  path: 'workers/x.py:2',
  title: 'worker quebra   no retry',
  why: 'o stack cita workers/x.py:2\ne o retry nao tem teto',
  fix: 'poe teto no retry',
  origem: { tipo: 'runtime', sinal: 'sha256:deadbeef', agente: 'workers' },
  found_by: 'grok',
};

const agente = { nome: 'workers', escalar_para: 'orchestrator' };

test('TRACKERS e a allowlist fechada da config (Task 6)', () => {
  assert.deepEqual([...TRACKERS], ['none', 'github', 'linear']);
});

test('corpoDaIssue traz o achado e o agente; titulo e uma linha so (Task 6)', () => {
  const corpo = corpoDaIssue(achado, agente);
  assert.match(corpo, /workers\/x\.py:2/);
  assert.match(corpo, /poe teto no retry/);
  assert.match(corpo, /sha256:deadbeef/);
  assert.match(corpo, /workers/);

  const titulo = tituloDaIssue(achado);
  assert.equal(titulo.includes('\n'), false, 'titulo nunca tem quebra de linha');
  assert.match(titulo, /worker quebra no retry/, 'whitespace colapsado como em registrarPrecedente');
});

test('none: nao chama binario nenhum, o achado fica em .lms (Task 6)', async () => {
  let chamou = false;
  const r = await abrirIssue('none', achado, {
    env: {},
    exec: async () => { chamou = true; return { stdout: '', stderr: '', code: 0 }; },
  });
  assert.equal(chamou, false);
  assert.equal(r.aberta, false);
  assert.equal(r.tracker, 'none');
});

test('github monta gh issue create com body por arquivo (Task 6)', async () => {
  const chamadas = [];
  const r = await abrirIssue('github', achado, {
    env: {},
    exec: async (cmd, args) => {
      chamadas.push({ cmd, args });
      return { stdout: 'https://github.com/o/r/issues/7\n', stderr: '', code: 0 };
    },
  });
  assert.equal(r.aberta, true);
  assert.equal(r.url, 'https://github.com/o/r/issues/7');
  const [chamada] = chamadas;
  assert.equal(chamada.cmd, 'gh');
  assert.deepEqual(chamada.args.slice(0, 3), ['issue', 'create', '--title']);
  assert.ok(chamada.args.includes('--label'));
  assert.ok(chamada.args.includes('lms-bug'));

  // O corpo vai por ARQUIVO: texto multilinha de modelo nunca entra em argv.
  const iBody = chamada.args.indexOf('--body-file');
  assert.notEqual(iBody, -1, 'body vai por arquivo');
  const corpoGravado = await readFile(chamada.args[iBody + 1], 'utf8');
  assert.match(corpoGravado, /o stack cita/);
  for (const arg of chamada.args) {
    assert.equal(String(arg).includes('\n'), false, 'nenhum argumento carrega quebra de linha');
  }
});

test('github ausente avisa e segue — falha de ferramenta nunca decide (Task 6)', async () => {
  const r = await abrirIssue('github', achado, {
    env: {},
    exec: async () => { const e = new Error('spawn gh ENOENT'); e.code = 'ENOENT'; throw e; },
  });
  assert.equal(r.aberta, false);
  assert.match(r.motivo, /gh|ENOENT/i);
});

test('linear sem LINEAR_API_KEY avisa e segue (Task 6)', async () => {
  let chamou = false;
  const r = await abrirIssue('linear', achado, {
    env: {},
    exec: async () => { chamou = true; return { stdout: '', stderr: '', code: 0 }; },
  });
  assert.equal(chamou, false, 'sem token nem tenta a rede');
  assert.equal(r.aberta, false);
  assert.match(r.motivo, /LINEAR_API_KEY/);
});

test('linear: payload por arquivo e token fora de argv (Task 6)', async () => {
  const chamadas = [];
  const r = await abrirIssue('linear', achado, {
    env: { LINEAR_API_KEY: 'lin_api_segredo', LINEAR_TEAM_ID: 'time-1' },
    exec: async (cmd, args) => {
      chamadas.push({ cmd, args });
      return {
        stdout: `${JSON.stringify({ data: { issueCreate: { issue: { url: 'https://linear.app/x/issue/A-1' } } } })}\n200`,
        stderr: '',
        code: 0,
      };
    },
  });
  assert.equal(r.aberta, true);
  assert.equal(r.url, 'https://linear.app/x/issue/A-1');
  const [chamada] = chamadas;
  assert.equal(chamada.cmd, 'curl');
  const argv = chamada.args.join(' ');
  assert.equal(argv.includes('lin_api_segredo'), false, 'token nunca em argv (vai por arquivo)');
  for (const arg of chamada.args) {
    assert.equal(String(arg).includes('\n'), false, 'texto do modelo nao vaza para o comando');
  }
  const iPayload = chamada.args.indexOf('--data-binary');
  assert.notEqual(iPayload, -1, 'payload GraphQL vai por arquivo');
  const payload = String(chamada.args[iPayload + 1]);
  assert.ok(payload.startsWith('@'), 'curl le o payload do arquivo, nao de argv');
  const json = JSON.parse(await readFile(payload.slice(1), 'utf8'));
  assert.match(json.query, /issueCreate/);
  assert.equal(json.variables.input.teamId, 'time-1');
});

test('linear com HTTP 500 avisa e segue (Task 6)', async () => {
  const r = await abrirIssue('linear', achado, {
    env: { LINEAR_API_KEY: 'lin_api_segredo', LINEAR_TEAM_ID: 'time-1' },
    exec: async () => ({ stdout: 'erro interno\n500', stderr: '', code: 0 }),
  });
  assert.equal(r.aberta, false);
  assert.match(r.motivo, /500/);
});

test('tracker desconhecido cai em none em vez de rodar comando (Task 6)', async () => {
  let chamou = false;
  const r = await abrirIssue('jira', achado, {
    env: {},
    exec: async () => { chamou = true; return { stdout: '', stderr: '', code: 0 }; },
  });
  assert.equal(chamou, false);
  assert.equal(r.aberta, false);
});

// Ajuste 3 (ordem do Master): `teamId` pode vir da config; o env VENCE. Token
// nunca: `LINEAR_API_KEY` continua so em env, porque config e versionada.
test('linear: teamId da config e usado quando o env nao traz (Ajuste 3)', async () => {
  const chamadas = [];
  const r = await abrirIssue('linear', achado, {
    env: { LINEAR_API_KEY: 'lin_api_segredo' },
    opcoes: { teamId: 'time-da-config' },
    exec: async (cmd, args) => {
      chamadas.push({ cmd, args });
      return {
        stdout: `${JSON.stringify({ data: { issueCreate: { issue: { url: 'https://linear.app/x/issue/A-2' } } } })}\n200`,
        stderr: '',
        code: 0,
      };
    },
  });
  assert.equal(r.aberta, true);
  const iPayload = chamadas[0].args.indexOf('--data-binary');
  const json = JSON.parse(await readFile(String(chamadas[0].args[iPayload + 1]).slice(1), 'utf8'));
  assert.equal(json.variables.input.teamId, 'time-da-config');
});

test('linear: LINEAR_TEAM_ID do env vence a config (Ajuste 3)', async () => {
  const chamadas = [];
  await abrirIssue('linear', achado, {
    env: { LINEAR_API_KEY: 'lin_api_segredo', LINEAR_TEAM_ID: 'time-do-env' },
    opcoes: { teamId: 'time-da-config' },
    exec: async (cmd, args) => {
      chamadas.push({ cmd, args });
      return {
        stdout: `${JSON.stringify({ data: { issueCreate: { issue: { url: 'https://linear.app/x/issue/A-3' } } } })}\n200`,
        stderr: '',
        code: 0,
      };
    },
  });
  const iPayload = chamadas[0].args.indexOf('--data-binary');
  const json = JSON.parse(await readFile(String(chamadas[0].args[iPayload + 1]).slice(1), 'utf8'));
  assert.equal(json.variables.input.teamId, 'time-do-env');
});

test('linear sem teamId em lugar nenhum avisa e segue (Ajuste 3)', async () => {
  let chamou = false;
  const r = await abrirIssue('linear', achado, {
    env: { LINEAR_API_KEY: 'lin_api_segredo' },
    opcoes: {},
    exec: async () => { chamou = true; return { stdout: '', stderr: '', code: 0 }; },
  });
  assert.equal(chamou, false);
  assert.equal(r.aberta, false);
  assert.match(r.motivo, /teamId|LINEAR_TEAM_ID/);
});
