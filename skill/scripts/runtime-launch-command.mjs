// Peertableの常駐コマンドだけをOS標準shellの構文へ変換する。
// 永続PTYの作成・送信・終了・backend選択はAiterm公開APIが担当する。
export function runtimeLaunchCommand({ executable, script, project, args = [], log, env = {}, platform = process.platform }) {
  const names = ['PEERTABLE_CREDENTIAL_FILE', 'PEERTABLE_URL', 'PEERTABLE_PARENT_NAME']
  if (platform === 'win32') {
    const quote = value => `'${String(value).replaceAll("'", "''")}'`
    return [
      '$utf8 = [System.Text.UTF8Encoding]::new($false)',
      '[Console]::OutputEncoding = $utf8', '$OutputEncoding = $utf8',
      'Remove-Item Env:PEERTABLE_POST_TOKEN -ErrorAction SilentlyContinue',
      ...names.filter(name => env[name]).map(name => `$env:${name} = ${quote(env[name])}`),
      `Set-Location -LiteralPath ${quote(project)}`,
      `& ${[executable, script, project, ...args].map(quote).join(' ')} 2>&1 | Out-File -FilePath ${quote(log)} -Encoding utf8 -Append`,
    ].join('; ')
  }
  if (!['darwin', 'linux'].includes(platform)) throw Object.assign(new Error(`未対応OS: ${platform}`), { code: 'PEERTABLE_PLATFORM_UNSUPPORTED' })
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
  return `cd ${quote(project)} && exec env -u PEERTABLE_POST_TOKEN ${names.filter(name => env[name]).map(name => `${name}=${quote(env[name])}`).join(' ')} ${[executable, script, project, ...args].map(quote).join(' ')} >> ${quote(log)} 2>&1`
}
