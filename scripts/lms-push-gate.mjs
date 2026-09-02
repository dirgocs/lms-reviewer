#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isExempt } from './lms-exempt-paths.mjs';
import { loadConfig, projectRoot } from './lms-config.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function command(file, args, { root, input = '' } = {}) {
  const result = spawnSync(file, args, {
    cwd: root,
    env: { ...process.env, LMS_PROJECT_ROOT: root },
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '' };
}

async function listChangedFromGit(root, input) {
  const result = command('sh', [join(SCRIPT_DIR, 'lms-push-changed.sh')], { root, input });
  return {
    ok: result.code === 0,
    files: result.stdout.split('\n').map((line) => line.trim()).filter(Boolean),
  };
}

async function triggerReviewer(root) {
  return command('bash', [join(SCRIPT_DIR, 'lms-reviewer-trigger.sh')], { root }).code;
}

export async function pushGate({ listChanged, classify, trigger }) {
  const changed = await listChanged();
  const exempt = changed.ok && classify(changed.files);
  if (exempt) return { code: 0, exempt: true };
  return { code: await trigger(), exempt: false };
}

export async function main() {
  const root = projectRoot();
  const input = readFileSync(0, 'utf8');
  const rules = loadConfig(root);
  const result = await pushGate({
    listChanged: () => listChangedFromGit(root, input),
    classify: (files) => isExempt(files, rules),
    trigger: () => triggerReviewer(root),
  });
  if (result.exempt) {
    console.log('LMS gate: push so com doc/tooling configurado — isento. Codigo continua barrado.');
  }
  return result.code;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = await main();
