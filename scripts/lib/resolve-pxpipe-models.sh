#!/usr/bin/env bash
# resolve_pxpipe_models — auto imaging allowlist for LMS reviewer (D17).
# Sourced by lms-reviewer-spawn.sh from PACKAGE_ROOT. No Master daily toggles.
#
# Pref list: LMS_PXPIPE_CANDIDATES or built-in (update when Anthropic renames models).
# Intersection empty → PXPIPE_MODELS=off (pass-through).

LMS_PXPIPE_CANDIDATES="${LMS_PXPIPE_CANDIDATES:-claude-fable-5,gpt-5.6}"

resolve_pxpipe_models() {
  local candidates available intersection="" c
  local root="${ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  IFS=',' read -ra candidates <<< "$LMS_PXPIPE_CANDIDATES"

  # available: models this machine/sub can use (best-effort, no Master UI)
  available="$(
    {
      # 1) explicit session default
      [ -n "${ANTHROPIC_MODEL:-}" ] && echo "$ANTHROPIC_MODEL"
      # 2) optional machine file written by a rare setup step (not daily toggle)
      [ -f "$root/.lms/available-models.txt" ] && cat "$root/.lms/available-models.txt"
      # 3) probe: if claude can run with model flag — optional, skip if slow
    } | tr ',\n' '\n' | sed '/^$/d' | sort -u
  )"

  # If we cannot detect anything, do NOT guess Fable still exists — safer off
  if [ -z "$available" ]; then
    # Prefer imaging if candidates non-empty AND pxpipe is up: pass candidates through
    # and let pxpipe pass-through unknown models as text. OR set off if LMS_PXPIPE_STRICT_DETECT=1
    if [ "${LMS_PXPIPE_STRICT_DETECT:-0}" = "1" ]; then
      echo "off"
      return
    fi
    # Non-strict: export candidates; pxpipe skips imaging for models not in its registry
    echo "$LMS_PXPIPE_CANDIDATES"
    return
  fi

  for c in "${candidates[@]}"; do
    c="$(echo "$c" | tr -d ' ')"
    [ -z "$c" ] && continue
    if echo "$available" | grep -qxF "$c"; then
      intersection="${intersection:+$intersection,}$c"
    fi
  done

  if [ -z "$intersection" ]; then
    echo "off"   # Fable gone, 5.6 not on sub → pass-through only, zero manual work
  else
    echo "$intersection"
  fi
}
