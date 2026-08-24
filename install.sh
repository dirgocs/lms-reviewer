#!/usr/bin/env bash
# Instala o gate LMS num projeto qualquer.
#
#   ./install.sh /caminho/do/projeto
#
# O trigger resolve a raiz sozinho (LMS_REVIEWER_ROOT ou `git rev-parse`), mas
# espera os módulos em <raiz>/scripts/ — é por isso que a instalação copia para lá
# em vez de virar dependência de node_modules.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-$PWD}"
[ -d "$TARGET" ] || { echo "projeto inexistente: $TARGET"; exit 1; }
TARGET="$(cd "$TARGET" && pwd)"
git -C "$TARGET" rev-parse --show-toplevel >/dev/null 2>&1 \
  || { echo "$TARGET nao e repo git — o gate revisa um diff, precisa de git"; exit 1; }

echo "==> copiando modulos para $TARGET/scripts/"
mkdir -p "$TARGET/scripts"
for f in "$SRC"/scripts/lms-*.mjs "$SRC"/scripts/lms-*.sh; do
  cp "$f" "$TARGET/scripts/$(basename "$f")"
done
chmod +x "$TARGET/scripts/lms-reviewer-trigger.sh" "$TARGET/scripts/lms-reviewer-spawn.sh"

echo "==> config de exemplo"
if [ ! -f "$TARGET/lms.config.json" ]; then
  cp "$SRC/lms.config.example.json" "$TARGET/lms.config.example.json"
  echo "    lms.config.example.json copiado — SEM lms.config.json o gate roda como"
  echo "    revisor puro de diff, que ja e util. Configure so o que o projeto tem."
fi

echo "==> .gitignore"
GI="$TARGET/.gitignore"
if ! grep -qxF '.lms/' "$GI" 2>/dev/null; then
  printf '\n# lms-reviewer: scorecard e logs da cadeia\n.lms/\n' >> "$GI"
fi

echo "==> hook de pre-push"
HOOK=""
if [ -d "$TARGET/.husky" ]; then HOOK="$TARGET/.husky/pre-push"
else HOOK="$TARGET/.git/hooks/pre-push"; fi

SNIPPET='# LMS auto-trigger (bloqueia o push ate a cadeia de revisao aprovar)
if [ -f "$ROOT/scripts/lms-reviewer-trigger.sh" ]; then
  bash "$ROOT/scripts/lms-reviewer-trigger.sh" || exit 1
fi'

if [ -f "$HOOK" ] && grep -q 'lms-reviewer-trigger' "$HOOK"; then
  echo "    ja presente em $HOOK"
elif [ -f "$HOOK" ]; then
  printf '\n%s\n' "$SNIPPET" >> "$HOOK"
  echo "    acrescentado ao $HOOK existente"
  grep -q 'ROOT=' "$HOOK" || echo "    ATENCAO: o hook nao define \$ROOT — ajuste a mao"
else
  mkdir -p "$(dirname "$HOOK")"
  cat > "$HOOK" <<EOF
#!/usr/bin/env sh
export PATH="\$HOME/.local/bin:\$HOME/.grok/bin:\$PATH"
ROOT=\$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "\$ROOT" || exit 1

$SNIPPET
EOF
  chmod +x "$HOOK"
  echo "    criado $HOOK"
fi

cat <<EOF

Pronto. Antes do primeiro push:
  1. Os tres CLIs revisores precisam estar no PATH e logados: claude, grok, codex.
     Ordem e modelos saem de env (LMS_REVIEWER_ORDER, LMS_*_MODEL, LMS_*_BIN).
  2. Rode os testes: cd $SRC && npm test
  3. O gate BLOQUEIA o push. Bypass e explicito e fica no log — nao e silencioso.
EOF
