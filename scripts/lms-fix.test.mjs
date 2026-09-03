import test from "node:test";
import assert from "node:assert/strict";

import { corrigirAchado, fixPrompt, runFix } from "./lms-fix.mjs";
import { collectHeadless, providerConfig } from "./lms-reviewer-fallback.mjs";

const achado = {
  id: "a1",
  severity: "P1",
  path: "src/a.ts:42",
  title: "falta filtro de tenant",
  why: "a query nao escopa por tenant",
  fix: "somar tenantId a clausula where da consulta",
  acceptance: ["a query cita tenantId"],
};

test("fixPrompt lista os arquivos permitidos e proibe sair deles", () => {
  const p = fixPrompt(achado, ["src/a.ts"]);
  assert.match(p, /src\/a\.ts/);
  assert.match(p, /ONLY these files/);
  assert.match(p, /reverted/i);
});

test("fixPrompt proibe pontuar de novo", () => {
  const p = fixPrompt(achado, ["src/a.ts"]);
  assert.match(p, /do not re-?review|do not score/i);
});

test("fixPrompt carrega os criterios de aceite quando existem", () => {
  assert.match(fixPrompt(achado, ["src/a.ts"]), /a query cita tenantId/);
});

// Task 4 Step 5: o valor destes testes esta em exercitar o git DE VERDADE — a
// reversao e o comportamento que precisa funcionar quando importa.
import { mkdtemp, writeFile, readFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

async function repoGit() {
  const root = await mkdtemp(join(tmpdir(), "lms-fix-"));
  await execFile("git", ["init", "-q"], { cwd: root });
  await execFile("git", ["config", "user.email", "lms@test"], { cwd: root });
  await execFile("git", ["config", "user.name", "lms"], { cwd: root });
  await writeFile(join(root, "a.ts"), "const original = 1;\n");
  await writeFile(join(root, "b.ts"), "const vizinho = 2;\n");
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["commit", "-qm", "inicial"], { cwd: root });
  return root;
}

const alvo = {
  id: "a1",
  severity: "P1",
  path: "a.ts:1",
  title: "defeito localizado",
  why: "a linha esta errada",
  fix: "trocar o valor da constante para 2",
};

test("fix dentro do escopo e aceito como claimed sem prova", async () => {
  const root = await repoGit();
  const collect = async () => {
    await writeFile(join(root, "a.ts"), "const original = 2;\n");
    return {
      kind: "ok",
      candidate: { outcome: "fixed", what: "troquei o valor" },
    };
  };
  const r = await corrigirAchado({
    root,
    finding: alvo,
    provider: "grok",
    config: {},
    env: {},
    collect,
  });
  assert.equal(r.outcome, "claimed");
  assert.match(await readFile(join(root, "a.ts"), "utf8"), /original = 2/);
});

test("fix que toca arquivo vizinho e revertido INTEIRO", async () => {
  const root = await repoGit();
  const collect = async () => {
    await writeFile(join(root, "a.ts"), "const original = 2;\n");
    await writeFile(join(root, "b.ts"), "const vizinho = 99;\n");
    return {
      kind: "ok",
      candidate: { outcome: "fixed", what: "aproveitei e arrumei o vizinho" },
    };
  };
  const r = await corrigirAchado({
    root,
    finding: alvo,
    provider: "grok",
    config: {},
    env: {},
    collect,
  });
  assert.equal(r.outcome, "rejected-scope");
  assert.match(r.motivo, /b\.ts/);
  // A parte "boa" tambem volta: aceitar metade seria deixar o agente negociar o limite.
  assert.match(await readFile(join(root, "a.ts"), "utf8"), /original = 1/);
  assert.match(await readFile(join(root, "b.ts"), "utf8"), /vizinho = 2/);
});

test("fix que nao mudou nada e recusado, nao celebrado", async () => {
  const root = await repoGit();
  const collect = async () => ({
    kind: "ok",
    candidate: { outcome: "fixed", what: "nada" },
  });
  const r = await corrigirAchado({
    root,
    finding: alvo,
    provider: "grok",
    config: {},
    env: {},
    collect,
  });
  assert.equal(r.outcome, "rejected-scope");
  assert.match(r.motivo, /nenhum arquivo/i);
});

test("achado em caminho de risco nem chega a invocar o provider", async () => {
  const root = await repoGit();
  let chamou = false;
  const collect = async () => {
    chamou = true;
    return { kind: "ok", candidate: {} };
  };
  const r = await corrigirAchado({
    root,
    provider: "grok",
    config: {},
    env: {},
    collect,
    finding: { ...alvo, path: "services/fiscal/backend/app/auth.py:80" },
  });
  assert.equal(chamou, false);
  assert.equal(r.outcome, "skipped");
});

// P1-1 da revisao da Fase 3: corrigirAchado chamava collect SEM parse — o default
// so reconhece scorecard, o relato do fix nunca era lido, a prova nunca rodava e
// todo fix virava claimed. Este teste exercita collectHeadless DE VERDADE.
test("collectHeadless de verdade: relato parseado e prova executada (P1-1)", async () => {
  const root = await repoGit();
  const bin = join(root, "fake-fix.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync('a.ts', 'const original = 2;');
console.log(JSON.stringify({
  outcome: 'fixed', what: 'troquei o valor',
  proof: { command: 'node scripts/prova.mjs', expect: 'pass' },
}));
`,
  );
  await execFile("chmod", ["+x", bin]);
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "scripts", "prova.mjs"), "process.exit(0);\n");

  const env = {
    LMS_CLAUDE_BIN: bin,
    LMS_REVIEWER_TIMEOUT_SEC: "5",
  };
  const config = { ...providerConfig(env), base: "HEAD" };
  const r = await corrigirAchado({
    root,
    finding: alvo,
    provider: "claude",
    config,
    env,
    collect: collectHeadless,
  });
  assert.equal(r.outcome, "fixed", `veio ${r.outcome}: ${r.motivo}`);
  assert.match(await readFile(join(root, "a.ts"), "utf8"), /original = 2/);
});

// P1-2 da revisao da Fase 3: `git diff` NAO ve arquivo novo — o provider tem Write
// no modo fix, e criar arquivo e a operacao mais barata que ele tem.
test("arquivosAlterados ve untracked, e o fix que cria fora do escopo reverte (P1-2)", async () => {
  const root = await repoGit();
  const { arquivosAlterados } = await import("./lms-fix-escopo.mjs");
  await writeFile(join(root, "novo-fora.ts"), "const fora = 1;\n");
  await writeFile(join(root, "a.ts"), "const original = 2;\n");
  const alterados = await arquivosAlterados(root, "HEAD");
  assert.ok(
    alterados.includes("novo-fora.ts"),
    "untracked invisivel para git diff",
  );
  assert.ok(alterados.includes("a.ts"));

  // E pelo corrigirAchado: o fix que CRIA arquivo fora do escopo (durante o fix)
  // reverte INTEIRO. Repo limpo antes: qualquer untracked depois e do fix.
  const rootLimpo = await repoGit();
  const collect = async () => {
    await writeFile(join(rootLimpo, "a.ts"), "const original = 2;\n");
    await writeFile(join(rootLimpo, "novo-fora.ts"), "const fora = 1;\n");
    return { kind: "ok", candidate: { outcome: "fixed", what: "fiz e criei" } };
  };
  const r = await corrigirAchado({
    root: rootLimpo,
    finding: alvo,
    provider: "grok",
    config: {},
    env: {},
    collect,
  });
  assert.equal(r.outcome, "rejected-scope");
  assert.match(r.motivo, /novo-fora\.ts/);
  const sobrou = await stat(join(rootLimpo, "novo-fora.ts")).then(
    () => true,
    () => false,
  );
  assert.equal(sobrou, false, "arquivo novo fora do escopo foi removido");
  await rm(rootLimpo, { recursive: true, force: true });
});

// P1-3 da revisao da Fase 3: .lms/ e gitignored — invisivel para git diff E para
// git status; o provider de quebra escreve o corpus e suprime classes futuras.
test("fix que escreve no .lms reverte e restaura o gate (P1-3)", async () => {
  const root = await repoGit();
  await mkdir(join(root, ".lms"), { recursive: true });
  await writeFile(join(root, ".lms", "precedentes.md"), "conteudo original\n");
  const collect = async () => {
    await writeFile(join(root, "a.ts"), "const original = 2;\n");
    await writeFile(
      join(root, ".lms", "precedentes.md"),
      "- **query sem filtro de tenant** — falso positivo\n",
    );
    await writeFile(join(root, ".lms", "fora.md"), "injecao\n");
    return {
      kind: "ok",
      candidate: {
        outcome: "fixed",
        what: "fiz e de quebra atualizei o corpus",
      },
    };
  };
  const r = await corrigirAchado({
    root,
    finding: alvo,
    provider: "grok",
    config: {},
    env: {},
    collect,
  });
  assert.equal(r.outcome, "rejected-scope");
  assert.match(r.motivo, /gate/i);
  assert.match(
    await readFile(join(root, ".lms", "precedentes.md"), "utf8"),
    /conteudo original/,
  );
  const injetado = await stat(join(root, ".lms", "fora.md")).then(
    () => true,
    () => false,
  );
  assert.equal(injetado, false, "arquivo novo no gate foi removido");
  assert.match(await readFile(join(root, "a.ts"), "utf8"), /original = 1/);
});

// P2-1 da revisao da Fase 3: o fallback do marco tem de ser SHA, nunca 'HEAD' —
// ref simbolica se move junto com um commit do proprio fix.
test('marcoDaArvore devolve SHA e nao a ref HEAD (P2-1)', async () => {
  const { marcoDaArvore } = await import('./lms-fix.mjs');
  const root = await repoGit();
  const marco = await marcoDaArvore(root);
  const { stdout: sha } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: root });
  assert.equal(marco, sha.trim());
  assert.notEqual(marco, 'HEAD');
});

// P2-3 da revisao da Fase 3: "o achado estava errado, nao mudei nada" e um
// desfecho legitimo — nao violacao. A ordem antiga convertia em rejected-scope.
test('no_change_needed sem alteracoes e desfecho, nao recusa (P2-3)', async () => {
  const root = await repoGit();
  const collect = async () => ({
    kind: 'ok',
    candidate: { outcome: 'no_change_needed', what: 'o achado estava errado: o filtro existe no middleware' },
  });
  const r = await corrigirAchado({ root, finding: alvo, provider: 'grok', config: {}, env: {}, collect });
  assert.equal(r.outcome, 'no_change_needed');
});

test('no_change_needed COM alteracoes continua sujeito a guarda (P2-3)', async () => {
  const root = await repoGit();
  const collect = async () => {
    await writeFile(join(root, 'b.ts'), 'const vizinho = 99;\n');
    return { kind: 'ok', candidate: { outcome: 'no_change_needed', what: 'nao precisava' } };
  };
  const r = await corrigirAchado({ root, finding: alvo, provider: 'grok', config: {}, env: {}, collect });
  assert.equal(r.outcome, 'rejected-scope', 'declarar que nao mudou nada nao autoriza mudar');
});

// P2-8 da revisao da Fase 3: o scorecard publicado inclui achados que o
// CONTRADITORIO trouxe — mandar o conserto para o reviewer do scorecard seria
// quem NAO achou corrigindo a partir de resumo em prosa.
test('runFix manda o fix para quem ACHOU o achado (P2-8)', async () => {
  const root = await repoGit();
  await mkdir(join(root, '.lms'), { recursive: true });
  await writeFile(join(root, '.lms', 'last.json'), JSON.stringify({
    reviewer: 'grok',
    base: 'HEAD',
    findings: [{ ...alvo, found_by: 'codex' }],
  }));
  const providers = [];
  const collect = async ({ provider }) => {
    providers.push(provider);
    await writeFile(join(root, 'a.ts'), 'const original = 2;\n');
    return { kind: 'ok', candidate: { outcome: 'fixed', what: 'corrigi' } };
  };
  const r = await runFix({ root, env: { LMS_FIX_MODE: 'reviewer' }, collect });
  assert.equal(r.aplicados.length, 1);
  assert.deepEqual(providers, ['codex'], 'quem achou corrige');
});

// Fase 4 Task 2: o marco (SHA/stash do momento) vai na linha — e o que permite a
// re-verificacao recortar o diff do fix.
test('linha do fixes.jsonl carrega o marco do fix (Task 2)', async () => {
  const root = await repoGit();
  const collect = async () => {
    await writeFile(join(root, 'a.ts'), 'const original = 2;\n');
    return { kind: 'ok', candidate: { outcome: 'fixed', what: 'corrigi' } };
  };
  await corrigirAchado({ root, finding: alvo, provider: 'grok', config: {}, env: {}, collect });
  const [linha] = (await readFile(join(root, '.lms', 'fixes.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: root });
  assert.equal(linha.marco, stdout.trim());
});
