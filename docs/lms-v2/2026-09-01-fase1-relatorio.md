# Fase 1 — LMS v2 contrato do scorecard — relatório de fechamento

**Data:** 2026-09-01 · **Branch:** `feat/lms-v2-contrato` · **Plano:** `docs/lms-v2/2026-09-01-lms-v2-contrato.md`

## Tasks feitas

| Task | Commit | Conteúdo |
| --- | --- | --- |
| 1 | `69901fa` | Regra de tenant citava `hotel_id`, coluna inexistente → `tenantId`/`tenant_id` + teste de vocabulário. (Sessão anterior.) |
| 2 | `0458588` | Extração de `citationShapeError`/`citationsDiskError` de `lms-inspection.mjs`. (Sessão anterior.) |
| 3 | `95a5e97` | Campo `coverage` — denominador da varredura. (Sessão anterior.) |
| 4 | `ea168d8` | Campo `verified` — asserções positivas com citação conferida no disco. (Sessão anterior.) |
| 5 | `958acc7` | Lente inaplicável declarada com `applicable: false` + `na_reason`. (Sessão anterior.) |
| 6 | `cec8ad1` | Achado com `id` estável, `precondition` e `acceptance`. (Sessão anterior.) |
| 7 | `8c305a4` | Retentativa com erro de validação (`retryPrompt`, `maxTentativas = 2` em `attemptProvider`). (Completada nesta sessão.) |
| 8 | `e6f8734` | Schema publicado em `skills/local-merge-score/references/scorecard.schema.json`, sincronizado com o validador por teste; SKILL.md atualizado. (Feita nesta sessão.) |

## Task 7 — estado parcial encontrado e decisão

A máquina reiniciou no meio da Task 7. O diff não commitado já trazia `retryPrompt`, o
laço de retentativa em `attemptProvider` e os três testes novos do plano — mas estava
**quebrado**: o laço `for` nunca era fechado (erro de sintaxe `Unexpected token
'default'`/`'export'` ao carregar o módulo) e `scorecard`/`durationMs` eram `const`
dentro do laço, porém usados depois dele.

Decisão: **serviu como base, completado** em vez de refeito. Correções aplicadas:

1. Hoist de `scorecard` e `durationMs` para fora do laço (com `let`), `break` e fechamento do laço após a validação de forma passar.
2. Dois testes de cadeia antigos (`malformed output falls through…`, `a review that opened no files…`) passaram a refletir o comportamento novo: saída malformada ganha UMA retentativa por provider antes de cair para o próximo (log vira `claude, claude, grok, grok, codex, codex`). Reprovação legítima continua encerrando a cadeia na primeira tentativa — coberto por teste novo.

Desvio consciente do plano: o plano pedia registrar a retentativa em `logAttempt` com
`extra: 'retry'`; ficou `result='retry'` + `reason=<mensagem de validação>` no `extra`,
que cumpre o objetivo (`.lms/fallback.log` mostra a segunda chance e o motivo) com uma
linha só de log.

## Task 8 — nota de migração aplicada

- `.agents/skills/local-merge-score/` **não existe neste repositório** → usado `skills/local-merge-score/` (mapeamento da nota de migração). O teste referencia o caminho real.
- **`pnpm dox-check` foi pulado**: o script não existe neste pacote (era do `karibu-erp`). Nada aqui depende dele.

## Passos pulados e por quê

- `pnpm dox-check` (Task 8, Step 6) — script inexistente neste repositório.
- Nada mais. Todos os demais passos executados na ordem do plano, TDD (teste falhou primeiro em ambas as tasks).

## Resultado final de `pnpm test`

```text
ℹ tests 118
ℹ pass 118
ℹ fail 0
```

(Suíte completa: `node --test scripts/*.test.mjs` + testes shell do push-changed e do gate.)

## Dúvidas para o Master

1. **Log de retentativa:** manter `result=retry` + motivo no `extra` (atual) ou voltar ao literal do plano (`result=invalid-output`, `extra=retry`)? O primeiro é mais legível no `fallback.log`; consumidores do `history.jsonl` que filtram `resultado` verão um valor novo.
2. **Custo de cota:** com a retentativa, um provider com JSON malformado custa até 2 invocações antes de cair para o próximo. A cadeia de 3 providers pode chegar a 6 chamadas no pior caso (só quando os três emitem lixo de forma). Aceitável?
3. Fases 2 (veredito) e 3 (fix mode) podem começar em paralelo, conforme o plano.
