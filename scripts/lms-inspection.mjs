import { readFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const MAX_INSPECTED_REQUIRED = 3;
const MIN_QUOTE_LENGTH = 12;
const LINE_WINDOW = 3;

/**
 * Prova de leitura conferida contra o disco.
 *
 * Vive num módulo próprio porque o gate de publicação tem DOIS caminhos — scorecard
 * em cache e cadeia de reviewers — e ambos precisam da mesma verificação. Quando ela
 * morava só no runner, o caminho em cache autorizava com prova fabricada; quando o
 * validador passou a checar apenas a FORMA, ainda dava para citar arquivo
 * inexistente. Os dois furos foram apontados pelo próprio reviewer.
 */

function normalizeQuote(text) {
  // Tolerante ao que não muda conteúdo: indentação, espaço colapsado e aspas
  // tipográficas que alguns modelos "embelezam" ao transcrever.
  return String(text)
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A citação bate com o arquivo, perto da linha declarada?
 *
 * Janela de ±3 linhas, deliberada. Um reviewer (codex, P1 conf=98) argumentou que a
 * janela "aceita citação da linha errada" e que a prova deveria exigir a linha exata.
 * Discordância registrada, e a janela fica, por dois motivos:
 *
 *   1. O que a prova precisa impedir é APROVAR SEM LER. Para isso, o que importa é a
 *      citação existir no arquivo — não o número estar exato. Quem conta linhas a
 *      partir do que leu erra por um, e isso não é fabricação.
 *   2. Exigir linha exata não fecha nada: quem sabe o conteúdo literal da linha sabe
 *      também o número dela. Só quebraria reviewer honesto.
 *
 * Containment num sentido só — a linha real contém o trecho citado. O sentido inverso
 * deixava passar citação inventada que começasse igual à linha real.
 */
async function quoteMatches(root, path, line, quote) {
  const wanted = normalizeQuote(quote);
  if (!wanted) return false;
  // Linha honesta pode ser CURTA — `db.commit()` tem 11 caracteres, e recusá-la
  // custou rodadas inteiras (o sintoma era o enganoso "quote does not match" numa
  // citação literalmente correta). Curto não vira brecha: abaixo do piso o trecho
  // só vale se for a linha INTEIRA normalizada, então citar um fragmento genérico
  // ("return", "});") continua impossível — fragmento não é igual a linha nenhuma.
  const exigeLinhaInteira = wanted.length < MIN_QUOTE_LENGTH;
  let content;
  try {
    content = await readFile(join(root, path), 'utf8');
  } catch {
    return false;
  }
  const lines = content.split('\n');
  const index = Number(line) - 1;
  if (!Number.isInteger(index)) return false;
  // A exceção curta abre mão da janela ±3, de propósito: `);` e `}` normalizados são
  // linhas inteiras válidas em quase qualquer arquivo, e com janela a chance de um
  // vizinho casar por acaso cresce demais. Quem cita linha curta tem entropia menor
  // para provar leitura — compensa com o número EXATO. A janela continua valendo
  // para citação longa, onde off-by-one não é fabricação.
  if (exigeLinhaInteira) {
    return index >= 0 && index < lines.length && normalizeQuote(lines[index]) === wanted;
  }
  const from = Math.max(0, index - LINE_WINDOW);
  const to = Math.min(lines.length, index + LINE_WINDOW + 1);
  for (let i = from; i < to; i += 1) {
    if (normalizeQuote(lines[i]).includes(wanted)) return true;
  }
  return false;
}

/**
 * Arquivos que mudaram e ainda podem ser abertos.
 *
 * Deleção sai (não há o que abrir). Rename vem como `R100<TAB>antigo<TAB>novo`, e o
 * que existe no disco é o último campo.
 */
export async function changedOpenablePaths(root, base) {
  try {
    const { stdout } = await execFile('git', ['diff', '--name-status', `${base}...HEAD`], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    });
    return new Set(
      stdout
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('D'))
        .map((line) => {
          const fields = line.split('\t').map((field) => field.trim()).filter(Boolean);
          return fields.at(-1) ?? '';
        })
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/** Forma da prova. Síncrono, sem tocar o disco. */
export function inspectedShapeError(value) {
  const inspected = value.inspected;
  if (!Array.isArray(inspected) || inspected.length === 0) {
    return 'inspected is required: list the files you opened as {path, line, quote}';
  }
  for (const entry of inspected) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return 'each inspected entry must be an object {path, line, quote}';
    }
    if (typeof entry.path !== 'string' || !entry.path.trim()) {
      return 'inspected entry needs a non-empty path';
    }
    if (!Number.isInteger(entry.line) || entry.line < 1) {
      return `inspected entry for ${entry.path} needs a 1-based integer line`;
    }
    if (typeof entry.quote !== 'string' || !entry.quote.trim()) {
      return `inspected entry for ${entry.path} needs a verbatim quote of the line`;
    }
  }
  return null;
}

/**
 * A prova existe, cobre arquivos do diff e as citações batem com o disco.
 *
 * `changedPaths` vazio significa "sem informação de diff" (repo sem git, teste): aí
 * o piso fixo vale e a checagem de pertencimento é dispensada, mas as citações
 * continuam sendo conferidas.
 */
export async function inspectionError(scorecard, changedPaths, root = process.cwd()) {
  const shapeError = inspectedShapeError(scorecard);
  if (shapeError) return shapeError;

  const byPath = new Map(
    scorecard.inspected.map((entry) => [
      String(entry.path).split(':')[0].trim(),
      { ...entry, path: String(entry.path).split(':')[0].trim() },
    ]),
  );

  // Sem informação de diff (fora de repo git, ou base inalcançável) não há como
  // dizer quantos arquivos eram elegíveis. Exigir 3 aí é exigir o impossível — e
  // a prova continua valendo, porque cada citação é conferida no disco.
  const openable = changedPaths.size;
  const required = openable === 0 ? 1 : Math.min(MAX_INSPECTED_REQUIRED, openable);
  if (byPath.size < required) {
    return `inspected must list at least ${required} distinct file(s), each with path, line and a verbatim quote`;
  }

  // A prova exige cobrir o DIFF, não proíbe ler o resto. A regra anterior invalidava
  // a revisão inteira quando o reviewer citava um colaborador do arquivo alterado —
  // e num diff de um arquivo só, abrir quem o chama é exatamente o que distingue
  // revisão de leitura superficial. Os três providers foram reprovados por isso no
  // mesmo diff, todos por terem feito a coisa certa.
  //
  // Não abre brecha: cada citação, do diff ou de fora, é conferida contra o disco
  // logo abaixo. Inventar continua impossível; ler mais, não.
  if (openable > 0) {
    const doDiff = [...byPath.keys()].filter((path) => changedPaths.has(path));
    if (doDiff.length < required) {
      return `inspected must cover at least ${required} changed file(s); got ${doDiff.length} (extra context files are allowed)`;
    }
  }

  const checks = await Promise.all(
    [...byPath.values()].map(async (entry) => ({
      path: entry.path,
      ok: await quoteMatches(root, entry.path, entry.line, entry.quote),
    })),
  );
  const bogus = checks.filter((check) => !check.ok).map((check) => check.path);
  if (bogus.length > 0) {
    return `quote does not match the file at the given line: ${bogus.slice(0, 3).join(', ')}`;
  }
  return null;
}
