import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { escreverArquivosCitados, coberturaFixture, verificacaoFixture } from './lms-test-fixtures.mjs';
import { join } from 'node:path';

import {
  attemptProvider,
  commandFor,
  providerConfig,
  reportarDesfecho,
  retryPrompt,
  runFallback,
  verificarProva,
} from './lms-reviewer-fallback.mjs';
import { findingId } from './lms-scorecard.mjs';

const base = 'origin/master';

const fakeProvider = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

const provider = process.env.LMS_REVIEWER_PROVIDER;
const mode = process.env['FAKE_' + provider.toUpperCase() + '_MODE'] || 'valid';
appendFileSync(process.env.FAKE_CALL_LOG, provider + '\\n');

if (mode === 'exit') process.exit(17);
if (mode === 'timeout') await new Promise(() => {});
// O prompt chega por stdin (claude, grok) OU como argumento (codex, cujo \`exec\`
// ignora stdin sem \`-\`). O fake precisa olhar os dois, senao o contraditorio no
// codex nunca reconhece que esta sendo chamado para refutar.
// Leitura SINCRONA do fd 0: com listeners assincronos ha corrida — se o stdin ja
// terminou antes de o 'end' ser registrado, a promessa nunca resolve e o fake trava
// ate o timeout. readFileSync nao tem esse buraco.
let doStdin = '';
try { doStdin = readFileSync(0, 'utf8'); } catch {}
const prompt = doStdin || process.argv.slice(2).join(' ');

const provaDeLeitura = [
  { path: 'a.ts', line: 1, quote: 'export const alpha = 1; // linha citada' },
  { path: 'b.ts', line: 1, quote: 'export const bravo = 2; // linha citada' },
  { path: 'c.ts', line: 1, quote: 'export const charlie = 3; // linha citada' },
];

// O prompt do contraditorio pede para DERRUBAR o 5/5. O fake responde o que um
// refutador honesto responde por padrao: olhei, provo que li, e nao achei defeito.
// Regra por prefixo em vez de lista: cada modo novo de refutacao ja entrou aqui
// esquecido duas vezes, e o sintoma era o fake responder 'nao achei defeito'.
if (prompt.includes('DERRUBAR') && !mode.startsWith('refute')) {
  console.log(JSON.stringify({ refuted: false, confidence: 0, inspected: provaDeLeitura }));
  process.exit(0);
}

// Refutador que alega defeito E indica como prova-lo. O runner roda o comando: se o
// resultado nao bater com o esperado, a refutacao cai.
if (prompt.includes('DERRUBAR') && mode === 'refute-com-prova') {
  console.log(JSON.stringify({
    refuted: true, confidence: 95, severity: 'P1', lens: 'code-quality',
    path: 'a.ts:1', title: 'alegacao que se prova sozinha', why: 'a suite quebra',
    inspected: provaDeLeitura,
    proof: { command: 'node scripts/prova.mjs', expect: 'fail' },
  }));
  process.exit(0);
}

// Refutador que alega defeito sem apontar nenhum: prova de leitura valida, mas
// nem path, nem title, nem why.
if (prompt.includes('DERRUBAR') && mode === 'refute-vazio') {
  console.log(JSON.stringify({ refuted: true, confidence: 90, inspected: provaDeLeitura }));
  process.exit(0);
}

// Refutador que nao abriu arquivo nenhum: veredito seco, sem prova.
if (prompt.includes('DERRUBAR') && mode === 'refute-sem-prova') {
  console.log(JSON.stringify({ refuted: false, confidence: 0 }));
  process.exit(0);
}

// Refutador que achou defeito real mas o payload veio sem um campo OBRIGATORIO
// (severity). O achado nao pode ser descartado em silencio (KDT-94).
if (prompt.includes('DERRUBAR') && mode === 'refute-incompleto') {
  console.log(JSON.stringify({
    refuted: true, confidence: 95,
    path: 'a.ts:1', why: 'furo de autorizacao real, com prova de leitura',
    inspected: provaDeLeitura,
  }));
  process.exit(0);
}

// Refutador que mandou so o essencial: sem fix, title, confidence e lens. Campo
// secundario ausente nao pode destruir o achado (KDT-94).
if (prompt.includes('DERRUBAR') && mode === 'refute-so-essencial') {
  console.log(JSON.stringify({
    refuted: true, severity: 'P1',
    path: 'a.ts:1', why: 'caso de borda ignorado na logica nova',
    inspected: provaDeLeitura,
  }));
  process.exit(0);
}
// Refutador com achado COMPLETO mas sem prova de leitura: o path do achado
// aponta arquivo do diff — ancora suficiente, a rodada nao pode ser queimada.
if (prompt.includes('DERRUBAR') && mode === 'refute-ancorado-sem-inspected') {
  console.log(JSON.stringify({
    refuted: true, confidence: 95, severity: 'P1', lens: 'code-safety',
    path: 'a.ts:1', title: 'defeito concreto sem prova de leitura',
    why: 'furo real apontado com arquivo e linha do diff',
  }));
  process.exit(0);
}
// Refutador que encontrou VARIOS defeitos numa rodada: principal + extras.
if (prompt.includes('DERRUBAR') && mode === 'refute-com-extras') {
  console.log(JSON.stringify({
    refuted: true, confidence: 95, severity: 'P1', lens: 'code-quality',
    path: 'a.ts:1', title: 'principal', why: 'defeito principal',
    inspected: provaDeLeitura,
    extra_findings: [
      { severity: 'P0', lens: 'code-safety', path: 'b.ts:1', title: 'extra grave', why: 'segundo defeito' },
      { severity: 'P2', path: 'c.ts:1', title: 'extra menor', why: 'terceiro defeito' },
    ],
  }));
  process.exit(0);
}
// Refutador com achado completo mas prova de leitura INVENTADA: quote que nao
// existe no arquivo. Mentira comprovada nao pode virar refutacao valida.
if (prompt.includes('DERRUBAR') && mode === 'refute-inspected-falso') {
  console.log(JSON.stringify({
    refuted: true, confidence: 95, severity: 'P1', lens: 'code-safety',
    path: 'a.ts:1', title: 'achado com prova falsa', why: 'alegacao com citacao inventada',
    inspected: [{ path: 'a.ts', line: 1, quote: 'linha que nao existe no arquivo' }],
  }));
  process.exit(0);
}
// Refutador que mandou SO titulo, com prova de leitura valida. Titulo e rotulo,
// nao evidencia: nao pode virar payload-incompleto, que bloqueia.
if (prompt.includes('DERRUBAR') && mode === 'refute-so-titulo') {
  console.log(JSON.stringify({
    refuted: true, title: 'algo parece errado', inspected: provaDeLeitura,
  }));
  process.exit(0);
}
// Modo do contraditorio: devolve o veredito de refutacao em vez de um scorecard.
if (prompt.includes('DERRUBAR') && mode === 'refute-p2-torto') {
  // P2 com confianca NAO-NUMERICA e path sem linha: nao e debito rastreavel.
  console.log(JSON.stringify({
    refuted: true, confidence: 'alto', severity: 'P2', lens: 'code-quality',
    path: 'a.ts', title: 'debito sem ancora', why: 'sem linha e sem confianca',
    inspected: provaDeLeitura,
  }));
  process.exit(0);
}
if (prompt.includes('DERRUBAR') && mode === 'refute-p2-prova-derrubada') {
  // P2 completo cuja PROPRIA prova o contradiz (expect fail, comando sai 0).
  console.log(JSON.stringify({
    refuted: true, confidence: 95, severity: 'P2', lens: 'code-quality',
    path: 'a.ts:1', title: 'debito que a prova desmente', why: 'alegacao automatica',
    inspected: provaDeLeitura,
    proof: { command: 'node scripts/prova.mjs', expect: 'fail' },
  }));
  process.exit(0);
}
if (mode === 'refute-p1-sem-titulo-com-p2') {
  // P1 valido pelo contrato (severity+path+why) SEM titulo, junto de um P2
  // completo: a politica nao pode rebaixar o P1.
  console.log(JSON.stringify({
    refuted: true, confidence: 99, severity: 'P1',
    lens: 'code-safety', path: 'a.ts:1',
    why: 'bloqueante sem titulo, contrato do refutador nao exige titulo',
    inspected: provaDeLeitura,
    extra_findings: [{
      severity: 'P2', confidence: 90, lens: 'code-quality', path: 'b.ts:1',
      title: 'p2 completo', why: 'debito acionavel', inspected: provaDeLeitura,
    }],
  }));
  process.exit(0);
}
if (mode === 'review-p2-com-p1-na-lista') {
  // Contadores MENTEM: p0/p1 zerados mas ha um P1 real em findings.
  console.log(JSON.stringify({
    score: 4, target: 5, p0: 0, p1: 0, p2: 1,
    lenses: {
      'code-safety': { p0: 0, p1: 0, p2: 0 },
      'code-structure': { p0: 0, p1: 0, p2: 0 },
      'code-quality': { p0: 0, p1: 0, p2: 1 },
      'code-efficiency': { p0: 0, p1: 0, p2: 0 },
    },
    findings: [
      { severity: 'P2', confidence: 90, lens: 'code-quality', path: 'a.ts:1',
        title: 'debito', why: 'acionavel' },
      { severity: 'P1', confidence: 95, lens: 'code-safety', path: 'b.ts:1',
        title: 'bloqueante escondido', why: 'contador mente' },
    ],
    coverage: [{ surface: 'arquivos alterados', total: 3, inspected: 3 }],
    verified: [{
      claim: 'os tres modulos exportam constantes nomeadas',
      path: 'a.ts', line: 1, quote: 'export const alpha = 1; // linha citada',
    }],
    inspected: provaDeLeitura,
  }));
  process.exit(0);
}
if (mode === 'refute-p2-sem-why') {
  // P2 sem justificativa: nao e acionavel, entao NAO enfileira — bloqueia.
  console.log(JSON.stringify({
    refuted: true, confidence: 95, severity: 'P2',
    lens: 'code-quality', path: 'a.ts:1', title: 'sem justificativa',
    inspected: provaDeLeitura,
  }));
  process.exit(0);
}
if (mode === 'refute-p2-extra-torto') {
  // P2 principal VALIDO + extra P1 sem titulo nem path: o extra e descartado
  // depois pelo applyRefutation, entao nao pode bloquear o enfileiramento.
  console.log(JSON.stringify({
    refuted: true, confidence: 95, severity: 'P2',
    lens: 'code-quality', path: 'a.ts:1',
    title: 'defeito que o primeiro reviewer nao viu',
    why: 'contraditorio encontrou caso de borda ignorado',
    inspected: provaDeLeitura,
    extra_findings: [{ severity: 'P1', confidence: 90 }],
  }));
  process.exit(0);
}
if (mode === 'refute' || mode === 'refute-p2') {
  console.log(JSON.stringify({
    refuted: true, confidence: 95, severity: mode === 'refute-p2' ? 'P2' : 'P1',
    lens: 'code-quality', path: 'a.ts:1',
    title: 'defeito que o primeiro reviewer nao viu',
    why: 'contraditorio encontrou caso de borda ignorado',
    inspected: provaDeLeitura,
  }));
  process.exit(0);
}
if (mode === 'invalid') {
  console.log('not-json');
  process.exit(0);
}

const reviewSeverity = /^review-(p[012])$/.exec(mode)?.[1];
const score = mode === 'low' || reviewSeverity ? 4 : 5;
const inspected = mode === 'no-inspection'
  ? []
  : [
      { path: 'a.ts', line: 1, quote: 'export const alpha = 1; // linha citada' },
      { path: 'b.ts', line: 1, quote: 'export const bravo = 2; // linha citada' },
      { path: 'c.ts', line: 1, quote: 'export const charlie = 3; // linha citada' },
    ];
const counts = { p0: 0, p1: 0, p2: 0 };
if (reviewSeverity) counts[reviewSeverity] = 1;
const lenses = {
  'code-safety': { p0: 0, p1: 0, p2: 0 },
  'code-structure': { p0: 0, p1: 0, p2: 0 },
  'code-quality': { ...counts },
  'code-efficiency': { p0: 0, p1: 0, p2: 0 },
};
console.log(JSON.stringify({
  reviewer: provider,
  score,
  target: 5,
  base: process.env.LMS_REVIEWER_BASE,
  ...counts,
  lenses,
  findings: reviewSeverity ? [{
    severity: reviewSeverity.toUpperCase(), confidence: 95, lens: 'code-quality',
    path: 'a.ts:1', title: 'achado de severidade controlada', why: 'exercita a politica',
  }] : [],
  at: new Date().toISOString(),
  coverage: [{ surface: 'arquivos alterados', total: 3, inspected: 3 }],
  verified: [{
    claim: 'os tres modulos exportam constantes nomeadas',
    path: 'a.ts', line: 1, quote: 'export const alpha = 1; // linha citada',
  }],
  inspected,
}));
`;

test('retryPrompt carrega a mensagem de validacao e o prompt original', () => {
  const p = retryPrompt('PROMPT ORIGINAL', 'coverage is required');
  assert.match(p, /coverage is required/);
  assert.match(p, /PROMPT ORIGINAL/);
  assert.match(p, /rejected/i);
});

// Fase 3 Task 3: o sandbox e o que garante a restricao do fix — nao a instrucao em prosa.
test('modo review mantem o codex em read-only', () => {
  const c = commandFor('codex', { models: { codex: 'm' }, bins: { codex: 'b' }, codexEffort: 'high', prompt: 'x' });
  assert.equal(c.args.includes('read-only'), true);
});

test('modo fix da escrita de workspace ao codex, nunca acesso total', () => {
  const c = commandFor('codex', { models: { codex: 'm' }, bins: { codex: 'b' }, codexEffort: 'xhigh', prompt: 'x' }, { modo: 'fix' });
  assert.equal(c.args.includes('workspace-write'), true);
  assert.equal(c.args.includes('read-only'), false);
  assert.equal(c.args.some((a) => String(a).includes('danger')), false);
});

test('modo fix libera Edit e Write no claude, e so eles', () => {
  const c = commandFor('claude', { models: { claude: 'm' }, bins: { claude: 'b' }, prompt: 'x' }, { modo: 'fix' });
  const tools = c.args[c.args.indexOf('--tools') + 1];
  assert.match(tools, /Edit/);
  assert.match(tools, /Write/);
  assert.equal(/Bash/.test(tools), false);
});

test('modo review nao libera Edit no claude', () => {
  const c = commandFor('claude', { models: { claude: 'm' }, bins: { claude: 'b' }, prompt: 'x' });
  assert.equal(/Edit/.test(c.args[c.args.indexOf('--tools') + 1]), false);
});

// P3-1 da revisao da Fase 1: com maxTentativas configuravel, o wrapper aninhava —
// cada volta empilhava outro bloco de instrucoes originais.
test('retentativas nao aninham o wrapper (P3-1)', async () => {
  const { root, opcoes } = await fixture();
  const prompts = [];
  const collect = async ({ prompt }) => {
    prompts.push(prompt);
    return { kind: 'ok', candidate: { score: 5 } };
  };
  await attemptProvider({ ...opcoes, root, collect, maxTentativas: 3 });
  assert.equal(prompts.length, 3);
  for (const prompt of prompts.slice(1)) {
    assert.equal((prompt.match(/VALIDATION ERROR/g) ?? []).length, 1);
    assert.equal((prompt.match(/ORIGINAL INSTRUCTIONS/g) ?? []).length, 1);
  }
});

test('attemptProvider tenta de novo quando a primeira saida esta malformada', async () => {
  const { root, opcoes, scorecardValido } = await fixture();
  const saidas = [{ score: 5 }, scorecardValido];
  let chamadas = 0;
  const collect = async () => ({ kind: 'ok', candidate: saidas[chamadas++] });
  const r = await attemptProvider({ ...opcoes, root, collect });
  assert.equal(chamadas, 2, 'devia ter dado uma segunda chance');
  assert.equal(r.accepted, true);
});

test('attemptProvider retenta quando a citacao de verified e fabricada (P1-2)', async () => {
  const { root, opcoes, scorecardValido } = await fixture();
  const fabricado = {
    ...scorecardValido,
    verified: [{ claim: 'arquivo inexistente conferido e correto', path: 'nao/existe.ts', line: 1, quote: 'inventado' }],
  };
  const saidas = [fabricado, scorecardValido];
  let chamadas = 0;
  const collect = async () => ({ kind: 'ok', candidate: saidas[chamadas++] });
  const r = await attemptProvider({ ...opcoes, root, collect });
  assert.equal(chamadas, 2, 'citacao fabricada de verified ganha segunda chance');
  assert.equal(r.accepted, true);
});

test('attemptProvider NAO tenta de novo quando o scorecard e valido e reprova', async () => {
  const { root, opcoes, scorecardValido } = await fixture();
  let chamadas = 0;
  const collect = async () => {
    chamadas += 1;
    return { kind: 'ok', candidate: { ...scorecardValido, score: 2, p1: 1,
      lenses: { ...scorecardValido.lenses, 'code-safety': { p0: 0, p1: 1, p2: 0 } } } };
  };
  const r = await attemptProvider({ ...opcoes, root, collect });
  assert.equal(chamadas, 1, 'reprovacao legitima nao ganha segunda chance');
  assert.equal(r.rejected, true);
});

test('verificador dentro do runFallback confirma achado que tentou passar como PLAUSIBLE', async () => {
  const { root, env, scorecardValido } = await fixture();
  try {
    // O revisor emite 5/5 com um P1 disfarçado de PLAUSIBLE (nao bloqueia na forma).
    // O verificador (grok) abre o arquivo, confirma o defeito e o achado volta a
    // bloquear; o contraditorio (tambem grok) nao derruba o aceite, mas o scorecard
    // gravado carrega o veredito CONFIRMED com a autoria da verificacao.
    const achado = {
      id: 'abc123', lens: 'code-safety', severity: 'P1', confidence: 90,
      path: 'a.ts:1', title: 'falta filtro de tenant', why: 'a query nao escopa',
      verdict: 'PLAUSIBLE', verdict_by: 'codex', verdict_why: 'nao reproduzi',
    };
    const chamadas = [];
    const collect = async ({ provider, prompt }) => {
      chamadas.push({ provider, prompt });
      if (prompt.includes('DEMOLISH')) {
        return { kind: 'ok', candidate: { id: 'abc123', verdict: 'CONFIRMED', why: 'abri o arquivo e o defeito esta la' } };
      }
      if (provider === 'claude') {
        return {
          kind: 'ok',
          candidate: { ...scorecardValido, findings: [achado] },
        };
      }
      // Contraditorio: olhou e nao derrubou (com prova de leitura).
      return {
        kind: 'ok',
        candidate: { refuted: false, confidence: 0, inspected: provaDeLeituraFixture },
      };
    };
    const r = await runFallback({ root, base, env, collect });
    assert.equal(r.ok, true);
    assert.equal(r.acceptedBy, 'claude');
    assert.equal(r.contestedBy, 'grok');
    // Tres chamadas: revisor, verificador do achado, contraditorio.
    assert.equal(chamadas.length, 3);
    assert.match(chamadas[1].prompt, /falta filtro de tenant/);
    const gravado = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
    assert.equal(gravado.findings[0].verdict, 'CONFIRMED');
    assert.equal(gravado.findings[0].verdict_by, 'grok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// P1-2 da revisao da Fase 2: o veredito tem de responder AO achado — veredito de
// outro id nao rebaixa. E as verificacoes sao sequenciais (um collect por achado).
test('verificador serial: veredito do outro achado nao rebaixa o segundo (P1-2)', async () => {
  const { root, env, scorecardValido } = await fixture();
  try {
    // Revisor emite dois achados PLAUSIBLE (nao bloqueiam a forma). O verificador
    // responde na primeira chamada com veredito cujo id casa com o P0; na segunda,
    // com id errado. Antes do conserto, a mesma resposta rebaixava os dois.
    const achados = [
      { id: 'bbb111', lens: 'code-safety', severity: 'P0', confidence: 95,
        path: 'a.ts:1', title: 'P0 de tenant', why: 'sem escopo', verdict: 'PLAUSIBLE', verdict_by: 'codex' },
      { id: 'aaa000', lens: 'code-quality', severity: 'P2', confidence: 85,
        path: 'b.ts:1', title: 'P2 cosmético', why: 'naming', verdict: 'PLAUSIBLE', verdict_by: 'codex' },
    ];
    let chamadaVerificador = 0;
    const collect = async ({ provider, prompt }) => {
      if (prompt.includes('DEMOLISH')) {
        // Primeira chamada (P0, id bbb111): veredito casa e rebaixa. Segunda
        // chamada (P2, id aaa000): veredito com id do P0 — nao pode vazar.
        const alvo = chamadaVerificador === 0 ? 'bbb111' : 'zzz999';
        chamadaVerificador += 1;
        return { kind: 'ok', candidate: { id: alvo, verdict: 'PLAUSIBLE', why: 'nao reproduzi' } };
      }
      if (provider === 'claude') {
        return { kind: 'ok', candidate: { ...scorecardValido, findings: achados } };
      }
      return { kind: 'ok', candidate: { refuted: false, confidence: 0, inspected: provaDeLeituraFixture } };
    };
    const r = await runFallback({ root, base, env, collect });
    assert.equal(r.ok, true);
    const gravado = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
    const porId = new Map(gravado.findings.map((f) => [f.id, f]));
    // O veredito com id certo rebaixa o P0 para PLAUSIBLE.
    assert.equal(porId.get('bbb111').verdict, 'PLAUSIBLE');
    // O veredito do P0 nao vaza para o P2: id errado falha fechado.
    assert.equal(porId.get('aaa000').verdict, 'CONFIRMED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// P1-1 da revisao da Fase 2: a refutacao do contraditorio PROVA defeitos reais
// (derrubam o ACEITE). Registrar a classe dela no corpus "nao reporte" suprimia
// vazamentos reais provados. Precedente so nasce de FALSE_POSITIVE com prova.
test('refutacao vencedora nao grava precedente (P1-1)', async () => {
  const { root, env, scorecardValido } = await fixture();
  try {
    const collect = async ({ provider, prompt: _prompt }) => {
      if (provider === 'claude') {
        return { kind: 'ok', candidate: scorecardValido };
      }
      return {
        kind: 'ok',
        candidate: {
          refuted: true, confidence: 95, severity: 'P1', lens: 'code-safety',
          path: 'a.ts:1', title: 'query sem filtro de tenant',
          why: 'a query não escopa', inspected: provaDeLeituraFixture,
        },
      };
    };
    const r = await runFallback({ root, base, env, collect });
    assert.equal(r.ok, false, 'a refutacao vencedora derruba o aceite');
    const existe = await stat(join(root, '.lms', 'precedentes.md')).then(() => true, () => false);
    assert.equal(existe, false, 'defeito REAL provado nao vira classe suprimida');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verificador FALSE_POSITIVE com prova confirma a classe no corpus (P1-1)', async () => {
  const { root, env, scorecardValido } = await fixture();
  try {
    const achado = {
      id: 'abc123', lens: 'code-safety', severity: 'P1', confidence: 90,
      path: 'a.ts:1', title: 'falta filtro de tenant', why: 'a query nao escopa',
      verdict: 'PLAUSIBLE', verdict_by: 'codex', verdict_why: 'nao reproduzi',
    };
    const collect = async ({ provider, prompt }) => {
      if (prompt.includes('DEMOLISH')) {
        return {
          kind: 'ok',
          candidate: {
            id: 'abc123', verdict: 'FALSE_POSITIVE',
            why: 'o filtro esta no middleware, a citacao aponta a linha errada',
            proof: { command: 'node scripts/prova.mjs', expect: 'pass' },
          },
        };
      }
      if (provider === 'claude') {
        return {
          kind: 'ok',
          candidate: { ...scorecardValido, findings: [achado] },
        };
      }
      return { kind: 'ok', candidate: { refuted: false, confidence: 0, inspected: provaDeLeituraFixture } };
    };
    const r = await runFallback({ root, base, env, collect });
    assert.equal(r.ok, true);
    const corpus = await readFile(join(root, '.lms', 'precedentes.md'), 'utf8');
    assert.match(corpus, /falta filtro de tenant/);
    assert.match(corpus, /grok/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function assertCadeiaCompleta(log) {
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['claude', 'grok', 'codex']);
}

// Cadeia com retentativa: cada provider queima as duas tentativas por saida
// invalida antes de cair para o proximo.
async function assertCadeiaDuplicada(log) {
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [
    'claude', 'claude', 'grok', 'grok', 'codex', 'codex',
  ]);
}

async function assertUltimoResultado(root, esperado) {
  assert.equal((await historico(root)).at(-1).result, esperado);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lms-fallback-'));
  const bin = join(root, 'fake-provider.mjs');
  const log = join(root, 'calls.log');
  await escreverArquivosCitados(root);
  // Script que a "prova" da refutacao executa. O exit vem do ambiente, entao o teste
  // decide se a alegacao se sustenta ou se desmente sozinha.
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(
    join(root, 'scripts', 'prova.mjs'),
    'process.exit(Number(process.env.FAKE_PROVA_EXIT ?? 0));\n',
    'utf8',
  );
  await writeFile(bin, fakeProvider, 'utf8');
  await chmod(bin, 0o755);
  const env = {
    LMS_CLAUDE_BIN: bin,
    LMS_GROK_BIN: bin,
    LMS_CODEX_BIN: bin,
    LMS_REVIEWER_ORDER: 'claude,grok,codex',
    LMS_REVIEWER_TIMEOUT_SEC: '1',
    FAKE_CALL_LOG: log,
  };
  // Scorecard como o MODELO emitiria (sem campos cravados pelo runner) e as opcoes
  // minimas do attemptProvider — fonte unica para os testes de retentativa.
  const scorecardValido = {
    score: 5,
    target: 5,
    p0: 0,
    p1: 0,
    p2: 0,
    lenses: {
      'code-safety': { p0: 0, p1: 0, p2: 0 },
      'code-structure': { p0: 0, p1: 0, p2: 0 },
      'code-quality': { p0: 0, p1: 0, p2: 0 },
      'code-efficiency': { p0: 0, p1: 0, p2: 0 },
    },
    findings: [],
    coverage: coberturaFixture,
    verified: verificacaoFixture,
    inspected: provaDeLeituraFixture,
  };
  const opcoes = {
    provider: 'claude',
    config: providerConfig(env),
    base,
    env,
    fallow: 'pass',
    changedPaths: new Set(['a.ts', 'b.ts', 'c.ts']),
  };
  return { root, env, log, scorecardValido, opcoes };
}

const provaDeLeituraFixture = [
  { path: 'a.ts', line: 1, quote: 'export const alpha = 1; // linha citada' },
  { path: 'b.ts', line: 1, quote: 'export const bravo = 2; // linha citada' },
  { path: 'c.ts', line: 1, quote: 'export const charlie = 3; // linha citada' },
];

function scorecardComAchados(severity, count) {
  const campo = severity.toLowerCase();
  const counts = { p0: 0, p1: 0, p2: 0, [campo]: count };
  return {
    score: 4,
    target: 5,
    ...counts,
    lenses: {
      'code-safety': { p0: 0, p1: 0, p2: 0 },
      'code-structure': { p0: 0, p1: 0, p2: 0 },
      'code-quality': { ...counts },
      'code-efficiency': { p0: 0, p1: 0, p2: 0 },
    },
    findings: Array.from({ length: count }, (_, index) => ({
      severity,
      confidence: 95,
      lens: 'code-quality',
      path: `a.ts:${index + 1}`,
      title: `${severity} ${index + 1}`,
      why: 'achado semantico',
    })),
    coverage: coberturaFixture,
    verified: verificacaoFixture,
    inspected: provaDeLeituraFixture,
  };
}

async function jsonl(root, arquivo) {
  const bruto = await readFile(join(root, '.lms', arquivo), 'utf8');
  return bruto
    .trim()
    .split('\n')
    .map((linha) => JSON.parse(linha));
}

test('builds exact High commands for all providers', () => {
  const config = providerConfig({
    LMS_CLAUDE_MODEL: 'claude-opus-4-8',
    LMS_GROK_MODEL: 'grok-4.6',
    LMS_CODEX_MODEL: 'gpt-5.6-sol',
  });

  assert.deepEqual(commandFor('claude', { ...config, base, prompt: 'review' }).args, [
    '--model',
    'claude-opus-4-8',
    '--effort',
    'high',
    '--print',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--permission-mode',
    'plan',
    '--tools',
    'Read,Grep,Glob',
  ]);
  assert.deepEqual(commandFor('grok', { ...config, base, prompt: 'review' }).args, [
    '--model',
    'grok-4.6',
    '--reasoning-effort',
    'medium',
    '--single',
    'review',
    '--output-format',
    'json',
    '--permission-mode',
    'plan',
    '--tools',
    'Read,Grep,Glob',
  ]);
  const codex = commandFor('codex', { ...config, base, prompt: 'review' });
  assert.equal(codex.args.includes('gpt-5.6-sol'), true);
  // `xhigh` é o piso do revisor codex, e o padrão vem do código, não do ambiente:
  // um deploy que esquecesse `LMS_CODEX_EFFORT` não pode rebaixar a revisão em
  // silêncio.
  assert.equal(codex.args.includes('model_reasoning_effort="xhigh"'), true);
  assert.equal(codex.args.includes('-'), false);
});

test('falls back from Claude failure to Grok and stops on accepted 5/5', async () => {
  const { root, env, log } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit' },
    });
    assert.equal(result.acceptedBy, 'grok');
    // O contraditorio chama um TERCEIRO provider para tentar derrubar o 5/5. O fake
    // devolve scorecard (sem `refuted`), entao o aceite se mantem — mas o codex e
    // chamado, e e isso que distingue aceite contestado de aceite sozinho.
    assert.equal(result.contestedBy, 'codex');
    await assertCadeiaCompleta(log);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed output falls through, but a low score STOPS the chain', async () => {
  // Antes isto esperava que score baixo caisse para o proximo provider — e era
  // exatamente o defeito: reprovacao legitima virava "reviewer quebrado", os tres
  // "falhavam" e o push passava. Reprovacao encerra a cadeia; continuar seria
  // procurar quem aprove.
  const { root, env, log } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: {
        ...env,
        FAKE_CLAUDE_MODE: 'invalid',
        FAKE_GROK_MODE: 'low',
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.rejectedBy, 'grok');
    assert.equal(result.acceptedBy, undefined);
    // codex nunca e chamado: o grok ja deu o veredito. O claude aparece duas vezes:
    // saida malformada ganha UMA retentativa com o erro de validacao (Task 7) antes
    // de cair para o proximo provider.
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['claude', 'claude', 'grok']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a review that opened no files is discarded as invalid output', async () => {
  // O codex expos esta necessidade: devolvia 5/5 com reasoning_tokens=152 e zero
  // ferramentas. Sem prova de leitura, o parecer nao vale.
  const { root, env, log } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: {
        ...env,
        FAKE_CLAUDE_MODE: 'no-inspection',
        FAKE_GROK_MODE: 'no-inspection',
        FAKE_CODEX_MODE: 'no-inspection',
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.rejectedBy, undefined);
    // Cada provider queima as duas tentativas (original + retentativa por forma)
    // antes de a cadeia cair para o proximo.
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.result),
      ['invalid-output', 'invalid-output', 'invalid-output'],
    );
    await assertCadeiaDuplicada(log);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('falls through timeout and unavailable provider to Codex', async () => {
  const { root, env, log } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: {
        ...env,
        FAKE_CLAUDE_MODE: 'timeout',
        LMS_GROK_BIN: join(root, 'missing-grok'),
      },
    });
    // claude deu timeout e o grok nem existe: sobra o proprio codex, que aceitou.
    // Sem refutador elegivel nao ha segunda opiniao — e sem ela nao se publica, pelo
    // mesmo principio que vale para o fallow. O override consciente existe e e alto.
    assert.equal(result.ok, false);
    assert.equal(result.uncontested, true);
    assert.match(result.reason ?? '', /sem-refutador/);
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['claude', 'codex']);

    // Com o override, o mesmo cenario publica — deliberadamente.
    const comOverride = await runFallback({
      root,
      base,
      env: {
        ...env,
        FAKE_CLAUDE_MODE: 'timeout',
        LMS_GROK_BIN: join(root, 'missing-grok'),
        LMS_ALLOW_UNCONTESTED: '1',
      },
    });
    assert.equal(comOverride.acceptedBy, 'codex');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Prepara um scorecard já existente e roda a cadeia — o par que os dois testes de
 *  sobrescrita compartilham. */
async function withExistingScorecard(previous, modes) {
  const { root, env } = await fixture();
  const scorecardPath = join(root, '.lms', 'last.json');
  await mkdir(join(root, '.lms'), { recursive: true });
  await writeFile(scorecardPath, previous, 'utf8');
  const result = await runFallback({ root, base, env: { ...env, ...modes } });
  return { root, scorecardPath, result };
}

test('blocks and preserves an existing scorecard when every provider fails', async () => {
  const { root, scorecardPath, result } = await withExistingScorecard('{"previous":"valid"}', {
    FAKE_CLAUDE_MODE: 'exit',
    FAKE_GROK_MODE: 'invalid',
    FAKE_CODEX_MODE: 'invalid',
  });
  try {
    assert.equal(result.acceptedBy, null);
    assert.equal(result.ok, false);
    assert.equal(await readFile(scorecardPath, 'utf8'), '{"previous":"valid"}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a rejection OVERWRITES an older scorecard', async () => {
  // Preservar um scorecard aprovado antigo enquanto o reviewer atual reprova seria o
  // pior caso: o gate leria o antigo e liberaria o push. O veredito novo manda.
  const { root, scorecardPath, result } = await withExistingScorecard('{"previous":"approved"}', {
    FAKE_CLAUDE_MODE: 'low',
  });
  try {
    assert.equal(result.rejectedBy, 'claude');
    const written = JSON.parse(await readFile(scorecardPath, 'utf8'));
    assert.equal(written.score, 4);
    assert.equal(written.reviewer, 'claude');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inspection floor adapts to the diff size and paths must belong to it', async () => {
  // Cobertura detalhada da prova (citacao fabricada, aspas, off-by-one) vive em
  // lms-inspection.test.mjs. Aqui fica o que e especifico do runner: o piso desce
  // para diffs pequenos, e caminho fora do diff e recusado.
  const { inspectionError } = await import('./lms-inspection.mjs');
  const root = await mkdtemp(join(tmpdir(), 'lms-inspect-'));
  try {
    await writeFile(join(root, 'only.ts'), 'const primeira = "linha real aqui";\n', 'utf8');
    await writeFile(join(root, 'a.ts'), 'const alpha = "conteudo verdadeiro";\n', 'utf8');
    await writeFile(join(root, 'b.ts'), 'const bravo = "outro conteudo real";\n', 'utf8');
    await writeFile(join(root, 'c.ts'), 'const charlie = "terceiro conteudo";\n', 'utf8');

    const one = { path: 'only.ts', line: 1, quote: 'const primeira = "linha real aqui";' };
    assert.equal(await inspectionError({ inspected: [one] }, new Set(['only.ts']), root), null);

    const threeFiles = new Set(['a.ts', 'b.ts', 'c.ts']);
    const three = [
      { path: 'a.ts', line: 1, quote: 'const alpha = "conteudo verdadeiro";' },
      { path: 'b.ts', line: 1, quote: 'const bravo = "outro conteudo real";' },
      { path: 'c.ts', line: 1, quote: 'const charlie = "terceiro conteudo";' },
    ];
    assert.equal(await inspectionError({ inspected: three }, threeFiles, root), null);

    // Mesmo arquivo repetido nao vira tres.
    assert.match(
      (await inspectionError({ inspected: [three[0], three[0], three[0]] }, threeFiles, root)) ??
        '',
      /at least 3 distinct/,
    );

    // Contexto nao substitui cobertura: citar dois arquivos do diff mais um de fora
    // (aqui um caminho deletado) nao fecha o piso de tres. Ler fora do diff passou a
    // ser permitido — o que nao pode e usar isso para cobrir menos do diff.
    assert.match(
      (await inspectionError(
        {
          inspected: [
            three[0],
            three[1],
            { path: 'gone.ts', line: 1, quote: 'qualquer coisa longa' },
          ],
        },
        threeFiles,
        root,
      )) ?? '',
      /must cover at least 3 changed file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Le `.lms/history.jsonl` — os testes do contraditorio precisam do mesmo. */
async function historico(root) {
  return jsonl(root, 'history.jsonl');
}

test('cada invocacao registra telemetria completa dos dois estagios', async () => {
  const { root, env } = await fixture();
  try {
    await runFallback({ root, base, env });
    const [revisor, refutador] = await historico(root);
    const campos = [
      'round_id',
      'subject',
      'base',
      'estagio',
      'provider',
      'modelo',
      'changed_files',
      'changed_lines',
      'p0',
      'p1',
      'p2',
      'findings_count',
      'resultado',
      'duration_ms',
      'at',
    ];

    for (const linha of [revisor, refutador]) {
      assert.deepEqual(
        campos.every((campo) => Object.hasOwn(linha, campo)),
        true,
      );
      assert.equal(linha.base, base);
      assert.equal(linha.changed_files, 0);
      assert.equal(linha.changed_lines, 0);
      assert.equal(linha.findings_count, 0);
    }
    assert.equal(revisor.estagio, 'reviewer');
    assert.equal(revisor.resultado, 'accepted');
    assert.equal(revisor.modelo, 'claude-opus-4-8');
    assert.equal(refutador.estagio, 'refutador');
    assert.equal(refutador.resultado, 'upheld');
    assert.equal(refutador.modelo, 'grok-4.6');
    assert.equal(refutador.round_id, revisor.round_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sem flag P2 continua bloqueando e nenhuma fila nasce', async () => {
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'review-p2' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.rejectedBy, 'claude');
    await assert.rejects(readFile(join(root, '.lms', 'p2-queue.jsonl'), 'utf8'), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('com flag P2 do reviewer entra na fila e a rodada aceita', async () => {
  const { root, env } = await fixture();
  const saida = [];
  const logOriginal = console.log;
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, LMS_SEVERITY_POLICY: '1', FAKE_CLAUDE_MODE: 'review-p2' },
    });
    console.log = (...args) => saida.push(args.join(' '));
    assert.equal(reportarDesfecho(result, 'lms-teste'), 0);
    assert.equal(result.ok, true);
    assert.equal(result.p2Queued, 1);
    assert.match(saida.join('\n'), /1 achado P2 enfileirado/);

    const [queued] = await jsonl(root, 'p2-queue.jsonl');
    assert.deepEqual(
      Object.keys(queued).sort(),
      // `why` e `fix` entraram na rodada 90: a fila e a UNICA memoria do debito
      // depois que o achado sai do scorecard, entao a justificativa vai junto.
      // `id` entrou no P2-5 da revisao da Fase 1: identidade estavel entre rodadas.
      ['commit', 'confidence', 'fix', 'id', 'lens', 'path', 'round_id', 'title', 'why'].sort(),
    );
    assert.equal(queued.path, 'a.ts:1');
    assert.equal(queued.title, 'achado de severidade controlada');
    assert.equal(queued.lens, 'code-quality');
    assert.equal(queued.confidence, 95);
    assert.equal(typeof queued.round_id, 'string');
  } finally {
    console.log = logOriginal;
    await rm(root, { recursive: true, force: true });
  }
});

test('com flag P0 e P1 continuam bloqueando', async () => {
  for (const severity of ['p0', 'p1']) {
    const { root, env } = await fixture();
    try {
      const result = await runFallback({
        root,
        base,
        env: { ...env, LMS_SEVERITY_POLICY: '1', FAKE_CLAUDE_MODE: `review-${severity}` },
      });
      assert.equal(result.ok, false, `${severity} nao pode liberar`);
      assert.equal(result.rejectedBy, 'claude');
      const gravado = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
      assert.equal(gravado[severity], 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('P2 encontrado pelo refutador tambem enfileira sem derrubar o aceite', async () => {
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, LMS_SEVERITY_POLICY: '1', FAKE_GROK_MODE: 'refute-p2' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.contestedBy, 'grok');
    assert.equal(result.p2Queued, 1);
    const [queued] = await jsonl(root, 'p2-queue.jsonl');
    assert.equal(queued.path, 'a.ts:1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extra P1 malformado nao impede o enfileiramento do P2 valido', async () => {
  // Rodada 89: `extrasComprovados` so descarta prova desmentida, nao exige campos.
  // Um extra com apenas `severity: P1` fazia o P2 legitimo bloquear — e o proprio
  // applyRefutation descartava o extra depois. So achado COMPLETO bloqueia.
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, LMS_SEVERITY_POLICY: '1', FAKE_GROK_MODE: 'refute-p2-extra-torto' },
    });
    assert.equal(result.ok, true, 'P2 com extra torto nao pode derrubar o aceite');
    assert.equal(result.p2Queued, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P2 sem justificativa nao enfileira — bloqueia como achado normal', async () => {
  // Rodada 90: a validacao de forma do scorecard nao olha o conteudo dos
  // findings; um P2 vazio virava aceite 5/5 com linha inutil na fila.
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, LMS_SEVERITY_POLICY: '1', FAKE_GROK_MODE: 'refute-p2-sem-why' },
    });
    assert.equal(result.ok, false, 'P2 sem why tem de bloquear, nao virar aceite');
    await assert.rejects(readFile(join(root, '.lms', 'p2-queue.jsonl'), 'utf8'), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a fila P2 guarda a justificativa e a correcao sugerida', async () => {
  // Rodada 90: o achado sai do scorecard ao virar aceite, entao a fila e a UNICA
  // memoria do debito — sem why/fix ninguem sabe depois por que aquilo e defeito.
  const { root, env } = await fixture();
  try {
    await runFallback({
      root,
      base,
      env: { ...env, LMS_SEVERITY_POLICY: '1', FAKE_GROK_MODE: 'refute-p2' },
    });
    const [queued] = await jsonl(root, 'p2-queue.jsonl');
    assert.equal(queued.why, 'contraditorio encontrou caso de borda ignorado');
    assert.ok('fix' in queued, 'o campo fix acompanha o debito');
    // P2-5 da revisao da Fase 1: a fila e a memoria duravel do debito, entao carrega
    // a identidade estavel — hash de lens+arquivo-sem-linha+titulo.
    assert.equal(queued.id, findingId({ lens: queued.lens, path: queued.path, title: queued.title }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P1 sem titulo nao e rebaixado por um P2 que o acompanha', async () => {
  // Rodada 91: o contrato do refutador (REFUTACAO_OBRIGATORIOS) nao exige title;
  // exigi-lo em temBloqueante deixava a politica zerar um P1 legitimo.
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, LMS_SEVERITY_POLICY: '1', FAKE_GROK_MODE: 'refute-p1-sem-titulo-com-p2' },
    });
    assert.equal(result.ok, false, 'o P1 tem de derrubar o aceite');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('contador que mente nao publica P1 escondido em findings', async () => {
  // Rodada 91: a validacao de forma nao reconcilia findings com p0/p1, entao um
  // scorecard com p1:0 e um P1 na lista virava aceite pela via da fila P2.
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, LMS_SEVERITY_POLICY: '1', FAKE_CLAUDE_MODE: 'review-p2-com-p1-na-lista' },
    });
    assert.equal(result.ok, false, 'P1 na lista bloqueia mesmo com contador zerado');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('o scorecard aceito nao lista os P2 que foram para a fila', async () => {
  // Rodada 91: structuredClone cria objetos novos, entao o filtro por referencia
  // nunca casava — o last.json saia score 5 / p2 0 AINDA listando os P2.
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, LMS_SEVERITY_POLICY: '1', FAKE_CLAUDE_MODE: 'review-p2' },
    });
    assert.equal(result.ok, true);
    const gravado = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
    assert.equal(gravado.p2, 0);
    assert.deepEqual(gravado.findings, [], 'o P2 enfileirado sai da lista');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P2 desmentido pela propria prova nao vira debito na fila', async () => {
  // Rodada 91: a politica escolhia o achado principal sem exigir que ele tivesse
  // sobrevivido a prova; um P2 mecanicamente derrubado entrava na fila como
  // debito legitimo, e sem a prova ninguem saberia depois que era falso.
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: {
        ...env,
        LMS_SEVERITY_POLICY: '1',
        FAKE_GROK_MODE: 'refute-p2-prova-derrubada',
        FAKE_PROVA_EXIT: '0', // o comando PASSA, mas o achado esperava falha
      },
    });
    assert.equal(result.p2Queued ?? 0, 0, 'achado desmentido nao enfileira');
    await assert.rejects(readFile(join(root, '.lms', 'p2-queue.jsonl'), 'utf8'), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rodada derrubada pelo contraditorio conta na campanha semantica', async () => {
  // Rodada 91: so a reprovacao do revisor primario incrementava semanticRounds,
  // entao campanhas decididas pelo refutador nunca chegavam ao teto/plateau.
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, LMS_SEVERITY_POLICY: '1', FAKE_GROK_MODE: 'refute' },
    });
    assert.equal(result.ok, false);
    const campanha = JSON.parse(
      await readFile(join(root, '.lms', 'severity-campaign.json'), 'utf8'),
    );
    assert.equal(campanha.semanticRounds, 1, 'a rodada do refutador contou');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a sombra roda com teto proprio, que MATA o processo dela', async () => {
  // Rodada 91: a sombra herdava o timeout de reviewer e ficava no caminho
  // critico. Rodada 92: Promise.race so parava de ESPERAR — o processo do Pi
  // seguia vivo com o timer de 15 min e segurava o runner do mesmo jeito. O
  // teto tem de chegar ao runCommand, que e quem mata o filho.
  const { root, env } = await fixture();
  try {
    const tetos = [];
    const collectShadow = async ({ config }) => {
      tetos.push(config.timeoutMs);
      return { kind: 'timeout' };
    };
    const result = await runFallback({
      root,
      base,
      env: { ...env, LMS_PI_SHADOW: '1', LMS_PI_SHADOW_TIMEOUT_SEC: '7' },
      collectShadow,
    });
    assert.equal(result.ok, true, 'a sombra nao decide nada');
    assert.deepEqual(tetos, [7000], 'o teto da sombra vai no config, nao numa corrida');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P2 com confianca invalida ou path sem linha nao entra na fila', async () => {
  // Rodada 92: Number('alto') e NaN e NaN < 80 e false — a checagem antiga
  // deixava passar; sem arquivo:linha a divida nao e rastreavel ate o defeito.
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, LMS_SEVERITY_POLICY: '1', FAKE_GROK_MODE: 'refute-p2-torto' },
    });
    assert.equal(result.p2Queued ?? 0, 0, 'achado torto nao vira debito');
    await assert.rejects(readFile(join(root, '.lms', 'p2-queue.jsonl'), 'utf8'), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a campanha mede os achados do refutador, nao os zeros do aceite', async () => {
  // Rodada 92: o attempt passado e o do revisor ACEITO (contadores zerados);
  // medir o plateau por ele registrava 0 em toda rodada do contraditorio.
  const { root, env } = await fixture();
  try {
    await runFallback({
      root,
      base,
      env: { ...env, LMS_SEVERITY_POLICY: '1', FAKE_GROK_MODE: 'refute-com-extras' },
    });
    const campanha = JSON.parse(
      await readFile(join(root, '.lms', 'severity-campaign.json'), 'utf8'),
    );
    assert.ok(campanha.lastCount > 0, `lastCount deveria contar os achados, veio ${campanha.lastCount}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a sombra sem prova de leitura nao vira segunda opiniao no historico', async () => {
  // Rodada 92: o rotulo saia so de candidate.refuted — um {refuted:false} seco
  // entrava como 'sustentou' e um payload torto como 'refutou', tornando o
  // piloto incomparavel com o refutador real, que passa por todas as validacoes.
  const { root, env } = await fixture();
  try {
    const collectShadow = async () => ({
      kind: 'ok',
      candidate: { refuted: false, confidence: 0 }, // sem inspected, sem campos
    });
    await runFallback({
      root,
      base,
      env: { ...env, LMS_PI_SHADOW: '1' },
      collectShadow,
    });
    const linhas = await historico(root);
    const sombra = linhas.filter((linha) => linha.estagio === 'refutador-sombra');
    assert.equal(sombra.length, 1);
    assert.equal(sombra[0].resultado, 'shadow-invalid-output');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('falha tecnica de provider nao conta como rodada semantica', async () => {
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: {
        ...env,
        LMS_SEVERITY_POLICY: '1',
        FAKE_CLAUDE_MODE: 'exit',
        FAKE_GROK_MODE: 'exit',
        FAKE_CODEX_MODE: 'exit',
      },
    });
    assert.equal(result.ok, false);
    await assert.rejects(readFile(join(root, '.lms', 'severity-campaign.json'), 'utf8'), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plateau para apos duas rodadas sem melhora e manda escalar', async () => {
  const { root, env } = await fixture();
  try {
    const collect = async () => ({ kind: 'ok', candidate: scorecardComAchados('P1', 2) });
    const resultados = [];
    for (let rodada = 0; rodada < 3; rodada += 1) {
      resultados.push(
        await runFallback({
          root,
          base,
          env: { ...env, LMS_SEVERITY_POLICY: '1' },
          collect,
        }),
      );
    }
    assert.equal(resultados[1].escalated, undefined);
    assert.equal(resultados[2].escalated, true);
    assert.match(resultados[2].reason, /plateau.*Master/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('teto de quatro rodadas escala sem liberar P1 pendente', async () => {
  const { root, env } = await fixture();
  try {
    const contagens = [4, 3, 2, 1];
    const resultados = [];
    for (const count of contagens) {
      const collect = async () => ({ kind: 'ok', candidate: scorecardComAchados('P1', count) });
      resultados.push(
        await runFallback({
          root,
          base,
          env: { ...env, LMS_SEVERITY_POLICY: '1' },
          collect,
        }),
      );
    }
    const teto = resultados.at(-1);
    assert.equal(teto.ok, false);
    assert.equal(teto.escalated, true);
    assert.match(teto.reason, /teto de 4.*Master/i);
    const gravado = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
    assert.equal(gravado.p1, 1, 'teto nao apaga P1 nem autoriza publicacao');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('o contraditorio derruba um 5/5 e o scorecard gravado passa a bloquear', async () => {
  const { root, env } = await fixture();
  try {
    // claude falha, grok aceita 5/5, codex entra como contraditorio e refuta.
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute' },
    });

    assert.equal(result.ok, false, 'refutacao com confianca >= 80 deve bloquear');
    assert.equal(result.rejectedBy, 'codex');
    assert.match(result.reason ?? '', /contraditorio derrubou/);

    // O que fica no disco tem de BLOQUEAR: deixar o aceite gravado liberaria o push
    // na tentativa seguinte, e a refutacao teria sido decorativa.
    const gravado = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
    assert.equal(gravado.score, 4);
    assert.equal(gravado.p1, 1);
    assert.equal(gravado.lenses['code-quality'].p1, 1);
    assert.equal(gravado.findings.at(-1).refutedBy, 'codex');

    // E o historico registra o desfecho, que e o sinal para ver reviewer complacente.
    assert.equal(
      (await historico(root)).some((linha) => linha.result === 'refuted'),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('achado concreto ancorado no diff derruba mesmo sem inspected', async () => {
  const { root, env } = await fixture();
  try {
    // Antes isto virava payload-incompleto: bloqueava igual, mas queimava a
    // rodada e o estado ficava "sem segunda opiniao". Achado com severity,
    // path (arquivo do diff) e why especificos E evidencia de leitura.
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute-ancorado-sem-inspected' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.rejectedBy, 'codex');
    assert.equal(
      (await historico(root)).some((linha) => linha.result === 'refuted'),
      true,
    );
    const gravado = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
    assert.equal(gravado.score, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inspected inventado nao ganha o passe da ancora', async () => {
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute-inspected-falso' },
    });
    // bloqueia (fail-closed), mas NAO como refutacao valida: prova falsa
    // detectada nao pode gravar scorecard de refutacao.
    assert.equal(result.ok, false);
    assert.equal(
      (await historico(root)).some((l) => l.result === 'refuted'),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extra_findings entram todos no scorecard numa unica rodada', async () => {
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute-com-extras' },
    });
    assert.equal(result.ok, false);
    const gravado = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
    // principal (P1 quality) + extra P0 safety + extra P2 (severidade REAL)
    const refutados = gravado.findings.filter((f) => f.refutedBy === 'codex');
    assert.equal(refutados.length, 3, 'todos os achados da rodada persistem');
    assert.equal(gravado.p0, 1);
    assert.equal(gravado.lenses['code-safety'].p0, 1);
    assert.equal(gravado.p1, 1);
    assert.equal(gravado.p2, 1, 'P2 permanece P2 — nao e promovido');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('falha do contraditorio bloqueia e nao vira consenso no historico', async () => {
  const { root, env } = await fixture();
  try {
    // grok aceita; o contraditorio (codex) nem roda — binario ausente.
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', LMS_CODEX_BIN: join(root, 'missing-codex') },
    });

    // Nao conseguir segunda opiniao BLOQUEIA: o mesmo principio do fallow — nao medir
    // nao vira aprovacao. Liberar aqui seria fail-open no unico ponto que existe para
    // impedir que um aceite passe sozinho.
    assert.equal(result.ok, false, 'sem segunda opiniao nao se publica');
    assert.equal(result.uncontested, true);
    assert.match(result.reason ?? '', /sem segunda opiniao/);
    // Caso 1 de KDT-94: refutador NAO RESPONDEU — a mensagem diz isso e diz que
    // nenhum achado foi perdido, em vez de induzir ao bypass.
    assert.match(result.reason ?? '', /nao chegou a responder/);
    const contraditorio = (await historico(root)).at(-1);
    assert.equal(contraditorio.provider, 'codex');
    assert.notEqual(contraditorio.result, 'upheld', 'CLI ausente nao e concordancia');
    assert.equal(contraditorio.result, 'missing-cli');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refutador sem prova de leitura nao conta como segunda opiniao', async () => {
  const { root, env } = await fixture();
  try {
    // O codex entra como contraditorio e responde `{refuted:false}` seco, sem ter
    // aberto arquivo nenhum. Isso NAO pode autorizar: contraditorio de fachada e
    // pior que nenhum, porque parece rigor.
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute-sem-prova' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.uncontested, true);
    assert.match(result.reason ?? '', /invalid-output/);
    // Caso 2 de KDT-94: respondeu lixo irrecuperavel — nao havia achado no payload,
    // e a mensagem diz isso em vez de deixar duvida sobre conteudo perdido.
    assert.match(result.reason ?? '', /nenhum achado foi perdido/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('campo secundario ausente nao destroi a refutacao: o achado derruba o 5/5', async () => {
  const { root, env } = await fixture();
  try {
    // O refutador mandou so o essencial: refuted, severity, path, why, inspected.
    // Sem fix, title, confidence e lens — e o achado vale mesmo assim: confianca
    // ausente assume o piso, lens e title tem default. Antes isto virava weak-refute
    // e o conteudo era descartado em silencio.
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute-so-essencial' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.rejectedBy, 'codex');
    assert.match(result.reason ?? '', /contraditorio derrubou/);
    assert.match(result.reason ?? '', /a\.ts:1/, 'o achado aparece com os campos que vieram');
    const gravado = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
    assert.equal(gravado.score, 4);
    assert.equal(gravado.findings.at(-1).refutedBy, 'codex');
    await assertUltimoResultado(root, 'refuted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('payload incompleto preserva o achado, bloqueia e diz o que fazer', async () => {
  const { root, env } = await fixture();
  try {
    // Caso 3 de KDT-94: o refutador ENCONTROU algo mas faltou `severity`
    // (obrigatorio). Continua fail-closed — mas o desfecho e distinto de lixo e a
    // mensagem carrega o achado, em vez de culpar a ferramenta e induzir ao bypass.
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute-incompleto' },
    });
    assert.equal(result.ok, false, 'payload incompleto continua bloqueando');
    assert.equal(result.uncontested, true);
    assert.match(result.reason ?? '', /payload-incompleto/);
    assert.match(result.reason ?? '', /ENCONTROU/);
    assert.match(result.reason ?? '', /veio sem: severity/);
    assert.match(
      result.reason ?? '',
      /furo de autorizacao real/,
      'o achado e mostrado ao operador',
    );
    assert.equal((await historico(root)).at(-1).result, 'payload-incompleto');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refutacao so com titulo nao bloqueia: titulo e rotulo, nao evidencia', async () => {
  const { root, env } = await fixture();
  try {
    // Achado do contraditorio sobre o proprio KDT-94: como `payload-incompleto`
    // BLOQUEIA, aceitar titulo como "conteudo real" transformaria a saida vazia
    // tipica de um modelo — {refuted:true, title:"..."} — em gate travado. Conteudo
    // real e apontar ONDE (path) ou POR QUE (why).
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute-so-titulo' },
    });

    assert.equal(result.ok, true, 'titulo solto nao pode indisponibilizar o gate');
    assert.equal((await historico(root)).at(-1).result, 'weak-refute');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refutacao sem defeito concreto nao bloqueia mudanca sa', async () => {
  const { root, env } = await fixture();
  try {
    const result = await runFallback({
      root,
      base,
      env: { ...env, FAKE_CLAUDE_MODE: 'exit', FAKE_CODEX_MODE: 'refute-vazio' },
    });

    // Alegar defeito sem apontar qual nao pode derrubar: seria indisponibilidade do
    // gate por alegacao vazia, espelho do problema que a prova de leitura resolve.
    assert.equal(result.ok, true, 'alegacao vazia nao derruba');
    assert.equal((await historico(root)).at(-1).result, 'weak-refute');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refutacao alucinada cai quando a propria prova a desmente', async () => {
  const { root, env } = await fixture();
  try {
    // O refutador alega "a suite quebra" e indica o comando. O comando passa (exit 0),
    // entao a alegacao se desmente sozinha e o aceite segue. Foi exatamente este o
    // caso real: "oito falhas" sobre uma suite que passava 34/34, sem apelacao.
    const result = await runFallback({
      root,
      base,
      env: {
        ...env,
        FAKE_CLAUDE_MODE: 'exit',
        FAKE_CODEX_MODE: 'refute-com-prova',
        FAKE_PROVA_EXIT: '0',
      },
    });
    assert.equal(result.ok, true, 'alegacao desmentida pela propria prova nao bloqueia');
    assert.equal((await historico(root)).at(-1).result, 'refutacao-nao-comprovada');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refutacao com prova que se sustenta bloqueia', async () => {
  const { root, env } = await fixture();
  try {
    // Mesmo veredito, mas agora o comando falha de verdade: a alegacao se sustenta e
    // o push e bloqueado. A apelacao nao pode virar escotilha para ignorar defeito.
    const result = await runFallback({
      root,
      base,
      env: {
        ...env,
        FAKE_CLAUDE_MODE: 'exit',
        FAKE_CODEX_MODE: 'refute-com-prova',
        FAKE_PROVA_EXIT: '1',
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.rejectedBy, 'codex');
    await assertUltimoResultado(root, 'refuted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refutador do MESMO provider so com opt-in explicito e sem alternativa', async () => {
  const { escolherRefutador } = await import('./lms-reviewer-fallback.mjs');
  const base = { ordem: ['grok', 'claude'], provider: 'claude', autor: 'fable' };
  const attempts = [
    { provider: 'grok', result: 'timeout', durationMs: 1 },
    { provider: 'claude', result: 'accepted', durationMs: 1 },
  ];
  // Sem a env: fail-closed de sempre — aceite morre sem-refutador.
  assert.equal(escolherRefutador({ ...base, attempts, env: {} }), undefined);
  // Com a env: o unico provider vivo refuta a si mesmo (decisao do Master, apagao
  // de cota dupla). Nunca rouba a vez de um refutador cruzado vivo:
  assert.equal(
    escolherRefutador({ ...base, attempts, env: { LMS_REFUTADOR_MESMO_PROVIDER: '1' } }),
    'claude',
  );
  const comGrokVivo = [{ provider: 'claude', result: 'accepted', durationMs: 1 }];
  assert.equal(
    escolherRefutador({ ...base, attempts: comGrokVivo, env: { LMS_REFUTADOR_MESMO_PROVIDER: '1' } }),
    'grok',
  );
});

// P1-4 da revisao da Fase 3: a prova roda EM GRUPO — o timeout que mata so o `sh`
// deixava o runner de teste (pnpm/vitest) orfao queimando CPU ate o fim da sessao.
test('verificarProva mata o grupo no timeout — o neto nao sobrevive (P1-4)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-prova-grupo-'));
  await mkdir(join(root, 'scripts'), { recursive: true });
  const alvo = join(root, 'neto-sobreviveu.txt');
  // A prova (allowlist: node scripts/...) cria um NETO no MESMO grupo (como um
  // runner de teste real faz) que escreve a sentinela depois de 1.2 s; o pai
  // fica vivo e o timeout de 300 ms mata o grupo inteiro.
  await writeFile(join(root, 'scripts', 'neto.mjs'), [
    "import { spawn } from 'node:child_process';",
    `spawn('sh', ['-c', 'sleep 1.2 && touch "$ALVO"'], { stdio: 'ignore' });`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const prova = await verificarProva(
    root,
    { command: 'node scripts/neto.mjs', expect: 'fail' },
    { ALVO: alvo, LMS_PROVA_TIMEOUT_MS: '300' },
  );
  assert.equal(prova, 'confirmada', 'timeout conta como saida nao-zero (expect fail)');
  await new Promise((r) => setTimeout(r, 2_000));
  const sobreviveu = await stat(alvo).then(() => true, () => false);
  assert.equal(sobreviveu, false, 'neto sobreviveu ao timeout da prova');
});

// P2-6 da revisao da Fase 3: a serializacao multiplicou o pior caso do estagio
// (5 x BOOT+TIMEOUT do tmux). Orcamento proprio: estourou, o restante sai
// CONFIRMED com motivo de teto — mesmo tratamento do excedente de MAX_VERIFICACOES.
test('teto de tempo do estagio de verificacao (P2-6)', async () => {
  const { root, env, scorecardValido } = await fixture();
  try {
    const achados = [
      { id: 'aaa000', lens: 'code-safety', severity: 'P1', confidence: 90,
        path: 'a.ts:1', title: 'primeiro achado', why: 'w', verdict: 'PLAUSIBLE', verdict_by: 'codex' },
      { id: 'bbb111', lens: 'code-quality', severity: 'P2', confidence: 85,
        path: 'b.ts:1', title: 'segundo achado', why: 'w', verdict: 'PLAUSIBLE', verdict_by: 'codex' },
    ];
    const collect = async ({ provider, prompt }) => {
      if (prompt.includes('DEMOLISH')) {
        await new Promise((r) => setTimeout(r, 60)); // cada verificacao custa 60ms
        return { kind: 'ok', candidate: { id: 'x', verdict: 'CONFIRMED', why: 'reproduzi' } };
      }
      if (provider === 'claude') {
        return { kind: 'ok', candidate: { ...scorecardValido, findings: achados } };
      }
      return { kind: 'ok', candidate: { refuted: false, confidence: 0, inspected: provaDeLeituraFixture } };
    };
    const r = await runFallback({ root, base, env: { ...env, LMS_VERIFY_BUDGET_MS: '20' }, collect });
    assert.equal(r.ok, true);
    const gravado = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
    const porId = new Map(gravado.findings.map((f) => [f.id, f]));
    assert.equal(porId.get('aaa000').verdict, 'CONFIRMED', 'o primeiro coube no orcamento');
    assert.match(porId.get('bbb111').verdict_why, /teto de tempo/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
