#!/usr/bin/env bash
# LMS isolated reviewer: ensure pxpipe → set env → tmux session (D15–D17).
# Master never toggles imaging; resolve_pxpipe_models is fully automatic.
# LMS_SPAWN_DETACHED=1 → never attach (for hooks/pre-push).
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
# shellcheck source=lib/resolve-pxpipe-models.sh
source "$ROOT/scripts/lib/resolve-pxpipe-models.sh" 2>/dev/null || true

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
PXPIPE_URL="${PXPIPE_URL:-http://127.0.0.1:47821}"
PXPIPE_BIN="${PXPIPE_BIN:-pxpipe-proxy}"   # global name or npx fallback

mkdir -p .lms

# --- A. Proxy always preferred ---
proxy_up() {
  curl -sf -o /dev/null --max-time 1 "$PXPIPE_URL/" 2>/dev/null \
    || curl -sf -o /dev/null --max-time 1 "$PXPIPE_URL" 2>/dev/null
}
if ! proxy_up; then
  if command -v "$PXPIPE_BIN" >/dev/null 2>&1; then
    nohup "$PXPIPE_BIN" >> .lms/pxpipe.log 2>&1 &
    echo $! > .lms/pxpipe.pid
    sleep 1
  elif command -v npx >/dev/null 2>&1; then
    # pxpipe-proxy may not be installed; attempt start, tolerate failure (graceful OFF)
    nohup npx --yes pxpipe-proxy >> .lms/pxpipe.log 2>&1 &
    echo $! > .lms/pxpipe.pid
    sleep 2
  fi
fi

USE_PROXY=0
if proxy_up; then
  USE_PROXY=1
  export ANTHROPIC_BASE_URL="$PXPIPE_URL"
  # B. Auto models — no Master toggle
  if type resolve_pxpipe_models >/dev/null 2>&1; then
    export PXPIPE_MODELS
    PXPIPE_MODELS="$(resolve_pxpipe_models)"
  else
    export PXPIPE_MODELS="${PXPIPE_MODELS:-off}"
  fi
  echo "pxpipe: ON url=$PXPIPE_URL models=$PXPIPE_MODELS" | tee -a .lms/spawn.log
else
  if [ "${LMS_REQUIRE_PXPIPE:-0}" = "1" ]; then
    echo "pxpipe failed to start (install pxpipe-proxy or unset LMS_REQUIRE_PXPIPE)" >&2
    echo "  pending: real pxpipe smoke once package is installed on this machine" >&2
    exit 1
  fi
  unset ANTHROPIC_BASE_URL || true
  echo "pxpipe: OFF (proxy down) — reviewer without compression" | tee -a .lms/spawn.log
  echo "  note: pxpipe-proxy not installed or failed to start; graceful OFF" | tee -a .lms/spawn.log
fi

# Persist decision for the session (debug, not a toggle UI)
printf '%s\n' \
  "url=${ANTHROPIC_BASE_URL:-direct}" \
  "models=${PXPIPE_MODELS:-n/a}" \
  "proxy=${USE_PROXY}" \
  "at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .lms/pxpipe-session.env

# --- C. tmux ---
if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found — cannot open isolated reviewer session" >&2
  if [ "${LMS_SPAWN_DETACHED:-0}" = "1" ]; then
    exit 0
  fi
  exit 1
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "reviewer session already running: tmux attach -t $SESSION"
  if [ "${LMS_SPAWN_DETACHED:-0}" = "1" ]; then
    exit 0
  fi
  exec tmux attach -t "$SESSION"
fi

tmux new-session -d -s "$SESSION" -c "$ROOT"
[ -n "${ANTHROPIC_BASE_URL:-}" ] && tmux set-environment -t "$SESSION" ANTHROPIC_BASE_URL "$ANTHROPIC_BASE_URL"
[ -n "${PXPIPE_MODELS:-}" ] && tmux set-environment -t "$SESSION" PXPIPE_MODELS "$PXPIPE_MODELS"

# Bootstrap prompt: LMS skill path; greploop denylisted for auto spend
BOOTSTRAP="cd $(printf %q "$ROOT") && echo 'LMS reviewer session. Load local-merge-score. No @greptile/greploop unless Master asked.' && claude --model \"${LMS_CLAUDE_MODEL:-claude-opus-4-8}\" --effort high"
if command -v claude >/dev/null 2>&1; then
  tmux send-keys -t "$SESSION" "$BOOTSTRAP" C-m
else
  tmux send-keys -t "$SESSION" "cd $(printf %q "$ROOT") && echo 'claude CLI not found — run LMS manually: see .agents/skills/local-merge-score/SKILL.md'" C-m
fi

echo "Reviewer: tmux attach -t $SESSION"
echo "Dashboard (if proxy on): $PXPIPE_URL/"
if [ "${LMS_SPAWN_DETACHED:-0}" = "1" ]; then
  exit 0
fi
# Interactive attach only when not detached
if [ -t 0 ] && [ -t 1 ]; then
  exec tmux attach -t "$SESSION"
fi
