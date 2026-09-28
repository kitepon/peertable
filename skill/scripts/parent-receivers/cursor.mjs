import { renderDelivery, PAGE_CHARS } from '../parent-delivery.mjs'
export { waitReceipt, bindNativeWait, backgroundReceive } from './background.mjs'
export async function cursorEvent(spool, event, write, options = {}) {
  if (!['afterMCPExecution', 'postToolUse'].includes(event.hook_event_name)) return false
  // afterMCPExecutionのtool_input/result_jsonは実測上JSON文字列。native登録はpostToolUseが所有する。
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
