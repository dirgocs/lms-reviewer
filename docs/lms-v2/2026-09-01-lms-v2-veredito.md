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

# LMS v2 — Fase 2: qualidade do veredito — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o LMS gastar revisão onde há risco, lembrar dos falsos-positivos que já derrubou, e submeter cada achado — não só o score — a um verificador independente.

**Architecture:** Dois módulos novos e pequenos (`lms-triage.mjs`, `lms-effort.mjs`) consultados por `lms-reviewer-trigger.sh` e `providerConfig`. O corpus de precedentes é um arquivo de texto injetado no prompt. A verificação por achado é um estágio novo dentro de `runFallback`, ao lado do contraditório que já existe — reusando a allowlist `PROVAS_PERMITIDAS` e a escolha de refutador (`escolherRefutador`).

**Tech Stack:** Node 22 ESM, `node --test`. Sem dependências novas. `graphify` é opcional — ausente, o effort cai no default.

**Spec:** `docs/superpowers/specs/2026-09-01-lms-v2.md`

## Global Constraints

- **Depende da Fase 1** (`docs/superpowers/plans/2026-09-01-lms-v2-contrato.md`): usa `findingId`, `findingsShapeError` e o campo `findings[].id`.
- PNPM only (ADR-009). Gates rodam da raiz do monorepo.
- Zero dependências novas.
- Nenhum estágio novo pode **falhar aberto**. Verificador que não roda, dá timeout ou devolve lixo = ausência de segunda opinião = o achado permanece bloqueando. Mesmo princípio já aplicado ao contraditório e ao fallow.
- Nenhum estágio novo pode **remover** um achado. O teto é rebaixar para `PLAUSIBLE`.
- Comando executado por verificador só sai de `PROVAS_PERMITIDAS`. O comando vem da saída de um modelo.
- Comentários em pt-BR, como o resto de `scripts/lms-*`.

---

### Task 1: Triagem determinística antes de acordar a cadeia

A cadeia de três providers roda em todo push, inclusive num diff só de `.md`. A cota semanal Claude é compartilhada entre lanes e orquestrador. O `/code-review ultra` gasta um Haiku para perguntar "isto merece review?"; aqui uma checagem de caminho é mais barata e mais previsível que um modelo.

**Files:**
- Create: `scripts/lms-triage.mjs`
- Create: `scripts/lms-triage.test.mjs`
- Modify: `scripts/lms-reviewer-trigger.sh`
- Modify: `package.json` (script `test:lms`)

**Interfaces:**
- Consumes: `changedOpenablePaths(root, base)` de `./lms-inspection.mjs`.
- Produces:
  - `export function precisaRevisao(paths)` → `{ revisar: boolean, motivo: string }`
  - CLI: `node scripts/lms-triage.mjs --base <ref>` → exit `0` = precisa revisão, exit `10` = dispensada (com motivo no stderr).

Exit `10` e não `1`: `1` já significa "algo deu errado" no trigger, e confundir os dois faria dispensa virar falha.

- [ ] **Step 1: Escrever o teste que falha**

`scripts/lms-triage.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { precisaRevisao } from './lms-triage.mjs';

test('dispensa diff so de markdown', () => {
  const r = precisaRevisao(['docs/README.md', 'CHANGELOG.md']);
  assert.equal(r.revisar, false);
  assert.match(r.motivo, /documenta/i);
});

test('exige revisao quando ha codigo junto da documentacao', () => {
  assert.equal(precisaRevisao(['docs/README.md', 'services/api/src/routes/rooms.ts']).revisar, true);
});

test('exige revisao para migration, mesmo sozinha', () => {
  assert.equal(precisaRevisao(['services/api/migrations/20260901_x.sql']).revisar, true);
});

test('exige revisao para workflow de CI e para hook', () => {
  assert.equal(precisaRevisao(['.github/workflows/ci.yml']).revisar, true);
  assert.equal(precisaRevisao(['.claude/hooks/local-merge-score-gate.sh']).revisar, true);
});

test('exige revisao quando nao ha informacao de diff', () => {
  assert.equal(precisaRevisao([]).revisar, true);
});

test('exige revisao para o proprio LMS', () => {
  assert.equal(precisaRevisao(['scripts/lms-scorecard.mjs']).revisar, true);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test scripts/lms-triage.test.mjs`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

`scripts/lms-triage.mjs`:

```js
#!/usr/bin/env node
/**
 * Vale a pena acordar tres revisores por este diff?
 *
 * Deterministico de proposito. Um modelo de triagem seria mais esperto e menos
 * previsivel — e a pergunta aqui e barata: o diff toca caminho de execucao?
 *
 * Falha FECHADA: sem informacao de diff, ou na duvida, revisa. Uma revisao a mais
 * custa tokens; uma a menos custa o gate.
 */
import { changedOpenablePaths } from './lms-inspection.mjs';

// Extensoes sem caminho de execucao. `.sql` NAO entra: migration muda o banco.
const INERTES = /\.(md|mdx|txt|rst|adoc|svg|png|jpe?g|gif|webp|ico|woff2?|ttf)$/i;

// Caminhos que exigem revisao mesmo parecendo inertes: mexer no proprio gate,
// no CI ou nas regras que o revisor le e exatamente o que ninguem deve fazer
// sem segunda opiniao.
const SEMPRE_REVISAR = [
  /^\.github\/workflows\//,
  /^\.claude\/hooks\//,
  /^scripts\/(lms-|db-exposure-gate|local-merge-score)/,
  /^\.agents\/skills\/local-merge-score\//,
  /^\.greptile\//,
  /(^|\/)migrations\//,
  /(^|\/)(AGENTS|CLAUDE)\.md$/,
];

export function precisaRevisao(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { revisar: true, motivo: 'sem informacao de diff' };
  }
  const obrigatorio = paths.find((p) => SEMPRE_REVISAR.some((re) => re.test(p)));
  if (obrigatorio) return { revisar: true, motivo: `toca superficie sensivel: ${obrigatorio}` };

  const comExecucao = paths.filter((p) => !INERTES.test(p));
  if (comExecucao.length === 0) {
    return { revisar: false, motivo: 'diff apenas de documentacao e assets, sem caminho de execucao' };
  }
  return { revisar: true, motivo: `${comExecucao.length} arquivo(s) com caminho de execucao` };
}

async function main() {
  const i = process.argv.indexOf('--base');
  const base = i >= 0 ? process.argv[i + 1] : 'origin/master';
  const paths = [...await changedOpenablePaths(process.cwd(), base)];
  const { revisar, motivo } = precisaRevisao(paths);
  console.error(`lms-triage: ${revisar ? 'revisar' : 'dispensada'} — ${motivo}`);
  process.exitCode = revisar ? 0 : 10;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test scripts/lms-triage.test.mjs`
Expected: PASS

- [ ] **Step 5: Ligar no trigger**

Em `scripts/lms-reviewer-trigger.sh`, depois do bloco de `LMS_SKIP` (linha 47-49) e antes de resolver o runner, acrescentar:

```bash
# Triagem antes da cadeia: diff sem caminho de execucao nao merece tres revisores.
# Exit 10 e "dispensada" (nao e erro); qualquer outro codigo diferente de 0 e falha
# da triagem, e falha de ferramenta NAO dispensa revisao.
if [ "${LMS_TRIAGE:-1}" = "1" ]; then
  set +e
  node "$ROOT/scripts/lms-triage.mjs" --base "$BASE"
  TRIAGE_RC=$?
  set -e
  if [ "$TRIAGE_RC" = "10" ]; then
    echo "lms-trigger: revisao dispensada pela triagem" >&2
    exit 0
  fi
fi
```

Conferir que `BASE` já está resolvido nesse ponto do script (a função `resolve_base` está definida na linha 51); se a atribuição de `BASE` vier depois, mover este bloco para logo após ela.

- [ ] **Step 6: Verificar o comportamento na árvore atual**

Run: `node scripts/lms-triage.mjs --base origin/master; echo "exit=$?"`
Expected: `exit=0` com motivo citando arquivos com caminho de execução (a branch tem `.py` alterados).

- [ ] **Step 7: Registrar na suíte e commitar**

Acrescentar `scripts/lms-triage.test.mjs` ao `test:lms` do `package.json`.

Run: `pnpm test:lms`
Expected: PASS

```bash
git add scripts/lms-triage.mjs scripts/lms-triage.test.mjs scripts/lms-reviewer-trigger.sh package.json
git commit -m "feat(lms): triagem deterministica dispensa a cadeia em diff sem execucao"
```

---

### Task 2: Effort do revisor derivado do raio de impacto

O `orient.mjs` já calcula `riskHints` a partir dos caminhos, e o SKILL.md já usa esse sinal para **limitar o score**. O mesmo sinal deve **aprofundar a revisão** — hoje ele é jogado fora pela metade.

**Files:**
- Create: `scripts/lms-effort.mjs`
- Create: `scripts/lms-effort.test.mjs`
- Modify: `scripts/lms-reviewer-fallback.mjs` (`providerConfig`, `commandFor`, `runFallback`)
- Modify: `package.json` (script `test:lms`)

**Interfaces:**
- Consumes: lista de caminhos alterados.
- Produces:
  - `export const CAMINHOS_DE_RISCO` → `RegExp`
  - `export function effortPara(paths, env)` → `'medium' | 'high' | 'xhigh'`
- `providerConfig(env, { paths })` ganha um segundo parâmetro opcional; sem ele, o comportamento é o de hoje.

- [ ] **Step 1: Escrever o teste que falha**

`scripts/lms-effort.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { effortPara } from './lms-effort.mjs';

test('diff comum revisa em high', () => {
  assert.equal(effortPara(['apps/erp-web/src/components/ui/button.tsx'], {}), 'high');
});

test('caminho de auth/tenant/fiscal sobe para xhigh', () => {
  assert.equal(effortPara(['services/fiscal/backend/app/auth.py'], {}), 'xhigh');
  assert.equal(effortPara(['services/api/src/pos/actor.ts'], {}), 'xhigh');
  assert.equal(effortPara(['services/api/migrations/20260901_rls.sql'], {}), 'xhigh');
});

test('LMS_EFFORT sobrescreve', () => {
  assert.equal(effortPara(['services/fiscal/backend/app/auth.py'], { LMS_EFFORT: 'medium' }), 'medium');
});

test('LMS_EFFORT invalido e ignorado', () => {
  assert.equal(effortPara(['a.ts'], { LMS_EFFORT: 'turbo' }), 'high');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test scripts/lms-effort.test.mjs`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

`scripts/lms-effort.mjs`:

```js
/**
 * Profundidade da revisao a partir do raio do diff.
 *
 * O sinal ja existia e era usado pela metade: o orient calcula `riskHints` e a
 * rubrica so o usa para LIMITAR o score. Se o diff toca auth/tenant/fiscal a ponto
 * de o score nao poder passar de 3, ele tambem merece uma revisao mais funda — nao
 * a mesma revisao com o teto mais baixo.
 */
const NIVEIS = new Set(['medium', 'high', 'xhigh']);

// Mesma familia do riskRe de local-merge-score-orient.mjs, mantida aqui porque o
// runner nao importa o orient (que e um script de terminal, com process.chdir).
export const CAMINHOS_DE_RISCO =
  /(fiscal|auth|rls|tenant|payment|acquirer|tenantId|tenant_id|middleware\/auth|prisma|migrations\/|certs?\/|signer|webhook)/i;

export function effortPara(paths, env = process.env) {
  const forcado = String(env.LMS_EFFORT ?? '').trim();
  if (NIVEIS.has(forcado)) return forcado;
  const risco = (paths ?? []).some((p) => CAMINHOS_DE_RISCO.test(p));
  return risco ? 'xhigh' : 'high';
}
```

Em `scripts/lms-reviewer-fallback.mjs`:

```js
import { effortPara } from './lms-effort.mjs';
```

Trocar a assinatura de `providerConfig`:

```js
export function providerConfig(env = process.env, { paths = [] } = {}) {
  const effort = effortPara(paths, env);
  return {
    order: envList(env, 'LMS_REVIEWER_ORDER', 'claude,grok,codex'),
    // O effort do refutador continua vindo de LMS_CLAUDE_EFFORT (Fable em medium,
    // decisao do Master 2026-08-19): so o REVISOR sobe com o raio.
    claudeEffort: env.LMS_CLAUDE_EFFORT ?? effort,
    effort,
    models: providerModels(env),
    bins: providerBins(env),
    timeoutMs: timeoutMs(env),
  };
}
```

Em `commandFor`, no ramo do `codex`, trocar o literal:

```js
        '-c', `model_reasoning_effort="${config.effort === 'xhigh' ? 'high' : config.effort ?? 'high'}"`,
```

(O codex não expõe `xhigh`; `high` é o teto dele. O ganho de `xhigh` vem do claude.)

O ramo do `grok` fica **inalterado**: `medium` supera `high` no grok-4.6 para review (medição do Master, 2026-08-15), e subir o effort dele pioraria a revisão.

Em `runFallback`, passar os caminhos:

```js
  const { text: changed, paths: changedPaths } = await diffContext(root, resolvedBase);
  const config = providerConfig(env, { paths: [...changedPaths] });
```

(mover a linha de `config` para depois de `diffContext`).

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test scripts/lms-effort.test.mjs scripts/lms-reviewer-fallback.test.mjs`
Expected: PASS — os testes existentes do `providerConfig` continuam verdes porque o segundo parâmetro é opcional.

- [ ] **Step 5: Documentar no SKILL.md**

Na tabela de env de `.agents/skills/local-merge-score/SKILL.md`, acrescentar:

```markdown
| `LMS_EFFORT` | `medium` \| `high` \| `xhigh`. Sem ela, o effort do revisor Claude sai do raio do diff: `xhigh` quando toca auth/tenant/fiscal/migrations/signer/webhook, `high` no resto. O grok continua em `medium` (mede melhor), e o codex tem `high` como teto. |
```

- [ ] **Step 6: Registrar na suíte e commitar**

Acrescentar `scripts/lms-effort.test.mjs` ao `test:lms`.

Run: `pnpm test:lms`
Expected: PASS

```bash
git add scripts/lms-effort.mjs scripts/lms-effort.test.mjs scripts/lms-reviewer-fallback.mjs \
  .agents/skills/local-merge-score/SKILL.md package.json
git commit -m "feat(lms): raio do diff define a profundidade da revisao, nao so o teto do score"
```

---

### Task 3: Corpus de precedentes que cresce sozinho

A mesma classe de falso-positivo é re-litigada a cada rodada. O `/code-review ultra` carrega uma lista fixa de exclusões; aqui a lista **cresce**: toda vez que uma refutação derruba um achado, a classe entra no corpus.

**Files:**
- Create: `.agents/skills/local-merge-score/references/precedentes.md`
- Create: `scripts/lms-precedentes.mjs`
- Create: `scripts/lms-precedentes.test.mjs`
- Modify: `scripts/lms-reviewer-fallback.mjs` (`reviewPrompt`, `applyRefutation`)
- Modify: `package.json`

**Interfaces:**
- Consumes: o veredito de refutação já produzido por `applyRefutation`.
- Produces:
  - `export async function lerPrecedentes(root)` → `string[]` (linhas `- ...`, no máximo 40)
  - `export async function registrarPrecedente(root, { classe, motivo, origem })` → `void`
- `reviewPrompt(base, reviewer, changed, outputPath, precedentes = [])` ganha um quinto parâmetro.

Teto de 40 linhas: o corpus entra no prompt de todo revisor, e um corpus que cresce sem limite vira custo fixo crescente por revisão. Ao estourar, a linha mais antiga sai.

- [ ] **Step 1: Escrever o teste que falha**

`scripts/lms-precedentes.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lerPrecedentes, registrarPrecedente, TETO_PRECEDENTES } from './lms-precedentes.mjs';

async function repoTemporario() {
  const root = await mkdtemp(join(tmpdir(), 'lms-prec-'));
  await mkdir(join(root, '.agents/skills/local-merge-score/references'), { recursive: true });
  return root;
}

test('le zero precedentes quando o arquivo nao existe', async () => {
  assert.deepEqual(await lerPrecedentes(await repoTemporario()), []);
});

test('registra e le de volta', async () => {
  const root = await repoTemporario();
  await registrarPrecedente(root, {
    classe: 'DoS por payload grande',
    motivo: 'fora de escopo do gate: resource exhaustion nao bloqueia publicacao',
    origem: 'grok 2026-09-01',
  });
  const linhas = await lerPrecedentes(root);
  assert.equal(linhas.length, 1);
  assert.match(linhas[0], /DoS por payload grande/);
  assert.match(linhas[0], /grok 2026-09-01/);
});

test('nao duplica a mesma classe', async () => {
  const root = await repoTemporario();
  const p = { classe: 'mesma classe', motivo: 'motivo suficientemente longo aqui', origem: 'x' };
  await registrarPrecedente(root, p);
  await registrarPrecedente(root, p);
  assert.equal((await lerPrecedentes(root)).length, 1);
});

test('respeita o teto descartando o mais antigo', async () => {
  const root = await repoTemporario();
  for (let i = 0; i < TETO_PRECEDENTES + 5; i += 1) {
    await registrarPrecedente(root, { classe: `classe ${i}`, motivo: 'motivo longo o suficiente', origem: 'x' });
  }
  const linhas = await lerPrecedentes(root);
  assert.equal(linhas.length, TETO_PRECEDENTES);
  assert.equal(linhas.some((l) => l.includes('classe 0')), false);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test scripts/lms-precedentes.test.mjs`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar o módulo**

`scripts/lms-precedentes.mjs`:

```js
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

const RELATIVO = '.agents/skills/local-merge-score/references/precedentes.md';
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
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test scripts/lms-precedentes.test.mjs`
Expected: PASS

- [ ] **Step 5: Semear o corpus com o que já se sabe**

Criar `.agents/skills/local-merge-score/references/precedentes.md` com o cabeçalho e as classes que a auditoria de 2026-08-31 e o histórico do LMS já estabeleceram:

```markdown
- **DoS / exaustão de recurso** — fora de escopo do gate de publicação; não bloqueia. _(politica 2026-09-01)_
- **Falta de rate limiting** — mesma família de DoS; não bloqueia. _(politica 2026-09-01)_
- **Variável de ambiente ou flag de CLI como vetor** — env é valor confiável neste ambiente; ataque que depende de controlá-la é inválido. _(politica 2026-09-01)_
- **XSS em componente React/Angular sem dangerouslySetInnerHTML** — o framework escapa; só vale com sink explícito. _(politica 2026-09-01)_
- **Injeção em regex / ReDoS** — não conta como vulnerabilidade neste gate. _(politica 2026-09-01)_
- **Ausência de log de auditoria** — não é vulnerabilidade. _(politica 2026-09-01)_
- **Log de dado não sensível** — só vale para segredo, senha ou PII; URL é considerada segura. _(politica 2026-09-01)_
- **Dependência desatualizada** — gerida separadamente; não entra no scorecard. _(politica 2026-09-01)_
- **Achado em arquivo que é só de teste** — não bloqueia publicação. _(politica 2026-09-01)_
- **Reescrever migration já aplicada** — impossível por desenho; reportar o que uma NOVA migration deve fazer. _(REGRA_MIGRATION_APLICADA)_
- **Suíte fiscal com 13 errors em test_n2/n3/n4** — exigem Postgres real na 5432; é o normal, não regressão. _(historico 2026-08)_
```

- [ ] **Step 6: Injetar no prompt e alimentar pela refutação**

Em `scripts/lms-reviewer-fallback.mjs`:

```js
import { lerPrecedentes, registrarPrecedente } from './lms-precedentes.mjs';
```

Trocar a assinatura de `reviewPrompt` para `(base, reviewer, changed, outputPath = '', precedentes = [])` e, logo antes do bloco `'Scoring:'`, acrescentar:

```js
    ...(precedentes.length
      ? [
          '--- PRECEDENTES: classes ja derrubadas em revisoes anteriores ---',
          'Nao reporte estas classes. Se achar que um caso e excecao ao precedente,',
          'diga POR QUE ele e diferente dentro do campo "why" — sem isso, o achado cai.',
          ...precedentes,
          '--- END ---',
          '',
        ]
      : []),
```

Em `runFallback`, ler uma vez e passar adiante:

```js
  const precedentes = await lerPrecedentes(root);
  // ...
    const prompt = reviewPrompt(resolvedBase, provider, changed, outputPathFor(provider), precedentes);
```

Em `applyRefutation`, quando a refutação **derruba** um achado (`derrubou === true`), registrar a classe. O título do achado derrubado é a classe; o `why` da refutação é o motivo:

```js
  // Refutacao vencedora vira precedente: a proxima rodada nao re-litiga a classe.
  // Registrar so quando derrubou de fato — refutacao nao comprovada nao ensina nada.
  if (derrubou && veredito?.title) {
    await registrarPrecedente(contexto.root ?? process.cwd(), {
      classe: veredito.title,
      motivo: veredito.why ?? 'derrubado pelo contraditorio',
      origem: `${contexto.refutador ?? 'refutador'} ${new Date().toISOString().slice(0, 10)}`,
    });
  }
```

`applyRefutation` passa a ser `async`; ajustar a chamada em `contestar` com `await`. Conferir que `contexto` já carrega `root` e `refutador` — se não carregar, acrescentar na chamada.

- [ ] **Step 7: Rodar a suíte inteira**

Acrescentar `scripts/lms-precedentes.test.mjs` ao `test:lms`.

Run: `pnpm test:lms`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add scripts/lms-precedentes.mjs scripts/lms-precedentes.test.mjs \
  .agents/skills/local-merge-score/references/precedentes.md \
  scripts/lms-reviewer-fallback.mjs package.json
git commit -m "feat(lms): corpus de precedentes cresce a cada refutacao vencedora"
```

---

### Task 4: Verificação adversarial por achado

O contraditório de hoje ataca o **scorecard** — caça falso-negativo (aceite frouxo). Este estágio ataca **cada achado** — caça falso-positivo. Hoje o único filtro de falso-positivo é `confidence >= 80`, auto-declarado pelo mesmo agente que achou.

**Files:**
- Create: `scripts/lms-verificar-achado.mjs`
- Create: `scripts/lms-verificar-achado.test.mjs`
- Modify: `scripts/lms-reviewer-fallback.mjs` (`runFallback`, `resolverAceite`)
- Modify: `scripts/lms-scorecard.mjs` (`verdictFindingsError`)
- Modify: `package.json`

**Interfaces:**
- Consumes: `escolherRefutador`, `verificarProva`, `collect`, `commandFor`, `PROVAS_PERMITIDAS` (de `lms-reviewer-fallback.mjs`); `findingId` (Fase 1).
- Produces:
  - `export function verificarPrompt(finding, base, changed)` → `string`
  - `export function aplicarVeredito(finding, veredito, provaResultado)` → `{ ...finding, verdict, verdict_by, verdict_why }`
  - `export const MAX_VERIFICACOES = 5`

Regras, decididas no spec §3.1:

| Veredito do verificador | Efeito |
| --- | --- |
| `CONFIRMED` | achado bloqueia, como hoje |
| `PLAUSIBLE` | achado **não** bloqueia, mas fica no scorecard como backlog |
| `FALSE_POSITIVE` **com** `proof` que roda e confirma | vira `PLAUSIBLE` (rebaixamento máximo — nunca some) |
| `FALSE_POSITIVE` **sem** prova que rode | vira `CONFIRMED` (falha fechada) |
| verificador não rodou / timeout / lixo | `CONFIRMED` (ausência de segunda opinião não absolve) |

O verificador nunca é quem achou, nem o autor. Teto de 5 achados verificados por rodada, os de maior severidade primeiro; o resto permanece `CONFIRMED`.

- [ ] **Step 1: Escrever o teste que falha**

`scripts/lms-verificar-achado.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { aplicarVeredito, verificarPrompt } from './lms-verificar-achado.mjs';

const achado = () => ({
  id: 'abc123', lens: 'code-safety', severity: 'P1', confidence: 90,
  path: 'src/a.ts:42', title: 'falta filtro de tenant', why: 'a query nao escopa',
});

test('CONFIRMED mantem o achado bloqueando', () => {
  const r = aplicarVeredito(achado(), { verdict: 'CONFIRMED', why: 'reproduzi' }, 'nao-verificavel');
  assert.equal(r.verdict, 'CONFIRMED');
});

test('PLAUSIBLE rebaixa sem remover', () => {
  const r = aplicarVeredito(achado(), { verdict: 'PLAUSIBLE', why: 'nao consegui reproduzir' }, 'nao-verificavel');
  assert.equal(r.verdict, 'PLAUSIBLE');
  assert.equal(r.title, achado().title);
});

test('FALSE_POSITIVE sem prova vira CONFIRMED', () => {
  const r = aplicarVeredito(achado(), { verdict: 'FALSE_POSITIVE', why: 'acho que nao' }, 'nao-verificavel');
  assert.equal(r.verdict, 'CONFIRMED');
});

test('FALSE_POSITIVE com prova confirmada vira PLAUSIBLE, nunca sumindo', () => {
  const r = aplicarVeredito(achado(), { verdict: 'FALSE_POSITIVE', why: 'o teste passa' }, 'confirmada');
  assert.equal(r.verdict, 'PLAUSIBLE');
});

test('veredito ausente ou malformado falha fechado', () => {
  assert.equal(aplicarVeredito(achado(), null, 'nao-verificavel').verdict, 'CONFIRMED');
  assert.equal(aplicarVeredito(achado(), { verdict: 'MAYBE' }, 'nao-verificavel').verdict, 'CONFIRMED');
});

test('verificarPrompt inclui o achado e proibe re-revisar', () => {
  const p = verificarPrompt(achado(), 'origin/master', 'src/a.ts');
  assert.match(p, /falta filtro de tenant/);
  assert.match(p, /src\/a\.ts:42/);
  assert.match(p, /CONFIRMED/);
  assert.match(p, /do not review/i);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test scripts/lms-verificar-achado.test.mjs`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar o módulo puro**

`scripts/lms-verificar-achado.mjs`:

```js
/**
 * Verificacao adversarial POR ACHADO.
 *
 * O contraditorio existente ataca o SCORECARD e caca falso-negativo: aceite frouxo.
 * Este estagio ataca CADA ACHADO e caca falso-positivo — que hoje so tem um filtro,
 * `confidence >= 80`, declarado pelo mesmo agente que achou. E o mesmo conflito de
 * interesse que ja foi removido do lado do aceite, intacto do lado do achado.
 *
 * O verificador so REBAIXA. Poder deletar um achado abriria caminho novo para
 * enfraquecer o gate — viraria "shopping por um verificador que descarta".
 */
export const MAX_VERIFICACOES = 5;

const VEREDITOS = new Set(['CONFIRMED', 'PLAUSIBLE', 'FALSE_POSITIVE']);

export function verificarPrompt(finding, base, changed = '') {
  return [
    `A reviewer flagged the finding below on the current branch against ${base}.`,
    'Your job is to try to DEMOLISH it, not to agree with it.',
    '',
    '--- FINDING ---',
    `severity: ${finding.severity}   confidence: ${finding.confidence}`,
    `path: ${finding.path}`,
    `title: ${finding.title}`,
    `why: ${finding.why}`,
    finding.precondition ? `precondition: ${finding.precondition}` : '',
    '--- END FINDING ---',
    '',
    changed ? `--- CHANGED FILES ---\n${changed}\n--- END ---\n` : '',
    'Open the cited file and decide. Do NOT review the rest of the diff — one finding,',
    'one verdict. Do NOT edit files, commit, push or change runtime state.',
    '',
    'Verdicts:',
    '  CONFIRMED      — you opened the file and the defect is really there.',
    '  PLAUSIBLE      — could be real, but you could not confirm it from the code.',
    '  FALSE_POSITIVE — it is NOT a defect, and you can prove it with a command.',
    '',
    'FALSE_POSITIVE without a proof that runs is treated as CONFIRMED. Do not claim it',
    'unless you can name a command from the project gates that demonstrates your point.',
    '',
    'Output EXACTLY ONE JSON object, no prose, no markdown fences:',
    '{',
    `  "id": "${finding.id}",`,
    '  "verdict": "CONFIRMED",',
    '  "why": "what you found when you opened the file",',
    '  "inspected": [{ "path": "src/a.ts", "line": 42, "quote": "the line, verbatim" }],',
    '  "proof": { "command": "pnpm --filter @karibu/api test", "expect": "pass" }',
    '}',
    '"proof" is optional and only meaningful for FALSE_POSITIVE.',
  ].filter(Boolean).join('\n');
}

/**
 * Aplica o veredito ao achado. Falha FECHADA em todo caminho duvidoso: veredito
 * ausente, malformado, ou FALSE_POSITIVE sem prova que rode = o achado continua
 * bloqueando. Ausencia de segunda opiniao nao absolve.
 */
export function aplicarVeredito(finding, veredito, provaResultado) {
  const bruto = veredito && VEREDITOS.has(veredito.verdict) ? veredito.verdict : 'CONFIRMED';
  let verdict = bruto;
  if (bruto === 'FALSE_POSITIVE') {
    verdict = provaResultado === 'confirmada' ? 'PLAUSIBLE' : 'CONFIRMED';
  }
  return {
    ...finding,
    verdict,
    verdict_by: veredito?.verificador ?? null,
    verdict_why: veredito?.why ?? 'sem segunda opiniao — mantido como CONFIRMED',
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test scripts/lms-verificar-achado.test.mjs`
Expected: PASS

- [ ] **Step 5: Só achado CONFIRMED bloqueia**

Em `scripts/lms-scorecard.mjs`, trocar `verdictFindingsError` por:

```js
/**
 * O veredito: achado pendente reprova a publicacao.
 *
 * Com a verificacao por achado, "pendente" passou a ter grau. Um achado rebaixado a
 * PLAUSIBLE por um verificador independente nao bloqueia — mas continua no
 * scorecard, visivel, como backlog. Achado sem `verdict` conta como CONFIRMED:
 * ausencia de verificacao nao absolve.
 */
function verdictFindingsError(value) {
  const findings = Array.isArray(value.findings) ? value.findings : [];
  if (findings.length > 0) {
    const bloqueiam = findings.filter((f) => (f.verdict ?? 'CONFIRMED') === 'CONFIRMED');
    return bloqueiam.length > 0
      ? `${bloqueiam.length} confirmed finding(s) remain: ${bloqueiam.slice(0, 3).map((f) => f.title).join('; ')}`
      : null;
  }
  // Sem lista de achados, cai no agregado — o caminho antigo continua valendo.
  for (const field of ['p0', 'p1', 'p2']) {
    if (value[field] !== 0) return `actionable ${field} findings remain`;
  }
  return null;
}
```

Acrescentar ao `scripts/lms-scorecard.test.mjs`:

```js
test('achado rebaixado a PLAUSIBLE nao bloqueia', () => {
  const card = { ...validScorecard(), score: 5, p0: 0, p1: 1, p2: 0 };
  card.lenses['code-safety'] = { p0: 0, p1: 1, p2: 0 };
  card.findings = [{ id: 'x', lens: 'code-safety', severity: 'P1', confidence: 85,
    path: 'a.ts:1', title: 't', why: 'w', verdict: 'PLAUSIBLE' }];
  assert.equal(validateScorecard(card, options), true);
});

test('achado sem verdict conta como CONFIRMED e bloqueia', () => {
  const card = { ...validScorecard(), score: 5, p0: 0, p1: 1, p2: 0 };
  card.lenses['code-safety'] = { p0: 0, p1: 1, p2: 0 };
  card.findings = [{ id: 'x', lens: 'code-safety', severity: 'P1', confidence: 85,
    path: 'a.ts:1', title: 't', why: 'w' }];
  assert.equal(validateScorecard(card, options), false);
});
```

- [ ] **Step 6: Ligar o estágio em `runFallback`**

Em `scripts/lms-reviewer-fallback.mjs`, acrescentar — modelada em `contestar`, que já resolve a escolha do provider e a coleta:

```js
import {
  aplicarVeredito,
  MAX_VERIFICACOES,
  verificarPrompt,
} from './lms-verificar-achado.mjs';

const ORDEM_SEVERIDADE = { P0: 0, P1: 1, P2: 2 };

/** Le o veredito com a MESMA varredura do scorecard — parser ingenuo falha aberto. */
function parseVeredito(stdout = '', stderr = '') {
  const aceita = (value) => 'verdict' in value;
  const candidatos = [
    ...candidatesFrom(stdout, new Set(), aceita),
    ...candidatesFrom(stderr, new Set(), aceita),
  ];
  return candidatos.at(-1) ?? null;
}

/**
 * Cada achado passa por um verificador independente.
 *
 * Falha FECHADA em todo caminho: sem verificador elegivel, com timeout, com veredito
 * malformado ou fora do teto, o achado sai CONFIRMED e continua bloqueando. Ausencia
 * de segunda opiniao nao absolve — mesmo principio do contraditorio e do fallow.
 */
async function verificarAchados({
  root, config, env, collect, ordem, autor, provider, base, changed, scorecard, outputPathFor,
}) {
  const findings = Array.isArray(scorecard?.findings) ? scorecard.findings : [];
  if (findings.length === 0) return scorecard;
  if (env.LMS_VERIFY === '0') {
    console.error('lms: verificacao por achado desligada por LMS_VERIFY=0');
    return scorecard;
  }

  const porGravidade = [...findings].sort(
    (a, b) => (ORDEM_SEVERIDADE[a.severity] ?? 9) - (ORDEM_SEVERIDADE[b.severity] ?? 9),
  );
  const aVerificar = porGravidade.slice(0, MAX_VERIFICACOES);
  const excedente = porGravidade.slice(MAX_VERIFICACOES);

  const verificados = await Promise.all(
    aVerificar.map(async (finding) => {
      const verificador = escolherRefutador({ ordem, attempts: [], provider, autor });
      if (!verificador) {
        return aplicarVeredito(finding, null, 'nao-verificavel');
      }
      const prompt = verificarPrompt(finding, base, changed);
      const saida = await collect({
        root, provider: verificador, config, base, prompt, env,
        parse: parseVeredito, outputPath: outputPathFor(verificador),
      }).catch(() => ({ kind: 'error' }));
      if (saida.kind !== 'ok' || !saida.candidate) {
        return aplicarVeredito(finding, null, 'nao-verificavel');
      }
      const veredito = { ...saida.candidate, verificador };
      const prova = veredito.proof
        ? await verificarProva(root, veredito.proof, env)
        : 'nao-verificavel';
      const resultado = aplicarVeredito(finding, veredito, prova);
      console.error(
        `lms: ${verificador} -> ${resultado.verdict} em "${finding.title}"`,
      );
      return resultado;
    }),
  );

  const naoVerificados = excedente.map((finding) => ({
    ...finding,
    verdict: 'CONFIRMED',
    verdict_by: null,
    verdict_why: `nao verificado (teto de ${MAX_VERIFICACOES} por rodada)`,
  }));

  return { ...scorecard, findings: [...verificados, ...naoVerificados] };
}
```

`collect` recebe `parse` e `outputPath` porque `collectHeadless` já aceita `parse` (linha 562) e o coletor de tmux precisa saber onde o verificador grava. Se a assinatura de `collectHeadless` ainda não aceitar `outputPath`, acrescentar o parâmetro e ignorá-lo no caminho headless.

Chamar em `runFallback`, **antes** de `contestar`, e passar o scorecard já verificado adiante:

```js
    if (attempt.accepted) {
      const verificado = await verificarAchados({
        root, config, env, collect, ordem, autor, provider, base: resolvedBase,
        changed, scorecard: attempt.scorecard, outputPathFor,
      });
      const contraditorio = await contestar({
        root, config, env, collect, ordem, autor, provider, base: resolvedBase,
        changed, outputPathFor, attempts, subject, scorecard: verificado, changedPaths,
      });
      return resolverAceite({
        root, env, provider, attempt: { ...attempt, scorecard: verificado },
        attempts, contraditorio,
      });
    }
```

Ordem importa: verificar antes de contestar significa que o contraditório vê os achados já com veredito, e um achado rebaixado a `PLAUSIBLE` é exatamente o tipo de coisa que o refutador deve poder atacar de volta.

- [ ] **Step 7: Documentar no SKILL.md**

Em `.agents/skills/local-merge-score/SKILL.md`, na seção do contraditório, acrescentar:

```markdown
**Cada achado passa por um verificador, e o verificador só rebaixa.** O contraditório
ataca o scorecard e caça falso-negativo; a verificação por achado ataca cada achado e
caça falso-positivo — que até aqui só tinha `confidence >= 80`, declarado pelo mesmo
agente que achou. Vereditos: `CONFIRMED` bloqueia; `PLAUSIBLE` não bloqueia mas fica no
scorecard como backlog; `FALSE_POSITIVE` **só** com prova executável da allowlist, e
mesmo assim o teto é `PLAUSIBLE` — nunca some. Veredito ausente, malformado, com timeout
ou sem verificador elegível conta como `CONFIRMED`: ausência de segunda opinião não
absolve. Teto de 5 achados por rodada, os mais graves primeiro; o resto segue bloqueando.
`LMS_VERIFY=0` desliga assumindo o risco, como `LMS_ALLOW_UNCONTESTED=1`.
```

- [ ] **Step 8: Rodar a suíte inteira**

Acrescentar `scripts/lms-verificar-achado.test.mjs` ao `test:lms`.

Run: `pnpm test:lms`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add scripts/lms-verificar-achado.mjs scripts/lms-verificar-achado.test.mjs \
  scripts/lms-reviewer-fallback.mjs scripts/lms-scorecard.mjs scripts/lms-scorecard.test.mjs \
  .agents/skills/local-merge-score/SKILL.md package.json
git commit -m "feat(lms): cada achado passa por verificador independente que so rebaixa"
```

---

## Fim da Fase 2

O LMS passa a: dispensar a cadeia em diff sem execução, revisar mais fundo onde o grafo diz que dói, lembrar do que já derrubou, e submeter cada achado a um verificador que não pode apagá-lo.
