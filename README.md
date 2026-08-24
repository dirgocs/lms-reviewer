# lms-reviewer

Gate de push **bloqueante**: uma cadeia de revisores headless (Claude → Grok → Codex)
julga o diff da branch e produz um *scorecard* que é verificado contra o disco. Sem
scorecard válido e fresco para *aquele* diff, o push não sai.

Extraído do `dirgocs/karibu-erp`. Aqui é agnóstico de projeto.

## O que faz ele valer a pena

O valor não está em "chamar um LLM para revisar" — está nas quatro travas que
impedem a revisão de virar teatro. Todas nasceram de um bug real em que **o gate
estava invertido: quanto mais problema o código tinha, mais fácil passar.**

| Trava                          | Sem ela                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------- |
| O diff vai **dentro** do prompt | Reviewer sem `git` não sabia o que mudou e terminava em `Cancelled`         |
| `inspected` conferido no disco  | O modelo alegava ter lido arquivos; agora prova com `{path, line, quote}`    |
| Falha da cadeia **bloqueia**    | Cadeia inteira falhando fazia `exit 0` com warning e liberava o push         |
| Contrato de saída é JSON        | Contrato em prosa fazia os três providers errarem campos e serem descartados |

A consequência do conjunto: reprovar é uma resposta **legítima e esperada**, não um
"reviewer quebrado". Achado real leva a push bloqueado — que era exatamente o que
não acontecia antes.

## Instalação

```bash
git clone git@github.com:dirgocs/lms-reviewer.git ~/dev/lms-reviewer
~/dev/lms-reviewer/install.sh /caminho/do/projeto
```

Copia os módulos para `<projeto>/scripts/`, adiciona `.lms/` ao `.gitignore` e
liga o trigger no `pre-push` (husky ou `.git/hooks`).

## Configuração

**Providers, ordem e modelos são variáveis de ambiente:**

| Variável                  | Default              |
| ------------------------- | -------------------- |
| `LMS_REVIEWER_ORDER`      | `claude,grok,codex`  |
| `LMS_CLAUDE_MODEL`        | `claude-opus-4-8`    |
| `LMS_GROK_MODEL`          | `grok-4.6`           |
| `LMS_CODEX_MODEL`         | `gpt-5.6-sol`        |
| `LMS_{CLAUDE,GROK,CODEX}_BIN` | nome do binário  |
| `LMS_CLAUDE_EFFORT`       | `high`               |
| `LMS_REVIEWER_TIMEOUT_SEC`| `900`                |

**Caminhos do projeto ficam em `lms.config.json`** (opcional — veja
`lms.config.example.json`). Sem esse arquivo o gate roda como revisor puro de diff,
que já é útil. Os dois campos que existem são isenções e medições que só fazem
sentido se o projeto realmente as tiver:

- `migrationsPath` — liga a regra de *migration append-only*. Sem ela a cadeia não
  converge em repos com migrations: cada rodada acha o próximo defeito teórico na
  mesma história imutável. **Não declare se o projeto não tem migrations** — seria
  isentar uma pasta inexistente.
- `fallow.gate` — gate de regressão de métrica, medido pelo *runner*, nunca
  declarado pelo reviewer (o modelo não tem shell nem relógio confiável).

## Testes

```bash
npm test    # 48 testes, sem rede e sem chamar nenhum CLI
```

## Pré-requisitos

Node ≥ 22, `git`, `tmux` (para a sessão de revisão interativa) e os CLIs revisores
no PATH e autenticados: `claude`, `grok`, `codex`. Um provider ausente só custa a
vez dele na cadeia — mas a cadeia inteira falhando **bloqueia**, não libera.
