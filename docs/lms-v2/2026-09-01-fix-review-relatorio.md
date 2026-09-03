# Fix review — Fases 1 e 2 (revisões independentes Opus 5)

**Data:** 2026-09-02 · **Branch:** `feat/lms-v2-contrato`
**Fontes:** `.lms/reports/REVIEW-FASE1-OPUS.md` (2 P1, 5 P2, 7 P3) · `.lms/reports/REVIEW-FASE2-OPUS.md` (3 P1, 5 P2, 4 P3)
**Suíte no fim da correção:** `pnpm test` → 166/166 verde.

## Achados da REVIEW-FASE1-OPUS.md

| Achado | Desfecho | Commit / evidência |
| --- | --- | --- |
| P1-1 contadores ↔ `findings` nunca reconciliados; gate aprova P0 listado com agregado zerado | **Corrigido** — o conserto havia aterrissado em `fb4f6ba` (posterior ao range revisado `1e363ae`): `verdictFindingsError` passou a julgar a LISTA — qualquer achado `(verdict ?? CONFIRMED) === CONFIRMED` bloqueia, com a lista nomeada na mensagem. Cenário exato da revisão reproduzido por probe: `scorecardError` agora devolve `1 confirmed finding(s) remain: rce`. Teste de regressão trava o cenário. | `829e329` |
| P1-2 `verified` fabricado: runner não conferia no disco; retentativa desperdiçada; aceite do runner mais fraco que o do gate | **Corrigido** — `verifiedDiskError` entra na cadeia do `formError` do `attemptProvider`; erro de citação entra no laço de retentativa. Dois testes do tmux quebraram ao ser corrigido — seus fixtures tinham citação `verified` fabricada (`alvo7` vs `alvo9` real; `src/um.ts` em root sem o arquivo): evidência de que o furo era real e o teste dependia dele. | `fffa52f` |
| P2-1 exemplo do SKILL.md violava o piso de 3 `inspected` distintas | **Corrigido** — três entradas realistas restauradas (o exemplo do schema, que só alimenta o teste, segue mínimo, como a revisão permite). | `f761c49` |
| P2-2 teste de sincronia schema↔validador não testava sincronia | **Corrigido** — teste novo confere as restrições-chave do schema contra o que o validador aplica (claim minLength 20, minItems 1, `fallow` required, `dependentRequired` applicable/na_reason, minLength de surface/na_reason, lentes extras permitidas). A afirmação do SKILL.md foi rebaixada para o que o teste sustenta ("o exemplo passa no validador e as restrições-chave são conferidas"). Zero deps novas — nenhum ajv; o teste de estrutura + o teste do exemplo cobrem os pontos onde já divergiu. | `bddae5a` |
| P2-3 divergências concretas schema ↔ validador (a–g) | **Corrigido** — `$defs/citation` separado de `$defs/verified` (claim ≥ 20 obrigatório só em verified), `minItems: 1`, `fallow` em `required`, `dependentRequired` applicable/na_reason, `minLength` de `na_reason` (15) e `surface` (3), `additionalProperties: false` removido das lentes. Mesmo commit do P2-2. | `bddae5a` |
| P2-4 `coverage` satisfeito por esforço zero e não cruzado com o diff | **Corrigido** — `coverageError` exige ao menos uma entrada com `total >= 1 && inspected >= 1`; e `coverageDiffError` (exportada) é chamada no CLI: exige uma superfície cujo `total` cubra os arquivos abríveis do diff. Testes nos dois níveis. | `b61778c` |
| P2-5 `id` estável fora da fila P2; `chaveDoAchado` discordava de `findingId` | **Corrigido** — fila grava `id: achado.id ?? findingId(achado)`; `chaveDoAchado` virou `findingId` (ignora linha). Clamp no `neutralizarP2` (P3-5) emendado no mesmo commit. | `f207965` |
| P3-1 wrapper de `retryPrompt` aninhado | **Corrigido** + teste (`maxTentativas: 3`, prompt com 1 `VALIDATION ERROR` e 1 `ORIGINAL INSTRUCTIONS`). | `62a2ae7` |
| P3-2 score sem teto | **Corrigido** (score 0–5, mantendo `score >= target` no veredito). Teste. | `e84c50d` |
| P3-3 `applicable` não-booleano | **Corrigido** — não-booleano (exceto ausente/`true`/`false`) é reprovado. Teste. | `e84c50d` |
| P3-4 `lens` não exigida mas hasheada | **Corrigido** — `findingsShapeError` exige `lens ∈ LENSES`. Teste. | `e84c50d` |
| P3-5 `neutralizarP2` pode negativar lente/agregado | **Corrigido** — clamp em 0 no `p2` da lente e do agregado. Sem teste dedicado (caminho privado; justificado: trivial e a fila P2 já tem 10 testes de fluxo). | `e84c50d` |
| P3-6 guarda de vocabulário lista fixa | **Corrigido** — varre `skills/**/*.md` + `hooks/*.sh` por glob. | `a4e8863` |
| P3-7 `maxTentativas < 1` estoura | **Corrigido** — piso de 1 no número de tentativas. Sem teste dedicado (uma linha, coberto pelo laço existente). | `62a2ae7` |

## Achados de REVIEW-FASE2-OPUS.md

| Achado | Desfecho | Commit / evidência |
| --- | --- | --- |
| P1-1 precedente alimentado com defeito REAL (refutação vencedora = classe suprimida) | **Corrigido** — registro removido de `contestar`; só o verificador registra, em `FALSE_POSITIVE` + prova `confirmada`. Testes: refutação vencedora NÃO grava `.lms/precedentes.md`; verificador com prova grava. | `7f58124` |
| P1-2 verificações paralelas sobre um prompt/arquivo; vereditos cruzados | **Corrigido** — laço sequencial (`for...of`) em `verificarAchados`; `aplicarVeredito` falha fechado quando `veredito.id !== finding.id` (ou id ausente). Testes: módulo (id outro/sem id/id certo) + integração (veredito do P0 não rebaixa o P2). | `7f58124` |
| P1-3 `verdict` acreditado sem procedência | **Corrigido** — `verdictFindingsError` só honra não-CONFIRMED quando `verdict_by` é string não-vazia ≠ `value.reviewer`; sem procedência, conta como CONFIRMED e bloqueia. Testes: sem `verdict_by`, `verdict_by` igual ao revisor, e com verificador independente. | `8f37f7c` |
| P2-1 effort do refutador herdava o raio / feature no-op com env | **Corrigido** — `providerConfig` separa `effort` (revisor) de `claudeEffort` (`LMS_CLAUDE_EFFORT`, medium do Master); `commandFor` decide pelo papel (`reviewer`/`refutador`/`verificador` carimbado nas chamadas de collect). Teste prova: revisor xhigh, refutador medium, refutador nunca herda xhigh. | `4008102` |
| P2-2 triagem = cópia permissiva da regra de isenção | **Corrigido** — `precisaRevisao` usa `isExempt(paths, loadConfig(root))` (`INERTES` deletada); `SEMPRE_REVISAR` mantida por cima. Testes: `logo.svg` revisado (deadlock morto) e `nonExemptPaths` respeitado. | `a7c5471` |
| P2-3 `registrarPrecedente` suja a árvore e invalida o subject | **Já corrigido** pela resposta do Master à dúvida nº 2 do relatório da Fase 2 (commit `4d69978`, posterior ao range revisado `f870739`): o corpus passou a morar em `.lms/precedentes.md`, gitignored, e `reviewSubject` lista não-rastreados com `ls-files --others --exclude-standard` (`scripts/lms-subject.mjs:68`), que **exclui** gitignored — a árvore visível ao subject não muda. Nenhum código novo necessário. | `4d69978` |
| P2-4 verificador escolhido com `attempts: []` — histórico de falha jogado fora | **Corrigido** no mesmo commit do P1-1/P1-2 — `runFallback` encaminha o `attempts` real; provider que nem rodou na rodada não verifica. Coberto pela suíte de cadeia (o verificador deixa de receber um provider que falhou). | `7f58124` |
| P2-5 texto de modelo verbatim no corpus; dedupe por substring | **Corrigido** — `\s+ → ' '` em classe/motivo; dedupe casa `startsWith('- **${classe}**')`. Testes: injeção por quebra de linha não sobrevive; substring curta não bloqueia classe distinta. | `b0d8b71` |
| P3-1 teto aplicado só na leitura / dedupe só vê as 40 | **Corrigido** no mesmo commit do P2-5 — dedupe lê o arquivo inteiro; teto aplicado só na escrita. | `b0d8b71` |
| P3-2 `parseVeredito` morto no caminho tmux (`collectTmux` ignora `parse`) | **Pulado** — justificativa: o estágio falha fechado no tmux (sem `verdict` → CONFIRMED, achado continua bloqueando); plugar `parse` no coletor tmux mexe na suíte do runner de TUI e no fluxo de arquivo de candidato, e é mudança de infraestrutura de coleta, não de regra. Sugerido para a Fase 3/lane de infra. | — |
| P3-3 sem teto de tempo para o estágio; timeout não mata grupo de processos | **Pulado** — justificado: a rodada inteira já é limitada por `LMS_TMUX_TIMEOUT_SEC`; matar grupo de processos (`detached` + `process.kill(-pid)`) é mudança de infra do `lms-process-utils`, decisão do Master. | — |
| P3-4 cobertura de teste da Fase 2 | **Parcial** — nesta leva entraram: teste de integração do verificador no `runFallback` (Fase 2, `6eee3ae`), testes de retentativa/serial/id/procedência/precedente (`7f58124`, `8f37f7c`) e o contrato do CLI da triagem exit-10 (`71f6f46`). O que falta: teste do wiring no `.sh` para o exit 10 (o contrato do CLI está testado; o `set +e` do shell não). | — |

## Nota sobre o corpus

A resposta do Master à dúvida nº 2 da Fase 2 moveu o corpus para `.lms/precedentes.md`
(gitignored, estado de runtime; commit `4d69978`). O arquivo semeado em
`skills/local-merge-score/references/` foi removido — as 11 classes de política da
auditoria não estão mais versionadas no pacote; quem quiser o corpus inicial escreve o
arquivo no checkout consumidor. `lerPrecedentes` devolve `[]` quando ele não existe.

## Suíte final

```text
ℹ tests 166
ℹ pass 166
ℹ fail 0
```

## Dúvidas para o Master

1. **P3-2 (tmux ignora `parse`)**: o verificador no modo tmux hoje sai CONFIRMED sem verificação real (falha fechada, mas o log diz "verificado"). Querer plugar `parse` no `collectTmux` na Fase 3 ou registro no backlog basta?
2. **P3-3 (timeout do grupo)**: `verificarProva` usa `execFile` com timeout que mata o shell, não o grupo. Matar grupo exige mudança em `lms-process-utils` — quer aqui ou deixa para a lane de infra?
