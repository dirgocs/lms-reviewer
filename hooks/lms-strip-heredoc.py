#!/usr/bin/env python3
"""Remove corpo de heredoc do comando antes do gate LMS analisar.

O corpo de um heredoc e DADO, nao comando: um arquivo escrito com
`cat > x <<'EOF'` pode citar qualquer verbo sem estar executando nada.
Sem isso o gate disparava (e no caminho de publish rodava a cadeia de
reviewer inteira) em cima de uma escrita de arquivo.

MENOS quando quem le o heredoc e um INTERPRETADOR. Em
`bash <<'EOF' ... git push ... EOF` o corpo E comando, e executa: apagá-lo
fazia o gate nao ver verbo nenhum e sair 0 em silencio — o mesmo furo do
shell aninhado, por outra porta. Nesse caso o corpo segue para o gate.

Le o comando em stdin, escreve em stdout so as linhas de comando.
"""

import re
import sys

HEREDOC = re.compile(r"""<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*$""")

# Destino ARQUIVO: o corpo e conteudo, nao comando. Unica familia em que apagar e
# seguro por construcao — `cat > x <<EOF` pode citar qualquer verbo sem executar nada.
DESTINO_ARQUIVO = {"cat", "tee", "dd", "sponge"}

# RUNTIME que nao e shell: o corpo tambem executa, mas ali `"git push"` quase sempre e
# STRING, nao comando. Manter o corpo cru fazia o gate barrar toda edicao de arquivo
# escrita com `python3 - <<'PY'` que mencionasse o verbo — inclusive as deste repo, onde
# o agente edita assim o tempo todo. Entao o corpo so segue adiante quando houver sinal
# de EXECUCAO de processo, e nao mera mencao.
RUNTIMES = {
    "python",
    "python3",
    "node",
    "deno",
    "bun",
    "perl",
    "ruby",
    "php",
    "lua",
    "osascript",
}

# Chamada de processo nos runtimes acima. Sem um destes, o verbo no corpo e texto.
EXECUCAO = re.compile(
    r"\b(subprocess|os\.system|os\.popen|os\.exec\w*|execSync|spawnSync|execFile|"
    r"child_process|system|exec|popen|Process|shell_exec|`)",
)
# Envelopes que so embrulham: o interpretador pode estar depois deles.
ENVELOPES = {
    "sudo",
    "nohup",
    "exec",
    "command",
    "env",
    "time",
    "timeout",
    "stdbuf",
    "setsid",
    "nice",
    "ionice",
}


def _programa_do_heredoc(linha: str) -> str:
    """Quem recebe o corpo.

    Percorre os tokens pulando envelope, atribuicao (`VAR=x`), opcao (`-l`) e
    numero (duracao de `timeout`), e para no primeiro programa de verdade.
    `/usr/bin/bash` e `bash` valem igual.
    """
    for token in linha.split():
        if token in ENVELOPES or token.startswith("-") or "=" in token:
            continue
        if token.isdigit():
            continue
        return token.rsplit("/", 1)[-1]
    return ""


def strip(cmd: str) -> str:
    out = []
    terminator = None
    programa = ""
    corpo: list[str] = []

    def resolver() -> None:
        """Decide se o corpo acumulado volta ao texto analisado.

        Por OMISSÃO o corpo volta. Enumerar interpretador é a mesma corrida que o gate
        já perdeu no shell: `ssh host <<EOF`, `expect`, `docker exec -i` executam o corpo
        igual, e ficariam de fora de qualquer lista. Então a pergunta vira a mesma do
        gate — dá para provar que este corpo é DADO?

        Duas provas aceitas. A primeira é o destino ser arquivo (`cat >`, `tee`, `dd`):
        aí o corpo é conteúdo, não comando. A segunda é o programa ser um runtime
        conhecido que NÃO é shell e cujo corpo não mostra execução de processo — em
        python ou node, `"git push"` dentro de aspas é string, e sem esta exceção toda
        edição de arquivo escrita com `python3 - <<PY` seria barrada.
        """
        if programa in DESTINO_ARQUIVO:
            return
        if programa in RUNTIMES and not any(EXECUCAO.search(linha) for linha in corpo):
            return
        out.extend(corpo)

    for line in cmd.split("\n"):
        if terminator is not None:
            if line.strip() == terminator:
                resolver()
                terminator = None
                programa = ""
                corpo = []
                continue
            corpo.append(line)
            continue
        out.append(line)
        m = HEREDOC.search(line)
        if m:
            terminator = m.group(2)
            programa = _programa_do_heredoc(line)
            corpo = []
    # Heredoc sem terminador (comando truncado): o corpo pendente ainda vale a regra.
    if terminator is not None:
        resolver()
    return "\n".join(out)


if __name__ == "__main__":
    sys.stdout.write(strip(sys.stdin.read()))
