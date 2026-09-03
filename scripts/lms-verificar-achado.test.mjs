import test from 'node:test';
import assert from 'node:assert/strict';

import { aplicarVeredito, verificarPrompt } from './lms-verificar-achado.mjs';

const achado = () => ({
  id: 'abc123', lens: 'code-safety', severity: 'P1', confidence: 90,
  path: 'src/a.ts:42', title: 'falta filtro de tenant', why: 'a query nao escopa',
});

test('CONFIRMED mantem o achado bloqueando', () => {
  const r = aplicarVeredito(achado(), { verdict: 'CONFIRMED', why: 'reproduzi' }, 'nao-verificavel');
  assert.equal(r.verdict, 'CONFIRMED');
});

test('PLAUSIBLE rebaixa sem remover', () => {
  const r = aplicarVeredito(achado(), { verdict: 'PLAUSIBLE', why: 'nao consegui reproduzir' }, 'nao-verificavel');
  assert.equal(r.verdict, 'PLAUSIBLE');
  assert.equal(r.title, achado().title);
});

test('FALSE_POSITIVE sem prova vira CONFIRMED', () => {
  const r = aplicarVeredito(achado(), { verdict: 'FALSE_POSITIVE', why: 'acho que nao' }, 'nao-verificavel');
  assert.equal(r.verdict, 'CONFIRMED');
});

test('FALSE_POSITIVE com prova confirmada vira PLAUSIBLE, nunca sumindo', () => {
  const r = aplicarVeredito(achado(), { verdict: 'FALSE_POSITIVE', why: 'o teste passa' }, 'confirmada');
  assert.equal(r.verdict, 'PLAUSIBLE');
});

test('veredito ausente ou malformado falha fechado', () => {
  assert.equal(aplicarVeredito(achado(), null, 'nao-verificavel').verdict, 'CONFIRMED');
  assert.equal(aplicarVeredito(achado(), { verdict: 'MAYBE' }, 'nao-verificavel').verdict, 'CONFIRMED');
});

test('verificarPrompt inclui o achado e proibe re-revisar', () => {
  const p = verificarPrompt(achado(), 'origin/master', 'src/a.ts');
  assert.match(p, /falta filtro de tenant/);
  assert.match(p, /src\/a\.ts:42/);
  assert.match(p, /CONFIRMED/);
  assert.match(p, /do not review/i);
});
