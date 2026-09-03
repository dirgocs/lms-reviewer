# LMS v2 — Fase 5: triagem de bug com agentes de domínio no repo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar entrada ao que chega de runtime (log de exceção, 500, rejeição da SEFAZ,
texto de issue): o sinal vira um achado do contrato do scorecard, passa pelo verificador
adversarial da Fase 2 e recebe rota (revisor/orquestrador) e rastreador opcionais. A
inteligência de domínio mora em agentes versionados no repo consumidor (`.agents/bug-triage/*.md`),
nunca no pacote.

**Architecture:** Quatro módulos novos (`lms-bug-agents.mjs`, `lms-triage-bug.mjs`,
`lms-bug-bootstrap.mjs`, `lms-tracker.mjs`) + adaptações: `bugAgents` em
`lms-config.mjs:loadConfig` (hoje chaves fechadas), `relativo` opcional em
`lms-precedentes.mjs` (caminho fixo hoje), `verificarAchados` reusado por
`lms-reverificar`/`lms-triage-bug`, `lms-eval.mjs` parametrizado (`carregarCasos`
hardcoded `casos`/`patch.diff` hoje). Task extra (evidência KDT-68, lanes paradas
"aguardando veredito"): o runner grava `.lms/veredito.json` ao fim de QUALQUER cadeia
e o `lms-trigger` sai com código por estado + linha estável `LMS VEREDITO: <estado>`.

**Tech Stack:** Node 22 ESM, `node --test`, `git`/`gh`/`curl` via `execFile`/`spawn`.
Sem dependências novas (frontmatter com parser próprio).

**Spec:** `docs/lms-v2/2026-09-03-lms-v2-fase5.md`

## Global Constraints

- PNPM only (ADR-009). Zero dependências novas (frontmatter com parser próprio).
- Fail-closed em todo caminho novo: `path` conferido no disco com linha
  (`citationsDiskError`); triagem passa SEMPRE pelo verificador da Fase 2
  (`LMS_VERIFY=0` recusa a triagem inteira, exit 1); agente só roda COMMITADO
  (untracked/modificado → recusa nomeada); sinal vazio ou sem caminho existente e sem
  agente → exit 2 nomeando o que faltou.
- Nenhum veredito novo: triagem não pontua, não escreve `.lms/last.json`, não toca
  `score`/`aggregate`/`coverage`, não desbloqueia push. `PLAUSIBLE` vira backlog.
- Bootstrap: só dispara com diretório vazio/ausente; nunca quando existe agente que
  não casou; nada roda até os arquivos serem commitados.
- Falha de ferramenta (tracker, binário, HTTP) avisa e segue — o achado fica em `.lms/`.
- Comentários e commits em pt-BR. `pnpm test` verde antes de cada commit. Um commit por task.

---

### Task 1: `lms-bug-agents.mjs` — frontmatter, carga, match, guarda de commitado

**Files:**

- Create: `scripts/lms-bug-agents.mjs`
- Create: `scripts/lms-bug-agents.test.mjs`

**Interfaces:**

- `export function parseFrontmatter(texto)` → `{ dados, corpo } | null` (YAML mínimo
  próprio: `chave: valor` e listas `- item`; sem `nome` ou regex que não compila → null).
- `export async function carregarAgentes(root, dir)` → agentes válidos; frontmatter
  inválido descartado com aviso, nunca "match parcial" (disciplina de `regexList`).
- `export async function agenteCommitado(root, arquivo)` → `{ commitado, estado }` via
  `git ls-files --error-unmatch` + `git status --porcelain` (untracked/modificado → recusa).
- `export function escolherAgente(agentes, sinal)` → maior escore > 0 (paths×3 sobre
  `caminhos_citados`, sinal×2, tags×1), empate pelo `nome` menor; zero → null.
- `export function contextoDoAgente(agente)` → corpo markdown + `fontes_de_verdade` +
  `verificar_antes_de_abrir_issue` como bloco de contexto do prompt.

- [ ] **Step 1: Testes que falham** (spec §4): frontmatter válido carrega; sem `nome` ou
  regex inválida → descartado com aviso; escore paths>sinal>tags e desempate por nome;
  agente untracked recusado; agente modificado recusado; zero match → null (sinaliza bootstrap).
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: `pnpm test` verde; commit** — `feat(lms): agentes de triagem de bug com match e guarda de commitado`.

---

### Task 2: `bugAgents` na config + exemplo

**Files:**

- Modify: `scripts/lms-config.mjs` (`EMPTY` ganha `bugAgents`; `loadConfig` valida `dir`
  com `str` e `tracker` contra `TRACKERS`; `guided` boolean)
- Modify: `lms.config.example.json` (documentar)
- Create: `scripts/lms-config.test.mjs` (casos de `bugAgents`) — se já existir, acrescentar

**Interfaces:** `{ bugAgents: { dir: '.agents/bug-triage', tracker: 'none', guided: false } }`
defaults; `tracker` fora de `['none','github','linear']` → default `none` (allowlist).

- [ ] **Steps: teste que falha → implementar → verde → commit** —
  `feat(lms): bugAgents na config — dir, tracker e guided opcionais`.

---

### Task 3: `lms-triage-bug.mjs` — sinal vira achado (núcleo puro)

**Files:**

- Create: `scripts/lms-triage-bug.mjs`
- Create: `scripts/lms-triage-bug.test.mjs`

**Interfaces:**

- `export function normalizarSinal(texto, origem)` → `{ texto, origem, tags }`
  (`tags` de padrões agnósticos: código HTTP, nome de exceção, `Traceback`, `panic:`).
- `export async function caminhosDoSinal(texto, root)` → caminhos citados por regex de
  stack trace, filtrados pelo que existe no disco (mesmo princípio de `citationsDiskError`).
- `export function triagemPrompt(sinal, agente, precedentes)` → prompt com o contexto do
  agente + precedentes daquele agente; proíbe path inventado.
- `export function parseTriagem(stdout, stderr)` — mesma tolerância de
  `normalizeProviderOutput` (um JSON com forma de achado).
- `export function achadoDoSinal(parsed, sinal, agente)` → achado do contrato
  (`findingId`, `lens` default `code-safety`, `confidence` 70, `origem: { tipo: 'runtime',
  sinal: sha256, agente }`, `found_by`), validado por `findingsShapeError`; recusa
  `path` sem linha/existente via `citationsDiskError`.

- [ ] **Step 1: Testes que falham** (spec §4): caminho inexistente no disco não vira
  `path`; achado passa `findingsShapeError` e `id` bate `findingId`; sinal vazio → exit 2;
  stdin e arquivo dão o mesmo achado; tags de padrões agnósticos.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: `pnpm test` verde; commit** — `feat(lms): sinal de runtime vira achado do contrato`.

---

### Task 4: Wiring com `verificarAchados` + bin/script

**Files:**

- Modify: `scripts/lms-triage-bug.mjs` (`runTriageBug`)
- Modify: `package.json` (bin `lms-triage-bug`, script `lms:triage:bug`)
- Modify: `scripts/lms-package.test.mjs`

**Interfaces:**

- `export async function runTriageBug({ root, env, collect, argv })`:
  1. `LMS_VERIFY=0` → recusa a triagem inteira (exit 1, nomeando).
  2. Sinal vazio, ou sem caminho existente citado **e** sem agente que case → exit 2.
  3. Achado embrulhado em `{ reviewer, base, findings: [achado] }` →
     `verificarAchados({ root, config, env, collect, ordem, autor: '', provider: found_by,
     base, changed, scorecard: mini, outputPathFor, attempts: [] })` — ordena por
     gravidade, respeita `MAX_VERIFICACOES`, chama `aplicarVeredito`. `PLAUSIBLE` vira
     backlog (nunca some).
  4. Grava `.lms/bug-<id>.json` com o achado VERIFICADO + rota.

- [ ] **Step 1: Teste de integração que falha** (collect falso): sinal com stack trace →
  achado verificado (CONFIRMED permanece, PLAUSIBLE vira backlog); `LMS_VERIFY=0` recusa;
  sinal vazio → exit 2.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar** + bin/script.
- [ ] **Step 4: `pnpm test` verde; commit** — `feat(lms): triagem de bug passa pelo verificador da Fase 2`.

---

### Task 5: Bootstrap — `lms-triage-bug --init` (autônomo e `--guided`)

**Files:**

- Create: `scripts/lms-bug-bootstrap.mjs`
- Create: `scripts/lms-bug-bootstrap.test.mjs`

**Interfaces:**

- `export async function varrerRepo(root)` → topologia (dirs 1º/2º nível + manifests),
  `AGENTS.md`/`CLAUDE.md`, rotas/handlers, integrações de terceiro, fila/worker, banco,
  gates existentes, `git log --grep '^fix' --name-only -n 400`.
- `export function proporAgentes(varredura)` → ≥1 e ≤6 propostas, cada uma com MOTIVO
  ("worker fiscal: 32 commits `fix:` em …").
- `export function renderizarAgente(proposta)` → texto `.md` com frontmatter.
- `export async function runBootstrap({ root, env, guided, yes, pergunta })` — `pergunta`
  injetável (teste sem TTY); modo autônomo: escreve, imprime lista+motivo, UMA confirmação
  (`y/N`) no fim; guiado: perguntas com default inferido (resposta vazia = default).

- [ ] **Step 1: Testes que falham** (spec §4): repo fixture propõe ≥1 e ≤6 com motivo;
  `--guided` usa `pergunta` injetada e o default inferido com resposta vazia; nada é
  escrito sem confirmação; auto-init só com diretório vazio (diretório com agente que
  NÃO casou não dispara).
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: `pnpm test` verde; commit** — `feat(lms): bootstrap de agentes de triagem, autonomo e guiado`.

---

### Task 6: Roteamento por agente + adapter de rastreador

**Files:**

- Create: `scripts/lms-tracker.mjs` (`TRACKERS = ['none','github','linear']`,
  `corpoDaIssue(finding, agente)` — saneamento de `registrarPrecedente` (colapsar
  whitespace), `abrirIssue(tracker, finding, { env, exec })`)
- Modify: `scripts/lms-triage-bug.mjs` (passo de roteamento: `escalar_para` do agente
  vence quando declarado; senão `corrigivelPeloRevisor` decide como sempre)
- Create: `scripts/lms-tracker.test.mjs`

**Interfaces:**

- `none` (default): só `.lms/bug-<id>.json`; `github`: `gh issue create --title …
  --body-file <tmp> --label lms-bug`; `linear`: `curl` POST GraphQL, token em
  `LINEAR_API_KEY` (env, nunca na config). Binário ausente/token ausente/HTTP ≠ 2xx →
  avisa e segue (falha de ferramenta nunca decide).

- [ ] **Step 1: Testes que falham** (spec §4): `none` só grava arquivo; `github` monta o
  comando com body por arquivo; `linear` sem token avisa e segue; HTTP 500 avisa e
  segue; texto multilinha do modelo não vaza para o comando; `escalar_para` vence a
  regra da Fase 3 e, sem ele, `corrigivelPeloRevisor` decide.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: `pnpm test` verde; commit** — `feat(lms): roteamento por agente e adapter de rastreador, falha de ferramenta avisa e segue`.

---

### Task 7: Precedentes por agente

**Files:**

- Modify: `scripts/lms-precedentes.mjs` (`lerPrecedentes`/`registrarPrecedente` ganham
  `{ relativo = RELATIVO }`; `TETO_PRECEDENTES` e dedupe por `- **classe**` valem por arquivo)
- Modify: `scripts/lms-triage-bug.mjs` (triagem errada registra precedente em
  `.lms/precedentes-bug/<agente>.md`; `triagemPrompt` lê os do agente casado)
- Modify: `scripts/lms-precedentes.test.mjs`

**Interfaces:** nunca no `.lms/precedentes.md` global — memória de falso-positivo de diff
e de domínio não se misturam.

- [ ] **Step 1: Testes que falham** (spec §4): `relativo` alternativo isola precedentes
  por agente, com teto e dedupe por arquivo; o global continua intacto.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: `pnpm test` verde; commit** — `feat(lms): precedentes por agente em .lms/precedentes-bug`.

---

### Task 8: Golden set de bugs + `lms-eval --bugs`

**Files:**

- Create: `evals/bugs/<slug>/{sinal.txt,esperado.json}` × 3 + `evals/bugs/README.md`
  (mesma regra de anonimização de `evals/casos/README.md`)
- Modify: `scripts/lms-eval.mjs` — `carregarCasos(dir, { sub = 'casos', arquivo =
  'patch.diff', campo = 'patch' })` (o corpus de revisão não quebra); `compararTriagem(
  esperado, resultado)` nova (acerto de match de agente + acerto de localização
  path-sem-linha; `nao_deve` = análogo de `fp_conhecidos`); `main()` roteia `--bugs`
  para `runEvalBugs({ dir, env, collect })` (sem patch, sem repo temporário); pisos
  `LMS_EVAL_BUG_MATCH_MIN` (0.8) e `LMS_EVAL_BUG_PATH_MIN` (0.6); corpus de bugs vazio = erro.
- Create: `scripts/lms-eval.test.mjs` (acrescentar casos)

- [ ] **Step 1: Testes que falham** (spec §4): `carregarCasos` parametrizado não quebra o
  corpus de revisão; `--bugs` calcula match/path; `nao_deve` citado reprova; corpus de
  bugs vazio é erro.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: `pnpm test` verde; commit** — `feat(lms): golden set de bugs com lms-eval --bugs`.

---

### Task 9: Documentação e release notes

**Files:**

- Modify: `CHANGELOG.md` (`[Unreleased]` → 1.4.0)
- Modify: `README.md` (tabela de binários)
- Modify: `skills/local-merge-score/SKILL.md` (seção "Triagem de bug")
- Modify: `package.json` (bins conferidos no teste do pacote)

- [ ] **Step 1:** SKILL.md com o invariante: o agente influencia **onde olhar**, nunca o
  que o gate aceita; sinal → achado → verificador → rota/rastreador.
- [ ] **Step 2: `pnpm test` verde; commit** — `docs(lms): documenta a triagem de bug (1.4.0)`.

---

### Task 10 (extra — evidência KDT-68, lanes paradas "aguardando veredito"): veredito persistido e linha estável

**Evidência real:** duas lanes ficaram HORAS paradas "aguardando veredito" depois de a
cadeia já ter fechado — quem espera não tinha como saber se a cadeia terminou, nem com
qual desfecho.

**Files:**

- Modify: `scripts/lms-reviewer-fallback.mjs` (`runFallback` grava `.lms/veredito.json` no
  fim de QUALQUER desfecho: accepted/upheld, refuted, rejected, timeout, invalid-output —
  `{ estado, score, reviewer, refutador, subject, at }`)
- Modify: `scripts/lms-reviewer-trigger.sh` (exit distinto por estado e UMA linha final
  estável `LMS VEREDITO: <estado>`)
- Modify: `skills/local-merge-score/SKILL.md` (como esperar: `until [ -f .lms/veredito.json ]`)
- Modify: `scripts/lms-reviewer-fallback.test.mjs`, `scripts/lms-reviewer-trigger.test.mjs`

**Interfaces:**

- `export async function registrarVeredito(root, { estado, score, reviewer, refutador, subject })` →
  grava `.lms/veredito.json` (at incluso). Estados: `accepted`, `refuted`, `rejected`,
  `timeout`, `invalid-output`.
- `lms-trigger`: exit 0 accepted; 1 refuted/rejected/invalid-output; e UMA linha final
  `LMS VEREDITO: <estado>` em stderr, sempre (fail-closed: cadeia que morre sem gravar
  → estado `timeout` gravado pelo trigger ao propagar falha).

- [ ] **Step 1: Testes que falham** — cadeia aceita grava `accepted` com reviewer/refutador/
  subject; rodada derrubada grava `refuted`; timeout grava `timeout`; trigger imprime
  `LMS VEREDITO: accepted` como última linha e sai 0.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: `pnpm test` verde; commit** — `feat(lms): veredito persistido e linha estavel no trigger`.

---

## Fim da Fase 5

Ao terminar: o que chega de runtime entra no mesmo contrato do diff — sinal → achado →
verificador adversarial → rota (revisor/orquestrador) → rastreador opcional — com a
inteligência de domínio versionada no repo consumidor, bootstrap com uma confirmação e
régua de eval própria; e quem espera a cadeia tem `.lms/veredito.json` + uma linha
estável `LMS VEREDITO: <estado>` para esperar de verdade.
