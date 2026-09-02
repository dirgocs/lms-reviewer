---
name: local-merge-score
description: >
  Local merge-readiness score (0–5, Greptile-style) plus a bounded fix loop.
  Composes Claude code-review findings, optional fallow audit, and graphify
  blast-radius signals. Use when asked for local merge score, LMS, score loop,
  greploop-local, review until 5/5 without Greptile credits, or pre-PR triage
  on the current branch/diff.
license: MIT
metadata:
  author: dirgocs/lms-reviewer
  version: '1.1'
---

# Local Merge Score (LMS)

Greptile-style **0–5 merge readiness** on the current branch/diff **without** spending Greptile credits. Claude (or host agent) `code-review` owns findings; this skill owns **scoring**, **graph context**, and the **fix loop**.

## When to use

- Pre-PR / pre-merge triage on the current checkout
- “Quanto está o score?” / “loop até 4/5 ou 5/5 local”
- Substitute for `greploop` when Greptile credits must be saved
- After implementing a feature, before opening a non-draft PR

## When NOT to use

- Replacing Greptile on a PR the user explicitly wants reviewed by Greptile
- Whole-repo health (use `fallow` skill)
- Pure architecture exploration without a diff (use `graphify` alone)
- Infinite greploop against GitHub bots (this loop is **local only**)

## Defaults

| Knob                          | Default                                                                                                                               | Override              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Base ref                      | `origin/master` then `origin/main` then `master`                                                                                      | user says base        |
| Target LMS                    | **5** — only 5/5 goes up to PR                                                                                                        | `target=N`            |
| Plateau stop                  | **2** consecutive iterations without score improvement → stop and escalate to Master (pending human decision, not lack of iterations) | `plateau=N`           |
| Hard ceiling                  | **8** iterations (runaway backstop; rarely reached)                                                                                   | `max=N`               |
| Delta-review                  | from iteration 2 on, re-review ONLY files changed since the previous iteration                                                        | —                     |
| Finding confidence floor      | **80** (same idea as Claude code-review)                                                                                              | do not lower casually |
| Greptile / `@greptile review` | **forbidden** unless user explicitly asks                                                                                             | —                     |

## Pipeline (one iteration)

```
0. Resolve base + changed paths
1. Graphify orient (if graph.json exists)
2. Code-review findings (Claude code-review skill OR equivalent multi-perspective review)
3. Optional fallow audit (deterministic)
4. Compute LMS 0–5 (see rubric)
5. If LMS >= target → report and stop (ready for PR)
   If score unchanged for 2 consecutive iterations (plateau) → report and ESCALATE to Master
   If iteration == hard ceiling (8) → report and stop (runaway backstop)
6. Else fix P0 then P1 then high-confidence P2 → commit optional → next iteration
   (iteration 2+: delta-review — only re-review files changed since last iteration)
```

### 0. Resolve base and diff scope

```bash
git rev-parse --show-toplevel
BASE=$(git merge-base HEAD origin/master 2>/dev/null \
  || git merge-base HEAD origin/main 2>/dev/null \
  || git merge-base HEAD master 2>/dev/null \
  || echo "HEAD~1")
git diff --name-only "$BASE"...HEAD
git log --oneline "$BASE"..HEAD | head -20
```

If the working tree has uncommitted changes, include them:

```bash
git status -sb
git diff --name-only
git diff --cached --name-only
```

### 1. Graphify orient (cheap — query only)

**Require:** `graphify-out/graph.json` exists and `graphify` CLI works.

Do **not** run full `/graphify .` rebuild inside the loop. Use scoped queries:

```bash
# For each high-signal path or symbol in the diff (cap 5–8 queries total per iteration):
graphify query "What depends on <SymbolOrFile>?"
graphify path "<ChangedModule>" "<TenantOrAuthOrApiSurface>"
# Optional:
graphify explain "<Symbol>"
```

Capture graph signals for the score:

| Signal                                                     | Effect on LMS                               |
| ---------------------------------------------------------- | ------------------------------------------- |
| Diff touches auth / RLS / tenant / fiscal / payments paths | Cap LMS ≤ 3 unless review is clean of P0/P1 |
| Cross-community / cross-package blast radius high          | Prefer LMS ≤ 3 if any P1 remains            |
| Only docs, config, CI, generated                           | Graph soft; do not inflate score            |

If graphify CLI or `graph.json` is missing: skip this step, note `graphify: skipped`, continue.

After code edits in a completed session (not every loop tick), remind to run `graphify update .` (AST-only) so the graph stays current.

### 2. Code-review findings (four lenses)

O caminho depende de **quem está dirigindo**, e a ordem abaixo é a real — não a
aspiracional. Dizer "prefira `/code-review`" para um agente que não consegue chamá-lo é
o tipo de documentação que faz perder tempo até descobrir sozinho.

**Agente (caminho principal):** cadeia de revisores em tmux — `pnpm lms:reviewer:tmux`,
ou automaticamente pelo `pnpm lms:trigger` no pre-push. Cada provider roda na TUI
dele, com as ferramentas nativas, e grava `.lms/candidates/<provider>.json`. Isso é
`autonomy: "reviewer"`: revisor independente de verdade, que é a categoria mais forte.
`LMS_REVIEWER_MODE=headless` volta à invocação headless (CI, container sem TTY).

**Humano (caminho principal):** `/code-review` (plugin Claude). O skill tem
`disable-model-invocation` — é disparado por você, cobrado, e roda na nuvem. Um agente
**não consegue** chamá-lo; não adianta tentar.

**Último recurso:** revisão multi-perspectiva feita por você mesmo, com as quatro lentes.

**Se você é o autor do diff, isto é `autonomy: "self"`** — a categoria mais fraca, e o
gate avisa em voz alta. Auto-revisão **não equivale** a revisor independente: é o mesmo
raciocínio que produziu o defeito julgando o defeito. A regra que vale no resto do
projeto é **revisor ≠ autor** (ver política de modelos do swarm). Prefira, nesta ordem:

1. cadeia de reviewers em tmux (`autonomy: "reviewer"`) — independente de verdade;
2. um subagente com modelo **diferente** do autor;
3. `self`, declarado como tal, quando não houver alternativa.

Classify **every** finding into one primary **lens**:

| Lens                | Focus                                                                  |
| ------------------- | ---------------------------------------------------------------------- |
| **code-safety**     | Auth, tenant/RLS, SQL injection, secrets, fiscal/compliance, data loss |
| **code-structure**  | Boundaries, DOX, layering, over-engineering, public API surface        |
| **code-quality**    | Correctness in this diff, edge cases, missing tests, broken contracts  |
| **code-efficiency** | New complexity, hotspots, duplication, unnecessary deps                |

Also cover the consumer's rules from the root and nearest `AGENTS.md` (or equivalent)
and the project facts declared in `lms.config.json`. Business rules belong to the
consumer; the package must not guess its tenant key, package manager, or service layout.

For each finding emit:

```text
- lens: code-safety | code-structure | code-quality | code-efficiency
- severity: P0 | P1 | P2
- confidence: 0-100
- path:line
- title
- why_it_matters
- suggested_fix
```

**Drop** findings with `confidence < 80`.<br>
**Drop** pre-existing issues not introduced by the diff.<br>
**Drop** pure style/format (linter owns it).

Severity anchors:

| Severity | Examples                                                                            |
| -------- | ----------------------------------------------------------------------------------- |
| **P0**   | Auth bypass, missing tenant isolation, data loss, secret leak, prod-breaking deploy |
| **P1**   | Real bug in new code, broken contract, wrong default that ships wrong behavior      |
| **P2**   | Maintainability, naming that confuses, missing non-critical test, mild duplication  |

**Lens caps (after base LMS):** any **P0 safety** → LMS ≤ 1; any **P1 safety** on fiscal/auth/tenant → LMS ≤ 2.

### 3. Fallow audit — obrigatório, não opcional

**Alegação mecânica se prova sozinha.** Quando a refutação puder ser demonstrada por
um comando — suite que falha, lint que acusa —, ela declara `proof: {command, expect}`
e o runner **roda**. Se o resultado não bater, a refutação cai (`refutacao-nao-comprovada`)
e o aceite segue. Existe porque uma refutação alucinada bloqueava para sempre: o codex
afirmou "a suíte tem oito falhas" sobre uma suíte que passava 34/34, e a palavra do
refutador era final. Os comandos aceitos são uma lista fechada (gates do projeto) — o
comando vem da saída de um modelo, e shell arbitrário ali seria entregar a máquina a
quem escreve o veredito.

**O refutador prova leitura como o revisor.** `inspected` com citação verbatim
conferida no disco vale para os dois lados: um `{refuted:false}` seco, de quem não
abriu arquivo nenhum, contaria como segunda opinião e liberaria o push. Contraditório
de fachada é pior que nenhum, porque parece rigor.

**Contraditório que não roda bloqueia.** Timeout, CLI ausente, veredito malformado ou
nenhum refutador elegível não são concordância: são ausência de segunda opinião, e sem
ela não se publica — mesmo princípio que vale para o fallow. `LMS_ALLOW_UNCONTESTED=1`
assume o risco conscientemente, como o `LMS_SKIP=1`.

**Todo aceite passa por contraditório.** A cadeia parava no primeiro scorecard
válido, então um aceite frouxo publicava sem segunda opinião — e discordar não custava
nada a quem aprovava. Agora um provider diferente (nem o que aprovou, nem o autor) é
pago para _derrubar_ o 5/5. Refutação com confiança ≥ 80 vira achado no scorecard, que
cai para 4 e passa a bloquear. Não achar defeito é resposta legítima e esperada.

**O contexto do revisor inclui a árvore suja.** Antes era só `base...HEAD`, e o revisor
julgava um mapa desatualizado — foi assim que ele reportou como ausente uma flag que já
estava no disco. Mudança não commitada e arquivo novo entram no diff que ele vê, e no
`subject` que o amarra.

**Todo desfecho vai para `.lms/history.jsonl`.** `last.json` é sobrescrito a cada
rodada; sem histórico não há como ver que um provider aceitou 40 de 40 — o sinal mais
barato de revisor complacente.

**O scorecard vale só para o diff que foi revisado.** O campo `subject` é o hash do
que o revisor viu — commits desde a base, árvore suja e arquivos novos ainda não
rastreados. O gate recalcula na hora e recusa quando não bate. Antes a validade era
só temporal (2h), então um 5/5 autorizava qualquer coisa commitada em seguida; o
próprio gate pedia em prosa para re-pontuar, e pedido ao agente não é trava.

**O autor sai da cadeia de revisores.** O runner detecta quem está dirigindo pelo
ambiente do CLI (`CLAUDECODE`, `CODEX_HOME`, `GROK_SESSION_ID`; `LMS_AUTHOR`
sobrescreve) e remove esse provider. Se não sobrar nenhum independente, a revisão
acontece mesmo assim, mas o scorecard sai marcado `self` — a categoria fraca — em vez
de se disfarçar de independente.

**O campo `fallow` do scorecard é exigido, e `"skipped"` é recusado.** O fallow é
determinístico e roda no push gate de qualquer jeito; declarar "skipped" era só uma
forma de não olhar. Foi assim que um scorecard 5/5 conviveu com o fallow bloqueando o
push por regressão de complexidade — os dois gates não se falavam.

Aceitos no veredito: `pass`, `warn`, `no-changes`. Recusados: `fail`, `skipped`,
ausente.

Rodar (pode ser lento no monorepo inteiro):

```bash
pnpm exec fallow audit --base "$BASE" --format json --quiet 2>/dev/null || true
# or via orient helper:
pnpm local:review -- --fallow
```

Map:

| `verdict`        | Score pressure                                                                 |
| ---------------- | ------------------------------------------------------------------------------ |
| `fail`           | Treat as at least one synthetic P1 (or keep LMS ≤ 2 if many introduced errors) |
| `warn`           | Soft; can hold LMS at 3–4 if agent review is clean                             |
| `pass` / missing | Neutral                                                                        |
| `no-changes`     | Neutral — **never block**                                                      |

**Regression gate scoped ao diff (anti falso-positivo):** se o audit reportar
`changed_files_count: 0`, o gate **não bloqueia** — o orient emite
`fallow: "no-changes"` e não compara métricas globais contra baseline zerada.
Regressão só conta quando derivada dos arquivos do diff (ou de baseline
não-vazia correspondente). Ao ajustar a política fallow, preserve esta regra.

Never run `fallow watch`. Never enable fallow telemetry.

### 4. Compute Local Merge Score

Load full rubric: [references/rubric.md](references/rubric.md).

Quick map:

| Condition                                                      | LMS     |
| -------------------------------------------------------------- | ------- |
| ≥1 P0 (conf ≥80) **or** fallow fail + security-sensitive paths | **0–1** |
| ≥1 hard P1 **or** several introduced fail-level static issues  | **2**   |
| Only soft P1 / several P2 / warn + risky area                  | **3**   |
| Zero P0/P1, ≤2 cosmetic P2, fallow pass/warn light             | **4**   |
| Zero actionable findings (P0/P1/P2 all empty after filter)     | **5**   |

Contextual caps (apply **after** base score, take the lower):

- Fiscal/compliance, auth, RLS/tenant, and payment paths identified by project rules:
  if any P1 remains → LMS ≤ 2; if only P2 → LMS ≤ 4
- CI-only / docs-only diff with no logic: do not invent P1; score can be 5 if review is empty

### 5–6. Loop

**Prefer Claude Code `/goal` when available** (v2.1.139+): condition-driven multi-turn until the evaluator sees evidence in the transcript. Templates: [references/goal-loop.md](references/goal-loop.md).

Example:

```text
/goal LMS = 5/5 with .lms/last.json written this session; zero P0 and zero P1
across code-safety, code-structure, code-quality, code-efficiency (conf≥80);
pnpm local:review evidence in transcript; no @greptile review; stop early and
escalate if score does not improve for 2 consecutive iterations (plateau);
hard stop after 8 iterations
```

Use **`/loop`** only to babysit (CI, human comments) on an interval — **not** as the primary fix loop and **never** to re-trigger Greptile. Project default: `.claude/loop.md` when present.

**Hosts without `/goal` (e.g. Grok):** explicit iteration loop:

```
iteration = 1; last_score = -1; plateau = 0
while true:
  run pipeline steps 0–4   # iteration 2+: delta-review (only files changed since last iteration)
  print scorecard (format below)
  if LMS >= target: break                     # 5/5 → ready for PR
  plateau = (LMS <= last_score) ? plateau+1 : 0
  if plateau >= 2: break and ESCALATE to Master   # human decision pending, stop burning tokens
  if iteration >= 8: break                    # runaway backstop
  last_score = LMS
  fix all P0, then P1, then high-value P2 (user can refuse P2)
  re-run typecheck/tests for touched packages when practical
  iteration += 1
```

Large diffs: sequential per-lens goals (safety → quality → structure → efficiency → LMS aggregate).

Do **not** push unless the user asked. Do **not** open PRs or trigger Greptile.

## Scorecard output (mandatory every iteration)

```markdown
## Local Merge Score: N/5

**Iteration:** i/max · **Target:** T · **Base:** <ref>

| Source       | Result                                                                   |
| ------------ | ------------------------------------------------------------------------ |
| code-review  | P0=a P1=b P2=c (conf≥80)                                                 |
| lenses       | safety p0/p1/p2 · structure · quality · efficiency                       |
| fallow audit | pass \| warn \| fail \| skipped                                          |
| graphify     | oriented \| skipped · notes: …                                           |
| autonomy     | reviewer \| goal \| loop \| manual \| **self** (mais fraco — ver abaixo) |

**Action:** merge | merge after small fixes | address feedback | rework | rethink

### Actionable findings

1. **[lens] P0/P1/P2** `path:line` — title (conf NN)
   - why / fix

### Fixed this iteration (if any)

- …

### Remaining for next iteration

- … or _none_
```

Final summary when stopping:

```markdown
## LMS complete

| Field                 | Value        |
| --------------------- | ------------ |
| Final score           | N/5          |
| Iterations            | i            |
| Target met            | yes/no       |
| Greptile credits used | 0            |
| graphify              | used/skipped |
| Remaining findings    | k            |
```

### Write scorecard for the hook (mandatory at end of a full LMS run)

After the final scorecard of the session (or whenever LMS is declared done), write:

```bash
mkdir -p .lms
```

`.lms/last.json`:

```json
{
  "score": 5,
  "target": 5,
  "base": "origin/master",
  "iteration": 1,
  "plateau": 0,
  "max_iterations": 8,
  "p0": 0,
  "p1": 0,
  "p2": 0,
  "lenses": {
    "code-safety": { "p0": 0, "p1": 0, "p2": 0 },
    "code-structure": { "p0": 0, "p1": 0, "p2": 0 },
    "code-quality": { "p0": 0, "p1": 0, "p2": 0 },
    "code-efficiency": { "p0": 0, "p1": 0, "p2": 0 }
  },
  "autonomy": "reviewer",
  "fallow": "pass",
  "graphify": "oriented",
  "inspected": [
    { "path": "path/from/the/diff.ts", "line": 42, "quote": "export function foo(bar) {" },
    { "path": "another.ts", "line": 7, "quote": "import { thing } from './thing';" },
    { "path": "a/third.ts", "line": 130, "quote": "const LIMIT = 12_000;" }
  ],
  "at": "2026-07-08T20:00:00Z"
}
```

Use real values and ISO-8601 UTC for `at`. When installed as documented, the Claude
PreToolUse hook at
`node_modules/@dirgocs/lms-reviewer/hooks/local-merge-score-gate.sh` reads this file
before `git commit` / `git push` / `gh pr create`.

| Env                               | Effect                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `LMS_HOOK_STRICT=1`               | Hook **blocks** the tool call if scorecard missing/stale/below min                                                          |
| `LMS_HOOK_MIN_SCORE`              | Default `5` — only 5/5 goes up to PR; plateau escalation is the sanctioned exception (Master decides, may use `LMS_SKIP=1`) |
| `LMS_HOOK_MAX_AGE_SEC`            | Default `7200` (2h)                                                                                                         |
| `LMS_HOOK_SKIP=1` or `LMS_SKIP=1` | Bypass hook                                                                                                                 |

Default is inject-context only (not strict). `.lms/` is gitignored runtime state.

## Relationship to other skills

| Skill                          | Role vs LMS                                                     |
| ------------------------------ | --------------------------------------------------------------- |
| **code-review** (Claude)       | Finding engine — call first each iteration                      |
| **fallow** / **fallow-review** | Deterministic gate / structural brief — optional input to score |
| **graphify**                   | Blast radius / path — orientation, not findings                 |
| **greploop**                   | GitHub + Greptile credits — **do not** call from LMS            |
| **check-pr**                   | Read existing PR comments — optional after open PR              |
| **ponytail**                   | Use when fixing over-engineering P2s                            |

## Consumer project rules (always apply in review)

- Read the root and nearest `AGENTS.md` (or the repository's equivalent instruction
  files) before reviewing a subtree.
- Treat `lms.config.json` as the source for consumer-specific paths and gates.
- Apply the repository's business, security, tenancy, package-manager, testing, and
  production-readiness rules exactly as written; do not replace them with package
  defaults.

## Failure modes

| Situation               | Response                                                           |
| ----------------------- | ------------------------------------------------------------------ |
| No git repo             | Stop; LMS requires a git checkout                                  |
| No code-review skill    | Self-review with the fallback checklist above                      |
| graphify missing        | Skip graph; note in scorecard                                      |
| fallow missing          | Skip fallow; note in scorecard                                     |
| User wants Greptile 5/5 | Direct them to `greploop` / credit policy; LMS is local substitute |

## Isolated reviewer (tmux + pxpipe)

`pnpm lms:reviewer` always tries pxpipe. Imaging allowlist is **auto-resolved**:
intersection of preferred imaging models × models available on this sub.
Empty intersection → `PXPIPE_MODELS=off` (pass-through). Per-request imaging
is pxpipe’s profitability gate. Do not ask the user to toggle pxpipe.
Byte-exact safety work → subagent on a model outside the imaging allowlist.

- Spawn: `pnpm lms:reviewer`
- Auto-trigger on publish: `pnpm lms:trigger`
- Detached spawn for hooks: `LMS_SPAWN_DETACHED=1`
- Bypass: `LMS_SKIP=1` / `LMS_HOOK_SKIP=1`
- If proxy missing: graceful OFF (unless `LMS_REQUIRE_PXPIPE=1`)

## Headless reviewer fallback

The publication gate runs authenticated local reviewers headlessly when
`.lms/last.json` is missing or stale. The fixed default order is:

1. Claude Opus 4.8 High: `claude --model claude-opus-4-8 --effort high`
2. Grok 4.6 Medium: `grok --model grok-4.6 --reasoning-effort medium` — medium
   supera high no grok-4.6 para review (medição do Master, 2026-08-15)
3. GPT-5.6 Sol High: `codex exec --model gpt-5.6-sol -s read-only` with
   (terra NÃO revisa — tier de execução intermediária; review exige modelo
   melhor ou do nível do autor — diretriz Master 2026-08-16) —
   `model_reasoning_effort="high"` — **`codex exec`, não `codex exec review`**: o
   subcomando `review` tem schema de saída próprio e ignora o prompt vindo por stdin
   sem `-`. O `-s read-only` é obrigatório: o codex lê arquivos executando shell, e o
   sandbox é o que impede mutação.

The public entry points are `pnpm lms:reviewer` and `pnpm lms:trigger`; their
implementation lives in the installed package. Model and timeout overrides are
`LMS_CLAUDE_MODEL`, `LMS_GROK_MODEL`, `LMS_CODEX_MODEL`,
`LMS_REVIEWER_ORDER`, and `LMS_REVIEWER_TIMEOUT_SEC`. OAuth remains in each
CLI's local session; no provider credentials are read or logged by the repo.

Reviewers run read-only and must return a fresh structured scorecard.

**Reprovação NÃO é falha do reviewer** (corrigido em 2026-07-26). O runner separa
duas coisas que antes eram uma só:

| Situação                                                   | O que é                                      | O que acontece                                          |
| ---------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------- |
| JSON malformado, timeout, quota, `reviewer`/`base` errados | o provider **não fez** o trabalho            | cai para o próximo provider                             |
| Scorecard bem formado com score < 5 ou achado pendente     | o provider **fez** o trabalho e **reprovou** | grava `.lms/last.json`, **encerra a cadeia** e bloqueia |

Encerrar na reprovação é deliberado: continuar seria procurar um reviewer que
aprove. E **se todos falharem, a publicação fica bloqueada** — `exit 1`, não
warning. Até 2026-07-26 o trigger fazia `exit 0` com "Proceeding with push despite
reviewer chain failure", e o efeito era o gate invertido: reprovação legítima era
lida como reviewer quebrado, os três "falhavam", e quanto mais problema o código
tinha, mais fácil passar.

**Prova de leitura é verificada contra o disco.** Cada entrada de `inspected` é
`{path, line, quote}`, e o runner confere a citação no arquivo — janela de 3 linhas
para tolerar off-by-one na contagem, e containment num sentido só (a linha real
contém o trecho citado). Sem isso, `inspected` era auto-declarado: um provider podia
listar caminhos plausíveis do diff e emitir 5/5 sem abrir nada — foi exatamente o que
o codex fez, aprovando em 17s com `reasoning_tokens: 152` e zero ferramentas.

O prompt enviado aos reviewers traz o **objeto exato** e as strings literais de
`reviewer` e `base`. Pedir "um JSON com reviewer, score, base…" em prosa era a
outra metade do problema: os três providers escreviam `reviewer: "Claude Opus 4.8"`,
omitiam `base` ou embrulhavam em cerca markdown, e falhavam na validação.

Diagnóstico quando algo falha: `.lms/fallback.log` traz `provider`, `result` e
`reason` de cada tentativa. `pnpm lms:reviewer` abre a sessão manual.

**Reviewer skill allowlist:** code-review, local-merge-score, fallow/fallow-review,
graphify, ponytail, caveman. **Denylist default:** greploop / `@greptile review`
without Master request.

## Quick invoke

User phrases that should trigger this skill:

- `/local-merge-score`
- “LMS” / “score local” / “merge score”
- “loop de review sem greptile”
- “até 4/5 ou 5/5 local”
