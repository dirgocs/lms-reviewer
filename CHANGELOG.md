# Changelog

Formato [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/),
versionamento [SemVer](https://semver.org/lang/pt-BR/).

O que conta como *breaking* aqui: mudar o schema do scorecard, o contrato de
`lms.config.json`, os nomes das variáveis `LMS_*`, ou tornar mais frouxa uma trava do
gate. **Afrouxar o gate é breaking mesmo que nada quebre tecnicamente** — quem instalou
isto instalou o rigor, e um gate que passa a deixar passar é uma regressão silenciosa.

## [Unreleased]

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

[Unreleased]: https://github.com/dirgocs/lms-reviewer/compare/v1.1.2...HEAD
[1.1.2]: https://github.com/dirgocs/lms-reviewer/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/dirgocs/lms-reviewer/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/dirgocs/lms-reviewer/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/dirgocs/lms-reviewer/releases/tag/v1.0.0
