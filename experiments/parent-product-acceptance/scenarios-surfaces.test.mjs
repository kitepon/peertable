// 公式snapshot/readerの判定とOS起動だけをfocusedで確認する。実機合格の代用にはしない。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { nativeInvocation, grokControlledTaskEnd } from './scenarios-surfaces.mjs'
import { shellCommand } from '../../skill/scripts/parent-platform.mjs'

const fixture = () => {
  const output = '受信processの終了\n', id = 'own-task', session = 'own-session'
  const snapshot = { task_id: id, owner_session_id: session, completed: true, explicitly_killed: true, output, output_file: '/own/output', output_total_bytes: Buffer.byteLength(output), exit_code: null, signal: 15 }
  const seen = { tasks: [{ type: 'task_completed', task_id: id, session, order: 12, raw_output: snapshot }], toolUses: [
    { id: 'cancel-use', name: 'kill_task', input: { task_id: id }, output: { 公式結果: '原値を保持' }, output_order: 13, order: 10, session },
    { id: 'reader-use', name: 'get_command_or_subagent_output', input: { task_ids: [id] }, order: 14, session, output: { type: 'TaskOutput', Result: { task_id: id, status: 'completed', truncated: false, output, output_file: snapshot.output_file, raw_output_bytes: snapshot.output_total_bytes } } },
  ] }
  return { seen, request: { operation: 'cancel', id, session, before: 10 } }
}

test('Grok cancelは同taskの公式kill・明示取消snapshot・全量readerを全て照合する', () => {
  const { seen, request } = fixture(), result = grokControlledTaskEnd(seen, request, { sameProcess: () => false })
  assert.equal(result.outcome, 'cancel'); assert.equal(result.control.id, 'cancel-use'); assert.equal(result.reader_tool_use_id, 'reader-use'); assert.equal(result.output, seen.tasks[0].raw_output.output)
  seen.tasks[0].raw_output.owner_session_id = '他会話'
  assert.throws(() => grokControlledTaskEnd(seen, request, { sameProcess: () => false }), { code: 'ACCEPTANCE_GROK_NATIVE_TASK_OWNER' })
})

test('既に終了済みtaskや別task取消・短縮readerはcancel成功にしない', () => {
  for (const mutate of [seen => { seen.tasks[0].raw_output.explicitly_killed = false }, seen => { seen.toolUses[0].input.task_id = '別task' }]) {
    const { seen, request } = fixture(); mutate(seen)
    assert.throws(() => grokControlledTaskEnd(seen, request, { sameProcess: () => false }), { code: 'ACCEPTANCE_GROK_CANCEL_NOT_OBSERVED' })
  }
  const { seen, request } = fixture(); seen.toolUses[1].input.timeout_ms = 1
  assert.equal(grokControlledTaskEnd(seen, request, { sameProcess: () => false }), null)
  delete seen.toolUses[1].input.timeout_ms; seen.toolUses[1].output.Result.output = '切詰め'
  assert.throws(() => grokControlledTaskEnd(seen, request, { sameProcess: () => false }), { code: 'ACCEPTANCE_GROK_NATIVE_FULL_READ' })
})

test('Grok exitは取消と区別してown受信process消失と異常task終了を要求する', () => {
  const { seen, request } = fixture(); request.operation = 'exit'; request.receiver_owner = { pid: 123, started: 'own-start' }; request.process_fault = { operation: 'SIGTERM', owner: request.receiver_owner }; seen.tasks[0].raw_output.explicitly_killed = false
  assert.equal(grokControlledTaskEnd(seen, request, { sameProcess: () => false }).outcome, 'exit')
  assert.throws(() => grokControlledTaskEnd(seen, request, { sameProcess: () => true }), { code: 'ACCEPTANCE_GROK_EXIT_NOT_OBSERVED' })
  seen.tasks[0].raw_output.signal = null; seen.tasks[0].raw_output.exit_code = 0
  assert.throws(() => grokControlledTaskEnd(seen, request, { sameProcess: () => false }), { code: 'ACCEPTANCE_GROK_EXIT_NOT_OBSERVED' })
})

test('取消後のready本文を検出して本文配送との混同を拒否できる', () => {
  const { seen, request } = fixture(), output = JSON.stringify({ schema: 'peertable.parent-background-result.v1', outcome: 'ready' }) + '\n'
  Object.assign(seen.tasks[0].raw_output, { output, output_total_bytes: Buffer.byteLength(output) })
  Object.assign(seen.toolUses[1].output.Result, { output, raw_output_bytes: Buffer.byteLength(output) })
  assert.equal(grokControlledTaskEnd(seen, request, { sameProcess: () => false }).delivered, true)
})

test('Windows起動はPowerShell7 EncodedCommandへspace/quote argvを閉じ、対話stdinを妨げない', () => {
  const executable = "C:\\Program Files\\親'入口.ps1", argv = ['空白 引数', "quote'\"", '$env:HOME', '`literal']
  const invocation = nativeInvocation(executable, argv, { platformName: 'win32', shellCommand, interactive: true })
  assert.equal(invocation.executable, 'pwsh.exe'); assert.ok(!invocation.argv.includes('-NonInteractive'))
  const script = Buffer.from(invocation.argv.at(-1), 'base64').toString('utf16le')
  assert.ok(script.includes(shellCommand(executable, argv, 'win32')))
  assert.ok(nativeInvocation(executable, argv, { platformName: 'win32', shellCommand }).argv.includes('-NonInteractive'))
})

test('POSIX起動はargv/env/cwd/stdinを実childへそのまま渡す', async () => {
  const args = ['空白 引数', "quote'\"", '$HOME', '`literal']
  const invocation = nativeInvocation(process.execPath, ['-e', "let input='';for await(const part of process.stdin)input+=part;console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),value:process.env.PEERTABLE_FIXTURE_LITERAL,input}));", ...args], { platformName: 'darwin', shellCommand, interactive: true })
  const cwd = process.cwd(), child = spawn(invocation.executable, invocation.argv, { cwd, env: { ...process.env, PEERTABLE_FIXTURE_LITERAL: "値 $HOME ' \"" }, stdio: ['pipe', 'pipe', 'inherit'] })
  let output = ''; child.stdout.on('data', part => { output += part }); child.stdin.end('日本語 stdin\n')
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  assert.equal(code, 0); assert.deepEqual(JSON.parse(output), { args, cwd, value: "値 $HOME ' \"", input: '日本語 stdin\n' })
})
