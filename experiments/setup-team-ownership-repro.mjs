#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = path.join(ROOT, 'skill', 'scripts', 'setup.sh');
const TEARDOWN = path.join(ROOT, 'skill', 'scripts', 'teardown.sh');
const TEAM_SENTINEL = 'project-owned team asset — do not replace\n';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    if (error.code === 'EISDIR') return true;
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function git(project, ...args) {
  const result = await run('git', args, { cwd: project });
  assert.equal(result.code, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function status(project) {
  return git(project, 'status', '--short', '--untracked-files=all');
}

async function makeServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url?.endsWith('/members')) {
      response.end(JSON.stringify({
        capabilities: { member_observation_v1: true },
        members: [],
      }));
      return;
    }
    if (request.method === 'GET' && request.url?.endsWith('/messages')) {
      response.end(JSON.stringify({ messages: [] }));
      return;
    }
    if (request.method === 'DELETE') {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.notEqual(address, null);
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function makeCli(root) {
  const cli = path.join(root, 'fixture-lattice');
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "list" ] && [ "$3" = "--json" ]; then
  printf '%s\\n' '{"schema":"lattice.run_list.v1","active_runs":[]}'
  exit 0
fi
printf '%s\\n' '{"schema":"fixture.lattice.v1"}'
`);
  await chmod(cli, 0o755);
  return cli;
}

async function makeFixture(root, name, { trackedTeam = false, existingTeam = false } = {}) {
  const project = path.join(root, name);
  await mkdir(project, { recursive: true });
  assert.equal((await run('git', ['init', '--quiet', '--initial-branch=main'], { cwd: project })).code, 0);
  await git(project, 'config', 'user.name', 'h4 fixture');
  await git(project, 'config', 'user.email', 'h4-fixture@example.invalid');
  await writeFile(path.join(project, 'README.md'), `${name}\n`);
  await git(project, 'add', 'README.md');
  await git(project, 'commit', '--quiet', '-m', 'fixture base');
  const excludeBefore = await readFile(path.join(project, '.git', 'info', 'exclude'), 'utf8');

  const sentinel = path.join(project, '.team', 'scripts', 'done.sh');
  const existing = path.join(project, '.team', 'project-owned.txt');
  if (trackedTeam) {
    await mkdir(path.dirname(sentinel), { recursive: true });
    await writeFile(sentinel, TEAM_SENTINEL);
    await git(project, 'add', '.team/scripts/done.sh');
    await git(project, 'commit', '--quiet', '-m', 'track team asset');
  }
  if (existingTeam) {
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, TEAM_SENTINEL);
  }
  return { project, excludeBefore, sentinel, existing };
}

function setupArgs(project, url) {
  return [SETUP, project, `h4-${path.basename(project)}`, url, 'fixture-plan', ROOT];
}

function setupEnv(cli, socket) {
  return {
    LATTICE_CLI: cli,
    PEERTABLE_POST_TOKEN: 'fixture-token',
    PEERTABLE_PUBLIC_URL: 'https://fixture.example.invalid',
    PEERTABLE_TMUX_SOCKET: socket,
  };
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'peertable-setup-team-'));
const sockets = [];
const { server, url } = await makeServer();
const cli = await makeCli(temporaryRoot);

try {
  const tracked = await makeFixture(temporaryRoot, 'tracked-team', { trackedTeam: true });
  const trackedBefore = await status(tracked.project);
  const trackedResult = await run('bash', setupArgs(tracked.project, url), {
    cwd: tracked.project,
    env: setupEnv(cli, path.join(temporaryRoot, 'tracked.sock')),
  });
  assert.notEqual(trackedResult.code, 0);
  assert.match(trackedResult.stderr, /PEERTABLE_SETUP_TEAM_CONFLICT/);
  assert.match(trackedResult.stderr, /\.team\/scripts\/done\.sh/);
  assert.equal(await readFile(tracked.sentinel, 'utf8'), TEAM_SENTINEL);
  assert.equal(await status(tracked.project), trackedBefore);
  assert.equal(await readFile(path.join(tracked.project, '.git', 'info', 'exclude'), 'utf8'), tracked.excludeBefore);
  assert.equal(await exists(path.join(tracked.project, '.mcp.json')), false);
  assert.equal(await exists(path.join(tracked.project, '.team', 'charter.md')), false);
  assert.equal(await exists(path.join(tracked.project, '.team', 'setup-state.json')), false);

  const existing = await makeFixture(temporaryRoot, 'existing-team', { existingTeam: true });
  const existingBefore = await status(existing.project);
  const existingResult = await run('bash', setupArgs(existing.project, url), {
    cwd: existing.project,
    env: setupEnv(cli, path.join(temporaryRoot, 'existing.sock')),
  });
  assert.notEqual(existingResult.code, 0);
  assert.match(existingResult.stderr, /PEERTABLE_SETUP_TEAM_CONFLICT/);
  assert.match(existingResult.stderr, /\.team\/project-owned\.txt/);
  assert.equal(await readFile(existing.existing, 'utf8'), TEAM_SENTINEL);
  assert.equal(await status(existing.project), existingBefore);
  assert.equal(await readFile(path.join(existing.project, '.git', 'info', 'exclude'), 'utf8'), existing.excludeBefore);
  assert.equal(await exists(path.join(existing.project, '.mcp.json')), false);
  assert.equal(await exists(path.join(existing.project, '.team', 'charter.md')), false);
  assert.equal(await exists(path.join(existing.project, '.team', 'setup-state.json')), false);

  const clean = await makeFixture(temporaryRoot, 'clean-team');
  const socket = path.join(temporaryRoot, 'clean.sock');
  sockets.push(socket);
  const setupResult = await run('bash', setupArgs(clean.project, url), {
    cwd: clean.project,
    env: setupEnv(cli, socket),
  });
  assert.equal(setupResult.code, 0, `clean setup failed\n${setupResult.stdout}\n${setupResult.stderr}`);
  assert.equal(await exists(path.join(clean.project, '.team', 'setup-state.json')), true);
  assert.equal(await exists(path.join(clean.project, '.team', 'roles', 'member.md')), true);

  const teardownResult = await run('bash', [TEARDOWN, clean.project, '--purge'], {
    cwd: clean.project,
    env: setupEnv(cli, socket),
  });
  assert.equal(teardownResult.code, 0, `clean teardown failed\n${teardownResult.stdout}\n${teardownResult.stderr}`);
  assert.equal(await status(clean.project), '');
  assert.equal(await readFile(path.join(clean.project, '.git', 'info', 'exclude'), 'utf8'), clean.excludeBefore);
  assert.equal(await exists(path.join(clean.project, '.team')), false);
  assert.equal(await exists(path.join(clean.project, '.mcp.json')), false);
  assert.equal(await exists(path.join(clean.project, '.lattice')), false);

  console.log('OK tracked/existing .team conflictは無変更typed failure、clean setup→purge teardownはdiffゼロ');
} finally {
  await new Promise(resolve => server.close(resolve));
  for (const socket of sockets) await run('tmux', ['-S', socket, 'kill-server']);
  await rm(temporaryRoot, { recursive: true, force: true });
}
