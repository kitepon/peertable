// 席に許可した作業の既知承認だけを、Aitermが示した現在の確認へ単発で返す。
export async function passSeatApproval(aiterm, sessionId, harness, observation) {
  if (!['codex', 'claude'].includes(harness)) return false
  if (harness === 'claude') {
    const current = observation ?? await aiterm.observe(sessionId)
    if (current.state !== 'blocked' || current.reason !== 'tool_approval') return false
  }
  const tool = harness === 'claude' ? 'claude_approval' : 'agent_approval'
  const schema = harness === 'claude' ? 'aiterm.claude-approval-result.v1' : 'aiterm.agent-approval-result.v1'
  const inspection = await aiterm.structured(tool, {
    action: 'inspect', session_id: sessionId,
  }, schema)
  if (inspection.status === 'none') return false
  if (inspection.status !== 'approval_required' || !inspection.choices.some(choice => choice.decision === 'approve_once')) {
    throw Object.assign(new Error(`席 ${sessionId} の承認を解決できません: ${inspection.reason}`), { code: 'PEERTABLE_SEAT_APPROVAL_BLOCKED' })
  }
  const response = await aiterm.structured(tool, {
    action: 'respond', session_id: sessionId, observed_prompt_digest: inspection.prompt_digest, approval_choice: 'approve_once',
  }, schema)
  if (response.status !== 'submitted') {
    throw Object.assign(new Error(`席 ${sessionId} の承認応答が成立していません`), { code: 'PEERTABLE_SEAT_APPROVAL_BLOCKED' })
  }
  return true
}
