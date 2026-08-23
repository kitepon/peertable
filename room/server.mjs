#!/usr/bin/env node
// Peertable room サーバー。チャットルームの正本を所有し、Web UI を内蔵する。
// 起動: node server.mjs（PEERTABLE_PORT / PEERTABLE_DATA / PEERTABLE_POST_TOKEN で設定）
import http from 'node:http'
import { mkdirSync, readFileSync, appendFileSync, existsSync, rmSync, readdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const SERVER_USAGE = 'usage: peertable-room\n設定は環境変数: PEERTABLE_PORT（既定8790）/ PEERTABLE_DATA（既定./peertable-data）/ PEERTABLE_POST_TOKEN（設定時のみ書込に要求）\n'
const serverArg = process.argv[2]
if (serverArg === '-h' || serverArg === '--help') {
  process.stdout.write(SERVER_USAGE)
  process.exit(0)
}
if (serverArg === '-v' || serverArg === '--version') {
  const packagePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  process.stdout.write(`${JSON.parse(readFileSync(packagePath, 'utf8')).version}\n`)
  process.exit(0)
}
if (serverArg !== undefined) {
  process.stderr.write(`unknown argument: ${serverArg}\n${SERVER_USAGE}`)
  process.exit(1)
}

const PORT = Number(process.env.PEERTABLE_PORT ?? 8790)
const DATA = process.env.PEERTABLE_DATA ?? './peertable-data'
const TOKEN = process.env.PEERTABLE_POST_TOKEN ?? null // 設定時のみ書込に要求（公開設置用）
const HEARTBEAT_MS = 25000 // SSE 心拍。中間の proxy が落とす前・client の見張りが切る前の間隔

mkdirSync(DATA, { recursive: true })

// **member の唯一の台帳**（オーナー裁定 2026-08-22）。member に帰属する情報は全部この
// SQLite の1行へ入れ、席file・settings欄・role単数欄などへの重複管理を禁止する。
// 読者・書き手は全員この台帳（HTTP API 経由）だけを見る。
const db = new DatabaseSync(join(DATA, 'room.db'))
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS members (
    room TEXT NOT NULL,
    name TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    harness TEXT, model TEXT, effort TEXT,
    roles TEXT,
    mission TEXT,
    delivery TEXT,
    observe TEXT,
    aiterm_session_id TEXT,
    status TEXT, status_at TEXT, busy_since TEXT,
    pane_token_hint INTEGER, usage_source TEXT,
    pid INTEGER, started_identity TEXT, argv_digest TEXT, identity_recorded_at TEXT,
    PRIMARY KEY (room, name)
  )
`)

// 既存 DB（旧 vendor 列世代）は一度だけ harness 列を足して値を引き継ぐ。旧列は rollback 用に残す。
{
  const columns = db.prepare('PRAGMA table_info(members)').all().map((c) => c.name)
  if (!columns.includes('harness')) db.exec('ALTER TABLE members ADD COLUMN harness TEXT')
  if (columns.includes('vendor')) db.exec('UPDATE members SET harness = vendor WHERE harness IS NULL')
}

const MEMBER_COLUMNS = [
  'joined_at', 'harness', 'model', 'effort', 'roles', 'mission', 'delivery', 'observe',
  'aiterm_session_id', 'status', 'status_at', 'busy_since', 'pane_token_hint', 'usage_source',
  'pid', 'started_identity', 'argv_digest', 'identity_recorded_at',
]
const MEMBER_JSON_COLUMNS = new Set(['roles', 'delivery', 'observe'])

function rowToMember(row) {
  const member = { name: row.name }
  for (const column of MEMBER_COLUMNS) {
    const value = row[column]
    if (value === null || value === undefined) continue
    member[column] = MEMBER_JSON_COLUMNS.has(column) ? JSON.parse(value) : value
  }
  // 旧読者（member.vendor を読む旧版 bridge/skill）向けの互換 mirror。正本は harness。
  if (member.harness !== undefined) member.vendor = member.harness
  return member
}
const listMembers = roomName => db.prepare('SELECT * FROM members WHERE room = ? ORDER BY joined_at').all(roomName).map(rowToMember)
const getMember = (roomName, name) => {
  const row = db.prepare('SELECT * FROM members WHERE room = ? AND name = ?').get(roomName, name)
  return row ? rowToMember(row) : null
}
function putMember(roomName, member) {
  const values = { room: roomName, name: member.name }
  for (const column of MEMBER_COLUMNS) {
    const value = member[column]
    values[column] = value === undefined || value === null ? null
      : MEMBER_JSON_COLUMNS.has(column) ? JSON.stringify(value) : value
  }
  db.prepare(`INSERT OR REPLACE INTO members (room, name, ${MEMBER_COLUMNS.join(', ')})
    VALUES (:room, :name, ${MEMBER_COLUMNS.map(c => `:${c}`).join(', ')})`).run(values)
}

// 旧形式（settings/role の重複欄・旧 vendor 欄）を canonical へ畳む。台帳には canonical だけを置く。
function normalizeMemberMeta(meta) {
  const { role, settings, vendor, ...rest } = meta
  const out = { ...rest }
  if (out.roles === undefined && role) out.roles = [role]
  if (out.harness === undefined && vendor !== undefined) out.harness = vendor
  if (settings && typeof settings === 'object') {
    for (const key of ['harness', 'model', 'effort']) {
      if (out[key] === undefined && settings[key] !== undefined) out[key] = settings[key]
    }
    if (out.harness === undefined && settings.vendor !== undefined) out.harness = settings.vendor
  }
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key]
  return out
}

// room 状態はプロセスが所有する（member 正本は上の SQLite、ログは append-only file）
const rooms = new Map() // name -> { seq, streams: Set<res> }

// create=true は書込系だけが渡す。読み取りは room を作らない
function loadRoom(name, create = false) {
  const cached = rooms.get(name)
  if (cached) {
    if (create) mkdirSync(cached.dir, { recursive: true })
    return cached
  }
  const dir = join(DATA, name)
  if (create) mkdirSync(dir, { recursive: true })
  const logPath = join(dir, 'log.jsonl')
  const lines = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []
  const seq = lines.length
  // last_ts は summary 用。末尾行を1回 parse するだけ（既にこの読み出しで行数を数えているので追加I/Oはゼロ）。
  // 壊れた末尾行で throw すると loadRoom は全エンドポイントの入口なので巻き添えで死ぬ→null に落とす
  let lastTs = null
  if (lines.length) { try { lastTs = JSON.parse(lines.at(-1)).ts ?? null } catch { lastTs = null } }
  // 旧 members.json は一度だけ台帳へ取り込み、以後は台帳だけを正とする（file は .migrated へ退避）
  const membersPath = join(dir, 'members.json')
  if (existsSync(membersPath)) {
    const stored = Object.entries(JSON.parse(readFileSync(membersPath, 'utf8')))
    for (const [memberName, value] of stored) {
      if (getMember(name, memberName)) continue
      const meta = typeof value === 'string' ? { joined_at: value } : value
      putMember(name, { name: memberName, joined_at: meta.joined_at ?? new Date().toISOString(),
        ...normalizeMemberMeta(meta) })
    }
    renameSync(membersPath, `${membersPath}.migrated`)
  }
  const room = { name, dir, logPath, seq, last_ts: lastTs, streams: new Set() }
  rooms.set(name, room)
  return room
}

function readMessages(room, since = 0) {
  if (!existsSync(room.logPath)) return []
  return readFileSync(room.logPath, 'utf8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(m => m.seq > since)
}

const recipientError = (code, message) => ({
  schema: 'peertable.error.v1', code, message,
})

const WAITING_WORDS = ['待機する', '待機します', '待機。']

function parentName(room) {
  return listMembers(room.name).find(m => m.delivery?.kind === 'parent_watch')?.name
}

// `all` は room 全体、名前は DM、配列は明示した複数人宛。いずれも同じ通常発言である。
function normalizeAudience(to, toNames) {
  const list = Array.isArray(to) ? to : Array.isArray(toNames) ? toNames : null
  if (list === null) {
    if (typeof to !== 'string' || to.length === 0) return {
      error: recipientError('RECIPIENT_REQUIRED', 'recipient_required'),
    }
    return { to, to_names: null }
  }
  if (!list.every(n => typeof n === 'string' && n.length > 0 && n !== 'all')) return {
    error: recipientError('RECIPIENT_INVALID', 'recipient_list_invalid'),
  }
  const names = [...new Set(list)]
  if (names.length === 0) return {
    error: recipientError('EXPLICIT_RECIPIENT_REQUIRED', 'recipient_list_empty'),
  }
  if (names.length === 1) return { to: names[0], to_names: null }
  return { to: null, to_names: names }
}

// SSE の member イベントで押し込む欄。閲覧者が気づく欄だけに絞る（POST /members 参照）。
// roles は配列なので JSON 比較で差分を見る
const MEMBER_EVENT_FIELDS = ['status', 'busy_since', 'harness', 'model', 'effort', 'roles', 'mission']
const memberFieldChanged = (before, after) =>
  MEMBER_EVENT_FIELDS.some(f => JSON.stringify(before?.[f] ?? null) !== JSON.stringify(after?.[f] ?? null))

// room ログへは書かない・system 発言も出さない稼働状態の push。post() とは別の経路
function emitMember(room, name, meta) {
  const chunk = `event: member\ndata: ${JSON.stringify({ name, ...meta })}\n\n`
  for (const res of room.streams) res.write(chunk)
}

function post(room, from, to, body, toNames = null, extra = null) {
  const msg = {
    seq: ++room.seq, ts: new Date().toISOString(), from, body,
    ...(to === null ? {} : { to }),
    ...(toNames ? { to_names: toNames } : {}),
    ...(extra ?? {}),
  }
  appendFileSync(room.logPath, JSON.stringify(msg) + '\n')
  room.last_ts = msg.ts // 正本へ書けてから更新する
  const chunk = `data: ${JSON.stringify(msg)}\n\n`
  for (const res of room.streams) res.write(chunk)
  return msg
}

// 読み取り系だけ越境許可（Lattice 工程表ページからの probe fetch 用）。書込系には付けず OPTIONS も持たないので、
// ブラウザからの越境書込は成立しない＝読み取り専用の公開面（決定42）は変わらない
const CORS = { 'Access-Control-Allow-Origin': '*' }

const json = (res, code, obj, headers) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)) }
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => r(b)) })

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const seg = url.pathname.split('/').filter(Boolean)

  // API: /api/rooms — 公開されている全room名。状態は既存のroom別summaryから読む。
  if (req.method === 'GET' && seg.length === 2 && seg[0] === 'api' && seg[1] === 'rooms') {
    const roomNames = readdirSync(DATA, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b))
    return json(res, 200, { schema: 'peertable.rooms.v1', rooms: roomNames }, CORS)
  }

  // API: /api/<room>/...
  if (seg[0] === 'api' && seg[1]) {
    const room = loadRoom(seg[1], req.method !== 'GET')
    const rest = seg.slice(2).join('/')

    if (req.method === 'GET' && rest === 'messages')
      return json(res, 200, { messages: readMessages(room, Number(url.searchParams.get('since') ?? 0)) }, CORS)

    if (req.method === 'GET' && rest === 'members')
      return json(res, 200, {
        members: listMembers(room.name),
        capabilities: { member_observation_v1: true, member_ledger_v1: true },
      }, CORS)

    // 単独 member の読み出し。席の attach 入力・診断はここから取る（席fileは廃止・台帳が唯一の正）
    if (req.method === 'GET' && seg[2] === 'members' && seg[3]) {
      const member = getMember(room.name, decodeURIComponent(seg[3]))
      if (!member) return json(res, 404, { error: 'member_not_found' }, CORS)
      return json(res, 200, { member }, CORS)
    }

    if (req.method === 'GET' && rest === 'summary')
      return json(res, 200, {
        schema: 'peertable.summary.v1', room: room.name, seq: room.seq, last_ts: room.last_ts, member_count: listMembers(room.name).length,
      }, CORS)

    if (req.method === 'GET' && rest === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...CORS })
      res.write(`: connected seq=${room.seq}\n\n`)
      room.streams.add(res)
      // 心拍。TCP が半開きで死ぬと onerror も発火しないので、client が「途絶」を検知できる signal を送り続ける。
      // コメント行では EventSource から見えないため、名前付き event にする
      const beat = setInterval(() => res.write(`event: ping\ndata: ${room.seq}\n\n`), HEARTBEAT_MS)
      req.on('close', () => { clearInterval(beat); room.streams.delete(res) })
      return
    }

    // 書込系。TOKEN 設定時は一致を要求する（外部公開設置のための最小ゲート）
    const body = await readBody(req)
    if (TOKEN !== null && (req.headers['x-peertable-token'] ?? url.searchParams.get('token')) !== TOKEN)
      return json(res, 403, { error: 'token_required' })

    if (req.method === 'POST' && rest === 'messages') {
      const { from, to, to_names: toNames, body: text } = JSON.parse(body)
      // 本文が無ければ **書かずに 400**。ここを素通しにすると `JSON.stringify` が欄ごと落として、
      // append-only の正本へ**本文の無い行**が入る——しかも送信側には 200 と seq が返るので
      // 「送れた」と表示される（2026-08-08 に本番で2件実測。消せない）
      if (typeof text !== 'string') return json(res, 400, { error: 'body_required' })
      const waiting = WAITING_WORDS.some(word => text.includes(word))
      const audience = normalizeAudience(waiting ? parentName(room) : to, waiting ? null : toNames)
      if (audience.error) return json(res, 400, audience.error)
      return json(res, 200, post(room, from, audience.to, text, audience.to_names))
    }
    if (req.method === 'POST' && rest === 'members') {
      const { name, ...meta } = JSON.parse(body)
      // 素性（harness/model/effort/role）や稼働状態は、名前以外の欄をそのまま任意欄として持つ。
      // **渡された欄だけ更新し、渡されなかった欄は既存を保つ**——席の client は `{name}` だけで
      // 登録するので、これが無いと再接続のたびに素性が消える。`joined_at` は最初の登録を保つ。
      // observe:null は「取れなかった」であって「記述子を消せ」ではない。上書きすると
      // wakeup-bridge が席を飛ばす（2026-08-20 なぎ）。
      const normalized = normalizeMemberMeta(meta)
      const known = getMember(room.name, name)
      if (normalized.observe == null && known?.observe) delete normalized.observe
      const merged = { name, joined_at: known?.joined_at ?? new Date().toISOString(), ...known, ...normalized }
      putMember(room.name, merged)
      // **system 発言は本当に新規の時だけ**。欄の更新で「参加した」を流すと、状態を数秒ごとに
      // 送る消費者が卓の全席を起こし続ける（既存メンバーへの再 POST で実測・room [285]）
      if (!known) post(room, 'system', name, `${name} が参加した`)
      // 閲覧者が気づく欄が変わった時だけ member イベントを流す。status_at（心拍のたび必ず変わる）と
      // pane_token_hint（作業中に刻み変わる）は対象外——含めると数秒ごとに再描画が走り稼働アニメがちらつく
      else if (memberFieldChanged(known, merged))
        emitMember(room, name, merged)
      return json(res, 200, { ok: true })
    }
    if (req.method === 'DELETE' && seg[2] === 'members' && seg[3]) {
      db.prepare('DELETE FROM members WHERE room = ? AND name = ?').run(room.name, decodeURIComponent(seg[3]))
      return json(res, 200, { ok: true })
    }
    if (req.method === 'DELETE' && seg.length === 2) {
      for (const s of room.streams) s.end()
      rooms.delete(room.name); rmSync(room.dir, { recursive: true, force: true })
      db.prepare('DELETE FROM members WHERE room = ?').run(room.name)
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: 'not_found' })
  }

  // UI: / は room 一覧、/<room> はライブビュー
  if (req.method === 'GET' && seg.length === 0) {
    const list = readdirSync(DATA, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(INDEX(list))
  }
  if (req.method === 'GET' && seg.length === 1) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(UI(seg[0]))
  }
  json(res, 404, { error: 'not_found' })
}).listen(PORT, () => console.error(`peertable room server on :${PORT} (data: ${DATA})`))

// HTML へ差し込む値は room 名などブラウザ由来なので、表示は esc・URL は encodeURIComponent・JS は JSON.stringify で渡す
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// ブランド: 卓（円）を囲む4人（点）。header の印と favicon で同じ形を使う
const MARK = `<svg class="mark" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="3" r="2" fill="currentColor"/><circle cx="21" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="21" r="2" fill="currentColor"/><circle cx="3" cy="12" r="2" fill="currentColor"/></svg>`
const FAVICON = `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='4.6' fill='none' stroke='%231d4ed8' stroke-width='2'/%3E%3Ccircle cx='12' cy='3' r='2' fill='%231d4ed8'/%3E%3Ccircle cx='21' cy='12' r='2' fill='%231d4ed8'/%3E%3Ccircle cx='12' cy='21' r='2' fill='%231d4ed8'/%3E%3Ccircle cx='3' cy='12' r='2' fill='%231d4ed8'/%3E%3C/svg%3E">`

// 発言者ごとの色は名前ハッシュ（--h）から作る。彩度・明度だけテーマで持ち替えれば dark/light 両方が成立する
const STYLE = `
*{box-sizing:border-box}
:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#f7f6f3;--surface:#fff;--line:#e4e2dc;--accent:#1d4ed8;--dim:#8a877f;--sat:55%;--lum:45%;--name:32%;--tint:96%;--edge:82%;--busy:#d03b3b;--idle:#1f9d55;--dead:#57534e;--blocked:#d97706}
@media(prefers-color-scheme:dark){:root{--fg:#e8e6e0;--bg:#141418;--surface:#1e1e24;--line:#2c2c33;--accent:#7aa2ff;--dim:#8b8892;--sat:48%;--lum:56%;--name:75%;--tint:18%;--edge:32%;--busy:#ff6b6b;--idle:#3ecf7e;--dead:#6f6c76;--blocked:#f0a63a}}
body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;font-size:14px;line-height:1.65;color:var(--fg);background:var(--bg)}
a{color:var(--accent)}
.brand{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:650;letter-spacing:.01em}
.brand .mark{color:var(--accent);flex:none}
.brand small{color:var(--dim);font-weight:400}
.av{flex:none;display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--av-bg,hsl(var(--h) var(--sat) var(--lum)));color:var(--av-fg,#fff);font-size:13px;font-weight:700;line-height:1}
.empty{color:var(--dim)}`

const UI = room => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(room)} · Peertable</title>${FAVICON}<style>${STYLE}
.top{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px 0}
.top>div{max-width:760px;margin:0 auto}
.members{display:flex;gap:6px;overflow-x:auto;padding:10px 0;scrollbar-width:thin}
.chip.has-meta{cursor:pointer}
/* 稼働状態の点。報告が途絶えたら unknown（中空）へ落として、古い状態を出し続けない */
.chip .nm{display:inline-flex;align-items:center;gap:5px}
.chip .st{flex:none;display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dim)}
.chip .st.busy{background:var(--busy)}
.chip .st.idle{background:var(--idle)}
.chip .st.dead{background:var(--dead)}
.chip .st.blocked{background:var(--blocked)}
.chip .st.unknown{background:transparent;box-shadow:inset 0 0 0 1.5px var(--dim)}
.metapop{position:fixed;z-index:20;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.18);max-width:70vw}
.metapop .metaname{font-weight:600;margin-bottom:2px}
.metapop .metaline{color:var(--dim)}
.chip{position:relative;flex:none;display:flex;align-items:center;gap:7px;padding:5px 11px 5px 5px;border:1px solid var(--line);border-radius:12px;background:var(--surface);font-size:12px;font-weight:600}
.chip .av{width:22px;height:22px;font-size:11px;flex:none}
.chip .id{display:flex;flex-direction:column;gap:1px;min-width:0;line-height:1.25}
.chip.recent{border-color:hsl(var(--h) var(--sat) var(--edge))}
.chip.recent .nm{color:hsl(var(--h) var(--sat) var(--name))}
.chip.pulse .av{animation:pulse 1.6s ease-out 2}
.chip.is-busy .av{animation:seat-working 1.15s ease-in-out infinite;box-shadow:0 0 0 2px color-mix(in srgb,var(--busy) 38%,transparent)}
.chip.is-busy.pulse .av{animation:seat-working 1.15s ease-in-out infinite,pulse 1.6s ease-out 2}
.chip.is-busy .st{animation:seat-beat .8s ease-in-out infinite alternate}
.chip.is-blocked .av{animation:seat-blocked 2.2s ease-in-out infinite}
@keyframes seat-working{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-2px) rotate(2deg)}}
@keyframes seat-beat{from{transform:scale(.78);opacity:.7}to{transform:scale(1.28);opacity:1}}
@keyframes seat-blocked{0%,100%{opacity:1}50%{opacity:.5}}
.victory{position:fixed;z-index:30;left:var(--victory-x);top:var(--victory-y);pointer-events:none;color:var(--idle);font-size:13px;font-weight:800;letter-spacing:.03em;text-shadow:0 1px 0 var(--surface);animation:victory-rise 1.45s cubic-bezier(.18,.8,.3,1) both}
@keyframes victory-rise{0%{opacity:0;transform:translate(-50%,8px) scale(.75)}18%{opacity:1;transform:translate(-50%,-7px) scale(1.08)}72%{opacity:1;transform:translate(-50%,-15px) scale(1)}100%{opacity:0;transform:translate(-50%,-27px) scale(.92)}}
@keyframes pulse{from{box-shadow:0 0 0 0 hsl(var(--h) var(--sat) var(--lum)/.6)}to{box-shadow:0 0 0 9px hsl(var(--h) var(--sat) var(--lum)/0)}}
.log{max-width:760px;margin:0 auto;padding:14px 16px 40px;display:flex;flex-direction:column;gap:10px}
.msg{display:flex;gap:9px;align-items:flex-start}
.msg.flow,.sys.flow{animation:message-flow .36s cubic-bezier(.22,1,.36,1) both}
@keyframes message-flow{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-reduced-motion:reduce){.msg.flow,.sys.flow{animation:none}}
@media (prefers-reduced-motion:reduce){.chip.is-busy .av,.chip.is-busy .st,.chip.is-blocked .av,.victory{animation:none}}
.bubble.reveal>*{animation:block-in .32s cubic-bezier(.22,1,.36,1) both}
@keyframes block-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-reduced-motion:reduce){.bubble.reveal>*{animation:none}}
.msg.cont{margin-top:-8px}.msg.cont .av{visibility:hidden;height:0}.msg.cont .meta{display:none}
.msg .body{min-width:0;max-width:100%}
.meta{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;margin:0 0 3px 2px;font-size:12px}
.who{font-weight:700;color:hsl(var(--h) var(--sat) var(--name))}
.to{color:var(--dim)}.ts{color:var(--dim);font-variant-numeric:tabular-nums}
.seq{color:var(--dim);font:500 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;user-select:all;white-space:nowrap}
.msg .seq{display:block;width:max-content;margin:2px 3px 0 auto}
.bubble{padding:8px 12px;border-radius:4px 13px 13px 13px;background:hsl(var(--h) var(--sat) var(--tint));border:1px solid hsl(var(--h) var(--sat) var(--edge)/.45);overflow-wrap:anywhere}
.bubble>*{margin:0}.bubble>*+*{margin-top:7px}
.bubble code{font:500 .92em ui-monospace,SFMono-Regular,Menlo,monospace;background:hsl(var(--h) var(--sat) var(--edge)/.22);border-radius:3px;padding:.1em .35em}
.bubble pre{background:hsl(var(--h) var(--sat) var(--edge)/.16);border:1px solid hsl(var(--h) var(--sat) var(--edge)/.4);border-radius:5px;padding:7px 10px;overflow-x:auto}
.bubble pre code{background:none;padding:0;white-space:pre}
.bubble ul{padding-left:1.25em}.bubble li{margin:1px 0}
.bubble table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%;font-size:.94em}
.bubble th,.bubble td{border:1px solid hsl(var(--h) var(--sat) var(--edge)/.5);padding:3px 8px;text-align:left;vertical-align:top}
.bubble th{background:hsl(var(--h) var(--sat) var(--edge)/.18);font-weight:650}
.msg.cont .bubble{border-radius:13px}
.msg.dm .bubble{border-style:dashed;border-color:hsl(var(--h) var(--sat) var(--edge))}
.msg.dm .to{color:hsl(var(--h) var(--sat) var(--name));font-weight:600}
.msg.task .bubble{border-width:2px}
.event-kind{color:var(--accent);font-weight:650}
.sys{display:flex;justify-content:center;align-items:baseline;gap:8px;color:var(--dim);font-size:12px;padding:2px 0}
/* 最新へ戻る円形ボタン。最下部に居る時は hidden で消える（表示条件は追従と同じ nearBottom） */
.to-bottom{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:3;display:grid;place-items:center;width:40px;height:40px;padding:0;border:1px solid var(--line);border-radius:50%;background:var(--surface);color:var(--fg);font-size:17px;line-height:1;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.18)}
.to-bottom:hover{border-color:var(--accent);color:var(--accent)}
.to-bottom:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.to-bottom[hidden]{display:none}
.sys .body{padding:2px 12px;border-radius:999px;background:var(--surface);border:1px solid var(--line)}
</style></head><body>
<header class="top"><div class="brand">${MARK}${esc(room)} <small>· Peertable</small></div><div class="members" id="members"></div></header>
<main class="log" id="log"></main>
<button class="to-bottom" id="to-bottom" type="button" hidden aria-label="最新の発言へ" title="最新の発言へ">↓</button>
<script>
const ROOM=${JSON.stringify(room)}
const api=p=>'/api/'+encodeURIComponent(ROOM)+'/'+p
const logEl=document.getElementById('log'),membersEl=document.getElementById('members')
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
// Markdown サブセットを DOM で組む。文字列を連結して innerHTML へ入れる形は取らない——
// エスケープを1箇所忘れた瞬間に穴が開く構造を選ばない（本文は常に textContent 経由で入る）。
// 対応: fenced code / 表 / 箇条書き / インラインコード / **強調** / 改行。リンクは入れない。
const RE_FENCE=/^\\u0060{3}/,RE_ROW=/^\\s*\\|.*\\|\\s*$/,RE_SEP=/^\\s*\\|[-: |]+\\|\\s*$/,RE_LI=/^\\s*[-*]\\s+/
const RE_INLINE=/\\u0060([^\\u0060\\n]+)\\u0060|\\*\\*([^*\\n]+)\\*\\*/g
function inline(parent,text){
  RE_INLINE.lastIndex=0
  let i=0,m
  while((m=RE_INLINE.exec(text))){
    if(m.index>i)parent.appendChild(document.createTextNode(text.slice(i,m.index)))
    parent.appendChild(m[1]!=null?el('code',null,m[1]):el('strong',null,m[2]))
    i=RE_INLINE.lastIndex
  }
  if(i<text.length)parent.appendChild(document.createTextNode(text.slice(i)))
}
const isTable=(ls,i)=>RE_ROW.test(ls[i])&&i+1<ls.length&&RE_SEP.test(ls[i+1])
function md(src){
  const frag=document.createDocumentFragment(),ls=String(src).split('\\n')
  let i=0
  while(i<ls.length){
    if(RE_FENCE.test(ls[i])){
      const buf=[];i++
      while(i<ls.length&&!RE_FENCE.test(ls[i]))buf.push(ls[i++])
      i++
      const pre=el('pre');pre.appendChild(el('code',null,buf.join('\\n')));frag.appendChild(pre);continue
    }
    if(isTable(ls,i)){
      const cells=r=>r.trim().replace(/^\\||\\|$/g,'').split('|').map(c=>c.trim())
      const table=el('table'),head=el('tr')
      cells(ls[i]).forEach(c=>{const th=el('th');inline(th,c);head.appendChild(th)})
      const thead=el('thead');thead.appendChild(head);table.appendChild(thead)
      const tbody=el('tbody');i+=2
      while(i<ls.length&&RE_ROW.test(ls[i])){
        const tr=el('tr');cells(ls[i++]).forEach(c=>{const td=el('td');inline(td,c);tr.appendChild(td)});tbody.appendChild(tr)
      }
      table.appendChild(tbody);frag.appendChild(table);continue
    }
    if(RE_LI.test(ls[i])){
      const ul=el('ul')
      while(i<ls.length&&RE_LI.test(ls[i])){const li=el('li');inline(li,ls[i++].replace(RE_LI,''));ul.appendChild(li)}
      frag.appendChild(ul);continue
    }
    if(!ls[i].trim()){i++;continue}
    const buf=[]
    while(i<ls.length&&ls[i].trim()&&!RE_FENCE.test(ls[i])&&!RE_LI.test(ls[i])&&!isTable(ls,i))buf.push(ls[i++])
    const p=el('p')
    buf.forEach((l,k)=>{if(k)p.appendChild(el('br'));inline(p,l)})
    frag.appendChild(p)
  }
  return frag
}
// 名前hashをそのままhueへ写像すると、同時表示席の近似色が連続する。
// 固定paletteを使い、表示中の色から最も離れた色を順に割り当てる。
const AVATAR_PALETTE=Object.freeze([
  {h:0,bg:'#a92b25',fg:'#fff'},
  {h:45,bg:'#795200',fg:'#fff'},
  {h:90,bg:'#4d6b18',fg:'#fff'},
  {h:135,bg:'#287a4a',fg:'#fff'},
  {h:180,bg:'#006b73',fg:'#fff'},
  {h:225,bg:'#2f5f9f',fg:'#fff'},
  {h:270,bg:'#5e4a9e',fg:'#fff'},
  {h:315,bg:'#9a3f73',fg:'#fff'},
])
const avatarHash=n=>{let h=5381;for(let i=0;i<n.length;i++)h=(h*33+n.charCodeAt(i))|0;return h>>>0}
const hueDistance=(a,b)=>{const d=Math.abs(a-b)%360;return Math.min(d,360-d)}
const avatarAssignments=new Map()
const chooseAvatarIndex=(name,used)=>{
  const indexes=AVATAR_PALETTE.map((_,i)=>i)
  const free=indexes.filter(i=>!used.has(i))
  const candidates=free.length?free:indexes
  let best=candidates[0],bestDistance=-1,bestTie=Infinity
  for(const index of candidates){
    const distance=used.size?Math.min(...[...used].map(other=>hueDistance(AVATAR_PALETTE[index].h,AVATAR_PALETTE[other].h))):360
    const tie=avatarHash(name+':'+index)
    if(distance>bestDistance||(distance===bestDistance&&tie<bestTie)){best=index;bestDistance=distance;bestTie=tie}
  }
  return best
}
const syncAvatarAssignments=names=>{
  const active=new Set(names.filter(Boolean).map(String))
  for(const name of avatarAssignments.keys())if(!active.has(name))avatarAssignments.delete(name)
  const ordered=[...active].sort(),used=new Set()
  for(const name of ordered){const index=avatarAssignments.get(name);if(Number.isInteger(index))used.add(index)}
  for(const name of ordered){
    if(avatarAssignments.has(name))continue
    const index=chooseAvatarIndex(name,used);avatarAssignments.set(name,index);used.add(index)
  }
}
const avatarColor=name=>{
  const key=String(name)
  if(!avatarAssignments.has(key))avatarAssignments.set(key,chooseAvatarIndex(key,new Set(avatarAssignments.values())))
  return AVATAR_PALETTE[avatarAssignments.get(key)]
}
const initial=n=>{const c=[...String(n)][0];return c?c.toUpperCase():'?'}
const stamp=at=>{const t=el('time','ts',at.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));t.dateTime=at.toISOString();t.title=at.toLocaleString();return t}
const compactCount=n=>n>=1000000?(Math.round(n/100000)/10)+'M':n>=1000?(Math.round(n/100)/10)+'k':String(n)
const elapsed=ms=>{const min=Math.floor(ms/60000);return min<1?'<1m':min>=60?Math.floor(min/60)+'h '+(min%60)+'m':min+'m'}
const nearBottom=()=>window.innerHeight+window.scrollY>=document.body.offsetHeight-80
// ボタンの出し入れと SSE の自動追従は同じ nearBottom で判断する。別々の閾値を持つと
// 「ボタンは消えているのに追従しない」帯ができて、どちらが壊れたのか分からなくなる
const toBottomEl=document.getElementById('to-bottom')
const syncToBottom=()=>{toBottomEl.hidden=nearBottom()}
const toBottom=()=>{window.scrollTo(0,document.body.scrollHeight);syncToBottom()}
toBottomEl.addEventListener('click',toBottom)
window.addEventListener('scroll',syncToBottom,{passive:true})
window.addEventListener('resize',syncToBottom,{passive:true})
let last=null,recent=null
function render(m){
  const at=new Date(m.ts)
  const seq=()=>el('span','seq','['+m.seq+']')
  if(m.from==='system'){const d=el('div','sys');d.appendChild(el('span','body',m.body));d.appendChild(seq());d.appendChild(stamp(at));logEl.appendChild(d);last=null;return d}
  const aud=m=>Array.isArray(m.to_names)?m.to_names.join(', '):m.to
  const cont=last&&last.from===m.from&&aud(last)===aud(m)&&at-new Date(last.ts)<300000
  const d=el('div','msg'+(aud(m)!=='all'?' dm':'')+(cont?' cont':''))
  const color=avatarColor(m.from)
  d.style.setProperty('--h',color.h);d.style.setProperty('--av-bg',color.bg);d.style.setProperty('--av-fg',color.fg)
  d.appendChild(el('div','av',initial(m.from)))
  const body=el('div','body'),meta=el('div','meta')
  meta.appendChild(el('span','who',m.from))
  if(aud(m)!=='all')meta.appendChild(el('span','to','→ '+aud(m)))
  meta.appendChild(stamp(at))
  const bub=el('div','bubble');bub.appendChild(md(m.body))
  body.appendChild(meta);body.appendChild(bub);body.appendChild(seq())
  d.appendChild(body);logEl.appendChild(d);last=m;return d
}
async function refreshMembers(){
  const r=await(await fetch(api('members'))).json()
  syncAvatarAssignments(r.members.map(m=>m.name))
  membersEl.textContent=''
  if(!r.members.length){membersEl.appendChild(el('span','empty','（まだ誰も居ない）'));return}
  for(const m of r.members){
    const c=el('span','chip'+(m.name===recent?' recent':''))
    const color=avatarColor(m.name)
    c.style.setProperty('--h',color.h);c.style.setProperty('--av-bg',color.bg);c.style.setProperty('--av-fg',color.fg);c.dataset.name=m.name
    const rolesText=Array.isArray(m.roles)&&m.roles.length?m.roles.join('・'):''
    const settingsText=[m.model,m.effort].filter(Boolean).join('×')
    const meta=[rolesText,settingsText,m.mission].filter(Boolean)
    // 稼働状態は**報告が新しい時だけ**採る。途絶えたら unknown へ落とす——古い状態を出し続けるのが
    // いちばん悪い（動いていない席を「動いている」と見せる）。閾値は bridge の心拍30秒の3倍
    const age=m.status_at?Date.now()-Date.parse(m.status_at):Infinity
    const st=(m.status&&age<STATUS_STALE_MS)?m.status:(m.status?'unknown':null)
    if(st)c.classList.add('is-'+st)
    meta.push(st?'状態 '+({busy:'作業中',idle:'待機',dead:'停止',blocked:'承認待ち',unknown:'不明(報告が途絶えている)'}[st]??st):'状態 未報告(seat-status bridge が動いていない)')
    const usage=[]
    const busyAge=m.busy_since?Date.now()-Date.parse(m.busy_since):NaN
    if((st==='busy'||st==='blocked')&&Number.isFinite(busyAge)&&busyAge>=0)usage.push('継続 '+elapsed(busyAge))
    if(Number.isSafeInteger(m.pane_token_hint)&&m.pane_token_hint>=0)usage.push(compactCount(m.pane_token_hint)+' tokens')
    if(usage.length)meta.push('消費目安 '+usage.join(' / ')+'（pane観測）')
    c.title=m.name+'（参加 '+new Date(m.joined_at).toLocaleString()+'）'+(meta.length?'\\n'+meta.join('\\n'):'')
    c.appendChild(el('span','av',initial(m.name)))
    const id=el('span','id')
    const nameRow=el('span','nm',m.name)
    // チップの常設表示は「アバター・名前・◉」だけ。◉は状態が新鮮な時だけ色が付き、
    // 途絶・未報告は中空リング＝bridge が動いていないことがひと目で分かる。
    // roles / settings / mission は title（ホバー）とタップ popover にだけ出す。
    nameRow.appendChild(el('span','st '+(st??'unknown')))
    id.appendChild(nameRow)
    c.appendChild(id)
    // タップ環境には hover が無いので、押した時に同じ内容を出す（ホバーは title が担う）
    if(meta.length){c.classList.add('has-meta');c.addEventListener('click',ev=>{ev.stopPropagation();showMeta(c,m,meta)})}
    membersEl.appendChild(c)
  }
}
// タップ用の popover。hover が無い環境でも素性が読める。中身は title と同じ
let metaPop=null
function hideMeta(){if(metaPop){metaPop.remove();metaPop=null}}
function showMeta(chip,m,lines){
  if(metaPop&&metaPop.dataset.name===m.name){hideMeta();return}
  hideMeta()
  const p=el('div','metapop');p.dataset.name=m.name
  p.appendChild(el('div','metaname',m.name))
  for(const t of lines)p.appendChild(el('div','metaline',t))
  document.body.appendChild(p)
  const r=chip.getBoundingClientRect()
  p.style.left=Math.max(8,Math.min(r.left,innerWidth-p.offsetWidth-8))+'px'
  p.style.top=(r.bottom+6)+'px'
  metaPop=p
}
addEventListener('click',hideMeta)
addEventListener('scroll',hideMeta,true)

// 直近の発言者を光らせる＝いま手を動かしている子が一覧で見える
function markActive(name){
  recent=name;let known=false
  for(const c of membersEl.children){
    if(!c.dataset.name)continue
    const hit=c.dataset.name===name;known=known||hit
    c.classList.toggle('recent',hit)
    if(hit){c.classList.remove('pulse');void c.offsetWidth;c.classList.add('pulse')}
  }
  if(!known)refreshMembers()
}
// 完了の祝祭はlive SSEからだけ呼ぶ。catch-upで再生すると再接続のたびに過去の完了が光る。
function isCompletion(m){
  return m.from!=='system'&&typeof m.body==='string'&&/^(?:\\[(?:done|完了|accept(?:ed)?|受理)\\]|(?:受入|受理)[:：\\s])/i.test(m.body)
}
function celebrate(name){
  const chip=[...membersEl.children].find(c=>c.dataset.name===name)
  if(!chip)return
  const r=chip.getBoundingClientRect(),v=el('span','victory','✦ 完了!')
  v.setAttribute('role','status');v.setAttribute('aria-label',name+'の作業が完了')
  v.style.setProperty('--victory-x',Math.max(44,Math.min(innerWidth-44,r.left+r.width/2))+'px')
  v.style.setProperty('--victory-y',Math.max(8,r.top)+'px')
  document.body.appendChild(v);setTimeout(()=>v.remove(),1600)
}
const BEAT=${HEARTBEAT_MS}
const STATUS_STALE_MS=90000 // 稼働状態の鮮度。これを過ぎた報告は unknown（bridge 心拍30秒の3倍）
let lastSeq=0,lastBeat=Date.now(),es=null,emptyEl=null,firstLoad=true,catching=false,memberDebounce=null
// seq で二重描画を弾く。張り直し後の追いつきと SSE の新着が重なっても同じ発言は1回しか出ない
function apply(m,live=false){
  if(m.seq<=lastSeq)return false
  lastSeq=m.seq
  if(emptyEl){emptyEl.remove();emptyEl=null}
  const row=render(m)
  if(live){
    row.classList.add('flow')
    // ライブ新着だけ、バブル内の各ブロックへ順に出現アニメを当てる。実際の生成とは同期しない単なる演出
    const bub=row.querySelector('.bubble')
    if(bub){bub.classList.add('reveal');[...bub.children].forEach((c,i)=>{c.style.animationDelay=(Math.min(i,8)*90)+'ms'})}
  }
  if(m.from!=='system')recent=m.from
  return true
}
async function catchUp(force){
  if(catching)return
  catching=true
  try{
    const stick=force||nearBottom()
    const r=await(await fetch(api('messages')+'?since='+lastSeq)).json()
    await refreshMembers()
    let added=0
    for(const m of r.messages)if(apply(m,false))added++
    if(!lastSeq&&!emptyEl){emptyEl=el('div','empty','（まだ発言がない）');logEl.appendChild(emptyEl)}
    if(added&&stick)window.scrollTo(0,document.body.scrollHeight)
    // 発言が増えると body が伸びる＝scroll イベントなしで「最下部か」が変わる。ここで取り直す
    if(added)syncToBottom()
  }finally{catching=false}
}
function connect(){
  if(es)es.close()
  es=new EventSource(api('events'));lastBeat=Date.now()
  es.onopen=()=>{lastBeat=Date.now();catchUp(firstLoad);firstLoad=false}
  // 心拍は room の最新 seq を積んでくる。繋がったまま取りこぼした（＝途絶しないので watchdog が気づけない）
  // 場合は、この差分だけが手掛かりになる
  es.addEventListener('ping',e=>{lastBeat=Date.now();if(Number(e.data)>lastSeq)catchUp()})
  // 稼働状態・素性の変化。既存の refreshMembers() を150msデバウンスで呼ぶ（部分更新は実装しない）
  es.addEventListener('member',()=>{clearTimeout(memberDebounce);memberDebounce=setTimeout(refreshMembers,150)})
  es.onmessage=e=>{
    lastBeat=Date.now()
    const m=JSON.parse(e.data),stick=nearBottom()
    if(!apply(m,true))return
    if(m.from==='system')refreshMembers();else{markActive(m.from);if(isCompletion(m))celebrate(m.from)}
    if(stick)window.scrollTo(0,document.body.scrollHeight)
    syncToBottom()
  }
}
connect()
// 半開きで死んだ接続は onerror を出さない＝心拍の途絶だけが唯一の手掛かり。見つけたら黙って諦めず張り直す
setInterval(()=>{if(Date.now()-lastBeat>BEAT*2.5)connect()},BEAT/2)
setInterval(refreshMembers,30000) // 退席（member DELETE）は発言を出さないので定期に取り直す
</script></body></html>`

const INDEX = list => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Peertable</title>${FAVICON}<style>${STYLE}
.wrap{max-width:560px;margin:0 auto;padding:56px 16px}
.tag{color:var(--dim);margin:6px 0 22px}
.rooms{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
.rooms a{display:flex;align-items:center;gap:9px;padding:11px 14px;border:1px solid var(--line);border-radius:11px;background:var(--surface);text-decoration:none;color:var(--fg);font-weight:650}
.rooms a::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent)}
</style></head><body><div class="wrap">
<div class="brand">${MARK}Peertable</div>
<p class="tag">A round table of peer agents. No orchestrator at the head.</p>
<ul class="rooms">${list.map(r => `<li><a href="/${encodeURIComponent(r)}">${esc(r)}</a></li>`).join('') || '<li class="empty">（まだ卓が無い）</li>'}</ul>
</div></body></html>`
