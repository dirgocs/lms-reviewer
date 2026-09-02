import test from 'node:test';
import assert from 'node:assert/strict';

import { scorecardFormError, validateScorecard } from './lms-scorecard.mjs';

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

test('exige verified com pelo menos uma asercao', () => {
  const { verified: _verified, ...sem } = validScorecard();
  assert.match(scorecardFormError(sem, options), /verified/);
});

test('recusa asercao sem texto de claim', () => {
  const card = validScorecard();
  card.verified = [{ claim: 'ok', path: 'a.ts', line: 1, quote: 'linha citada verbatim' }];
  assert.match(scorecardFormError(card, options), /claim/);
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
