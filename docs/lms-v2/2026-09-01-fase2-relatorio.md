# Fase 2 — LMS v2 qualidade do veredito — relatório de fechamento

**Data:** 2026-09-01 · **Branch:** `feat/lms-v2-contrato` · **Plano:** `docs/lms-v2/2026-09-01-lms-v2-veredito.md`

## Tasks feitas

| Task | Commit | Conteúdo |
| --- | --- | --- |
| 1 | `34ca8db` | Triagem determinística (`scripts/lms-triage.mjs`): diff sem caminho de execução dispensa a cadeia (exit 10); ligada no `lms-reviewer-trigger.sh` depois de `BASE_REF` (resolvido antes do bloco, como o plano pedia verificar). `LMS_TRIAGE=0` desliga. |
| 2 | `ca38d84` | Effort derivado do raio (`scripts/lms-effort.mjs`): `xhigh` em auth/tenant/fiscal/migrations/signer/webhook/`/pos/`, `high` no resto; `LMS_EFFORT` sobrescreve. Só o revisor Claude sobe; grok fica em `medium` e codex inalterado. |
| 3 | `c0fe757` | Corpus de precedentes (`scripts/lms-precedentes.mjs` + `skills/local-merge-score/references/precedentes.md` semeadas com 11 classes): injetado no `reviewPrompt`; refutação vencedora registra a classe (registro em `contestar`, onde `derrubouEfetivo` e `veredito` já estão resolvidos, em vez de dentro do `applyRefutation` puro/síncrono). |
| 4 | `fb4f6ba` | Verificação adversarial por achado (`scripts/lms-verificar-achado.mjs`): estágio novo em `runFallback` antes do contraditório; `verdictFindingsError` respeita `verdict` (achado `PLAUSIBLE` não bloqueia, sem `verdict` conta como `CONFIRMED`); `collectHeadless` aceita `outputPath` e o ignora. |

## Desvios do plano (com motivo)

1. **Task 2, regex de risco:** o teste do plano espera `services/api/src/pos/actor.ts` → `xhigh`, mas a regex do plano não casa com `pos` (ponto de venda = domínio de pagamento). O teste é a spec: acrescentado o segmento exato `/pos/` à `CAMINHOS_DE_RISCO` (em vez de `pos` solto, que casaria com "compose", "position", etc.).
2. **Task 2, ramo do codex:** o plano manda mapear `xhigh`→`high` no codex ("não expõe xhigh"), mas o código atual usa `codexEffort` com default `xhigh` — diretriz Master 2026-08-27, mais nova que o plano. Codex ficou intacto.
3. **Task 3, registro do precedente:** o plano pedia registrar dentro de `applyRefutation` (e torná-la async). `applyRefutation` é pura e síncrona; o registro ficou em `contestar`, imediatamente antes de `writeScorecard` do scorecard refutado — mesmo efeito, sem contaminar a função pura.
4. **Caminhos da nota de migração:** `.agents/skills/local-merge-score/` → `skills/local-merge-score/` (módulo de precedentes, corpus, SKILL.md); `.claude/hooks/` → `hooks/` (regex da triagem cobre ambos).
5. **`package.json`:** nenhuma edição — o script `test` usa glob `scripts/*.test.mjs`, então os testes novos são registrados automaticamente (o plano pedia `test:lms`, que não existe aqui; é `test`).

## Passos pulados e por quê

- Nenhum passo pulado. Todos os arquivos citados existem aqui (com o mapeamento acima).

## Resultado final de `pnpm test`

```text
ℹ tests 140
ℹ pass 140
ℹ fail 0
```

## Dúvidas para o Master

1. **Prova do verificador roda no ambiente da revisão** (mesmo `execFile`/`PROVAS_PERMITIDAS` do contraditório, timeout 10 min). OK herdar isso sem flag própria?
2. **Precedentes versionados:** o corpus `skills/.../precedentes.md` cresce em runtime no repositório do consumidor e agora entra no diff/subject. Queremos gitignore nele, ou é desejável que apareça no diff (auditorável)?
3. Task 4 não têm teste de integração do estágio completo (verificador real derrubando um achado dentro do `runFallback`) — só do módulo puro + suíte de cadeia existente verde. Se quiser o teste de integração com fake collect, digo o custo: um fake a mais no `fixture()`.
