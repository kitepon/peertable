import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { resolveWindowsLatticeCommand } from './platform/windows/resolve-lattice-command.mjs'
import { classifyGrokPaneTail, isGrokPrivacyBanner } from './vendors/grok/pane-status.mjs'

const TOKEN_HINT = /[↓↑]\s*([0-9]+(?:\.[0-9]+)?)\s*([kKmM]?)\s*tokens\b/gu

const POST_TOKEN_LINE = /^\s*(?:export\s+)?PEERTABLE_POST_TOKEN\s*=\s*(.*)$/

const TOKEN_MULTIPLIER = Object.freeze({
  '': 1,
  k: 1_000,
  m: 1_000_000,
})

export function supportsMemberObservation(payload) {
  return payload?.capabilities?.member_observation_v1 === true
}

/** aiterm-mcp の POSIX 既定ソケット規則。Windows の path.join で `/tmp` を壊さない。 */
export function defaultTmuxSocket(env) {
  return path.posix.join(env.TMPDIR || '/tmp', 'claude-tmux-sockets', 'claude.sock')
}

const defaultTmuxProbe = {
  serverAlive(socket) {
    try {
      execFileSync('tmux', ['-S', socket, 'ls'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  },
  listAitermSockets() {
    try {
      return readdirSync('/tmp')
        .filter(name => /^aiterm-.*\.sock$/u.test(name))
        .map(name => join('/tmp', name))
    } catch {
      return []
    }
  },
}

/**
 * 明示設定、既定、検証済み発見の順で tmux socket を決める。
 * 見つからない既定値は launch-seat.sh が新しい server を作るために必要なので返す。
 */
export function resolveTmuxSocket(env, probe = defaultTmuxProbe) {
  if (env.PEERTABLE_TMUX_SOCKET) {
    return { socket: env.PEERTABLE_TMUX_SOCKET, source: 'explicit', candidates: [], error: null }
  }
  const fallback = defaultTmuxSocket(env)
  if (probe.serverAlive(fallback)) {
    return { socket: fallback, source: 'default', candidates: [], error: null }
  }
  const candidates = probe.listAitermSockets().filter(socket => probe.serverAlive(socket))
  if (candidates.length === 1) {
    return { socket: candidates[0], source: 'discovered', candidates, error: null }
  }
  if (candidates.length > 1) {
    return {
      socket: null,
      source: 'none',
      candidates,
      error: { code: 'PEERTABLE_TMUX_SOCKET_AMBIGUOUS', message: '検証済み aiterm socket が複数あります' },
    }
  }
  return { socket: fallback, source: 'default', candidates: [], error: null }
}

/**
 * Windows の psmux は -S を黙って既定 namespace へ落とす（aiterm 実測 2026-08-16）。
 * aiterm と同じ -L namespace を使う。名前の式は aiterm-mcp core.js の WIN_NS と一致させる。
 */
export function usesPsmuxNamespace(env = process.env, platform = process.platform) {
  if (env.PEERTABLE_FORCE_POSIX_TMUX === '1') return false
  if (env.PEERTABLE_TMUX_L || env.AITERM_PSMUX_NS) return true
  return platform === 'win32'
}

export function aitermPsmuxNamespace(env = process.env, platform = process.platform) {
  if (env.PEERTABLE_TMUX_L) return env.PEERTABLE_TMUX_L
  if (env.AITERM_PSMUX_NS) return env.AITERM_PSMUX_NS
  const isWin = platform === 'win32'
  const root = env.TMPDIR ?? (isWin ? env.TEMP ?? tmpdir() : '/tmp')
  const joinPath = isWin ? path.win32.join : path.posix.join
  const sockdir = joinPath(root, 'claude-tmux-sockets')
  return `aiterm-${createHash('sha1').update(sockdir).digest('hex').slice(0, 12)}`
}

/** tmux/psmux へ渡す接続引数。POSIX は -S socket、Windows は -L namespace。 */
export function tmuxArgv(extraArgs = [], { socket, env = process.env, platform = process.platform } = {}) {
  if (usesPsmuxNamespace(env, platform)) {
    return ['-L', aitermPsmuxNamespace(env, platform), ...extraArgs]
  }
  return ['-S', socket, ...extraArgs]
}

/**
 * npm の extensionless shim は Windows の execFile で ENOENT。
 * 隣の .cmd を cmd.exe /c で起動する（shell:true は DEP0190 かつ引数連結）。
 */
export function resolveLatticeExecutable(cli, { platform = process.platform, exists = existsSync } = {}) {
  if (typeof cli !== 'string' || !cli) return { command: cli, argv: ['todo', 'status', '--json'] }
  if (platform !== 'win32') return { command: cli, argv: ['todo', 'status', '--json'] }
  return resolveWindowsLatticeCommand(cli, exists)
}

/** member の自己申告を優先し、無い既存 member だけ旧 session 名へ互換フォールバックする。 */
export function resolveSeatObservation(member, defaultSocket) {
  const observe = member?.observe
  if (observe && typeof observe === 'object' && typeof observe.tmux_target === 'string' && observe.tmux_target) {
    const socket = observe.tmux_socket || defaultSocket
    return socket ? { socket, target: observe.tmux_target, source: 'descriptor' } : null
  }
  return defaultSocket && member?.name
    ? { socket: defaultSocket, target: `peer-${member.name}`, source: 'legacy' }
    : null
}

/**
 * `~/.config/peertable.env` の本文から書込トークンを読む。**`export` の有無に依存しない。**
 * 2026-08-10 実測: `export` を落とした設定ファイルを `source` した shell から `nohup node …` で
 * 起こした bridge は、トークンを持たないまま常駐して **4時間 HTTP 403 を撃ち続けた**。
 * 起こす側の shell の書き方に、常駐の生死を握らせない。
 */
export function parsePostTokenEnvFile(text) {
  if (typeof text !== 'string') return null
  for (const line of text.split('\n')) {
    const matched = POST_TOKEN_LINE.exec(line)
    if (!matched) continue
    let value = matched[1].trim()
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    if (quoted && value.length >= 2) value = value.slice(1, -1)
    if (value) return value
  }
  return null
}

/**
 * launch-seat.sh:25-27 と同じ解決規則で書込トークンを決める（直接env → 席別credential → 設定file）。
 * 規則を二重に書かない——常駐bridgeは起こし側のshell envを継承しないため、席別credentialのpathを
 * 明示的に渡す。readFileは試験のための注入口で、既定は実ファイルを読む。
 */
export function resolvePostToken(env, readFile = path => { try { return readFileSync(path, 'utf8') } catch { return null } }) {
  if (env.PEERTABLE_POST_TOKEN) return env.PEERTABLE_POST_TOKEN
  if (env.PEERTABLE_CREDENTIAL_FILE) {
    const token = readFile(env.PEERTABLE_CREDENTIAL_FILE)
    return typeof token === 'string' ? token.trim() : ''
  }
  return parsePostTokenEnvFile(readFile(join(env.HOME || homedir(), '.config', 'peertable.env'))) ?? ''
}

/**
 * 送信結果から常駐を続けてよいかを決める。**「一度も書けていない」と「一度は書けたが今落ちている」を
 * 分ける**——前者は起動不良で、常駐しても「点が出ない」という**起動していない場合と同じ結果**を
 * 「起動している」ように見せてしまう。だから常駐に入らせない。後者は途中の障害なので、
 * 連続 limit 回で止める（黙って再試行を続けるゾンビを作らない・決定54）。
 * 送るものが1件も無い tick は失敗ではない（席がまだ立っていない卓が正常にありうる）。
 */
export function decideBridgeContinuation({ attempted, failed, provenWritable, failedTicks, limit }) {
  if (attempted === 0) return { verdict: 'idle', provenWritable, failedTicks }
  if (failed < attempted) return { verdict: 'ok', provenWritable: true, failedTicks: 0 }
  const next = failedTicks + 1
  if (!provenWritable) return { verdict: 'write_denied', provenWritable, failedTicks: next }
  return { verdict: next >= limit ? 'unreachable' : 'degraded', provenWritable, failedTicks: next }
}

/**
 * tmux セッションが見つからない席の扱いを決める。**tmux 席を持たない member（親など）は
 * 一度も観測できない**ので `null`（送らない）。**過去に観測できていた席が消えたら実際に落ちた**
 * ので `dead` を返す。previous は直前に送信できた観測（`{status,...}` か undefined）。
 */
export function deriveMissingSession(previous) {
  return previous ? { status: 'dead', busySince: null, paneTokenHint: null } : null
}

// launch-seat.sh:74-77 と docs/plan.md §11 が実測で記録した既知ダイアログ文言の集合
export const BLOCKED_MARKERS = [
  '1. Yes, I trust this folder',
  '1. I am using this for local development',
  '1. Yes, continue',
  'Do you want to proceed?',
  // Codex v0.148 のコマンド承認ダイアログ（2026-08-22 実測: 承認待ちの席が idle と
  // 誤表示され、オーナーが「動いているのに表示が変わらない」と気づいた）
  'Would you like to run the following command?',
  '1. Yes, proceed',
  'Press enter to confirm or esc to cancel',
]

export { isGrokPrivacyBanner }

/**
 * pane 末尾の生文字列から画面状態を判定する。判定順は busy → blocked → idle
 * （承認プロンプト表示中は `esc to interrupt` が消えるので busy を先に見る）。
 */
export function classifyPaneTail(tail) {
  if (typeof tail !== 'string') return 'idle'
  if (tail.includes('esc to interrupt')) return 'busy'
  // Claude Code 2.1 / Fable TUI は思考中に esc to interrupt を出さない（2026-08-19 実測）。
  // 動名詞（Sprouting / Wibbling 等）は毎回変わるので使わない。
  // 思考中の固定句に加え、ツール実行中は経過時間付きスピナー行と /btw の固定ヒントが出る。
  if (tail.includes('thinking with') || tail.includes('almost done thinking')) return 'busy'
  if (tail.includes("without interrupting Claude's current work")) return 'busy'
  if (tail.includes('Calling tools')) return 'busy'
  if (/…\s*\(\d+(?:m \d+)?s\b/u.test(tail)) return 'busy'
  const grokStatus = classifyGrokPaneTail(tail)
  if (grokStatus !== null) return grokStatus
  if (BLOCKED_MARKERS.some(marker => tail.includes(marker))) return 'blocked'
  return 'idle'
}

/**
 * pane 内で実行中の CLI プロセスの pid（`#{pane_pid}`）を読む。tmux pane 自体は生きたまま
 * （`pane_dead=0`）、中の CLI プロセスだけが停止する局面があるため、pane の生死とは別に
 * このプロセス自身の状態を見る必要がある。
 */
export function tmuxPanePid(socket, target, exec = execFileSync) {
  try {
    const out = exec('tmux', tmuxArgv(['list-panes', '-t', target, '-F', '#{pane_pid}'], { socket }), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const pid = out.trim().split('\n')[0]
    return pid && /^[0-9]+$/.test(pid) ? pid : null
  } catch {
    return null
  }
}

/**
 * pane プロセス（またはその直接の子）が stopped（`ps` stat の先頭が `T`）かどうかを見る。
 * 実測（2026-08-11, bell/suzune）: Lattice pull run の accept hold は attach 済み worker
 * （pane の子で pid===pgid のもの）へ SIGSTOP を送る。tmux pane は shell も含めて生きたまま
 * （`pane_dead=0`）で、末尾の画面は停止直前のまま残るため、`classifyPaneTail` だけでは
 * `idle` と誤判定する。
 */
export function isPaneProcessStopped(panePid, exec = execFileSync) {
  if (!panePid) return false
  try {
    const out = exec('ps', ['-o', 'pid=,ppid=,stat=', '-A'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\n').some((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/u.exec(line)
      if (!match) return false
      const [, pid, ppid, stat] = match
      return (pid === String(panePid) || ppid === String(panePid)) && stat.startsWith('T')
    })
  } catch {
    return false
  }
}

/**
 * paneのstatus行が公開しているtoken値だけを読む。
 * harness固有のログや課金単価は推測せず、表示が無い席はnullのままにする。
 */
export function parsePaneTokenHint(pane) {
  if (typeof pane !== 'string') return null
  let latest = null
  for (const match of pane.matchAll(TOKEN_HINT)) {
    const multiplier = TOKEN_MULTIPLIER[match[2].toLowerCase()]
    const value = Math.round(Number(match[1]) * multiplier)
    if (Number.isSafeInteger(value) && value >= 0) latest = value
  }
  return latest
}

// ---- claim巡回番犬の純関数（seat-status-bridge.mjsが使う。testはここからimportする）----
export const STOP_DECLARATION = /\[待機\]|\[監査提出\]|待機します|散会/u

export function patrolTargets({ activeTasks, messages, statusOf, lastBusyStartAt, now, lastNag, nagIntervalMs }) {
  // task_id -> claim発言者の履歴。[claim]で積み、[claim撤回]で本人の最新claimを取り消す
  // （実被弾 2026-08-25 #160: 撤回を読めず、撤回済みの後発claim者へ番犬が誤って吠えた。
  // roomのclaimは割当の正本（決定25）なので、撤回も同じ語彙で読む——正本の外の推定はしない）。
  const claimHistory = new Map()
  for (const m of messages) {
    const claim = /^\[claim\]\s+([0-9A-Za-z._-]+)/u.exec(m.body ?? '')
    if (claim) {
      if (!claimHistory.has(claim[1])) claimHistory.set(claim[1], [])
      claimHistory.get(claim[1]).push(m.from)
      continue
    }
    const retract = /^\[claim撤回\]\s+([0-9A-Za-z._-]+)/u.exec(m.body ?? '')
    if (retract) {
      const history = claimHistory.get(retract[1]) ?? []
      const index = history.lastIndexOf(m.from)
      if (index !== -1) history.splice(index, 1)
    }
  }
  const owner = new Map()
  for (const [task, history] of claimHistory) {
    if (history.length > 0) owner.set(task, history.at(-1))
  }
  const targets = []
  for (const task of activeTasks) {
    const seat = owner.get(task)
    if (!seat || statusOf(seat) !== 'idle') continue
    // 待機の判定は観測ベース（2026-08-25 オーナー裁定）: 「最後のターン終了より後に待機宣言があるか」
    // だけを見る。宛先による失効・TTLのようなメッセージ解釈の条件は持たない。
    // ターンを終えたのに宣言せず黙った席（実被弾: 起こされて→落として→古い宣言の裏で就寝）は
    // 宣言がターン終了より古いので確実に引っかかる。
    let declTs = 0
    for (const m of messages) {
      if (m.from === seat && STOP_DECLARATION.test(m.body ?? '')) declTs = Date.parse(m.ts ?? '') || declTs
    }
    const busyStart = lastBusyStartAt(seat)
    // 錨はターン「開始」（2026-08-25 実被弾 #120: 終了錨だと「宣言→数秒後にターン終了」の正常系が
    // 常に古い判定を食らい誤爆する）。「最後のターンの開始より後に宣言した」＝そのターンが宣言を
    // 残したこと。起床ターンが無宣言で終わると、手持ちの宣言は前ターン開始より古くなり必ず捕まる。
    // bridge再起動等でターン履歴が無い席は、宣言の存在だけで正当とみなす（誤爆しない安全側）
    const declared = busyStart == null ? declTs > 0 : declTs >= busyStart - 10_000
    if (declared) continue
    if (now - (lastNag.get(seat) ?? 0) < nagIntervalMs) continue
    if (!targets.some(t => t.seat === seat)) targets.push({ seat, task })
  }
  return targets
}


// ---- ランプ合成（2026-08-25 オーナー裁定: ドットは1個、席と預け仕事を合成する）----
// 点滅(busy) = 席のターン実行中 または jobセッションの画面が動いている
// 点灯(idle) = どのプロセスかは生きているが、何も動いていない
// 白抜き(dead/unknown相当) = 何も無い
// blockedは「存在するが承認待ちで詰まっている」の特殊表示としてそのまま通す。
export function combineSeatLamp(paneStatus, job) {
  if (job?.active) return 'busy'
  if (paneStatus === 'busy' || paneStatus === 'blocked') return paneStatus
  if (paneStatus === 'idle' || job?.alive) return 'idle'
  return paneStatus // 'dead' 等はそのまま
}

// paneプロセスの子孫に実働（CPU消費）が居るかの判定素材。psの `pid ppid pcpu` 出力を受け取り、
// root配下の子孫（root自身は除く）に pcpu >= 閾値 が居れば true。席がCodex内蔵background terminal等、
// tmuxセッションを作らずに走らせた預け仕事を、プロセスツリーの実観測で拾う（2026-08-25 オーナー裁定
//「子プロセスも見る」）。nohup等でツリーから切り離された仕事はここでは見えない——それは
// peer-<name>-job* セッション慣例の側が受け持つ（二本立て）。
export function hasActiveDescendant(psRows, rootPid, { minCpu = 1.0, minAgeGapSeconds = 60 } = {}) {
  const parseEtime = (raw) => {
    // ps etime: [[dd-]hh:]mm:ss
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(raw)
    if (!m) return null
    return (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + (Number(m[3]) * 60) + Number(m[4])
  }
  const children = new Map()
  const cpu = new Map()
  const age = new Map()
  for (const row of psRows) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)/.exec(row)
    if (!m) continue
    const [pid, ppid, pcpu] = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
    cpu.set(pid, pcpu)
    age.set(pid, parseEtime(m[4]))
  }
  const rootAge = age.get(rootPid)
  const queue = [...(children.get(rootPid) ?? [])]
  while (queue.length) {
    const pid = queue.pop()
    // 席と同時に起動したプロセスは足場（CLI本体・MCP server群）であって預け仕事ではない。
    // 足場はアイドルでも1%前後のCPUを食い、ランプを恒常的に点滅させる誤検知源になる
    // （実被弾 2026-08-25: 監査待ちのkoharuが「ずっとアクティブ」に見えた）。
    // 「paneより有意に後から生まれた」ことだけを預け仕事の観測条件にする——起動時刻は
    // 観測できる事実であり、コマンド名の恣意的なリストを持たない。
    const laterBorn = rootAge != null && age.get(pid) != null && rootAge - age.get(pid) >= minAgeGapSeconds
    if (laterBorn && (cpu.get(pid) ?? 0) >= minCpu) return true
    queue.push(...(children.get(pid) ?? []))
  }
  return false
}

// pane子孫（filter該当分）の累積CPU時間合計（秒）。pcpu%は減衰平均でIO待ち主体のジョブが0.0へ
// 丸まる（実被弾 2026-08-25: 毎分数百リクエストの収集がpcpu 0.0で「非稼働」表示）。
// 累積CPU時間は実カウンタで、働いていれば周期間で必ず増える——「変化が発生しているか」を見る。
// psの `pid ppid time etime` 出力を受ける。filterは(childAgeSec, rootAgeSec)=>boolで足場除外等に使う。
export function subtreeCpuSeconds(psRows, rootPid, { includeChild = () => true, includeRoot = false } = {}) {
  // 小数部を捨てない: 30秒周期で数msずつ進む常駐ジョブは、秒未満を切ると差分が永久に0になり
  // 「生きているのに稼働として観測されない」（実被弾 2026-08-26: mioのp5daily監督ループ）
  const parseClock = (raw) => {
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(raw)
    if (!m) return null
    return (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + (Number(m[3]) * 60) + Number(m[4])
  }
  const children = new Map()
  const rec = new Map()
  for (const row of psRows) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)/.exec(row)
    if (!m) continue
    const [pid, ppid] = [Number(m[1]), Number(m[2])]
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
    rec.set(pid, { cpu: parseClock(m[3]), age: parseClock(m[4]) })
  }
  const rootAge = rec.get(rootPid)?.age ?? null
  let total = 0
  // 席paneでは root（harness本体）は常時CPUを進めるので数えない（足場除外と同じ理由）。
  // jobセッションでは root（pane pid）そのものが預け仕事の本体なので数える——数えないと
  // 監督ループ型のジョブが丸ごと不可視になる（実被弾 2026-08-26: mioのp5dailyがidle表示）
  if (includeRoot) total += rec.get(rootPid)?.cpu ?? 0
  const queue = [...(children.get(rootPid) ?? [])]
  while (queue.length) {
    const pid = queue.pop()
    const r = rec.get(pid)
    if (r && includeChild(r.age, rootAge)) total += r.cpu ?? 0
    queue.push(...(children.get(pid) ?? []))
  }
  return total
}
