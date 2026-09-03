import test from 'node:test';
import assert from 'node:assert/strict';

import { achadoEstrutural, classeDe, classesReincidentes } from './lms-classe-recorrente.mjs';

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
