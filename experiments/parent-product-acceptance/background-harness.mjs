// 通常CLIの公式記録を読む。起動・認証・hook設定は操作adapterが所有する。
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { parseDelivered } from './evidence.mjs'

const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const decode = bytes => { const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes; return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text }
const json = (text, source) => { try { return JSON.parse(decode(text)) } catch { fail('ACCEPTANCE_TRANSCRIPT_CORRUPT', `${source} のJSONが破損しています`) } }

// 元Bufferは変更しない。改行済みの行だけを確定とし、未確定末尾は観測から外す。
export function readBackgroundJsonl(bytes, file = 'native transcript') {
  const lines = decode(bytes).split('\n'), tail = lines.pop()
  return { rows: lines.map((line, order) => ({ order, row: json(line, `${file}:${order + 1}`) })), pending_tail: tail.length }
}
const checkSession = (expected, actual, source) => {
  if (actual != null && actual !== expected) fail('ACCEPTANCE_NATIVE_SESSION_MISMATCH', `${source} の会話IDが期待値と一致しません`)
}
const hookEvent = row => row.event ?? row.input ?? row
const eventName = event => event.hook_event_name ?? event.hookEventName
const hookName = event => event.tool_name ?? event.toolName
const hookInput = event => event.tool_input ?? event.toolInput
const hookOutput = event => event.tool_output ?? event.toolResult
const hookId = event => event.tool_use_id ?? event.toolUseId
const hookRows = (hooks, expected) => hooks.map((item, order) => {
  const event = hookEvent(item)
  for (const value of [event.conversation_id, event.session_id, event.sessionId]) checkSession(expected, value, `hook:${order}`)
  const path = event.transcript_path ?? event.transcriptPath
  if (path && !path.split(/[\\/]/u).includes(expected) && !path.endsWith(`${expected}.jsonl`)) fail('ACCEPTANCE_NATIVE_SESSION_MISMATCH', `hook:${order} のtranscript pathが別会話です`)
  return { event, order, at: item.at ?? event.timestamp ?? null }
})
const empty = ({ rows, pending_tail }) => ({ rows: rows.length, pending_tail, toolUses: [], replies: [], injections: [], deliveries: [], turns: [], queued: [], pages: [], tasks: [] })
const rememberTurn = (seen, turn) => { if (turn && !seen.turns.includes(turn)) seen.turns.push(turn) }
const pageOf = value => value?.schema === 'peertable.parent-read-page.v1' ? value : value?.schema === 'peertable.parent-read-result.v1' ? value.page : null
const cursorValues = output => {
  const outer = typeof output === 'string' ? json(output, 'Cursor tool_output') : output
  const values = [outer]
  for (const part of outer?.content ?? []) if (part.type === 'text') values.push(json(part.text, 'Cursor MCP text'))
  if (outer?.structuredContent) values.push(outer.structuredContent)
  return values
}
const addPages = (seen, values, entry) => {
  // 同じMCP結果のcontent/structuredContent二重包装だけを一つにする。別tool callの再読は残す。
  const unique = []
  for (const value of values) { const page = pageOf(value); if (page && !unique.some(item => isDeepStrictEqual(item, page))) unique.push(page) }
  for (const page of unique) seen.pages.push({ ...entry, page })
}
const deliveryFromPage = (page, entry, body, source) => ({ room: page.event.room, from: page.event.from ?? page.event.message?.from, to: page.event.to_names ?? page.event.to ?? page.event.message?.to_names ?? page.event.message?.to, seq: page.event.seq, body, delivery_id: page.delivery_id, digest: page.digest, preview: false, ...entry, boundary: { source, raw_body_equal: true, encoding: 'none' } })

// page列は配送ごとにoffset 0からcompleteまでを一回の回収として束ねる。
// complete後に再びoffset 0が来た場合は別受信として残し、真の重複を隠さない。
const pageDeliveries = seen => {
  const runs = new Map()
  for (const entry of seen.pages) {
    const page = entry.page
    let run = runs.get(page.delivery_id)
    if (page.offset === 0 && run) fail('ACCEPTANCE_PAGE_NATIVE_SEQUENCE', '公式pageが回収途中でoffset 0へ戻りました')
    if (page.offset === 0) { run = { first: page, body: '', offset: 0 }; runs.set(page.delivery_id, run) }
    if (!run || page.offset !== run.offset || page.digest !== run.first.digest || page.total_characters !== run.first.total_characters || typeof page.event?.body !== 'string') fail('ACCEPTANCE_PAGE_NATIVE_SEQUENCE', '公式pageの順序・identityが不一致です')
    run.body += page.event.body; run.offset += page.event.body.length
    if (page.complete !== (run.offset === page.total_characters)) fail('ACCEPTANCE_PAGE_NATIVE_FINAL', '公式pageのcompleteと本文長が一致しません')
    if (page.complete) {
      const related = seen.deliveries.find(item => item.delivery_id === page.delivery_id && item.native_task_id === entry.native_task_id)
      if (related?.entry?.type === 'native_task_output_file' && !related.page_recovered) { related.page_recovered = true; related.native_pages = (related.native_pages ?? 0) + 1; related.page_order = entry.order }
      else if (page.event.seq !== undefined) seen.deliveries.push(deliveryFromPage(run.first, entry, run.body, entry.source ?? 'grok parent_read MCP result (transcript updates.jsonl)'))
      runs.delete(page.delivery_id)
    }
  }
}
const cursorTool = part => part.name === 'CallDynamicTool' && part.input?.namespace === 'peertable_parent'
  ? { name: part.input.toolName, input: part.input.arguments }
  : { name: part.name, input: part.input }
const comparableCursorInput = (name, input) => {
  if (name === 'Read') return { path: input?.path ?? input?.file_path, ...(input?.offset !== undefined ? { offset: input.offset } : {}), ...(input?.limit !== undefined ? { limit: input.limit } : {}) }
  if (name === 'Shell') return { command: input?.command }
  if (['parent_join', 'parent_read', 'parent_leave'].includes(name)) return Object.fromEntries(Object.entries(input ?? {}).filter(([key]) => key !== 'hook_context_id'))
  return input
}
const terminalOutput = (bytes, source) => {
  const text = decode(bytes), match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/u.exec(text)
  if (!match) fail('ACCEPTANCE_NATIVE_TASK_OUTPUT_FORMAT', `${source} に公式front matterがありません`)
  const rest = text.slice(match[0].length), footer = /\r?\n---\r?\nexit_code:/u.exec(rest)
  const stdout = footer ? rest.slice(0, footer.index) : rest
  const status = /^status: (\S+)/mu.exec(match[0])?.[1] ?? null
  // 成功stdoutのJSON記録だけを読む。失敗taskの診断本文や任意コマンドのplain textは配送ではない。
  const parsed = status === 'succeeded' && stdout.startsWith('{') ? readBackgroundJsonl(stdout, source) : { rows: [], pending_tail: 0 }
  return { text, status, stdout, pending_tail: parsed.pending_tail, values: parsed.rows.map(item => item.row), front: match[0] }
}

export function parseCursorNativeTranscript({ transcript, hooks = [], expectedConversationId, readTaskFile = path => readFileSync(path), file = 'Cursor transcript' }) {
  if (!expectedConversationId) fail('ACCEPTANCE_NATIVE_SESSION_REQUIRED', '期待するCursor会話IDが必要です')
  const parsed = readBackgroundJsonl(transcript, file), seen = empty(parsed), events = hookRows(hooks, expectedConversationId)
  const post = events.filter(({ event }) => eventName(event) === 'postToolUse')
  let nextHook = 0, turn = null
  const readTasks = new Set()
  for (const { order, row } of parsed.rows) {
    checkSession(expectedConversationId, row.conversation_id ?? row.sessionId ?? row.session_id, `${file}:${order}`)
    const parts = row.message?.content ?? []
    if (row.role === 'user') turn = null
    for (const part of parts) {
      if (part.type !== 'tool_use') continue
      const tool = cursorTool(part)
      const index = post.findIndex(({ event }, i) => i >= nextHook && (hookName(event) === `MCP:${tool.name}` || hookName(event) === tool.name) && isDeepStrictEqual(comparableCursorInput(tool.name, tool.input), comparableCursorInput(tool.name, hookInput(event))))
      const event = index < 0 ? null : post[index].event
      if (event) { nextHook = index + 1; turn = event.generation_id ?? null; rememberTurn(seen, turn) }
      const entry = { order, session: expectedConversationId, turn_id: turn, id: event ? hookId(event) : part.id ?? null, name: tool.name, input: tool.input, raw_input: part.input, native_name: part.name, output: event ? hookOutput(event) : undefined, hook_input: event ? hookInput(event) : undefined }
      seen.toolUses.push(entry)
      if (!event) continue
      if (!['Shell', 'Read', 'parent_join', 'parent_read', 'parent_leave'].includes(tool.name)) continue
      const output = cursorValues(hookOutput(event))
      if (tool.name === 'Shell') {
        const task = output[0]
        if (task?.shell_id != null) seen.tasks.push({ ...entry, id: String(task.shell_id), tool_use_id: entry.id, type: 'task_backgrounded', task_id: String(task.shell_id), pid: task.pid, raw_output: task })
      }
      if (tool.name === 'Read') {
        const path = tool.input?.path ?? tool.input?.file_path
        const taskId = /(?:^|[\\/])terminals[\\/](\d+)\.txt$/u.exec(path ?? '')?.[1]
        const metadata = output[0]
        if (!taskId || metadata?.file_path !== path || !Number.isSafeInteger(metadata.content_length)) continue
        const rawBytes = readTaskFile(path), native = terminalOutput(rawBytes, path)
        // 保存済み最終fileを、完了前に読んだ短いReadへ遡って結び付けない。
        if (metadata.content_length < native.text.length || tool.input.offset !== undefined || tool.input.limit !== undefined) continue
        for (const [line, value] of native.values.entries()) {
          if (value.schema !== 'peertable.parent-background-result.v1') continue
          seen.tasks.push({ ...entry, id: taskId, reader_tool_use_id: entry.id, type: 'task_output_read', task_id: taskId, output_file: path, result: value, raw_bytes: rawBytes })
          const key = `${path}:${line}`
          if (readTasks.has(key)) continue
          readTasks.add(key)
          const base = { order, session: expectedConversationId, turn_id: turn, native_task_id: taskId, entry: { type: 'native_task_output_file', task_id: taskId, reader_id: entry.id }, boundary: { source: `cursor native background task output terminals/${taskId}.txt`, raw_body_equal: true, encoding: 'none' } }
          if (typeof value.text === 'string') {
            seen.injections.push({ ...base, text: value.text })
            for (const delivery of parseDelivered(value.text)) seen.deliveries.push({ ...delivery, ...base })
          }
        }
      }
      if (tool.name === 'parent_read') {
        const reader = [...seen.tasks].reverse().find(item => item.type === 'task_output_read' && item.result.delivery_id === tool.input?.delivery_id && item.order < order)
        if (output.some(value => pageOf(value)) && !reader) fail('ACCEPTANCE_NATIVE_FULL_READER_MISSING', 'Cursor parent_readに先行する同taskの公式全文Readがありません')
        addPages(seen, output, { order, session: expectedConversationId, turn_id: turn, id: entry.id, native_task_id: reader?.task_id ?? null, reader_id: reader?.reader_tool_use_id ?? null, reader_order: reader?.order ?? null, source: 'cursor parent_read MCP result (postToolUse hook)' })
      }
    }
    if (row.role === 'assistant') {
      const text = parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('')
      if (text.length) seen.replies.push({ order, session: expectedConversationId, turn_id: turn, text })
    }
  }
  pageDeliveries(seen)
  return seen
}

export function parseGrokNativeUpdates({ transcript, hooks = [], expectedConversationId, file = 'Grok updates.jsonl' }) {
  if (!expectedConversationId) fail('ACCEPTANCE_NATIVE_SESSION_REQUIRED', '期待するGrok会話IDが必要です')
  const parsed = readBackgroundJsonl(transcript, file), seen = empty(parsed)
  hookRows(hooks, expectedConversationId)
  const updates = parsed.rows.map(({ order, row }) => {
    checkSession(expectedConversationId, row.params?.sessionId, `${file}:${order}`)
    checkSession(expectedConversationId, row.params?.update?.task_snapshot?.owner_session_id, `${file}:${order}:task`)
    return { order, update: row.params?.update ?? {} }
  })
  // Grokの公式prompt_idはturn完了時に記録される。接頭辞を含めて原値を使う。
  const turnAt = new Map(); let upcoming = null
  for (let i = updates.length - 1; i >= 0; i--) {
    const { update, order } = updates[i]
    if (update.sessionUpdate === 'turn_completed') upcoming = update.prompt_id ?? null
    turnAt.set(order, upcoming)
  }
  const calls = new Map(), completed = new Map(), readers = []
  let reply = null
  const flush = () => { if (reply) { seen.replies.push(reply); reply = null } }
  for (const { order, update: u } of updates) {
    const turn = turnAt.get(order), base = { order, session: expectedConversationId, turn_id: turn }
    rememberTurn(seen, turn)
    if (u.sessionUpdate === 'agent_message_chunk' && typeof u.content?.text === 'string') {
      if (reply && reply.turn_id !== turn) flush()
      reply ??= { ...base, text: '' }; reply.text += u.content.text
    } else if (!['hook_execution', 'agent_thought_chunk'].includes(u.sessionUpdate)) flush()
    if (u.sessionUpdate === 'tool_call') {
      const name = u.rawInput?.tool_name?.startsWith('peertable_parent__') ? u.rawInput.tool_name.slice('peertable_parent__'.length) : u._meta?.['x.ai/tool']?.name ?? u.title
      const entry = { ...base, id: u.toolCallId, name, native_name: u._meta?.['x.ai/tool']?.name ?? u.title, input: name.startsWith('parent_') ? u.rawInput.tool_input : u.rawInput, raw_input: u.rawInput }
      seen.toolUses.push(entry); calls.set(entry.id, entry)
    }
    if (['task_backgrounded', 'task_completed'].includes(u.sessionUpdate)) {
      const task = u.task_snapshot ?? u
      seen.tasks.push({ ...base, type: u.sessionUpdate, task_id: task.task_id, id: task.task_id, tool_use_id: u.tool_call_id ?? null, output_file: task.output_file, completed_order: u.sessionUpdate === 'task_completed' ? order : null, raw_output: task })
      if (u.sessionUpdate === 'task_completed') completed.set(task.task_id, { ...base, task })
    }
    if (u.sessionUpdate !== 'tool_call_update' || !u.rawOutput) continue
    const call = calls.get(u.toolCallId), raw = u.rawOutput
    if (!call) fail('ACCEPTANCE_NATIVE_TOOL_CORRELATION', 'Grok tool出力に対応する公式tool_callがありません')
    call.output = raw; call.output_order = order
    if (raw.type === 'BackgroundTaskStarted') seen.tasks.push({ ...base, type: 'task_started_result', id: raw.task_id, tool_use_id: call.id, task_id: raw.task_id, output_file: raw.output_file, pid: raw.pid, raw_output: raw })
    if (call.name === 'get_command_or_subagent_output' && raw.type === 'TaskOutput') {
      const result = raw.Result, task = completed.get(result?.task_id)
      if (task && call.input?.task_ids?.includes(result.task_id) && !Object.hasOwn(call.input, 'timeout_ms') && result.truncated === false && result.status === 'completed') {
        for (const { row } of readBackgroundJsonl(result.output, 'Grok task output').rows) {
          if (row.schema === 'peertable.parent-background-result.v1') {
            const reader = { ...base, id: call.id, task_id: result.task_id, result: row, completed_order: task.order }
            readers.push(reader)
            seen.tasks.push({ ...reader, id: result.task_id, reader_tool_use_id: call.id, type: 'task_output_read', output_file: result.output_file, raw_output: result })
          }
        }
      }
    }
    if (raw.type === 'MCP' && raw.tool_name === 'parent_read') {
      const value = json(raw.output?.OkayOutput, 'Grok parent_read OkayOutput'), page = pageOf(value)
      if (!page) continue
      const reader = [...readers].reverse().find(item => item.result.delivery_id === page.delivery_id && item.order < order)
      if (!reader) fail('ACCEPTANCE_NATIVE_FULL_READER_MISSING', 'Grok parent_readに先行する同taskの公式全文readerがありません')
      if (reader.result.digest !== page.digest || (reader.result.endpoint_id !== undefined && reader.result.endpoint_id !== page.endpoint_id)) fail('ACCEPTANCE_NATIVE_TASK_PAGE_MISMATCH', 'Grok全文readerとparent_readのdigest/endpointが一致しません')
      addPages(seen, [value], { ...base, id: call.id, native_task_id: reader.task_id, reader_id: reader.id, completed_order: reader.completed_order, reader_order: reader.order })
    }
  }
  flush(); pageDeliveries(seen)
  return seen
}

export function createBackgroundHarnessObserver({ harness, transcriptPath, updatesPath, hookPaths = [], expectedConversationId, readTaskFile }) {
  const parser = { cursor: parseCursorNativeTranscript, grok: parseGrokNativeUpdates }[harness]
  if (!parser) fail('ACCEPTANCE_HARNESS_UNSUPPORTED', `未対応の背景harnessです: ${harness}`)
  const file = transcriptPath ?? updatesPath
  const observe = () => {
    const parsedHooks = hookPaths.map(path => readBackgroundJsonl(readFileSync(path), path))
    const hooks = parsedHooks.flatMap(item => item.rows.map(entry => entry.row))
    const seen = parser({ transcript: readFileSync(file), hooks, expectedConversationId, readTaskFile, file })
    seen.hook_pending_tail = parsedHooks.reduce((sum, item) => sum + item.pending_tail, 0)
    return seen
  }
  return { observe, readNativePages: deliveryId => observe().pages.filter(item => item.page.delivery_id === deliveryId) }
}
