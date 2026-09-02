/** Fixtures compartilhadas das suítes do runner LMS (fallback e pi).
 *  A prova de leitura é conferida contra o disco, então os arquivos citados
 *  pelos fakes precisam existir de verdade — e a lista é a MESMA nas duas
 *  suítes de propósito (o fallow acusou o clone; a fonte única mora aqui). */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function escreverArquivosCitados(root) {
  await writeFile(join(root, 'a.ts'), 'export const alpha = 1; // linha citada\n', 'utf8');
  await writeFile(join(root, 'b.ts'), 'export const bravo = 2; // linha citada\n', 'utf8');
  await writeFile(join(root, 'c.ts'), 'export const charlie = 3; // linha citada\n', 'utf8');
}

/** Cobertura padrao dos fixtures: a superficie varrida tem de bater com os
 *  tres arquivos que escreverArquivosCitados cria. */
export const coberturaFixture = [{ surface: 'arquivos alterados', total: 3, inspected: 3 }];
