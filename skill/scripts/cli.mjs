#!/usr/bin/env node
// npmが公開するPeertable操作入口。
import { skillCommand } from './install-skill.mjs'
import { setupProject, resumeProject } from './project-runtime.mjs'
import { launchSeat } from './launch-seat.mjs'
import { leaveSeat } from './leave-seat.mjs'
import { diagnoseProject } from './doctor.mjs'
import { teardownProject } from './teardown.mjs'
import { changeSeat } from './change-seat.mjs'
import { connectCommand } from './parent-connect.mjs'

function projectOptions(args, { seat = false } = {}) {
  const options = { project: args[0], phases: [] }
  let index = 1
  if (seat) options.name = args[index++]
  const names = { '--room': 'room', '--url': 'url', '--tasks': 'tasks', '--plan': 'plan',
    '--roles': 'roles', '--mission': 'mission', '--model': 'model', '--effort': 'effort', '--harness': 'harness', '--vendor': 'harness', '--brief': 'brief', '--parent': 'parent', '--reason': 'reason' }
  for (; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--json') continue
    if (arg === '--no-probe') { options.probe = false; continue }
    if (arg === '--repair') { options.repair = true; continue }
    if (arg === '--purge') { options.purge = true; continue }
    if (arg === '--archive') { options.purge = false; continue }
    const key = names[arg]
    if (!key && arg !== '--phase') throw new Error(`未対応の引数: ${arg}`)
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`${arg}の値を指定してください`)
    if (arg === '--phase') options.phases.push(value)
    else options[key] = value
  }
  return options
}

const [command, ...args] = process.argv.slice(2)
try {
  if (command === 'connect') {
    const result = await connectCommand(args)
    console.log(JSON.stringify(result))
    if (result.status === 'failed') process.exitCode = 1
  } else if (command === 'install') {
    const result = skillCommand(args)
    console.log(JSON.stringify(result))
    if (args.includes('--check') && result.status !== 'ready') process.exitCode = 1
  } else if (command === 'diagnostics') {
    const result = args[0] && !args[0].startsWith('--')
      ? await diagnoseProject(projectOptions(args)) : skillCommand(['--check', ...args])
    console.log(JSON.stringify(result))
    if (result.status !== 'ready') process.exitCode = 1
  } else if (command === 'setup' || command === 'resume') {
    const result = await (command === 'setup' ? setupProject : resumeProject)(projectOptions(args))
    console.log(JSON.stringify(result))
    if (result.status !== 'ready') process.exitCode = 1
  } else if (command === 'launch') {
    console.log(JSON.stringify(await launchSeat(projectOptions(args, { seat: true }))))
  } else if (command === 'change') {
    console.log(JSON.stringify(await changeSeat(projectOptions(args, { seat: true }))))
  } else if (command === 'leave') {
    if (args.length !== 2) throw new Error('leaveにはprojectと席名を指定してください')
    console.log(JSON.stringify(await leaveSeat(args[0], args[1])))
  } else if (command === 'teardown') {
    console.log(JSON.stringify(await teardownProject(projectOptions(args))))
  } else if (!command || ['--help', '-h', 'help'].includes(command)) {
    console.log(`Peertable
  peertable install [--target claude|codex|grok|cursor] [--json]
  peertable connect [--target claude|codex|grok|cursor] [--remove] [--json]
  peertable diagnostics [--target claude|codex|grok|cursor] [--json]
  peertable diagnostics <project> [--repair]
  peertable setup <project> --room <room> --url <URL> --tasks <file>
  peertable setup <project> --room <room> --url <URL> --plan <plan> [--phase <id>]
  peertable resume <project> [--plan <plan>] [--phase <id>] [--no-probe]
  peertable launch <project> <name> --roles <roles> --model <model> --effort <effort> [--harness <harness>] [--brief <text>]
  peertable leave <project> <name>
  peertable change <project> <name> [--harness <harness>] [--model <model>] [--effort <effort>]
  peertable teardown <project> [--purge]

installはskillを配置・更新します。対象AIは既存のホームディレクトリから検出します。
setup/resumeは明示したprojectの生成物とruntimeを更新し、実動作を確認します。`)
  } else {
    throw Object.assign(new Error(`未対応のコマンド: ${command}`), { code: 'PEERTABLE_COMMAND_UNKNOWN' })
  }
} catch (error) {
  console.error(JSON.stringify({ schema: 'peertable.error.v1', code: error.code ?? 'PEERTABLE_COMMAND_FAILED', message: error.message, ...(error.result ? { result: error.result } : {}) }))
  process.exitCode = 1
}
