#!/usr/bin/env sh
# Self-check de scripts/lms-push-changed.sh. Pina a propriedade que importa: quando a base
# nao e determinavel, sai 1 (falha fechada) em vez de devolver lista vazia — lista vazia
# somada a isencao viraria "push sem gate".
#
#   sh scripts/lms-push-changed.test.sh
set -eu

S=$(cd -- "$(dirname -- "$0")" && pwd)/lms-push-changed.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
R="$TMP/repo"
ZERO=0000000000000000000000000000000000000000
fail=0

mkdir -p "$R"; cd "$R"
git init -q -b master; git config user.email t@t; git config user.name t
mkdir -p docs services
echo a > docs/a.md; echo b > services/b.ts
git add -A; git commit -qm base
BASE=$(git rev-parse HEAD)
# finge um remoto: origin/master aponta para o commit base
git update-ref refs/remotes/origin/master "$BASE"
git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master

echo doc >> docs/a.md; git add -A; git commit -qm doc
DOC=$(git rev-parse HEAD)
echo code >> services/b.ts; git add -A; git commit -qm code
CODE=$(git rev-parse HEAD)

check() { # check <nome> <esperado-rc> <esperado-grep|-> <stdin>
  nome=$1; erc=$2; egrep=$3; entrada=$4
  saida=$(printf '%s\n' "$entrada" | sh "$S" 2>/dev/null) && rc=0 || rc=1
  [ "$rc" = "$erc" ] || { echo "FALHOU: $nome — esperava rc $erc, veio $rc"; fail=1; return; }
  [ "$egrep" = "-" ] && return
  printf '%s\n' "$saida" | grep -q "$egrep" || {
    echo "FALHOU: $nome — esperava /$egrep/ na saida, veio: $(printf '%s' "$saida" | tr '\n' ' ')"; fail=1; }
}

# ref conhecida no remoto: diff remote_sha..local_sha
check "ref existente, so doc"  0 'docs/a.md'    "refs/heads/master $DOC refs/heads/master $BASE"
check "ref existente, codigo"  0 'services/b.ts' "refs/heads/master $CODE refs/heads/master $DOC"

# ref nova: cai no merge-base com origin/HEAD
check "ref nova"               0 'docs/a.md'    "refs/heads/nova $DOC refs/heads/nova $ZERO"

# deletando ref: nada entra
check "delete ref"             0 -              "refs/heads/x $ZERO refs/heads/x $BASE"
saida=$(printf '%s\n' "refs/heads/x $ZERO refs/heads/x $BASE" | sh "$S")
[ -z "$(printf '%s' "$saida" | tr -d '[:space:]')" ] || { echo "FALHOU: delete ref devia sair vazio"; fail=1; }

# base indeterminavel: sha que nao existe no repo -> rc 1, NUNCA lista vazia com rc 0
check "base indeterminavel"    1 -              "refs/heads/nova 1111111111111111111111111111111111111111 refs/heads/nova $ZERO"

# a composicao que o hook faz: determinado + so-doc = isento; determinado + codigo = barrado
E=$(cd -- "$(dirname -- "$S")" && pwd)/lms-exempt-paths.mjs
printf '%s\n' "refs/heads/master $DOC refs/heads/master $BASE" | sh "$S" | node "$E" \
  || { echo "FALHOU: push so de doc deveria ser isento"; fail=1; }
printf '%s\n' "refs/heads/master $CODE refs/heads/master $DOC" | sh "$S" | node "$E" \
  && { echo "FALHOU: push com codigo NAO pode ser isento"; fail=1; } || true

[ "$fail" = 0 ] && echo "lms-push-changed: ok (8 checagens)" || { echo "lms-push-changed: FALHOU"; exit 1; }
