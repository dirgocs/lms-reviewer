# Golden set de triagem de bug

Régua do `lms-triage-bug`: cada caso tem o **sinal de runtime** (`sinal.txt` —
log, stack trace, resposta HTTP ou relato) e o **esperado** (`esperado.json`).
Rodar `pnpm lms:eval --bugs` mede duas coisas, separadas de propósito:

- **acerto de match** — o agente que casou é o `agente` esperado. Casar o agente
  errado no arquivo certo é um defeito diferente de casar o agente certo no
  arquivo errado; por isso as duas métricas não se somam.
- **acerto de localização** — o `path`-sem-linha do achado bate com o esperado.

`nao_deve` é o análogo de `fp_conhecidos` do corpus de revisão: classe que a
triagem NÃO pode citar (o falso-culpado clássico daquela superfície). Citar
qualquer uma reprova a rodada inteira, independente dos pisos.

## Onde moram os agentes

O corpus é do pacote; **os agentes são do repo consumidor**. `--bugs` tria contra
`.agents/bug-triage/` do repositório onde é executado — é a mesma divisão do
resto da Fase 5: o pacote faz a mecânica, o repo carrega a inteligência de
domínio. Rodar no próprio pacote (que não declara agentes) mede match 0 por
desenho, não por defeito.

## Proveniência

Casos curados manualmente a partir do histórico do consumidor (`.lms/history.jsonl`,
runtime gitignored) e dos precedentes vencidos em `.lms/precedentes.md`:

- `worker-retry-sem-teto` — worker reagenda em 0s sem teto de tentativas depois
  de rejeição da transmissão. O falso-culpado registrado é "certificado
  expirado": o código de rejeição é bloqueio temporário, não falha de
  certificado.
- `emissao-tenant-ausente` — consulta de emissão sem filtro de tenant (mesma
  classe do caso `tenant-emissao` do corpus de revisão, aqui chegando por 500 de
  runtime em vez de diff). O falso-culpado é "rate limit/DoS", precedente já
  derrubado.
- `preview-dessincronizado` — preview e nota emitida divergem no total. O
  falso-culpado é tratar divergência de valor como problema cosmético.

## Regra de anonimização (obrigatória para novos casos)

Nada entra aqui sem passar por estas regras — os arquivos de origem são runtime
gitignored do repo consumidor:

- Sem nome de cliente, projeto ou domínio real.
- Sem CNPJ/CPF, chave de API, token, certificado ou trecho de `.env`.
- Sem URLs de produção; use `services/api/src/...` e nomes genéricos.
- Sem stack trace de dependência de terceiro verbatim: só os quadros do projeto.
- O sinal precisa ser pequeno e autocontido — o caso mede UMA classe de triagem,
  não um incidente inteiro.
- Curadoria manual, uma vez. Não há importador automático: cada caso é lido e
  anonimizado à mão.

## Uso

```bash
pnpm lms:eval --bugs          # tria o corpus contra os agentes deste repo
LMS_EVAL_BUG_MATCH_MIN=0.9 pnpm lms:eval --bugs   # pisos (defaults 0.8 / 0.6)
```

Exit 1 abaixo dos pisos (`LMS_EVAL_BUG_MATCH_MIN` 0.8, `LMS_EVAL_BUG_PATH_MIN`
0.6) ou com qualquer `nao_deve` citado. Corpus vazio é **erro**, nunca 100%:
acerto sobre zero casos é a métrica mais mentirosa possível.
