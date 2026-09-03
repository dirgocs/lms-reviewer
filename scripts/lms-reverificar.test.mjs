import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aplicarReverificacao,
  parseReverificacao,
  reverificarPrompt,
} from './lms-reverificar.mjs';

const scorecard = () => ({
  reviewer: 'grok',
  score: 3,
  target: 5,
  base: 'origin/master',
  p0: 0,
  p1: 1,
  p2: 0,
  coverage: [{ surface: 'arquivos alterados', total: 3, inspected: 3 }],
  findings: [
    { id: 'aaa111', lens: 'code-safety', severity: 'P1', confidence: 90,
      path: 'src/a.ts:42', title: 'falta filtro de tenant', why: 'a query nao escopa',
      acceptance: ['a query cita tenantId'], verdict: 'CONFIRMED' },
    { id: 'bbb222', lens: 'code-quality', severity: 'P2', confidence: 85,
      path: 'src/b.ts:7', title: 'nome confuso', why: 'legibilidade', verdict: 'CONFIRMED' },
  ],
});

// Task 3 da Fase 4: re-verificacao incremental fail-closed.

test('aplicarReverificacao: closed nao altera score nem agregado nem coverage (Task 3)', () => {
  const antes = scorecard();
  const depois = aplicarReverificacao(
    antes,
    [{ id: 'aaa111', status: 'closed', why: 'o filtro foi adicionado', evidence: 'linha 43 cita tenantId' }],
    [],
  );
  assert.equal(depois.score, antes.score);
  assert.equal(depois.p1, antes.p1);
  assert.deepEqual(depois.coverage, antes.coverage);
  const achado = depois.findings.find((f) => f.id === 'aaa111');
  assert.equal(achado.reverificado, 'closed');
  // Os DEMAIS achados ficam intactos e abertos por default.
  assert.equal(depois.findings.find((f) => f.id === 'bbb222').reverificado, 'open');
});

test('aplicarReverificacao: id ausente na resposta continua open (Task 3)', () => {
  const depois = aplicarReverificacao(
    scorecard(),
    [{ id: 'aaa111', status: 'closed', why: 'x', evidence: 'y' }],
    [],
  );
  assert.equal(depois.findings.find((f) => f.id === 'bbb222').reverificado, 'open');
});

test('aplicarReverificacao: id desconhecido na resposta é ignorado (Task 3)', () => {
  const depois = aplicarReverificacao(
    scorecard(),
    [{ id: 'zzz999', status: 'closed', why: 'inventado', evidence: 'x' }],
    [],
  );
  assert.equal(depois.findings.length, 2, 'nenhum achado novo entra no scorecard');
});

test('aplicarReverificacao: closed derrubado pelo verificador volta a open (Task 3)', () => {
  const depois = aplicarReverificacao(
    scorecard(),
    [{ id: 'aaa111', status: 'closed', why: 'fechei', evidence: 'x' }],
    [{ id: 'aaa111', verdict: 'CONFIRMED' }],
  );
  assert.equal(depois.findings.find((f) => f.id === 'aaa111').reverificado, 'open');
});

test('aplicarReverificacao: closed sustentado pelo verificador permanece closed (Task 3)', () => {
  const depois = aplicarReverificacao(
    scorecard(),
    [{ id: 'aaa111', status: 'closed', why: 'fechei', evidence: 'x' }],
    [{ id: 'aaa111', verdict: 'PLAUSIBLE' }],
  );
  assert.equal(depois.findings.find((f) => f.id === 'aaa111').reverificado, 'closed');
});

test('reverificarPrompt lista ids, severidade, acceptance e o diff, e proibe re-review (Task 3)', () => {
  const achados = scorecard().findings;
  const p = reverificarPrompt(achados, 'diff --git a/src/a.ts');
  assert.match(p, /aaa111/);
  assert.match(p, /bbb222/);
  assert.match(p, /falta filtro de tenant/);
  assert.match(p, /a query cita tenantId/);
  assert.match(p, /diff --git/);
  assert.match(p, /closed|open/);
  assert.match(p, /do not re-?review|nao re-revise|ONLY/i);
});

test('parseReverificacao extrai o objeto com results e ignora o resto (Task 3)', () => {
  const bruto = 'lixo {"results":[{"id":"aaa111","status":"closed"}]} fim';
  assert.deepEqual(parseReverificacao(bruto, ''), { results: [{ id: 'aaa111', status: 'closed' }] });
  assert.equal(parseReverificacao('{"score": 5}', ''), null);
});

// Task 4 da Fase 4: wiring com o verificador da Fase 2 — fechamento so vale
// quando o verificador independente nao derruba, e NUNCA publica scorecard.
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { runReverificacao } from './lms-reverificar.mjs';

const execFile = promisify(execFileCallback);

async function repoPosFix() {
  const root = await mkdtemp(join(tmpdir(), 'lms-reverif-'));
  await execFile('git', ['init', '-q'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'lms@test'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'lms'], { cwd: root });
  await writeFile(join(root, 'a.ts'), 'const original = 1;\n');
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-qm', 'base'], { cwd: root });
  const { stdout: sha } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: root });
  await writeFile(join(root, 'a.ts'), 'const original = 2;\n'); // o fix na arvore
  await mkdir(join(root, '.lms'), { recursive: true });
  await writeFile(join(root, '.lms', 'last.json'), JSON.stringify({
    reviewer: 'grok',
    base: 'HEAD',
    score: 3,
    findings: [{ id: 'aaa111', lens: 'code-safety', severity: 'P1', confidence: 90,
      path: 'a.ts:1', title: 'falta filtro de tenant', why: 'w',
      acceptance: ['a query cita tenantId'], verdict: 'CONFIRMED', found_by: 'codex' }],
  }));
  await writeFile(join(root, '.lms', 'fixes.jsonl'), JSON.stringify({
    commit: sha, marco: sha, id: 'aaa111', provider: 'codex',
    outcome: 'fixed', arquivos: ['a.ts'], motivo: 'corrigi',
  }));
  return { root, sha };
}

test('runReverificacao fecha achado que o verificador nao derruba (Task 4)', async () => {
  const { root } = await repoPosFix();
  const chamadas = [];
  const collect = async ({ prompt }) => {
    chamadas.push(prompt);
    if (prompt.includes('DEMOLISH')) {
      // Verificador da Fase 2: nao derruba o fechamento (PLAUSIBLE nao reabre).
      return { kind: 'ok', candidate: { id: 'aaa111', verdict: 'PLAUSIBLE', why: 'nao reproduzi' } };
    }
    return {
      kind: 'ok',
      candidate: { results: [{ id: 'aaa111', status: 'closed', why: 'aceitacao passa', evidence: 'a.ts:1' }] },
    };
  };
  const r = await runReverificacao({ root, env: {}, collect });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.fechados, ['aaa111']);
  // Duas chamadas: re-verificacao + verificador independente.
  assert.equal(chamadas.filter((p) => p.includes('still OPEN')).length, 1, 're-verificacao foi chamada');
  assert.equal(chamadas.filter((p) => p.includes('DEMOLISH')).length, 1);
  const registro = JSON.parse(await readFile(join(root, '.lms', 'reverificacao.json'), 'utf8'));
  assert.equal(registro.results[0].status, 'closed');
  // NUNCA publica: o scorecard em cache fica intacto.
  const last = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
  assert.equal(last.findings[0].reverificado, undefined);
});

test('runReverificacao: closed derrubado pelo verificador volta a open (Task 4)', async () => {
  const { root } = await repoPosFix();
  const collect = async ({ prompt }) => {
    if (prompt.includes('DEMOLISH')) {
      return { kind: 'ok', candidate: { id: 'aaa111', verdict: 'CONFIRMED', why: 'o defeito segue la' } };
    }
    return { kind: 'ok', candidate: { results: [{ id: 'aaa111', status: 'closed', why: 'x', evidence: 'y' }] } };
  };
  const r = await runReverificacao({ root, env: {}, collect });
  assert.deepEqual(r.abertos, ['aaa111']);
  assert.deepEqual(r.fechados, []);
});

test('runReverificacao: LMS_VERIFY=0 recusa a re-verificacao inteira (Task 4)', async () => {
  const { root } = await repoPosFix();
  let chamou = false;
  const collect = async () => { chamou = true; return { kind: 'ok', candidate: null }; };
  const r = await runReverificacao({ root, env: { LMS_VERIFY: '0' }, collect });
  assert.equal(r.status, 'recusada');
  assert.equal(chamou, false, 'fechar sem contraditorio e o buraco');
});

test('runReverificacao: sem marco no fixes.jsonl recusa (Task 4)', async () => {
  const { root } = await repoPosFix();
  await writeFile(join(root, '.lms', 'fixes.jsonl'), JSON.stringify({ commit: 'x', outcome: 'fixed', arquivos: ['a.ts'] }));
  const r = await runReverificacao({ root, env: {}, collect: async () => ({ kind: 'ok', candidate: null }) });
  assert.equal(r.status, 'recusada');
  assert.match(r.motivo, /marco/i);
});

// P2-3 da revisao da Fase 4: runFix grava UMA linha por achado; o diff tem de
// cobrir o LOTE inteiro (marco da PRIMEIRA linha do lote) — com o marco da
// ultima, os fixes anteriores somem do diff e a rodada cheia volta a ser
// obrigatoria (o custo que a fase existe para cortar).
test('loteDeFix: marco da primeira linha e uniao de arquivos (P2-3)', async () => {
  const { loteDeFix } = await import('./lms-reverificar.mjs');
  const linhas = [
    { commit: 'h1', marco: 'sha1', id: 'a1', provider: 'codex', outcome: 'fixed', arquivos: ['a.ts'] },
    { commit: 'h2', marco: 'sha2', id: 'a2', provider: 'codex', outcome: 'claimed', arquivos: ['b.ts'] },
    { commit: 'h3', marco: 'sha3', id: 'a3', provider: 'codex', outcome: 'fixed', arquivos: ['c.ts'] },
  ];
  const lote = loteDeFix(linhas);
  assert.equal(lote.marco, 'sha1', 'o marco do lote e o da PRIMEIRA linha');
  assert.deepEqual(lote.arquivos, ['a.ts', 'b.ts', 'c.ts']);
  // Linhas ja consumidas por uma re-verificacao anterior ficam fora.
  const lote2 = loteDeFix(linhas, 2);
  assert.equal(lote2.marco, 'sha3');
  assert.deepEqual(lote2.arquivos, ['c.ts']);
});

test('loteDeFix: claimed sem arquivos, ou linha sem marco, recusa (P2-3)', async () => {
  const { loteDeFix } = await import('./lms-reverificar.mjs');
  assert.equal(loteDeFix([{ marco: 'sha1', outcome: 'claimed', arquivos: [] }]), null, 'diff sem pathspec devolveria a arvore inteira');
  assert.equal(loteDeFix([{ outcome: 'fixed', arquivos: ['a.ts'] }]), null, 'sem marco nao ha como recortar o diff');
  assert.equal(loteDeFix([{ marco: 'sha9', outcome: 'fixed', arquivos: ['a.ts'] }], 5), null, 'nada novo a re-verificar');
});

test('runReverificacao consome o lote: segunda chamada sem fix novo recusa (P2-3)', async () => {
  const { root } = await repoPosFix();
  const collect = async ({ prompt }) => {
    if (prompt.includes('DEMOLISH')) {
      return { kind: 'ok', candidate: { id: 'aaa111', verdict: 'PLAUSIBLE', why: 'nao reproduzi' } };
    }
    return { kind: 'ok', candidate: { results: [{ id: 'aaa111', status: 'closed', why: 'x', evidence: 'y' }] } };
  };
  const primeira = await runReverificacao({ root, env: {}, collect });
  assert.equal(primeira.status, 'ok');
  const registro = JSON.parse(await readFile(join(root, '.lms', 'reverificacao.json'), 'utf8'));
  assert.equal(registro.linhasConsumidas, 1);

  const segunda = await runReverificacao({ root, env: {}, collect });
  assert.equal(segunda.status, 'recusada');
  assert.match(segunda.motivo, /nenhum fix novo/i);
});

// P2-5 da revisao da Fase 4: manterJanela era codigo morto — nenhum chamador
// passava, e o bin lms-reverificar sempre rodava headless. A re-verificacao roda
// na TUI (modo padrao) com manterJanela e caminhos proprios; headless so com a
// env explícita.
test('re-verificacao usa coleta tmux com manterJanela e caminhos proprios (P2-5)', async () => {
  const { root } = await repoPosFix();
  const opcoesVistas = [];
  const collect = async (opcoes) => {
    opcoesVistas.push(opcoes);
    if (opcoes.prompt.includes('DEMOLISH')) {
      return { kind: 'ok', candidate: { id: 'aaa111', verdict: 'PLAUSIBLE', why: 'nao reproduzi' } };
    }
    return { kind: 'ok', candidate: { results: [{ id: 'aaa111', status: 'closed', why: 'x', evidence: 'y' }] } };
  };
  await runReverificacao({ root, env: {}, collect });
  const reverif = opcoesVistas.find((o) => o.prompt.includes('still OPEN'));
  assert.equal(reverif.manterJanela, true);
  assert.match(reverif.promptPath, /reverificar-prompt\.md$/);
  assert.match(reverif.outPath, /reverificar\.json$/);
});

test('coletaDaReverificacao respeita LMS_REVIEWER_MODE (P2-5)', async () => {
  const { coletaDaReverificacao } = await import('./lms-reverificar.mjs');
  const { collectHeadless } = await import('./lms-reviewer-fallback.mjs');
  const { collectTmux } = await import('./lms-reviewer-tmux.mjs');
  assert.equal(coletaDaReverificacao({}), collectTmux, 'tmux e o modo padrao de producao');
  assert.equal(coletaDaReverificacao({ LMS_REVIEWER_MODE: 'headless' }), collectHeadless);
  assert.equal(coletaDaReverificacao({ LMS_REVIEWER_MODE: 'tmux' }), collectTmux);
});
