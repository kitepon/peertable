// 実境界で観測した値だけから peertable.parent-live-case.v1 と目録recordを組み立てる。
// 観測が欠けたcaseへpassedを書かない。成否はgateと同じ関数で自己照合する。
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { auditAcceptance, expectedCases } from '../../scripts/parent-delivery-acceptance.mjs'

export const sha256 = value => createHash('sha256').update(value).digest('hex')

// renderDelivery の出力を実境界の本文から逆に読む。本文中の改行・角括弧は末尾の配送ID行で区切る。
export function parseDelivered(text) {
  const out = []
  const head = /\[Peertable room=(\S+) from=(\S+) to=(.+?) seq=(\S+)\]\n本文: /gu
  let match
  while ((match = head.exec(text))) {
    const start = match.index + match[0].length
    const tail = /\n\[配送ID=([0-9a-f-]{36}) digest=([0-9a-f]{64})( 全文取得=parent_read)?\]/gu
    tail.lastIndex = start
    const end = tail.exec(text)
    if (!end) continue
    let to
    try { to = JSON.parse(match[3]) } catch { to = match[3] }
    out.push({ room: match[1], from: match[2], to, seq: Number(match[4]), body: text.slice(start, end.index), delivery_id: end[1], digest: end[2], preview: Boolean(end[3]) })
    head.lastIndex = end.index + end[0].length
  }
  return out
}

// 公開投影はHOMEと秘密keyを落とす。本文・ID・seqは照合に必要なので残す。
export function project(value) {
  const home = homedir()
  if (Array.isArray(value)) return value.map(project)
  if (typeof value === 'string') return value.split(home).join('~')
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['credential', 'continuation_key', 'token', 'auth', 'apiKeySource', 'env'].includes(key))
    .map(([key, item]) => [key, project(item)]))
  return value
}

const failed = (reasons, extra = {}) => ({ status: reasons.length ? 'failed' : 'passed', reasons, ...extra })

// 1 audience分の照合。original=room投稿、received=親harness記録から読んだ実配送本文。
export function judgeAudience({ label, posted, record, receipt, deliveries, replies, session, recipient }) {
  const reasons = []
  const original = { room: posted.room, from: posted.from, to: posted.to_names ?? posted.to, seq: posted.seq, body: posted.body }
  const matches = deliveries.filter(item => item.delivery_id === record?.delivery_id)
  if (!record) reasons.push('SPOOL_RECORD_MISSING')
  else if (record.state !== 'submitted') reasons.push(`SPOOL_STATE_${record.state}`)
  if (record && record.event?.body !== posted.body) reasons.push('SPOOL_BODY_MISMATCH')
  if (matches.length !== 1) reasons.push(`HARNESS_DELIVERY_COUNT_${matches.length}`)
  const received = matches[0] ? { room: matches[0].room, from: matches[0].from, to: matches[0].to, seq: matches[0].seq, body: matches[0].body } : null
  const bodyEqual = Boolean(received) && JSON.stringify(original) === JSON.stringify(received)
  if (received && !bodyEqual) reasons.push('HARNESS_BODY_MISMATCH')
  if (matches[0]?.session !== session) reasons.push('HARNESS_SESSION_MISMATCH')
  const reply = replies.find(item => item.session === session && item.text.includes(posted.nonce) && item.order > (matches[0]?.order ?? Infinity))
  if (!reply) reasons.push('ASSISTANT_REPLY_MISSING')
  if (receipt?.state !== 'delivered') reasons.push(`ROOM_RECEIPT_${receipt?.state ?? 'missing'}`)
  if (!Number.isSafeInteger(receipt?.receipt_revision)) reasons.push('ROOM_RECEIPT_REVISION_MISSING')
  return failed(reasons, {
    label, recipient, original, received, body_equal: bodyEqual, count: matches.length,
    delivery: matches[0] ?? null, reply: reply ?? null, spool: record ? { delivery_id: record.delivery_id, state: record.state, queued_submission_id: record.queued_submission_id, accepted_at: record.accepted_at, reason: record.receipt?.reason ?? null } : null,
    receipt: receipt ? { seq: posted.seq, recipient, route: 'parent_receiver', result: receipt.state, reason: receipt.reason ?? null, receipt_revision: receipt.receipt_revision ?? null, queued_submission_id: receipt.queued_submission_id ?? null, accepted_at: receipt.accepted_at ?? null } : null,
  })
}

export function caseId({ os, harness, surface, scenario }) { return `${os}/${harness}/${surface}/${scenario}` }

// case証拠。checksのどれかが失敗なら status:failed、観測なしなら証拠自体を作らない。
export function buildCase({ meta, scenario, checks, observations, extra = {} }) {
  if (!checks.length) throw Object.assign(new Error('観測のないscenarioに成績を作りません'), { code: 'ACCEPTANCE_NO_OBSERVATION' })
  const id = caseId({ ...meta, scenario })
  const reasons = checks.flatMap(check => check.reasons.map(reason => `${check.label}:${reason}`))
  const evidence = {
    schema: 'peertable.parent-live-case.v1', case_id: id, status: reasons.length ? 'failed' : 'passed', reasons,
    native: true, os: meta.os, harness: meta.harness, surface: meta.surface,
    source_commit: meta.source_commit, runtime_digest: meta.runtime_digest, package_version: meta.package_version, client_version: meta.client_version,
    package_tarball_sha256: meta.package_tarball_sha256, harness_version: meta.harness_version, node_version: meta.node_version,
    parent_session: meta.parent_session, parent_process: meta.parent_process, endpoint_id: meta.endpoint_id, room: meta.room,
    owner_input_required: false, isolation: meta.isolation,
    ...(meta.controller ? { controller: meta.controller } : {}),
    ...(meta.runner ? { runner: meta.runner } : {}),
    ...(meta.runner_commit ? { runner_commit: meta.runner_commit, runner_files: meta.runner_files } : {}),
    observations, receipts: checks.map(check => check.receipt).filter(Boolean),
    body_checks: checks.filter(check => check.received).map(check => ({ label: check.label, original: check.original, received: check.received })),
    checks, ...extra,
  }
  return project(evidence)
}

export function buildRecord(evidence, evidenceFile, extra = {}) {
  return {
    id: evidence.case_id, status: evidence.status, kind: 'product_live', native: true,
    harness_version: evidence.harness_version, source_commit: evidence.source_commit, runtime_digest: evidence.runtime_digest,
    package_version: evidence.package_version, parent_session: evidence.parent_session, evidence_file: evidenceFile,
    body_equal: evidence.body_checks.length > 0 && evidence.checks.every(check => check.body_equal !== false),
    owner_input_required: false, receipt_evidence: evidence.receipts.map(receipt => `${receipt.seq}:${receipt.recipient}:r${receipt.receipt_revision}`).join(','),
    observations: evidence.observations.map(item => item.kind), ...extra,
  }
}

const typed = (code, message) => Object.assign(new Error(message), { code })

// 後片付けの結果を完了条件と照合する。未完了は成功へ丸めず、原因codeを返す。未知のlabelは判定できないのでtyped errorにする。
export function cleanupFailure(label, result) {
  const rules = {
    harness_exit: [[result.exited !== true, 'ACCEPTANCE_HARNESS_NOT_EXITED']],
    // runnerの停止・索引撤去は後片付けとして続けるが、製品自身の終了処理が未完了ならrun成功にしない。
    endpoint_stop: [[!Array.isArray(result.owned_alive_after) || result.owned_alive_after.length > 0, 'ACCEPTANCE_OWNED_PROCESS_ALIVE'], [result.runtime_after !== 'stopped', 'ACCEPTANCE_ENDPOINT_NOT_STOPPED'],
      [result.product_stopped_within_30s !== true, 'PRODUCT_ENDPOINT_NOT_SELF_STOPPED'], [result.stopped_by_runner !== false, 'PRODUCT_ENDPOINT_STOPPED_BY_RUNNER'], [result.product_index_left_after_stop !== false, 'PRODUCT_STOPPED_ENDPOINT_INDEX_LEFT']],
    codex_folder_trust_remove: [[result.remaining_trust_entries !== 0, 'ACCEPTANCE_TRUST_ENTRY_LEFT']],
    pty_close: [[result.pane_alive_after !== false, 'ACCEPTANCE_PANE_ALIVE'], [!['closed', 'already_closed'].includes(result.outcome), 'ACCEPTANCE_PTY_NOT_CLOSED']],
    room_server: [[result.alive_after !== false, 'ACCEPTANCE_ROOM_ALIVE']],
    scenario_proxy: [[result.closed !== true, 'ACCEPTANCE_PROXY_NOT_CLOSED']],
    connect_remove: [[!result.removed?.length || result.removed.some(item => !item.endsWith(':removed')), 'ACCEPTANCE_CONNECT_REMOVE_FAILED'], [result.semantic_equal !== true, 'ACCEPTANCE_CONFIG_NOT_RESTORED'], [result.config_text_equal === false, 'ACCEPTANCE_CONFIG_TEXT_CHANGED']],
  }[label]
  if (!rules) throw typed('ACCEPTANCE_CLEANUP_UNKNOWN', `完了条件の無い後片付けです: ${label}`)
  const codes = rules.filter(([broken]) => broken).map(([, code]) => code)
  return codes.length ? { code: codes[0], codes } : null
}

// 自己監査でgateが拒否したpassedは目録へ出さずtyped errorで止める。failedはそのまま記録し、runの成功には数えない。
export function acceptCase(record, audit) {
  if (record.status === 'passed' && audit.gate_errors.length) throw typed('ACCEPTANCE_SELF_AUDIT_FAILED', `${record.id}: ${JSON.stringify(audit.gate_errors)}`)
  return { run_ok: record.status === 'passed' }
}

// 自分の1件だけをgateの関数へ通し、MISSING以外のerrorが無いかを見る。
export function selfAudit(record, evidence) {
  const audit = auditAcceptance([record], { readEvidence: () => evidence, sourceCommit: record.source_commit, sourceDigest: record.runtime_digest, packageVersion: record.package_version })
  const own = audit.errors.filter(error => error.id === record.id)
  return { id: record.id, gate_errors: own, expected_total: expectedCases().length }
}
