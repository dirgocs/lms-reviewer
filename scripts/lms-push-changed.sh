#!/usr/bin/env sh
# Lista os arquivos que um push levaria, a partir do stdin que o git entrega ao pre-push:
#
#   <local ref> <local sha> <remote ref> <remote sha>
#
#   git ... | scripts/lms-push-changed.sh
#     exit 0 + lista no stdout  -> conjunto determinado
#     exit 1                    -> nao foi possivel determinar a base
#
# Existe separado do hook por um motivo so: e a parte que decide o INSUMO do gate, e a
# unica com como errar em silencio. Testavel em `scripts/lms-push-changed.test.sh`.
#
# Ref nova (remote sha zerado) nao tem base no remoto: usa o merge-base com o branch
# default do remoto. Nao achar base sai 1 — quem chama trata isso como "nao isento".
# Falha fechada: nao saber quais arquivos vao nao e o mesmo que saber que nao ha codigo.
set -eu

ZERO=0000000000000000000000000000000000000000
out=""

while read -r _lref lsha _rref rsha; do
  [ -n "${lsha:-}" ] || continue
  [ "$lsha" = "$ZERO" ] && continue          # deletando ref: nada de codigo entra
  if [ "${rsha:-$ZERO}" = "$ZERO" ]; then
    default=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/master)
    base=$(git merge-base "$lsha" "$default" 2>/dev/null || true)
  else
    base=$rsha
  fi
  [ -n "$base" ] || exit 1
  out="$out
$(git diff --name-only "$base" "$lsha" 2>/dev/null || true)"
done

printf '%s\n' "$out" | grep -v '^[[:space:]]*$' || true
exit 0
