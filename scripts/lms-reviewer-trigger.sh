#!/usr/bin/env bash
# Exit 0 if LMS scorecard OK. Else run authenticated headless reviewers.
# Used by PreToolUse gate and husky pre-push (D18).
set -euo pipefail
PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${LMS_REVIEWER_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
export LMS_PROJECT_ROOT="$ROOT"
cd "$ROOT"
SCORECARD="$ROOT/.lms/last.json"
MAX_AGE="${LMS_HOOK_MAX_AGE_SEC:-7200}"
# Nome da sessao derivado do caminho da raiz: uma sessao por arvore de trabalho.
# Com nome fixo, dois worktrees revisando ao mesmo tempo disputam as janelas
# lms-<provider> e o segundo mata a do primeiro; o sintoma chega mascarado como
# "contraditorio: invalid-output". Tem de casar com sessionNameFor() de
# scripts/lms-reviewer-tmux.mjs: sha256 do caminho, 8 primeiros hex.
#
# sha256sum e GNU e nao existe no macOS, onde o equivalente e `shasum -a 256`.
# Com `set -euo pipefail`, a falha dentro da substituicao derrubaria o hook inteiro
# em vez de revisar — entao o fallback e obrigatorio, nao conveniencia.
lms_session_name() {
  local raiz=$1 soma
  if command -v sha256sum >/dev/null 2>&1; then
    soma=$(printf '%s' "$raiz" | sha256sum)
  elif command -v shasum >/dev/null 2>&1; then
    soma=$(printf '%s' "$raiz" | shasum -a 256)
  else
    soma=$(printf '%s' "$raiz" | openssl dgst -sha256 | awk '{print $NF}')
  fi
  printf 'lms-review-%s' "${soma:0:8}"
}
SESSION="${LMS_TMUX_SESSION:-$(lms_session_name "$ROOT")}"
# Cadeia agentica em tmux e o padrao: cada revisor roda na TUI dele, com as ferramentas
# nativas, em vez de ser invocado headless. Metade dos defeitos da cadeia anterior era
# atrito de invocacao (stdin ignorado, JSONL de eventos, nomes de ferramenta errados no
# prompt), nao de revisao. LMS_REVIEWER_MODE=headless volta ao caminho antigo, que
# continua testado e serve onde nao ha tmux (CI, container sem TTY).
case "${LMS_REVIEWER_MODE:-tmux}" in
  headless) DEFAULT_RUNNER="$PACKAGE_ROOT/scripts/lms-reviewer-fallback.mjs" ;;
  *)        DEFAULT_RUNNER="$PACKAGE_ROOT/scripts/lms-reviewer-tmux.mjs" ;;
esac
# Sem tmux no PATH nao adianta insistir: cai para o headless em vez de falhar por algo
# que nao tem a ver com o codigo em revisao.
if [ "$DEFAULT_RUNNER" != "${DEFAULT_RUNNER%tmux.mjs}" ] && ! command -v tmux >/dev/null 2>&1; then
  echo "lms-trigger: tmux ausente; usando a cadeia headless" >&2
  DEFAULT_RUNNER="$PACKAGE_ROOT/scripts/lms-reviewer-fallback.mjs"
fi
RUNNER="${LMS_REVIEWER_RUNNER:-$DEFAULT_RUNNER}"

if [ "${LMS_SKIP:-}" = "1" ] || [ "${LMS_HOOK_SKIP:-}" = "1" ]; then
  exit 0
fi

resolve_base() {
  local candidate
  for candidate in origin/master origin/main master main; do
    if git merge-base HEAD "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  printf '%s\n' HEAD~1
}

BASE_REF="${LMS_REVIEWER_BASE:-$(resolve_base)}"

# Triagem antes da cadeia: diff sem caminho de execucao nao merece tres revisores.
# Exit 10 e "dispensada" (nao e erro); qualquer outro codigo diferente de 0 e falha
# da triagem, e falha de ferramenta NAO dispensa revisao.
if [ "${LMS_TRIAGE:-1}" = "1" ]; then
  set +e
  node "$PACKAGE_ROOT/scripts/lms-triage.mjs" --base "$BASE_REF"
  TRIAGE_RC=$?
  set -e
  if [ "$TRIAGE_RC" = "10" ]; then
    echo "lms-trigger: revisao dispensada pela triagem" >&2
    exit 0
  fi
fi

# Fase 4: suíte vermelha recusa a rodada ANTES de gastar cota (exit 11). Falha de
# ferramenta (comando ausente, timeout) avisa e segue — erro de infra nunca decide
# sozinho, mesmo precedente da triagem. LMS_TEST_GATE=0 desliga.
if [ "${LMS_TEST_GATE:-1}" = "1" ]; then
  set +e
  node "$PACKAGE_ROOT/scripts/lms-pre-rodada.mjs" --root "$ROOT"
  PRE_RODADA_RC=$?
  set -e
  if [ "$PRE_RODADA_RC" = "11" ]; then
    echo "lms-trigger: rodada recusada — suíte vermelha (nenhum provider invocado)" >&2
    exit 11
  fi
fi

scorecard_ok() {
  [ -f "$PACKAGE_ROOT/scripts/lms-scorecard.mjs" ] || return 1
  node "$PACKAGE_ROOT/scripts/lms-scorecard.mjs" \
    --file "$SCORECARD" \
    --base "$BASE_REF" \
    --max-age-sec "$MAX_AGE" \
    >/dev/null 2>&1
}

# Task 10 da Fase 5 (evidencia KDT-68): quem espera a cadeia precisa de UMA linha
# estavel, sempre a ultima do stderr, e de um arquivo para esperar. Duas lanes
# ficaram HORAS paradas "aguardando veredito" com a cadeia ja fechada.
VEREDITO_FILE="$ROOT/.lms/veredito.json"

# P1-1 da revisao da Fase 5: o veredito e o desfecho DESTA rodada, nao um lock.
# Ele nunca era invalidado, entao uma rodada aceita no passado deixava um arquivo
# que autorizava a falha seguinte — bypass do gate sem LMS_SKIP e sem intencao do
# usuario. A rodada comeca apagando o desfecho da anterior (mesmo principio do
# `rm` no inicio de runFallback).
rm -f "$VEREDITO_FILE"

veredito_estado() {
  [ -f "$VEREDITO_FILE" ] || return 1
  sed -n 's/.*"estado"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$VEREDITO_FILE" | head -1
}

# Sai nomeando o estado. Duas fontes, com pesos diferentes:
#
# - COM argumento: o proprio trigger julgou (scorecard validado). E a UNICA forma
#   de chegar em `accepted`.
# - SEM argumento: a cadeia rodou e nao autorizou; o estado vem do que o runner
#   gravou nesta rodada. `accepted` aqui seria contradicao (o scorecard nao passou
#   na validacao logo acima), entao vira `timeout` — fail-closed.
#
# O arquivo e SEMPRE reescrito com o estado final (P2-3): a guarda anterior so
# gravava quando o arquivo faltava, e quem esperava em
# `until [ -f .lms/veredito.json ]` lia o desfecho da rodada ANTERIOR.
finalizar() {
  estado="${1:-}"
  autorizado=0
  if [ -n "$estado" ]; then
    # Com argumento: o trigger julgou (scorecard validado). E a UNICA origem de
    # autorizacao — P1-1: aceite lido de arquivo jamais libera push.
    autorizado=1
  else
    # Sem argumento: o gate nao autorizou, mas o VEREDITO e da cadeia, nao do gate.
    # 1.4.2 (KDT-68): aqui o `accepted` que a cadeia acabara de gravar virava
    # `timeout` com tudo null, e o desfecho real sumia. O arquivo foi apagado no
    # inicio da rodada, entao o que estiver nele e desta cadeia.
    estado="$(veredito_estado)" || estado=""
  fi
  [ -n "$estado" ] || estado="timeout"

  # 1.4.1: o runner grava o veredito RICO (reviewer, refutador, score, subject) e o
  # trigger reescrevia por cima com nulls, na mesma rodada. Quando o estado final
  # bate com o que esta no arquivo, o arquivo e desta rodada (foi apagado no
  # inicio) e diz mais do que o trigger sabe — preserva. So reescreve quando o
  # trigger discorda, e ai os campos do desfecho vencido nao podem sobreviver.
  if [ "$(veredito_estado || true)" != "$estado" ]; then
    mkdir -p "$ROOT/.lms"
    printf '{\n  "estado": "%s",\n  "score": null,\n  "reviewer": null,\n  "refutador": null,\n  "subject": null,\n  "at": "%s"\n}\n' \
      "$estado" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$VEREDITO_FILE"
  fi

  echo "LMS VEREDITO: $estado" >&2
  if [ "$estado" = "accepted" ] && [ "$autorizado" = "1" ]; then exit 0; fi
  exit 1
}

if scorecard_ok; then
  echo "lms-trigger: scorecard OK"
  finalizar accepted
fi

if [ -f "$RUNNER" ]; then
  echo "lms-trigger: running headless reviewer chain…"
  if node "$RUNNER"; then
    if scorecard_ok; then
      echo "lms-trigger: scorecard accepted"
      finalizar accepted
    fi
    echo "lms-trigger: reviewer returned without a valid scorecard" >&2
  else
    # BLOQUEIA. Antes isto era `exit 0` com um warning, e o efeito era o oposto do
    # desenho documentado ("if all providers fail, publication stays blocked"):
    # quanto mais problema o código tinha, mais fácil passar, porque reprovação
    # legítima era lida como reviewer quebrado. O runner agora separa as duas
    # coisas e imprime qual foi.
    echo "lms-trigger: reviewer chain did not authorize this push" >&2
    echo "  Se um reviewer REPROVOU: leia .lms/last.json e trate os achados." >&2
    echo "  Se todos FALHARAM: veja .lms/fallback.log e rode 'pnpm lms:reviewer'." >&2
    echo "  Bypass consciente e sob sua responsabilidade: LMS_SKIP=1 git push …" >&2
    finalizar
  fi
else
  echo "lms-trigger: fallback runner missing at $RUNNER" >&2
fi

echo "lms-trigger: LMS scorecard missing/stale/below required score 5."
echo "  Run pnpm lms:reviewer (tmux session: $SESSION), ensure .lms/last.json, then retry push."
finalizar
