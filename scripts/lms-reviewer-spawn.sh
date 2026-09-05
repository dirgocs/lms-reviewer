#!/usr/bin/env bash
# LMS isolated reviewer: tmux session (D15). LMS_SPAWN_DETACHED=1 → never attach.
set -euo pipefail
ROOT="${LMS_REVIEWER_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT"

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

mkdir -p .lms

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

BOOTSTRAP="cd $(printf %q "$ROOT") && echo 'LMS reviewer session. Load local-merge-score. Greptile saiu do pipeline; apenas LMS.' && claude --model \"${LMS_CLAUDE_MODEL:-claude-opus-5}\" --effort high"
if command -v claude >/dev/null 2>&1; then
  tmux send-keys -t "$SESSION" "$BOOTSTRAP" C-m
else
  tmux send-keys -t "$SESSION" "cd $(printf %q "$ROOT") && echo 'claude CLI not found — run LMS manually: pnpm exec lms-reviewer'" C-m
fi

echo "Reviewer: tmux attach -t $SESSION"
if [ "${LMS_SPAWN_DETACHED:-0}" = "1" ]; then
  exit 0
fi
if [ -t 0 ] && [ -t 1 ]; then
  exec tmux attach -t "$SESSION"
fi
