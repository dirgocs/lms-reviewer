import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `hotel_id` nao existe em nenhum arquivo de codigo: a chave de tenant e
// `tenantId` / `tenant_id`. Uma regra que manda o revisor procurar coluna
// inexistente e pior que regra ausente — ele procura, nao acha, e conclui que
// esta tudo certo.
//
// P3-6 da revisao da Fase 1: lista fixa de 3 caminhos deixava um NOVO
// references/*.md reintroduzir hotel_id sem o teste piscar. Varre as pastas
// de regra por glob.
const PASTAS_DE_REGRA = ['skills', 'hooks'];

async function varrer(dir, prefixo) {
  const arquivos = [];
  for (const entrada of await readdir(dir, { withFileTypes: true })) {
    if (entrada.name.startsWith('.') || entrada.name === 'node_modules') continue;
    const relativo = `${prefixo}${entrada.name}`;
    if (entrada.isDirectory()) {
      arquivos.push(...(await varrer(join(raiz, relativo), `${relativo}/`)));
    } else if (entrada.name.endsWith('.md') || entrada.name.endsWith('.sh')) {
      arquivos.push(relativo);
    }
  }
  return arquivos;
}

test('nenhum arquivo de regra manda procurar hotel_id', async () => {
  const arquivos = [];
  for (const pasta of PASTAS_DE_REGRA) {
    arquivos.push(...(await varrer(join(raiz, pasta), `${pasta}/`)));
  }
  assert.ok(arquivos.length > 0, 'a varredura achou a superficie de regra');
  for (const relativo of arquivos) {
    const conteudo = await readFile(resolve(raiz, relativo), 'utf8');
    assert.equal(
      /hotel_id/.test(conteudo),
      false,
      `${relativo} ainda cita hotel_id; a chave real e tenantId / tenant_id`,
    );
  }
});
