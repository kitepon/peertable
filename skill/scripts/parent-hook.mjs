#!/usr/bin/env node
// Peertable所有hook。互換読込みも実processのハーネスと照合して1 adapterだけ動かす。
import { hookContext, endpointsFor, verifyJoinHook, assertClaudeParent } from './parent-caller.mjs'
import { harnessProcess, failure } from './parent-platform.mjs'
import { claudeRewake } from './parent-receivers/claude.mjs'
import { cursorEvent } from './parent-receivers/cursor.mjs'
import { bindNativeWait } from './parent-receivers/background.mjs'
import { codexHook } from './parent-receivers/codex.mjs'
import { stopEndpoint } from './parent-runtime.mjs'

const harness = process.argv[2]
const writeJson = value => new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve()))
const writeError = value => new Promise((resolve, reject) => process.stderr.write(`${value}\n`, error => error ? reject(error) : resolve()))
try {
  let raw = ''; for await (const chunk of process.stdin) raw += chunk
  const event = JSON.parse(raw)
  if (harness === 'claude') assertClaudeParent(event)
  const eventName = harness === 'grok' ? event.hook_event_name : event.hook_event_name
  const pre = eventName === (harness === 'cursor' ? 'preToolUse' : 'PreToolUse')
  const empty = pre && harness === 'cursor' ? { permission: 'allow' } : {}
  const owner = harnessProcess(harness)
  if (!owner) { await writeJson(empty) }
  else if (pre) {
    const saved = hookContext(harness, event)
    await writeJson(!saved || harness === 'claude' ? empty : harness === 'cursor'
      ? { permission: 'allow', updated_input: saved.updated }
      : { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: saved.updated } })
  } else {
    const conversation = harness === 'grok' ? event.sessionId : harness === 'cursor' ? event.conversation_id : event.session_id
    if (!conversation) throw failure('PARENT_CALLER_UNBOUND')
    const endpoints = endpointsFor({ caller: { harness, conversation } }).filter(spool => {
      const bound = spool.read().caller.owner
      return bound.pid === owner.pid && bound.started === owner.started && spool.read().runtime !== 'stopped'
    })
    let emitted = false
    if (['PostToolUse', 'postToolUse', 'afterMCPExecution'].includes(eventName) && harness !== 'codex') verifyJoinHook(harness, event, owner)
    if (harness === 'claude' && ['PostToolUse', 'Stop'].includes(eventName)) {
      const code = await claudeRewake(endpoints, writeError)
      process.exitCode = code
      emitted = code === 2
    }
    for (const spool of endpoints) {
      if (['SessionEnd', 'sessionEnd'].includes(eventName)) { await stopEndpoint(spool); continue }
      if (harness === 'codex' && ['PostToolUse', 'Stop'].includes(eventName)) {
        if (await codexHook(spool, event, writeJson)) { emitted = true; break }
      } else if (['cursor', 'grok'].includes(harness) && ['postToolUse', 'PostToolUse', 'afterMCPExecution'].includes(eventName)) {
        try { if (harness === 'grok') await bindNativeWait(spool, event, harness) }
        catch (error) { spool.update({ runtime: 'failed', error_code: error.code, error_detail: error.message }); throw error }
        if (harness === 'cursor' && await cursorEvent(spool, event, writeJson)) { emitted = true; break }
      }
    }
    if (!emitted && harness !== 'claude') await writeJson(empty)
  }
} catch (error) {
  const code = error.code ?? 'PARENT_HOOK_FAILED'
  await writeError(`${code}: ${error.message}`)
  if (harness === 'cursor') await writeJson({ permission: 'deny', agent_message: code })
  process.exitCode = 1
}
