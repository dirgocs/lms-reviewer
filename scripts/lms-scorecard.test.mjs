import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { coverageDiffError, comIdsDeAchado, findingsShapeError, findingId, scorecardError, scorecardFormError, validateScorecard } from './lms-scorecard.mjs';

const now = Date.parse('2026-07-10T00:00:00.000Z');
const options = {
  reviewer: 'grok',
  base: 'origin/master',
  now,
  maxAgeSec: 7200,
};

function validScorecard(reviewer = 'grok') {
  return {
    reviewer,
    score: 5,
    target: 5,
    base: 'origin/master',
    p0: 0,
    p1: 0,
    p2: 0,
    lenses: {
      'code-safety': { p0: 0, p1: 0, p2: 0 },
      'code-structure': { p0: 0, p1: 0, p2: 0 },
      'code-quality': { p0: 0, p1: 0, p2: 0 },
      'code-efficiency': { p0: 0, p1: 0, p2: 0 },
    },
    at: '2026-07-09T23:30:00.000Z',
    autonomy: 'reviewer',
    fallow: 'pass',
    coverage: [{ surface: 'arquivos alterados', total: 3, inspected: 3 }],
    verified: [
      { claim: 'o envelope resolve o tenant a partir do JWT', path: 'a.ts', line: 1, quote: 'linha citada verbatim' },
    ],
    inspected: [{ path: 'a.ts', line: 1, quote: 'linha citada verbatim' }],
  };
}

test('o exemplo do schema publicado passa no validador', async () => {
  const schema = JSON.parse(
    await readFile(
      new URL('../skills/local-merge-score/references/scorecard.schema.json', import.meta.url),
    ),
  );
  const exemplo = schema.examples[0];
  assert.equal(
    scorecardFormError(exemplo, {
      reviewer: exemplo.reviewer,
      base: exemplo.base,
      now: Date.parse(exemplo.at) + 1000,
    }),
    null,
  );
});

// P2-2/P2-3 da revisao da Fase 1: o schema e documentacao executavel, entao as
// restricoes que o validador aplica precisam aparecer no schema — os pontos onde
// ja tinham divergido ficam travados aqui.
test('o schema publica as MESMAS restricoes do validador', async () => {
  const schema = JSON.parse(
    await readFile(
      new URL('../skills/local-merge-score/references/scorecard.schema.json', import.meta.url),
    ),
  );
  const { verified, citation, lens, coverage } = schema.$defs;
  // (a) claim obrigatorio e >= 20 chars SO em verified; citation (inspected) nao pede
  assert.ok(verified.required.includes('claim'));
  assert.equal(verified.properties.claim.minLength, 20);
  assert.equal(citation.required.includes('claim'), false);
  // (b) arrays de citacao nao aceitam vazio
  for (const campo of ['verified', 'inspected']) {
    assert.equal(schema.properties[campo].minItems, 1);
  }
  // (c) fallow e exigido pelo gate de publicacao
  assert.ok(schema.required.includes('fallow'));
  // (d)+(e) applicable e booleano e, quando false, exige na_reason >= 15
  assert.equal(lens.properties.applicable.type, 'boolean');
  assert.deepEqual(lens.dependentRequired, { applicable: ['na_reason'] });
  assert.equal(lens.properties.na_reason.minLength, 15);
  // (f) superficie nomeada
  assert.equal(coverage.properties.surface.minLength, 3);
  // (g) validador ignora lentes desconhecidas — o schema nao pode ser mais estrito
  assert.equal(schema.properties.lenses.additionalProperties, undefined);
});

test('exige coverage', () => {
  const { coverage: _coverage, ...semCoverage } = validScorecard();
  assert.match(scorecardFormError(semCoverage, options), /coverage/);
});

test('recusa coverage com inspected maior que total', () => {
  const card = validScorecard();
  card.coverage = [{ surface: 'rotas', total: 3, inspected: 4 }];
  assert.match(scorecardFormError(card, options), /inspected .* total/);
});

test('recusa superficie sem descricao', () => {
  const card = validScorecard();
  card.coverage = [{ surface: '  ', total: 3, inspected: 3 }];
  assert.match(scorecardFormError(card, options), /surface/);
});

test('aceita coverage bem formado', () => {
  assert.equal(scorecardFormError(validScorecard(), options), null);
});

// P2-4 da revisao da Fase 1: esforco zero nao satisfaz o denominador.
test('recusa coverage que declara esforco zero', () => {
  const card = validScorecard();
  card.coverage = [{ surface: 'rotas do envelope', total: 0, inspected: 0 }];
  assert.match(scorecardFormError(card, options), /total >= 1/);
});

test('exige verified com pelo menos uma asercao', () => {
  const { verified: _verified, ...sem } = validScorecard();
  assert.match(scorecardFormError(sem, options), /verified/);
});

test('recusa asercao sem texto de claim', () => {
  const card = validScorecard();
  card.verified = [{ claim: 'ok', path: 'a.ts', line: 1, quote: 'linha citada verbatim' }];
  assert.match(scorecardFormError(card, options), /claim/);
});

test('aceita lente declarada inaplicavel com motivo', () => {
  const card = validScorecard();
  card.lenses['code-efficiency'] = {
    p0: 0, p1: 0, p2: 0,
    applicable: false,
    na_reason: 'diff toca apenas documentacao; nao ha caminho de execucao',
  };
  assert.equal(scorecardFormError(card, options), null);
});

test('recusa lente inaplicavel sem motivo', () => {
  const card = validScorecard();
  card.lenses['code-efficiency'] = { p0: 0, p1: 0, p2: 0, applicable: false };
  assert.match(scorecardFormError(card, options), /na_reason/);
});

test('recusa lente inaplicavel que ainda reporta achado', () => {
  const card = validScorecard();
  card.lenses['code-efficiency'] = {
    p0: 0, p1: 1, p2: 0, applicable: false, na_reason: 'nao se aplica a este diff',
  };
  card.p1 = 1;
  assert.match(scorecardFormError(card, options), /applicable: false/);
});

const achado = () => ({
  lens: 'code-safety', severity: 'P1', confidence: 90,
  path: 'src/a.ts:42', title: 'falta filtro de tenant',
  why: 'a query nao escopa por tenant', fix: 'somar tenantId ao where',
});

test('findingId ignora o numero da linha', () => {
  const a = findingId(achado());
  const b = findingId({ ...achado(), path: 'src/a.ts:45' });
  assert.equal(a, b);
});

test('findingId muda quando o titulo muda', () => {
  assert.notEqual(findingId(achado()), findingId({ ...achado(), title: 'outro defeito' }));
});

test('recusa severidade fora de P0/P1/P2', () => {
  assert.match(findingsShapeError({ findings: [{ ...achado(), severity: 'CRITICAL' }] }), /severity/);
});

test('recusa confidence fora de 0-100', () => {
  assert.match(findingsShapeError({ findings: [{ ...achado(), confidence: 140 }] }), /confidence/);
});

test('aceita precondition e acceptance opcionais', () => {
  assert.equal(
    findingsShapeError({
      findings: [{ ...achado(), precondition: 'so com LMS_FIX_MODE=reviewer', acceptance: ['teste X passa'] }],
    }),
    null,
  );
});

test('aceita ausencia de findings quando nao ha achado', () => {
  assert.equal(findingsShapeError({ findings: [] }), null);
  assert.equal(findingsShapeError({}), null);
});

test('accepts a fresh 5/5 scorecard with zero findings', () => {
  assert.equal(validateScorecard(validScorecard(), options), true);
});

test('rejects a stale scorecard', () => {
  assert.equal(
    validateScorecard(
      { ...validScorecard(), at: '2026-07-09T20:00:00.000Z' },
      options,
    ),
    false,
  );
});

test('rejects score 5 when any aggregate finding remains', () => {
  assert.equal(validateScorecard({ ...validScorecard(), p1: 1 }, options), false);
});

test('rejects a provider mismatch', () => {
  assert.equal(
    validateScorecard({ ...validScorecard(), reviewer: 'claude' }, options),
    false,
  );
});

test('rejects malformed values and missing lenses', () => {
  assert.equal(validateScorecard({ score: 5 }, options), false);
});

test('accepts a merge-base SHA as the base identity', () => {
  assert.equal(
    validateScorecard(
      { ...validScorecard(), base: 'abc123def456' },
      { ...options, base: 'abc123def456' },
    ),
    true,
  );
});

test('achado rebaixado a PLAUSIBLE com verificador independente nao bloqueia', () => {
  const card = { ...validScorecard(), score: 5, p0: 0, p1: 1, p2: 0 };
  card.lenses['code-safety'] = { p0: 0, p1: 1, p2: 0 };
  card.findings = [{ id: 'x', lens: 'code-safety', severity: 'P1', confidence: 85,
    path: 'a.ts:1', title: 't', why: 'w', verdict: 'PLAUSIBLE', verdict_by: 'codex', verdict_why: 'nao reproduzi' }];
  assert.equal(validateScorecard(card, options), true);
});

// P1-3 da revisao da Fase 2: `verdict` sem procedencia nao absolve — o proprio
// revisor nao pode se auto-absolver escrevendo PLAUSIBLE no proprio scorecard.
test('PLAUSIBLE sem verdict_by independente bloqueia (P1-3)', () => {
  const card = { ...validScorecard(), score: 5, p0: 0, p1: 1, p2: 0 };
  card.lenses['code-safety'] = { p0: 0, p1: 1, p2: 0 };
  card.findings = [{ id: 'x', lens: 'code-safety', severity: 'P1', confidence: 85,
    path: 'a.ts:1', title: 't', why: 'w', verdict: 'PLAUSIBLE' }];
  assert.equal(validateScorecard(card, options), false);
});

test('verdict_by igual ao revisor nao absolve (P1-3)', () => {
  const card = validScorecard();
  card.findings = [{ id: 'x', lens: 'code-safety', severity: 'P1', confidence: 85,
    path: 'a.ts:1', title: 't', why: 'w', verdict: 'PLAUSIBLE', verdict_by: 'grok' }];
  assert.equal(validateScorecard(card, options), false);
});

test('achado sem verdict conta como CONFIRMED e bloqueia', () => {
  const card = { ...validScorecard(), score: 5, p0: 0, p1: 1, p2: 0 };
  card.lenses['code-safety'] = { p0: 0, p1: 1, p2: 0 };
  card.findings = [{ id: 'x', lens: 'code-safety', severity: 'P1', confidence: 85,
    path: 'a.ts:1', title: 't', why: 'w' }];
  assert.equal(validateScorecard(card, options), false);
});

// P1-1 da revisao da Fase 1 (REVIEW-FASE1-OPUS.md): contadores zerados NAO
// escondem achado listado. O conserto aterrissou em fb4f6ba (veredito le a
// lista); o teste trava a regressao do cenario exato da revisao.
test('achado P0 listado com contadores zerados bloqueia (P1-1)', () => {
  const card = validScorecard();
  card.findings = [{ severity: 'P0', confidence: 99, path: 'src/x.ts:1',
    title: 'rce', why: 'exec de input do usuario' }];
  assert.equal(validateScorecard(card, options), false);
});

test('achado CONFIRMED bloqueia mesmo com agregado coerente (P1-1)', () => {
  const card = validScorecard();
  card.findings = [{ id: 'x', lens: 'code-safety', severity: 'P1', confidence: 95,
    path: 'a.ts:1', title: 'falta tenant', why: 'w', verdict: 'CONFIRMED' }];
  assert.equal(validateScorecard(card, options), false);
});

// P3 da revisao da Fase 1: endurecimento barato do validador.
test('score tem teto 5 (P3-2)', () => {
  assert.equal(validateScorecard({ ...validScorecard(), score: 99 }, options), false);
});

test('applicable nao-booleano e reprovado (P3-3)', () => {
  const card = validScorecard();
  card.lenses['code-efficiency'] = {
    p0: 0, p1: 0, p2: 0,
    applicable: 'false', na_reason: 'diff so de documentacao aqui',
  };
  assert.match(scorecardFormError(card, options), /applicable/);
});

test('achado com lens ausente ou desconhecida e reprovado (P3-4)', () => {
  const achado = { severity: 'P1', confidence: 90, path: 'a.ts:1', title: 't', why: 'w' };
  assert.match(findingsShapeError({ findings: [achado] }), /lens/);
  assert.match(findingsShapeError({ findings: [{ ...achado, lens: 'security' }] }), /lens/);
  assert.equal(
    findingsShapeError({ findings: [{ ...achado, lens: 'code-safety' }] }),
    null,
  );
});

// P2-4: alguma superficie declarada tem de cobrir o diff inteiro.
test('exige uma superficie que cubra o diff (P2-4)', () => {
  const card = validScorecard();
  card.coverage = [{ surface: 'rotas do envelope', total: 2, inspected: 2 }];
  assert.match(coverageDiffError(card, new Set(['a.ts', 'b.ts', 'c.ts'])), /3 changed file/);
  assert.equal(coverageDiffError(validScorecard(), new Set(['a.ts', 'b.ts', 'c.ts'])), null);
  assert.equal(coverageDiffError(validScorecard(), new Set()), null);
});

// Task extra da Fase 4 (KDT-68, LMS 1.2.0): score precisa ser coerente com a
// severidade — grok devolveu score 4 com p1=5 e o validador de forma aceitou,
// queimando a cadeia em vez de devolver o erro nomeado para a retentativa.
test('score 4 com p1=5 CONFIRMED reprovado nomeando o campo (KDT-68)', () => {
  const card = { ...validScorecard(), score: 4, p1: 5 };
  card.lenses['code-safety'] = { p0: 0, p1: 3, p2: 0 };
  card.lenses['code-quality'] = { p0: 0, p1: 2, p2: 0 };
  card.findings = Array.from({ length: 5 }, (_, i) => ({
    id: `k${i}`, lens: 'code-safety', severity: 'P1', confidence: 90,
    path: `a.ts:${i + 1}`, title: `achado ${i}`, why: 'w',
  }));
  // A regra vive no VEREDITO (scorecardError): na forma, rejeitar deixaria o
  // proximo provider publicar 5/5 limpo e o P1 gravado se perderia.
  assert.match(scorecardError(card, options), /score must be <= 3/);
  assert.match(scorecardError(card, options), /p1=5/);
});

test('score 5 com P2 CONFIRMED reprovado nomeando p2 (Task extra)', () => {
  const card = { ...validScorecard(), score: 5, p2: 1 };
  card.lenses['code-quality'] = { p0: 0, p1: 0, p2: 1 };
  card.findings = [{ id: 'x', lens: 'code-quality', severity: 'P2', confidence: 90,
    path: 'a.ts:1', title: 't', why: 'w' }];
  assert.match(scorecardError(card, options), /score must be <= 4/);
  assert.match(scorecardError(card, options), /p2=1/);
});

test('score coerente com a severidade passa na forma (Task extra)', () => {
  const card3 = { ...validScorecard(), score: 3, p1: 1 };
  card3.lenses['code-safety'] = { p0: 0, p1: 1, p2: 0 };
  card3.findings = [{ id: 'x', lens: 'code-safety', severity: 'P1', confidence: 90,
    path: 'a.ts:1', title: 't', why: 'w' }];
  assert.equal(scorecardFormError(card3, options), null);

  const card4 = { ...validScorecard(), score: 4, p2: 1 };
  card4.lenses['code-quality'] = { p0: 0, p1: 0, p2: 1 };
  card4.findings = [{ id: 'x', lens: 'code-quality', severity: 'P2', confidence: 90,
    path: 'a.ts:1', title: 't', why: 'w' }];
  assert.equal(scorecardFormError(card4, options), null);
});

test('PLAUSIBLE nao pesa no score — backlog nao pontua (Task extra)', () => {
  const card = { ...validScorecard(), score: 5, p1: 1 };
  card.lenses['code-safety'] = { p0: 0, p1: 1, p2: 0 };
  card.findings = [{ id: 'x', lens: 'code-safety', severity: 'P1', confidence: 85,
    path: 'a.ts:1', title: 't', why: 'w', verdict: 'PLAUSIBLE', verdict_by: 'codex' }];
  assert.equal(scorecardFormError(card, options), null);
});

// Fase 4 Task 6: o achado estrutural da classe recorrente (id proprio
// 'classe:...', recurrence, acceptance de teste de classe) passa na forma.
test('findingsShapeError aceita o achado estrutural da classe recorrente (Task 6)', () => {
  const sintetico = {
    id: 'classe:code-safety:services/api', lens: 'code-safety', severity: 'P1',
    confidence: 100, path: 'services/api/', title: 'classe recorrente: code-safety em services/api',
    why: 'reincidiu em 3 rodadas', found_by: 'runner',
    acceptance: ['um teste que feche a CLASSE — corrigir so as ocorrencias nao fecha'],
    recurrence: { rounds: 3, ids: ['a', 'b', 'c'] },
  };
  assert.equal(findingsShapeError({ findings: [sintetico] }), null);
});

// P2-6 da revisao da Fase 4: `closed` PRECISA remover o achado da lista
// bloqueante — cruzando last.json x reverificacao.json pelo subject, sem mexer
// em score/agregado. Sem o cruzamento, a re-verificacao nao serve para nada.
test('gate ignora achado fechado pela re-verificação, cruzando pelo subject (P2-6)', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { reviewSubject } = await import('./lms-subject.mjs');
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const rodarCli = async (rootDir) => {
    const { promisify } = await import('node:util');
    const cli = join(dirname(fileURLToPath(import.meta.url)), 'lms-scorecard.mjs');
    return promisify(execFile)(
      process.execPath,
      [cli, '--file', join(rootDir, '.lms', 'last.json'), '--base', 'HEAD~1'],
      { cwd: rootDir },
    )
      .then((r) => ({ ...r, code: 0 }))
      .catch((e) => ({ ...e, code: e.code ?? 1 }));
  };

  const root = await mkdtemp(join(tmpdir(), 'lms-gate-p26-'));
  const git = (args) => promisify(execFile)('git', args, { cwd: root });
  await writeFile(join(root, '.gitignore'), '.lms/\n');
  await git(['init', '-q']);
  await git(['config', 'user.email', 'lms@test'], { cwd: root });
  await git(['config', 'user.name', 'lms'], { cwd: root });
  await writeFile(join(root, 'a.ts'), 'const original = 1;\n');
  await git(['add', '.'], { cwd: root });
  await git(['commit', '-qm', 'base'], { cwd: root });
  await writeFile(join(root, 'a.ts'), 'const original = 2;\n');
  await git(['add', '.']);
  await git(['commit', '-qm', 'fix']);

  const subject = await reviewSubject(root, 'HEAD~1');
  const card = {
    reviewer: 'grok', score: 5, target: 5, base: 'HEAD~1', subject,
    p0: 0, p1: 1, p2: 0,
    lenses: {
      'code-safety': { p0: 0, p1: 1, p2: 0 },
      'code-structure': { p0: 0, p1: 0, p2: 0 },
      'code-quality': { p0: 0, p1: 0, p2: 0 },
      'code-efficiency': { p0: 0, p1: 0, p2: 0 },
    },
    at: new Date().toISOString(), autonomy: 'reviewer', fallow: 'pass',
    coverage: [{ surface: 'arquivos alterados', total: 1, inspected: 1 }],
    verified: [{ claim: 'o fix troca o valor da constante', path: 'a.ts', line: 1, quote: 'const original = 2;' }],
    inspected: [{ path: 'a.ts', line: 1, quote: 'const original = 2;' }],
    findings: [{ id: 'f1', lens: 'code-safety', severity: 'P1', confidence: 90,
      path: 'a.ts:1', title: 'valor errado', why: 'w' }],
  };
  await mkdir(join(root, '.lms'), { recursive: true });
  await writeFile(join(root, '.lms', 'last.json'), JSON.stringify(card));

  // Sem re-verificação: o P1 CONFIRMED bloqueia.
  const antes = await rodarCli(root);
  assert.equal(antes.code, 1, 'P1 CONFIRMED bloqueia sem re-verificacao');

  // Re-verificação fechou f1, mesmo subject: o gate passa a ignorá-lo.
  await writeFile(join(root, '.lms', 'reverificacao.json'), JSON.stringify({
    subject, reviewer: 'codex', fechados: ['f1'], abertos: [], results: [],
  }));
  const depois = await rodarCli(root);
  assert.equal(depois.code, 0, `achado fechado nao deve bloquear: ${depois.stderr || depois.stdout}`);

  // Subject diferente NAO cruza: o bloqueio volta.
  await writeFile(join(root, '.lms', 'reverificacao.json'), JSON.stringify({
    subject: 'outro-subject', reviewer: 'codex', fechados: ['f1'], abertos: [], results: [],
  }));
  const terceiro = await rodarCli(root);
  assert.equal(terceiro.code, 1, 'subject diferente nao cruza');
});

// 1.4.1 defeito 2 (visto nas lanes do Karibu): achados do candidato chegavam sem
// `id`, e sem id nao ha como selecionar achado para re-verificar. O id e DERIVADO
// (findingId), nunca julgado pelo modelo — entao da para preencher o que faltou.
test('comIdsDeAchado deriva o id que falta e preserva o que ja existe (1.4.1)', () => {
  const scorecard = {
    score: 4,
    findings: [
      { lens: 'code-safety', path: 'a.ts:10', title: 'sem filtro de tenant', why: 'x' },
      { lens: 'code-quality', path: 'b.ts:2', title: 'nome ruim', why: 'y', id: 'jaTinha1234' },
    ],
  };
  const comIds = comIdsDeAchado(scorecard);
  assert.equal(comIds.findings[0].id, findingId(scorecard.findings[0]), 'id derivado do achado');
  assert.equal(comIds.findings[1].id, 'jaTinha1234', 'id existente nao e sobrescrito');
  assert.notEqual(comIds, scorecard, 'nao muta o original');
});

test('comIdsDeAchado aguenta scorecard sem findings (1.4.1)', () => {
  assert.deepEqual(comIdsDeAchado({ score: 5 }).findings, undefined);
  assert.deepEqual(comIdsDeAchado(null), null);
  assert.deepEqual(comIdsDeAchado({ findings: 'nao e lista' }).findings, 'nao e lista');
});
