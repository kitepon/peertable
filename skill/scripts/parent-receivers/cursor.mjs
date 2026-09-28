import { renderDelivery, PAGE_CHARS } from '../parent-delivery.mjs'
export { waitReceipt, bindNativeWait, backgroundReceive } from './background.mjs'
export async function cursorEvent(spool, event, write, options = {}) {
  // Aitermと同じくafterMCPExecutionは会話束縛だけ。本文は成功・失敗後のtool hookへ渡す。
  if (!['postToolUse', 'postToolUseFailure'].includes(event.hook_event_name)) return false
  // 失敗したShellを背景taskの登録成功として扱わない。
  if (event.hook_event_name === 'postToolUse') await (await import('./background.mjs')).bindNativeWait(spool, event, 'cursor')
  return cursorHook(spool, write, options)
}

export async function cursorHook(spool, write, { checkTarget = () => spool.assertCurrentEndpoint() } = {}) {
  await checkTarget()
  const record = spool.claim('cursor_additional_context')
  if (!record) return false
  const preview = String(record.event.body ?? '').length > PAGE_CHARS
  try {
    await checkTarget()
    if (preview) spool.handoff(record)
    await write({ additional_context: renderDelivery(spool.read(), record, { preview }) })
    if (!preview) spool.finish(record, { reason: 'cursor_hook_output' })
  } catch (error) { spool.finish(record, { state: 'unknown', reason: 'PARENT_CURSOR_OUTPUT_UNKNOWN' }); throw error }
  await spool.flushReceiptsAfterOutput()
  return true
}
