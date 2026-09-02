# lms-reviewer

Gate de publicação **bloqueante**. Uma cadeia de revisores julga o diff da branch,
produz um scorecard e o verifica contra os arquivos no disco. Sem scorecard 5/5,
fresco e pertencente àquele diff, o push não sai.

Extraído do `dirgocs/karibu-erp`; desde a v1.1 este pacote é a fonte canônica. O
projeto consumidor guarda apenas seus fatos em `lms.config.json` e aponta hooks e
scripts para o pacote pinado por tag.

## Instalação

Na raiz do projeto consumidor:

```bash
pnpm add -D github:dirgocs/lms-reviewer#v1.1.2
```

Ligue o gate ao `pre-push`, preservando os gates de produto que já existirem:

```sh
pnpm exec lms-push-gate || exit 1
```

O comando lê do stdin as refs que o Git entrega ao hook. Push só de paths isentos
retorna sem chamar reviewers; conjunto misto, código ou base indeterminável passam
obrigatoriamente pelo `lms-trigger`.

Para o hook `PreToolUse` do Claude Code, aponte para:

```text
${CLAUDE_PROJECT_DIR}/node_modules/@dirgocs/lms-reviewer/hooks/local-merge-score-gate.sh
```

A skill completa está em
`node_modules/@dirgocs/lms-reviewer/skills/local-merge-score/`. O consumidor pode
montá-la por symlink no diretório de skills do agente, sem copiar conteúdo.

Adicione `.lms/` ao `.gitignore`: scorecards, logs e telemetria são estado local.

## Comandos

| Binário | Função |
| --- | --- |
| `lms-push-gate` | Classifica o push e chama o trigger quando há código |
| `lms-trigger` | Valida o scorecard ou executa a cadeia de reviewers |
| `lms-reviewer` | Abre a sessão isolada do reviewer |
| `lms-reviewer-tmux` | Executa a cadeia dirigida pelas TUIs no tmux |
| `lms-exempt-paths` | Classifica uma lista de paths usando `lms.config.json` |

## Por que o gate é confiável

| Trava | O que evita |
| --- | --- |
| Diff dentro do prompt | Reviewer sem contexto julgando a tarefa errada |
| `inspected` conferido no disco | Alegação falsa de que um arquivo foi lido |
| Identidade do diff | Scorecard antigo autorizando código novo |
| Falha fechada | Timeout, CLI ausente ou JSON inválido liberando push |
| Contraditório obrigatório | Aceite 5/5 sem uma segunda tentativa de derrubá-lo |

Reprovação é um resultado legítimo, não uma falha técnica. Achado real bloqueia e
vai para `.lms/last.json`; falha dos providers também bloqueia e fica registrada em
`.lms/fallback.log`.

## Configuração por projeto

`lms.config.json` é opcional; o shape completo está em
[`lms.config.example.json`](./lms.config.example.json).

- `migrationsPath`: pasta append-only. Só quando declarada o prompt explica que uma
  migration aplicada não pode ser reescrita.
- `dbStateGate`: verificador do estado vivo do banco que cobre o risco fora do diff.
- `fallow.gate` e `fallow.baseline`: medição objetiva executada pelo runner.
- `exemptPaths`: regexes; **todo** arquivo precisa casar para o push ser isento.
- `nonExemptPaths`: exceções prioritárias dentro de um prefixo isento.

Config inválida descarta o conjunto inteiro e cai nos defaults restritivos; regex de
exclusão quebrada nunca pode abrir uma isenção configurada.

Providers, ordem, modelos e timeouts continuam em variáveis `LMS_*`. Defaults:
`claude,grok,codex`, `claude-opus-4-8`, `grok-4.6`, `gpt-5.6-sol`, esforço Claude
`high` e timeout de 900 segundos.

## Testes

```bash
pnpm test
```

A suíte não usa rede nem chama reviewers reais. Fixtures exercitam Git, runners
falsos, o hook do Claude Code, o gate de push e o conteúdo publicável do pacote.

## Pré-requisitos e versionamento

Node ≥ 22, pnpm, Git e os CLIs configurados para os providers escolhidos. `tmux` é
necessário para o modo padrão; sem ele o trigger cai para o runner headless.

O projeto segue SemVer, tags `vX.Y.Z` e
[`CHANGELOG.md`](./CHANGELOG.md). Afrouxar uma trava é breaking change: quem instala
este pacote instala o rigor, não apenas a API técnica.
