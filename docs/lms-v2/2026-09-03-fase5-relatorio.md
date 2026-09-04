# Fase 5 — triagem de bug com agentes de domínio no repo — relatório de fechamento

**Data:** 2026-09-04 · **Branch:** `feat/lms-v2-fase5` · **Spec:** `docs/lms-v2/2026-09-03-lms-v2-fase5.md` · **Plano:** `docs/lms-v2/2026-09-03-lms-v2-fase5-plano.md`

## Tasks feitas (na ordem do plano)

| Task | Commit | Conteúdo |
| --- | --- | --- |
| Spec | `ccfa513` | Spec da fase (lane anterior). |
| Plano | `690cf0c` | Plano da fase (9 tasks + Task 10 extra, evidência KDT-68) (lane anterior). |
| 1 | `5e27654` | `lms-bug-agents.mjs`: `parseFrontmatter` (YAML mínimo próprio, zero dependência nova), `carregarAgentes` (frontmatter inválido descartado com aviso, nunca "match parcial"), `agenteCommitado` (untracked/modificado → recusa nomeada), `escolherAgente` (paths×3, sinal×2, tags×1; empate pelo nome menor), `contextoDoAgente`. (lane anterior) |
| 2 | `ea02931` | `bugAgents` em `loadConfig` (`dir`, `tracker` contra allowlist fechada, `guided`) + `lms.config.example.json`. (lane anterior) |
| 3 | `a3c0468` | `lms-triage-bug.mjs` núcleo: `normalizarSinal` (tags só de padrões estruturais agnósticos), `caminhosDoSinal` (só o que existe no disco), `triagemPrompt`, `parseTriagem`, `achadoDoSinal` (contrato + `findingId` + origem runtime assinada; `path` sem linha ou inexistente é recusado). (lane anterior) |
| 4 | `dd75f6b` | Wiring com `verificarAchados` da Fase 2: `LMS_VERIFY=0` recusa a triagem inteira (exit 1), exit 2 nomeando o que faltou, `PLAUSIBLE` vira backlog, grava `.lms/bug-<id>.json`; bin `lms-triage-bug` + `lms:triage:bug`. (lane anterior) |
| 5 | `a2bbeb4` | `lms-bug-bootstrap.mjs`: `varrerRepo` (topologia, `AGENTS.md`/`CLAUDE.md`, superfícies rota/worker/banco/integração, gates, `git log --grep '^fix'`), `proporAgentes` (piso 1, teto 6, MOTIVO obrigatório), `renderizarAgente` (round-trip pelo parser da Task 1), `deveBootstrapar`, `runBootstrap` (autônomo com UMA confirmação; `--guided` com default inferido). Wiring de `--init` e do auto-init no `runTriageBug`. |
| — | `111dc80` | **Correção fora do plano:** a spec §3.1 promete `… \| lms-triage-bug`, mas o runner só lia sinal de arquivo — sem argumento o texto ficava vazio e a triagem morria com exit 2. Passa a ler stdin (injetável para teste), com `isTTY` devolvendo vazio em vez de travar, e o argumento de arquivo ignorando flags. |
| 6 | `1e3ecce` | `lms-tracker.mjs` (`corpoDaIssue`, `tituloDaIssue`, `abrirIssue`) + roteamento: `escalar_para` vence a regra da Fase 3 quando declarado, senão `corrigivelPeloRevisor` decide. `none` não chama binário; `github` via `gh`; `linear` via `curl`. Toda falha avisa e segue. |
| 7 | `fd5cd82` | `{ relativo }` opcional em `lerPrecedentes`/`registrarPrecedente` (teto e dedupe por arquivo) + triagem derrubada vira precedente daquele agente em `.lms/precedentes-bug/<agente>.md`, lido no `triagemPrompt` da próxima triagem que casar o mesmo agente. |
| 8 | `2f8167b` | `carregarCasos(dir, { sub, arquivo, campo })`, `compararTriagem` (match e localização medidos separados; `nao_deve` = análogo de `fp_conhecidos`), `abaixoDosPisosBug`, `runEvalBugs`, roteamento de `--bugs` em `main()`; `evals/bugs/` com 3 casos curados/anonimizados + README. |
| 10 | `30198c8` | `registrarVeredito` + `runFallback` grava `.lms/veredito.json` em QUALQUER desfecho (inclusive exceção no meio); `estadoDoDesfecho` fail-closed; `lms-trigger` sai por estado e imprime `LMS VEREDITO: <estado>` como última linha do stderr; SKILL.md com `until [ -f .lms/veredito.json ]`. |
| 9 | `24ce4a6` | README (tabela de binários completa), SKILL.md (seção "Triagem de bug" com o invariante), CHANGELOG 1.4.0, versão 1.4.0, `evals/` no artefato publicado. |

## Sobre o trabalho parcial da lane anterior

A lane anterior parou no meio da Task 5. O diff não commitado tinha **7 arquivos
modificados + 1 novo**:

- **5 arquivos eram 100% reformatação de estilo** (aspas simples → duplas, quebras
  no padrão Prettier), sem uma linha de mudança semântica: `lms-config.mjs`,
  `lms-config.test.mjs`, `lms-package.test.mjs`, `lms-triage-bug.mjs`,
  `lms-triage-bug.test.mjs`. **Revertidos**, conforme a regra da fase (é a mesma
  causa registrada no relatório da Fase 4: formatter da IDE).
- `lms-bug-agents.test.mjs` era reformatação **mais** os testes da Task 5 escritos
  no arquivo errado (o plano pede `lms-bug-bootstrap.test.mjs`). Revertido; os
  testes foram reescritos no arquivo certo.
- `lms-bug-bootstrap.mjs` (novo) era trabalho real, mas incompleto: sem
  `deveBootstrapar` (o gate de auto-init exigido pela spec §3.3), o modo guiado
  fazia UMA pergunta em vez das seis da spec, ignorava `bugAgents.dir`, não
  imprimia a lista com motivo e quebrava se `pergunta` não fosse injetada. Foi
  usado como ponto de partida e completado sob TDD (teste primeiro, vermelho
  verificado, depois implementação).

## Defeitos encontrados e corrigidos no caminho

Dois defeitos reais em código já commitado, achados ao integrar:

1. **`lms-eval` apontava o corpus para `<raiz>/casos`**, diretório que nunca
   existiu — o corpus mora em `evals/casos`. `pnpm lms:eval` morria com "corpus de
   eval ausente ou ilegível". Corrigido na Task 8 (`2f8167b`).
2. **`lms-triage-bug` nunca leu stdin**, apesar de a spec §3.1 e o `--help` do
   próprio módulo prometerem `kubectl logs … | lms-triage-bug`. Corrigido em
   `111dc80`, com o teste "stdin e arquivo dão o mesmo achado" que a spec §4 exige
   e que não existia.

## Passos pulados e por quê

- **Nenhuma task do plano foi pulada.** As 10 (9 + a extra) estão commitadas.
- `evals/bugs/` mede contra os agentes do repo **onde o eval roda**. Rodar
  `--bugs` no próprio pacote (que não declara agentes) mede match 0 **por
  desenho**, não por defeito — a inteligência de domínio é do consumidor. Está
  documentado no `evals/bugs/README.md`; não há como o pacote se auto-avaliar sem
  embutir domínio, que é exatamente o que a spec §6 proíbe.
- `pnpm dox-check` não existe neste pacote (mesma herança registrada na Fase 4).

## Resultado final

```text
ℹ tests 329
ℹ pass 329
ℹ fail 0
LINT_OK (node --check em scripts/*.mjs; bash -n em scripts/*.sh, hooks/*.sh)
```

`pnpm test` (suíte completa) rodou verde **antes de cada um dos 7 commits** desta
lane.

## Dúvidas para o Master

1. **Match de sinal inferido pelo bootstrap.** O `match.sinal` proposto é o nome
   da superfície (ex.: `workers`), que de fato aparece em stack trace. Inferir
   vocabulário de domínio (`cStat`, `NFeDistribuicaoDFe`, como no exemplo da spec
   §3.2) exigiria o pacote adivinhar domínio — deixei em branco por princípio, com
   o `--guided` cobrindo. Serve, ou quer heurística mais agressiva (ex.: grep de
   identificadores repetidos nos arquivos da superfície)?
2. **`verificar_antes_de_abrir_issue` sai vazio no bootstrap autônomo.** É a
   verdade de domínio que só o consumidor tem; o corpo do `.md` gerado pede
   explicitamente que seja preenchido. Confirma que agente gerado sem essa lista é
   aceitável (ele ainda casa e ainda orienta onde olhar), ou o bootstrap autônomo
   deveria recusar-se a escrever sem ela?
3. **`LINEAR_TEAM_ID`.** A spec §3.4 cita só `LINEAR_API_KEY`, mas a mutation
   `issueCreate` exige `teamId`. Tratei a ausência como as demais falhas de
   ferramenta (avisa e segue). Confirma o nome da variável?
4. **`.lms/veredito.json` é desfecho, não lock.** Quem espera precisa apagá-lo
   antes de uma rodada nova (documentado na SKILL). Quer que o `runFallback`
   apague o arquivo no início da cadeia, para que "existe" signifique sempre
   "terminou agora"?
