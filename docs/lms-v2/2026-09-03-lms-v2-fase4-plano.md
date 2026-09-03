# LMS v2 — Fase 4: fechamento do laço fix → revisão — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar o laço fix → revisão sem rodada cheia quando o laço é estreito, transformar
classe repetida em achado estrutural, criar eval do próprio LMS e recusar rodada sobre
suíte vermelha.

**Architecture:** Quatro módulos novos (`lms-pre-rodada.mjs`, `lms-reverificar.mjs`,
`lms-classe-recorrente.mjs`, `lms-eval.mjs`) e mudanças pontuais em `lms-fix.mjs` (marco na
linha), `lms-reviewer-tmux.mjs` (prompt/candidato por chamador + `manterJanela`),
`lms-reviewer-fallback.mjs` (`logAttempt` persiste achados; sintético no `runFallback`),
`lms-fix-routing.mjs` (classe recorrente não é corrigível), `lms-config.mjs` (`testCommand`)
e `lms-reviewer-trigger.sh` (degrau de teste, exit 11).

**Tech Stack:** Node 22 ESM, `node --test`, `git` via `execFile`/`spawn`. Sem dependências novas.

**Spec:** `docs/lms-v2/2026-09-03-lms-v2-fase4.md`

## Global Constraints

- PNPM only (ADR-009). Zero dependências novas.
- Nenhum item afrouxa o gate: re-verificação só **fecha achado** (nunca mexe em
  `score`/`aggregate`/`coverage`, nunca emite `accepted`); verificador só **rebaixa**;
  achado estrutural só **acrescenta**.
- Fail-closed em todo caminho novo: id ausente/desconhecido na resposta = `open`;
  `closed` só vale após o verificador da Fase 2; `LMS_VERIFY=0` desliga a re-verificação
  inteira; falha de ferramenta no degrau de teste avisa e segue, vermelho recusa (exit 11).
- Ordem de dependência (spec §7): Task 1, 2, 5, 7 independentes; 3 ← 2; 4 ← 2,3; 6 ← 5; 8 ← 1-7.
- Comentários e commits em pt-BR. `pnpm test` verde antes de cada commit. Um commit por task.

---

### Task 1: Suíte verde como pré-condição de rodada (`lms-pre-rodada`)

**Files:**

- Create: `scripts/lms-pre-rodada.mjs`
- Create: `scripts/lms-pre-rodada.test.mjs`
- Modify: `scripts/lms-config.mjs` (`loadConfig` aceita `testCommand`, validado por `str`
  quando string; objeto `{ cmd, args }` normalizado)
- Modify: `lms.config.example.json` (documentar a chave)
- Modify: `scripts/lms-reviewer-trigger.sh` (bloco após a triagem)

**Interfaces:**

- Consumes: `loadConfig` (`lms-config.mjs`), `spawnEmGrupo`/`matarGrupo`
  (`lms-process-utils.mjs`).
- Produces:
  - `export function comandoDeTeste(config)` → `{ cmd, args } | null` (null = chave ausente)
  - `export async function runPreRodada({ root, env })` → `{ status: 'pulado'|'verde'|'vermelho'|'erro', saida }`
  - CLI: `node scripts/lms-pre-rodada.mjs` → exit 0 (pulado/verde/erro-de-ferramenta),
    exit 11 (vermelho), com as últimas 20 linhas no stderr quando vermelho.

- [ ] **Step 1: Testes que falham** — sem `testCommand` → `pulado` (exit 0); comando falho
  → `vermelho`; comando inexistente → `erro` mas tratado como "segue" (exit 0 com aviso);
  timeout mata o GRUPO (neto não sobrevive); `LMS_TEST_GATE=0` pula.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar** `comandoDeTeste` (string → `{ cmd, args: [] }`; objeto →
  normalizado; ausente/inválido → null) e `runPreRodada` com `spawnEmGrupo` + `matarGrupo`
  e timeout `LMS_TEST_TIMEOUT_MS` (default 10 min). Vermelho = exit != 0; timeout/ENOENT =
  `erro` (avisa, segue).
- [ ] **Step 4: Bloco no `lms-reviewer-trigger.sh`** depois da triagem: `LMS_TEST_GATE`
  (default 1), exit 11 encerra o trigger com stderr das últimas 20 linhas e **nenhum
  provider invocado**; falha de ferramenta avisa e segue.
- [ ] **Step 5: `pnpm test` verde; commit** — `feat(lms): suuite vermelha recusa a rodada antes de gastar cota`.

---

### Task 2: Sessão tmux reutilizável e marco do fix gravado

**Files:**

- Modify: `scripts/lms-reviewer-tmux.mjs` (`collectTmux` aceita `promptPath`, `outPath`,
  `manterJanela`)
- Modify: `scripts/lms-reviewer-fallback.mjs` (`collectTmux` default args preservados)
- Modify: `scripts/lms-fix.mjs` (`registrar` grava `marco`)
- Modify: `scripts/lms-reviewer-tmux.test.mjs`, `scripts/lms-fix.test.mjs`

**Interfaces:**

- `collectTmux({ root, provider, config, prompt, parse, promptPath, outPath, manterJanela })`:
  defaults = `.lms/review-prompt.md` e `.lms/candidates/<provider>.json` (comportamento de
  hoje preservado); `manterJanela: true` não chama `killWindow` no sucesso. Fallback: janela
  morreu → abre nova com prompt auto-contido (comportamento de hoje).
- `corrigirAchado`: linha de `.lms/fixes.jsonl` carrega `marco` (SHA/stash de `marcoDaArvore`).

- [ ] **Step 1: Testes que falham** — `lerCandidato`/poll usam o `outPath` do chamador
  (teste de unidade sobre os caminhos derivados); `manterJanela` não derruba a janela no
  sucesso; linha do fix contém `marco` igual ao SHA de `rev-parse HEAD`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar** (extração do par de caminhos para helper puro +
  `manterJanela` condicionando `killWindow`; `corrigirAchado` adiciona `marco` à linha).
- [ ] **Step 4: `pnpm test` verde; commit** — `feat(lms): janela tmux por chamador e marco do fix gravado`.

---

### Task 3: Re-verificação incremental — prompt, parse e aplicação pura (`lms-reverificar`)

**Files:**

- Create: `scripts/lms-reverificar.mjs`
- Create: `scripts/lms-reverificar.test.mjs`

**Interfaces:**

- `export function reverificarPrompt(findings, diff)` — pergunta estreita: *estes ids
  continuam abertos?* Contrato de saída: `{ results: [{ id, status: 'closed'|'open', why, evidence }] }`.
- `export function parseReverificacao(stdout, stderr)` — extrator sobre `candidatesFrom`
  com `aceita = v => 'results' in v`.
- `export function aplicarReverificacao(scorecard, results, verificados)` (pura) — fail-closed:
  id ausente/desconhecido na resposta = `open`; `closed` que o verificador derrubou volta
  `open`; NUNCA mexe em `score`/`p0/p1/p2`/`coverage`; só anota o achado
  (`reverificado: 'closed'|'open'`, `reverificado_por`).

- [ ] **Step 1: Testes que falham** (spec §4): `closed` não altera `score`/agregado;
  id ausente na resposta continua `open`; id desconhecido ignorado; `closed` derrubado pelo
  verificador volta a `open`; prompt lista ids, `acceptance` e proíbe re-review completo.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar** as três funções puras (sem I/O).
- [ ] **Step 4: `pnpm test` verde; commit** — `feat(lms): re-verificacao incremental do fix, fail-closed`.

---

### Task 4: Wiring da re-verificação com o verificador da Fase 2

**Files:**

- Modify: `scripts/lms-reverificar.mjs` (`runReverificacao`)
- Modify: `scripts/lms-fix.test.mjs` ou `scripts/lms-reverificar.test.mjs` (integração)
- Modify: `package.json` (bin `lms-reverificar`, script `lms:reverificar`)
- Modify: `scripts/lms-package.test.mjs` (bin listado)

**Interfaces:**

- `export async function runReverificacao({ root, env, collect })` →
  `{ status: 'recusada'|'ok', abertos, fechados }`:
  1. `LMS_VERIFY=0` → recusa inteira (mensagem e exit 0 sem ação).
  2. Lê `.lms/last.json` (achados CONFIRMED) e `.lms/fixes.jsonl` (última linha
     `fixed`/`claimed` com `marco`); sem marco → recusa.
  3. Diff do fix = `git diff --name-only <marco>` + untracked novos, limitado aos
     arquivos dos achados.
  4. `collect` com `reverificarPrompt` + `parseReverificacao`; `aplicarReverificacao`;
     achados `closed` passam pelo verificador da Fase 2 (`verificarAchados`-like, só
     rebaixa) — derrubado volta a `open`.
  5. Grava `.lms/reverificacao.json`. **Nunca** grava `.lms/last.json` nem emite `accepted`.

- [ ] **Step 1: Teste de integração que falha** (collect falso): fix reclamado com marco →
  re-verificação fecha achado que o verificador não derrubou; `LMS_VERIFY=0` recusa;
  achado sem resposta fica `open`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar** `runReverificacao` + bin/script.
- [ ] **Step 4: `pnpm test` verde; commit** — `feat(lms): runReverificacao fecha achado so com verificador e nunca publica`.

---

### Task 5: Histórico por rodada com achados + classe recorrente

**Files:**

- Modify: `scripts/lms-reviewer-fallback.mjs` (`logAttempt`/`attemptProvider` persistem
  `{ lens, path, id }` dos achados na linha de `.lms/history.jsonl`)
- Create: `scripts/lms-classe-recorrente.mjs`
- Create: `scripts/lms-classe-recorrente.test.mjs`

**Interfaces:**

- `export function classeDe(finding)` → `"<lens>:<prefixo>"` (prefixo = primeiros dois
  segmentos do path, ou o path inteiro se tiver menos).
- `export function classesReincidentes(historico, { janela = 3 } = {})` → classes presentes
  nas últimas `janela` rodadas CONSECUTIVAS (com os ids das ocorrências).
- `export function achadoEstrutural(classe, ocorrencias)` → achado sintético:
  `{ id: "classe:<lens>:<prefixo>", severity: "P1", lens, path: "<prefixo>/", title,
  found_by: "runner", acceptance: [<teste de classe>], recurrence: { rounds, ids } }`.

- [ ] **Step 1: Testes que falham** (spec §4): 3 rodadas mesma lens+prefixo → sintético;
  2 rodadas → nada; rodadas não consecutivas → nada; linha de histórico carrega achados.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: `pnpm test` verde; commit** — `feat(lms): classe repetida em 3 rodadas e historia por achado`.

---

### Task 6: Achado estrutural no `runFallback` e recusa do fix pontual

**Files:**

- Modify: `scripts/lms-reviewer-fallback.mjs` (`runFallback` injeta o sintético antes do
  estágio de verificação, quando `classesReincidentes` dispara sobre o histórico anterior)
- Modify: `scripts/lms-fix-routing.mjs` (`corrigivelPeloRevisor` recusa achado com
  `recurrence`: `{ ok: false, motivo: 'classe recorrente exige decisão de desenho' }`)
- Modify: `scripts/lms-scorecard.test.mjs` (`findingsShapeError` aceita o sintético)
- Modify: `scripts/lms-fix-routing.test.mjs`

**Interfaces:**

- Sintético entra em `attempt.scorecard.findings` (CONFIRMED → bloqueia como qualquer P1)
  e passa pelo estágio de verificação/contraditório como qualquer achado.
- `corrigivelPeloRevisor`: `finding.recurrence` presente → não é corrigível (cai em
  `escalados` no `runFix` modo `orchestrator`).
- `findingsShapeError`: achado com `recurrence` e `acceptance` (array) passa.

- [ ] **Step 1: Testes que falham** (spec §4): sintético com `id`/`recurrence` passa
  `findingsShapeError`; `corrigivelPeloRevisor` recusa; `runFallback` injeta o sintético
  quando o histórico tem classe reincidente (collect falso + `.lms/history.jsonl` fixture).
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: `pnpm test` verde; commit** — `feat(lms): classe recorrente vira achado estrutural que bloqueia e escala`.

---

### Task 7: Golden set de evals do próprio LMS (`lms-eval`)

**Files:**

- Create: `evals/casos/<slug>/patch.diff` × 3, `evals/casos/<slug>/esperado.json` × 3,
  `evals/casos/README.md` (proveniência + regras de anonimização)
- Create: `scripts/lms-eval.mjs`
- Create: `scripts/lms-eval.test.mjs`
- Modify: `package.json` (bin `lms-eval`, script `lms:eval`)

**Interfaces:**

- `export async function carregarCasos(dir)` → lista de casos; diretório sem casos = erro
  (nunca 100% de recall sobre corpus vazio).
- `export function compararAchados(esperado, obtidos)` → `{ recall_p1, taxa_fp, por_caso }`;
  casamento por `(lens, path)` + `id` quando o id for estável; título nunca é chave;
  `fp_conhecidos` que aparecerem contam FP.
- `export async function runEval({ dir, env, collect })` — aplica o `patch.diff` num repo
  temporário, roda o prompt de revisão via `collect`, compara. CLI `lms-eval` imprime
  `{ casos, recall_p1, taxa_fp, por_caso }` e exit 1 abaixo dos pisos
  (`LMS_EVAL_RECALL_MIN` default 0.8; `LMS_EVAL_FP_MAX` default 0.2).

- [ ] **Step 1: Testes que falham** (spec §4): recall/FP sobre corpus fixture; FP conhecido
  detectado reprova o caso; exit 1 abaixo do piso; corpus vazio é erro.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar** módulo + corpus anonimizado (3 casos: achado real de tenant,
  achado real de paridade/classe, falso-positivo conhecido de DoS).
- [ ] **Step 4: `pnpm test` verde; commit** — `feat(lms): golden set de evals com pisos de recall e falso-positivo`.

---

### Task 8: Documentação e release notes

**Files:**

- Modify: `CHANGELOG.md` (`[Unreleased]` → 1.3.0)
- Modify: `skills/local-merge-score/SKILL.md` (seções "Re-verificação", "Classe recorrente",
  "Pré-rodada")
- Modify: `lms.config.example.json` (se já não foi na Task 1)
- Modify: `scripts/lms-package.test.mjs` (versão 1.3.0)

- [ ] **Step 1:** SKILL.md com os três blocos (invariante de cada um: re-verificação nunca
  publica, sintético só acrescenta, pré-rodada é opcional por config).
- [ ] **Step 2: `pnpm test` verde; commit** — `docs(lms): documenta re-verificacao, classe recorrente e pre-rodada (1.3.0)`.

### Task 9 (extra — evidência KDT-68, LMS 1.2.0): Score coerente com a severidade

**Evidência real (2026-09-03):** o grok devolveu scorecard com `score: 4` e `p1: 5` e o
validador de FORMA aceitou — o runner queimou a cadeia inteira em vez de devolver o erro
nomeado para a retentativa.

**Files:**
- Modify: `scripts/lms-scorecard.mjs` (`scoreCoerenteError` no `firstError` de
  `scorecardFormError`, depois de `findingsShapeError`)
- Modify: `scripts/lms-scorecard.test.mjs`

**Regra:** achado CONFIRMED (ou sem `verdict`, que é CONFIRMED) pesa no score:
qualquer P0/P1 → `score <= 3`; só P2 → `score <= 4`. PLAUSIBLE (rebaixado pelo
verificador) não pesa — backlog não bloqueia nem pontua (preserva o F2-P1-3).
Mensagem nomeia `score` e o contador em aberto.

- [ ] **Step 1: Testes que falham** — score 4 + `p1: 5` (CONFIRMED) reprovado nomeando
  `p1`; score 5 + P2 CONFIRMED reprovado nomeando `p2`; score 3 + P1 CONFIRMED passa na
  forma; PLAUSIBLE não pesa.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar** `scoreCoerenteError`.
- [ ] **Step 4: `pnpm test` verde; commit** — `fix(lms): score incoerente com a severidade e reprovado na forma, nomeando o campo`.

---

## Fim da Fase 4

Ao terminar: o laço fix → re-verificação não gasta rodada cheia quando o fix é estreito
e o verificador independente não derruba o fechamento; classe repetida em 3 rodadas
bloqueia como P1 estrutural com `acceptance` de teste de classe; o próprio LMS tem
régua (`lms-eval`) com pisos de recall e falso-positivo; e rodada não nasce sobre suíte
vermelha (exit 11, sem provider).
