#!/usr/bin/env node
/**
 * Fix mode do LMS: quem achou o defeito corrige.
 *
 * O invariante do LMS e "quem julga != quem produziu". Corrigir e produzir; pontuar
 * e julgar. O invariante so quebra se o revisor PONTUAR o delta que ele escreveu — e
 * isso ja e impossivel: scripts/lms-subject.mjs mete a arvore suja no hash, entao o
 * fix invalida o scorecard no instante em que toca o disco.
 *
 * O que resta bloquear e o "ja que estou aqui" (guarda de escopo) e a tentacao de
 * editar o proprio gate (denylist). As duas sao mecanicas.
 */
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { arquivosDoAchado, corrigivelPeloRevisor } from './lms-fix-routing.mjs';
import { arquivosAlterados, escopoViolado, reverter } from './lms-fix-escopo.mjs';
// O fix reusa a MESMA allowlist (PROVAS_PERMITIDAS) do contraditorio de proposito —
// abrir uma segunda lista de comandos permitidos seria abrir um segundo caminho
// para shell arbitrario.
import {
  collectHeadless,
  providerConfig,
  verificarProva,
} from './lms-reviewer-fallback.mjs';

const execFile = promisify(execFileCallback);

export function fixPrompt(finding, arquivos) {
  return [
    'You reviewed this branch and reported the finding below. Now fix it.',
    '',
    '--- FINDING ---',
    `severity: ${finding.severity}`,
    `path: ${Array.isArray(finding.path) ? finding.path.join(', ') : finding.path}`,
    `title: ${finding.title}`,
    `why: ${finding.why}`,
    `suggested fix: ${finding.fix}`,
    ...(Array.isArray(finding.acceptance) && finding.acceptance.length
      ? ['acceptance criteria:', ...finding.acceptance.map((c) => `  - ${c}`)]
      : []),
    '--- END FINDING ---',
    '',
    `You may edit ONLY these files: ${arquivos.join(', ')}`,
    'Any change outside them makes the whole fix be reverted, so do not "while I am',
    'here" anything. No new files, no deletions, no refactors beyond the finding.',
    '',
    'Do NOT re-review the diff, do not score, do not write a scorecard, do not commit,',
    'do not push. Fix the defect and stop.',
    '',
    'When done, print EXACTLY ONE JSON object, no prose, no markdown fences:',
    '{',
    '  "outcome": "fixed",',
    '  "what": "one sentence on what you changed",',
    '  "proof": { "command": "pnpm --filter @karibu/api test", "expect": "pass" }',
    '}',
    '"outcome" is "fixed" or "no_change_needed" (use the second only if you conclude',
    'the finding was wrong — say why in "what"). "proof" is optional but strongly',
    'preferred: without it the fix is recorded as "claimed", not "fixed", and the next',
    'review round re-checks that path first.',
  ].join('\n');
}

/** Ponto de comparacao antes do fix, sem encostar na pilha de stash. */
async function marcoDaArvore(root) {
  // `git stash create` so MONTA o objeto — nao empilha. `git stash push` mexeria
  // numa pilha compartilhada com as outras worktrees e com o Master.
  const { stdout } = await execFile('git', ['stash', 'create'], { cwd: root });
  return stdout.trim() || 'HEAD';
}

async function registrar(root, linha) {
  await mkdir(join(root, '.lms'), { recursive: true });
  await appendFile(join(root, '.lms', 'fixes.jsonl'), `${JSON.stringify(linha)}\n`, 'utf8');
}

export async function corrigirAchado({ root, finding, provider, config, env, collect }) {
  const arquivos = arquivosDoAchado(finding);
  const rota = corrigivelPeloRevisor(finding);
  if (!rota.ok) {
    const linha = {
      at: new Date().toISOString(), id: finding.id, provider,
      outcome: 'skipped', arquivos, motivo: rota.motivo,
    };
    await registrar(root, linha);
    return linha;
  }

  const desde = await marcoDaArvore(root);
  const saida = await collect({
    root, provider, config, base: config.base, env, modo: 'fix',
    prompt: fixPrompt(finding, arquivos),
  }).catch(() => ({ kind: 'error' }));

  const alterados = await arquivosAlterados(root, desde);
  const violacao = escopoViolado(alterados, arquivos);

  // Ordem importa: a guarda de escopo roda ANTES de olhar o que o provider disse.
  // Um provider que estourou o escopo e anunciou "fixed" nao pode ser acreditado
  // sobre o proprio limite.
  if (violacao) {
    await reverter(root, alterados);
    const linha = { at: new Date().toISOString(), id: finding.id, provider,
      outcome: 'rejected-scope', arquivos: alterados, motivo: violacao };
    await registrar(root, linha);
    return linha;
  }

  const relato = saida.kind === 'ok' ? saida.candidate : null;
  if (relato?.outcome === 'no_change_needed') {
    const linha = { at: new Date().toISOString(), id: finding.id, provider,
      outcome: 'no_change_needed', arquivos: [], motivo: relato.what ?? '' };
    await registrar(root, linha);
    return linha;
  }

  let outcome = 'claimed';
  let motivo = relato?.what ?? 'sem relato do provider';
  if (relato?.proof) {
    const prova = await verificarProva(root, relato.proof, env);
    if (prova === 'confirmada') {
      outcome = 'fixed';
    } else {
      // Prova que nao confirma derruba o fix inteiro: "corrigi" com prova que falha
      // e pior que "corrigi" sem prova — e uma alegacao ja contestada.
      await reverter(root, alterados);
      outcome = 'rejected-scope';
      motivo = `prova do fix nao confirmou (${prova})`;
    }
  }
  const linha = {
    at: new Date().toISOString(), id: finding.id, provider, outcome,
    arquivos: outcome === 'rejected-scope' ? [] : alterados, motivo,
  };
  await registrar(root, linha);
  return linha;
}

export async function runFix({ root = process.cwd(), env = process.env, collect = collectHeadless } = {}) {
  const modo = env.LMS_FIX_MODE ?? 'off';
  if (modo === 'off') {
    console.error('lms-fix: fix mode desligado (LMS_FIX_MODE=off)');
    return { aplicados: [], recusados: [], escalados: [] };
  }
  let scorecard;
  try {
    scorecard = JSON.parse(await readFile(join(root, '.lms', 'last.json'), 'utf8'));
  } catch (erro) {
    // Falha fechada: scorecard ausente ou corrompido nao da margem para decidir o
    // que corrigir — corrigir cego e tocar codigo sem saber o que o revisor viu.
    console.error(`lms-fix: scorecard ausente ou invalido (${erro.message}) — rode a cadeia de revisao primeiro`);
    process.exitCode = 1;
    return { aplicados: [], recusados: [], escalados: [] };
  }
  // Achado rebaixado a PLAUSIBLE por um verificador nao vale um fix: ele nao bloqueia
  // e pode nem ser defeito.
  const alvos = (scorecard.findings ?? []).filter((f) => (f.verdict ?? 'CONFIRMED') === 'CONFIRMED');

  if (modo === 'orchestrator') {
    for (const finding of alvos) {
      const rota = corrigivelPeloRevisor(finding);
      console.log(
        `${rota.ok ? 'REVISOR   ' : 'ORQUESTRA '} ${finding.severity} ${finding.path} — ${finding.title} (${rota.motivo})`,
      );
    }
    return { aplicados: [], recusados: [], escalados: alvos };
  }

  const config = { ...providerConfig(env), base: scorecard.base };
  const linhas = [];
  // Em serie de proposito: dois fixes simultaneos na mesma arvore fazem a guarda de
  // escopo de um enxergar o diff do outro e reverter trabalho alheio.
  for (const finding of alvos) {
    linhas.push(await corrigirAchado({
      root, finding, provider: scorecard.reviewer, config, env, collect,
    }));
  }
  const resultado = {
    aplicados: linhas.filter((l) => l.outcome === 'fixed' || l.outcome === 'claimed'),
    recusados: linhas.filter((l) => l.outcome === 'rejected-scope'),
    escalados: linhas.filter((l) => l.outcome === 'skipped'),
  };
  console.error(
    `lms-fix: ${resultado.aplicados.length} aplicado(s), `
    + `${resultado.recusados.length} revertido(s), ${resultado.escalados.length} escalado(s). `
    + 'O scorecard foi invalidado pelo subject — rode a cadeia de novo.',
  );
  return resultado;
}

if (import.meta.url === `file://${process.argv[1]}`) await runFix();
