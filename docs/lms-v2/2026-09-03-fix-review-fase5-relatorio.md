# Fix review — Fase 5 (triagem de bug, agentes de domínio, veredito persistido)

**Data:** 2026-09-04 · **Branch:** `feat/lms-v2-fase5` · **Range revisado:** `origin/master..76fb1ff`
**Fonte:** `.lms/reports/REVIEW-FASE5-OPUS.md` (2 P1, 4 P2, 5 P3)
**Suíte no fim da leva:** `pnpm test` → 362/362 verde. Lint sintático: `node --check` em `scripts/*.mjs`; `bash -n` em `scripts/*.sh`, `hooks/*.sh` — OK.

Todos os achados obrigatórios têm **teste que reproduz a falha antes da correção**.

## P1

| Achado | Desfecho | Commit |
| --- | --- | --- |
| P1-1 `finalizar` propagava `veredito.json` VELHO e transformava gate reprovado em push liberado | **Corrigido** — duas travas, não uma: a rodada começa apagando o desfecho da anterior (`rm -f` no início do trigger, simétrico ao `rm` do `runFallback`), e `finalizar` sem argumento **nunca deriva `accepted`** — quem autoriza é o scorecard validado, que chama `finalizar accepted` explicitamente; estado lido como `accepted` sem esse caminho vira `timeout`. Teste reproduz o bypass: scorecard score 2 + runner falhando + `veredito.json` `accepted` velho → antes exit **0**, agora exit 1. | `e39d473` |
| P1-2 `--init` sobrescrevia agente commitado e apagava a verdade de domínio | **Corrigido** — `runBootstrap` escreve **só nome novo**; proposta homônima de arquivo existente é PULADA e nomeada no stderr. `--force` é a única forma de sobrescrever, e o aviso diz o que se perde. Retorno ganha `pulados` para o chamador distinguir "escreveu" de "já existia". Testes: agente artesanal commitado sobrevive ao `--init --yes`; `--force` regrava. | `3c359a7` |

## P2

| Achado | Desfecho | Commit |
| --- | --- | --- |
| P2-1 regex vazia no `match` fazia o agente casar TUDO | **Corrigido** — `listaDeRegex` recusa padrão vazio/só-espaço; o `catch` de `parseFrontmatter` já descarta o agente com aviso (disciplina de `regexList`). Teste: `match.sinal: [""]` e `paths: ["   "]` descartam o agente. | `cd3b832` |
| P2-2 arquivo com `LINEAR_API_KEY` nunca era apagado | **Corrigido** — a pasta temporária morre num `finally`, no sucesso e no erro. Testes verificam a remoção nos dois caminhos, lendo o payload **durante** a chamada (onde ele existe). **Vazamento vizinho achado no caminho:** a mensagem de erro da ferramenta ia inteira para stderr e para `.lms/bug-<id>.json` — um `curl` que ecoasse o token o gravaria em log e arquivo; passa por redação antes de propagar, com teste. | `cd3b832` |
| P2-3 `finalizar` só escrevia o veredito quando o arquivo não existia — quem espera lia o estado errado | **Corrigido** — o arquivo é sempre reescrito com o estado final. Teste: `veredito.json` `rejected` velho + rodada que passa → arquivo diz `accepted` e nada da rodada anterior vaza. O teste da Task 10 que simulava "runner gravou" pré-escrevendo o arquivo tinha premissa errada (era um veredito velho); o runner falso passa a gravar **durante** a rodada, como a cadeia real. | `e39d473` |
| P2-4 `lms-eval --bugs` media `path` sobre a saída crua, sem a conferência de disco | **Corrigido** — o relato passa por `achadoDoSinal`, e recusa vira caso reprovado (`recusado` no `por_caso`), não erro do eval. **Lacuna maior encontrada ao ligar isso** (abaixo). | `70dd01a` |

### Lacuna encontrada ao corrigir P2-4

A spec §3.1 promete "`path` conferido no disco, com linha — linha inexistente é
recusada antes de sair", mas **nada conferia a linha**. `citationsDiskError` não
servia para este caminho: ela exige que a **quote** case o arquivo naquela linha, e
a quote da triagem vem do log de runtime, nunca do código — bateria sempre falso, e
por isso nunca foi ligada. `conferirPathNoDisco` exige o que dá para exigir
honestamente: o arquivo existe, está sob a raiz, e tem aquela linha. Usada pelo
runner de produção **e** pelo eval.

O teste da Task 4 usava `a.py:2`, arquivo que não existe no fixture — passava
porque nada conferia. Corrigido, com testes novos para path inventado, linha além
do fim do arquivo e caminho fora da raiz.

## P3 (a critério)

| Achado | Desfecho | Commit |
| --- | --- | --- |
| P3-1 `achadoDoSinal` lançava e o runner não capturava (rejeição não tratada, sem a linha `recusada — …`) | **Corrigido** — recusa nomeada como todos os outros desfechos, com motivo no retorno. | `f0ca6d9` |
| P3-2 guiado: typo na resposta 1 mantinha TODAS as propostas em silêncio | **Corrigido** — conjunto vazio é cancelamento, com a lista dos nomes esperados no aviso. | `f0ca6d9` |
| P3-3 `..` no caminho citado saía da raiz e entrava como "conferido no disco" | **Corrigido** — contenção sob a raiz nos dois pontos: `caminhosDoSinal` (o que entra no prompt) e `conferirPathNoDisco` (o que vira achado). | `70dd01a` |
| P3-4 pré-rodada sem estado próprio em `estadoDoDesfecho` | **Não corrigido — justificado abaixo.** | — |
| P3-5 cobertura: (a) `--init` sobre diretório com agente, (b) `finalizar` com `accepted` velho, (c) regex vazia, (d) agente apenas *staged* | **Corrigido** — (a), (b) e (c) viraram os testes de reprodução de P1-2, P1-1 e P2-1. (d) tem teste próprio: `git add` sem commit não torna a instrução imutável. | `3c359a7`, `e39d473`, `cd3b832`, `f0ca6d9` |

### Por que P3-4 fica fora

A premissa do relatório não se sustenta: a pré-rodada da Fase 4 vive **no trigger**
(`lms-reviewer-trigger.sh`, exit 11) e nunca entra em `runFallback`, então ela não
"cai no ramo final `invalid-output`" de `estadoDoDesfecho` — esse caminho é
inalcançável.

Existe um problema **vizinho e real**: a triagem que dispensa (exit 10) e a
pré-rodada vermelha (exit 11) saem sem gravar veredito, e quem espera em
`until [ -f .lms/veredito.json ]` fica sem arquivo (ou lê o da rodada anterior).
Três razões para não corrigir agora:

1. **Não é regressão desta fase.** As duas saídas acontecem nas linhas 76 e 90, e o
   `rm -f` que introduzi está na 113 — elas se comportam exatamente como antes.
2. **Exige vocabulário novo de estado** (`dispensada`, `pre-rodada-vermelha`) em
   `ESTADOS_VEREDITO`, que é contrato de quem espera.
3. **Exige um fixture de trigger com git de verdade** para provocar exit 10/11
   honestamente — a alternativa seria um hook de teste (`LMS_FORCE_*`) dentro do
   código de produção, que é pior que o defeito.

Trabalho de próxima fase, não de véspera de release. Registrado aqui para não se
perder.

## Resultado final

```text
ℹ tests 362
ℹ pass 362
ℹ fail 0
LINT_OK (node --check em scripts/*.mjs; bash -n em scripts/*.sh, hooks/*.sh)
```
