// 専用runの中断だけを所有する。待機を捨てず、回収用の待機にはsignalを渡さない。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
export const interruption = reason => Object.assign(new Error('専用lease runを中断しました'), { code: 'ACCEPTANCE_LEASE_INTERRUPTED', detail: reason })
export function checkCancellation(signal) { if (signal?.aborted) throw signal.reason?.code ? signal.reason : interruption(String(signal.reason ?? 'abort')) }

export function waitDelay(ms, signal) {
  checkCancellation(signal)
  return new Promise((resolveWait, reject) => {
    const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolveWait() }
    const abort = () => { try { checkCancellation(signal) } catch (error) { finish(error) } }
    const timer = setTimeout(() => finish(), ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
export async function waitUntil(label, probe, ms = 300000, every = 1000, { signal, timeoutCode = 'ACCEPTANCE_TIMEOUT' } = {}) {
  const end = Date.now() + ms
  for (;;) { checkCancellation(signal); const value = await probe(); checkCancellation(signal); if (value) return value; if (Date.now() >= end) fail(timeoutCode, label); await waitDelay(Math.min(every, Math.max(1, end - Date.now())), signal) }
}

const read = file => JSON.parse(readFileSync(file, 'utf8'))
const same = (a, b) => a && b && a.pid === b.pid && a.started === b.started

export function createLeaseCancellation({ out, pkg, runner, platform, signal, signals = process.platform !== 'win32' }) {
  const directory = join(resolve(out), 'private'); mkdirSync(directory, { recursive: true, mode: 0o700 })
  const descriptorFile = join(directory, 'lease-control.json'), requestFile = join(directory, 'lease-stop-request.json')
  // 過去runのsummary/制御記録を上書きしない。停止要求も同じrun UUIDに限定する。
  if (existsSync(descriptorFile)) fail('ACCEPTANCE_LEASE_OUTPUT_ALREADY_USED', descriptorFile)
  const owner = platform.processIdentity(process.pid)
  if (!owner || !platform.sameProcess(owner)) fail('ACCEPTANCE_LEASE_OWNER_MISSING', 'lease controller本人を確認できません')
  const descriptor = { schema: 'peertable.lease-control.v1', run_id: randomUUID(), request_token: randomUUID(), owner, pkg: resolve(pkg), out: resolve(out), runner, request_file: requestFile, started_at: new Date().toISOString() }
  writeFileSync(descriptorFile, JSON.stringify(descriptor, null, 2), { flag: 'wx', mode: 0o600 })
  const controller = new AbortController(), abort = reason => { if (!controller.signal.aborted) controller.abort(interruption(reason)) }
  const linked = () => abort({ source: 'caller_signal', reason: String(signal.reason ?? 'abort') })
  signal?.addEventListener('abort', linked, { once: true }); if (signal?.aborted) linked()
  const signalHandlers = signals ? ['SIGTERM', 'SIGINT'].map(name => { const handler = () => abort({ source: 'posix_signal', signal: name }); process.on(name, handler); return [name, handler] }) : []
  const timer = setInterval(() => {
    if (!existsSync(requestFile) || controller.signal.aborted) return
    try {
      const request = read(requestFile)
      if (request.schema !== 'peertable.lease-stop-request.v1' || request.run_id !== descriptor.run_id || request.request_token !== descriptor.request_token || !same(request.owner, owner)) fail('ACCEPTANCE_LEASE_STOP_OWNER_MISMATCH', '停止要求のrun/本人が一致しません')
      abort({ source: 'request_file', request_id: request.request_id, requested_at: request.requested_at })
    } catch (error) { controller.abort(error) }
  }, 100)
  return { signal: controller.signal, descriptor, descriptor_file: descriptorFile, close() { clearInterval(timer); signal?.removeEventListener('abort', linked); for (const [name, handler] of signalHandlers) process.removeListener(name, handler) } }
}

// stop入口は自己runの要求→finished summary→保存した本人の実消失まで1回で確認する。
export async function requestLeaseStop({ out, runner, platform, timeout = 180000 }) {
  const root = resolve(out), descriptor = read(join(root, 'private/lease-control.json'))
  if (descriptor.schema !== 'peertable.lease-control.v1' || descriptor.out !== root || descriptor.request_file !== join(root, 'private/lease-stop-request.json') || descriptor.runner.commit !== runner.commit) fail('ACCEPTANCE_LEASE_STOP_OWNER_MISMATCH', '専用runのpath/controllerが一致しません')
  const summaryFile = join(root, 'summary.json')
  const finished = () => {
    if (!existsSync(summaryFile)) return null
    const summary = read(summaryFile)
    if (summary.run_id !== descriptor.run_id || !same(summary.owner, descriptor.owner)) fail('ACCEPTANCE_LEASE_STOP_OWNER_MISMATCH', 'summaryのrun/本人が一致しません')
    return summary.finished_at ? summary : null
  }
  let summary = finished()
  if (!summary) {
    if (!platform.sameProcess(descriptor.owner)) fail('ACCEPTANCE_LEASE_STOP_CONTROLLER_GONE', 'finished summaryのないrunは既に終了しています')
    platform.atomicJson(descriptor.request_file, { schema: 'peertable.lease-stop-request.v1', run_id: descriptor.run_id, request_token: descriptor.request_token, owner: descriptor.owner, request_id: randomUUID(), requested_at: new Date().toISOString() })
    summary = await waitUntil('専用leaseの中断と回収完了', finished, timeout, 100, { timeoutCode: 'ACCEPTANCE_LEASE_STOP_TIMEOUT' })
  }
  await waitUntil('専用lease controller本人の実終了', () => !platform.sameProcess(descriptor.owner), timeout, 100, { timeoutCode: 'ACCEPTANCE_LEASE_STOP_TIMEOUT' })
  if (summary.status !== 'failed' || !summary.errors?.some(error => error.code === 'ACCEPTANCE_LEASE_INTERRUPTED') || summary.cleanup?.status !== 'passed' || summary.cases.length) fail('ACCEPTANCE_LEASE_STOP_RESULT_INVALID', '中断failure/回収完了/成功成績0が揃いません')
  return { schema: 'peertable.lease-stop-result.v1', run_id: descriptor.run_id, status: 'stopped', finished_at: summary.finished_at, controller_gone: true, cleanup: summary.cleanup, errors: summary.errors }
}

export async function finishLeaseExecution({ summary, signal, prepare, execute, cleanup, save }) {
  const errors = []; let value, preparationCleanup
  try { checkCancellation(signal); const context = await prepare(); checkCancellation(signal); value = await execute(context); checkCancellation(signal) }
  catch (error) { preparationCleanup = error.cleanup; errors.push({ code: error.code ?? 'ACCEPTANCE_LEASE_RUN_FAILED', message: error.message, detail: error.detail }) }
  finally {
    summary.current_boundary = 'cleanup'
    try { save() } catch (error) { errors.push({ code: error.code ?? 'ACCEPTANCE_LEASE_SUMMARY_WRITE_FAILED', message: error.message }) }
    try { summary.cleanup = { ...await cleanup(), status: preparationCleanup?.status === 'failed' ? 'failed' : 'passed', ...(preparationCleanup ? { preparation: preparationCleanup } : {}) } }
    catch (error) { summary.cleanup = { status: 'failed' }; errors.push({ code: error.code ?? 'ACCEPTANCE_LEASE_CLEANUP_FAILED', message: error.message }) }
    // cleanup途中の中断も成功にしない。cleanup自体はsignalで打ち切らない。
    if (signal?.aborted && !errors.some(error => error.code === 'ACCEPTANCE_LEASE_INTERRUPTED')) { const error = interruption(signal.reason?.detail ?? String(signal.reason)); errors.push({ code: error.code, message: error.message, detail: error.detail }) }
    summary.status = errors.length ? 'failed' : 'passed'; summary.errors = errors; summary.finished_at = new Date().toISOString(); save()
  }
  return { summary, value }
}

// ChildProcessを所有する呼出し元だけが使う。exit待機のtimer/listenerは両経路で必ず撤去する。
export async function closeOwnedChild(child, ms = 10000) {
  if (child.exitCode !== null || child.signalCode !== null) return { pid: child.pid, exited: true, code: child.exitCode, signal: child.signalCode }
  await new Promise((resolveExit, reject) => {
    const exit = () => { clearTimeout(timer); child.removeListener('exit', exit); resolveExit() }
    const timer = setTimeout(() => { child.removeListener('exit', exit); reject(Object.assign(new Error('所有room processが終了しません'), { code: 'ACCEPTANCE_LEASE_ROOM_ALIVE' })) }, ms)
    child.once('exit', exit); child.kill('SIGTERM')
  })
  return { pid: child.pid, exited: true, code: child.exitCode, signal: child.signalCode }
}
