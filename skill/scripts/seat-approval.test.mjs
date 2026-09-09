import test from 'node:test'
import assert from 'node:assert/strict'
import { passSeatApproval } from './seat-approval.mjs'

test('公開APIのdigestと単発許可だけを返す', async () => {
  const calls = []
  const aiterm = { structured: async (tool, args) => {
    calls.push({ tool, args })
    return args.action === 'inspect'
      ? { status: 'approval_required', prompt_digest: 'current-digest', choices: [{ decision: 'approve_once', label: '今回だけ許可' }] }
      : { status: 'submitted' }
  } }
  assert.equal(await passSeatApproval(aiterm, 'seat', 'codex'), true)
  assert.deepEqual(calls[1], { tool: 'agent_approval', args: { action: 'respond', session_id: 'seat', observed_prompt_digest: 'current-digest', approval_choice: 'approve_once' } })
})

test('未知の確認・digest不一致を握りつぶさず、再送しない', async () => {
  let count = 0
  const aiterm = { structured: async () => { count++; throw new Error('dialog_changed') } }
  await assert.rejects(passSeatApproval(aiterm, 'seat', 'codex'), /dialog_changed/)
  assert.equal(count, 1)
})

test('承認が無ければ何も送らない', async () => {
  let count = 0
  assert.equal(await passSeatApproval({ structured: async () => { count++; return { status: 'none' } } }, 'seat', 'codex'), false)
  assert.equal(count, 1)
})
test('Claudeのtool承認だけを既存の相関付き公開APIへ渡す', async () => {
  const calls = []
  const aiterm = { structured: async (tool, args, schema) => {
    calls.push({ tool, args, schema })
    return args.action === 'inspect' ? { status: 'approval_required', prompt_digest: 'claude-digest', choices: [{ decision: 'approve_once' }] } : { status: 'submitted' }
  } }
  for (const observation of [{ state: 'idle' }, { state: 'blocked', reason: 'project_mcp_consent' }]) {
    assert.equal(await passSeatApproval(aiterm, 'seat', 'claude', observation), false)
  }
  assert.equal(calls.length, 0)
  assert.equal(await passSeatApproval(aiterm, 'seat', 'claude', { state: 'blocked', reason: 'tool_approval' }), true)
  assert.equal(calls[1].tool, 'claude_approval')
  assert.equal(calls[1].schema, 'aiterm.claude-approval-result.v1')
  assert.equal(calls[1].args.observed_prompt_digest, 'claude-digest')
})
