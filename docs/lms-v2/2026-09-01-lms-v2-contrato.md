> **Nota de migração (2026-09-01).** Este documento foi escrito dentro do
> `karibu-erp` e cita caminhos daquele monorepo. Ele será implementado NESTE
> repositório (`@dirgocs/lms-reviewer`), onde o layout é:
>
> | No texto (karibu-erp)                      | Aqui (pacote)                        |
> | ------------------------------------------ | ------------------------------------ |
> | `scripts/lms-*.mjs`, `scripts/lms-*.sh`    | `scripts/lms-*` (mesmos nomes)       |
> | `.agents/skills/local-merge-score/`        | `skills/local-merge-score/`          |
> | `.claude/hooks/local-merge-score-gate.sh`  | `hooks/local-merge-score-gate.sh`    |
> | `.husky/pre-push` (bloco LMS)              | bin `lms-push-gate`                  |
> | `services/api/...`, `apps/erp-web/...`     | exemplos do projeto consumidor; nada aqui depende deles |
>
> O conteúdo abaixo está verbatim, sem reescrita.

# LMS v2 — Fase 1: contrato do scorecard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao scorecard do LMS os campos que faltam para distinguir "revisou e está limpo" de "não olhou", e trocar o canal de JSON-em-prosa por um schema publicado com retentativa.

**Architecture:** Todos os campos novos entram em `scripts/lms-scorecard.mjs` (validação) e `scripts/lms-reviewer-fallback.mjs` (prompt). A verificação de citação contra o disco, que hoje só atende `inspected`, é extraída de `scripts/lms-inspection.mjs` para servir também ao campo `verified`. Nenhum arquivo novo de runtime além do JSON Schema.

**Tech Stack:** Node 22 ESM, `node --test`, `node:assert/strict`. Sem dependências novas.

**Spec:** `docs/superpowers/specs/2026-09-01-lms-v2.md`

## Global Constraints

- PNPM only (ADR-009). Rodar gates da raiz do monorepo com `pnpm --filter`, nunca `pnpm exec` dentro de um pacote.
- Zero dependências novas. Tudo com stdlib do Node.
- Toda função nova exportada precisa de teste em `node --test`.
- `.lms/` é estado de runtime gitignored — não versionar fixture de scorecard real.
- A suíte do LMS roda com `pnpm test:lms`. Ela precisa continuar verde ao fim de cada task.
- Mensagem de erro de validação é lida por um modelo na retentativa: precisa dizer **qual campo** e **o que se esperava**, não só "invalid".
- Comentários e mensagens de commit em pt-BR, como o resto de `scripts/lms-*`.

---

### Task 1: Corrigir a chave de tenant errada (`hotel_id`)

`hotel_id` não existe em nenhum arquivo de código do repositório. A chave real é `tenantId` (Prisma / tabelas PascalCase) e `tenant_id` (tabelas snake_case), como `scripts/db-exposure-gate.mjs` já usa. Enquanto a regra estiver errada, todo revisor que a seguir procura a coisa errada.

**Files:**
- Modify: `scripts/local-merge-score-orient.mjs:56`
- Modify: `.agents/skills/local-merge-score/SKILL.md:417`
- Modify: `.greptile/rules.md:12-13`
- Modify: `apps/erp-web/AGENTS.md:16`
- Test: `scripts/lms-vocabulario.test.mjs` (criar)

**Interfaces:**
- Consumes: nada.
- Produces: nada em código. Garante que os arquivos de regra não voltem a citar `hotel_id`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `scripts/lms-vocabulario.test.mjs`:

```js
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
  'scripts/local-merge-score-orient.mjs',
  '.agents/skills/local-merge-score/SKILL.md',
  '.greptile/rules.md',
  'apps/erp-web/AGENTS.md',
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
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `node --test scripts/lms-vocabulario.test.mjs`
Expected: FAIL — 4 arquivos ainda citam `hotel_id`.

- [ ] **Step 3: Corrigir os quatro arquivos**

`scripts/local-merge-score-orient.mjs:56` — trocar a alternativa do regex:

```js
const riskRe =
  /(fiscal|auth|rls|tenant|payment|acquirer|tenantId|tenant_id|middleware\/auth|prisma)/i;
```

`.agents/skills/local-merge-score/SKILL.md:417` — trocar a linha por:

```markdown
- Multi-tenant: `tenantId` (tabelas Prisma) / `tenant_id` (tabelas snake_case) + RLS.
  O backend fiscal (`services/fiscal/backend`) conecta como dono do banco e **não**
  passa por RLS — lá o isolamento é o filtro explícito por `tenant_id` em cada query.
  Sem policy, nenhum filtro de tenant vindo do cliente conta.
```

`.greptile/rules.md:12-13` — trocar as duas linhas por:

```markdown
Toda tabela de negócio tem `tenantId` (PascalCase) ou `tenant_id` (snake_case).
Queries e mutations devem confiar em RLS (policy por essa coluna) — nunca montar
filtro de tenant manualmente no cliente.
```

`apps/erp-web/AGENTS.md:16` — trocar a linha por:

```markdown
- Multi-tenant isolation by `tenantId`/`tenant_id` — every data path must respect active tenant (`app/select-tenant`, `app/tenant-error`).
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `node --test scripts/lms-vocabulario.test.mjs`
Expected: PASS

- [ ] **Step 5: Confirmar que nada mais no repo depende de `hotel_id`**

Run: `git grep -n hotel_id -- ':!docs/superpowers'`
Expected: nenhuma saída (o spec desta fase cita `hotel_id` de propósito, ao descrever o bug, e está excluído).

- [ ] **Step 6: Registrar o teste na suíte do LMS**

Em `package.json`, no script `test:lms`, acrescentar `scripts/lms-vocabulario.test.mjs` à lista de arquivos passada a `node --test`.

Run: `pnpm test:lms`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add scripts/lms-vocabulario.test.mjs scripts/local-merge-score-orient.mjs \
  .agents/skills/local-merge-score/SKILL.md .greptile/rules.md apps/erp-web/AGENTS.md package.json
git commit -m "fix(lms): regra de tenant citava hotel_id, coluna que nao existe"
```

---

### Task 2: Extrair a verificação de citação para uso compartilhado

`inspectionError` hoje mistura três coisas: forma da entrada, cobertura mínima do diff, e conferência da citação contra o disco. O campo `verified` da Task 4 precisa das partes 1 e 3, mas não da 2 (uma asserção positiva pode citar arquivo fora do diff). Extrair antes de duplicar.

**Files:**
- Modify: `scripts/lms-inspection.mjs`
- Test: `scripts/lms-inspection.test.mjs`

**Interfaces:**
- Consumes: `quoteMatches(root, path, line, quote)` (privada hoje, em `lms-inspection.mjs`).
- Produces:
  - `export function citationShapeError(entries, campo)` → `string | null`
  - `export async function citationsDiskError(entries, root)` → `string | null`

- [ ] **Step 1: Escrever o teste que falha**

Acrescentar a `scripts/lms-inspection.test.mjs`:

```js
import { citationShapeError, citationsDiskError } from './lms-inspection.mjs';

test('citationShapeError nomeia o campo na mensagem', () => {
  const erro = citationShapeError([{ path: 'a.ts', line: 0, quote: 'x'.repeat(20) }], 'verified');
  assert.match(erro, /verified/);
  assert.match(erro, /1-based/);
});

test('citationShapeError aceita entradas bem formadas', () => {
  assert.equal(
    citationShapeError([{ path: 'a.ts', line: 3, quote: 'uma linha citada' }], 'verified'),
    null,
  );
});

test('citationsDiskError reprova citacao que nao existe no arquivo', async () => {
  const erro = await citationsDiskError(
    [{ path: 'package.json', line: 1, quote: 'ESTA LINHA NAO EXISTE NO ARQUIVO' }],
    process.cwd(),
  );
  assert.match(erro, /package\.json/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test scripts/lms-inspection.test.mjs`
Expected: FAIL — `citationShapeError is not a function`.

- [ ] **Step 3: Implementar a extração**

Em `scripts/lms-inspection.mjs`, exportar `quoteMatches` e acrescentar as duas funções, depois reescrever `inspectedShapeError` e a parte de disco de `inspectionError` em cima delas:

```js
/**
 * Forma de uma lista de citacoes. Sincrono, sem tocar o disco.
 *
 * `campo` entra na mensagem porque quem le o erro e um modelo tentando de novo:
 * "inspected entry needs a non-empty path" e acionavel, "invalid entry" nao.
 */
export function citationShapeError(entries, campo) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return `${campo} is required: list them as {path, line, quote}`;
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return `each ${campo} entry must be an object {path, line, quote}`;
    }
    if (typeof entry.path !== 'string' || !entry.path.trim()) {
      return `${campo} entry needs a non-empty path`;
    }
    if (!Number.isInteger(entry.line) || entry.line < 1) {
      return `${campo} entry for ${entry.path} needs a 1-based integer line`;
    }
    if (typeof entry.quote !== 'string' || entry.quote.trim().length < MIN_QUOTE_LENGTH) {
      return `${campo} entry for ${entry.path} needs a verbatim quote of at least ${MIN_QUOTE_LENGTH} chars`;
    }
  }
  return null;
}

/** As citacoes batem com o disco? Assincrono; nao julga cobertura. */
export async function citationsDiskError(entries, root = process.cwd()) {
  const porCaminho = new Map(
    entries.map((entry) => {
      const path = String(entry.path).split(':')[0].trim();
      return [path, { ...entry, path }];
    }),
  );
  const checks = await Promise.all(
    [...porCaminho.values()].map(async (entry) => ({
      path: entry.path,
      ok: await quoteMatches(root, entry.path, entry.line, entry.quote),
    })),
  );
  const bogus = checks.filter((check) => !check.ok).map((check) => check.path);
  return bogus.length > 0
    ? `quote does not match the file at the given line: ${bogus.slice(0, 3).join(', ')}`
    : null;
}
```

Trocar o corpo de `inspectedShapeError` por `return citationShapeError(value.inspected, 'inspected');`, e substituir o bloco final de `inspectionError` (as linhas que hoje montam `checks` e `bogus`) por `return citationsDiskError(scorecard.inspected, root);`. A checagem de cobertura mínima do diff **fica onde está** — ela é específica de `inspected`.

Exportar `quoteMatches` acrescentando `export` à declaração existente.

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test scripts/lms-inspection.test.mjs`
Expected: PASS, incluindo os testes antigos — a extração não pode mudar comportamento.

- [ ] **Step 5: Commit**

```bash
git add scripts/lms-inspection.mjs scripts/lms-inspection.test.mjs
git commit -m "refactor(lms): extrai checagem de citacao para uso alem de inspected"
```

---

### Task 3: Campo `coverage` — o denominador da varredura

**Files:**
- Modify: `scripts/lms-scorecard.mjs`
- Modify: `scripts/lms-reviewer-fallback.mjs` (`reviewPrompt`)
- Test: `scripts/lms-scorecard.test.mjs`

**Interfaces:**
- Consumes: `firstError`, `isNonNegativeInteger` (privadas de `lms-scorecard.mjs`).
- Produces: `coverageError(value)` (privada), chamada de dentro de `scorecardFormError`.

Forma do campo:

```json
"coverage": [
  { "surface": "rotas com parametro de caminho em app/api/v1", "total": 45, "inspected": 45 },
  { "surface": "queries prisma sem tenantId na vizinhanca", "total": 52, "inspected": 52 }
]
```

- [ ] **Step 1: Escrever o teste que falha**

Em `scripts/lms-scorecard.test.mjs`, acrescentar `coverage` ao helper `validScorecard()`:

```js
    coverage: [{ surface: 'arquivos alterados', total: 3, inspected: 3 }],
```

E os casos:

```js
import { scorecardFormError } from './lms-scorecard.mjs';

test('exige coverage', () => {
  const { coverage, ...semCoverage } = validScorecard();
  assert.match(scorecardFormError(semCoverage, options), /coverage/);
});

test('recusa coverage com inspected maior que total', () => {
  const card = validScorecard();
  card.coverage = [{ surface: 'rotas', total: 3, inspected: 4 }];
  assert.match(scorecardFormError(card, options), /inspected .* total/);
});

test('recusa superficie sem descricao', () => {
  const card = validScorecard();
  card.coverage = [{ surface: '  ', total: 3, inspected: 3 }];
  assert.match(scorecardFormError(card, options), /surface/);
});

test('aceita coverage bem formado', () => {
  assert.equal(scorecardFormError(validScorecard(), options), null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test scripts/lms-scorecard.test.mjs`
Expected: FAIL — o scorecard sem `coverage` passa hoje.

- [ ] **Step 3: Implementar `coverageError`**

Em `scripts/lms-scorecard.mjs`, antes de `aggregateShapeError`:

```js
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
```

Acrescentar `coverageError(value),` à lista de `firstError([...])` dentro de `scorecardFormError`, logo depois de `aggregateShapeError(value),`.

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test scripts/lms-scorecard.test.mjs`
Expected: PASS

- [ ] **Step 5: Ensinar o campo ao revisor**

Em `scripts/lms-reviewer-fallback.mjs`, em `reviewPrompt`, acrescentar uma regra numerada depois da regra 7 (`inspected`):

```js
    '  8. "coverage" declara O QUE VOCE VARREU e quanto: uma entrada por superficie,',
    '     {surface, total, inspected}. Superficie e uma familia enumeravel — "rotas com',
    '     parametro de caminho", "queries que nao citam tenant", "arquivos alterados".',
    '     `total` e quantos existem, `inspected` quantos voce de fato abriu. Varra a',
    '     superficie inteira quando ela couber; quando nao couber, diga o numero real em',
    '     vez de inflar. Declarar inspected < total e uma resposta honesta e aceita.',
```

E no bloco `'Exact shape:'`, depois do array `inspected`, acrescentar:

```js
    '  "coverage": [',
    '    { "surface": "arquivos alterados neste diff", "total": 7, "inspected": 7 },',
    '    { "surface": "handlers de rota tocados", "total": 3, "inspected": 3 }',
    '  ],',
```

Acrescentar também, logo antes do bloco `'--- WHAT CHANGED ---'`, a instrução que torna a superfície nomeável — não dá para declarar cobertura sem antes saber o que se está varrendo:

```js
    'Before judging code-safety: identify WHICH isolation mechanism this code path',
    'actually uses, then look for where it is missing. Do not assume. This repo has',
    'two, and they are not interchangeable: Postgres RLS bound to the JWT via',
    'get_current_tenant_id(), and — in services/fiscal/backend, which connects as the',
    'database owner and is therefore NOT subject to RLS — an explicit tenant_id filter',
    'written into every query. A finding that names the wrong mechanism is noise.',
    'The same rule applies to the other lenses: name the surface, then sweep it.',
    '',
```

- [ ] **Step 6: Rodar a suíte inteira do LMS**

Run: `pnpm test:lms`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add scripts/lms-scorecard.mjs scripts/lms-scorecard.test.mjs scripts/lms-reviewer-fallback.mjs
git commit -m "feat(lms): scorecard declara cobertura da varredura, nao so o que leu"
```

---

### Task 4: Campo `verified` — asserções positivas com citação

**Files:**
- Modify: `scripts/lms-scorecard.mjs`
- Modify: `scripts/lms-reviewer-fallback.mjs` (`reviewPrompt`)
- Test: `scripts/lms-scorecard.test.mjs`

**Interfaces:**
- Consumes: `citationShapeError(entries, campo)` e `citationsDiskError(entries, root)` da Task 2.
- Produces: `verifiedShapeError(value)` (privada) chamada de `scorecardFormError`; `verifiedDiskError(scorecard, root)` exportada, chamada pelo gate junto de `inspectionError`.

Forma:

```json
"verified": [
  { "claim": "issuers.py resolve o emissor por (id, tenant_id) em todos os handlers",
    "path": "services/fiscal/backend/app/api/v1/issuers.py", "line": 909,
    "quote": "issuer = _get_issuer_or_404(issuer_id, ctx.tenant_id, db)" }
]
```

- [ ] **Step 1: Escrever o teste que falha**

Em `scripts/lms-scorecard.test.mjs`, acrescentar ao helper `validScorecard()`:

```js
    verified: [
      { claim: 'o envelope resolve o tenant a partir do JWT', path: 'a.ts', line: 1, quote: 'linha citada verbatim' },
    ],
```

E:

```js
test('exige verified com pelo menos uma asercao', () => {
  const { verified, ...sem } = validScorecard();
  assert.match(scorecardFormError(sem, options), /verified/);
});

test('recusa asercao sem texto de claim', () => {
  const card = validScorecard();
  card.verified = [{ claim: 'ok', path: 'a.ts', line: 1, quote: 'linha citada verbatim' }];
  assert.match(scorecardFormError(card, options), /claim/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test scripts/lms-scorecard.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implementar**

Em `scripts/lms-scorecard.mjs`, importar as duas funções novas:

```js
import {
  changedOpenablePaths,
  citationShapeError,
  citationsDiskError,
  inspectedShapeError,
  inspectionError,
} from './lms-inspection.mjs';
```

E acrescentar:

```js
const MIN_CLAIM_LENGTH = 20;

/**
 * O que o revisor conferiu e considera CORRETO, com citacao.
 *
 * Existe para dar ao contraditorio algo barato de atacar. Provar ausencia de bug e
 * caro; derrubar "todos os handlers escopam por tenant" custa achar um handler. Sem
 * este campo, o refutador so podia discordar do score — uma discordancia sem alvo.
 */
function verifiedShapeError(value) {
  const shape = citationShapeError(value.verified, 'verified');
  if (shape) return shape;
  for (const entry of value.verified) {
    if (typeof entry.claim !== 'string' || entry.claim.trim().length < MIN_CLAIM_LENGTH) {
      return `verified entry for ${entry.path} needs a "claim" of at least ${MIN_CLAIM_LENGTH} chars saying what holds`;
    }
  }
  return null;
}

/** Citacoes de `verified` conferidas no disco. Usado pelo gate, junto de inspectionError. */
export async function verifiedDiskError(scorecard, root = process.cwd()) {
  const shape = verifiedShapeError(scorecard);
  if (shape) return shape;
  return citationsDiskError(scorecard.verified, root);
}
```

Acrescentar `verifiedShapeError(value),` à lista de `firstError` de `scorecardFormError`, logo depois de `inspectedShapeError(value),`.

Em `validateFile`, depois da checagem de `proofError`, acrescentar:

```js
    const verifiedError = await verifiedDiskError(value, process.cwd());
    if (verifiedError) {
      console.error(`invalid LMS scorecard: ${verifiedError}`);
      process.exitCode = 1;
    }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test scripts/lms-scorecard.test.mjs`
Expected: PASS

- [ ] **Step 5: Ensinar o campo ao revisor**

Em `reviewPrompt`, acrescentar a regra 9:

```js
    '  9. "verified" e o oposto de "findings": o que voce CONFERIU e esta CORRETO, com',
    '     citacao verificada no disco igual a "inspected". Uma entrada por afirmacao:',
    '     {claim, path, line, quote}. Escreva afirmacoes especificas e atacaveis ("todos',
    '     os handlers de issuers.py resolvem por (id, tenant_id)"), nunca elogio vago',
    '     ("o codigo esta bom"). Minimo uma entrada. Um segundo revisor sera pago para',
    '     tentar derrubar estas afirmacoes, entao nao afirme o que voce nao conferiu.',
```

E no `'Exact shape:'`, depois do bloco `coverage`:

```js
    '  "verified": [',
    '    { "claim": "todo handler com {id} resolve o objeto por (id, tenant_id)",',
    '      "path": "path/from/the/list.py", "line": 909,',
    '      "quote": "issuer = _get_issuer_or_404(issuer_id, ctx.tenant_id, db)" }',
    '  ],',
```

- [ ] **Step 6: Rodar a suíte**

Run: `pnpm test:lms`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add scripts/lms-scorecard.mjs scripts/lms-scorecard.test.mjs scripts/lms-reviewer-fallback.mjs
git commit -m "feat(lms): scorecard registra o que foi conferido e esta correto"
```

---

### Task 5: Lente inaplicável declarada, em vez de lente vazia

**Files:**
- Modify: `scripts/lms-scorecard.mjs` (`lensFindings`, `lensTotals`)
- Modify: `scripts/lms-reviewer-fallback.mjs` (`reviewPrompt`)
- Test: `scripts/lms-scorecard.test.mjs`

**Interfaces:**
- Consumes: `LENSES` (já existe em `lms-scorecard.mjs:7`).
- Produces: aceita `{ p0, p1, p2, applicable: false, na_reason: "..." }` numa lente.

- [ ] **Step 1: Escrever o teste que falha**

```js
test('aceita lente declarada inaplicavel com motivo', () => {
  const card = validScorecard();
  card.lenses['code-efficiency'] = {
    p0: 0, p1: 0, p2: 0,
    applicable: false,
    na_reason: 'diff toca apenas documentacao; nao ha caminho de execucao',
  };
  assert.equal(scorecardFormError(card, options), null);
});

test('recusa lente inaplicavel sem motivo', () => {
  const card = validScorecard();
  card.lenses['code-efficiency'] = { p0: 0, p1: 0, p2: 0, applicable: false };
  assert.match(scorecardFormError(card, options), /na_reason/);
});

test('recusa lente inaplicavel que ainda reporta achado', () => {
  const card = validScorecard();
  card.lenses['code-efficiency'] = {
    p0: 0, p1: 1, p2: 0, applicable: false, na_reason: 'nao se aplica a este diff',
  };
  card.p1 = 1;
  assert.match(scorecardFormError(card, options), /applicable: false/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test scripts/lms-scorecard.test.mjs`
Expected: FAIL — hoje `applicable: false` sem `na_reason` passa.

- [ ] **Step 3: Implementar**

Em `scripts/lms-scorecard.mjs`, trocar `lensFindings` por:

```js
const MIN_NA_REASON = 15;

/**
 * Lente vazia era ambigua: `{p0:0,p1:0,p2:0}` significa "limpo" ou "nao olhei"?
 * `applicable: false` obriga a dizer qual dos dois, com motivo — e uma lente
 * inaplicavel nao pode reportar achado, senao ela se aplicava.
 */
function lensError(lens, nome) {
  if (!lens || typeof lens !== 'object' || Array.isArray(lens)) {
    return `invalid findings for ${nome}`;
  }
  for (const field of ['p0', 'p1', 'p2']) {
    if (!isNonNegativeInteger(lens[field])) return `invalid findings for ${nome}`;
  }
  if (lens.applicable === false) {
    if (typeof lens.na_reason !== 'string' || lens.na_reason.trim().length < MIN_NA_REASON) {
      return `${nome} is marked applicable: false and needs a "na_reason" explaining why`;
    }
    if (lens.p0 + lens.p1 + lens.p2 > 0) {
      return `${nome} has findings but is marked applicable: false`;
    }
  }
  return null;
}
```

E em `lensTotals`, trocar a checagem:

```js
function lensTotals(value) {
  const totals = { p0: 0, p1: 0, p2: 0 };
  for (const lensName of LENSES) {
    const lens = value.lenses[lensName];
    const erro = lensError(lens, lensName);
    if (erro) return { error: erro };
    for (const field of Object.keys(totals)) totals[field] += lens[field];
  }
  return { totals };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test scripts/lms-scorecard.test.mjs`
Expected: PASS

- [ ] **Step 5: Ensinar ao revisor**

Em `reviewPrompt`, acrescentar à regra 4 (chaves das lentes):

```js
    '     Uma lente que NAO se aplica a este diff deve dizer isso explicitamente:',
    '     {"p0":0,"p1":0,"p2":0,"applicable":false,"na_reason":"por que nao se aplica"}.',
    '     Zerada sem `applicable` significa "olhei e esta limpo" — nao use como',
    '     sinonimo de "nao olhei".',
```

- [ ] **Step 6: Rodar a suíte**

Run: `pnpm test:lms`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add scripts/lms-scorecard.mjs scripts/lms-scorecard.test.mjs scripts/lms-reviewer-fallback.mjs
git commit -m "feat(lms): lente inaplicavel se declara em vez de sair zerada"
```

---

### Task 6: Achado com identidade, precondição e critério de aceite

Sem id estável, o scorecard é um retrato: não dá para dizer se o P1 da rodada 3 é o mesmo da rodada 2. `precondition` separa achado vivo de achado teórico. `acceptance` é o que transforma um P2 adiado em algo que a rodada seguinte confere.

**Files:**
- Modify: `scripts/lms-scorecard.mjs`
- Modify: `scripts/lms-reviewer-fallback.mjs` (`reviewPrompt`, `stampScorecard`)
- Test: `scripts/lms-scorecard.test.mjs`

**Interfaces:**
- Consumes: `createHash` de `node:crypto`.
- Produces:
  - `export function findingId(finding)` → `string` (12 hex) — hash de `lens|path-sem-linha|title`.
  - `export function findingsShapeError(value)` → `string | null`.
  - `stampScorecard` passa a carimbar `id` em cada finding que não trouxer um.

O id ignora o número da linha de propósito: o mesmo defeito, depois de o arquivo crescer três linhas acima, continua sendo o mesmo defeito.

- [ ] **Step 1: Escrever o teste que falha**

```js
import { findingId, findingsShapeError } from './lms-scorecard.mjs';

const achado = () => ({
  lens: 'code-safety', severity: 'P1', confidence: 90,
  path: 'src/a.ts:42', title: 'falta filtro de tenant',
  why: 'a query nao escopa por tenant', fix: 'somar tenantId ao where',
});

test('findingId ignora o numero da linha', () => {
  const a = findingId(achado());
  const b = findingId({ ...achado(), path: 'src/a.ts:45' });
  assert.equal(a, b);
});

test('findingId muda quando o titulo muda', () => {
  assert.notEqual(findingId(achado()), findingId({ ...achado(), title: 'outro defeito' }));
});

test('recusa severidade fora de P0/P1/P2', () => {
  assert.match(findingsShapeError({ findings: [{ ...achado(), severity: 'CRITICAL' }] }), /severity/);
});

test('recusa confidence fora de 0-100', () => {
  assert.match(findingsShapeError({ findings: [{ ...achado(), confidence: 140 }] }), /confidence/);
});

test('aceita precondition e acceptance opcionais', () => {
  assert.equal(
    findingsShapeError({
      findings: [{ ...achado(), precondition: 'so com LMS_FIX_MODE=reviewer', acceptance: ['teste X passa'] }],
    }),
    null,
  );
});

test('aceita ausencia de findings quando nao ha achado', () => {
  assert.equal(findingsShapeError({ findings: [] }), null);
  assert.equal(findingsShapeError({}), null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test scripts/lms-scorecard.test.mjs`
Expected: FAIL — `findingId is not a function`.

- [ ] **Step 3: Implementar**

Em `scripts/lms-scorecard.mjs`, no topo:

```js
import { createHash } from 'node:crypto';
```

E:

```js
const SEVERIDADES = new Set(['P0', 'P1', 'P2']);

/**
 * Identidade estavel de um achado, para segui-lo entre iteracoes.
 *
 * A LINHA fica de fora de proposito: o mesmo defeito, depois de o arquivo crescer
 * tres linhas acima, continua sendo o mesmo defeito. Sem isto o scorecard e um
 * retrato — nao da para dizer se "corrigi" mudou codigo, nem se o P1 desta rodada e
 * o mesmo da anterior.
 */
export function findingId(finding) {
  const path = String(finding?.path ?? '').split(':')[0].trim();
  const material = [finding?.lens ?? '', path, String(finding?.title ?? '').trim().toLowerCase()];
  return createHash('sha256').update(material.join('\0')).digest('hex').slice(0, 12);
}

/**
 * Forma dos achados. `findings` ausente ou vazio e legitimo — e o 5/5.
 *
 * `precondition` e opcional e existe para separar achado vivo de achado teorico:
 * "so exploravel com a flag X ligada" e informacao que muda a severidade e que hoje
 * nao tinha onde morar.
 */
export function findingsShapeError(value) {
  const findings = value.findings;
  if (findings === undefined || findings === null) return null;
  if (!Array.isArray(findings)) return 'findings must be an array';
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      return 'each finding must be an object';
    }
    if (!SEVERIDADES.has(finding.severity)) {
      return `finding "${finding.title ?? '?'}" needs severity P0, P1 or P2`;
    }
    if (!Number.isInteger(finding.confidence) || finding.confidence < 0 || finding.confidence > 100) {
      return `finding "${finding.title ?? '?'}" needs an integer confidence between 0 and 100`;
    }
    for (const campo of ['path', 'title', 'why']) {
      if (typeof finding[campo] !== 'string' || !finding[campo].trim()) {
        return `finding "${finding.title ?? '?'}" needs a non-empty ${campo}`;
      }
    }
    if (finding.precondition !== undefined && typeof finding.precondition !== 'string') {
      return `finding "${finding.title}" has a non-string precondition`;
    }
    if (finding.acceptance !== undefined) {
      if (!Array.isArray(finding.acceptance) || finding.acceptance.some((c) => typeof c !== 'string')) {
        return `finding "${finding.title}" needs acceptance as an array of strings`;
      }
    }
  }
  return null;
}
```

Acrescentar `findingsShapeError(value),` ao `firstError` de `scorecardFormError`, depois de `verifiedShapeError(value),`.

Em `scripts/lms-reviewer-fallback.mjs`, importar `findingId` de `./lms-scorecard.mjs` e carimbar o id dentro de `stampScorecard`. A função hoje devolve `{ ...parsed, reviewer, base, fallow, autonomy, at, ...extra }` — os `findings` chegam pelo spread de `parsed` e precisam ser sobrescritos **depois** dele:

```js
export function stampScorecard(parsed, provider, fallow, base, extra = {}) {
  if (!parsed) return null;
  // O runner crava os fatos objetivos: quem revisou, contra qual base, quando, e o
  // que o fallow mediu. O modelo julga o codigo — nao tem relogio confiavel nem
  // shell, e ja errou `at` com data no futuro e `base` omitido.
  //
  // O id do achado entra aqui pelo mesmo motivo: e derivado, nao julgado. Deixar o
  // modelo inventar id abriria caminho para dois achados iguais com ids diferentes
  // (e a rastreabilidade entre iteracoes morre em silencio).
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map((finding) => ({ ...finding, id: finding.id ?? findingId(finding) }))
    : parsed.findings;
  return {
    ...parsed,
    reviewer: provider,
    base,
    fallow,
    autonomy: 'reviewer',
    at: new Date().toISOString(),
    ...(findings === undefined ? {} : { findings }),
    ...extra,
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test scripts/lms-scorecard.test.mjs`
Expected: PASS

- [ ] **Step 5: Ensinar ao revisor**

Em `reviewPrompt`, acrescentar à regra 6 (findings):

```js
    '     Cada achado pode trazer "precondition" (o que precisa ser verdade para ser',
    '     explorado: flag ligada, config insegura, ambiente especifico) e "acceptance"',
    '     (lista de criterios verificaveis que provam a correcao). Precondicao vazia',
    '     significa exploravel como o codigo esta. Nao invente precondicao para',
    '     amaciar um achado real, nem omita para inflar um teorico.',
```

E no exemplo do `'Exact shape:'`, trocar o objeto de finding por:

```js
    '    { "lens": "code-safety", "severity": "P1", "confidence": 90,',
    '      "path": "path/to/file.ts:42", "title": "short title",',
    '      "why": "why it matters", "fix": "suggested fix",',
    '      "precondition": "", "acceptance": ["o teste X falha antes e passa depois"] }',
```

- [ ] **Step 6: Rodar a suíte**

Run: `pnpm test:lms`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add scripts/lms-scorecard.mjs scripts/lms-scorecard.test.mjs scripts/lms-reviewer-fallback.mjs
git commit -m "feat(lms): achado ganha id estavel, precondicao e criterio de aceite"
```

---

### Task 7: Retentativa com o erro de validação, em vez de queimar o provider

Hoje um JSON malformado é classificado como "o provider não fez o trabalho" e a cadeia cai para o próximo. Uma vírgula custa um revisor. O Claude Code resolve isso com uma tool tipada; sem tool cross-provider, o equivalente é devolver **a mensagem de validação específica** e deixar tentar uma vez.

**Files:**
- Modify: `scripts/lms-reviewer-fallback.mjs` (`attemptProvider`)
- Test: `scripts/lms-reviewer-fallback.test.mjs`

**Interfaces:**
- Consumes: `scorecardFormError` (já importada), `collect` (injetada).
- Produces: `export function retryPrompt(promptOriginal, erro)` → `string`.
- `attemptProvider` ganha a opção `maxTentativas = 2` (a segunda só acontece se a primeira falhou por **forma**, nunca por veredito).

- [ ] **Step 1: Escrever o teste que falha**

Em `scripts/lms-reviewer-fallback.test.mjs`:

```js
import { retryPrompt } from './lms-reviewer-fallback.mjs';

test('retryPrompt carrega a mensagem de validacao e o prompt original', () => {
  const p = retryPrompt('PROMPT ORIGINAL', 'coverage is required');
  assert.match(p, /coverage is required/);
  assert.match(p, /PROMPT ORIGINAL/);
  assert.match(p, /rejected/i);
});
```

E dois testes de integração do `attemptProvider`. O arquivo já tem o helper `fixture()` (linha 179), que monta um repositório temporário com scorecard válido — reusar, não duplicar. `collect` é injetado e devolve `{ kind, candidate }`, no formato de `collectHeadless`:

```js
test('attemptProvider tenta de novo quando a primeira saida esta malformada', async () => {
  const { root, opcoes, scorecardValido } = await fixture();
  const saidas = [{ score: 5 }, scorecardValido];
  let chamadas = 0;
  const collect = async () => ({ kind: 'ok', candidate: saidas[chamadas++] });
  const r = await attemptProvider({ ...opcoes, root, collect });
  assert.equal(chamadas, 2, 'devia ter dado uma segunda chance');
  assert.equal(r.accepted, true);
});

test('attemptProvider NAO tenta de novo quando o scorecard e valido e reprova', async () => {
  const { root, opcoes, scorecardValido } = await fixture();
  let chamadas = 0;
  const collect = async () => {
    chamadas += 1;
    return { kind: 'ok', candidate: { ...scorecardValido, score: 2, p1: 1,
      lenses: { ...scorecardValido.lenses, 'code-safety': { p0: 0, p1: 1, p2: 0 } } } };
  };
  const r = await attemptProvider({ ...opcoes, root, collect });
  assert.equal(chamadas, 1, 'reprovacao legitima nao ganha segunda chance');
  assert.equal(r.rejected, true);
});
```

Se `fixture()` ainda não expuser `opcoes` e `scorecardValido`, estender o helper para devolvê-los em vez de montar um segundo fixture ao lado — teste irmão nascendo duplicado é o que o fallow reprova.

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test scripts/lms-reviewer-fallback.test.mjs`
Expected: FAIL — `retryPrompt is not a function`; e a contagem de chamadas é 1.

- [ ] **Step 3: Implementar**

Em `scripts/lms-reviewer-fallback.mjs`:

```js
/**
 * Segunda chance por ERRO DE FORMA, nunca por veredito.
 *
 * A cadeia tratava JSON malformado como "o provider nao fez o trabalho" e caia para
 * o proximo — uma virgula custava um revisor, e o ultimo da fila herdava a culpa. O
 * que a validacao ja sabe (qual campo, o que se esperava) volta para quem errou.
 *
 * Reprovacao legitima NAO entra aqui: pedir de novo a quem reprovou e procurar um
 * "sim" — exatamente o que a cadeia foi desenhada para nao fazer.
 */
export function retryPrompt(promptOriginal, erro) {
  return [
    'Your previous output was rejected by the scorecard validator.',
    '',
    `VALIDATION ERROR: ${erro}`,
    '',
    'Fix ONLY that. Your judgement of the code stands — do not re-review, do not',
    'change the score, do not drop findings. Emit the same review with the format',
    'corrected. Output exactly one JSON object, no prose, no markdown fences.',
    '',
    '--- ORIGINAL INSTRUCTIONS ---',
    promptOriginal,
  ].join('\n');
}
```

Em `attemptProvider`, envolver a coleta num laço de até duas voltas. A segunda volta só acontece quando `scorecardFormError` devolveu erro (forma), e usa `retryPrompt(prompt, erroDeForma)` como entrada. Quando a segunda também falhar, o resultado é o mesmo de hoje (`invalid-output`, cai para o próximo provider). Registrar a retentativa em `logAttempt` com `extra: 'retry'` para que `.lms/fallback.log` mostre que houve segunda chance.

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test scripts/lms-reviewer-fallback.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lms-reviewer-fallback.mjs scripts/lms-reviewer-fallback.test.mjs
git commit -m "feat(lms): erro de forma devolve a mensagem de validacao em vez de queimar o provider"
```

---

### Task 8: Publicar o schema e atualizar o SKILL.md

**Files:**
- Create: `.agents/skills/local-merge-score/references/scorecard.schema.json`
- Modify: `.agents/skills/local-merge-score/SKILL.md`
- Test: `scripts/lms-scorecard.test.mjs`

**Interfaces:**
- Consumes: `validateScorecard` e o exemplo do SKILL.md.
- Produces: um arquivo de schema que o teste mantém sincronizado com o validador.

- [ ] **Step 1: Escrever o teste que falha**

```js
import { readFile } from 'node:fs/promises';

test('o exemplo do schema publicado passa no validador', async () => {
  const schema = JSON.parse(
    await readFile(new URL('../.agents/skills/local-merge-score/references/scorecard.schema.json', import.meta.url)),
  );
  const exemplo = schema.examples[0];
  assert.equal(
    scorecardFormError(exemplo, { reviewer: exemplo.reviewer, base: exemplo.base, now: Date.parse(exemplo.at) + 1000 }),
    null,
  );
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test scripts/lms-scorecard.test.mjs`
Expected: FAIL — arquivo não existe.

- [ ] **Step 3: Criar o schema**

`.agents/skills/local-merge-score/references/scorecard.schema.json`: JSON Schema draft-2020-12 descrevendo `reviewer`, `score`, `target`, `base`, `subject`, `at`, `autonomy`, `fallow`, `p0`/`p1`/`p2`, `lenses` (com `applicable`/`na_reason`), `inspected`, `coverage`, `verified` e `findings` (com `id`, `precondition`, `acceptance`), e um `examples: [...]` com um scorecard 5/5 completo — o mesmo objeto que o `validScorecard()` do teste produz, incluindo os campos das Tasks 3 a 6.

O schema é documentação executável: o teste do Step 1 impede que ele divirja do validador.

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test scripts/lms-scorecard.test.mjs`
Expected: PASS

- [ ] **Step 5: Atualizar o SKILL.md**

Em `.agents/skills/local-merge-score/SKILL.md`, na seção "Write scorecard for the hook", substituir o JSON de exemplo pelo exemplo completo do schema e acrescentar, logo abaixo:

```markdown
O contrato canônico é [references/scorecard.schema.json](references/scorecard.schema.json),
mantido em sincronia com `scripts/lms-scorecard.mjs` por teste. Campos novos desta versão:

| Campo | Para quê |
| --- | --- |
| `coverage` | Denominador da varredura: `{surface, total, inspected}` por superfície. Distingue "abriu 3 de 45" de "abriu as 45". |
| `verified` | Asserções positivas com citação conferida no disco. Dá ao contraditório um alvo barato de derrubar. |
| `lenses.<lente>.applicable` + `na_reason` | Lente que não se aplica se declara, em vez de sair zerada e ambígua. |
| `findings[].id` | Identidade estável entre iterações (hash de lente + arquivo + título; ignora a linha). |
| `findings[].precondition` | Condição de explorabilidade. Separa achado vivo de teórico. |
| `findings[].acceptance` | Critérios verificáveis que provam a correção. |
```

- [ ] **Step 6: Rodar a suíte inteira e o gate**

Run: `pnpm test:lms`
Expected: PASS

Run: `pnpm dox-check`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add .agents/skills/local-merge-score/references/scorecard.schema.json \
  .agents/skills/local-merge-score/SKILL.md scripts/lms-scorecard.test.mjs
git commit -m "docs(lms): publica o schema do scorecard e sincroniza com o validador"
```

---

## Fim da Fase 1

Ao terminar, `.lms/last.json` passa a exigir `coverage`, `verified`, lente declarada e achados com id. O primeiro push depois do deploy vai gastar uma rodada de revisão a mais (o scorecard em cache é rejeitado por forma) — comportamento esperado, não regressão.

Fases 2 e 3 podem começar em paralelo a partir daqui.
