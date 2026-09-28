// 公式Codexの設定APIで追加・解除するfocused再現。認証なしの専用設定dirで、親受信の実機成績は作らない。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexConnection } from '../skill/scripts/parent-receivers/codex.mjs'
import { removeCodexConfiguration } from '../skill/scripts/parent-connect.mjs'

const dir = mkdtempSync(join(tmpdir(), 'peertable-codex-config-removal-'))
const file = join(dir, 'config.toml')
const before = '#利用者\n[features]\nhooks = true\n\n[hooks.state.\'foreign:key\']\nenabled = false\ntrusted_hash = "利用者の承認"\n'
writeFileSync(file, before)
let client
try {
  client = await codexConnection(dir, { codexHome: dir })
  const ownKey = 'own:key.with.dot"and-quote'
  await client.request('config/batchWrite', { filePath: file, edits: [
    { keyPath: 'mcp_servers.peertable_parent', value: { command: process.execPath, args: ['product-entry.mjs'] }, mergeStrategy: 'replace' },
    { keyPath: `hooks.state.${JSON.stringify(ownKey)}`, value: { enabled: true, trusted_hash: '自分の承認' }, mergeStrategy: 'replace' },
  ] })
  assert.notEqual(readFileSync(file, 'utf8'), before)
  await removeCodexConfiguration(client, file, [{ key: ownKey }])
  assert.equal(readFileSync(file, 'utf8'), before)
  console.log(JSON.stringify({ schema: 'peertable.codex-config-removal-repro.v1', status: 'passed', kind: 'offline_official_config_api_not_product_live', exact_foreign_text: true }))
} finally {
  if (client) await client.close()
  rmSync(dir, { recursive: true, force: true })
}
