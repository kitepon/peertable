#!/usr/bin/env node
// wakeup-bridge の配達入口。席の TUI への打鍵は aiterm の公開 API（pty_send / agent_steer）だけで行う。
// PTY の状態（前面プロセス・termios・貼付方言・submit 成立）は aiterm が所有し、bridge は
// 「誰に・いつ・何を届けるか」と receipt だけを持つ（責務境界。2026-09-04 オーナー裁定）。
// usage: aiterm-deliver.mjs <session_id> <body_file> [--mode=dispatch|steer]
//   dispatch: idle な席へ pty_send（自動 agent dispatch）。ready gate と submit 観測は aiterm。
//   steer:    実行中ターンへ agent_steer（Codex 0.153 はキューへ積む）。idle なら delivery=idle が返る。
// stdout に receipt JSON を1行。失敗は stderr に aiterm のエラー本文を出して非ゼロ。
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const args = process.argv.slice(2)
const mode = (args.find(a => a.startsWith('--mode=')) ?? '--mode=dispatch').slice('--mode='.length)
const [sessionId, bodyFile] = args.filter(a => !a.startsWith('--'))
if (!sessionId || !bodyFile || !['dispatch', 'steer'].includes(mode)) {
  process.stderr.write('usage: aiterm-deliver.mjs <session_id> <body_file> [--mode=dispatch|steer]\n')
  process.exit(2)
}
const text = readFileSync(bodyFile, 'utf8')
const client = new Client({ name: 'peertable-wakeup-deliver', version: '0.8.53' })
await client.connect(new StdioClientTransport({ command: 'aiterm-mcp', env: process.env }))
try {
  const result = mode === 'steer'
    ? await client.callTool({ name: 'agent_steer', arguments: { session_id: sessionId, text } })
    : await client.callTool({ name: 'pty_send', arguments: { session_id: sessionId, text, enter: true } })
  if (result.isError) {
    process.stderr.write(`${result.content?.[0]?.text ?? 'AITERM_DELIVER_FAILED'}\n`)
    process.exit(1)
  }
  const receipt = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? '{}')
  // aiterm の契約: dispatch は投げっぱなしでよいが、完了（Stop）は receipt の wait_process で回収する。
  // Claude 席は前の匿名 turn の Stop を回収しない限り次の dispatch が「Claude turn が未解決」で拒否される
  // （実測 2026-09-04: 監査席への 2 通目以降が全部失敗し、監査提出が 10 分読まれなかった）。
  // ここで wait_process を切り離して起動し、bridge は待たない。
  const wp = receipt?.wait_process
  if (wp && typeof wp.executable === 'string' && Array.isArray(wp.args)) {
    spawn(wp.executable, wp.args, { detached: true, stdio: 'ignore', env: process.env }).unref()
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
} finally {
  await client.close()
}
