import test from 'node:test';
import assert from 'node:assert/strict';

import { achadoEstrutural, classeDe, classesReincidentes, historicoDeRodadas } from './lms-classe-recorrente.mjs';

const achado = (over = {}) => ({
  id: 'x1', lens: 'code-safety', path: 'services/api/src/routes/rooms.ts:10',
  title: 'query sem tenant', ...over,
});

// Task 5 da Fase 4: a mesma lens no mesmo prefixo de diretorio (dois segmentos)
// em 3 rodadas CONSECUTIVAS vira achado estrutural — "fix the principle, not the
// example" com mecanismo.

test('classeDe usa lens + prefixo de dois segmentos (Task 5)', () => {
  assert.equal(classeDe(achado()), 'code-safety:services/api');
  assert.equal(classeDe(achado({ path: 'a.ts:1' })), 'code-safety:a.ts');
  assert.equal(classeDe(achado({ path: 'docs/leia.md' })), 'code-safety:docs/leia.md');
});

test('3 rodadas consecutivas na mesma classe dispara o sintetico (Task 5)', () => {
  const historico = [
    { achados: [achado({ id: 'a', path: 'services/api/src/x.ts:1' })] },
    { achados: [achado({ id: 'b', path: 'services/api/src/y.ts:2' })] },
    { achados: [achado({ id: 'c', path: 'services/api/src/z.ts:3' })] },
  ];
  const classes = classesReincidentes(historico);
  assert.equal(classes.length, 1);
  assert.equal(classes[0].classe, 'code-safety:services/api');
  assert.deepEqual(classes[0].ids, ['a', 'b', 'c']);
  const sintetico = achadoEstrutural(classes[0]);
  assert.equal(sintetico.severity, 'P1');
  assert.equal(sintetico.found_by, 'runner');
  assert.match(sintetico.id, /^classe:code-safety:services\/api$/);
  assert.match(sintetico.acceptance[0], /teste/i);
  assert.deepEqual(sintetico.recurrence.ids, ['a', 'b', 'c']);
});

test('2 rodadas nao dispara (Task 5)', () => {
  const historico = [
    { achados: [achado({ id: 'a' })] },
    { achados: [achado({ id: 'b' })] },
  ];
  assert.deepEqual(classesReincidentes(historico), []);
});

test('rodadas nao consecutivas nao disparam (Task 5)', () => {
  const historico = [
    { achados: [achado({ id: 'a' })] },
    { achados: [achado({ id: 'outro', lens: 'code-quality', path: 'outro/x.ts:1' })] },
    { achados: [achado({ id: 'c' })] },
  ];
  assert.deepEqual(classesReincidentes(historico), []);
});

test('janela configuravel (Task 5)', () => {
  const historico = [
    { achados: [achado({ id: 'a' })] },
    { achados: [achado({ id: 'b' })] },
  ];
  const classes = classesReincidentes(historico, { janela: 2 });
  assert.equal(classes.length, 1);
  assert.deepEqual(classes[0].ids, ['a', 'b']);
});

// P1-2 da revisao da Fase 4: rodada limpa (apos o teste de classe) PRECISA entrar
// na janela — descartada, a serie antiga permanece e o sintetico bloqueia para
// sempre (deadlock: a saida da spec era "rodada cheia deixar de reincidir").
test('rodada limpa quebra a serie no historico (P1-2)', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'lms-classe-'));
  await mkdir(join(root, '.lms'), { recursive: true });
  const linha = (achados) => JSON.stringify({ provider: 'grok', result: 'rejected', achados });
  const linhas = [
    linha([achado({ id: 'a' })]),
    linha([achado({ id: 'b' })]),
    linha([achado({ id: 'c' })]),
    linha([]), // rodada limpa: o teste de classe fechou a familia
    linha([]),
  ];
  await writeFile(join(root, '.lms', 'history.jsonl'), linhas.join('\n') + '\n');

  const rodadas = await historicoDeRodadas(root);
  assert.equal(rodadas.length, 5, 'rodada limpa entra na janela, nao e descartada');
  assert.deepEqual(classesReincidentes(rodadas), [], 'a serie quebrou');
});

// P2-1 da revisao da Fase 4: recorrência escopada por subject — rodadas de outra
// branch (outro diff) nao contam para a serie.
test('historico escopado por subject (P2-1)', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'lms-classe-'));
  await mkdir(join(root, '.lms'), { recursive: true });
  const linhas = [
    JSON.stringify({ subject: 'shaA', achados: [achado({ id: 'a' })] }),
    JSON.stringify({ subject: 'shaA', achados: [achado({ id: 'b' })] }),
    JSON.stringify({ subject: 'shaB', achados: [achado({ id: 'c' })] }),
  ];
  await writeFile(join(root, '.lms', 'history.jsonl'), linhas.join('\n') + '\n');

  const rodadasB = await historicoDeRodadas(root, 'shaB');
  assert.equal(rodadasB.length, 1, 'rodada de outra branch nao conta');
  const rodadasA = await historicoDeRodadas(root, 'shaA');
  assert.equal(rodadasA.length, 2);
});
