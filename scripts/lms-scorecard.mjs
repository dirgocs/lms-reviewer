import { readFile } from 'node:fs/promises';

import { changedOpenablePaths, inspectedShapeError, inspectionError } from './lms-inspection.mjs';
import { reviewSubject } from './lms-subject.mjs';

const REVIEWERS = new Set(['claude', 'grok', 'codex']);
const LENSES = ['code-safety', 'code-structure', 'code-quality', 'code-efficiency'];

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function lensFindings(lens) {
  return (
    lens &&
    isNonNegativeInteger(lens.p0) &&
    isNonNegativeInteger(lens.p1) &&
    isNonNegativeInteger(lens.p2)
  );
}

function objectError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'scorecard must be a JSON object';
  }
  return null;
}

function reviewerError(value) {
  return REVIEWERS.has(value.reviewer) ? null : 'invalid reviewer';
}

function reviewerMatchError(value, reviewer) {
  return !reviewer || value.reviewer === reviewer ? null : 'reviewer mismatch';
}

function baseError(value, base) {
  return base && value.base === base ? null : 'base mismatch';
}

function identityError(value, reviewer, base) {
  return firstError([
    reviewerError(value),
    reviewerMatchError(value, reviewer),
    baseError(value, base),
  ]);
}

function scoreIntegerError(value) {
  const valid = Number.isInteger(value.score) && Number.isInteger(value.target);
  return valid ? null : 'score and target must be integers';
}

function scoreTargetError(value) {
  return value.target === 5 && value.score >= value.target ? null : 'score must meet target 5';
}

function aggregateFieldError(value) {
  for (const field of ['p0', 'p1', 'p2']) {
    if (!isNonNegativeInteger(value[field])) return `${field} must be a non-negative integer`;
  }
  return null;
}

function lensTotals(value) {
  const totals = { p0: 0, p1: 0, p2: 0 };
  for (const lensName of LENSES) {
    const lens = value.lenses[lensName];
    if (!lensFindings(lens)) return { error: `invalid findings for ${lensName}` };
    for (const field of Object.keys(totals)) totals[field] += lens[field];
  }
  return { totals };
}

/** Coerência interna: o agregado tem de somar as lentes. Não julga o veredito. */
function aggregateConsistencyError(value, totals) {
  for (const field of Object.keys(totals)) {
    if (value[field] !== totals[field]) return `${field} aggregate does not match lenses`;
  }
  return null;
}

/**
 * Quanto da superficie foi de fato varrido.
 *
 * `inspected` prova que o revisor leu ALGUMA coisa; nao prova que ele varreu. Um
 * revisor que abriu 3 de 45 rotas e um que abriu as 45 produziam scorecards
 * indistinguiveis. `coverage` e o denominador que faltava — e por ser auto-declarado,
 * e exatamente o tipo de afirmacao que o contraditorio consegue derrubar barato:
 * basta achar a 46a rota.
 */
function coverageError(value) {
  const coverage = value.coverage;
  if (!Array.isArray(coverage) || coverage.length === 0) {
    return 'coverage is required: list each surface you swept as {surface, total, inspected}';
  }
  for (const entry of coverage) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return 'each coverage entry must be an object {surface, total, inspected}';
    }
    if (typeof entry.surface !== 'string' || entry.surface.trim().length < 3) {
      return 'coverage entry needs a "surface" describing what was swept';
    }
    if (!isNonNegativeInteger(entry.total) || !isNonNegativeInteger(entry.inspected)) {
      return `coverage entry "${entry.surface}" needs integer total and inspected`;
    }
    if (entry.inspected > entry.total) {
      return `coverage entry "${entry.surface}" has inspected (${entry.inspected}) greater than total (${entry.total})`;
    }
  }
  return null;
}

/**
 * O veredito: achado pendente reprova a publicação.
 *
 * Vive separado da checagem de FORMA de propósito. Antes isto morava junto, e a
 * consequência era grave: um reviewer que fazia o trabalho certo e encontrava um
 * P1 tinha seu scorecard classificado como `invalid-output`, o runner caía para o
 * próximo provider, os três "falhavam", e o trigger liberava o push com warning.
 * O gate ficava invertido — quanto mais problema o código tinha, mais fácil passar.
 */
function verdictFindingsError(value) {
  for (const field of ['p0', 'p1', 'p2']) {
    if (value[field] !== 0) return `actionable ${field} findings remain`;
  }
  return null;
}

function lensesPresenceError(value) {
  return value.lenses && typeof value.lenses === 'object' ? null : 'lenses are required';
}

const FALLOW_OK = new Set(['pass', 'warn', 'no-changes']);
const AUTONOMY = new Set(['reviewer', 'goal', 'loop', 'manual', 'self']);

/**
 * O fallow é determinístico e roda no push gate de qualquer jeito — então declarar
 * "skipped" era só uma forma de não olhar. Foi exatamente assim que um scorecard
 * 5/5 conviveu com o fallow bloqueando o push por regressão.
 *
 * `warn` e `no-changes` passam (a rubrica os trata como soft); `fail`, ausente ou
 * `skipped` reprovam.
 */
function fallowError(value) {
  if (value.fallow === undefined || value.fallow === null) {
    return 'fallow result is required (run the audit; "skipped" is not acceptable)';
  }
  if (!FALLOW_OK.has(value.fallow)) return `fallow must be pass, warn or no-changes (got "${value.fallow}")`;
  return null;
}

/**
 * Quem revisou. `self` é o autor avaliando o próprio trabalho: aceito, porque às
 * vezes é o único caminho, mas é a categoria mais fraca e o gate diz isso em voz
 * alta — a regra que vale no resto do projeto é revisor ≠ autor.
 */
function autonomyError(value) {
  if (!AUTONOMY.has(value.autonomy)) {
    return `autonomy must be one of ${[...AUTONOMY].join(', ')}`;
  }
  return null;
}

/** Forma do agregado e das lentes, sem julgar se passou. */
function aggregateShapeError(value) {
  const fieldError = aggregateFieldError(value);
  if (fieldError) return fieldError;
  const presenceError = lensesPresenceError(value);
  if (presenceError) return presenceError;
  const { error, totals } = lensTotals(value);
  return error || aggregateConsistencyError(value, totals);
}

/**
 * O parecer vale para o diff que o revisor VIU, e só para ele.
 *
 * Antes a validade era só temporal: um 5/5 autorizava qualquer coisa commitada nas
 * duas horas seguintes. O gate pedia em prosa para re-pontuar quando o código
 * mudasse — pedido ao agente não é trava. `subject` é o hash do diff revisado
 * (commits + árvore suja + arquivos novos); quando ele não bate, o parecer é de
 * outro código.
 *
 * `expected` ausente significa que quem chamou não sabe calcular (teste, repo sem
 * git): aí a checagem é dispensada em vez de reprovar por falta de informação.
 */
function subjectError(value, expected) {
  if (!expected) return null;
  if (!value.subject) return 'scorecard has no subject (re-run the reviewer chain)';
  if (value.subject !== expected) {
    return `scorecard reviewed a different diff (subject ${value.subject} != ${expected})`;
  }
  return null;
}

function freshnessError(value, now, maxAgeSec) {
  const at = Date.parse(value.at);
  if (!Number.isFinite(at)) return 'at must be an ISO timestamp';
  const ageMs = now - at;
  if (ageMs < -60_000) return 'scorecard timestamp is in the future';
  if (ageMs > maxAgeSec * 1000) return 'scorecard is stale';
  return null;
}

function firstError(checks) {
  for (const check of checks) {
    if (check) return check;
  }
  return null;
}

/**
 * O scorecard está BEM FORMADO? Não diz se passou.
 *
 * É isto que o runner de reviewers deve usar para decidir se o provider fez o
 * trabalho ou devolveu lixo. Um scorecard bem formado com score 2 e três P1 é
 * válido — é uma reprovação legítima, e reprovação não é falha do reviewer.
 */
export function scorecardFormError(value, {
  reviewer,
  base,
  subject,
  now = Date.now(),
  maxAgeSec = 7200,
} = {}) {
  const objectErrorMessage = objectError(value);
  if (objectErrorMessage) return objectErrorMessage;
  return firstError([
    identityError(value, reviewer, base),
    scoreIntegerError(value),
    aggregateShapeError(value),
    coverageError(value),
    autonomyError(value),
    inspectedShapeError(value),
    freshnessError(value, now, maxAgeSec),
    subjectError(value, subject),
  ]);
}

/**
 * O scorecard AUTORIZA a publicação? Forma válida mais o veredito: target 5,
 * score atingindo o target e zero achado pendente.
 *
 * É isto que o gate de push usa.
 */
export function scorecardError(value, {
  reviewer,
  base,
  subject,
  now = Date.now(),
  maxAgeSec = 7200,
} = {}) {
  const formError = scorecardFormError(value, { reviewer, base, subject, now, maxAgeSec });
  if (formError) return formError;
  return firstError([scoreTargetError(value), verdictFindingsError(value), fallowError(value)]);
}

export function validateScorecard(value, options = {}) {
  return scorecardError(value, options) === null;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    args[key] = argv[i + 1];
    i += 1;
  }
  return args;
}

function cliUsage() {
  console.error('usage: lms-scorecard --file FILE [--reviewer NAME] --base REF [--max-age-sec N]');
  process.exitCode = 2;
}

async function validateFile(args) {
  try {
    const value = JSON.parse(await readFile(args.file, 'utf8'));
    // O gate recalcula o subject aqui: e o unico ponto que sabe o estado ATUAL do
    // repositorio. Confiar no que o scorecard diz sobre si mesmo seria deixar a
    // amarra nas maos de quem ela deveria limitar.
    const error = scorecardError(value, {
      reviewer: args.reviewer,
      base: args.base,
      subject: await reviewSubject(process.cwd(), args.base),
      maxAgeSec: Number(args['max-age-sec'] ?? 7200),
    });
    if (error) {
      console.error(`invalid LMS scorecard: ${error}`);
      process.exitCode = 1;
      return;
    }
    // O caminho do scorecard EM CACHE tambem confere as citacoes no disco. Validar
    // so a forma deixava fabricar prova citando arquivo inexistente — furo apontado
    // pelo reviewer (codex, P1 conf=98).
    const proofError = await inspectionError(
      value,
      await changedOpenablePaths(process.cwd(), args.base),
      process.cwd(),
    );
    if (proofError) {
      console.error(`invalid LMS scorecard: ${proofError}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`invalid LMS scorecard: ${error.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file || !args.base) return cliUsage();
  return validateFile(args);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
