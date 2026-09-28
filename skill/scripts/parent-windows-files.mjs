// Windows標準APIで、読取り中の旧fileを保ったまま名前をatomicに置換する。
import { createRequire } from 'node:module'
import { resolve, toNamespacedPath } from 'node:path'

let api
function windowsApi() {
  if (api) return api
  const koffi = createRequire(import.meta.url)('koffi')
  const kernel = koffi.load('kernel32.dll')
  api = {
    pointerBytes: koffi.sizeof('void *'),
    open: kernel.func('intptr_t __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, intptr_t templateFile)'),
    rename: kernel.func('int32_t __stdcall SetFileInformationByHandle(intptr_t file, int32_t infoClass, const void *info, uint32_t size)'),
    close: kernel.func('int32_t __stdcall CloseHandle(intptr_t file)'),
    error: kernel.func('uint32_t __stdcall GetLastError()'),
  }
  return api
}
const windowsFailure = (operation, error, source, destination) => Object.assign(
  new Error(`${operation}: Windows error ${error}: ${source} → ${destination}`),
  { code: 'PARENT_ATOMIC_REPLACE_FAILED', operation, win32_error: error, path: source, dest: destination },
)
export function replaceWindowsFile(source, destination) {
  const native = windowsApi()
  // DELETE権限、共有READ|WRITE|DELETE、OPEN_EXISTING。既に書き終えた自分のtempを開く。
  const handle = native.open(toNamespacedPath(resolve(source)), 0x10000, 7, null, 3, 0, 0)
  if (handle === -1 || handle === -1n) throw windowsFailure('CreateFileW', native.error(), source, destination)
  let renameError, closeError
  try {
    const name = Buffer.from(toNamespacedPath(resolve(destination)), 'utf16le')
    const lengthOffset = native.pointerBytes * 2, nameOffset = lengthOffset + 4
    const info = Buffer.alloc(nameOffset + name.length + 2)
    // FILE_RENAME_INFO: union Flags、pointer境界へ整列したRootDirectory、長さ、UTF-16名。
    info.writeUInt32LE(3, 0) // REPLACE_IF_EXISTS | POSIX_SEMANTICS
    info.writeUInt32LE(name.length, lengthOffset)
    name.copy(info, nameOffset)
    if (!native.rename(handle, 22, info, info.length)) renameError = native.error() // FileRenameInfoEx
  } finally {
    if (!native.close(handle)) closeError = native.error()
  }
  if (renameError !== undefined) throw windowsFailure('SetFileInformationByHandle', renameError, source, destination)
  if (closeError !== undefined) throw windowsFailure('CloseHandle', closeError, source, destination)
}
