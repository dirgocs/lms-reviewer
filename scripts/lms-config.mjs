import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Config por projeto do LMS. Tudo aqui é opcional: sem `lms.config.json` o gate
 * roda como revisor puro de diff, que é o comportamento correto para um projeto
 * que não tem migrations versionadas nem gate de métrica.
 *
 * Isto existe porque na extração do karibu-erp dois caminhos estavam hardcoded no
 * runner (`services/api/migrations/` e `apps/pdv-mobile/scripts/fallow-regression-gate.mjs`).
 * Um deles entrava no PROMPT do revisor — num projeto sem esse layout, a regra
 * mandava o modelo ignorar achados numa pasta que não existe.
 *
 * Shape de `lms.config.json` na raiz do repo:
 * {
 *   "migrationsPath": "services/api/migrations/",
 *   "dbStateGate": "scripts/db-exposure-gate.mjs",
 *   "fallow": { "gate": "apps/x/scripts/fallow-regression-gate.mjs",
 *               "baseline": ".fallow/baseline.json" }
 * }
 */

const EMPTY = Object.freeze({
  migrationsPath: null,
  dbStateGate: null,
  fallow: Object.freeze({ gate: null, baseline: '.fallow/baseline.json' }),
});

const cache = new Map();

export function projectRoot() {
  return process.env.LMS_PROJECT_ROOT ?? process.cwd();
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

/** Só para teste: limpa o cache entre casos. */
export function resetConfigCache() {
  cache.clear();
}
