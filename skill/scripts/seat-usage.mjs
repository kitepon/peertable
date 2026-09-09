import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveWindowsCommand, resolveWindowsLatticeCommand } from './platform/windows/resolve-lattice-command.mjs'

const POST_TOKEN_LINE = /^\s*(?:export\s+)?PEERTABLE_POST_TOKEN\s*=\s*(.*)$/

export function supportsMemberObservation(payload) {
  return payload?.capabilities?.member_observation_v1 === true
}

export function resolveLatticeExecutable(cli, { platform = process.platform, exists = existsSync } = {}) {
  if (typeof cli !== 'string' || !cli) return { command: cli, argv: ['todo', 'status', '--json'] }
  if (platform !== 'win32') return { command: cli, argv: ['todo', 'status', '--json'] }
  return resolveWindowsLatticeCommand(cli, exists)
}

export function resolveLatticeInvocation(cli, argv, {
  platform = process.platform,
  exists = existsSync,
  pwsh = 'pwsh.exe',
} = {}) {
  return resolveWindowsCommand(cli, argv, { platform, exists, pwsh })
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

export function parentWatchShouldNotify(message, roomUpdate) {
  const body = String(message?.body ?? '')
  if (roomUpdate) return /全タスク完了|\[オーナー宛/u.test(body)
  return true
}
