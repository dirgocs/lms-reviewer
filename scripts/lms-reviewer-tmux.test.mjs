import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attemptProvider, reviewPrompt, runFallback, stampScorecard } from './lms-reviewer-fallback.mjs';
import { sessionNameFor, tuiCommand } from './lms-reviewer-tmux.mjs';

/** Scorecard bem formado; `inspected` é preenchido pelo teste contra arquivos reais. */
function scorecard(overrides = {}) {
  return {
    score: 5,
    target: 5,
    p0: 0,
    p1: 0,
    p2: 0,
    lenses: {
      'code-safety': { p0: 0, p1: 0, p2: 0 },
      'code-structure': { p0: 0, p1: 0, p2: 0 },
      'code-quality': { p0: 0, p1: 0, p2: 0 },
      'code-efficiency': { p0: 0, p1: 0, p2: 0 },
    },
    findings: [],
    ...overrides,
  };
}

test('prompt muda de stdout para arquivo quando ha destino', () => {
  const semDestino = reviewPrompt('origin/master', 'claude', 'M a.ts');
  assert.match(semDestino, /Print EXACTLY ONE JSON object/);
  assert.doesNotMatch(semDestino, /\.lms\/candidates/);

  const comDestino = reviewPrompt('origin/master', 'claude', 'M a.ts', '.lms/candidates/claude.json');
  assert.match(comDestino, /Write EXACTLY ONE JSON object to \.lms\/candidates\/claude\.json/);
  // A permissão de escrita precisa ser explícita e ÚNICA: o revisor da TUI grava o
  // scorecard, e só ele.
  assert.match(comDestino, /ONLY file you may write is \.lms\/candidates\/claude\.json/);
});

test('runner crava os fatos objetivos por cima do que o modelo escreveu', () => {
  const stamped = stampScorecard(
    { ...scorecard(), reviewer: 'Claude Opus 4.8', base: 'inventado', at: '2099-01-01T00:00:00Z' },
    'grok',
    'pass',
    'origin/master',
  );
  assert.equal(stamped.reviewer, 'grok');
  assert.equal(stamped.base, 'origin/master');
  assert.equal(stamped.fallow, 'pass');
  assert.equal(stamped.autonomy, 'reviewer');
  assert.notEqual(stamped.at, '2099-01-01T00:00:00Z');
});

test('a cadeia aceita qualquer estrategia de coleta, nao so a headless', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-tmux-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    const paths = ['src/um.ts', 'src/dois.ts', 'src/tres.ts'];
    for (const path of paths) {
      await writeFile(join(root, path), `export function alvo${path.length}(entrada) {\n  return entrada;\n}\n`, 'utf8');
    }
    const inspected = paths.map((path) => ({ path, line: 1, quote: `export function alvo${path.length}(entrada) {` }));

    // Coleta falsa: devolve o candidato sem processo nenhum. É exatamente o que o
    // runner de tmux faz depois de ler o arquivo do revisor.
    const collect = async () => ({ kind: 'ok', candidate: scorecard({ inspected }) });

    const attempt = await attemptProvider({
      root,
      provider: 'grok',
      config: { models: { grok: 'grok-4.6' }, bins: {}, timeoutMs: 1000 },
      base: 'origin/master',
      prompt: 'irrelevante para esta coleta',
      env: {},
      fallow: 'pass',
      changedPaths: new Set(paths),
      collect,
    });

    assert.equal(attempt.accepted, true, `esperava aceite, veio: ${JSON.stringify(attempt.attempt)}`);
    assert.equal(attempt.scorecard.reviewer, 'grok');
    assert.equal(attempt.scorecard.autonomy, 'reviewer');

    // O aceite NAO pode estar em disco aqui: enquanto o contraditorio roda, um 5/5
    // gravado seria lido pelo gate e liberaria o push sem a segunda opiniao. Quem
    // grava e o runFallback, depois que a refutacao falha em derrubar.
    await assert.rejects(readFile(join(root, '.lms', 'last.json'), 'utf8'), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('coleta que nao entrega candidato nao vira aceite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-tmux-to-'));
  try {
    const attempt = await attemptProvider({
      root,
      provider: 'codex',
      config: { models: { codex: 'gpt-5.6-sol' }, bins: {}, timeoutMs: 1000 },
      base: 'origin/master',
      prompt: 'irrelevante',
      env: {},
      fallow: 'pass',
      changedPaths: new Set(['src/um.ts']),
      collect: async () => ({ kind: 'timeout' }),
    });
    assert.equal(attempt.accepted, false);
    assert.equal(attempt.attempt.result, 'timeout');
    assert.notEqual(attempt.rejected, true, 'timeout e falha de coleta, nao reprovacao do codigo');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refutacao malformada nao derruba: "false" string nao e refutacao', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-strict-'));
  try {
    await writeFile(join(root, 'mudou.ts'), 'export const alvo = 1;\n', 'utf8');
    const inspected = [{ path: 'mudou.ts', line: 1, quote: 'export const alvo = 1;' }];

    // Um veredito com refuted:"false" (string) e confianca alta: Boolean() frouxo o
    // trataria como refutacao e bloquearia um diff sem defeito apontado.
    const collect = async ({ prompt }) => ({
      kind: 'ok',
      candidate: prompt.includes('DERRUBAR')
        ? { refuted: 'false', confidence: 99 }
        : scorecard({ inspected }),
    });

    const resultado = await runFallback({
      root,
      base: 'origin/master',
      env: { LMS_AUTHOR: 'claude' },
      collect,
    });
    // O ponto: `refuted: "false"` NAO pode ser lido como refutacao (Boolean frouxo
    // bloquearia por defeito nenhum). Ele conta como veredito invalido — ou seja,
    // segunda opiniao nao obtida — entao bloqueia por AUSENCIA de contraditorio, nao
    // por achado inventado.
    assert.equal(resultado.ok, false);
    assert.equal(resultado.uncontested, true, 'malformado e ausencia de opiniao, nao refutacao');
    assert.equal(resultado.rejectedBy, undefined, 'nao pode virar reprovacao por achado');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sessao tmux e por arvore de trabalho, nao global', () => {
  // Nome fixo fazia dois worktrees revisando ao mesmo tempo disputarem as janelas
  // `lms-<provider>`: o segundo matava a do primeiro e o gate reportava
  // `contraditorio: invalid-output` — culpando o refutador por colisao de
  // infraestrutura. Aconteceu em quatro publicacoes seguidas.
  const repo = sessionNameFor('/home/master/dev/karibu-erp');
  const lane = sessionNameFor('/home/master/dev/worktrees/kdt91-seguranca');
  assert.notEqual(repo, lane, 'worktrees distintos precisam de sessoes distintas');
  assert.match(repo, /^lms-review-[0-9a-f]{8}$/);
  assert.equal(repo, sessionNameFor('/home/master/dev/karibu-erp'), 'mesmo caminho, mesma sessao');
});

test('LMS_TMUX_SESSION continua sobrescrevendo o nome derivado', () => {
  const anterior = process.env.LMS_TMUX_SESSION;
  process.env.LMS_TMUX_SESSION = 'lms-review-manual';
  try {
    assert.equal(sessionNameFor('/qualquer/caminho'), 'lms-review-manual');
  } finally {
    if (anterior === undefined) delete process.env.LMS_TMUX_SESSION;
    else process.env.LMS_TMUX_SESSION = anterior;
  }
});

test('promptEstaRodando reconhece os marcadores dos tres TUIs e recusa prompt parado', async () => {
  const { promptEstaRodando } = await import('./lms-reviewer-tmux.mjs');
  // Rodando: cada marcador ISOLADO, um assert por TUI — amostra composta deixava
  // um marcador sumir do regex sem nenhum teste cair.
  assert.equal(promptEstaRodando('⠙ Working…'), true);
  assert.equal(promptEstaRodando('(esc to interrupt)'), true);
  assert.equal(promptEstaRodando('⠴ Waiting for response… 10s'), true);
  assert.equal(promptEstaRodando('Thinking…'), true);
  assert.equal(promptEstaRodando('Esc to cancel'), true);
  // Parado com o TEXTO do prompt preso na caixa de input: banner engoliu o Enter.
  // Texto presente NÃO é prova de execução — foi exatamente o furo das rodadas 54/58.
  assert.equal(
    promptEstaRodando('❯ Leia .lms/review-prompt.md e execute…\n› Ask Codex to do anything'),
    false,
  );
});

test('tui do pi nao invoca codex e restringe tools de mutacao', () => {
  const cmd = tuiCommand('pi', 'z-ai/glm-5.3-flash');
  assert.equal(cmd[0], 'pi');
  assert.ok(cmd.includes('openrouter'));
  assert.ok(cmd.includes('z-ai/glm-5.3-flash'));
  assert.ok(!cmd.includes('codex'));
  const tools = cmd[cmd.indexOf('--tools') + 1];
  assert.match(tools, /read/);
  assert.doesNotMatch(tools, /bash|edit|write/i);
});

test('LMS_GROK_BIN so substitui o TUI com o atestado de trava (rodada 85)', () => {
  const binAnterior = process.env.LMS_GROK_BIN;
  const travaAnterior = process.env.LMS_GROK_BIN_TRAVADO;
  process.env.LMS_GROK_BIN = '/tmp/tui-substituto';
  try {
    delete process.env.LMS_GROK_BIN_TRAVADO;
    // sem o atestado: recusa o override e mantem o grok com as travas --deny
    assert.equal(tuiCommand('grok', 'grok-4.6')[0], 'grok');
    assert.ok(tuiCommand('grok', 'grok-4.6').includes('--deny'));

    process.env.LMS_GROK_BIN_TRAVADO = '1';
    // com o atestado: o substituto assume, carregando as proprias travas
    assert.deepEqual(tuiCommand('grok', 'grok-4.6'), ['/tmp/tui-substituto']);
  } finally {
    if (binAnterior === undefined) delete process.env.LMS_GROK_BIN;
    else process.env.LMS_GROK_BIN = binAnterior;
    if (travaAnterior === undefined) delete process.env.LMS_GROK_BIN_TRAVADO;
    else process.env.LMS_GROK_BIN_TRAVADO = travaAnterior;
  }
});
