#!/usr/bin/env node
// 同梱snapshotの役割→1位〜3位から、着席可能な harness / model / effort を解決する。
// 外部文書を読むのは呼出側が明示した時だけ。隣接repoの有無で製品挙動を変えない。
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const EFFORT = /×\s*(none|low|medium|high|xhigh|max|ultra)/iu
const harnessOf = (modelName) => {
  const name = String(modelName).trim()
  if (/^claude\b/iu.test(name)) return 'claude'
  if (/^gpt\b|^gpt-/iu.test(name)) return 'codex'
  if (/^grok\b/iu.test(name)) return 'grok'
  return null
}

const fail = (code, message) => {
  process.stderr.write(`${code}: ${message}\n`)
  process.exit(2)
}

export function findModelsDoc({ env = process.env, exists = existsSync, scriptDir = here } = {}) {
  if (env.PEERTABLE_MODELS_DOC) return resolve(env.PEERTABLE_MODELS_DOC)
  if (env.DOTAGENTS_ROOT) return join(resolve(env.DOTAGENTS_ROOT), 'docs/02_models.md')
  const bundled = join(scriptDir, '../02_models.snapshot.md')
  if (exists(bundled)) return bundled
  return null
}

const stripCell = (cell) => String(cell ?? '').replace(/\*\*/g, '').trim()

const parseMarkdownTable = (block) => {
  const lines = block.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('|'))
  if (lines.length < 3) return []
  const headers = lines[0].split('|').slice(1, -1).map((cell) => stripCell(cell))
  return lines.slice(2).map((line) => {
    const cells = line.split('|').slice(1, -1).map((cell) => stripCell(cell))
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']))
  })
}

const section = (markdown, heading) => {
  const start = markdown.indexOf(`## ${heading}`)
  if (start < 0) return ''
  const rest = markdown.slice(start)
  const next = rest.search(/\n## /)
  return next < 0 ? rest : rest.slice(0, next)
}

const slugOf = (cell) => {
  const alias = cell.match(/alias\s+`([^`]+)`/u)
  if (alias) return alias[1]
  const slug = cell.match(/`([^`]+)`/u)
  return slug ? slug[1] : null
}

export function parseLedger(markdown) {
  const rows = parseMarkdownTable(section(markdown, 'モデル台帳'))
  return rows.flatMap((row) => {
    const name = row['モデル']
    const slug = slugOf(row['slug'] ?? '')
    const harness = harnessOf(name)
    if (!name || !slug || !harness) return []
    return [{ name, slug, harness }]
  })
}

const parseCell = (cell) => {
  const raw = stripCell(cell)
  if (!raw || raw === '—' || raw === '-') return null
  if (raw.includes('オーナー指定')) return { skip: 'owner-pin', cell: raw }
  if (/^ChatGPT/iu.test(raw) || raw.includes('gpt-connector')) return { skip: 'not-a-seat', cell: raw }
  const effortMatch = raw.match(EFFORT)
  const modelKey = raw.split('×')[0]
    .replace(/（[^）]*）/gu, '')
    .replace(/\([^)]*\)/gu, '')
    .trim()
  if (!modelKey) return { skip: 'unparseable', cell: raw }
  return {
    modelKey,
    effort: effortMatch ? effortMatch[1].toLowerCase() : null,
    cell: raw,
  }
}

const matchLedger = (modelKey, ledger) => {
  const key = modelKey.toLowerCase()
  const exact = ledger.find((row) => row.name.toLowerCase() === key)
  if (exact) return exact
  const contained = ledger.filter((row) => row.name.toLowerCase().includes(key) || key.includes(row.name.toLowerCase()))
  if (contained.length === 1) return contained[0]
  const token = ledger.filter((row) => row.name.toLowerCase().split(/\s+/u).includes(key))
  if (token.length === 1) return token[0]
  return null
}

export function listOfficialRoles(markdown) {
  return parseMarkdownTable(section(markdown, '順位表（役割→1位〜3位）'))
    .map((row) => row['役割'])
    .filter(Boolean)
}

export function harnessFromSlug(slug) {
  const text = String(slug ?? '').trim().toLowerCase()
  if (!text) return null
  if (/^(gpt-|gpt\b|o[0-9])/u.test(text)) return 'codex'
  if (/^(claude|opus|sonnet|haiku|fable)\b/u.test(text)) return 'claude'
  if (/^grok\b/u.test(text)) return 'grok'
  return null
}

const parseRoleList = (roles) => {
  const raw = Array.isArray(roles) ? roles : String(roles ?? '').split(/[,、]/u)
  const seen = new Set()
  const list = []
  for (const item of raw) {
    const role = String(item ?? '').trim()
    if (!role || seen.has(role)) continue
    seen.add(role)
    list.push(role)
  }
  return list
}

export function resolveSeatPlacement(role, markdown, { source = '', harness = '' } = {}) {
  const wantHarness = String(harness ?? '').trim()
  const wanted = String(role ?? '').trim()
  if (!wanted) {
    return { error: 'SEAT_ROLE_REQUIRED', message: 'role が空（02_models の役割名が要る）' }
  }
  const ranks = parseMarkdownTable(section(markdown, '順位表（役割→1位〜3位）'))
  const row = ranks.find((item) => item['役割'] === wanted)
  if (!row) {
    const known = ranks.map((item) => item['役割']).filter(Boolean)
    return { error: 'SEAT_ROLE_UNKNOWN', message: `未知の役割: ${wanted}（${known.join(' / ')}）` }
  }
  const ledger = parseLedger(markdown)
  const dropped = []
  for (const rank of [1, 2, 3]) {
    const parsed = parseCell(row[`${rank}位`])
    if (!parsed) continue
    if (parsed.skip) {
      dropped.push({ rank, reason: parsed.skip, cell: parsed.cell })
      continue
    }
    const hit = matchLedger(parsed.modelKey, ledger)
    if (!hit) {
      dropped.push({ rank, reason: 'not-in-ledger', cell: parsed.cell })
      continue
    }
    if (wantHarness && hit.harness !== wantHarness) {
      dropped.push({ rank, reason: `harness-mismatch(want ${wantHarness})`, cell: parsed.cell })
      continue
    }
    if (hit.slug === 'haiku') {
      return { role: wanted, rank, harness: hit.harness, model: hit.slug, effort: '', source, dropped }
    }
    if (!parsed.effort) {
      dropped.push({ rank, reason: 'effort-missing', cell: parsed.cell })
      continue
    }
    return {
      role: wanted,
      rank,
      harness: hit.harness,
      model: hit.slug,
      effort: parsed.effort,
      source,
      dropped,
    }
  }
  return {
    error: 'SEAT_PLACEMENT_UNRESOLVABLE',
    message: `${wanted}${wantHarness ? `（harness=${wantHarness}）` : ''} を着席可能な harness/model/effort へ解決できない`,
    dropped,
  }
}

export function resolveSeatIdentity({
  roles, model, effort, harness, markdown, source = '', allowParentRole = false,
} = {}) {
  const roleList = parseRoleList(roles)
  if (roleList.length === 0) {
    return { error: 'SEAT_ROLE_REQUIRED', message: 'roles が空（02_models の役割名が1つ以上要る）' }
  }
  const official = listOfficialRoles(markdown)
  const unknown = roleList.filter((role) => !official.includes(role))
  if (unknown.length > 0) {
    return {
      error: 'SEAT_ROLE_UNKNOWN',
      message: `未知の役割: ${unknown.join(', ')}（${official.join(' / ')}）`,
    }
  }
  if (roleList.includes('実装') && roleList.includes('反証')) {
    return { error: 'SEAT_ROLE_CONFLICT', message: '同一人物に実装と反証を同時に付けられない' }
  }
  if (!allowParentRole && roleList.includes('統括')) {
    return { error: 'SEAT_ROLE_PARENT_ONLY', message: '統括は親セッションの役割であり席を起こさない' }
  }
  if (allowParentRole && roleList.includes('統括') && !String(model ?? '').trim()) {
    return {
      roles: roleList,
      settings: {
        harness: String(harness ?? '').trim(),
        model: '',
        effort: String(effort ?? '').trim(),
      },
      source,
    }
  }

  const requestedModel = String(model ?? '').trim()
  const requestedEffort = String(effort ?? '').trim()
  const requestedHarness = String(harness ?? '').trim()
  if (requestedModel) {
    const resolvedHarness = requestedHarness || harnessFromSlug(requestedModel)
      || parseLedger(markdown).find((row) => row.slug === requestedModel)?.harness
    if (!resolvedHarness) {
      return {
        error: 'SEAT_HARNESS_UNRESOLVED',
        message: `model=${requestedModel} の harness を推定できない（--harness が要る）`,
      }
    }
    return {
      roles: roleList,
      settings: { harness: resolvedHarness, model: requestedModel, effort: requestedEffort },
      source,
    }
  }

  const first = resolveSeatPlacement(roleList[0], markdown, { source, harness: requestedHarness })
  if (first.error) return first
  return {
    roles: roleList,
    settings: {
      harness: first.harness,
      model: first.model,
      effort: requestedEffort || first.effort || '',
    },
    source,
    dropped: first.dropped,
  }
}

// realpath比較にする——symlink経由（例: ~/.claude/skills/peertable → 実体tree）で呼ばれると
// パス文字列比較が外れ、mainが走らず「exit 0・出力なし」で沈黙する（実被弾 2026-08-25:
// launch-seat.sh が SEAT_LAUNCH_HARNESS_UNSUPPORTED: harness= で落ち、原因が見えなかった）。
const isMain = process.argv[1] && (() => {
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isMain) {
  const args = process.argv.slice(2)
  let roles = ''
  let model = ''
  let effort = ''
  let harness = ''
  const positional = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--roles') { roles = args[++i] ?? ''; continue }
    if (arg === '--model') { model = args[++i] ?? ''; continue }
    if (arg === '--effort') { effort = args[++i] ?? ''; continue }
    // --vendor は旧名の互換 alias
    if (arg === '--harness' || arg === '--vendor') { harness = args[++i] ?? ''; continue }
    positional.push(arg)
  }
  if (!roles) roles = positional[0] ?? ''
  const doc = findModelsDoc()
  if (!doc) {
    fail('SEAT_MODELS_DOC_MISSING', '同梱の02_models.snapshot.mdが見つからない')
  }
  if (!existsSync(doc)) {
    fail('SEAT_MODELS_DOC_MISSING', `02_models.md が無い: ${doc}`)
  }
  const result = resolveSeatIdentity({
    roles, model, effort, harness, markdown: readFileSync(doc, 'utf8'), source: doc,
  })
  if (result.error) fail(result.error, result.message)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
