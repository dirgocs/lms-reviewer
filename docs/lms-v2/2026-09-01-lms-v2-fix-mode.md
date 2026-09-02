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

# LMS v2 — Fase 3: fix mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deixar o revisor que achou o defeito corrigi-lo, com o contexto do tamanho do defeito — sem que ele consiga aprovar o próprio conserto nem tocar no gate que o julga.

**Architecture:** Um runner novo (`scripts/lms-fix.mjs`) que lê `.lms/last.json`, decide quais achados são corrigíveis pelo revisor, invoca **uma segunda vez** o provider que os achou (agora com sandbox de escrita), e valida o diff resultante contra uma guarda de escopo e uma denylist. Pontuar continua read-only; corrigir é outra invocação. O `subject` hash já existente invalida o scorecard automaticamente assim que o fix toca o disco — é isso que impede o revisor de aprovar o próprio conserto.

**Tech Stack:** Node 22 ESM, `node --test`, `git` via `execFile`. Sem dependências novas.

**Spec:** `docs/superpowers/specs/2026-09-01-lms-v2.md` (§3.2 a §3.5)

## Global Constraints

- **Depende da Fase 1** (`docs/superpowers/plans/2026-09-01-lms-v2-contrato.md`): usa `findings[].id`, `findings[].path` e `findings[].acceptance`.
- PNPM only (ADR-009).
- Zero dependências novas.
- **Pontuar e corrigir nunca no mesmo turno.** Um revisor que pontua e corrige na mesma invocação tem incentivo a achar o que ele gosta de consertar.
- **O fix nunca escreve no gate.** `.lms/`, `.claude/hooks/`, `scripts/lms-*`, `scripts/db-exposure-gate*`, `.git/` são proibidos, conferidos **antes e depois**. Um agente com mandato de corrigir e incentivo de passar no gate, com escrita no gate, edita o gate.
- **Fix fora do escopo é revertido inteiro**, nunca parcialmente aceito.
- `LMS_FIX_MODE` default `off`. Ligar é decisão explícita.
- Comentários em pt-BR, como o resto de `scripts/lms-*`.

---

### Task 1: Regra de roteamento — quem corrige cada achado

**Files:**
- Create: `scripts/lms-fix-routing.mjs`
- Create: `scripts/lms-fix-routing.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `CAMINHOS_DE_RISCO` de `./lms-effort.mjs` (Fase 2 Task 2). Se a Fase 2 ainda não tiver ido, copiar a constante para este módulo e deixar `// ponytail: duplicado ate a Fase 2 exportar` — não bloquear.
- Produces:
  - `export const CAMINHOS_PROIBIDOS` → `RegExp[]`
  - `export function caminhoProibido(path)` → `boolean`
  - `export function corrigivelPeloRevisor(finding)` → `{ ok: boolean, motivo: string }`
  - `export function arquivosDoAchado(finding)` → `string[]`

- [ ] **Step 1: Escrever o teste que falha**

`scripts/lms-fix-routing.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { arquivosDoAchado, caminhoProibido, corrigivelPeloRevisor } from './lms-fix-routing.mjs';

const achado = (over = {}) => ({
  id: 'a1', lens: 'code-safety', severity: 'P1', confidence: 90,
  path: 'services/api/src/routes/pos-reference.ts:1547',
  title: 'lock sem checagem de posse',
  why: 'printer_id nao e validado contra o tenant',
  fix: 'resolver a impressora por (id, tenantId) antes do INSERT',
  ...over,
});

test('arquivosDoAchado tira o numero da linha', () => {
  assert.deepEqual(arquivosDoAchado(achado()), ['services/api/src/routes/pos-reference.ts']);
});

test('arquivosDoAchado aceita lista de caminhos', () => {
  assert.deepEqual(
    arquivosDoAchado(achado({ path: ['a.ts:1', 'b.ts:2'] })),
    ['a.ts', 'b.ts'],
  );
});

test('achado localizado e corrigivel pelo revisor', () => {
  assert.equal(corrigivelPeloRevisor(achado()).ok, true);
});

test('achado em caminho de risco vai para o orquestrador', () => {
  const r = corrigivelPeloRevisor(achado({ path: 'services/fiscal/backend/app/auth.py:80' }));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /risco/i);
});

test('achado sem fix acionavel vai para o orquestrador', () => {
  const r = corrigivelPeloRevisor(achado({ fix: 'decidir se a rota deve existir' }));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /decis/i);
});

test('achado sem campo fix vai para o orquestrador', () => {
  const r = corrigivelPeloRevisor(achado({ fix: undefined }));
  assert.equal(r.ok, false);
});

test('achado em caminho proibido nunca e corrigivel', () => {
  assert.equal(corrigivelPeloRevisor(achado({ path: 'scripts/lms-scorecard.mjs:10' })).ok, false);
  assert.equal(corrigivelPeloRevisor(achado({ path: '.claude/hooks/x.sh:1' })).ok, false);
});

test('caminhoProibido cobre o gate inteiro', () => {
  for (const p of [
    '.lms/last.json', '.claude/hooks/local-merge-score-gate.sh',
    'scripts/lms-fix.mjs', 'scripts/db-exposure-gate.mjs', '.git/config',
  ]) {
    assert.equal(caminhoProibido(p), true, p);
  }
  assert.equal(caminhoProibido('services/api/src/routes/rooms.ts'), false);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test scripts/lms-fix-routing.test.mjs`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

`scripts/lms-fix-routing.mjs`:

```js
/**
 * Quem corrige cada achado.
 *
 * A forma do achado responde: se `fix` e um diff, quem achou tem o contexto do
 * tamanho exato do defeito e corrige melhor que o orquestrador, que precisaria
 * re-derivar tudo a partir de um resumo em prosa. Se `fix` e uma decisao, o revisor
 * nao conhece o plano e escala.
 */
import { CAMINHOS_DE_RISCO } from './lms-effort.mjs';

/**
 * O fix NUNCA escreve aqui.
 *
 * Um agente com mandato de corrigir e incentivo de passar no gate, com acesso de
 * escrita ao gate, edita o gate. Mesma razao pela qual PROVAS_PERMITIDAS e allowlist
 * fechada: o que sai do modelo nao manda no que julga o modelo.
 */
export const CAMINHOS_PROIBIDOS = [
  /^\.lms\//,
  /^\.claude\/hooks\//,
  /^scripts\/lms-/,
  /^scripts\/db-exposure-gate/,
  /^scripts\/local-merge-score/,
  /^\.agents\/skills\/local-merge-score\//,
  /^\.git\//,
  /^\.husky\//,
];

export function caminhoProibido(path) {
  const limpo = String(path ?? '').replace(/^\.\//, '').trim();
  return CAMINHOS_PROIBIDOS.some((re) => re.test(limpo));
}

export function arquivosDoAchado(finding) {
  const bruto = Array.isArray(finding?.path) ? finding.path : [finding?.path];
  return [
    ...new Set(
      bruto
        .filter((p) => typeof p === 'string' && p.trim())
        .map((p) => p.split(':')[0].trim().replace(/^\.\//, '')),
    ),
  ];
}

// Um `fix` que fala de decisao, e nao de edicao, e o sinal de que o revisor nao tem
// o contexto necessario: ele nao conhece o plano do produto.
const PEDE_DECISAO = /\b(decid|avali|discut|considerar se|remover a rota|repensar|arquitetur|escolher entre)/i;

const MIN_FIX = 20;

export function corrigivelPeloRevisor(finding) {
  const arquivos = arquivosDoAchado(finding);
  if (arquivos.length === 0) return { ok: false, motivo: 'achado sem arquivo citado' };
  if (arquivos.some(caminhoProibido)) {
    return { ok: false, motivo: 'achado toca o proprio gate — correcao e do Master' };
  }
  if (arquivos.some((p) => CAMINHOS_DE_RISCO.test(p))) {
    return { ok: false, motivo: 'caminho de risco (auth/tenant/fiscal/migration) — vai para o orquestrador' };
  }
  const fix = String(finding?.fix ?? '').trim();
  if (fix.length < MIN_FIX) return { ok: false, motivo: 'sem fix acionavel descrito' };
  if (PEDE_DECISAO.test(fix)) {
    return { ok: false, motivo: 'o fix pede decisao, nao edicao — vai para o orquestrador' };
  }
  return { ok: true, motivo: 'fix localizado nos arquivos citados' };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test scripts/lms-fix-routing.test.mjs`
Expected: PASS

- [ ] **Step 5: Registrar na suíte e commitar**

Acrescentar `scripts/lms-fix-routing.test.mjs` ao `test:lms`.

Run: `pnpm test:lms`
Expected: PASS

```bash
git add scripts/lms-fix-routing.mjs scripts/lms-fix-routing.test.mjs package.json
git commit -m "feat(lms): regra de roteamento decide quem corrige cada achado"
```

---

### Task 2: Guarda de escopo — o fix que sai do lugar é revertido inteiro

**Files:**
- Create: `scripts/lms-fix-escopo.mjs`
- Create: `scripts/lms-fix-escopo.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `caminhoProibido` de `./lms-fix-routing.mjs`; `execFile` de `node:child_process`.
- Produces:
  - `export function escopoViolado(alterados, permitidos)` → `string | null`
  - `export async function arquivosAlterados(root, desde)` → `string[]`
  - `export async function reverter(root, arquivos)` → `void`

`desde` é o SHA do `git stash create` tirado antes do fix, ou `null` para comparar contra `HEAD` mais a árvore suja. A reversão usa `git checkout --` nos arquivos e `git clean -f` nos não rastreados que o fix criou — nunca `git reset --hard`, que apagaria trabalho do Master na mesma árvore.

- [ ] **Step 1: Escrever o teste que falha**

`scripts/lms-fix-escopo.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { escopoViolado } from './lms-fix-escopo.mjs';

test('aceita fix restrito aos arquivos permitidos', () => {
  assert.equal(escopoViolado(['src/a.ts'], ['src/a.ts', 'src/b.ts']), null);
});

test('recusa arquivo fora da lista', () => {
  const e = escopoViolado(['src/a.ts', 'src/z.ts'], ['src/a.ts']);
  assert.match(e, /src\/z\.ts/);
  assert.match(e, /fora do escopo/i);
});

test('recusa caminho proibido mesmo se estiver na lista permitida', () => {
  const e = escopoViolado(['scripts/lms-scorecard.mjs'], ['scripts/lms-scorecard.mjs']);
  assert.match(e, /proibido/i);
});

test('fix que nao mudou nada e violacao, nao sucesso', () => {
  const e = escopoViolado([], ['src/a.ts']);
  assert.match(e, /nenhum arquivo/i);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test scripts/lms-fix-escopo.test.mjs`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

`scripts/lms-fix-escopo.mjs`:

```js
/**
 * Guarda de escopo do fix.
 *
 * O risco real do fix por revisor nao e o conserto errado — e o "ja que estou aqui".
 * Um agente com escrita e um mandato refatora mais do que o achado. A guarda e
 * mecanica: o diff que o fix produziu tem de caber nos arquivos que o achado citou.
 *
 * Violacao reverte o fix INTEIRO. Aceitar a parte boa de um fix que estourou o escopo
 * seria deixar o agente negociar o proprio limite.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { caminhoProibido } from './lms-fix-routing.mjs';

const execFile = promisify(execFileCallback);

export function escopoViolado(alterados, permitidos) {
  const proibido = alterados.find(caminhoProibido);
  if (proibido) return `o fix escreveu em caminho proibido: ${proibido}`;
  if (alterados.length === 0) return 'o fix nao alterou nenhum arquivo';
  const permitidoSet = new Set(permitidos);
  const fora = alterados.filter((p) => !permitidoSet.has(p));
  return fora.length > 0
    ? `o fix alterou arquivo fora do escopo do achado: ${fora.slice(0, 5).join(', ')}`
    : null;
}

/** Arquivos que mudaram na arvore desde `desde` (SHA de `git stash create`). */
export async function arquivosAlterados(root, desde) {
  const args = desde
    ? ['diff', '--name-only', desde]
    : ['status', '--porcelain'];
  const { stdout } = await execFile('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return stdout
    .split('\n')
    .map((linha) => (desde ? linha.trim() : linha.slice(3).trim()))
    .filter(Boolean);
}

/**
 * Desfaz o fix, arquivo por arquivo.
 *
 * `git checkout --` nos rastreados e `git clean -f` nos novos, NUNCA `reset --hard`:
 * a arvore e compartilhada com o Master e com outras lanes, e um reset apagaria
 * trabalho que nao e do fix.
 */
export async function reverter(root, arquivos) {
  for (const arquivo of arquivos) {
    try {
      await execFile('git', ['checkout', '--', arquivo], { cwd: root });
    } catch {
      // Arquivo novo nao tem versao anterior para restaurar: some com clean.
      await execFile('git', ['clean', '-f', '--', arquivo], { cwd: root }).catch(() => {});
    }
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test scripts/lms-fix-escopo.test.mjs`
Expected: PASS

- [ ] **Step 5: Registrar na suíte e commitar**

Acrescentar `scripts/lms-fix-escopo.test.mjs` ao `test:lms`.

Run: `pnpm test:lms`
Expected: PASS

```bash
git add scripts/lms-fix-escopo.mjs scripts/lms-fix-escopo.test.mjs package.json
git commit -m "feat(lms): guarda de escopo reverte fix que sai dos arquivos do achado"
```

---

### Task 3: Sandbox de escrita, separado do sandbox de revisão

**Files:**
- Modify: `scripts/lms-reviewer-fallback.mjs` (`commandFor`)
- Modify: `scripts/lms-reviewer-fallback.test.mjs`

**Interfaces:**
- Consumes: `config` já montado por `providerConfig`.
- Produces: `commandFor(provider, config, { modo = 'review' })` — `modo: 'fix'` troca as permissões.

O sandbox é o que garante a restrição, não a instrução em prosa. Em modo `fix`, cada CLI ganha escrita **no workspace** — nunca acesso total.

- [ ] **Step 1: Escrever o teste que falha**

```js
import { commandFor, providerConfig } from './lms-reviewer-fallback.mjs';

test('modo review mantem o codex em read-only', () => {
  const c = commandFor('codex', { ...providerConfig({}), prompt: 'x' });
  assert.equal(c.args.includes('read-only'), true);
});

test('modo fix da escrita de workspace ao codex, nunca acesso total', () => {
  const c = commandFor('codex', { ...providerConfig({}), prompt: 'x' }, { modo: 'fix' });
  assert.equal(c.args.includes('workspace-write'), true);
  assert.equal(c.args.includes('read-only'), false);
  assert.equal(c.args.some((a) => String(a).includes('danger')), false);
});

test('modo fix libera Edit e Write no claude, e so eles', () => {
  const c = commandFor('claude', { ...providerConfig({}), prompt: 'x' }, { modo: 'fix' });
  const tools = c.args[c.args.indexOf('--tools') + 1];
  assert.match(tools, /Edit/);
  assert.match(tools, /Write/);
  assert.equal(/Bash/.test(tools), false);
});

test('modo review nao libera Edit no claude', () => {
  const c = commandFor('claude', { ...providerConfig({}), prompt: 'x' });
  assert.equal(/Edit/.test(c.args[c.args.indexOf('--tools') + 1]), false);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test scripts/lms-reviewer-fallback.test.mjs`
Expected: FAIL — `commandFor` ignora o terceiro argumento.

- [ ] **Step 3: Implementar**

Em `scripts/lms-reviewer-fallback.mjs`, trocar a assinatura e os três ramos:

```js
/**
 * Comando do provider. `modo: 'fix'` troca o sandbox — e so ele.
 *
 * Pontuar e corrigir sao invocacoes separadas de proposito: um revisor que pontua e
 * corrige no mesmo turno tem incentivo a achar o que ele gosta de consertar.
 *
 * Escrita e de WORKSPACE, nunca total. O sandbox e o que garante a restricao; a
 * instrucao em prosa "nao mexa em outros arquivos" nunca garantiu nada.
 */
export function commandFor(provider, config, { modo = 'review' } = {}) {
  const model = config.models[provider];
  const common = { command: config.bins[provider], input: config.prompt };
  const corrigindo = modo === 'fix';
  if (provider === 'claude') {
    return {
      ...common,
      args: [
        '--model', model,
        '--effort', config.claudeEffort ?? 'high',
        '--print',
        '--output-format', 'json',
        '--no-session-persistence',
        '--permission-mode', corrigindo ? 'acceptEdits' : 'plan',
        // Bash fica de fora tambem no fix: editar arquivo nao precisa de shell, e
        // shell e como um fix estoura o escopo sem passar pela guarda.
        '--tools', corrigindo ? 'Read,Grep,Glob,Edit,Write' : 'Read,Grep,Glob',
      ],
    };
  }
  if (provider === 'grok') {
    return {
      ...common,
      args: [
        '--model', model,
        '--reasoning-effort', 'medium',
        '--single', config.prompt,
        '--output-format', 'json',
        '--permission-mode', corrigindo ? 'acceptEdits' : 'plan',
        '--tools', corrigindo ? 'Read,Grep,Glob,Edit,Write' : 'Read,Grep,Glob',
      ],
      input: null,
    };
  }
  if (provider === 'codex') {
    return {
      ...common,
      args: [
        'exec',
        '--model', model,
        '-c', `model_reasoning_effort="${config.effort === 'xhigh' ? 'high' : config.effort ?? 'high'}"`,
        '-s', corrigindo ? 'workspace-write' : 'read-only',
        '--json',
        config.prompt,
      ],
      input: null,
    };
  }
  throw new Error(`unknown LMS provider: ${provider}`);
}
```

(Se a Fase 2 Task 2 ainda não tiver ido, manter `'model_reasoning_effort="high"'` literal no codex e ajustar depois.)

- [ ] **Step 4: Passar o modo por `collectHeadless`**

`collectHeadless` hoje chama `commandFor(provider, { ...config, base, prompt })` sem modo (linha 564). Sem plumbing, o runner do fix não consegue pedir escrita. Acrescentar o parâmetro, com default que preserva o comportamento atual:

```js
export async function collectHeadless({
  root, provider, config, base, prompt, env,
  parse = normalizeProviderOutput,
  // `modo` sai daqui para commandFor. Default 'review': quem nao pede escrita
  // continua read-only, e nenhum caminho existente muda de permissao por acidente.
  modo = 'review',
}) {
  const command = commandFor(provider, { ...config, base, prompt }, { modo });
```

Teste:

```js
test('collectHeadless repassa o modo para commandFor', async () => {
  const { root, opcoes } = await fixture();
  let argsVistos = null;
  // runCommand e interno; o observavel aqui e o comando montado, entao o teste
  // exercita commandFor pela mesma porta que collectHeadless usa.
  argsVistos = commandFor('codex', { ...providerConfig({}), prompt: 'x' }, { modo: 'fix' }).args;
  assert.equal(argsVistos.includes('workspace-write'), true);
});
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test scripts/lms-reviewer-fallback.test.mjs`
Expected: PASS — os testes existentes continuam verdes porque `modo` tem default.

- [ ] **Step 6: Commit**

```bash
git add scripts/lms-reviewer-fallback.mjs scripts/lms-reviewer-fallback.test.mjs
git commit -m "feat(lms): commandFor ganha modo fix com sandbox de escrita de workspace"
```

---

### Task 4: O runner do fix

**Files:**
- Create: `scripts/lms-fix.mjs`
- Create: `scripts/lms-fix.test.mjs`
- Modify: `package.json` (script `lms:fix` e `test:lms`)

**Interfaces:**
- Consumes: `corrigivelPeloRevisor`, `arquivosDoAchado` (Task 1); `escopoViolado`, `arquivosAlterados`, `reverter` (Task 2); `providerConfig`, `collectHeadless` (Task 3).
- **Pré-requisito:** `verificarProva` (`scripts/lms-reviewer-fallback.mjs:829`) é privada hoje. Acrescentar `export` à declaração — o fix reusa a mesma allowlist `PROVAS_PERMITIDAS` do contraditório, e uma segunda lista de comandos permitidos seria um segundo caminho para shell arbitrário.
- Produces:
  - `export function fixPrompt(finding, arquivos)` → `string`
  - `export async function corrigirAchado({ root, finding, provider, config, env, collect })` → `{ id, outcome, motivo, arquivos }`
  - `export async function runFix({ root, env, collect })` → `{ aplicados, recusados, escalados }`
  - CLI: `node scripts/lms-fix.mjs`

`outcome` usa o vocabulário do `/code-review`, mais os dois desfechos que só existem aqui:

| `outcome` | Significado |
| --- | --- |
| `fixed` | o fix rodou, coube no escopo e (quando havia `proof`) a prova passou |
| `claimed` | o fix rodou e coube no escopo, mas não havia prova executável |
| `no_change_needed` | o provider concluiu que não havia o que corrigir |
| `rejected-scope` | estourou o escopo ou a denylist; revertido |
| `skipped` | roteado para o orquestrador pela Task 1 |

`claimed` separado de `fixed` de propósito: "corrigi" sem prova é alegação, e a rodada seguinte re-revisa aquele caminho com prioridade.

- [ ] **Step 1: Escrever o teste que falha**

`scripts/lms-fix.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { fixPrompt } from './lms-fix.mjs';

const achado = {
  id: 'a1', severity: 'P1', path: 'src/a.ts:42',
  title: 'falta filtro de tenant', why: 'a query nao escopa por tenant',
  fix: 'somar tenantId a clausula where da consulta',
  acceptance: ['a query cita tenantId'],
};

test('fixPrompt lista os arquivos permitidos e proibe sair deles', () => {
  const p = fixPrompt(achado, ['src/a.ts']);
  assert.match(p, /src\/a\.ts/);
  assert.match(p, /ONLY these files/);
  assert.match(p, /reverted/i);
});

test('fixPrompt proibe pontuar de novo', () => {
  const p = fixPrompt(achado, ['src/a.ts']);
  assert.match(p, /do not re-?review|do not score/i);
});

test('fixPrompt carrega os criterios de aceite quando existem', () => {
  assert.match(fixPrompt(achado, ['src/a.ts']), /a query cita tenantId/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test scripts/lms-fix.test.mjs`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar o prompt e o runner**

`scripts/lms-fix.mjs` — o prompt primeiro:

```js
#!/usr/bin/env node
/**
 * Fix mode do LMS: quem achou o defeito corrige.
 *
 * O invariante do LMS e "quem julga != quem produziu". Corrigir e produzir; pontuar
 * e julgar. O invariante so quebra se o revisor PONTUAR o delta que ele escreveu — e
 * isso ja e impossivel: scripts/lms-subject.mjs mete a arvore suja no hash, entao o
 * fix invalida o scorecard no instante em que toca o disco.
 *
 * O que resta bloquear e o "ja que estou aqui" (guarda de escopo) e a tentacao de
 * editar o proprio gate (denylist). As duas sao mecanicas.
 */
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { arquivosDoAchado, corrigivelPeloRevisor } from './lms-fix-routing.mjs';
import { arquivosAlterados, escopoViolado, reverter } from './lms-fix-escopo.mjs';
// `verificarProva` e privada em lms-reviewer-fallback.mjs hoje: acrescentar `export`
// a declaracao da linha 829. O fix reusa a MESMA allowlist do contraditorio de
// proposito — abrir uma segunda lista de comandos permitidos seria abrir um segundo
// caminho para shell arbitrario.
import {
  collectHeadless,
  providerConfig,
  verificarProva,
} from './lms-reviewer-fallback.mjs';

const execFile = promisify(execFileCallback);

export function fixPrompt(finding, arquivos) {
  return [
    'You reviewed this branch and reported the finding below. Now fix it.',
    '',
    '--- FINDING ---',
    `severity: ${finding.severity}`,
    `path: ${Array.isArray(finding.path) ? finding.path.join(', ') : finding.path}`,
    `title: ${finding.title}`,
    `why: ${finding.why}`,
    `suggested fix: ${finding.fix}`,
    ...(Array.isArray(finding.acceptance) && finding.acceptance.length
      ? ['acceptance criteria:', ...finding.acceptance.map((c) => `  - ${c}`)]
      : []),
    '--- END FINDING ---',
    '',
    `You may edit ONLY these files: ${arquivos.join(', ')}`,
    'Any change outside them makes the whole fix be reverted, so do not "while I am',
    'here" anything. No new files, no deletions, no refactors beyond the finding.',
    '',
    'Do NOT re-review the diff, do not score, do not write a scorecard, do not commit,',
    'do not push. Fix the defect and stop.',
    '',
    'When done, print EXACTLY ONE JSON object, no prose, no markdown fences:',
    '{',
    '  "outcome": "fixed",',
    '  "what": "one sentence on what you changed",',
    '  "proof": { "command": "pnpm --filter @karibu/api test", "expect": "pass" }',
    '}',
    '"outcome" is "fixed" or "no_change_needed" (use the second only if you conclude',
    'the finding was wrong — say why in "what"). "proof" is optional but strongly',
    'preferred: without it the fix is recorded as "claimed", not "fixed", and the next',
    'review round re-checks that path first.',
  ].join('\n');
}
```

Depois, o orquestrador de uma correção e o runner:

```js
/** Ponto de comparacao antes do fix, sem encostar na pilha de stash. */
async function marcoDaArvore(root) {
  // `git stash create` so MONTA o objeto — nao empilha. `git stash push` mexeria
  // numa pilha compartilhada com as outras worktrees e com o Master.
  const { stdout } = await execFile('git', ['stash', 'create'], { cwd: root });
  return stdout.trim() || 'HEAD';
}

async function registrar(root, linha) {
  await mkdir(join(root, '.lms'), { recursive: true });
  await appendFile(join(root, '.lms/fixes.jsonl'), `${JSON.stringify(linha)}\n`, 'utf8');
}

export async function corrigirAchado({ root, finding, provider, config, env, collect }) {
  const arquivos = arquivosDoAchado(finding);
  const rota = corrigivelPeloRevisor(finding);
  if (!rota.ok) {
    const linha = { at: new Date().toISOString(), id: finding.id, provider,
      outcome: 'skipped', arquivos, motivo: rota.motivo };
    await registrar(root, linha);
    return linha;
  }

  const desde = await marcoDaArvore(root);
  const saida = await collect({
    root, provider, config, base: config.base, env, modo: 'fix',
    prompt: fixPrompt(finding, arquivos),
  }).catch(() => ({ kind: 'error' }));

  const alterados = await arquivosAlterados(root, desde);
  const violacao = escopoViolado(alterados, arquivos);

  // Ordem importa: a guarda de escopo roda ANTES de olhar o que o provider disse.
  // Um provider que estourou o escopo e anunciou "fixed" nao pode ser acreditado
  // sobre o proprio limite.
  if (violacao) {
    await reverter(root, alterados);
    const linha = { at: new Date().toISOString(), id: finding.id, provider,
      outcome: 'rejected-scope', arquivos: alterados, motivo: violacao };
    await registrar(root, linha);
    return linha;
  }

  const relato = saida.kind === 'ok' ? saida.candidate : null;
  if (relato?.outcome === 'no_change_needed') {
    const linha = { at: new Date().toISOString(), id: finding.id, provider,
      outcome: 'no_change_needed', arquivos: [], motivo: relato.what ?? '' };
    await registrar(root, linha);
    return linha;
  }

  let outcome = 'claimed';
  let motivo = relato?.what ?? 'sem relato do provider';
  if (relato?.proof) {
    const prova = await verificarProva(root, relato.proof, env);
    if (prova === 'confirmada') {
      outcome = 'fixed';
    } else {
      // Prova que nao confirma derruba o fix inteiro: "corrigi" com prova que falha
      // e pior que "corrigi" sem prova — e uma alegacao ja contestada.
      await reverter(root, alterados);
      outcome = 'rejected-scope';
      motivo = `prova do fix nao confirmou (${prova})`;
    }
  }
  const linha = { at: new Date().toISOString(), id: finding.id, provider, outcome,
    arquivos: outcome === 'rejected-scope' ? [] : alterados, motivo };
  await registrar(root, linha);
  return linha;
}

export async function runFix({ root = process.cwd(), env = process.env, collect = collectHeadless } = {}) {
  const modo = env.LMS_FIX_MODE ?? 'off';
  if (modo === 'off') {
    console.error('lms-fix: fix mode desligado (LMS_FIX_MODE=off)');
    return { aplicados: [], recusados: [], escalados: [] };
  }
  const scorecard = JSON.parse(await readFile(join(root, '.lms/last.json'), 'utf8'));
  // Achado rebaixado a PLAUSIBLE por um verificador nao vale um fix: ele nao bloqueia
  // e pode nem ser defeito.
  const alvos = (scorecard.findings ?? []).filter((f) => (f.verdict ?? 'CONFIRMED') === 'CONFIRMED');

  if (modo === 'orchestrator') {
    for (const finding of alvos) {
      const rota = corrigivelPeloRevisor(finding);
      console.log(`${rota.ok ? 'REVISOR   ' : 'ORQUESTRA '} ${finding.severity} ${finding.path} — ${finding.title} (${rota.motivo})`);
    }
    return { aplicados: [], recusados: [], escalados: alvos };
  }

  const config = { ...providerConfig(env), base: scorecard.base };
  const linhas = [];
  // Em serie de proposito: dois fixes simultaneos na mesma arvore fazem a guarda de
  // escopo de um enxergar o diff do outro e reverter trabalho alheio.
  for (const finding of alvos) {
    linhas.push(await corrigirAchado({
      root, finding, provider: scorecard.reviewer, config, env, collect,
    }));
  }
  const resultado = {
    aplicados: linhas.filter((l) => l.outcome === 'fixed' || l.outcome === 'claimed'),
    recusados: linhas.filter((l) => l.outcome === 'rejected-scope'),
    escalados: linhas.filter((l) => l.outcome === 'skipped'),
  };
  console.error(
    `lms-fix: ${resultado.aplicados.length} aplicado(s), `
    + `${resultado.recusados.length} revertido(s), ${resultado.escalados.length} escalado(s). `
    + 'O scorecard foi invalidado pelo subject — rode a cadeia de novo.',
  );
  return resultado;
}

if (import.meta.url === `file://${process.argv[1]}`) await runFix();
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test scripts/lms-fix.test.mjs`
Expected: PASS

- [ ] **Step 5: Testar a guarda de escopo com `git` de verdade**

O valor deste teste está em exercitar o `git`, não em simulá-lo: a reversão é o comportamento que precisa funcionar quando importa. Acrescentar a `scripts/lms-fix.test.mjs`:

```js
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { corrigirAchado } from './lms-fix.mjs';

const execFile = promisify(execFileCallback);

async function repoGit() {
  const root = await mkdtemp(join(tmpdir(), 'lms-fix-'));
  await execFile('git', ['init', '-q'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'lms@test'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'lms'], { cwd: root });
  await writeFile(join(root, 'a.ts'), 'const original = 1;\n');
  await writeFile(join(root, 'b.ts'), 'const vizinho = 2;\n');
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-qm', 'inicial'], { cwd: root });
  return root;
}

const alvo = {
  id: 'a1', severity: 'P1', path: 'a.ts:1', title: 'defeito localizado',
  why: 'a linha esta errada', fix: 'trocar o valor da constante para 2',
};

test('fix dentro do escopo e aceito como claimed sem prova', async () => {
  const root = await repoGit();
  const collect = async () => {
    await writeFile(join(root, 'a.ts'), 'const original = 2;\n');
    return { kind: 'ok', candidate: { outcome: 'fixed', what: 'troquei o valor' } };
  };
  const r = await corrigirAchado({ root, finding: alvo, provider: 'grok', config: {}, env: {}, collect });
  assert.equal(r.outcome, 'claimed');
  assert.match(await readFile(join(root, 'a.ts'), 'utf8'), /original = 2/);
});

test('fix que toca arquivo vizinho e revertido INTEIRO', async () => {
  const root = await repoGit();
  const collect = async () => {
    await writeFile(join(root, 'a.ts'), 'const original = 2;\n');
    await writeFile(join(root, 'b.ts'), 'const vizinho = 99;\n');
    return { kind: 'ok', candidate: { outcome: 'fixed', what: 'aproveitei e arrumei o vizinho' } };
  };
  const r = await corrigirAchado({ root, finding: alvo, provider: 'grok', config: {}, env: {}, collect });
  assert.equal(r.outcome, 'rejected-scope');
  assert.match(r.motivo, /b\.ts/);
  // A parte "boa" tambem volta: aceitar metade seria deixar o agente negociar o limite.
  assert.match(await readFile(join(root, 'a.ts'), 'utf8'), /original = 1/);
  assert.match(await readFile(join(root, 'b.ts'), 'utf8'), /vizinho = 2/);
});

test('fix que nao mudou nada e recusado, nao celebrado', async () => {
  const root = await repoGit();
  const collect = async () => ({ kind: 'ok', candidate: { outcome: 'fixed', what: 'nada' } });
  const r = await corrigirAchado({ root, finding: alvo, provider: 'grok', config: {}, env: {}, collect });
  assert.equal(r.outcome, 'rejected-scope');
  assert.match(r.motivo, /nenhum arquivo/i);
});

test('achado em caminho de risco nem chega a invocar o provider', async () => {
  const root = await repoGit();
  let chamou = false;
  const collect = async () => { chamou = true; return { kind: 'ok', candidate: {} }; };
  const r = await corrigirAchado({
    root, provider: 'grok', config: {}, env: {}, collect,
    finding: { ...alvo, path: 'services/fiscal/backend/app/auth.py:80' },
  });
  assert.equal(chamou, false);
  assert.equal(r.outcome, 'skipped');
});
```

Run: `node --test scripts/lms-fix.test.mjs`
Expected: PASS

- [ ] **Step 6: Expor o script**

Em `package.json`, acrescentar `"lms:fix": "node scripts/lms-fix.mjs"` e `scripts/lms-fix.test.mjs` ao `test:lms`.

Run: `pnpm test:lms`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add scripts/lms-fix.mjs scripts/lms-fix.test.mjs package.json
git commit -m "feat(lms): runner do fix mode, com guarda de escopo e prova opcional"
```

---

### Task 5: Exclusão de autor por arquivo

Hoje `authorProvider` exclui o **provider inteiro** da cadeia. Com fix de revisor, isso queima um revisor a cada correção — em três correções não sobra ninguém e o scorecard cai para `self`. A exclusão precisa ser do delta que ele escreveu, não da rodada.

**Files:**
- Modify: `scripts/lms-reviewer-fallback.mjs` (`runFallback`)
- Create: `scripts/lms-fix-autoria.mjs`
- Create: `scripts/lms-fix-autoria.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `.lms/fixes.jsonl` (escrito pela Task 4).
- Produces:
  - `export async function autoresPorArquivo(root)` → `Map<string, Set<string>>`
  - `export function providerPodeRevisar(provider, changedPaths, autores)` → `boolean`

Regra: um provider não revisa a rodada se ele escreveu **algum** dos arquivos alterados. Mais fino que isso (revisar parte do diff) exigiria fatiar o scorecard, o que quebra o agregado — fica fora de escopo.

- [ ] **Step 1: Escrever o teste que falha**

`scripts/lms-fix-autoria.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { autoresPorArquivo, providerPodeRevisar } from './lms-fix-autoria.mjs';

async function repoCom(linhas) {
  const root = await mkdtemp(join(tmpdir(), 'lms-autoria-'));
  await mkdir(join(root, '.lms'), { recursive: true });
  await writeFile(join(root, '.lms/fixes.jsonl'), linhas.map((l) => JSON.stringify(l)).join('\n'));
  return root;
}

test('sem arquivo de fixes, ninguem e autor', async () => {
  const m = await autoresPorArquivo(await mkdtemp(join(tmpdir(), 'lms-vazio-')));
  assert.equal(m.size, 0);
});

test('mapeia arquivo para quem o corrigiu', async () => {
  const root = await repoCom([
    { id: 'a1', provider: 'grok', outcome: 'fixed', arquivos: ['src/a.ts'] },
  ]);
  const m = await autoresPorArquivo(root);
  assert.deepEqual([...m.get('src/a.ts')], ['grok']);
});

test('fix revertido nao gera autoria', async () => {
  const root = await repoCom([
    { id: 'a1', provider: 'grok', outcome: 'rejected-scope', arquivos: ['src/a.ts'] },
  ]);
  assert.equal((await autoresPorArquivo(root)).size, 0);
});

test('provider que escreveu um dos arquivos nao revisa', () => {
  const autores = new Map([['src/a.ts', new Set(['grok'])]]);
  assert.equal(providerPodeRevisar('grok', ['src/a.ts', 'src/b.ts'], autores), false);
  assert.equal(providerPodeRevisar('claude', ['src/a.ts', 'src/b.ts'], autores), true);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test scripts/lms-fix-autoria.test.mjs`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

`scripts/lms-fix-autoria.mjs`:

```js
/**
 * Quem escreveu o que, para tirar do julgamento so quem produziu.
 *
 * `authorProvider` exclui o provider INTEIRO da cadeia. Com fix por revisor isso
 * queima um revisor a cada correcao: em tres correcoes nao sobra ninguem e o
 * scorecard cai para `self`, a categoria fraca. A exclusao passa a olhar o delta.
 *
 * Fix revertido (`rejected-scope`) nao conta: nada dele sobrou no disco.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PERSISTIU = new Set(['fixed', 'claimed']);

export async function autoresPorArquivo(root) {
  const mapa = new Map();
  let texto;
  try {
    texto = await readFile(join(root, '.lms/fixes.jsonl'), 'utf8');
  } catch {
    return mapa;
  }
  for (const linha of texto.split('\n')) {
    if (!linha.trim()) continue;
    let registro;
    try {
      registro = JSON.parse(linha);
    } catch {
      continue;
    }
    if (!PERSISTIU.has(registro.outcome)) continue;
    for (const arquivo of registro.arquivos ?? []) {
      if (!mapa.has(arquivo)) mapa.set(arquivo, new Set());
      mapa.get(arquivo).add(registro.provider);
    }
  }
  return mapa;
}

export function providerPodeRevisar(provider, changedPaths, autores) {
  return !changedPaths.some((path) => autores.get(path)?.has(provider));
}
```

Em `scripts/lms-reviewer-fallback.mjs`, dentro de `runFallback`, depois de calcular `autor`:

```js
  // Autor da sessao fora da cadeia (como sempre) E quem corrigiu arquivo deste diff.
  const autores = await autoresPorArquivo(root);
  const independentes = config.order.filter(
    (provider) => provider !== autor && providerPodeRevisar(provider, [...changedPaths], autores),
  );
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test scripts/lms-fix-autoria.test.mjs scripts/lms-reviewer-fallback.test.mjs`
Expected: PASS

- [ ] **Step 5: Registrar na suíte e commitar**

Acrescentar `scripts/lms-fix-autoria.test.mjs` ao `test:lms`.

Run: `pnpm test:lms`
Expected: PASS

```bash
git add scripts/lms-fix-autoria.mjs scripts/lms-fix-autoria.test.mjs \
  scripts/lms-reviewer-fallback.mjs package.json
git commit -m "feat(lms): quem corrigiu um arquivo sai da revisao daquele diff"
```

---

### Task 6: Documentar o fix mode no SKILL.md

**Files:**
- Modify: `.agents/skills/local-merge-score/SKILL.md`

- [ ] **Step 1: Escrever a seção**

Acrescentar depois da seção "Headless reviewer fallback":

```markdown
## Fix mode (`pnpm lms:fix`)

Quem achou o defeito tem o contexto do tamanho do defeito. O orquestrador tem a
sessão inteira e precisa re-derivar tudo a partir de um resumo em prosa. Para
correção localizada, o revisor é o agente mais bem posicionado do sistema.

**O invariante continua de pé, e não por promessa.** Corrigir é produzir; pontuar é
julgar. `scripts/lms-subject.mjs` mete a árvore suja no hash do `subject`, então o
fix invalida o scorecard no instante em que toca o disco — aprovar o próprio conserto
é estruturalmente impossível, não desaconselhado.

| Env | Efeito |
| --- | --- |
| `LMS_FIX_MODE=off` | **default.** Nenhum fix automático. |
| `LMS_FIX_MODE=reviewer` | O provider que achou corrige, numa segunda invocação com sandbox de escrita. |
| `LMS_FIX_MODE=orchestrator` | Só lista os achados corrigíveis e sai; o Master decide. |

**Duas invocações, nunca uma.** Pontuar é read-only (`codex exec -s read-only`,
claude sem `Edit`). Corrigir é outra chamada, com `workspace-write` — nunca acesso
total, nunca `Bash` no fix. Um revisor que pontua e corrige no mesmo turno tem
incentivo a achar o que ele gosta de consertar.

**Roteamento pela forma do achado** (`scripts/lms-fix-routing.mjs`): se `fix` é um
diff, o revisor corrige; se pede decisão, escala. Caminho de risco
(auth/tenant/fiscal/migration/signer/webhook) vai sempre para o orquestrador.

**O fix nunca escreve no gate.** `.lms/`, `.claude/hooks/`, `scripts/lms-*`,
`scripts/db-exposure-gate*`, `.agents/skills/local-merge-score/`, `.git/`, `.husky/`
são proibidos, conferidos antes e depois. Um agente com mandato de corrigir e
incentivo de passar no gate, com escrita no gate, edita o gate.

**Estourou o escopo, reverte inteiro** (`scripts/lms-fix-escopo.mjs`). Aceitar a
parte boa de um fix que passou dos arquivos do achado seria deixar o agente negociar
o próprio limite. A reversão é `git checkout --` por arquivo e `git clean -f` nos
novos — nunca `reset --hard`, que apagaria trabalho do Master na mesma árvore. O
ponto de comparação sai de `git stash create`, que não encosta na pilha de stash
compartilhada entre worktrees.

**`fixed` ≠ `claimed`.** Fix com `proof` executável (mesma allowlist do
contraditório) que passa vira `fixed`; sem prova vira `claimed`, e a rodada seguinte
re-revisa aquele caminho primeiro. Tudo em `.lms/fixes.jsonl`.

**Quem corrigiu sai da revisão daquele diff** (`scripts/lms-fix-autoria.mjs`), por
arquivo — não o provider inteiro, que em três correções esvaziaria a cadeia.
```

- [ ] **Step 2: Rodar o gate de documentação**

Run: `pnpm dox-check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add .agents/skills/local-merge-score/SKILL.md
git commit -m "docs(lms): documenta o fix mode, o roteamento e as duas guardas"
```

---

## Fim da Fase 3

Com as três fases, o LMS passa a saber **o quanto** foi varrido, **o que está certo**, **quais achados sobreviveram a um verificador**, e **quem corrigiu o quê** — e a correção acontece onde o contexto já está, sem que ninguém consiga assinar o próprio conserto.
