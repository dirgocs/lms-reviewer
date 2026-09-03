# Changelog

Formato [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/),
versionamento [SemVer](https://semver.org/lang/pt-BR/).

O que conta como *breaking* aqui: mudar o schema do scorecard, o contrato de
`lms.config.json`, os nomes das variáveis `LMS_*`, ou tornar mais frouxa uma trava do
gate. **Afrouxar o gate é breaking mesmo que nada quebre tecnicamente** — quem instalou
isto instalou o rigor, e um gate que passa a deixar passar é uma regressão silenciosa.

## [1.3.0] - 2026-09-03

Fase 4: fechamento do laço fix → revisão. Spec e plano em
`docs/lms-v2/2026-09-03-lms-v2-fase4.md` e `...-fase4-plano.md`.

### Adicionado

- **Suíte verde como pré-condição de rodada** (`testCommand` em `lms.config.json`,
  opcional) — suíte vermelha recusa a rodada (exit 11, nenhum provider invocado);
  falha de ferramenta avisa e segue; `LMS_TEST_GATE=0` desliga.
- **Re-verificação incremental do fix** (`lms-reverificar`, bin `lms-reverificar`) —
  o mesmo revisor que abriu o achado responde "estes ids continuam abertos?";
  fail-closed (id ausente/desconhecido = open), `closed` só vale após o verificador
  da Fase 2, nunca altera score/agregado e nunca publica scorecard.
- **Classe recorrente vira achado estrutural** — a mesma lens+prefixo em 3 rodadas
  consecutivas injeta um P1 do runner cujo acceptance é o TESTE da classe; fix
  pontual é recusado (vai para o orquestrador).
- **Golden set de evals** (`evals/`, bin `lms-eval`) — recall de P1 real e taxa de
  falso-positivo conhecido, com pisos (`LMS_EVAL_RECALL_MIN` 0.8, `LMS_EVAL_FP_MAX`
  0.2). Trocar `reviewPrompt` ou provider exige rodada de eval no CHANGELOG.
- Sessão tmux reutilizável: prompt/candidato por chamador e `manterJanela`.
- Linha de `.lms/fixes.jsonl` carrega o `marco`; histórico carrega os achados
  (`lens`, `path`, `id`) por rodada.

### Corrigido

- Score incoerente com a severidade reprovado no veredito, nomeando o campo
  (KDT-68: score 4 com p1=5 aceito): P0/P1 CONFIRMED => score <= 3; só P2 => <= 4.
  PLAUSIBLE não pesa.

## [1.2.0] - 2026-09-02

Fase 1 (contrato do scorecard), Fase 2 (qualidade do veredito) e Fase 3 (fix mode),
com as três levas de correção sobre revisão independente. Relatórios completos em
`docs/lms-v2/` (`2026-09-01-fase1-relatorio.md`, `2026-09-01-fase2-relatorio.md`,
`2026-09-01-fase3-relatorio.md`, `2026-09-01-fix-review-relatorio.md`,
`2026-09-01-fix-review-fase3-relatorio.md`); spec e porquê em `docs/lms-v2/2026-09-01-lms-v2.md`.

### Adicionado

- **Scorecard v2** — `coverage` (denominador da varredura), `verified` (asserções
  positivas com citação conferida no disco), lente inaplicável declarada
  (`applicable: false` + `na_reason`), achado com `id` estável (ignora a linha),
  `precondition` e `acceptance`. Schema publicado em
  `skills/local-merge-score/references/scorecard.schema.json`, sincronizado com o
  validador por teste.
- **Retentativa por forma** — saída malformada devolve a mensagem de validação ao
  provider (uma segunda chance); reprovação legítima segue encerrando a cadeia.
- **Triagem determinística** (`lms-triage`, exit 10) — diff sem caminho de execução
  dispensa a cadeia; usa a MESMA regra de isenção do gate (`isExempt` +
  `lms.config.json`); superfícies sensíveis (gate, CI, migrations, AGENTS.md) sempre
  revisam.
- **Effort pelo raio do diff** (`LMS_EFFORT`) — `xhigh` quando toca
  auth/tenant/fiscal/migrations/signer/webhook/`/pos/`; so o revisor sobe, refutador
  fica no `LMS_CLAUDE_EFFORT`.
- **Corpus de precedentes** (`.lms/precedentes.md`, runtime do consumidor) — refutador
  e verificador alimentam; injetado no prompt de toda revisão, sanitizado e com teto
  de 40.
- **Verificação adversarial por achado** — cada achado CONFIRMED vai a um verificador
  independente que so rebaixa (`CONFIRMED`/`PLAUSIBLE`; `FALSE_POSITIVE` exige prova da
  allowlist e o teto é `PLAUSIBLE`); `LMS_VERIFY=0` desliga, `LMS_VERIFY_BUDGET_MS`
  orça o estágio; serial, com id conferido e teto de 5 achados por rodada.
- **Fix mode** (`LMS_FIX_MODE`, default `off`; `pnpm lms:fix` / bin `lms-fix`) — quem
  achou corrige numa segunda invocação com sandbox de escrita (`workspace-write`,
  sem `Bash`); roteamento pela forma do achado; guarda de escopo (untracked/rename
  visíveis, `.lms/` vigiado por snapshot de conteúdo, violação reverte inteiro);
  `fixed` ≠ `claimed` (prova pela allowlist `PROVAS_PERMITIDAS`); autoria por arquivo
  com escopo temporal (expira com o HEAD); `found_by` manda o conserto para quem achou.
- `lms-fix` exposto no `bin` do pacote.

### Corrigido

- Gate não publica mais scorecard que LISTA achado bloqueante com contadores zerados
  (contagem e lista reconciliadas pelo veredito).
- Runner confere `verified` no disco (antes só o gate conferia — a retentativa
  desperdiçava e o erro aparecia 20 min depois, sem nomear campo).
- Mensagens de validação nomeiam campo e expectativa; `score` ganhou teto 0-5;
  `applicable` não-booleano e `lens` desconhecida são reprovados.
- Prova executável roda em GRUPO de processos — timeout não orfana mais o runner de
  teste; filhos destacados morrem na saída do runner (Ctrl+C incluso).
- Marco do fix é SHA imutável (não a ref `HEAD`); `no_change_needed` deixa de ser
  recusado; denylist do fix cobre `.agents/`, `.claude/` e o pacote instalado.
- Verificador no tmux recebe onde gravar o veredito (antes imprimia — estágio virava
  timeout no caminho principal de produção).
- Regra de tenant fala de `tenantId`/`tenant_id` — `hotel_id` não existe em código
  nenhum e a guarda de vocabulário varre `skills/` e `hooks/` por glob.
- Ordenação do output e correções de release: `chore(release): v1.2.0`.

## [1.1.5] - 2026-09-01

### Adicionado

- Provider `pi` na cadeia (`LMS_REVIEWER_ORDER=grok,pi`). Modelo default
  `z-ai/glm-5.3-flash` via OpenRouter (`LMS_PI_MODEL`, `LMS_PI_PROVIDER`).
  A TUI restringe tools a leitura.

## [1.1.4] - 2026-09-01

### Corrigido

- `goal-loop.md` e o hook PreToolUse deixam de citar `pnpm local:review`, script
  que não existe no consumidor. O fluxo público é `pnpm exec lms-trigger` /
  `pnpm exec fallow`.

## [1.1.3] - 2026-09-01

### Removido

- pxpipe: o spawn não sobe proxy, não resolve allowlist de imaging e não grava
  `.lms/pxpipe-*`. A sessão tmux fala direto com o CLI do provider.

## [1.1.2] - 2026-09-01

### Corrigido

- `lms-reviewer` (spawn) carrega o allowlist do pxpipe de `scripts/lib/` do pacote,
  não de `scripts/lib/` do consumidor.
- A skill e o spawn documentam `pnpm exec lms-trigger` / `pnpm exec lms-reviewer`,
  os bins instalados, em vez de scripts wrapper no projeto cliente.

## [1.1.1] - 2026-09-01

### Corrigido

- A skill instalada documenta apenas os comandos públicos e o caminho real do hook no
  pacote, sem apontar para scripts vendorizados que o consumidor removeu.
- Regras de negócio passam a vir do `AGENTS.md` e do `lms.config.json` do consumidor;
  a skill canônica não fixa mais convenções internas do Karibu.

## [1.1.0] - 2026-09-01

### Adicionado

- Fonte canônica dos scripts vivos do Karibu, incluindo runner tmux, piloto Pi,
  contexto de diff, telemetria de severidade, política P2 e fixtures correspondentes.
- Bins `lms-reviewer-tmux`, `lms-push-gate` e `lms-exempt-paths`.
- Hook do Claude Code, skill completa e planos do LMS v2 no artefato do pacote.
- Regras `exemptPaths` e `nonExemptPaths` no `lms.config.json`.

### Modificado

- Trigger, hook e spawn resolvem a mecânica ao lado do pacote; o projeto consumidor
  não precisa mais manter cópias em `scripts/`.
- `lms-push-gate` preserva o fail-closed: base indeterminável nunca é isenção.
- Config de regex inválida descarta o conjunto inteiro, impedindo que uma exclusão
  malformada abra um prefixo isento.
- Instalação oficial passa a ser dependência Git pinada por tag com pnpm.

### Removido

- `install.sh` e o fluxo de vendoring, que criavam duas fontes divergentes.

## [1.0.0] - 2026-08-24

Primeira versão como repositório próprio. Extraído do `dirgocs/karibu-erp`.
48 testes passando (44 herdados + 4 novos), sem rede e sem chamar nenhum CLI.

### Adicionado

- Cadeia de revisores headless com fallback entre providers
  (`lms-reviewer-fallback.mjs`), ordem default `claude,grok,codex`.
- Scorecard verificado contra o disco (`lms-scorecard.mjs`, `lms-inspection.mjs`):
  `inspected` é prova de leitura em `{path, line, quote}`, com a linha copiada
  verbatim. Quote que não bate invalida a review inteira.
- Identidade do diff (`lms-subject.mjs`): scorecard de outro diff não autoriza
  publicação, e a árvore suja conta.
- Trigger de `pre-push` (`lms-reviewer-trigger.sh`) e sessão tmux de revisão
  (`lms-reviewer-tmux.mjs`, `lms-reviewer-spawn.sh`).
- `lms-config.mjs` — **novo na extração**: carrega um `lms.config.json` opcional da
  raiz do projeto. Sem ele o gate roda como revisor puro de diff.
- `install.sh`, `package.json` com bins e `npm test`, `lms.config.example.json`.

### Modificado (desacoplamento na extração)

- `migrationsPath` deixa de ser `services/api/migrations/` hardcoded. A regra de
  *migration append-only* só entra no prompt quando o projeto a declara — antes, num
  repo sem migrations, ela mandava o revisor isentar uma pasta inexistente, o que é
  uma isenção gratuita no gate.
- `dbStateGate` deixa de citar `scripts/db-exposure-gate.mjs` fixo no prompt.
- `fallow.gate` deixa de ser `apps/pdv-mobile/scripts/...` hardcoded. Sem configuração
  o veredito é `no-changes`, igual ao que já valia quando o arquivo não existia.

### Segurança

- `lms.config.json` inválido **não** vira aprovação silenciosa: avisa no stderr e cai
  no default vazio, que é o modo mais restritivo de prompt e não desliga trava nenhuma.

[1.1.5]: https://github.com/dirgocs/lms-reviewer/compare/v1.1.4...v1.1.5
[1.1.4]: https://github.com/dirgocs/lms-reviewer/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/dirgocs/lms-reviewer/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/dirgocs/lms-reviewer/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/dirgocs/lms-reviewer/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/dirgocs/lms-reviewer/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/dirgocs/lms-reviewer/releases/tag/v1.0.0
