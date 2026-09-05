import test from 'node:test';
import assert from 'node:assert/strict';

import { effortPara, effortValido } from './lms-effort.mjs';

test('diff comum revisa em high', () => {
  assert.equal(effortPara(['apps/erp-web/src/components/ui/button.tsx'], {}), 'high');
});

test('caminho de auth/tenant/fiscal sobe para xhigh', () => {
  assert.equal(effortPara(['services/fiscal/backend/app/auth.py'], {}), 'xhigh');
  assert.equal(effortPara(['services/api/src/pos/actor.ts'], {}), 'xhigh');
  assert.equal(effortPara(['services/api/migrations/20260901_rls.sql'], {}), 'xhigh');
});

test('LMS_EFFORT sobrescreve', () => {
  assert.equal(effortPara(['services/fiscal/backend/app/auth.py'], { LMS_EFFORT: 'medium' }), 'medium');
});

test('LMS_EFFORT invalido e ignorado', () => {
  assert.equal(effortPara(['a.ts'], { LMS_EFFORT: 'turbo' }), 'high');
});

// P2-1 da revisao da Fase 2: o raio sobe so o REVISOR. Refutador Fable fica em
// medium (LMS_CLAUDE_EFFORT, decisao do Master 2026-08-19) e nunca herda o raio.
test('papel define o effort do claude (P2-1)', async () => {
  const { commandFor } = await import('./lms-reviewer-fallback.mjs');
  const { providerConfig } = await import('./lms-reviewer-fallback.mjs');
  const config = providerConfig({}, { paths: ['services/fiscal/auth.py'] });
  assert.equal(config.effort, 'xhigh');
  assert.equal(config.claudeEffort, undefined);
  const revisor = commandFor('claude', { models: { claude: 'm' }, bins: { claude: 'b' }, timeoutMs: 1, ...config, papel: 'reviewer' });
  assert.equal(revisor.args[revisor.args.indexOf('--effort') + 1], 'xhigh');
  const refutador = commandFor('claude', {
    models: { claude: 'm' }, bins: { claude: 'b' }, timeoutMs: 1,
    claudeEffort: 'medium',
  });
  assert.equal(refutador.args[refutador.args.indexOf('--effort') + 1], 'medium');
});

// 1.4.3 (politica do Master, 2026-09-05): Grok encerrado; effort por complexidade
// low|medium|high|xhigh, NUNCA max. `max` e rejeitado com mensagem, nao aceito em
// silencio nem propagado ao CLI.
test('LMS_EFFORT aceita low (1.4.3)', () => {
  assert.equal(effortPara(['a.ts'], { LMS_EFFORT: 'low' }), 'low');
});

test('effortValido normaliza e recusa max nomeando a env (1.4.3)', () => {
  const avisos = [];
  const original = console.error;
  console.error = (m) => avisos.push(String(m));
  try {
    assert.equal(effortValido('high', 'LMS_CODEX_EFFORT'), 'high');
    assert.equal(effortValido('  XHigh ', 'LMS_CODEX_EFFORT'), 'xhigh', 'trim e case');
    assert.equal(effortValido('max', 'LMS_CODEX_EFFORT'), null, 'max nunca passa');
    assert.equal(effortValido('turbo', 'LMS_EFFORT'), null);
    assert.equal(effortValido(undefined, 'LMS_EFFORT'), null);
  } finally {
    console.error = original;
  }
  assert.ok(avisos.some((a) => /LMS_CODEX_EFFORT/.test(a) && /max/.test(a)), 'a env e nomeada');
  assert.ok(avisos.some((a) => /low\|medium\|high\|xhigh|low, medium, high, xhigh/.test(a)), 'diz o que vale');
});

test('LMS_EFFORT=max nao vira effort: cai no default do raio (1.4.3)', () => {
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(effortPara(['a.ts'], { LMS_EFFORT: 'max' }), 'high');
    assert.equal(effortPara(['services/fiscal/x.py'], { LMS_EFFORT: 'max' }), 'xhigh');
  } finally {
    console.error = original;
  }
});
