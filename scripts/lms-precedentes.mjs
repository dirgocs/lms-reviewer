/**
 * Memoria de falso-positivo do LMS.
 *
 * O `/code-review ultra` carrega uma lista fixa de exclusoes ("DoS nao conta",
 * "env var e valor confiavel"). Aqui a lista CRESCE: toda refutacao que derruba um
 * achado deixa a classe registrada, e o proximo revisor a le antes de reportar.
 * Sem isso, o custo de re-litigar a mesma classe e pago inteiro a cada rodada.
 *
 * Teto de 40: o corpus entra no prompt de TODA revisao. Corpus sem limite e custo
 * fixo crescente por revisao — a linha mais antiga sai.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const TETO_PRECEDENTES = 40;

// Estado de runtime do consumidor, como todo .lms/ — gitignored, o pacote nao
// embarca corpus: so carrega o arquivo se ele existir.
const RELATIVO = '.lms/precedentes.md';
const CABECALHO = [
  '# Precedentes — classes de achado já derrubadas',
  '',
  'Gerado pelo LMS. Cada linha é uma classe de achado que uma refutação derrubou.',
  'O revisor lê isto antes de reportar: reportar de novo custa a rodada inteira.',
  'Editar à mão é permitido — o runner só acrescenta e apara pelo teto.',
  '',
];

function caminho(root) {
  return join(root, RELATIVO);
}

export async function lerPrecedentes(root) {
  try {
    const texto = await readFile(caminho(root), 'utf8');
    return texto.split('\n').filter((linha) => linha.startsWith('- ')).slice(-TETO_PRECEDENTES);
  } catch {
    return [];
  }
}

export async function registrarPrecedente(root, { classe, motivo, origem }) {
  const limpa = String(classe ?? '').trim();
  const porQue = String(motivo ?? '').trim();
  if (limpa.length < 5 || porQue.length < 10) return;

  const atuais = await lerPrecedentes(root);
  if (atuais.some((linha) => linha.includes(limpa))) return;

  const nova = `- **${limpa}** — ${porQue} _(${String(origem ?? 'lms').trim()})_`;
  const linhas = [...atuais, nova].slice(-TETO_PRECEDENTES);
  await mkdir(dirname(caminho(root)), { recursive: true });
  await writeFile(caminho(root), [...CABECALHO, ...linhas, ''].join('\n'), 'utf8');
}
