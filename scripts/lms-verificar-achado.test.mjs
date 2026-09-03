import test from 'node:test';
import assert from 'node:assert/strict';

import { aplicarVeredito, verificarPrompt } from './lms-verificar-achado.mjs';

const achado = () => ({
  id: 'abc123', lens: 'code-safety', severity: 'P1', confidence: 90,
  path: 'src/a.ts:42', title: 'falta filtro de tenant', why: 'a query nao escopa',
});

// P1-2 da revisao da Fase 2: o veredito tem de CARREGAR o id do achado que
// responde. Sem isso, um unico output lido por varias verificacoes rebaixa
// achados que ninguem abriu. Veredito sem id, com id errado, ausente ou
// malformado: falha fechada, o achado continua CONFIRMED.
const veredito = (over = {}) => ({ id: 'abc123', verdict: 'CONFIRMED', why: 'reproduzi', ...over });

test('verificarPrompt inclui o achado e proibe re-revisar', () => {
  const p = verificarPrompt(achado(), 'origin/master', 'src/a.ts');
  assert.match(p, /falta filtro de tenant/);
  assert.match(p, /src\/a\.ts:42/);
  assert.match(p, /CONFIRMED/);
  assert.match(p, /do not review/i);
});

test('CONFIRMED mantem o achado bloqueando', () => {
  const r = aplicarVeredito(achado(), veredito({ why: 'reproduzi' }), 'nao-verificavel');
  assert.equal(r.verdict, 'CONFIRMED');
});

test('veredito com id de outro achado falha fechado (P1-2)', () => {
  const r = aplicarVeredito(
    achado(),
    { id: 'outro-id', verdict: 'PLAUSIBLE', why: 'resposta de outro achado' },
    'confirmada',
  );
  assert.equal(r.verdict, 'CONFIRMED');
});

test('veredito sem id tambem falha fechado (P1-2)', () => {
  const r = aplicarVeredito(achado(), { verdict: 'PLAUSIBLE', why: 'x' }, 'nao-verificavel');
  assert.equal(r.verdict, 'CONFIRMED');
});

test('veredito com id do proprio achado se aplica (P1-2)', () => {
  const r = aplicarVeredito(achado(), veredito({ verdict: 'PLAUSIBLE' }), 'nao-verificavel');
  assert.equal(r.verdict, 'PLAUSIBLE');
});

test('PLAUSIBLE rebaixa sem remover', () => {
  const r = aplicarVeredito(
    achado(),
    veredito({ verdict: 'PLAUSIBLE', why: 'nao consegui reproduzir' }),
    'nao-verificavel',
  );
  assert.equal(r.verdict, 'PLAUSIBLE');
  assert.equal(r.title, achado().title);
});

test('FALSE_POSITIVE sem prova vira CONFIRMED', () => {
  const r = aplicarVeredito(
    achado(),
    veredito({ verdict: 'FALSE_POSITIVE', why: 'acho que nao' }),
    'nao-verificavel',
  );
  assert.equal(r.verdict, 'CONFIRMED');
});

test('FALSE_POSITIVE com prova confirmada vira PLAUSIBLE, nunca sumindo', () => {
  const r = aplicarVeredito(
    achado(),
    { id: 'abc123', verdict: 'FALSE_POSITIVE', why: 'o teste passa' },
    'confirmada',
  );
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

// P2-5 da revisao da Fase 3: no tmux (caminho principal) o candidato so existe se
// o verificador GRAVAR o arquivo — prompt que manda imprimir nunca produzia
// candidato, e o estagio inteiro virava timeout → CONFIRMED.
test('verificarPrompt diz onde gravar quando ha outputPath (P2-5)', () => {
  const p = verificarPrompt(achado(), 'origin/master', 'src/a.ts', '.lms/candidates/grok.json');
  assert.match(p, /\.lms\/candidates\/grok\.json/);
  assert.match(p, /Write EXACTLY ONE JSON object/);

  const sem = verificarPrompt(achado(), 'origin/master');
  assert.doesNotMatch(sem, /Write EXACTLY ONE JSON object/);
});
