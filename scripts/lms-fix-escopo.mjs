/**
 * Guarda de escopo do fix.
 *
 * O risco real do fix por revisor nao e o conserto errado — e o "ja que estou aqui".
 * Um agente com escrita e um mandato refatora mais do que o achado. A guarda e
 * mecanica: o diff que o fix produziu tem de caber nos arquivos que o achado citou.
 *
 * Violacao reverte o fix INTEIRO. Aceitar a parte boa de um fix que estourou o escopo
 * seria deixar o agente negociar o proprio limite.
 *
 * P1-2/P1-3 da revisao da Fase 3: `git diff` NAO ve untracked, e `.lms/` e
 * gitignored — invisivel para diff E status. O provider tem Write no modo fix:
 * criar arquivo e a operacao mais barata que ele tem, e escrever no proprio gate
 * (corpus de precedentes, scorecard, autoria) reabre exatamente o furo que o
 * F2-P1-1 fechou. Duas fontes de verdade: git para a arvore rastreada, listagem
 * de conteudo de `.lms/` antes/depois para o gate.
 */
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { caminhoProibido } from "./lms-fix-routing.mjs";

const execFile = promisify(execFileCallback);

export function escopoViolado(alterados, permitidos) {
  const proibido = alterados.find(caminhoProibido);
  if (proibido) return `o fix escreveu em caminho proibido: ${proibido}`;
  if (alterados.length === 0) return "o fix nao alterou nenhum arquivo";
  const permitidoSet = new Set(permitidos);
  const fora = alterados.filter((p) => !permitidoSet.has(p));
  return fora.length > 0
    ? `o fix alterou arquivo fora do escopo do achado: ${fora.slice(0, 5).join(", ")}`
    : null;
}

/** Arquivos rastreados que mudaram desde `desde` (SHA de `git stash create`/HEAD). */
async function rastreadosAlterados(root, desde) {
  const args = desde
    ? ["diff", "--name-only", desde]
    : ["status", "--porcelain"];
  const { stdout } = await execFile("git", args, {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((linha) => (desde ? linha.trim() : linha.slice(3).trim()))
    .filter(Boolean);
}

/** Nao rastreados (excluindo gitignored) — `git diff` nao ve, a guarda sim. */
export async function naoRastreados(root) {
  const { stdout } = await execFile(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return stdout
    .split("\n")
    .map((linha) => linha.trim())
    .filter(Boolean);
}

/**
 * Tudo que mudou na arvore: rastreados desde o marco + nao rastreados NOVOS
 * (`naoRastreadosAntes` subtrai o que o Master ja tinha solto na arvore).
 */
export async function arquivosAlterados(
  root,
  desde,
  naoRastreadosAntes = new Set(),
) {
  const novos = (await naoRastreados(root)).filter(
    (p) => !naoRastreadosAntes.has(p),
  );
  return [...new Set([...(await rastreadosAlterados(root, desde)), ...novos])];
}

/**
 * Conteudo de TODO `.lms/**` — o gate que o fix jamais pode tocar e gitignored,
 * entao o git nao serve: a prova e a listagem de conteudo antes e depois.
 */
export async function capturarGate(root) {
  const mapa = new Map();
  async function varrer(dir, prefixo) {
    let entradas;
    try {
      entradas = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // .lms/ nem existe ainda
    }
    for (const entrada of entradas) {
      const relativo = `${prefixo}${entrada.name}`;
      if (entrada.isDirectory()) {
        await varrer(join(dir, entrada.name), `${relativo}/`);
      } else {
        mapa.set(relativo, await readFile(join(dir, entrada.name), "utf8"));
      }
    }
  }
  await varrer(join(root, ".lms"), ".lms/");
  return mapa;
}

/** Arquivos de `.lms/` que mudaram, sumiram ou nasceram entre os dois snapshots. */
export function gateTocado(antes, depois) {
  const tocados = [];
  for (const [caminho, conteudo] of antes) {
    if (depois.get(caminho) !== conteudo) tocados.push(caminho);
  }
  for (const caminho of depois.keys()) {
    if (!antes.has(caminho)) tocados.push(caminho);
  }
  return tocados;
}

/** Devolve `.lms/` ao estado do snapshot: reescreve o que havia, apaga o que nasceu. */
export async function restaurarGate(root, antes) {
  await rm(join(root, ".lms"), { recursive: true, force: true });
  for (const [caminho, conteudo] of antes) {
    const destino = join(root, caminho);
    await mkdir(dirname(destino), { recursive: true });
    await writeFile(destino, conteudo, "utf8");
  }
}

/**
 * Desfaz o fix, arquivo por arquivo.
 *
 * `git checkout --` nos rastreados e `git clean -f -x` nos novos, NUNCA `reset --hard`:
 * a arvore e compartilhada com o Master e com outras lanes, e um reset apagaria
 * trabalho que nao e do fix. `-x` (P3-4) alcanca arquivo criado dentro de diretorio
 * gitignored, que `clean` comum preservaria.
 */
export async function reverter(root, arquivos) {
  for (const arquivo of arquivos) {
    try {
      await execFile("git", ["checkout", "--", arquivo], { cwd: root });
    } catch {
      // Arquivo novo nao tem versao anterior para restaurar: some com clean.
      await execFile("git", ["clean", "-f", "-x", "--", arquivo], {
        cwd: root,
      }).catch(() => {});
    }
  }
}

function dirname(caminho) {
  const partes = caminho.split("/");
  partes.pop();
  return partes.join("/") || ".";
}
