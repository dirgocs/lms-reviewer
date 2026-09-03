# Fix review — Fase 3 (fix mode) — leva final

**Data:** 2026-09-02 · **Branch:** `feat/lms-v2-contrato` · **Range revisado:** `f870739..c3feb6a`
**Fonte:** `.lms/reports/REVIEW-FASE3-OPUS.md` (4 P1, 8 P2, 4 P3)
**Os 5 P1 das revisões anteriores foram reproduzidos e confirmados FECHADOS** pelo revisor (Parte 1 do relatório).
**Suíte no fim da leva:** `pnpm test` → 211/211 verde. Lint sintático: `node --check` em todo `scripts/*.mjs` e `hooks/*.mjs`, `bash -n` em todo `*.sh` — OK.

## P1

| Achado | Desfecho | Commit |
| --- | --- | --- |
| P1-1 `corrigirAchado` chamava collect sem `parse` — relato nunca lido, prova era código morto, todo fix virava `claimed` | **Corrigido** — `parseRelato` (extrator próprio com `aceita = v => 'outcome' in v` sobre a varredura `candidatesFrom`, agora exportada) entra no collect; teste de integração com `collectHeadless` DE VERDADE: fake provider escreve o arquivo, emite relato com `proof`, a prova roda pela allowlist e o desfecho é `fixed`. | `ceaabbc` |
| P1-2 guarda de escopo cega a arquivo NOVO (`git diff` não lista untracked, nem destino de rename) | **Corrigido** — `naoRastreados(root)` (`ls-files --others --exclude-standard`) com snapshot antes/depois: só untracked NOVOS contam (trabalho não rastreado pre-existente do Master não vira violação e não é apagado). Teste com git real: untracked fora do escopo → `rejected-scope` + arquivo removido. | `0f68f02` |
| P1-3 `.lms/` é gitignored — a denylist era inerte no ponto de aplicação | **Corrigido** — `capturarGate`/`gateTocado`/`restaurarGate`: listagem de CONTEÚDO de `.lms/**` antes/depois do fix; qualquer mudança (arquivo novo, alterado ou sumido) é violação, o `.lms/` é restaurado ao snapshot e o fix revertido. Teste: provider sobrescreve `precedentes.md` e cria `fora.md` → rejeitado, conteúdo original restaurado, injetado removido. | `0f68f02` |
| P1-4 `verificarProva` continuava no `execFile` — matava só o `sh`; `spawnEmGrupo` nunca usado em produção | **Corrigido** — `verificarProva` usa `spawnEmGrupo` + `matarGrupo` no timeout (`LMS_PROVA_TIMEOUT_MS` configurável, default 10 min). Teste no caminho público: prova que cria neto no mesmo grupo → timeout → neto morto (sentinela nunca escrita). | `f4bb89e` |

## P2

| Achado | Desfecho | Commit |
| --- | --- | --- |
| P2-1 fallback do marco era a ref `'HEAD'`, que se move com um commit do próprio fix | **Corrigido** — `marcoDaArvore` (exportado) cai para `rev-parse HEAD` (SHA imutável). Teste: marco === SHA, ≠ string `'HEAD'`. | `25cb79e` |
| P2-2 exclusão de autoria permanente por arquivo (`.lms/fixes.jsonl` sem escopo temporal) | **Corrigido** — linhas do fix carregam `commit` (HEAD do momento) e `autoresPorArquivo(root, commitAtual)` só considera autoria do HEAD atual: fix mergeado expira; exclusão vale enquanto o fix estiver na árvore. Testes: outro HEAD não exclui; mesmo HEAD exclui. | `9d534e2` |
| P2-3 `no_change_needed` inalcançável (guarda o convertia em `rejected-scope`) | **Corrigido** — lista vazia só é violação quando o provider ALEGOU ter corrigido; declarou nada e não mudou nada = desfecho `no_change_needed`. Declarou nada e MEXEU → segue sujeito à guarda (teste cobre os dois lados). | `25cb79e` |
| P2-4 denylist cobria metade do mapeamento documentado | **Corrigido** — somados `.agents/skills/local-merge-score/`, `.claude/skills/local-merge-score/` e `node_modules/@dirgocs/lms-reviewer/`. Teste cobre os três + roteamento. | `f81b262` |
| P2-5 no tmux o verificador imprimia em vez de gravar — estágio virava timeout | **Corrigido** — `verificarPrompt(finding, base, changed, outputPath)` com o mesmo bloco "Write EXACTLY ONE JSON object to `<path>`" dos outros prompts; `verificarAchados` repassa `outputPathFor(verificador)`. Teste: com `outputPath` instrui gravação; sem, preserva "output". | `862572a` |
| P2-6 serialização multiplicou o pior caso sem teto próprio | **Corrigido** — orçamento do estágio (`LMS_VERIFY_BUDGET_MS`, default 10 min): estourou, os achados restantes saem CONFIRMED com `verdict_why` de teto (mesmo tratamento do excedente de `MAX_VERIFICACOES`). Teste com orçamento de 20 ms e verificações de 60 ms. | `4e850d7` |
| P2-7 `detached` tirou os CLIs do grupo do terminal — Ctrl+C/morte do pai orfana o revisor | **Corrigido** — `vigarFilho`/`matarFilhosRegistados` em `lms-process-utils`; `runCommand` registra cada filho; `runFallback` instala handlers `SIGINT`/`SIGTERM` que derrubam os vivos e saem (130/143). Teste: filho teimoso registrado morre no purge. | `363e66c` |
| P2-8 `runFix` mandava todo achado para `scorecard.reviewer`, inclusive os do refutador | **Corrigido** — `applyRefutation` carimba `found_by` no achado (e extras); `runFix` usa `finding.found_by ?? scorecard.reviewer`. Teste: achado com `found_by: 'codex'` → o conserto vai para o codex. | `0b3ce1e` |

## P3 (a critério)

| Achado | Desfecho | Commit |
| --- | --- | --- |
| P3-1 `lms-fix` fora do `bin` — consumidor não consegue invocar | **Corrigido** — `bin['lms-fix']` + `chmod +x`; teste do pacote atualizado para v1.2.0 com a lista completa de bins. | `dc94993` |
| P3-2 porta de saída na checagem de id (`finding.id === undefined` desligava a defesa do F2-P1-2) | **Corrigido** — sem porta de saída: veredito sem id é divergência → CONFIRMED. | `dc94993` |
| P3-3 `stampScorecard` aceitava id do modelo | **Corrigido** — `id: findingId(finding)` SEMPRE; o modelo não inventa identidade. Testes dos fixtures ajustados para derivar os ids esperados (`findingId`) ou assertar por título. | `dc94993` (`1d5a64b` para os testes) |
| P3-4 `reverter` não limpava dentro de gitignored | **Corrigido** — `git clean -f -x --` na reversão, no mesmo commit do P1-2. | `0f68f02` |

## Nota sobre estilo

Durante esta leva o formatter automático da IDE converteu três arquivos da leva
(`lms-fix-escopo.mjs`, `lms-fix.mjs`, `lms-fix.test.mjs`) para aspas duplas após cada
gravação, fora do controle do agente. O conteúdo funcional foi preservado e verificado
(suíte 211/211 + lint sintático); a normalização de estilo (aspas simples) deve ser
feita como commit mecânico único em seguida, sem misturar com mudanças de comportamento.

## Suíte final e lint

```text
ℹ tests 211
ℹ pass 211
ℹ fail 0
LINT_OK (node --check scripts/*.mjs hooks/*.mjs; bash -n scripts/*.sh hooks/*.sh)
```
