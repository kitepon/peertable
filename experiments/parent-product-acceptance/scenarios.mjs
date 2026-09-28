// 実機受入24scenarioの手順。公式親の会話と実境界の観測が揃うまで合格を作らない。
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { scenarios as inventory } from '../../scripts/parent-delivery-acceptance.mjs'

export const scenarioNames = Object.keys(inventory).filter(name => name !== 'audience')
const fail = (code, detail) => { throw Object.assign(new Error(detail), { code }) }
const step = (action, expectation, input = {}) => ({ action, expectation, input })
const send = (label = '本文', input = {}) => step('deliver', 'native_delivery', { label, ...input })
const native = (action, expectation, input = {}) => step(action, expectation, input)

// 各adapterは同じ目的を自harnessの公式境界で実施する。未知の境界を類似APIへ置換しない。
export const receiverBoundaries = {
  claude: { active: '実sessionのPostToolUse/Stop asyncRewake', claim: '実hook processのclaimとstderr exit2', output: 'asyncRewakeのstderr出力', background: '実sessionのhook process', foreign: '利用者hookと承認', lease: 'asyncRewake有限leaseと同join再武装', switch: '/clear・/exit・公式resume' },
  codex: { active: '実threadの同期PostToolUse/Stop', claim: '所有queueのdelete:trueと実hook process', output: 'additionalContext/block reasonのstdout出力', background: '公式thread queueと接続', foreign: '同threadの利用者/Aiterm所有queueとhook', lease: 'queue接続更新', switch: '/new・/quit・公式resume' },
  cursor: { active: '実conversationのadditional_context', claim: '公式hookとnative背景Shellの共通claim', output: 'hook stdoutと背景Shell完了', background: '親所有native Shell/task', foreign: '利用者hookと承認', lease: '背景task有限leaseと次登録', switch: '公式新会話・終了・resume' },
  grok: { active: '実sessionのrun_terminal_command背景完了', claim: '背景processとparent_readの共通claim', output: '完了task出力とparent_read最終page', background: '親所有run_terminal_command task', foreign: '利用者hookと承認', lease: '背景task有限leaseと次登録', switch: '公式新会話・終了・resume' },
}

// 文字数上限は導入物のPAGE_CHARSをcontextから受け取る。上限をrunnerに複製しない。
export function scenarioPlan(name, { pageChars } = {}) {
  const plans = {
    busy: [native('work_start', 'work_running'), send(), native('work_finish', 'work_continued')],
    final_race: [native('final_arm', 'final_boundary_armed'), send('終了境界'), native('final_observe', 'final_no_loss_duplicate')],
    idle: [native('idle_wait', 'idle_without_input'), send('待機から起床'), native('idle_observe', 'idle_new_turn_without_input')],
    consecutive: [send('1通目'), native('idle_wait', 'idle_without_input'), send('2通目'), native('work_start', 'work_running'), send('3通目'), native('work_finish', 'work_continued'), native('sequence_observe', 'seq_order')],
    no_external_tools: [native('policy_set', 'policy_installed', { tools: 'parent_only' }), send('外部作業toolなし'), native('tools_observe', 'no_external_tools')],
    no_tools: [native('policy_set', 'policy_installed', { tools: 'none' }), send('全toolなし', { allowRetained: true }), native('tools_observe', 'no_tools_or_explicit_rearm'), native('policy_set', 'policy_installed', { tools: 'normal' }), native('retained_recover', 'retained_native_recovery')],
    original: [send('日本語・引用・改行', { body: `日本語😀\n「引用」 'q' "double" <tag a="1"> & 字面&gt;\n\\path\\改行\r\n末尾\n` }), send('長文全量', { long: true }), native('pages_observe', 'whole_body_recovered')],
    burst: [native('burst_start', 'burst_above_page_limit', { count: 4 }), native('burst_observe', 'unread_until_last_page'), native('burst_finish', 'burst_seq_whole_body')],
    source_reconnect: [native('source_disconnect', 'http_sse_disconnected'), send('切断中', { defer: true }), native('source_reconnect', 'http_sse_catchup'), native('pending_recover', 'native_delivery'), send('再接続後'), native('sequence_observe', 'seq_order')],
    process_recovery: [native('receiver_suspend', 'own_receiver_suspended'), send('ready保持', { defer: true }), native('receiver_restart', 'ready_inherited'), native('pending_recover', 'native_delivery'), native('sending_interrupt', 'sending_unknown_no_resend'), native('submitted_restart', 'submitted_not_resubmitted'), send('復旧後')],
    claim_race: [native('claim_race_arm', 'own_claim_competitors'), send('claim競合'), native('claim_race_observe', 'single_claim_output')],
    output_interruption: [native('output_interrupt_arm', 'own_output_boundary_armed'), send('中断対象', { defer: true }), native('output_interrupt', 'claim_output_unknown_preserved'), native('output_unknown_observe', 'unknown_not_resent'), send('中断後別本文')],
    receipt_retry: [native('receipt_fail_arm', 'own_receipt_http_failure'), send('receipt失敗', { defer: true }), native('receipt_failure_observe', 'native_output_receipt_pending'), native('receipt_restore', 'receipt_only_recovered'), native('pending_recover', 'native_delivery'), native('receipt_retry_observe', 'output_once_receipt_revision')],
    session_change: [send('旧会話正常'), native('session_clear', 'new_conversation_identity'), send('旧宛保持', { defer: true, endpoint: 'old' }), native('session_new_join', 'new_binding_verified'), send('新会話正常', { endpoint: 'new' }), native('session_resume', 'official_resume_identity'), native('session_isolation_observe', 'old_body_no_new_conversation'), send('resume後', { endpoint: 'resumed' })],
    parallel_rooms: [native('parallel_open', 'two_rooms_two_native_conversations'), send('第一room'), send('第二room', { endpoint: 'parallel' }), native('parallel_observe', 'claims_room_conversation_separated')],
    unavailable_hook: [native('hook_disable', 'own_hook_disabled'), native('join_expect_failure', 'disabled_hook_typed_failure'), native('hook_untrust', 'own_hook_untrusted'), native('join_expect_failure', 'untrusted_hook_typed_failure'), native('hook_remove_file', 'own_hook_file_absent'), native('join_expect_failure', 'absent_hook_typed_failure'), native('hook_restore', 'normal_launch_intact'), send('hook復元後')],
    foreign_ownership: [native('foreign_seed', 'own_fixture_foreign_entries'), native('foreign_snapshot', 'foreign_order_approval_baseline'), send('所有分離'), native('foreign_observe', 'foreign_entries_unchanged')],
    compatibility_hooks: [native('compatibility_arm', 'own_compatible_hook_loaded'), send('互換hook'), native('compatibility_observe', 'one_adapter_one_binding')],
    background_end: [native('background_cancel', 'native_task_cancel_observed'), native('background_timeout', 'native_task_timeout_observed'), native('background_exit', 'native_task_exit_observed'), native('background_observe', 'task_end_not_delivered'), native('receiver_rearm', 'native_receiving_rearmed'), send('背景終了後')],
    lease: [native('lease_expiry_arm', 'own_finite_lease'), send('期限前'), native('lease_expiry_observe', 'finite_lease_control_not_body'), send('再武装待ち', { defer: true }), native('receiver_rearm', 'same_endpoint_cursor_rearmed'), native('pending_recover', 'native_delivery'), send('期限更新後')],
    binding_deadline: [native('binding_timeout_arm', 'own_binding_pending'), native('binding_timeout_observe', 'binding_timeout_typed_failed'), native('probe_timeout_arm', 'own_probe_not_consumed'), native('probe_timeout_observe', 'probe_timeout_typed_failed'), native('deadline_restore', 'new_join_verified'), send('期限障害復旧後')],
    slot_race: [native('slot_race_arm', 'own_simultaneous_hooks'), send('slot競合'), native('slot_race_observe', 'single_live_slot'), send('slot継続')],
    lifecycle: [send('更新前'), native('same_version_update', 'same_version_single_registration'), native('new_version_update', 'new_version_history_binding_preserved'), send('更新後'), native('teardown', 'receiver_stopped_parent_alive_history_kept'), native('lifecycle_rejoin', 'new_binding_after_teardown'), send('再導入後')],
    package: [native('package_inspect', 'pack_installed_no_checkout_paths'), send('導入物配送'), native('package_observe', 'pack_native_entry_used')],
  }
  if (!scenarioNames.includes(name)) fail('ACCEPTANCE_SCENARIO_UNKNOWN', `正本にないscenarioです: ${name}`)
  if (['original', 'burst'].includes(name) && (!Number.isSafeInteger(pageChars) || pageChars <= 0)) fail('ACCEPTANCE_PAGE_LIMIT_MISSING', '導入物のPAGE_CHARSが必要です')
  return plans[name]
}

// 観測はその試験専用artifactを指す。spoolだけ、runner自身のstdout、fixtureだけではnative合格にしない。
export function validateBoundary(result, { expectation, session, runId, scenario }) {
  if (result?.expectation !== expectation || result?.verified !== true) fail('ACCEPTANCE_BOUNDARY_FAILED', `${scenario}: ${expectation}を実測で確認できません`)
  if (!Array.isArray(result.observations) || !result.observations.length) fail('ACCEPTANCE_NATIVE_OBSERVATION_MISSING', `${expectation}の観測がありません`)
  for (const row of result.observations) {
    if (!row.kind || row.run_id !== runId || row.scenario !== scenario || !row.turn_id || !row.parent_session || !row.artifact || !['harness_transcript', 'official_queue', 'official_hook', 'native_task', 'os_process', 'http_boundary', 'installed_package'].includes(row.source)) fail('ACCEPTANCE_BOUNDARY_EVIDENCE_INVALID', `${expectation}: 実境界の相関・artifactが不足しています`)
    if (row.parent_session !== session && !result.related_sessions?.includes(row.parent_session)) fail('ACCEPTANCE_BOUNDARY_SESSION_MISMATCH', `${expectation}: 別会話の観測です`)
  }
  return result.observations
}

export function validateNativeCheck(check, { scenario, runId, session }) {
  if (check?.run_id !== runId || check?.scenario !== scenario || check.status !== 'passed' || check.body_equal !== true || check.count !== 1 || !check.original || !check.received || !isDeepStrictEqual(check.original, check.received)) fail('ACCEPTANCE_NATIVE_BODY_FAILED', `${scenario}: 原文/実会話本文の一致・1回配送を確認できません`)
  if (check.delivery?.session !== session || !check.delivery.turn_id || check.reply?.session !== session || !check.reply.turn_id || check.reply.order <= check.delivery.order || !check.reply.text.includes(check.nonce)) fail('ACCEPTANCE_NATIVE_REPLY_MISSING', `${scenario}: 同じ実会話の後続応答がありません`)
  if (check.receipt?.result !== 'delivered' || !Number.isSafeInteger(check.receipt.receipt_revision) || check.receipt.receipt_revision <= 0) fail('ACCEPTANCE_NATIVE_RECEIPT_MISSING', `${scenario}: 宛先別receiptがありません`)
  if (check.harness === 'codex' && (!check.receipt.queued_submission_id || !check.receipt.accepted_at)) fail('ACCEPTANCE_CODEX_QUEUE_RECEIPT_MISSING', `${scenario}: 公式queueの受付証拠がありません`)
  if (check.delivery.boundary?.encoding && !['none', 'codex_hook_prompt_xml_text'].includes(check.delivery.boundary.encoding)) fail('ACCEPTANCE_BODY_NORMALIZATION_FORBIDDEN', '任意の本文正規化は許可されていません')
  return check
}

// contextは導入物・実親・専用roomの操作を所有する。action未提供時は実行前にtyped errorで止める。
export async function runScenario(name, context) {
  const { harness, session, pageChars, runId = randomUUID() } = context
  if (!receiverBoundaries[harness]) fail('ACCEPTANCE_HARNESS_UNSUPPORTED', harness)
  const plan = scenarioPlan(name, { pageChars })
  const missing = [...new Set(plan.map(item => item.action))].filter(action => typeof context.actions?.[action] !== 'function')
  if (missing.length) fail('ACCEPTANCE_SCENARIO_ADAPTER_MISSING', `${harness}/${name}: ${missing.join(', ')}`)
  const checks = [], observations = [], trace = [], nonces = new Set()
  const scope = { scenario: name, runId, session, harness, pageChars, checks, observations, boundaries: receiverBoundaries[harness] }
  try {
  for (const [index, item] of plan.entries()) {
    scope.step_index = index
    const nonce = `PEERTABLE_${name.toUpperCase()}_${index}_${randomUUID()}`
    const body = item.input.body ?? `日本語の観測\n「引用」😀 <tag a="1"> & 字面&gt;\n配送確認の符号は ${nonce} です。`
    const input = { ...item.input, ...(item.action === 'deliver' ? { nonce, body: `${body}${item.input.long ? ('\n長文 日本語 < > & 字面&amp; 😀'.repeat(Math.ceil(pageChars / 20) * 3)) : ''}\n${nonce}` } : {}), index }
    const result = await context.actions[item.action](input, scope)
    if (item.action === 'deliver' && !item.input.defer && !item.input.allowRetained) {
      const targetSession = result.parent_session ?? session
      validateNativeCheck(result.check, { scenario: name, runId, session: targetSession })
      if (nonces.has(result.check.nonce) || result.check.nonce !== nonce) fail('ACCEPTANCE_SCENARIO_EVIDENCE_REUSED', `${name}: 専用の投稿ではありません`)
      nonces.add(nonce); checks.push(result.check)
    }
    observations.push(...validateBoundary(result, { expectation: item.expectation, session, runId, scenario: name }))
    if (result.checks) for (const check of result.checks) {
      validateNativeCheck(check, { scenario: name, runId, session: check.parent_session ?? session })
      if (nonces.has(check.nonce)) fail('ACCEPTANCE_SCENARIO_EVIDENCE_REUSED', `${name}: 同じ観測を再使用しています`)
      nonces.add(check.nonce); checks.push(check)
    }
    trace.push({ step: index, action: item.action, expectation: item.expectation, artifacts: result.observations.map(row => row.artifact) })
  }
  if (!checks.length) fail('ACCEPTANCE_NO_NATIVE_DELIVERY', `${name}: 専用本文の実親受信がありません`)
  if (['consecutive', 'source_reconnect', 'burst'].includes(name) && checks.some((check, index) => index && (check.original.seq <= checks[index - 1].original.seq || check.delivery.order <= checks[index - 1].delivery.order))) fail('ACCEPTANCE_SEQ_ORDER', `${name}: seq順に配送されていません`)
  return { scenario: name, run_id: runId, checks, observations, trace, boundaries: receiverBoundaries[harness], status: 'passed' }
  } finally { if (context.finalize) await context.finalize(scope) }
}
