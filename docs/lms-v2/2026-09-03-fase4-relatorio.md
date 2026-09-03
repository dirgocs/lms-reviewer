# Fase 4 — fechamento do laço fix → revisão — relatório de fechamento

**Data:** 2026-09-03 · **Branch:** `feat/lms-v2-fase4` · **Spec:** `docs/lms-v2/2026-09-03-lms-v2-fase4.md` · **Plano:** `docs/lms-v2/2026-09-03-lms-v2-fase4-plano.md`

## Tasks feitas (na ordem do plano §7)

| Task | Commit | Conteúdo |
| --- | --- | --- |
| Plano | `c25c001` | Plano da fase (8 tasks + Task 9 extra), mesmo formato das fases anteriores. |
| 1 | `7032d4f` | Suíte verde como pré-condição: `lms-pre-rodada.mjs` (`comandoDeTeste`, `runPreRodada`, CLI exit 11), `testCommand` em `lms.config.json` (string ou `{cmd,args}`, opcional por desenho), bloco no `lms-reviewer-trigger.sh` após a triagem, `lms.config.example.json` documentado. Timeout em GRUPO (`LMS_TEST_TIMEOUT_MS`, default 10 min); vermelho recusa (nenhum provider), falha de ferramenta avisa e segue; `LMS_TEST_GATE=0` desliga. |
| 2 | `63dc9ba` | `collectTmux` com `promptPath`/`outPath` por chamador (`caminhosDaColeta`, defaults preservados) e `manterJanela` (não derruba a TUI no sucesso); `enviarPromptAteEntrar` recebe o caminho relativo do prompt (com override, o agente leria o arquivo errado); `registrar` grava o `marco` (SHA/stash) em cada linha de `fixes.jsonl`. |
| 3 | `dbadea8` | `lms-reverificar.mjs` puro: `reverificarPrompt` (ids + severity + acceptance + diff do fix; proíbe re-review completo), `parseReverificacao` (só objeto com `results`), `aplicarReverificacao` (fail-closed: id ausente/desconhecido = open; nunca mexe em score/agregado/coverage). |
| 4 | `02ddb1d` | `runReverificacao`: lê `last.json` + última linha `fixed/claimed` de `fixes.jsonl` (com `marco`), diff do fix limitado aos arquivos do fix (+ untracked como bloco), collect com `parseReverificacao`, `closed` passa pelo verificador da Fase 2 (CONFIRMED = volta a `open`), grava `.lms/reverificacao.json`, **nunca** publica. `LMS_VERIFY=0` recusa inteira. Bin `lms-reverificar` + `lms:reverificar`. |
| extra (KDT-68) | `969e370` | Score coerente com a severidade (ordem do Master): P0/P1 CONFIRMED → `score <= 3`; só P2 → `<= 4`; reprovado no VEREDITO nomeando `score` e os contadores. PLAUSIBLE não pesa (preserva F2-P1-3). Plano atualizado (Task 9). |
| 5 | `fc6d45f` | `logAttempt` persiste `{lens, path, id}` por achado na linha de `.lms/history.jsonl` (sintéticos `classe:` ficam fora — recontá-los mantia a classe reincidente para sempre); `lms-classe-recorrente.mjs` (`classeDe`, `classesReincidentes` com janela e rodadas consecutivas, `achadoEstrutural`, `historicoDeRodadas`). |
| 6 | `e5fb8ae` | `runFallback` injeta o sintético P1 do runner antes do veredito (bloqueia como qualquer P1 CONFIRMADO; contraditório pode derrubar); `corrigivelPeloRevisor` recusa `recurrence` (`classe recorrente exige decisão de desenho`); `findingsShapeError` aceita o sintético. |
| 7 | `4ff04dc` | `lms-eval.mjs` (`carregarCasos` — corpus vazio é erro; `compararAchados` por `(lens, path)`; `abaixoDosPisos` — recall min 0.8, FP máx 0.2, configuráveis; `runEval` aplica o patch em repo temporário e compara) + corpus `evals/casos/` com 3 casos anonimizados (tenant-emissão, paridade-preview, DoS falso-positivo) + README de proveniência/anonimização + bin `lms-eval`. |
| 8 | `fb07743` | SKILL.md (seções Re-verificação, Classe recorrente, Pré-rodada), CHANGELOG 1.3.0, versão 1.3.0 no pacote e no teste. |

## Passos pulados e por quê

- Nenhum passo da spec foi pulado. `pnpm dox-check` não existe neste pacote (herança do plano anterior — consumidor).

## Incidente de ferramenta (registrado)

O formatter automático da IDE corrompeu `scripts/lms-classe-recorrente.mjs` durante a
Task 5/6 (comentário de doc sem fechar engoliu o export, imports removidos) — os testes
de módulo passavam enquanto o wiring do `runFallback` falhava com histórico vazio.
Resolvido reescrevendo o arquivo inteiro com o conteúdo canônico. Os três arquivos da
Fase 3 citados no relatório anterior seguem em aspas duplas (mesma causa); normalização
de estilo fica como commit mecânico separado, quando o formatter estiver estável.

## Resultado final

```text
ℹ tests 250
ℹ pass 250
ℹ fail 0
LINT_OK (node --check em scripts/*.mjs, hooks/*.mjs; bash -n em *.sh)
```

## Dúvidas para o Master

1. **`runReverificacao` usa `providerConfig(env)` + `escolherRefutador` indireto** (via `verificarAchados`) para escolher o verificador do fechamento. Quer um provider dedicado (ex.: `LMS_REVERIFICAR_PROVIDER`) ou o roteamento atual serve?
2. **`lms-eval` roda o provider `[0]` da ordem.** Rodar a cadeia inteira por caso multiplicaria o custo por 3; um provider único é a régua mínima. Confirmado?
3. **Corpus com 3 casos** é o piso da spec — curadoria nova sai dos precedentes vencidos (spec §6.4). Sem prazo; quando o Master quiser, a curadoria é manual.
