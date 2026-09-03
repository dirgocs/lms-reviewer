# Golden set de evals do LMS

Régua do próprio LMS: cada caso tem o **diff revisado** (`patch.diff`) e o
**esperado** (`esperado.json`). Rodar `pnpm lms:eval` mede recall de P1 real e
taxa de falso-positivo conhecido contra o provider/prompt atuais.

- `p1` — achados REAIS esperados: têm de aparecer (contam recall). Casamento por
  `(lens, path)`; `id` decide quando estável; título nunca é chave.
- `fp_conhecidos` — classes de achado já DERRUBADAS por refutação/precedente: se
  aparecerem, contam falso-positivo.

## Proveniência

Casos curados manualmente a partir do histórico do LMS (`.lms/history.jsonl` do
consumidor) e das revisões independentes (`REVIEW-FASE{1,2,3}-OPUS.md`), mais os
precedentes vencidos registrados em `.lms/precedentes.md`:

- `tenant-emissao` — query de emissão sem filtro de tenant (KDT-68, rodada 1).
- `paridade-preview` — preview dessincronizado da emissão (KDT-68, classe que
  reincidiu 5 rodadas).
- `dos-falso-positivo` — webhook sem rate limit reportado como P1: falso-positivo
  conhecido (precedente "DoS/exaustão de recurso", política 2026-09-01).

## Regra de anonimização (obrigatória para novos casos)

Nada entra aqui sem passar por estas regras — os arquivos de origem são runtime
gitignored do repo consumidor:

- Sem nome de cliente, projeto ou domínio real.
- Sem CNPJ/CPF, chave de API, token, certificado ou trecho de `.env`.
- Sem URLs de produção; use `services/api/src/...` e nomes genéricos.
- O diff precisa ser autocontido (arquivos novos) e pequeno — o caso mede UMA
  classe de achado, não um projeto.
- Curadoria manual, uma vez. Não há importador automático: cada caso é lido e
  anonimizado à mão.

## Uso

```bash
pnpm lms:eval          # roda o provider da ordem contra o corpus e imprime a régua
LMS_EVAL_RECALL_MIN=0.9 pnpm lms:eval   # pisos configuráveis (defaults 0.8 / 0.2)
```

Exit 1 abaixo dos pisos. Trocar `reviewPrompt` ou acrescentar provider à
`LMS_REVIEWER_ORDER` EXIGE uma rodada de eval registrada no CHANGELOG.
