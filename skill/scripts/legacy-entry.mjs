#!/usr/bin/env node
// 既存のshell入口は引数だけを翻訳し、処理順序を共通CLIへ集める。
const [entry, ...args] = process.argv.slice(2)
let command = entry
let translated = args
if (entry === 'setup') {
  const [project, room, url, plan, _legacyRoot, ...tail] = args
  translated = [project, '--room', room, '--url', url]
  if (plan && plan !== '-') translated.push('--plan', plan)
  if (tail[0] && !tail[0].startsWith('--')) {
    const tasks = tail.shift()
    if (tasks !== '-') translated.push('--tasks', tasks)
  }
  translated.push(...tail)
} else if (entry === 'launch-seat') {
  command = 'launch'
  const [project, name, ...tail] = args
  translated = [project, name]
  let roles = false
  while (tail.length) {
    const arg = tail.shift()
    if (arg.startsWith('--')) {
      const value = tail.shift()
      translated.push(arg, value)
      if (arg === '--roles') roles = true
    } else if (!roles) { translated.push('--roles', arg); roles = true }
    else translated.push('--brief', arg)
  }
} else if (entry === 'leave-seat') command = 'leave'
else if (entry === 'change-seat') command = 'change'
else if (entry === 'doctor') command = 'diagnostics'
process.argv = [process.execPath, new URL('./cli.mjs', import.meta.url).pathname, command, ...translated]
await import('./cli.mjs')
