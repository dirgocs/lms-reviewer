# Fix review — Fase 4 (re-verificação, classe recorrente, evals, pré-rodada)

**Data:** 2026-09-03 · **Branch:** `feat/lms-v2-fase4` · **Range revisado:** `master..770eca8`
**Fonte:** `.lms/reports/REVIEW-FASE4-OPUS.md` (2 P1, 6 P2, 5 P3)
**Suíte no fim da leva:** `pnpm test` → 263/263 verde. Lint sintático: `node --check` em `scripts/*.mjs`, `hooks/*.mjs`, `evals/*.mjs`; `bash -n` em `*.sh` — OK.

## P1

| Achado | Desfecho | Commit |
| --- | --- | --- |
| P1-1 `collectTmux` explodia com `relPrompt` indefinido — modo tmux (produção) não rodava nenhuma revisão | **Corrigido** — `relPrompt = relativoAoRoot(promptPath, root)` junto do `relOut`; teste de integração com tmux FALSO no PATH reproduz o `ReferenceError` antes e o `kind: 'ok'` depois. Costuras lazy (`BOOT_MS`/`POLL_MS`/`TIMEOUT_MS` lidas no uso) para o teste rodar em ~1s sem 15 min de teto. | `b752adc` |
| P1-2 rodada limpa não quebra a série da classe recorrente — deadlock permanente (a saída da spec era inalcançável) | **Corrigido** — `historicoDeRodadas` passa a incluir rodada com `achados: []` (a rodada limpa entra na janela e quebra a série). Teste: 3 rodadas da classe + 2 limpas → zero reincidentes. | `ce7aaf8` |

## P2

| Achado | Desfecho | Commit |
| --- | --- | --- |
| P2-1 recorrência ignorava `subject` — rodadas de outra branch contavam | **Corrigido** — `historicoDeRodadas(root, subject)` filtra por `registro.subject`; `runFallback` repassa `rodada.subject`. Teste: rodada de outro subject não conta. | `ce7aaf8` |
| P2-2 `testCommand` string com argumento nunca rodava (`spawn` sem shell → ENOENT "de ferramenta" → degrau desligado em silêncio) | **Corrigido** — string quebra em `cmd`+`args` com aspas removidas por token; o normalizador do `lms.config.json` é a única fonte (`comandoDeTeste` delega). Testes: unitário + CLI com string produzindo exit 11. | `4b437ca` |
| P2-3 marco da ÚLTIMA linha recortava o diff do lote — fixes anteriores somiam da re-verificação | **Corrigido** — `loteDeFix(linhas, consumidas)`: marco da PRIMEIRA linha do lote, união de arquivos, `linhasConsumidas` gravado em `.lms/reverificacao.json`; segunda chamada sem fix novo recusa. `claimed`/`rejected` sem arquivos recusam (diff sem pathspec devolveria a árvore inteira). Testes unitário + de consumo. | `94821ca` |
| P2-4 `runFix` não imprimia o comando de re-verificação | **Corrigido** — ao fim, `console.error` com `pnpm lms:reverificar # ids: …` quando há aplicados. Teste captura o stderr. | `acd65dd` |
| P2-5 `manterJanela` era código morto; bin rodava sempre headless | **Corrigido** — `coletaDaReverificacao(env)` escolhe tmux (default) vs headless (`LMS_REVIEWER_MODE`); `runReverificacao` passa `manterJanela: true` e caminhos próprios; `verificarAchados` repassa o flag. Teste: collect vê `manterJanela`/`promptPath`/`outPath`; `coletaDaReverificacao` respeita o modo. | `d64f1d6` |
| P2-6 `closed` não removia nada da lista bloqueante — a re-verificação não servia para nada | **Corrigido** — o gate cruza `last.json` × `reverificacao.json` pelo subject: achado em `fechados` recebe `reverificado: 'closed'` e sai de `verdictFindingsError` e de `scoreCoerenteError` (score/agregado intocados). Subject diferente não cruza. Teste de integração com o CLI: bloqueia sem re-verificação, passa com `closed` mesmo subject, volta a bloquear com subject divergente. | `253ab5f` |
| P2-7 um único `found_by` re-verificava achados de todos os revisores | **Corrigido** — alvos agrupados por `found_by`; um collect por grupo com os ids do próprio grupo; verificação idem. Teste: dois grupos → dois collects, cada prompt só com os ids do grupo, providers `codex`/`grok`. | `b64c2bf` |

## P3 (a critério — todos corrigidos, baratos)

| Achado | Desfecho | Commit |
| --- | --- | --- |
| P3-1 recall casava achado de qualquer severidade | **Corrigido** — só `severity === 'P1'` conta para o recall; teste: P3 de estilo no mesmo arquivo/lente não conta. | `3ba728b` |
| P3-2 repos temporários de eval acumulavam em /tmp | **Corrigido** — `rm` no fim de cada caso. | `3ba728b` |
| P3-3 saída da pré-rodada sem teto de memória | **Corrigido** — anel de ~200 linhas (o exit 11 imprime só a cauda). | `3ba728b` |
| P3-4 `por_caso` interno de um elemento que ninguém usava | **Corrigido** — removido do retorno puro (`runEval` monta o seu com slug). | `3ba728b` |
| P3-5 `taxa_fp` diluída pelo total reportado | **Corrigido** — denominador = `fp_conhecidos` do corpus. Teste: 1 de 1 → 1.0 (antes 0.5 e passava). | `3ba728b` |

## Resultado final

```text
ℹ tests 263
ℹ pass 263
ℹ fail 0
LINT_OK (node --check scripts/*.mjs hooks/*.mjs evals/*.mjs; bash -n *.sh)
```
