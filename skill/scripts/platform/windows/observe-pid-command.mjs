import { execFileSync } from 'node:child_process'

export function parseWindowsCreationDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('pid の CreationDate を解釈できない')
    return value.toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  const text = String(value ?? '').trim()
  const microsoft = /^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/u.exec(text)
  if (microsoft) return new Date(Number(microsoft[1])).toISOString()
  const normalized = text.replace(/(\.\d{3})\d+(?=[+-]\d{2}:\d{2}$)/u, '$1')
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) throw new Error(`pid の CreationDate を解釈できない: ${text}`)
  return parsed.toISOString()
}

export function observeWindowsPidCommand(pid, hashArgv) {
  const filter = `ProcessId=${pid}`
  const script = `Get-CimInstance Win32_Process -Filter ${JSON.stringify(filter)} | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress`
  const output = execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  }).trim()
  if (!output) throw new Error('pid のWin32_Processを観測できない')
  const row = JSON.parse(output)
  const started = parseWindowsCreationDate(row.CreationDate)
  const argv = String(row.CommandLine || '').trim()
  if (!started || !argv) throw new Error('pid のCreationDate/CommandLineを観測できない')
  return { pid: Number(row.ProcessId), started_identity: started, argv, argv_digest: hashArgv(argv) }
}
