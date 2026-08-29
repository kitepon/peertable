#!/usr/bin/env node
// Peertable セッション側クライアント。channel（新着の一行通知）と room ツールを 1 プロセスに統合する。
// .mcp.json 登録: {"command":"node","args":["client.mjs"],"env":{"PEERTABLE_URL":"http://192.168.1.2:8790","PEERTABLE_ROOM":"myproject","PEERTABLE_MEMBER":"hinata"}}
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isIdleSelfWake } from '../skill/scripts/wakeup-delivery.mjs'
import { findModelsDoc, resolveSeatIdentity } from '../skill/scripts/resolve-seat-placement.mjs'

// client.mjs 側のハードコード版数。package.json の version と一致していることを
// diagnostics の version_consistency が見る（2 つの版数源の drift 検出。決定45）
const MCP_VERSION = '0.8.16'
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `usage:
  peertable-client                       room MCP サーバーとして起動する（.mcp.json 経由の通常経路）
  peertable-client --help / --version    ヘルプまたはバージョンを表示する
  peertable-client diagnostics           診断を人間可読で出す（fail の理由はこちらに出る）
  peertable-client diagnostics --json    schema peertable.native_factory_diagnostics.v1 の JSON で出す
`

// サブコマンドは引数がある時だけ解釈する。引数なし＝MCP stdio サーバー（本番の着席経路）は素通しで、
// 診断のコードは一切走らない（起動ディレイを増やさない）
const sub = process.argv[2]
if (sub !== undefined) {
  if (sub === '-h' || sub === '--help') {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  if (sub === '-v' || sub === '--version') {
    process.stdout.write(`${MCP_VERSION}\n`)
    process.exit(0)
  }
  if (sub === 'diagnostics') process.exit(await runDiagnostics(process.argv.includes('--json')))
  process.stderr.write(`unknown subcommand: ${sub}\n${USAGE}`)
  process.exit(1)
}

const URL_BASE = process.env.PEERTABLE_URL
const ROOM = process.env.PEERTABLE_ROOM
const ME = process.env.PEERTABLE_MEMBER
const CREDENTIAL_FILE = process.env.PEERTABLE_CREDENTIAL_FILE ?? null
const TOKEN = (() => {
  if (!CREDENTIAL_FILE) throw new Error('PEERTABLE_CREDENTIAL_MISSING: credential file pathが無い')
  let value
  try { value = readFileSync(CREDENTIAL_FILE, 'utf8').trim() } catch {
    throw new Error('PEERTABLE_CREDENTIAL_UNREADABLE: credential fileを読めない')
  }
  if (!value) throw new Error('PEERTABLE_CREDENTIAL_INVALID: credential fileが空')
  return value
})()
if (!URL_BASE || !ROOM || !ME) throw new Error('PEERTABLE_URL / PEERTABLE_ROOM / PEERTABLE_MEMBER を設定すること')

const api = p => `${URL_BASE}/api/${ROOM}/${p}`
const headers = { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Peertable-Token': TOKEN } : {}) }
// room 全体宛と自分が明示された発言を新着として処理する。
const relevant = m => Array.isArray(m.to_names)
  ? m.to_names.includes(ME)
  : m.to === ME || (m.to === 'all' && m.from !== ME)

let cursor = 0 // read_unread 用。参加時点から数える
// 読了ack専用。read_unreadが実際にメッセージを返した時だけ進む（参加時の末尾代入では進まない）。
// cursorとの分離は反証3（2026-08-25）: 再接続直後のcursorは「未読の起点」であって読了の証明ではない。
let ackSeq = 0

const mcp = new Server(
  { name: 'room', version: MCP_VERSION },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions:
      `あなたは Peertable room「${ROOM}」のメンバー「${ME}」である。` +
      'メンバー一覧の名前・役割・設定・使命を見て連携せよ。members と read_unread 先頭に同じ欄がある。' +
      '<channel source="room"> の通知は「新着あり」の合図であり、本文は read_unread ツールで読む。' +
      '発言は post ツールを使う。to: "all" はroom全体、メンバー名はDM、配列は複数人宛である。' +
      'post 応答の room_saved は room 保存だけの事実で、配達成功ではない。相手に届いた前提で進む前に delivery が delivered であることを確認せよ。' +
      `次にやる仕事があるターンを終える直前に post(to: "${ME}", message: "[次の行動] ...") を1回送れ。` +
      'この自己DMは席の TUI へ次ターンの入力として入る。仕事があるのに出さないと席は止まる。' +
      '手番が無く待機に入るときは自己DMを出すな。親へ [待機] を一度だけ送り沈黙せよ。空の終了通知は使うな。',
  },
)

const text = s => ({ content: [{ type: 'text', text: s }] })

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'post',
      description:
        'room へ通常発言する。to は "all"（room全体）/ メンバー名（DM）/ メンバー名の配列（複数人宛）。' +
        `次の仕事があるターン終了時は to を自分の名前（${ME}）にし、message を "[次の行動] " で始めよ。これが次ターンの起こしである。手番が無い待機では自己DMを出すな。`,
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            anyOf: [
              { type: 'string', minLength: 1 },
              { type: 'array', items: { type: 'string', minLength: 1, not: { const: 'all' } }, minItems: 1, uniqueItems: true },
            ],
            description: '"all" / メンバー名 / メンバー名の配列',
          },
          message: { type: 'string' },
        },
        required: ['to', 'message'],
      },
    },
    { name: 'read_unread', description: 'room全体宛と自分宛の未読メッセージを読む。読んだ位置は記憶される', inputSchema: { type: 'object', properties: {} } },
    { name: 'read_log', description: 'room ログの直近 count 件を読む（既定 50。全宛先を含む）', inputSchema: { type: 'object', properties: { count: { type: 'number' } } } },
    { name: 'members', description: 'room に居るメンバーの一覧（名前・役割・設定・使命・実効稼働状態）と bridge 健全性。状態が unknown の席と bridge 障害はここで分かる', inputSchema: { type: 'object', properties: {} } },
    { name: 'delivery_status', description: '発言 seq の宛先別配達状態を照会する。delivered / pending / seat_unavailable / bridge_unavailable / failed。room_saved は配達成功ではない', inputSchema: { type: 'object', properties: { seq: { type: 'number' } }, required: ['seq'] } },
  ],
}))

const fmt = m => `[${m.seq}] ${m.from} → ${Array.isArray(m.to_names) ? m.to_names.join(', ') : m.to} (${m.ts}): ${m.body}`
const elapsedText = ms => {
  if (!Number.isFinite(ms)) return null
  const min = Math.floor(ms / 60000)
  return min < 1 ? `${Math.floor(ms / 1000)}s前` : min >= 60 ? `${Math.floor(min / 60)}h${min % 60}m前` : `${min}m前`
}
// 実効稼働状態は server 生成の欄だけを読む（決定101）。MCP 側で鮮度判定を持たない
const statusText = (m) => {
  if (m.status_effective === undefined) return '状態=不明(旧server・実効状態なし)'
  const age = elapsedText(m.status_age_ms)
  if (m.status_reason === 'fresh') return `状態=${m.status_effective}（最終報告 ${age}）`
  return `状態=${m.status_effective}（理由=${m.status_reason}${age ? `・最終報告 ${age}` : '・報告なし'}）`
}
const memberLine = (m) => {
  const rolesText = Array.isArray(m.roles) && m.roles.length ? m.roles.join('・') : ''
  const settingsText = [m.model, m.effort].filter(Boolean).join('×')
  const parts = [m.name]
  if (rolesText) parts.push(`役割=${rolesText}`)
  if (settingsText) parts.push(`設定=${settingsText}`)
  if (m.mission) parts.push(`使命=${m.mission}`)
  parts.push(statusText(m))
  return parts.join(' ')
}
const bridgeText = (bridges) => {
  if (!bridges) return '⚠ bridge健全性: 不明（旧serverはbridge台帳を持たない）'
  const label = { seat_status: '稼働状態bridge', wakeup: '配達bridge' }
  const lines = ['seat_status', 'wakeup'].map((kind) => {
    const state = bridges[kind]?.state ?? 'unknown'
    return `${label[kind]}=${state}`
  })
  const broken = ['seat_status', 'wakeup'].some(k => bridges[k]?.state !== 'up')
  return `${broken ? '⚠ ' : ''}bridge: ${lines.join(' / ')}`
}
const rosterText = async () => {
  const { members, bridges } = await (await fetch(api('members'))).json()
  if (!members?.length) return `席: （まだ誰も居ない）\n${bridgeText(bridges)}`
  return `席: ${members.map(memberLine).join(' / ')}\n${bridgeText(bridges)}`
}
const deliveryText = (delivery) => {
  const entries = Object.entries(delivery ?? {})
  if (!entries.length) return 'delivery: （TUI配達対象の宛先なし）'
  return `delivery: ${entries.map(([name, d]) => `${name}=${d.state}${d.reason ? `(${d.reason})` : ''}`).join(' / ')}`
}

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = req.params.arguments ?? {}
  switch (req.params.name) {
    case 'post': {
      // read_seq: read_unreadが実際に返した最終seqだけを相乗り申告する（読了ack・2026-08-25）。
      // 「読んだ後にターンが生きて投稿まで到達した」の証明であり、wakeup-bridgeはこの値以下を再配達しない。
      // cursorは流用しない——cursorは参加時に末尾seqへ代入される未読起点であり、再接続直後に
      // 「読んでいないものを読了申告」して配達待ちの未読を捨てる（反証3・2026-08-25）。
      const r = await fetch(api('messages'), { method: 'POST', headers, body: JSON.stringify({ from: ME, to: args.to, body: args.message, ...(ackSeq > 0 ? { read_seq: ackSeq } : {}) }) })
      const msg = await r.json()
      if (!r.ok) return { isError: true, ...text(`送信失敗: ${JSON.stringify(msg)}`) }
      // cursor は触らない。自分の発言は relevant で除外されるので進める必要が無く、
      // ここで進めると post より前に届いた未読を読まないまま既読にしてしまう（0.2.1 で修正）
      // 保存と配達は別の事実（決定102）。sent の一語で両者を混ぜず、宛先別の配達状態を返す
      if (msg.room_saved !== true) return text(`sent [${msg.seq}]（旧server: 配達状態は取得できない。room保存を配達成功と扱うな）`)
      return text(`room_saved [${msg.seq}]（room保存のみ。配達成功ではない）\n${deliveryText(msg.delivery)}\n配達の確定は delivery_status ツール（seq=${msg.seq}）で delivered を確認すること`)
    }
    case 'delivery_status': {
      const r = await fetch(api(`deliveries?seq=${Number(args.seq)}`))
      const body = await r.json()
      if (!r.ok) return { isError: true, ...text(`照会失敗: ${JSON.stringify(body)}`) }
      return text(`seq ${body.seq}: room_saved=${body.room_saved}\n${deliveryText(body.delivery)}`)
    }
    case 'read_unread': {
      const { messages } = await (await fetch(api(`messages?since=${cursor}`))).json()
      if (messages.length) { cursor = messages[messages.length - 1].seq; ackSeq = cursor }
      const mine = messages.filter(relevant)
      const roster = await rosterText()
      return text(mine.length ? `${roster}\n${mine.map(fmt).join('\n')}` : `${roster}\n未読なし`)
    }
    case 'read_log': {
      const { messages } = await (await fetch(api('messages'))).json()
      return text(messages.slice(-(args.count ?? 50)).map(fmt).join('\n') || '（ログなし）')
    }
    case 'members': {
      const { members, bridges } = await (await fetch(api('members'))).json()
      return text(`${members.map(memberLine).join('\n') || '（誰も居ない）'}\n${bridgeText(bridges)}`)
    }
    default:
      throw new Error(`unknown tool: ${req.params.name}`)
  }
})

await mcp.connect(new StdioServerTransport())

// 参加登録し、現在のログ末尾から未読を数え始める。
// 素性（harness/model/effort/role）は launch-seat.sh が env へ入れる。**登録のたびに載せる**——
// 登録は client の起動ごとに繰り返し起きるので、1回きりの経路に置くと
// member の状態が失われた時に二度と戻らない（server 側は渡された欄だけ更新する upsert）
function observeSelf() {
  const named = process.env.PEERTABLE_MEMBER ? `peer-${process.env.PEERTABLE_MEMBER}` : ''
  const handed = process.env.PEERTABLE_TMUX_SOCKET
  if (handed && named) {
    return { tmux_socket: handed, tmux_target: named, tmux_namespace: handed }
  }
  if (!process.env.TMUX) {
    process.stderr.write('peertable-client: observe unavailable: TMUX 不在\n')
    return null
  }
  if (!process.env.TMUX_PANE) {
    process.stderr.write('peertable-client: observe unavailable: TMUX_PANE 不在\n')
    return null
  }
  const socket = process.env.TMUX.split(',')[0]
  if (!socket) {
    process.stderr.write('peertable-client: observe unavailable: TMUX の socket が空\n')
    return null
  }
  try {
    const target = execFileSync('tmux', ['-S', socket, 'display-message', '-p', '-t', process.env.TMUX_PANE, '#S'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!target) throw new Error('session 名が空')
    return { tmux_socket: socket, tmux_target: target }
  } catch (error) {
    process.stderr.write(`peertable-client: observe unavailable: ${error.message}\n`)
    return null
  }
}

{
  const { messages } = await (await fetch(api('messages'))).json()
  cursor = messages.length ? messages[messages.length - 1].seq : 0
}

const observe = observeSelf()
const parseRoles = (raw) => String(raw ?? '').split(/[,、]/u).map((item) => item.trim()).filter(Boolean)
const roles = parseRoles(process.env.PEERTABLE_ROLES || process.env.PEERTABLE_ROLE)
// 台帳（room server の SQLite）へは canonical 欄だけを登録する。settings / role（単数）の
// 重複欄は 2026-08-22 に廃止——同一情報の重複管理禁止（オーナー裁定）。
const IDENTITY = Object.fromEntries(Object.entries({
  // 正本は harness。旧 launcher（PEERTABLE_VENDOR だけを置く版)からの起動も受ける。
  harness: process.env.PEERTABLE_HARNESS ?? process.env.PEERTABLE_VENDOR,
  // 旧版 room server（vendor 列世代）へ登録しても素性が落ちないための互換併記。
  vendor: process.env.PEERTABLE_HARNESS ?? process.env.PEERTABLE_VENDOR,
  model: process.env.PEERTABLE_MODEL,
  effort: process.env.PEERTABLE_EFFORT,
  roles,
  mission: process.env.PEERTABLE_MISSION,
  observe,
}).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0)))
{
  const modelsDoc = findModelsDoc()
  if (!modelsDoc || !existsSync(modelsDoc)) {
    throw new Error('SEAT_MODELS_DOC_MISSING: 02_models.md が見つからない')
  }
  const checked = resolveSeatIdentity({
    roles,
    model: process.env.PEERTABLE_MODEL,
    effort: process.env.PEERTABLE_EFFORT,
    harness: process.env.PEERTABLE_HARNESS ?? process.env.PEERTABLE_VENDOR,
    markdown: readFileSync(modelsDoc, 'utf8'),
  })
  if (checked.error) throw new Error(`${checked.error}: ${checked.message}`)
}
await fetch(api('members'), { method: 'POST', headers, body: JSON.stringify({ name: ME, ...IDENTITY }) })

// SSE 購読 → 自分に関係する新着だけ一行通知へ変換。切断は外部障害なので再接続する。
const actionHint = 'read_unread で本文を読み、本文に具体的な依頼・行動要求があればそれをこのturnで実行し、完了または具体的なblockerをroomへ報告してから入力待ちに戻ること。情報通知だけなら追加の外部行動を起こさず読了で戻ること。'
async function subscribe() {
  for (;;) {
    try {
      const res = await fetch(api(`events`))
      let buf = ''
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString('utf8')
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const lines = frame.split('\n')
          // 名前付きイベント（ping/member等）はチャット発言ではない。明示的に読み飛ばす——
          // 現状は relevant() が宛先無しの payload を弾いて偶然安全なだけで、将来のイベント追加が
          // 席を起こす経路を open のままにしない
          if (lines.some(l => l.startsWith('event: '))) continue
          const data = lines.filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('')
          if (!data) continue
          const m = JSON.parse(data)
          if (!relevant(m) || isIdleSelfWake(m)) continue
          await mcp.notification({
            method: 'notifications/claude/channel',
            params: {
              content: `room に新着あり（${m.from} → ${Array.isArray(m.to_names) ? m.to_names.join(', ') : m.to}）。${actionHint}`,
              meta: { from: m.from, to: Array.isArray(m.to_names) ? m.to_names.join(',') : m.to, seq: String(m.seq) },
            },
          })
        }
      }
    } catch {
      // サーバー断。少し待って再接続（会話は止まるが工程はローカル Lattice で続く）
    }
    await new Promise(r => setTimeout(r, 3000))
  }
}
subscribe()

// --- diagnostics（決定45 の契約。read-only。呼ばれた時だけ走る）-------------------------
// 関数宣言なので巻き上げられ、ファイル冒頭のサブコマンド分岐から呼べる。
// checks の値は契約どおり状態そのもの（pass / fail / not_applicable / unverified）。
// 外部 adapter が exact allowlist で検証するため JSON へ理由を混ぜず、理由は人間可読出力に出す。
async function runDiagnostics(asJson) {
  const checks = {}
  const why = {}
  const run = async (name, fn) => {
    try {
      const [status, reason] = await fn()
      checks[name] = status
      why[name] = reason
    } catch (e) {
      checks[name] = 'unverified'
      why[name] = `判定不能: ${e.message}`
    }
  }

  let pkg = null
  let pkgError = null
  try {
    pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  } catch (e) {
    pkgError = e
  }
  const needPkg = () => {
    if (!pkg) throw pkgError
    return pkg
  }

  await run('version_consistency', () => {
    const v = needPkg().version
    return v === MCP_VERSION
      ? ['pass', `package.json と client.mjs がどちらも ${v}`]
      : ['fail', `package.json=${v} / client.mjs=${MCP_VERSION} で食い違っている`]
  })

  await run('bin_integrity', () => {
    const bins = Object.entries(needPkg().bin ?? {})
    if (!bins.length) throw new Error('package.json に bin が無い')
    const broken = bins.filter(([, rel]) => {
      const p = join(PKG_ROOT, rel)
      if (!existsSync(p)) return true
      return !readFileSync(p, 'utf8').startsWith('#!')
    })
    return broken.length
      ? ['fail', `不在または shebang 無し: ${broken.map(([n]) => n).join(', ')}`]
      : ['pass', `${bins.map(([n]) => n).join(' / ')} が存在し shebang を持つ`]
  })

  await run('node_runtime', () => {
    const want = needPkg().engines?.node
    const min = /^>=\s*(\d+)/.exec(want ?? '')
    if (!min) throw new Error(`engines.node を解釈できない: ${want}`)
    const major = Number(process.version.slice(1).split('.')[0])
    return major >= Number(min[1])
      ? ['pass', `${process.version} が ${want} を満たす`]
      : ['fail', `${process.version} は ${want} を満たさない`]
  })

  await run('skill_bundle', () => {
    const required = [
      'SKILL.md',
      'scripts/setup.sh',
      'scripts/teardown.sh',
      'scripts/external-pane.mjs',
      'scripts/launch-seat.sh',
      'scripts/resolve-seat-placement.mjs',
      'scripts/tmux-at.bash',
      'scripts/tmux-socket.mjs',
      'scripts/seat-identity.mjs',
      'scripts/pid-alive.mjs',
      'scripts/parent-watch.mjs',
      'scripts/parent-watch-logic.mjs',
      'scripts/seat-credential.mjs',
      'scripts/ensure-room-mcp.mjs',
      // 既存卓の現行tree同期とteardownのblock単位所有。resume／teardownから呼ぶため一体で必須
      'scripts/room-mcp-config.mjs',
      'scripts/upgrade-team-assets.sh',
      'scripts/remove-managed-room-mcp.mjs',
      'scripts/bridge-record-live.mjs',
      'scripts/leave-seat.sh',
      'scripts/change-seat.sh',
      'scripts/set-mission.sh',
      'scripts/post-message.mjs',
      // effort 専用の互換入口。change-seat.sh へ委譲するので、どちらが欠けても席設定変更が死ぬ
      'scripts/change-effort.sh',
      'scripts/make-plan-input.mjs',
      'scripts/parent-join.sh',
      'scripts/wakeup-bridge.mjs',
      'scripts/wakeup-delivery.mjs',
      'scripts/seat-status-bridge.mjs',
      // 円卓開始ゲートと既存 room の正規 resume 入口（決定104・105）。欠けると親の依頼確定と再稼働が手作業へ戻る
      'scripts/kickoff-gate.mjs',
      'scripts/resume.sh',
      // teardown の archive（＝解散・既定）が呼ぶ。欠けるとログの写しが取れない
      'scripts/archive-room-log.py',
      'templates/gen-plan.mjs',
      'templates/done.sh',
      'templates/independence-refresh.sh',
      'templates/parent.md',
      'templates/charter.md',
      'templates/member.md',
      'templates/member-standalone.md',
      'templates/tasks.md',
      'templates/mcp.json',
    ]
    const missing = required.filter(f => !existsSync(join(PKG_ROOT, 'skill', f)))
    return missing.length
      ? ['fail', `skill/ に不足: ${missing.join(', ')}`]
      : ['pass', `必須 ${required.length} ファイルが揃っている`]
  })

  await run('room_reachability', async () => {
    const url = process.env.PEERTABLE_URL
    if (!url) return ['not_applicable', 'PEERTABLE_URL 未設定（npm 単体利用の平常状態）']
    try {
      const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(3000) })
      return res.ok
        ? ['pass', `${url}/ が ${res.status} を返した`]
        : ['fail', `${url}/ が ${res.status} を返した`]
    } catch (e) {
      // 到達しないことは判定不能ではなく確定した fail（unverified へ丸めない）
      return ['fail', `${url}/ へ到達できない: ${e.message}`]
    }
  })

  const values = Object.values(checks)
  const overall = values.includes('unverified') ? 'unverified'
    : values.includes('fail') ? 'not_ready'
      : 'ready'

  const report = {
    schema: 'peertable.native_factory_diagnostics.v1',
    product: { name: pkg?.name ?? 'peertable', version: pkg?.version ?? null },
    checks,
    overall,
  }
  if (asJson) {
    console.log(JSON.stringify(report))
  } else {
    console.log(`peertable ${report.product.version ?? '(version 不明)'} — ${overall}`)
    for (const [name, status] of Object.entries(checks)) console.log(`  ${status.padEnd(15)} ${name}: ${why[name]}`)
  }
  return overall === 'ready' ? 0 : 1
}
