# Fase 3 — LMS v2 fix mode — relatório de fechamento

**Data:** 2026-09-02 · **Branch:** `feat/lms-v2-contrato` · **Plano:** `docs/lms-v2/2026-09-01-lms-v2-fix-mode.md`
**Inclui as duas tasks extras** decididas pelo Master na leva de correção (P3-2 e P3-3 de REVIEW-FASE2-OPUS.md).

## Tasks feitas

| Task | Commit | Conteúdo |
| --- | --- | --- |
| 1 | `2a60eb6` | Roteamento (`lms-fix-routing.mjs`): `caminhoProibido` (denylist do gate: `.lms/`, `hooks/`, `scripts/lms-*`, db-exposure, skills do LMS, `.git/`, `.husky/`), `corrigivelPeloRevisor` (caminho de risco e fix-que-pede-decisão vão para o orquestrador), `arquivosDoAchado` (lista de caminhos, linha removida). |
| 2 | `c3ddd7c` | Guarda de escopo (`lms-fix-escopo.mjs`): `escopoViolado` (proibido > nada alterado > fora da lista), `arquivosAlterados` (desde `git stash create`), `reverter` (`checkout --` + `clean -f`, nunca `reset --hard`). |
| 3 | `8191f36` | Sandbox de escrita: `commandFor(provider, config, { modo })` — fix dá `acceptEdits` + `Edit,Write` no claude/grok (sem `Bash`) e `workspace-write` no codex (nunca acesso total); `collectHeadless` ganha `modo` com default `review`. |
| 4 | `ea44457` | Runner do fix (`lms-fix.mjs`): `fixPrompt` (arquivos permitidos, proibição de re-review/scorecard, acceptance criteria), `corrigirAchado` (roteamento → marco `git stash create` → collect em modo fix → guarda de escopo ANTES de acreditar o provider → prova opcional pela MESMA allowlist), `runFix` (`LMS_FIX_MODE=off | reviewer | orchestrator`, alvos = achados CONFIRMED, em série), log em`.lms/fixes.jsonl`,`verificarProva` exportada. CLI com `pnpm lms:fix` e falha fechada em scorecard ausente/corrompido. Testes de integração com git real: fix no escopo → `claimed`; vizinho → revertido INTEIRO; nada mudado → recusado; caminho de risco nem invoca o provider. |
| Extra (P3-3) | `c0bb07c` | `lms-process-utils` ganha `spawnEmGrupo` (detached) e `matarGrupo` (`process.kill(-pid)` com fallback ESRCH/Windows). `runCommand` e o `verificarProva` do runner matam a árvore inteira no timeout. Teste discrimina: neto orfão de `sh -c 'sleep 1 && touch … &'` não sobrevive mais ao kill do pai. |
| Extra B (P3-2) | `f9ad503` | `collectTmux` aceita `parse` do chamador (`lerCandidato(texto, parse)`, exportado e testado): o verificador por achado no modo tmux (caminho principal de produção) extrai o veredito com o parser próprio em vez de sair CONFIRMED sem verificar; scorecard antigo no arquivo do candidato não é veredito (poll continua, falha fechada). |
| 5 | `84e9741` | Autoria por arquivo (`lms-fix-autoria.mjs`): `autoresPorArquivo` lê `.lms/fixes.jsonl` (só `fixed`/`claimed` persistem); `runFallback` exclui da RODADA quem escreveu arquivo do diff — o provider não é mais excluído da cadeia inteira. |
| 6 | `108f9ce` | SKILL.md: seção "Fix mode" (invariante do subject, tabela de env, duas invocações, roteamento, denylist, reversão inteira, `fixed` ≠ `claimed`, autoria por arquivo). Caminhos mapeados: `hooks/` e `skills/local-merge-score/`. |

## Passos pulados e por quê

- **`pnpm dox-check` (Task 6):** script não existe neste pacote (era do `karibu-erp`).
- **Registro de testes em `package.json` (`test:lms`):** o script `test` usa glob `scripts/*.test.mjs` — os 5 testes novos são registrados automaticamente. Só o `lms:fix` precisou ser acrescentado ao `package.json` (Task 4).
- **Task 1, constante `CAMINHOS_DE_RISCO`:** Fase 2 já exportava de `lms-effort.mjs` — sem cópia local.

## Resultado final de `pnpm test`

```text
ℹ tests 196
ℹ pass 196
ℹ fail 0
```

## Dúvidas para o Master

1. **`orchestrator` só lista** — o roteamento imprime a lista e sai; não há ainda um chamador que consuma `escalados` para criar tarefas. É o desenho (o Master decide olhando a lista) ou quer uma fila própria?
2. **Fixes enfileirados contra `subject` antigo:** o fix toca o disco e invalida o scorecard — a rodada de re-revisão é manual (rrodar a cadeia de novo) por desenho. Automatizar o re-trigger após `lms:fix` bem-sucedido é Fase 4 ou fica como está?
3. **P3-4 da Fase 2 (wiring do exit 10 no `.sh`)** — continua pendente do fix-review (o contrato do CLI está testado; o shell não). Quer que eu cubra na próxima leva?
