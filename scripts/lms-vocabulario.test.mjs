import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `hotel_id` nao existe em nenhum arquivo de codigo: a chave de tenant e
// `tenantId` / `tenant_id`. Uma regra que manda o revisor procurar coluna
// inexistente e pior que regra ausente — ele procura, nao acha, e conclui que
// esta tudo certo.
const SUPERFICIE_DE_REGRA = [
  'skills/local-merge-score/SKILL.md',
  'skills/local-merge-score/references/rubric.md',
  'hooks/local-merge-score-gate.sh',
];

test('nenhum arquivo de regra manda procurar hotel_id', async () => {
  for (const relativo of SUPERFICIE_DE_REGRA) {
    const conteudo = await readFile(resolve(raiz, relativo), 'utf8');
    assert.equal(
      /hotel_id/.test(conteudo),
      false,
      `${relativo} ainda cita hotel_id; a chave real e tenantId / tenant_id`,
    );
  }
});
