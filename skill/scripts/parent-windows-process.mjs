// Windows標準APIで本人存命だけを確認する。parent/exe/commandの取得はCIMが所有する。
// 1回のOpenProcessで得たhandleから「開始時刻」と「存命」を同時に読むので、PID再利用の照会間隙が無い。
import { createRequire } from 'node:module'

const QUERY_LIMITED_INFORMATION = 0x1000, SYNCHRONIZE = 0x100000
const WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 0x102, WAIT_FAILED = 0xffffffff
const ERROR_ACCESS_DENIED = 5, ERROR_INVALID_PARAMETER = 87
const EPOCH_DIFF_100NS = 116444736000000000n // 1601-01-01 → 1970-01-01

let api
function windowsApi() {
  if (api) return api
  const koffi = createRequire(import.meta.url)('koffi')
  const kernel = koffi.load('kernel32.dll')
  api = {
    open: kernel.func('intptr_t __stdcall OpenProcess(uint32_t access, int32_t inherit, uint32_t pid)'),
    times: kernel.func('int32_t __stdcall GetProcessTimes(intptr_t process, void *creation, void *exit, void *kernel, void *user)'),
    wait: kernel.func('uint32_t __stdcall WaitForSingleObject(intptr_t handle, uint32_t milliseconds)'),
    close: kernel.func('int32_t __stdcall CloseHandle(intptr_t handle)'),
    error: kernel.func('uint32_t __stdcall GetLastError()'),
  }
  return api
}
const failure = (code, detail, extra = {}) => Object.assign(new Error(detail), { code, ...extra })

// FILETIME(100ns, 1601起点) → 製品が永続する形式(.NET 'o'、UTC、7桁)。CIM CreationDateの粒度(1µs、切捨て)に揃える。
export function startedFromFileTime(filetime) {
  const truncated = filetime - (filetime % 10n)
  const seconds = truncated / 10000000n - EPOCH_DIFF_100NS / 10000000n
  const fraction = String(truncated % 10000000n).padStart(7, '0')
  return `${new Date(Number(seconds * 1000n)).toISOString().slice(0, 19)}.${fraction}Z`
}

// 戻り値: { alive: false } | { alive: true, started }。判定できない失敗は退避せずtyped errorにする。
export function windowsProcessState(pid, native = windowsApi()) {
  const handle = native.open(QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, Number(pid))
  if (!handle) {
    const error = native.error()
    if (error === ERROR_INVALID_PARAMETER) return { alive: false } // 該当PIDのprocess objectが無い
    throw failure(error === ERROR_ACCESS_DENIED ? 'PARENT_PROCESS_ACCESS_DENIED' : 'PARENT_PROCESS_API_FAILED', `OpenProcess PID ${pid}: Windows error ${error}`, { win32_error: error })
  }
  let result, operationError, closeError
  try {
    const creation = Buffer.alloc(8)
    if (!native.times(handle, creation, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) { const error = native.error(); throw failure('PARENT_PROCESS_API_FAILED', `GetProcessTimes PID ${pid}: Windows error ${error}`, { win32_error: error }) }
    const waited = native.wait(handle, 0)
    if (waited === WAIT_FAILED) { const error = native.error(); throw failure('PARENT_PROCESS_API_FAILED', `WaitForSingleObject PID ${pid}: Windows error ${error}`, { win32_error: error }) }
    result = waited === WAIT_TIMEOUT ? { alive: true, started: startedFromFileTime(creation.readBigUInt64LE(0)) } : { alive: false }
    if (waited !== WAIT_TIMEOUT && waited !== WAIT_OBJECT_0) throw failure('PARENT_PROCESS_API_FAILED', `WaitForSingleObject PID ${pid}: unexpected ${waited}`)
  } catch (error) { operationError = error } finally {
    if (!native.close(handle)) closeError = native.error()
  }
  if (closeError !== undefined) throw failure('PARENT_PROCESS_API_FAILED', `CloseHandle PID ${pid}: Windows error ${closeError}`, { win32_error: closeError, cause: operationError })
  if (operationError) throw operationError
  return result
}
export const sameWindowsProcess = (owner, native) => {
  if (!Number.isSafeInteger(Number(owner.pid)) || Number(owner.pid) <= 0) throw failure('PARENT_PROCESS_ID_INVALID', 'PIDが正の整数ではありません')
  const state = windowsProcessState(owner.pid, native)
  return state.alive && state.started === owner.started
}
