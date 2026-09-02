import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inspectedShapeError, inspectionError } from './lms-inspection.mjs';

test('shape check rejects the old string form and empty quotes', () => {
  assert.match(inspectedShapeError({}) ?? '', /inspected is required/);
  assert.match(inspectedShapeError({ inspected: [] }) ?? '', /inspected is required/);
  assert.match(
    inspectedShapeError({ inspected: ['a.ts', 'b.ts'] }) ?? '',
    /must be an object/,
  );
  assert.match(
    inspectedShapeError({ inspected: [{ path: 'a.ts', quote: 'linha longa aqui' }] }) ?? '',
    /1-based integer line/,
  );
  assert.match(
    inspectedShapeError({ inspected: [{ path: 'a.ts', line: 1, quote: '   ' }] }) ?? '',
    /verbatim quote/,
  );
  // Citação CURTA passa na forma: linha honesta pode ter 11 caracteres
  // (`db.commit()`), e recusar aqui queimou rodadas inteiras. Quem decide é o
  // matcher, exigindo igualdade com a linha inteira.
  assert.equal(
    inspectedShapeError({ inspected: [{ path: 'a.ts', line: 1, quote: 'curta' }] }),
    null,
  );
  assert.equal(
    inspectedShapeError({ inspected: [{ path: 'a.ts', line: 1, quote: 'linha longa o bastante' }] }),
    null,
  );
});

test('short quote only matches when it IS the whole line', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lms-inspec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, 'w.py'),
    'def f(db):\n    db.commit()\n    return migrouODefault\n',
    'utf8',
  );
  const caso = (quote, line = 2) => ({
    score: 5,
    inspected: [{ path: 'w.py', line, quote }],
  });

  // Linha curta citada por inteiro (indentação normalizada): prova válida.
  assert.equal(await inspectionError(caso('db.commit()'), new Set(), dir), null);
  // Fragmento genérico de linha maior: continua impossível provar leitura com ele.
  assert.match(
    (await inspectionError(caso('return', 3), new Set(), dir)) ?? '',
    /quote does not match/,
  );
  // E a exceção curta NÃO ganha a janela ±3: `db.commit()` citado na linha errada
  // falha, mesmo com a linha certa a um passo. Entropia menor exige número exato.
  assert.match(
    (await inspectionError(caso('db.commit()', 1), new Set(), dir)) ?? '',
    /quote does not match/,
  );
});

test('without diff information the floor is 1, but quotes are still verified', async () => {
  // Fora de repo git nao ha como saber quantos arquivos eram elegiveis; exigir 3
  // seria exigir o impossivel. A prova continua valendo pela citacao no disco.
  const root = await mkdtemp(join(tmpdir(), 'lms-nodiff-'));
  try {
    await writeFile(join(root, 'x.ts'), 'export const sozinho = 1; // unica linha\n', 'utf8');
    assert.equal(
      await inspectionError(
        { inspected: [{ path: 'x.ts', line: 1, quote: 'export const sozinho = 1; // unica linha' }] },
        new Set(),
        root,
      ),
      null,
    );
    assert.match(
      (await inspectionError(
        { inspected: [{ path: 'x.ts', line: 1, quote: 'export const sozinho = 999; // inventado' }] },
        new Set(),
        root,
      )) ?? '',
      /quote does not match/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a fabricated quote is rejected even when the path is real', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-proof-'));
  try {
    await writeFile(join(root, 'real.ts'), 'const verdade = "conteudo que existe";\n', 'utf8');
    const changed = new Set(['real.ts']);

    assert.equal(
      await inspectionError(
        { inspected: [{ path: 'real.ts', line: 1, quote: 'const verdade = "conteudo que existe";' }] },
        changed,
        root,
      ),
      null,
    );

    assert.match(
      (await inspectionError(
        { inspected: [{ path: 'real.ts', line: 1, quote: 'const verdade = "eu inventei isto";' }] },
        changed,
        root,
      )) ?? '',
      /quote does not match/,
    );

    // Arquivo que nem existe no disco.
    assert.match(
      (await inspectionError(
        { inspected: [{ path: 'real.ts', line: 1, quote: 'qualquer coisa suficientemente longa' }] },
        changed,
        root,
      )) ?? '',
      /quote does not match/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ler contexto fora do diff nao invalida a revisao', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-ctx-'));
  try {
    await writeFile(join(root, 'mudou.ts'), 'export function alvo(entrada) {\n  return entrada;\n}\n', 'utf8');
    await writeFile(join(root, 'colaborador.ts'), 'export const CHAMA_O_ALVO = true;\n', 'utf8');

    // Um diff de UM arquivo: o piso é 1. Citar o colaborador que ele chama é o que
    // separa revisão de leitura superficial — e era exatamente o que reprovava antes.
    const comContexto = {
      inspected: [
        { path: 'mudou.ts', line: 1, quote: 'export function alvo(entrada) {' },
        { path: 'colaborador.ts', line: 1, quote: 'export const CHAMA_O_ALVO = true;' },
      ],
    };
    assert.equal(await inspectionError(comContexto, new Set(['mudou.ts']), root), null);

    // Mas contexto não substitui o diff: citar SÓ o que não mudou continua inválido.
    const soContexto = {
      inspected: [{ path: 'colaborador.ts', line: 1, quote: 'export const CHAMA_O_ALVO = true;' }],
    };
    assert.match(
      await inspectionError(soContexto, new Set(['mudou.ts']), root) ?? '',
      /must cover at least 1 changed file/,
    );

    // E citação inventada segue barrada, venha de onde vier.
    const inventada = {
      inspected: [
        { path: 'mudou.ts', line: 1, quote: 'export function alvo(entrada) {' },
        { path: 'colaborador.ts', line: 1, quote: 'linha que nao existe no arquivo' },
      ],
    };
    assert.match(
      await inspectionError(inventada, new Set(['mudou.ts']), root) ?? '',
      /quote does not match/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
