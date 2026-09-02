#!/usr/bin/env bash
# PreToolUse gate: LMS context + auto-trigger on push/pr (D18).
# - git push / gh pr create|edit: run lms-reviewer-trigger.sh; block if ≠ 0
# - git commit: inject only (unless LMS_TRIGGER_ON_COMMIT=1 → spawn non-blocking)
# - LMS_HOOK_STRICT=1 also forces block on commit path when scorecard bad
#
# Scorecard: .lms/last.json  Bypass: LMS_HOOK_SKIP=1 / LMS_SKIP=1
set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
SCORECARD="${ROOT}/.lms/last.json"
MAX_AGE_SEC="${LMS_HOOK_MAX_AGE_SEC:-7200}"
MIN_SCORE="${LMS_HOOK_MIN_SCORE:-5}"
TRIGGER="${PACKAGE_ROOT}/scripts/lms-reviewer-trigger.sh"
EXEMPT_PATHS="${PACKAGE_ROOT}/scripts/lms-exempt-paths.mjs"
SPAWN="${PACKAGE_ROOT}/scripts/lms-reviewer-spawn.sh"

INPUT=$(cat || true)
CMD=$(python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    d={}
print((d.get('tool_input') or d).get('command') or '')
" <<<"$INPUT" 2>/dev/null || true)

# Casar o texto cru do comando fazia o gate disparar em quem so MENCIONA o verbo:
# um `cat > arquivo <<EOF` cujo corpo cita a publicacao, um grep, um echo. No
# caminho de publish isso chegava a rodar a cadeia de reviewer inteira e bloquear
# uma simples escrita de arquivo. Duas defesas:
#   a) corpo de heredoc sai do texto analisado (e dado, nao comando);
#   b) o verbo so conta se ABRE um segmento (aceitando VAR=x, sudo e -C <path>).
CMD_SCAN=$(python3 "${BASH_SOURCE%/*}/lms-strip-heredoc.py" <<<"$CMD" 2>/dev/null || printf '%s' "$CMD")

# O diretorio corrente do shell NAO aparece no texto do comando: uma sessao que
# ja esta noutro repo publica com um `push` seco, sem `cd` nenhum. Olhar so o
# texto fazia o gate barrar push do vault megamente. O harness manda o cwd no
# payload; e ele que decide de onde o comando sai.
CWD_IN=$(python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
print(d.get('cwd') or '')
" <<<"$INPUT" 2>/dev/null || true)

# O verbo so conta se ABRE um segmento — mencao nao e execucao. Mas ancorar por regex
# num prefixo fechado (`VAR=x` e `sudo`) deixou passar o idioma da casa: o AGENTS.md
# manda rodar processo longo destacado, e `nohup git push` nao era barrado. `timeout`,
# `env -u VAR`, `exec` e `git -c k=v push` tinham o mesmo furo — um gate que o AGENTS.md
# chama de inegociavel saindo com 0 em silencio.
#
# Varredura por TOKEN: pula envelope conhecido, opcao, atribuicao, duracao de `timeout`
# e nome de variavel de `env -u`; para no primeiro token que e um programa de verdade.
# `echo 'como fazer: git push'` para em `echo` e segue isento, que e o ponto da ancora.
lms_gated_kind() { # ecoa publish|commit e retorna 0; 1 se o segmento nao e gated
  local prog='' verbo='' profundidade="${2:-0}" segmento_bruto="$1"
  set -f                    # sem glob: o segmento e texto, nao padrao de arquivo
  # shellcheck disable=SC2086
  set -- $1
  while [ $# -gt 0 ]; do
    case "$1" in
      '('|'{'|'!'|-*|*=*) shift; continue ;;
      sudo|nohup|exec|command|env|time|timeout|stdbuf|setsid|nice|ionice) shift; continue ;;
      [0-9]*) shift; continue ;;          # duracao de `timeout 300`
      [A-Z]*) shift; continue ;;          # nome de variavel de `env -u VAR`
    esac
    prog="$1"; shift; break
  done
  # `/usr/bin/git` e `git` sao o mesmo programa: sem o basename, o ramo do git nao rodava
  # com caminho absoluto e a linha caía no default — que, por sua vez, também não a
  # reconhecia. O `lms-strip-heredoc.py` já fazia basename; o gate, não.
  prog=${prog##*/}

  # `bash -c 'git push --no-verify'`: o programa real e o SHELL, e o verbo mora dentro
  # do argumento. A varredura por token, sozinha, para em `bash` e libera — o casamento
  # por substring que ela substituiu pegava este caso, entao fechar o furo do `nohup`
  # sem tratar shell aninhado TROCOU um buraco por outro. E o pior deles: o `--no-verify`
  # de dentro tambem desliga o pre-push, entao nada barra a publicacao.
  case "$prog" in
    sh | bash | zsh | dash | ksh | ash)
      set +f
      # Teto de recursao: `bash -c "bash -c ..."` e legitimo, aninhamento infinito nao.
      # Teto estourado nao e alvara: se ainda ha verbo de publicacao no texto, barra.
      if [ "$profundidade" -ge 3 ]; then
        lms_texto_publica "$segmento_bruto" && { printf 'publish'; return 0; }
        return 1
      fi
      # `-lc`, `-ce`, `-xc`: a flag do script vem AGRUPADA com as outras, e casar `-c`
      # exato deixava passar justamente a forma mais curta de escrever isto. Qualquer
      # flag curta que contenha `c` abre script; `--long` nao.
      local interno=''
      while [ $# -gt 0 ]; do
        case "$1" in
          --*) ;;
          -*c*) shift; interno="$*"; break ;;
        esac
        shift
      done
      # Sem script identificavel, mas com verbo de publicacao no texto: barra. Um shell
      # que o parser nao entende e o pior lugar para presumir inocencia.
      if [ -z "$interno" ]; then
        lms_texto_publica "$segmento_bruto" && { printf 'publish'; return 0; }
        return 1
      fi
      # As aspas sobrevivem ao split e atrapalham o reconhecimento do verbo.
      interno=${interno//\"/}
      interno=${interno//\'/}
      lms_gated_kind "$interno" "$((profundidade + 1))"
      return $?
      ;;
  esac

  if [ "$prog" = 'git' ]; then
    # Opcoes GLOBAIS do git, antes do verbo. Consumir so `-C`/`-c` fazia
    # `git --no-pager push --no-verify` e `git --git-dir=... push` nao serem
    # classificados como publicacao — e, pior, este ramo dava `return 1` sem cair no
    # default fechado, entao a inversao nao alcancava justamente o programa que mais
    # importa aqui.
    while [ $# -gt 0 ]; do
      case "$1" in
        -C | -c | --git-dir | --work-tree | --namespace | --exec-path | --super-prefix)
          shift 2 || break
          ;;
        --git-dir=* | --work-tree=* | --namespace=* | --exec-path=* | --super-prefix=* | \
          --no-pager | --paginate | --no-replace-objects | --bare | --literal-pathspecs | \
          --glob-pathspecs | --noglob-pathspecs | --icase-pathspecs | -P | -p)
          shift
          ;;
        *) break ;;
      esac
    done
    verbo="${1:-}"
    set +f
    [ "$verbo" = 'push' ] && { printf 'publish'; return 0; }
    [ "$verbo" = 'commit' ] && { printf 'commit'; return 0; }
    # Verbo conhecido e inofensivo: `git log --grep='git push'` cita sem executar, e
    # quem manda e o VERBO, nao o texto solto da linha.
    case "$verbo" in
      status | log | diff | show | rev-parse | rev-list | ls-files | ls-tree | branch | \
        remote | config | fetch | stash | add | restore | checkout | switch | reset | \
        merge-base | describe | blame | grep | cat-file | worktree | tag | clean | apply | \
        cherry-pick | rebase | revert | init | clone | help | var | shortlog | count-objects)
        return 1
        ;;
    esac
    # Verbo que o parser nao reconhece (alias, plugin, ou forma que ele nao entende):
    # falha FECHADA se ainda houver verbo de publicacao no texto.
    lms_texto_publica "$segmento_bruto" && { printf 'publish'; return 0; }
    return 1
  fi
  if [ "$prog" = 'gh' ] && [ "${1:-}" = 'pr' ]; then
    case "${2:-}" in create|edit) set +f; printf 'publish'; return 0 ;; esac
    set +f
    return 1
  fi
  set +f

  # DEFAULT INVERTIDO: barra por omissao.
  #
  # Tres rodadas seguidas do reviewer acharam formas DIFERENTES de escapar do mesmo
  # gate — `bash -c`, depois `-lc`/`-ce`/`-xc`, depois heredoc que alimenta shell.
  # Cada conserto fechava a forma reproduzida e deixava a proxima da mesma familia.
  # Enumerar sintaxe de shell e uma corrida que o gate perde: sempre ha mais uma forma.
  #
  # Entao a pergunta muda. Nao e mais "esta linha e reconhecidamente uma publicacao?",
  # e sim "da para PROVAR que ela e so mencao?". Ferramenta de texto recebendo o verbo
  # como argumento e mencao; qualquer outra coisa com verbo de publicacao no texto
  # BARRA — inclusive programa que o parser nao conhece. Falso positivo custa uma
  # rodada de cadeia; falso negativo publica sem gate.
  case "$prog" in
    echo | printf | grep | egrep | fgrep | rg | ag | sed | awk | cat | less | more \
      | head | tail | wc | diff | comm | jq | yq | column | sort | uniq)
      return 1
      ;;
  esac

  if lms_texto_publica "$segmento_bruto"; then
    printf 'publish'
    return 0
  fi
  return 1
}

# O verbo no TEXTO — por varredura de TOKEN, nao por regex.
#
# A regex anterior exigia que entre `git` e o verbo houvesse so aspas, espaco ou virgula.
# Isso cobria a forma argv (`subprocess.run(['git', 'push'])`) e perdia tudo que leva
# opcao no meio: `xargs git -C . push`, `parallel git --git-dir=.git push`. Cada padrao
# novo pedia mais um caractere na classe — a mesma corrida perdida de sempre.
#
# Aqui os tokens sao percorridos: achou `git` (ou `/usr/bin/git`), pula o que for opcao,
# atribuicao ou caminho, e olha o proximo token de verdade.
lms_texto_publica() {
  local -a toks
  # Aspas, colchetes, parenteses e virgula viram SEPARADOR, nao lixo a remover: em
  # `subprocess.run(['git', 'push'])` o `git` esta colado no que vem antes, e apagar os
  # caracteres produzia `subprocess.rungit` em vez de dois tokens.
  local texto=${1//[\[\]()\'\",]/ }
  set -f
  # shellcheck disable=SC2086
  toks=($texto)
  set +f
  local i=0 t base j prox
  while [ "$i" -lt "${#toks[@]}" ]; do
    t=${toks[$i]}
    base=${t##*/}
    if [ "$base" = 'git' ] || [ "$base" = 'gh' ]; then
      j=$((i + 1))
      while [ "$j" -lt "${#toks[@]}" ]; do
        prox=${toks[$j]}
        case "$prox" in
          # Opcao que LEVA ARGUMENTO: pular so ela deixava o caminho (`.` em
          # `git -C . push`) no lugar do verbo, e a funcao devolvia "nao publica".
          -C | -c | --git-dir | --work-tree | --namespace | --exec-path | --super-prefix)
            j=$((j + 2))
            continue
            ;;
          -*) j=$((j + 1)); continue ;;   # opcao sem argumento, ou com `=`
          *=*) j=$((j + 1)); continue ;;
          '') j=$((j + 1)); continue ;;
        esac
        break
      done
      prox=${toks[$j]:-}
      if [ "$base" = 'git' ]; then
        case "$prox" in push | commit) return 0 ;; esac
      else
        case "$prox" in pr) return 0 ;; esac
      fi
    fi
    i=$((i + 1))
  done
  return 1
}

# `commit -a` reconhecido como FLAG, nao como substring. O pattern antigo
# (`*git\ commit*-*a*`) casava o `-` do `-m` mais qualquer "a" DA MENSAGEM — quase
# todo commit — e arrastava o diff nao-indexado para o conjunto de arquivos, matando
# na pratica a isencao de doc/tooling. Aqui so conta flag de verdade: apos o token
# `commit`, `--all` exato, ou `a` num cluster curto ANTES da primeira opcao que toma
# valor (`-m`, `-c`, `-C`, `-F`, `-t`) — dali em diante o resto do cluster e
# mensagem/arquivo, nao flag (`-madoc` e a mensagem "adoc", nao `-a`).
# Residuo aceito: token de OUTRO segmento depois de um `commit` pode conter `a` e
# arrastar a arvore sem precisar — direcao fechada, igual ao pattern antigo.
lms_commit_arrasta_worktree() {
  set -f
  # shellcheck disable=SC2086
  set -- $1
  set +f
  local apos_commit=0 tok cluster i c
  for tok in "$@"; do
    if [ "$apos_commit" -eq 0 ]; then
      [ "${tok##*/}" = 'commit' ] && apos_commit=1
      continue
    fi
    case "$tok" in
      --all) return 0 ;;
      --*) continue ;;
      -?*)
        cluster=${tok#-}
        i=0
        while [ "$i" -lt "${#cluster}" ]; do
          c=${cluster:$i:1}
          case "$c" in
            a) return 0 ;;
            m | c | C | F | t) break ;;
          esac
          i=$((i + 1))
        done
        ;;
    esac
  done
  return 1
}

lms_any_gated=0
while IFS= read -r seg; do
  lms_gated_kind "$seg" >/dev/null && lms_any_gated=1
done < <(printf '%s\n' "$CMD_SCAN" | tr ';&|' '\n')
[ "$lms_any_gated" -eq 1 ] || exit 0

if [ "${LMS_HOOK_SKIP:-}" = "1" ] || [ "${LMS_SKIP:-}" = "1" ]; then
  exit 0
fi

# LMS scores code, so it only governs commits and publishes of THIS repo. A command aimed at
# another repository (`git -C <path> push`, or `cd <path> && git push` — e.g. the
# megamente memory vault) was being judged against this project's scorecard.
# A isenção só vale quando NENHUMA parte do comando publica este repo. Antes ela
# olhava apenas o PRIMEIRO `git -C` e saía com exit 0 — então
# `git -C /tmp/outro status && git push` era isentado pelo primeiro trecho e o push
# deste repo passava sem gate. Furo apontado pelo reviewer (codex, P1 conf=98).
#
# Regra agora: divide o comando nos separadores de shell, e a isenção exige que
# TODO segmento que publique aponte para fora daqui.
root_abs=$(readlink -f "$ROOT" 2>/dev/null || printf '%s' "$ROOT")

segment_is_external() {
  seg="$1"
  seg_target=""
  case "$seg" in
    # `-C` em qualquer posicao depois do `git`, nao so colado nele: `git -c k=v -C <path>`
    # e valido e escapava do casamento antigo, que exigia o literal "git -C ". So chega
    # aqui segmento ja classificado como git/gh, entao `-C` e sempre a opcao do git.
    *" -C "*)    seg_target=$(sed -n 's/.* -C \([^ ;&|]*\).*/\1/p'    <<<"$seg" | head -1) ;;
    *"cd "*)     seg_target=$(sed -n 's/.*cd \([^ ;&|]*\).*/\1/p'     <<<"$seg" | head -1) ;;
  esac
  [ -n "$seg_target" ] || return 1
  seg_abs=$(readlink -f "$seg_target" 2>/dev/null || printf '%s' "$seg_target")
  case "$seg_abs" in
    "$root_abs" | "$root_abs"/*) return 1 ;;
    *) return 0 ;;
  esac
}

# O ALVO EFETIVO do segmento, e nao uma conjuncao entre cwd e `-C`.
#
# A forma anterior — `cwd_external == 0 && ! segment_is_external` — saia pelo primeiro
# teste quando o cwd do harness era externo, e aí `git -C <ESTA raiz> push --no-verify`
# nunca chegava a ser avaliado: publicacao daqui, isentada por acidente, com o
# `--no-verify` pulando o husky junto.
#
# Regra: `git -C <path>` decide sozinho, porque afeta apenas o proprio comando e vence o
# diretorio corrente. Sem `-C`, quem decide e o cwd vigente (que um `cd` anterior pode
# ter deslocado).
segment_is_internal() {
  seg="$1"
  # `-C` NÃO é o único jeito de o git apontar para um repositório. `--git-dir` e
  # `--work-tree` fazem o mesmo, e honrar só o `-C` deixava
  # `git --git-dir=<esta raiz>/.git push --no-verify`, disparado de /tmp, ser
  # classificado como publicação EXTERNA — gate sai 0 e o `--no-verify` desliga o husky.
  alvo=''
  for padrao in ' -C \([^ ;&|]*\)' '--git-dir[= ]\([^ ;&|]*\)' '--work-tree[= ]\([^ ;&|]*\)'; do
    achado=$(sed -n "s/.*${padrao}.*/\1/p" <<<"$seg" | head -1)
    if [ -n "$achado" ]; then
      # `.git` aponta para o repositório um nível acima.
      case "$achado" in */.git | */.git/) achado=${achado%/.git*} ;; esac
      alvo="$achado"
      break
    fi
  done
  if [ -n "$alvo" ]; then
    alvo_abs=$(readlink -f "$alvo" 2>/dev/null || printf '%s' "$alvo")
    case "$alvo_abs" in
      "$root_abs" | "$root_abs"/*) return 0 ;;
      *) return 1 ;;
    esac
  fi
  [ "$cwd_external" -eq 0 ]
}

all_publishes_external=1
saw_publish=0
is_publish=0
# `cd <externo> && git push` é legítimo: o `cd` muda o diretório dos segmentos
# seguintes. Já `git -C <externo>` afeta APENAS o próprio comando — um `git push`
# solto depois dele publica daqui. Confundir os dois era o bypass.
cwd_external=0
if [ -n "$CWD_IN" ]; then
  cwd_in_abs=$(readlink -f "$CWD_IN" 2>/dev/null || printf '%s' "$CWD_IN")
  case "$cwd_in_abs" in
    "$root_abs" | "$root_abs"/*) cwd_external=0 ;;
    *) cwd_external=1 ;;
  esac
fi
while IFS= read -r segment; do
  [ -n "$segment" ] || continue

  # Só `cd` desloca o diretório corrente dos próximos segmentos.
  # A aspa conta como fronteira: em `bash -c \'cd /outro && git commit\'` o `cd` vem
  # colado no `\'`, e exigir espaco antes fazia o deslocamento passar despercebido — o
  # commit seguinte era barrado como se fosse neste repo.
  if [[ "$segment" =~ (^|[[:space:]\'\"])cd[[:space:]]+([^[:space:]]+) ]]; then
    cd_target="${BASH_REMATCH[2]}"
    cd_abs=$(readlink -f "$cd_target" 2>/dev/null || printf '%s' "$cd_target")
    case "$cd_abs" in
      "$root_abs" | "$root_abs"/*) cwd_external=0 ;;
      *) cwd_external=1 ;;
    esac
  fi

  if kind=$(lms_gated_kind "$segment"); then
    saw_publish=1
    [ "$kind" = "publish" ] && is_publish=1
    if segment_is_internal "$segment"; then
      all_publishes_external=0
    fi
  fi
done < <(printf '%s\n' "$CMD_SCAN" | tr ';&|' '\n')

if [ "$saw_publish" -eq 1 ] && [ "$all_publishes_external" -eq 1 ]; then
  exit 0
fi

# LMS pontua CODIGO. Duas familias de path nao tem o que pontuar:
#   - doc pura (markdown, texto, docs/) — as quatro lentes do scorecard nao se aplicam;
#   - tooling de agente (skills e seus mounts por symlink), escrito para agente e nao
#     entregue ao usuario.
# A isencao exige que o conjunto de arquivos seja SO desses. MISTO continua barrado:
# isentar mistura deixaria qualquer diff pegar carona numa linha de markdown.
# A regra mora no pacote, em scripts/lms-exempt-paths.mjs — a mesma usada pelo
# lms-push-gate. Duas copias divergiriam, e a permissiva viraria bypass.

if [ "$is_publish" = "1" ]; then
  upstream=$(git -C "$ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
  changed=""
  [ -n "$upstream" ] && changed=$(git -C "$ROOT" diff --name-only "$upstream...HEAD" 2>/dev/null || true)
else
  # Commit: o que esta indexado. `commit -a` tambem arrasta o nao-indexado, entao os
  # dois conjuntos entram — senao um `commit -a` com codigo sujo passaria como doc.
  changed=$(git -C "$ROOT" diff --cached --name-only 2>/dev/null || true)
  if lms_commit_arrasta_worktree "$CMD_SCAN"; then
    changed=$(printf '%s\n%s\n' "$changed" "$(git -C "$ROOT" diff --name-only 2>/dev/null || true)")
  fi
fi

# Conjunto vazio (sem upstream, nada indexado) nao prova nada — cai no gate.
if [ -n "$(printf '%s' "$changed" | tr -d '[:space:]')" ]; then
  if printf '%s\n' "$changed" | LMS_PROJECT_ROOT="$ROOT" node "$EXEMPT_PATHS"; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"LMS gate: mudanca so em doc/tooling de agente (markdown, docs/, skills) — isento. Codigo de produto continua barrado."}}'
    exit 0
  fi
fi

# Publish path: always run trigger (auto-spawn + hard block when scorecard bad)
if [ "$is_publish" = "1" ]; then
  trigger_out=""
  trigger_rc=0
  if [ -f "$TRIGGER" ]; then
    set +e
    trigger_out=$(bash "$TRIGGER" 2>&1)
    trigger_rc=$?
    set -e
  else
    trigger_out="lms-reviewer-trigger.sh missing at $TRIGGER"
    trigger_rc=1
  fi

  CMD_SAFE=$(printf '%s' "$CMD" | head -c 200)
  export LMS_GATE_TRIGGER_OUT="$trigger_out"
  export LMS_GATE_CMD="$CMD_SAFE"
  export LMS_GATE_RC="$trigger_rc"
  python3 <<'PY'
import json, os
trigger_out = os.environ.get("LMS_GATE_TRIGGER_OUT", "")
cmd = os.environ.get("LMS_GATE_CMD", "")
rc = int(os.environ.get("LMS_GATE_RC", "1"))
if rc == 0:
    # `self` = o autor avaliou o proprio trabalho. Passa, mas o gate diz em voz
    # alta: a regra do projeto e revisor != autor, e um scorecard self nao
    # equivale a revisao independente.
    self_review = ""
    try:
        with open(".lms/last.json", encoding="utf-8") as fh:
            if json.load(fh).get("autonomy") == "self":
                self_review = (
                    "\nAVISO: autonomy=self — auto-revisao do autor, a categoria mais fraca. "
                    "Nao houve revisor independente; a regra do projeto e revisor != autor."
                )
    except Exception:
        pass
    ctx = (
        "LOCAL-MERGE-SCORE (LMS) gate: scorecard OK for publish."
        f"{self_review}\n"
        f"{trigger_out}\n"
        f"Command: {cmd}"
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": ctx.strip(),
        }
    }, ensure_ascii=False))
else:
    session = os.environ.get("LMS_TMUX_SESSION", "lms-review")
    ctx = (
        "LOCAL-MERGE-SCORE (LMS) gate: publish blocked.\n"
        "Trigger/spawn ran; scorecard still missing, stale, or below min.\n"
        f"{trigger_out}\n"
        f"1) attach: tmux attach -t {session}\n"
        "2) run local-merge-score / /goal LMS = 5/5; write .lms/last.json\n"
        "3) retry this command\n"
        "Greptile saiu do pipeline (2026-08-27); use apenas o LMS.\n"
        f"Command: {cmd}"
    )
    print(json.dumps({
        "decision": "block",
        "reason": "LMS scorecard missing/stale/below min — reviewer spawn attempted",
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": ctx.strip(),
        }
    }, ensure_ascii=False))
PY
  exit 0
fi

# Commit path: inject context; optional non-blocking spawn
if [ "${LMS_TRIGGER_ON_COMMIT:-0}" = "1" ]; then
  if [ ! -f "$SCORECARD" ] && [ -f "$SPAWN" ]; then
    LMS_SPAWN_DETACHED=1 bash "$SPAWN" >/dev/null 2>&1 || true
  fi
fi

python3 - "$SCORECARD" "$MAX_AGE_SEC" "$MIN_SCORE" "$CMD" <<'PY'
import json, os, sys, time
from pathlib import Path

scorecard, max_age, min_score, cmd = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
strict = os.environ.get("LMS_HOOK_STRICT", "").strip() in ("1", "true", "yes")

def emit(context: str, block: bool = False, reason: str = "") -> None:
    if block:
        out = {
            "decision": "block",
            "reason": reason or context,
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "additionalContext": context,
            },
        }
    else:
        out = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "additionalContext": context,
            }
        }
    print(json.dumps(out, ensure_ascii=False))

base_ctx = (
    "LOCAL-MERGE-SCORE (LMS) gate: before git commit / git push / gh pr create, "
    "follow the `local-merge-score` skill. "
    "1) `pnpm exec lms-trigger` 2) code-review findings (conf≥80) four lenses "
    "3) optional graphify query/path 4) score 0–5 5) write `.lms/last.json` "
    "with score, lenses, autonomy. Defaults: target 5 (only 5/5 ships), plateau-stop 2, ceiling 8. "
    "Greptile saiu do pipeline (2026-08-27); use apenas o LMS. "
    f"Command: `{cmd[:200]}`"
)

p = Path(scorecard)
if not p.is_file():
    msg = base_ctx + " No `.lms/last.json` — run local-merge-score (or /goal LMS = 5/5) first."
    emit(msg, block=strict, reason="LMS scorecard missing")
    raise SystemExit(0)

try:
    data = json.loads(p.read_text(encoding="utf-8"))
except Exception:
    msg = base_ctx + " `.lms/last.json` invalid JSON — re-run local-merge-score."
    emit(msg, block=strict, reason="LMS scorecard invalid")
    raise SystemExit(0)

age = time.time() - p.stat().st_mtime
try:
    score_n = int(data.get("score"))
except Exception:
    score_n = -1

fresh = age <= max_age
ok = fresh and score_n >= min_score

if ok:
    emit(
        base_ctx
        + f" Scorecard OK: LMS {score_n}/5 (min {min_score}), age {int(age)}s. "
        "Proceed; re-score if code changed after the scorecard."
    )
    raise SystemExit(0)

if not fresh:
    detail = f"scorecard stale (age {int(age)}s > {max_age}s)"
elif score_n < min_score:
    detail = f"LMS {score_n}/5 below min {min_score}"
else:
    detail = "scorecard not OK"

msg = base_ctx + f" {detail}. Refresh `.lms/last.json`, retry."
emit(msg, block=strict, reason=f"LMS gate: {detail}")
raise SystemExit(0)
PY
