import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Config por projeto do LMS. Tudo aqui é opcional: sem `lms.config.json` o gate
 * roda como revisor puro de diff, que é o comportamento correto para um projeto
 * que não tem migrations versionadas nem gate de métrica.
 *
 * Isto existe porque na extração do karibu-erp os fatos do projeto estavam
 * hardcoded nos scripts: dois caminhos no runner (`services/api/migrations/` e
 * `apps/pdv-mobile/scripts/fallow-regression-gate.mjs`) e a regra de isenção de
 * doc/tooling no `lms-exempt-paths.sh`. Um deles entrava no PROMPT do revisor —
 * num projeto sem esse layout, a regra mandava o modelo ignorar achados numa pasta
 * que não existe.
 *
 * Shape de `lms.config.json` na raiz do repo (ver lms.config.example.json):
 * {
 *   "migrationsPath": "services/api/migrations/",
 *   "dbStateGate": "scripts/db-exposure-gate.mjs",
 *   "fallow": { "gate": "apps/x/scripts/fallow-regression-gate.mjs",
 *               "baseline": ".fallow/baseline.json" },
 *   "exemptPaths": ["^docs/", "\\.(md|mdx|txt|rst)$"],
 *   "nonExemptPaths": []
 * }
 */

/**
 * Isenção default: doc pura. Um conjunto de arquivos só é isento do gate quando
 * TODO arquivo casa com alguma destas ERE. É o mínimo que vale em qualquer repo —
 * skills de agente e corpus oficial são fato do projeto e vêm da config.
 */
export const DEFAULT_EXEMPT_PATHS = Object.freeze(['^docs/', '\\.(md|mdx|txt|rst)$']);

const EMPTY = Object.freeze({
  migrationsPath: null,
  dbStateGate: null,
  fallow: Object.freeze({ gate: null, baseline: '.fallow/baseline.json' }),
  exemptPaths: DEFAULT_EXEMPT_PATHS,
  nonExemptPaths: Object.freeze([]),
});

const cache = new Map();

/**
 * Raiz do projeto CONSUMIDOR, não do pacote: os scripts moram em node_modules e o
 * que importa é o repo de quem está publicando. `LMS_PROJECT_ROOT` é o override
 * explícito (testes e trigger); sem ele, a raiz git do cwd; sem git, o cwd.
 */
export function projectRoot() {
  if (process.env.LMS_PROJECT_ROOT) return process.env.LMS_PROJECT_ROOT;
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.cwd();
  }
}

export function loadConfig(root = projectRoot()) {
  if (cache.has(root)) return cache.get(root);

  const path = join(root, 'lms.config.json');
  let parsed = EMPTY;

  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      parsed = Object.freeze({
        migrationsPath: str(raw.migrationsPath),
        dbStateGate: str(raw.dbStateGate),
        fallow: Object.freeze({
          gate: str(raw.fallow?.gate),
          baseline: str(raw.fallow?.baseline) ?? '.fallow/baseline.json',
        }),
        exemptPaths: regexList(raw.exemptPaths, DEFAULT_EXEMPT_PATHS, 'exemptPaths'),
        nonExemptPaths: regexList(raw.nonExemptPaths, [], 'nonExemptPaths'),
      });
    } catch (error) {
      // Config quebrada não pode virar aprovação silenciosa: avisa alto e segue
      // com o default vazio, que é o modo mais restritivo de prompt (sem isenção
      // de migration) e mais permissivo de gate (sem fallow) — o oposto de um
      // bypass, porque o revisor continua bloqueando por achado.
      console.error(`lms: lms.config.json inválido (${error.message}); usando defaults`);
    }
  }

  cache.set(root, parsed);
  return parsed;
}

function str(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Lista de ERE (POSIX, o dialeto do `grep -E` que a regra original usava). Chave
 * ausente = default; chave presente mas inválida (não-array, item não-string ou
 * regex que não compila) = a lista INTEIRA é descartada com aviso, e não só o
 * item ruim — meia regra de isenção é o que vira bypass silencioso.
 */
function regexList(value, fallback, key) {
  if (value === undefined) return Object.freeze([...fallback]);
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new TypeError(`${key} precisa ser array de strings`);
  }
  for (const item of value) {
    try {
      new RegExp(item);
    } catch (error) {
      throw new TypeError(`${key} tem regex inválida (${item}): ${error.message}`);
    }
  }
  return Object.freeze([...value]);
}

/** Só para teste: limpa o cache entre casos. */
export function resetConfigCache() {
  cache.clear();
}
