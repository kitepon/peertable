#!/usr/bin/env node

/**
 * t4: 現行規範を、使い捨てroom/projectと実Codex席で一周する。
 *
 * - 親だけが自然文のmodel / effort依頼をtargetへ変換する
 * - 席を再起動し、role・議題・room履歴から再着任する
 * - 作業者が試験と自己監査を終え、最終結果だけを監査担当へ渡す
 * - 監査担当は試験を再実行せず、妥当性判断・close・抽象的な次着手だけを行う
 */

import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AitermClient } from '../skill/scripts/aiterm-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const roomServer = join(repo, "room", "server.mjs");
const launchSeat = join(repo, "skill", "scripts", "launch-seat.sh");
const changeSeat = join(repo, "skill", "scripts", "change-seat.sh");
const leaveSeat = join(repo, "skill", "scripts", "leave-seat.sh");
const parentJoin = join(repo, "skill", "scripts", "parent-join.sh");
const peertableCli = join(repo, 'skill', 'scripts', 'cli.mjs');

const workerModelBefore = process.env.T4_WORKER_MODEL_BEFORE || "gpt-5.6-terra";
const workerModelAfter = process.env.T4_WORKER_MODEL_AFTER || "gpt-5.6-sol";
const workerEffortBefore = process.env.T4_WORKER_EFFORT_BEFORE || "high";
const workerEffortAfter = process.env.T4_WORKER_EFFORT_AFTER || "max";
const auditorModel = process.env.T4_AUDITOR_MODEL || "gpt-5.6-sol";
const auditorEffort = process.env.T4_AUDITOR_EFFORT || "high";
const timeoutMs = Number(process.env.T4_TIMEOUT_MS || 240_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function command(file, args, options = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, {
      cwd: options.cwd || repo,
      env: options.env || process.env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: options.timeout ?? timeoutMs,
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code === "ETIMEDOUT" ? 124 : (error ? (error.code ?? 1) : 0),
        error: error?.message || "",
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
    child.on("error", () => {});
    child.stdin?.end();
  });
}

function commandSync(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: options.cwd || repo,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitFor(label, predicate, timeout = timeoutMs, interval = 500) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`${label} の待機がタイムアウトしました${lastError ? `: ${lastError.message}` : ""}`);
}

async function freePort() {
  const server = await new Promise((resolve, reject) => {
    const candidate = net.createServer();
    candidate.once("error", reject);
    candidate.listen(0, "127.0.0.1", () => resolve(candidate));
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }
  if (!response.ok) throw new Error(`${options.method || "GET"} ${url} -> ${response.status}: ${body}`);
  return parsed;
}

async function startRoom({ dataDir, token, port, room }) {
  const child = spawn(process.execPath, [roomServer], {
    cwd: repo,
    env: {
      ...process.env,
      PEERTABLE_PORT: String(port),
      PEERTABLE_DATA: dataDir,
      PEERTABLE_POST_TOKEN: token,
      PEERTABLE_PARENT_NAME: "bell",
      PEERTABLE_ROOM: room,
      PEERTABLE_PUBLIC_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  await waitFor("使い捨てroom", async () => {
    try {
      return (await jsonFetch(`http://127.0.0.1:${port}/api/${encodeURIComponent(room)}/summary`)).room === room;
    } catch { return false; }
  }, 30_000);
  return { child, output: () => output };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(5_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function postRoom(base, token, payload) {
  return jsonFetch(`${base}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Peertable-Token": token },
    body: JSON.stringify(payload),
  });
}

async function messages(base) {
  const result = await jsonFetch(`${base}/messages`);
  return Array.isArray(result) ? result : (result.messages || result.items || []);
}

async function members(base) {
  const result = await jsonFetch(`${base}/members`);
  return Array.isArray(result) ? result : (result.members || result.items || []);
}

async function waitForIdle(aiterm, session) {
  await waitFor(`${session} idle`, async () => {
    const observed = await aiterm.observe(session);
    return observed.state === 'idle' && observed.harness_alive === true;
  }, 120_000, 1_000);
}

async function runSupport(script) {
  const result = await command(process.execPath, [join(repo, "experiments", script)], { timeout: 120_000 });
  if (result.code !== 0) {
    throw new Error(`${script} が失敗しました (code=${result.code})\n${result.stdout}\n${result.stderr}`);
  }
  return { script, passed: true, tail: `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-4).join("\n") };
}

async function liveLifecycle() {
  const root = await mkdtemp(join(tmpdir(), "peertable-t4-"));
  const dataDir = join(root, "room-data");
  const project = join(root, "project");
  const tokenFile = join(root, "post-token.env");
  const aiterm = new AitermClient();
  const invocationLog = join(project, ".team", "t4-test-invocations.jsonl");
  const room = `t4-live-${process.pid}`;
  const token = `t4-token-${process.pid}-${Date.now()}`;
  const port = await freePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const base = `${serverUrl}/api/${encodeURIComponent(room)}`;
  let roomProcess;
  let workerBridge;
  let auditorBridge;
  let workerPresent = false;
  let auditorPresent = false;
  let parentPresent = false;
  const env = {
    ...process.env,
    PEERTABLE_TOKEN_SOURCE_FILE: tokenFile,
  };
  delete env.PEERTABLE_POST_TOKEN;
  delete env.PEERTABLE_MEMBER;
  const parentEnv = {
    ...env,
    PEERTABLE_POST_TOKEN: token,
    PEERTABLE_URL: serverUrl,
    PEERTABLE_ROOM: room,
    PEERTABLE_ROOM_API: base,
    PEERTABLE_PARENT_NAME: "bell",
    PEERTABLE_PARENT_HOST: "codex",
  };
  const workerBrief = `あなたは使い捨てroomの作業者 t4-live-worker です。.team/roles/member.md、.team/tasks.md、room履歴を正本として行動してください。起動ターンでは正本を読んで [t4-live-seat-ready] をbellへ送り、そのターンを終了してください。以後は各DMの処理を投稿したらそのターンを終了し、自分で待機処理を呼ばないでください。
- [t4-live-boot] DMでは [t4-live-boot-ok] をbellへ返す。
- [t4-live-suppressive-parent] DMでも作業を止めず、全体へ [t4-live-progress] と [claim] t4-live-work を投稿する。
- [t4-live-change] DMでは、作業が複雑になったのでSolへ変更し推論も最大にしてほしい旨を、定型文へ言い直さず自然文でbellだけへ [t4-live-change-request] として送る。
- [t4-live-rejoin] DMではrole・tasks・room履歴を読み直し、全体へ [t4-live-rejoin-ok] を投稿する。
- [t4-live-finalize] DMでは node .team/t4-self-test.mjs を自分で実行し、出力と対象を自己監査する。途中確認や監査依頼は投稿せず、最終的な試験内容・結果・自己監査だけを t4-live-auditor へ [t4-live-final-results] としてDMする。作業者自身はcloseしない。`;
  const auditorBrief = `あなたはSol監査専任席 t4-live-auditor です。.team/roles/member.md、.team/tasks.md、room履歴を読み、親から明示DMで渡される監査任務を待ってください。`;
  const auditorAssignment = `[t4-live-auditor-start] あなたはSol監査専任席です。正本を読み、まず [t4-live-auditor-ready] をbellへ送ってこのターンを終了してください。以後、作業者の [t4-live-final-results] が届いたら、試験を実行せず、報告された試験内容と結果が妥当かだけを判断してください。妥当なら全体へ順に [t4-live-audit-accepted]、[done] t4-live-work、次の工程に着手してください と投稿し、そのターンを終了してください。具体的な次工程、追加試験、改善案、差し戻しは書かず、自分で待機処理を呼ばないでください。`;

  try {
    await mkdir(dataDir, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(tokenFile, `PEERTABLE_POST_TOKEN=${token}\n`, { mode: 0o600 });
    const tasksFile = join(root, 'tasks.md');
    await writeFile(tasksFile, '# 自律作業の実機試験\n\n- t4-live-work\n');
    roomProcess = await startRoom({ dataDir, token, port, room });
    const setup = await command(process.execPath, [peertableCli, 'setup', project,
      '--room', room, '--url', serverUrl, '--tasks', tasksFile], { env, timeout: 120_000 });
    assert.equal(setup.code, 0, setup.stderr);
    await writeFile(join(project, ".team", "t4-deliverable.txt"), "t4-ready\n");
    await writeFile(join(project, ".team", "t4-self-test.mjs"), `import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
assert.equal(readFileSync(new URL("./t4-deliverable.txt", import.meta.url), "utf8"), "t4-ready\\n");
appendFileSync(new URL("./t4-test-invocations.jsonl", import.meta.url), JSON.stringify({ member: process.env.PEERTABLE_MEMBER || null, result: "1/1" }) + "\\n");
console.log("t4-self-test: 1/1 green");
`);

    const joined = await command("bash", [parentJoin, project, "bell", auditorModel, auditorEffort, "codex"], {
      env: parentEnv, timeout: 120_000,
    });
    assert.equal(joined.code, 0, `${joined.stdout}\n${joined.stderr}`);
    parentPresent = true;
    const parent = (await members(base)).find((item) => item.name === "bell");
    assert.equal(parent?.delivery?.kind, "parent_watch");

    const beforeParentTurn = (await messages(base)).length;
    const parentTurn = await command("codex", [
      "exec", "--json", "--model", auditorModel, "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "あなたはこの使い捨てroomの親bellです。.team/roles/parent.mdを読み、親が技術監査・通常工程操作・配車・作業者や監査担当の代行をしないことを確認してください。room投稿、コード変更、試験実行はせず、最後にT4_PARENT_ROLE_READYだけを回答してください。",
    ], { cwd: project, env: parentEnv, timeout: timeoutMs });
    assert.equal(parentTurn.code, 0, `${parentTurn.stdout}\n${parentTurn.stderr}`);
    assert.match(parentTurn.stdout, /T4_PARENT_ROLE_READY/);
    assert.equal((await messages(base)).length, beforeParentTurn);

    let launch = await command("bash", [launchSeat, project, "t4-live-worker", "実装", workerBrief,
      "--model", workerModelBefore, "--vendor", "codex", "--effort", workerEffortBefore], { env, timeout: timeoutMs });
    assert.equal(launch.code, 0, `${launch.stdout}\n${launch.stderr}`);
    workerPresent = true;
    await waitFor("作業席member登録", async () => (await members(base)).some((item) => item.name === "t4-live-worker"));
    await waitFor("作業席起動完了", async () => (await messages(base)).some((item) =>
      item.from === "t4-live-worker" && item.body?.includes("[t4-live-seat-ready]")));
    await waitForIdle(aiterm, "peer-t4-live-worker");

    await postRoom(base, token, { from: "bell", to: "t4-live-worker", body: "[t4-live-boot] 再着任内容を返してください。" });
    await waitFor("boot応答", async () => (await messages(base)).some((item) =>
      item.from === "t4-live-worker" && item.body?.includes("[t4-live-boot-ok]")));
    await waitForIdle(aiterm, "peer-t4-live-worker");

    await postRoom(base, token, { from: "bell", to: "t4-live-worker", body: "[t4-live-suppressive-parent] 親への応答後も自律作業を続けてください。" });
    await waitFor("自律progress/claim", async () => {
      const log = (await messages(base)).filter((item) => item.from === "t4-live-worker");
      return log.some((item) => item.body?.includes("[t4-live-progress]"))
        && log.some((item) => item.body?.includes("[claim] t4-live-work"));
    });
    await waitForIdle(aiterm, "peer-t4-live-worker");
    assert.equal((await messages(base)).some((item) => item.from === "bell" && item.body?.includes("[配車]")), false);

    await postRoom(base, token, { from: "bell", to: "t4-live-worker", body: "[t4-live-change] 現在の作業量に合う席設定を自然文で相談してください。" });
    const changeRequest = await waitFor("自然文の変更依頼", async () => (await messages(base)).find((item) =>
      item.from === "t4-live-worker" && item.to === "bell" && item.body?.includes("[t4-live-change-request]")));
    await waitForIdle(aiterm, "peer-t4-live-worker");
    const change = await command("bash", [changeSeat, project, "t4-live-worker",
      "--model", workerModelAfter, "--effort", workerEffortAfter, "--parent", "bell",
      "--reason", "作業者の自然文相談を親が判断し、Solと最大推論をtargetとして確定"], { env, timeout: timeoutMs });
    assert.equal(change.code, 0, `${change.stdout}\n${change.stderr}`);
    assert.equal(change.stdout.includes(changeRequest.body), false);
    const configured = (await members(base)).find((item) => item.name === "t4-live-worker");
    assert.equal(configured?.model, workerModelAfter);
    assert.equal(configured?.effort, workerEffortAfter);

    await waitForIdle(aiterm, "peer-t4-live-worker");
    await stopProcess(workerBridge);
    workerBridge = null;
    const left = await command("bash", [leaveSeat, project, "t4-live-worker"], { env, timeout: 60_000 });
    assert.equal(left.code, 0, `${left.stdout}\n${left.stderr}`);
    workerPresent = false;
    const readyBeforeRestart = (await messages(base)).filter((item) =>
      item.from === "t4-live-worker" && item.body?.includes("[t4-live-seat-ready]")).length;
    launch = await command("bash", [launchSeat, project, "t4-live-worker", "実装", workerBrief,
      "--model", workerModelAfter, "--vendor", "codex", "--effort", workerEffortAfter], { env, timeout: timeoutMs });
    assert.equal(launch.code, 0, `${launch.stdout}\n${launch.stderr}`);
    workerPresent = true;
    await waitFor("再起動した作業席の起動完了", async () => (await messages(base)).filter((item) =>
      item.from === "t4-live-worker" && item.body?.includes("[t4-live-seat-ready]")).length > readyBeforeRestart);
    await waitForIdle(aiterm, "peer-t4-live-worker");
    await postRoom(base, token, { from: "bell", to: "t4-live-worker", body: "[t4-live-rejoin] role・tasks・room履歴から再着任してください。" });
    await waitFor("再着任応答", async () => (await messages(base)).some((item) =>
      item.from === "t4-live-worker" && item.body?.includes("[t4-live-rejoin-ok]")));
    await waitForIdle(aiterm, "peer-t4-live-worker");

    const auditLaunch = await command("bash", [launchSeat, project, "t4-live-auditor", "監査・発見", auditorBrief,
      "--model", auditorModel, "--vendor", "codex", "--effort", auditorEffort], { env, timeout: timeoutMs });
    assert.equal(auditLaunch.code, 0, `${auditLaunch.stdout}\n${auditLaunch.stderr}`);
    auditorPresent = true;
    await waitFor("監査席member登録", async () => (await members(base)).some((item) =>
      item.name === "t4-live-auditor" && item.role === "監査・発見"));
    await postRoom(base, token, { from: "bell", to: "t4-live-auditor", body: auditorAssignment });
    await waitFor("監査席起動完了", async () => (await messages(base)).some((item) =>
      item.from === "t4-live-auditor" && item.body?.includes("[t4-live-auditor-ready]")));
    await waitForIdle(aiterm, "peer-t4-live-auditor");

    await postRoom(base, token, { from: "bell", to: "t4-live-worker", body: "[t4-live-finalize] 自己試験・自己監査を完了し、最終結果だけを監査担当へ渡してください。" });
    const finalResults = await waitFor("最終試験結果", async () => (await messages(base)).find((item) =>
      item.from === "t4-live-worker" && item.to === "t4-live-auditor"
      && item.body?.includes("[t4-live-final-results]") && item.body?.includes("1/1")));
    const accepted = await waitFor("監査受理", async () => (await messages(base)).find((item) =>
      item.from === "t4-live-auditor" && item.body?.includes("[t4-live-audit-accepted]")));
    const closed = await waitFor("監査担当close", async () => (await messages(base)).find((item) =>
      item.from === "t4-live-auditor" && item.body?.includes("[done] t4-live-work")));
    const next = await waitFor("抽象的な次着手", async () => (await messages(base)).find((item) =>
      item.from === "t4-live-auditor" && item.body === "次の工程に着手してください"));
    assert.ok(finalResults.seq < accepted.seq && accepted.seq < closed.seq && closed.seq < next.seq);
    const roomLog = await messages(base);
    assert.equal(roomLog.some((item) => item.from === "t4-live-worker"
      && /途中確認|監査依頼/u.test(item.body || "")), false);
    assert.equal(roomLog.some((item) => item.from === "bell"
      && /\[t4-live-audit-accepted\]|\[done\]/u.test(item.body || "")), false);
    assert.equal(roomLog.some((item) => item.seq > closed.seq && item.from === "t4-live-auditor"
      && item.body !== "次の工程に着手してください"), false);

    const invocations = (await readFile(invocationLog, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(invocations.some((item) => item.member === "t4-live-worker"));
    assert.equal(invocations.some((item) => item.member === "t4-live-auditor"), false);
    assert.equal(invocations.every((item) => item.result === "1/1"), true);
    return {
      room,
      models: { worker_before: workerModelBefore, worker_after: workerModelAfter, auditor: auditorModel },
      efforts: { worker_before: workerEffortBefore, worker_after: workerEffortAfter, auditor: auditorEffort },
      checks: [
        "real-parent-role-boundary",
        "real-active-progress-and-self-claim",
        "real-natural-model-effort-change-by-parent",
        "real-restart-and-rejoin-from-role-task-room",
        "real-worker-self-test-self-audit-final-results-only",
        "real-auditor-no-retest-close-and-generic-next",
      ],
      sequence: { final_results: finalResults.seq, accepted: accepted.seq, closed: closed.seq, next: next.seq },
      test_invocations: invocations,
      message_count: roomLog.length,
      room_output_tail: roomProcess.output().trim().split("\n").slice(-4).join("\n"),
    };
  } finally {
    if (workerBridge) await stopProcess(workerBridge);
    if (auditorBridge) await stopProcess(auditorBridge);
    if (workerPresent) await command("bash", [leaveSeat, project, "t4-live-worker"], { env, timeout: 60_000 });
    if (auditorPresent) await command("bash", [leaveSeat, project, "t4-live-auditor"], { env, timeout: 60_000 });
    if (parentPresent) {
      await fetch(`${base}/members/${encodeURIComponent("bell")}`, {
        method: "DELETE", headers: { "X-Peertable-Token": token },
      }).catch(() => {});
    }
    const cleanup = await command(process.execPath, [peertableCli, 'teardown', project], { env, timeout: 60_000 });
    if (cleanup.code !== 0) throw new Error(cleanup.stderr);
    await aiterm.close();
    if (roomProcess) await stopProcess(roomProcess.child);
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const support = [];
  for (const script of ["seat-change-repro.mjs", "parent-role-repro.mjs"]) {
    support.push(await runSupport(script));
  }
  const live = await liveLifecycle();
  console.log(JSON.stringify({
    schema: "peertable.t4.autonomy-lifecycle.v2",
    started_at: new Date().toISOString(),
    support,
    live,
    passed: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    schema: "peertable.t4.autonomy-lifecycle.v2",
    passed: false,
    error: error.stack || String(error),
  }, null, 2));
  process.exitCode = 1;
});
