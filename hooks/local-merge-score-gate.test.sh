#!/usr/bin/env bash
# Teste do gate LMS. Roda direto: bash .claude/hooks/local-merge-score-gate.test.sh
# Hermetico: cria repos git temporarios, nunca toca o repo real nem dispara reviewer.
set -uo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/local-merge-score-gate.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAKE_RUNNER="$TMP/fake-runner.mjs"
printf '#!/usr/bin/env node\nprocess.exit(9);\n' > "$FAKE_RUNNER"
chmod +x "$FAKE_RUNNER"

mkrepo() {
  d="$TMP/$1"; mkdir -p "$d"; git -C "$d" init -q
  git -C "$d" config user.email t@t; git -C "$d" config user.name t
  # O consumidor nao recebe scripts LMS vendorizados. O hook deve resolver a
  # classificacao de paths no pacote em que ele proprio esta instalado.
  printf '%s\n' '{"exemptPaths":["^custom/","^docs/","\\.(md|mdx|txt|rst)$"]}' > "$d/lms.config.json"
  printf 'x\n' > "$d/seed"; git -C "$d" add seed lms.config.json; git -C "$d" commit -qm seed
  printf '%s' "$d"
}

run() { # run <root> <cwd> <comando>
  # o payload leva o cwd, como o harness faz — e dele que sai a decisao quando
  # o comando nao tem `cd` nenhum (sessao ja posicionada noutro repo)
  printf '{"cwd":%s,"tool_input":{"command":%s}}' \
    "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$2")" \
    "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$3")" \
    | (cd "$2" && CLAUDE_PROJECT_DIR="$1" \
        LMS_REVIEWER_MODE=headless LMS_REVIEWER_RUNNER="$FAKE_RUNNER" \
        bash "$HOOK" 2>&1)
}

fails=0
check() { # check <nome> <substring esperada|VAZIO> <saida>
  if [ "$2" = "VAZIO" ]; then
    [ -z "$(printf '%s' "$3" | tr -d '[:space:]')" ] && { echo "ok    $1"; return; }
  else
    case "$3" in *"$2"*) echo "ok    $1"; return ;; esac
  fi
  echo "FALHA $1"; echo "      esperava: $2"; echo "      obteve:   $3"; fails=$((fails + 1))
}

REPO=$(mkrepo repo); EXT=$(mkrepo externo)
VERB_C="git commit"     # montado em runtime: o texto literal faria o gate
VERB_P="git push"       # disparar sobre este proprio arquivo de teste

# 1. comando sem acao gated nao produz nada
check "status nao e gated" VAZIO "$(run "$REPO" "$REPO" 'git status')"

# 2. mencao nao e execucao — heredoc e texto solto nao acionam o gate
check "verbo dentro de heredoc" VAZIO \
  "$(run "$REPO" "$REPO" "cat > /dev/null <<'EOF'
$VERB_P origin main
EOF")"
check "verbo citado em echo" VAZIO "$(run "$REPO" "$REPO" "echo 'como fazer: $VERB_P'")"
check "verbo no meio do texto" VAZIO "$(run "$REPO" "$REPO" "grep -rn '$VERB_C' docs/")"

# 3. acao gated em OUTRO repo e isenta — LMS so governa este projeto
check "commit em repo externo" VAZIO "$(run "$REPO" "$REPO" "cd $EXT && $VERB_C -m x")"
check "-C apontando para fora"  VAZIO "$(run "$REPO" "$REPO" "git -C $EXT commit -m x")"
check "push em repo externo"   VAZIO "$(run "$REPO" "$REPO" "cd $EXT && $VERB_P")"

# 3b. sessao posicionada noutro repo: comando seco, sem `cd`, sai de fora daqui
check "publish seco em outro repo" VAZIO "$(run "$REPO" "$EXT" "$VERB_P origin main")"
check "commit seco em outro repo"  VAZIO "$(run "$REPO" "$EXT" "$VERB_C -m x")"

# 4. so doc e isento; codigo e misto continuam barrados
printf '# doc\n' > "$REPO/nota.md"; git -C "$REPO" add nota.md
check "commit so markdown" "isento" "$(run "$REPO" "$REPO" "$VERB_C -m doc")"

printf 'export const a = 1\n' > "$REPO/a.ts"; git -C "$REPO" add a.ts
check "commit misto nao e isento" "LOCAL-MERGE-SCORE" "$(run "$REPO" "$REPO" "$VERB_C -m misto")"

git -C "$REPO" reset -q; git -C "$REPO" add a.ts
check "commit de codigo" "LOCAL-MERGE-SCORE" "$(run "$REPO" "$REPO" "$VERB_C -m code")"

# 5. commit -a arrasta o nao-indexado: codigo sujo nao passa como doc
git -C "$REPO" reset -q; git -C "$REPO" add nota.md
printf 'export const b = 2\n' > "$REPO/b.ts"; git -C "$REPO" add -N b.ts
check "commit -a com codigo sujo" "LOCAL-MERGE-SCORE" "$(run "$REPO" "$REPO" "$VERB_C -am tudo")"

# 5b. `-a` e FLAG, nao letra da mensagem: o pattern antigo casava o `-` do `-m` mais
#     qualquer "a" NA MENSAGEM — quase todo commit — e arrastava a arvore, destruindo
#     a isencao de doc na pratica. Mesmo estado do caso 5: doc indexado, b.ts sujo.
check "mensagem com 'a' nao arrasta a arvore" "isento" \
  "$(run "$REPO" "$REPO" "$VERB_C -m 'atualiza a nota'")"
check "-a separado segue arrastando" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$REPO" "$VERB_C -a -m doc")"
check "--all segue arrastando" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$REPO" "$VERB_C --all -m doc")"

# 6. ENVELOPES: o verbo continua abrindo o segmento, so que embrulhado. O AGENTS.md
#    manda rodar processo longo destacado — `nohup` nao e hipotese exotica aqui.
git -C "$REPO" reset -q; git -C "$REPO" add a.ts
for envelope in "nohup" "timeout 300" "exec" "command" "env -u FOO" "FOO=1 nohup" "setsid"; do
  check "envelope: $envelope + commit" "LOCAL-MERGE-SCORE" \
    "$(run "$REPO" "$REPO" "$envelope $VERB_C -m code")"
done
check "git -c antes do verbo" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$REPO" "git -c user.name=x commit -m code")"
check "git -c e -C juntos, repo externo" VAZIO \
  "$(run "$REPO" "$REPO" "git -c user.name=x -C $EXT commit -m x")"
check "envelope + push" "LOCAL-MERGE-SCORE" "$(run "$REPO" "$REPO" "nohup $VERB_P origin master")"

# 6c. SHELL ANINHADO: o verbo mora dentro do argumento de -c. A varredura por token
#     para no shell e liberava — e o --no-verify de dentro desliga o pre-push tambem,
#     entao esta composicao publicava sem LMS nenhum.
git -C "$REPO" reset -q; git -C "$REPO" add a.ts
for sh_ in "bash" "sh" "zsh"; do
  check "shell aninhado: $sh_ -c commit" "LOCAL-MERGE-SCORE" \
    "$(run "$REPO" "$REPO" "$sh_ -c '$VERB_C -m code'")"
done
check "shell aninhado com --no-verify" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$REPO" "bash -c '$VERB_P --no-verify origin master'")"
check "envelope + shell aninhado" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$REPO" "nohup bash -c '$VERB_P origin master'")"
# 6d. FLAGS AGRUPADAS: `-lc`, `-ce`, `-xc` sao a forma curta de escrever `-c`, e casar
#     `-c` exato deixava passar exatamente a composicao que o comentario do patch
#     anterior descreve como a pior — shell aninhado COM --no-verify.
for flags in "-lc" "-ce" "-xc"; do
  check "flag agrupada: bash $flags + push --no-verify" "LOCAL-MERGE-SCORE" \
    "$(run "$REPO" "$REPO" "bash $flags '$VERB_P --no-verify origin master'")"
done
check "flag agrupada: zsh -lc commit" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$REPO" "zsh -lc '$VERB_C -m code'")"

check "shell aninhado em repo externo segue isento" VAZIO \
  "$(run "$REPO" "$REPO" "bash -c 'cd $EXT && $VERB_C -m x'")"
check "shell aninhado sem verbo nao e gated" VAZIO \
  "$(run "$REPO" "$REPO" "bash -c 'ls -la'")"

# 6b. e a mencao continua isenta mesmo com envelope na frente
check "envelope nao transforma mencao em execucao" VAZIO \
  "$(run "$REPO" "$REPO" "nohup grep -rn '$VERB_C' docs/")"

# 7. DEFAULT INVERTIDO: barra por omissao. O gate parou de enumerar sintaxe de shell
#    (corrida que ele perde: tres rodadas do reviewer, tres formas novas) e passou a
#    exigir PROVA de que a linha e so mencao.
git -C "$REPO" reset -q; git -C "$REPO" add a.ts

# 7a. heredoc que alimenta INTERPRETADOR executa o corpo — nao pode ser apagado
check "heredoc para bash executa e e gated" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$REPO" "bash <<'EOF'
$VERB_P --no-verify origin master
EOF")"
check "heredoc para sh -s executa e e gated" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$REPO" "sh -s <<'EOF'
$VERB_C -m x
EOF")"
# 7b. e o heredoc que alimenta ARQUIVO continua sendo dado, nao comando
check "heredoc para arquivo segue isento" VAZIO \
  "$(run "$REPO" "$REPO" "cat > /tmp/nota.txt <<'EOF'
$VERB_P origin main
EOF")"

# 7c. programa que o parser NAO conhece, com verbo no texto: barra
for exotico in "xargs -I{} $VERB_P" "parallel $VERB_P" "meu-script-proprio $VERB_P"; do
  check "desconhecido com verbo barra: ${exotico%% *}" "LOCAL-MERGE-SCORE" \
    "$(run "$REPO" "$REPO" "$exotico")"
done

# 7d. mencao continua isenta — e isso e o que a inversao precisa preservar
check "git log --grep com verbo nao e gated" VAZIO \
  "$(run "$REPO" "$REPO" "git log --grep='$VERB_P' --oneline")"
check "sed citando o verbo nao e gated" VAZIO \
  "$(run "$REPO" "$REPO" "sed -n 's/$VERB_P//p' README.md")"

# 8. OPCOES GLOBAIS DO GIT: vinham antes do verbo e faziam o ramo `git` devolver
#    "nao gated" SEM cair no default fechado — a inversao nao alcancava justamente o
#    programa que mais importa.
git -C "$REPO" reset -q; git -C "$REPO" add a.ts
check "git --no-pager push --no-verify" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$REPO" "git --no-pager $VERB_P --no-verify origin master")"
check "git --git-dir=... push" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$REPO" "git --git-dir=$REPO/.git $VERB_P --no-verify")"
check "git -c k=v --no-pager commit" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$REPO" "git -c user.name=x --no-pager $VERB_C -m code")"
# e o verbo inofensivo com opcao global segue isento
# 8b. CAMINHO ABSOLUTO: `/usr/bin/git` nao e o token `git`, entao o ramo do git nem
#     rodava — e o default tambem nao reconhecia, porque as opcoes ficam no meio.
check "caminho absoluto do git com opcao global" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$REPO" "/usr/bin/git --no-pager $VERB_P --no-verify origin master")"
check "caminho absoluto do git, verbo inofensivo" VAZIO \
  "$(run "$REPO" "$REPO" "/usr/bin/git --no-pager status")"
# 8c. WRAPPER com opcoes entre o programa e o verbo.
#     `SO_PUSH`/`SO_COMMIT` sao o verbo SEM o `git` na frente: usar `$VERB_P` aqui
#     produzia `xargs git -C . git push`, com o par colado, e o teste passava pelo
#     motivo errado — sem exercitar o caminho que tem opcao com ARGUMENTO no meio.
SO_PUSH=${VERB_P#git }
SO_COMMIT=${VERB_C#git }
check "xargs git -C . push" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$REPO" "xargs git -C . $SO_PUSH --no-verify")"
check "parallel git --git-dir=.git push" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$REPO" "parallel git --git-dir=.git $SO_PUSH")"
check "argv com -C separado (forma python)" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$REPO" "python3 <<'PY'
import subprocess; subprocess.run(['git', '-C', '.', '$SO_PUSH'])
PY")"
check "xargs git -C . status segue isento" VAZIO \
  "$(run "$REPO" "$REPO" "xargs git -C . status")"

check "git --no-pager status nao e gated" VAZIO \
  "$(run "$REPO" "$REPO" "git --no-pager status")"

# 9. cwd EXTERNO com `git -C <esta raiz>`: a conjuncao saia pelo primeiro teste e
#    isentava publicacao DESTE repo por acidente.
check "cwd fora + git -C aponta para ca" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$EXT" "git -C $REPO $VERB_P --no-verify origin master")"
git -C "$REPO" reset -q
mkdir -p "$REPO/custom"; printf 'binario\n' > "$REPO/custom/corpus.bin"
git -C "$REPO" add custom/corpus.bin
check "cwd fora + git -C usa lms.config do projeto" "isento" \
  "$(run "$REPO" "$EXT" "git -C $REPO $SO_COMMIT -m corpus")"
git -C "$REPO" reset -q
check "cwd fora + git -C aponta para fora segue isento" VAZIO \
  "$(run "$REPO" "$EXT" "git -C $EXT $VERB_P origin master")"
# `--git-dir`/`--work-tree` apontam para um repo igual ao `-C`: honrar so o `-C` deixava
# a publicacao DESTE repo passar como externa quando o cwd do harness era outro.
check "cwd fora + --git-dir aponta para ca" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$EXT" "git --git-dir=$REPO/.git $VERB_P --no-verify origin master")"
check "cwd fora + --work-tree aponta para ca" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$EXT" "git --work-tree=$REPO --git-dir=$REPO/.git $VERB_C -m x")"
check "cwd fora + --git-dir aponta para fora segue isento" VAZIO \
  "$(run "$REPO" "$EXT" "git --git-dir=$EXT/.git $VERB_P origin master")"

# 10. heredoc para runtime que NAO e shell: corpo com execucao de processo e comando,
#     corpo que so cita o verbo em string e dado — senao toda edicao de arquivo escrita
#     com `python3 - <<PY` que mencione o verbo dispara a cadeia inteira.
check "python3 heredoc COM subprocess e gated" "LOCAL-MERGE-SCORE" \
  "$(run "$REPO" "$REPO" "python3 <<'PY'
import subprocess; subprocess.run(['git', 'push'])
PY")"
# 10b. programa FORA de qualquer lista que executa o corpo: enumerar interpretador e a
#      mesma corrida perdida do shell, entao o corpo volta por omissao.
for executor in "ssh host" "expect" "docker exec -i container"; do
  check "heredoc para ${executor%% *} e gated" "LOCAL-MERGE-SCORE" \
    "$(run "$REPO" "$REPO" "$executor <<'EOF'
$VERB_P --no-verify origin master
EOF")"
done
check "heredoc para tee segue isento" VAZIO \
  "$(run "$REPO" "$REPO" "tee /tmp/nota.txt <<'EOF'
$VERB_P origin master
EOF")"

check "python3 heredoc so citando segue isento" VAZIO \
  "$(run "$REPO" "$REPO" "python3 - <<'PY'
texto = '$VERB_P origin master'
open('/tmp/nota.txt', 'w').write(texto)
PY")"

[ "$fails" -eq 0 ] && { echo "todos passaram"; exit 0; }
echo "$fails falha(s)"; exit 1
