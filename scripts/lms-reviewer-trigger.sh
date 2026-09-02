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

scorecard_ok() {
  [ -f "$PACKAGE_ROOT/scripts/lms-scorecard.mjs" ] || return 1
  node "$PACKAGE_ROOT/scripts/lms-scorecard.mjs" \
    --file "$SCORECARD" \
    --base "$BASE_REF" \
    --max-age-sec "$MAX_AGE" \
    >/dev/null 2>&1
}

if scorecard_ok; then
  echo "lms-trigger: scorecard OK"
  exit 0
fi

if [ -f "$RUNNER" ]; then
  echo "lms-trigger: running headless reviewer chain…"
  if node "$RUNNER"; then
    if scorecard_ok; then
      echo "lms-trigger: scorecard accepted"
      exit 0
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
    exit 1
  fi
else
  echo "lms-trigger: fallback runner missing at $RUNNER" >&2
fi

echo "lms-trigger: LMS scorecard missing/stale/below required score 5."
echo "  Run pnpm lms:reviewer (tmux session: $SESSION), ensure .lms/last.json, then retry push."
exit 1
