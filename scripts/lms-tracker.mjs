/**
 * Adapter de rastreador (Fase 5, spec §3.4).
 *
 * O achado verificado sempre fica em `.lms/bug-<id>.json`; abrir issue é um
 * extra. Por isso TODA falha aqui — binário ausente, token ausente, HTTP ≠ 2xx —
 * AVISA E SEGUE: falha de ferramenta nunca decide (mesma simetria da pré-rodada
 * da Fase 4).
 *
 * Texto de modelo nunca entra verbatim em comando: o título passa pelo mesmo
 * saneamento de `lms-precedentes.mjs:registrarPrecedente` (colapsar whitespace) e
 * o corpo vai sempre por ARQUIVO — `--body-file` no `gh`, `--data-binary @file`
 * no `curl`. O token do Linear também vai por arquivo, nunca em argv, onde
 * qualquer `ps` do sistema o leria.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { TRACKERS } from './lms-config.mjs';

export { TRACKERS };

const execFile = promisify(execFileCallback);

const LINEAR_URL = 'https://api.linear.app/graphql';
const MUTATION = 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { url } } }';

/** Executor default: `{ stdout, stderr, code }`, injetável para teste sem CLI real. */
async function execPadrao(cmd, args) {
  const { stdout, stderr } = await execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 });
  return { stdout, stderr, code: 0 };
}

/** Uma linha, whitespace colapsado — o saneamento de registrarPrecedente. */
export function tituloDaIssue(finding) {
  const titulo = String(finding?.title ?? '').replace(/\s+/g, ' ').trim();
  return `[lms-bug] ${titulo || finding?.path || 'achado de runtime'}`.slice(0, 200);
}

/** Corpo em markdown: o achado inteiro, mais o agente que triou. */
export function corpoDaIssue(finding, agente) {
  return [
    `**${finding.severity ?? 'P1'}** · lente \`${finding.lens ?? 'code-safety'}\` · confiança ${finding.confidence ?? 70}`,
    '',
    `**Onde:** \`${finding.path}\``,
    '',
    '**Por quê**',
    String(finding.why ?? '').trim(),
    '',
    finding.fix ? `**Fix sugerido**\n${String(finding.fix).trim()}\n` : '',
    finding.precondition ? `**Pré-condição:** ${String(finding.precondition).trim()}\n` : '',
    Array.isArray(finding.acceptance) && finding.acceptance.length
      ? `**Aceite**\n${finding.acceptance.map((a) => `- ${a}`).join('\n')}\n`
      : '',
    '---',
    `Origem: ${finding.origem?.tipo ?? 'runtime'} · sinal \`${finding.origem?.sinal ?? '(sem hash)'}\``,
    `Agente: \`${agente?.nome ?? finding.origem?.agente ?? '(sem agente)'}\``,
    `Triado por: \`${finding.found_by || '(desconhecido)'}\` · id \`${finding.id ?? '(sem id)'}\``,
    '',
    'Aberta pelo LMS. O achado passou pelo verificador adversarial antes desta issue.',
  ].filter((linha) => linha !== '').join('\n');
}

function aviso(motivo) {
  console.error(`lms-tracker: issue não aberta — ${motivo} (o achado está em .lms/)`);
  return { aberta: false, motivo };
}

/**
 * Mensagem de ferramenta vai para stderr e para o `.lms/bug-<id>.json`: se o
 * token aparecer nela, ele vaza para log e para arquivo. Redige antes de propagar.
 */
function semSegredo(texto, segredos) {
  let limpo = String(texto ?? '');
  for (const segredo of segredos) {
    if (segredo && segredo.length >= 8) limpo = limpo.split(segredo).join('[REDIGIDO]');
  }
  return limpo;
}

/**
 * Abre a issue no rastreador configurado. Nunca lança: o pior caso é
 * `{ aberta: false, motivo }` — o achado já está gravado de qualquer forma.
 */
export async function abrirIssue(tracker, finding, { env = process.env, exec = execPadrao, agente, opcoes = {} } = {}) {
  const escolhido = TRACKERS.includes(tracker) ? tracker : 'none';
  if (escolhido === 'none') {
    return { aberta: false, tracker: 'none', motivo: 'tracker none' };
  }

  const pasta = await mkdtemp(join(tmpdir(), 'lms-bug-'));
  const corpo = corpoDaIssue(finding, agente);
  const titulo = tituloDaIssue(finding);
  const segredos = [String(env.LINEAR_API_KEY ?? '').trim()];

  try {
    if (escolhido === 'github') {
      const arquivoCorpo = join(pasta, 'corpo.md');
      await writeFile(arquivoCorpo, corpo, 'utf8');
      const { stdout } = await exec('gh', [
        'issue', 'create',
        '--title', titulo,
        '--body-file', arquivoCorpo,
        '--label', 'lms-bug',
      ]);
      return { aberta: true, tracker: 'github', url: String(stdout).trim().split('\n').at(-1) ?? '' };
    }

    // linear
    const token = String(env.LINEAR_API_KEY ?? '').trim();
    if (!token) return { ...aviso('LINEAR_API_KEY ausente no ambiente'), tracker: 'linear' };
    // Env VENCE a config: a config e versionada e vale para o repo inteiro; o env
    // e de quem esta rodando. Token nunca vem da config, so daqui.
    const time = String(env.LINEAR_TEAM_ID ?? opcoes.teamId ?? '').trim();
    if (!time) {
      return {
        ...aviso('teamId do Linear ausente (LINEAR_TEAM_ID no env ou bugAgents.tracker.linear.teamId na config)'),
        tracker: 'linear',
      };
    }

    const arquivoPayload = join(pasta, 'payload.json');
    await writeFile(
      arquivoPayload,
      JSON.stringify({ query: MUTATION, variables: { input: { teamId: time, title: titulo, description: corpo } } }),
      'utf8',
    );
    // Token por arquivo de header: argv é legível por qualquer `ps` da máquina.
    const arquivoHeader = join(pasta, 'headers.txt');
    await writeFile(arquivoHeader, `authorization: ${token}\ncontent-type: application/json\n`, 'utf8');

    const { stdout } = await exec('curl', [
      '-s', '-S', '-X', 'POST',
      '-H', `@${arquivoHeader}`,
      '--data-binary', `@${arquivoPayload}`,
      '-w', '\\n%{http_code}',
      LINEAR_URL,
    ]);

    const linhas = String(stdout).split('\n');
    const status = Number(linhas.at(-1));
    if (!(status >= 200 && status < 300)) {
      return { ...aviso(`Linear respondeu HTTP ${Number.isFinite(status) ? status : '(sem status)'}`), tracker: 'linear' };
    }
    let url = '';
    try {
      url = JSON.parse(linhas.slice(0, -1).join('\n'))?.data?.issueCreate?.issue?.url ?? '';
    } catch {
      return { ...aviso('Linear respondeu 2xx com corpo não-JSON'), tracker: 'linear' };
    }
    return { aberta: true, tracker: 'linear', url };
  } catch (erro) {
    return { ...aviso(`${escolhido}: ${semSegredo(erro.message, segredos)}`), tracker: escolhido };
  } finally {
    // P2-2 da revisao da Fase 5: o token sai de argv (onde qualquer `ps` o leria)
    // mas entra num arquivo de header. Nada o apagava — nem no sucesso, nem no
    // erro —, entao cada triagem com tracker linear deixava mais uma copia do
    // LINEAR_API_KEY em claro no /tmp, sobrevivendo a sessao.
    await rm(pasta, { recursive: true, force: true });
  }
}
