// 通常HOME・公式認証・user設定を共有し、試験projectと公式session指定だけを所有する。
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { openAiterm } from './aiterm.mjs'
import { startupAction, readTranscript, transcriptPath } from './harness.mjs'
import { parseDelivered, sha256 } from './evidence.mjs'
import { nativeInvocation, resolveOfficialCli } from './scenarios-surfaces.mjs'

const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (label, probe, ms = 180000, interval = 250) => { const end = Date.now() + ms; for (;;) { const value = await probe(); if (value) return value; if (Date.now() >= end) fail('ACCEPTANCE_FIXTURE_TIMEOUT', label); await sleep(interval) } }
const contained = (root, file) => { const path = relative(realpathSync(root), file); return path !== '' && !path.startsWith('..') && !isAbsolute(path) }
const writeJson = (file, value) => { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }) }

// observer本人が起動時identityを保存する。終了後にPIDだけから本人を取り直さない。
export function nativeHookObserverSource(platformEntry) {
  return `import {processIdentity} from ${JSON.stringify(platformEntry)};import {readFileSync,appendFileSync,existsSync} from 'node:fs';const owner=processIdentity(process.pid);let raw='';for await(const chunk of process.stdin)raw+=chunk;const event=JSON.parse(raw.replace(/^\\uFEFF/u,''));const control=existsSync(process.argv[3])?JSON.parse(readFileSync(process.argv[3],'utf8')):null;const name=event.tool_name??event.toolName??'';const operation=/parent_(join|read|leave)$/.exec(name)?.[0];const held=Boolean(control?.hold&&(!control.onlyTool||operation===control.onlyTool)&&(!control.onlyEvent||event.hook_event_name===control.onlyEvent));appendFileSync(process.argv[2],JSON.stringify({at:new Date().toISOString(),pid:process.pid,owner,event,held,control_release:held?control.release:null})+'\\n');if(held)while(!existsSync(control.release))await new Promise(r=>setTimeout(r,25));process.stdout.write('{}\\n');\n`
}

// Grokの直列gateで製品prehookの完了後にだけ待つ。共有global hookには触れない。
export function appendGrokProductObserver(value, event, observer) {
  if (value.hooks[event]?.length !== 1 || value.hooks[event][0].hooks?.length !== 1) fail('ACCEPTANCE_PROJECT_PREHOOK_ORDER_UNCONFIRMED', '専用Grok製品handler 1個の直後へobserverを追加できません')
  value.hooks[event][0].hooks.push(observer)
  return value
}

// 専用診断artifactへOS原応答を残し、process APIの失敗自体は伝播する。
export function observeFixtureProcessIdentity(platform, pid, directory) {
  try { return platform.processIdentity(pid) }
  catch (error) {
    const sample = (executable, argv) => { try { return { executable, argv, code: 0, stdout: execFileSync(executable, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } } catch (probe) { return { executable, argv, code: probe.status ?? null, stdout: probe.stdout?.toString() ?? '', stderr: probe.stderr?.toString() ?? '', error_code: probe.code } } }
    const artifact = join(directory, `process-identity-failed-${pid}-${Date.now()}.json`)
    const responses = process.platform === 'darwin' ? [sample('/bin/ps', ['-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'lstart=', '-o', 'command=']), sample('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'])] : []
    writeJson(artifact, { at: new Date().toISOString(), pid, error: { code: error.code, message: error.message, stack: error.stack }, responses })
    error.detail = { ...error.detail, pid, artifact }; throw error
  }
}

// 背景taskの実登録入力と、完了後の公式reader入力は別々に固定する。
export function fixtureJoinInstruction({ harness, project, name }) {
  const common = `Peertable parent_joinをproject=${project} name=${name}で1回呼んでください。同じ会話のroom配送の確認符号を原文のまま報告し、受信を継続してください。`
  if (!['cursor', 'grok'].includes(harness)) return common
  const registration = '製品receipt wait_process.native_tool.inputの完成済み入力を、指定されたnative背景toolへそのまま渡してください。taskの完了前に出力readerやparent_readで先取りしないでください。'
  const read = harness === 'grok'
    ? '公式task_completedで示された同じtask_idだけをget_command_or_subagent_outputのtask_ids配列に入れて全量を読みます。入力はtask_idsの1キーだけです。timeout_msキーは付けず、0も不可です。truncated:falseとcompletedを確認した公式全文readerの結果にdelivery_idがある場合だけ、そのIDをparent_readへ渡してください。'
    : '同じShell taskの背景完了後、公式Shellが示す同taskの出力fileを公式Readで全文読みます。offset/limitを付けず、他taskのfileを読みません。その全文出力のdelivery_idをparent_readへ渡してください。'
  return common + registration + read + 'continuation_tokenがある間は同じ配送のparent_readを完了まで続けます。その結果の次wait_processも同じ完成入力で登録してください。'
}

// 共有設定fileを書かず、公式--settingsを次の自己CLI runへ渡す。同じ実会話をresumeする。
export async function setClaudeSessionHookFault(fixture, disabled) {
  if (fixture.harness !== 'claude' || !fixture.session) fail('ACCEPTANCE_CLAUDE_SESSION_FAULT_UNBOUND', '既知の専用Claude会話が必要です')
  const session = fixture.session
  fixture.configuration.assertHooksUnchanged()
  if (disabled && !fixture.claudeHookFault) fixture.claudeHookFault = { session, originalSettings: fixture.sessionSettings }
  if (!disabled && !fixture.claudeHookFault) fail('ACCEPTANCE_CLAUDE_SESSION_FAULT_MISSING', '復元対象の私物session設定がありません')
  await fixture.stopOwnPane()
  fixture.sessionSettings = disabled ? { ...(fixture.claudeHookFault.originalSettings ?? {}), disableAllHooks: true } : fixture.claudeHookFault.originalSettings
  await fixture.launch({ resume: session })
  fixture.configuration.assertHooksUnchanged()
  if (!disabled) fixture.claudeHookFault = null
  return { fault: disabled ? 'disabled' : 'restored', parent_session: session, official_option: '--settings', session_settings: fixture.sessionSettings, global_sourcePath: fixture.configuration.hooks, normal_hook_bytes_equal: true, global_changed: false, official_source: 'https://code.claude.com/docs/en/hooks#disable-or-remove-hooks' }
}

export function hookConfigurationSnapshot(hooks) {
  const beforeBytes = existsSync(hooks) ? readFileSync(hooks) : null
  const beforeHooks = beforeBytes ? JSON.parse(beforeBytes.toString('utf8').replace(/^\uFEFF/u, '')) : null
  return { hooks, beforeHooks, beforeBytes, assertHooksUnchanged() { const after = existsSync(hooks) ? readFileSync(hooks) : null; if (Boolean(after) !== Boolean(beforeBytes) || (after && !after.equals(beforeBytes))) fail('ACCEPTANCE_USER_HOOK_CONFIG_CHANGED', hooks) } }
}

// 関連する通常設定の読取りだけ。認証保存物は開かず、harness自身へ任せる。
export function ordinaryConfiguration(harness) {
  const home = homedir()
  const config = harness === 'codex' ? process.env.CODEX_HOME ?? join(home, '.codex') : harness === 'claude' ? process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude') : harness === 'cursor' ? process.env.CURSOR_HOME ?? join(home, '.cursor') : join(home, '.grok')
  const hooks = join(config, harness === 'claude' ? 'settings.json' : harness === 'grok' ? 'hooks/peertable-parent.json' : 'hooks.json')
  return { home, config, ...hookConfigurationSnapshot(hooks) }
}

// 親終了直後の中間状態で失敗にしない。製品による自己停止と索引撤去を実際に待つ。
export async function waitOwnedFixtureExit({ readEndpoints, sameProcess, knownOwners = [], indexExists, timeout = 30000 }) {
  const final = await until('own親/process/索引の製品自己撤去', () => {
    const endpoints = readEndpoints(), states = endpoints.map(endpoint => ({ id: endpoint.id, state: endpoint.read() }))
    const alive = [...knownOwners, ...states.flatMap(item => [item.state.caller?.owner, item.state.watcher, item.state.waiter?.owner].filter(Boolean))].filter(owner => sameProcess(owner))
    return !alive.length && states.every(item => item.state.runtime === 'stopped' && !indexExists(item.id)) ? { endpoints: states.map(item => ({ id: item.id, runtime: item.state.runtime })), known_processes_gone: true, indexes_gone: true } : null
  }, timeout, 100)
  return final
}

export function assertOnlyProjectTrustChanged(before, after, project, { remove = false } = {}) {
  const expected = structuredClone(before)
  if (remove) { if (!expected.projects?.[project]) fail('ACCEPTANCE_PROJECT_TRUST_BASELINE_MISSING', project); delete expected.projects[project]; if (!Object.keys(expected.projects).length) delete expected.projects }
  else { if (expected.projects?.[project]) fail('ACCEPTANCE_PROJECT_TRUST_ALREADY_PRESENT', project); expected.projects ??= {}; expected.projects[project] = { trust_level: 'trusted' } }
  if (!isDeepStrictEqual(expected, after)) fail('ACCEPTANCE_PROJECT_TRUST_OTHER_SETTINGS_CHANGED', '専用project trust以外の実効設定が変わりました')
}

export async function createNativeFixtureFactory({ pkg, out, tokenFile, serverUrl, sourceMeta, apiFor, model, surfaceAdapters = {} }) {
  if (!apiFor) {
    const token = /^PEERTABLE_POST_TOKEN=(.+)$/mu.exec(readFileSync(tokenFile, 'utf8'))?.[1]
    if (!token) fail('ACCEPTANCE_FIXTURE_ROOM_TOKEN_MISSING', '試験roomのtoken参照を確認できません')
    apiFor = room => async (path, body) => { const response = await fetch(`${serverUrl}/api/${encodeURIComponent(room)}/${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Peertable-Token': token }, body: body ? JSON.stringify(body) : undefined }); if (!response.ok) fail('ACCEPTANCE_FIXTURE_ROOM_HTTP', `${path}:${response.status}`); return response.json() }
  }
  const fixtures = new Set(), platform = await import(pathToFileURL(join(pkg, 'skill/scripts/parent-platform.mjs')).href)
  const { projectEndpoints } = await import(pathToFileURL(join(pkg, 'skill/scripts/parent-runtime.mjs')).href)
  const { ownsParentConnection } = await import(pathToFileURL(join(pkg, 'skill/scripts/parent-connect.mjs')).href)
  const { codexConnection } = await import(pathToFileURL(join(pkg, 'skill/scripts/parent-receivers/codex.mjs')).href)
  const root = join(out, 'native-fixtures'); mkdirSync(root, { recursive: true, mode: 0o700 })
  return {
    api: room => apiFor(room),
    async open({ harness = sourceMeta.harness, room = sourceMeta.room, name = `fixture-${randomUUID().slice(0, 8)}`, initialJoin = true, sessionSettings = null, prepare } = {}) {
      const directory = join(root, `${harness}-${randomUUID()}`); mkdirSync(directory, { recursive: true, mode: 0o700 })
      const project = join(directory, 'project'); mkdirSync(join(project, '.team'), { recursive: true, mode: 0o700 }); writeJson(join(project, '.team/setup-state.json'), { room, server_url: serverUrl, mode: 'adhoc' })
      const configuration = ordinaryConfiguration(harness)
      if (['claude', 'codex'].includes(harness) && !ownsParentConnection(harness)) fail('ACCEPTANCE_FIXTURE_PARENT_NOT_CONNECTED', '通常設定のPeertable所有登録が必要です。fixtureはglobal登録を変更しません')
      let adapter = surfaceAdapters[harness] ?? (['claude', 'codex'].includes(harness) ? { resolveCli: () => resolveOfficialCli(harness, platform), startup: view => startupAction(harness, view), transcript: session => transcriptPath(harness, session), read: file => readTranscript(harness, file) } : null)
      const fixture = { directory, project, configuration, pkg, harness, name, room, pty: null, aiterm: null, target: null, session: null, owner: null, paneOwner: null, nativeOwners: [], receiverOwners: [], ready: false, backups: new Map(), closed: false, observations: [], sessionSettings, adapter }
      if (adapter?.bind) adapter = adapter.bind(fixture)
      fixture.adapter = adapter
      if (!adapter?.resolveCli || !adapter.startup || !adapter.transcript || !adapter.read) fail('ACCEPTANCE_OFFICIAL_SURFACE_BOUNDARY_UNCONFIRMED', `${harness}: 公式task/transcriptの実測adapterが必要です`)
      fixture.identityArtifact = join(directory, 'native-process-identity.json')
      fixture.trackOwnProcesses = async () => {
        if (!fixture.pty) return
        const pane = await fixture.aiterm.observe(fixture.pty)
        if (pane.pane_process?.pid && !fixture.paneOwner) fixture.paneOwner = observeFixtureProcessIdentity(platform, pane.pane_process.pid, directory)
        for (const endpoint of projectEndpoints(project)) {
          const state = endpoint.read()
          if (state.caller?.owner && platform.sameProcess(state.caller.owner)) { fixture.owner = state.caller.owner; if (!fixture.nativeOwners.some(owner => owner.pid === state.caller.owner.pid && owner.started === state.caller.owner.started)) fixture.nativeOwners.push(state.caller.owner) }
          for (const owner of [state.watcher, state.waiter?.owner].filter(Boolean)) if (!fixture.receiverOwners.some(item => item.pid === owner.pid && item.started === owner.started)) fixture.receiverOwners.push(owner)
        }
        if (!fixture.paneOwner || !platform.sameProcess(fixture.paneOwner)) return
        let rows
        if (process.platform === 'win32') {
          const raw = execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { encoding: 'utf8' })
          rows = JSON.parse(raw); if (!Array.isArray(rows)) rows = [rows]
          rows = rows.map(row => ({ pid: row.ProcessId, parent: row.ParentProcessId }))
        } else rows = execFileSync('/bin/ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' }).trim().split('\n').map(line => { const [pid, parent] = line.trim().split(/\s+/u).map(Number); return { pid, parent } })
        const descendants = new Set([fixture.paneOwner.pid]); let added = true
        while (added) { added = false; for (const row of rows) if (descendants.has(row.parent) && !descendants.has(row.pid)) { descendants.add(row.pid); added = true } }
        for (const pid of descendants) {
          const owner = observeFixtureProcessIdentity(platform, pid, directory)
          if (owner && platform.processHarness(owner) === harness && !fixture.nativeOwners.some(item => item.pid === owner.pid && item.started === owner.started)) { fixture.nativeOwners.push(owner); fixture.owner ??= owner }
        }
        writeJson(fixture.identityArtifact, { at: new Date().toISOString(), project, harness, pty: fixture.pty, pane: fixture.paneOwner, native: fixture.nativeOwners, receiver: fixture.receiverOwners })
      }
      fixture.rpc = async (method, params) => {
        if (harness !== 'codex') fail('ACCEPTANCE_FIXTURE_RPC_HARNESS', harness)
        const client = await codexConnection(project, { executable: fixture.owner?.executable ?? platform.resolveExecutable('codex'), codexHome: configuration.config })
        try { const value = await client.request(method, params); fixture.observations.push({ method, params, value, at: new Date().toISOString() }); return value } finally { await client.close() }
      }
      const userConfigRpc = async (method, params) => {
        const client = await codexConnection(configuration.config, { executable: platform.resolveExecutable('codex'), codexHome: configuration.config })
        try { return await client.request(method, params) } finally { await client.close() }
      }
      fixture.ensureProjectTrust = async () => {
        if (harness !== 'codex' || fixture.projectTrust) return
        const file = join(configuration.config, 'config.toml'), before = (await userConfigRpc('config/read', { includeLayers: false })).config
        if (before.projects?.[project]) fail('ACCEPTANCE_PROJECT_TRUST_ALREADY_PRESENT', project)
        const bytes = existsSync(file) ? readFileSync(file) : null, backup = join(directory, 'codex-config-before.tar')
        if (bytes) execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-cf', backup, file], { stdio: 'ignore' })
        fixture.projectTrust = { file, before, bytes, backup }
        await userConfigRpc('config/batchWrite', { filePath: file, edits: [{ keyPath: `projects.${JSON.stringify(project)}.trust_level`, value: 'trusted', mergeStrategy: 'replace' }] })
        const after = (await userConfigRpc('config/read', { includeLayers: false })).config
        assertOnlyProjectTrustChanged(before, after, project)
        fixture.observations.push({ method: 'config/batchWrite', own_project: project, action: 'temporary_project_trust', others_semantically_unchanged: true, backup })
      }
      fixture.removeProjectTrust = async () => {
        if (!fixture.projectTrust) return
        const baseline = fixture.projectTrust, current = (await userConfigRpc('config/read', { includeLayers: false })).config
        if (current.projects?.[project]) {
          await userConfigRpc('config/batchWrite', { filePath: baseline.file, edits: [{ keyPath: `projects.${JSON.stringify(project)}`, value: null, mergeStrategy: 'replace' }] })
          const after = (await userConfigRpc('config/read', { includeLayers: false })).config
          assertOnlyProjectTrustChanged(current, after, project, { remove: true })
        }
        const restored = (await userConfigRpc('config/read', { includeLayers: false })).config
        if (restored.projects?.[project] || !isDeepStrictEqual(restored, baseline.before)) fail('ACCEPTANCE_PROJECT_TRUST_NOT_RESTORED', 'own trust entry撤去後に他設定の意味差が残っています')
        const afterBytes = existsSync(baseline.file) ? readFileSync(baseline.file) : null
        if (Boolean(afterBytes) !== Boolean(baseline.bytes) || afterBytes && !afterBytes.equals(baseline.bytes)) fail('ACCEPTANCE_PROJECT_TRUST_TOML_TEXT_CHANGED', `公式API撤去後にTOML本文差が残っています: ${baseline.file}`)
        if (existsSync(baseline.backup)) rmSync(baseline.backup)
        fixture.observations.push({ method: 'config/batchWrite', own_project: project, action: 'temporary_project_trust_removed', others_semantically_unchanged: true, toml_bytes_equal: true })
        fixture.projectTrust = null
      }
      fixture.setClaudeOwnedHookFault = disabled => setClaudeSessionHookFault(fixture, disabled)
      fixture.modify = (file, mutate) => {
        if (!contained(project, file)) fail('ACCEPTANCE_FIXTURE_WRITE_OUTSIDE', file)
        if (existsSync(file) && realpathSync(file) !== file) fail('ACCEPTANCE_FIXTURE_LINK_WRITE', file)
        if (!fixture.backups.has(file)) fixture.backups.set(file, existsSync(file) ? readFileSync(file) : null)
        const value = existsSync(file) ? readFileSync(file) : null, next = mutate(value)
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
        if (next === null) rmSync(file); else writeFileSync(file, next, { mode: 0o600 })
        return { file, before_sha256: value && sha256(value), after_sha256: next && sha256(next) }
      }
      fixture.trustProjectHooks = async () => {
        if (harness !== 'codex') return
        await fixture.ensureProjectTrust()
        const listed = await fixture.rpc('hooks/list', { cwds: [project] }), owned = listed.data.flatMap(group => group.hooks ?? []).filter(hook => contained(project, hook.sourcePath))
        if (!owned.length) fail('ACCEPTANCE_PROJECT_HOOK_NOT_DISCOVERED', '公式hooks/listが試験projectのhookを返しません')
        const edits = owned.flatMap(hook => [{ keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: 'replace' }, { keyPath: `hooks.state.${JSON.stringify(hook.key)}.enabled`, value: true, mergeStrategy: 'replace' }])
        const localConfig = join(project, '.codex/config.toml'); mkdirSync(dirname(localConfig), { recursive: true })
        if (!fixture.backups.has(localConfig)) fixture.backups.set(localConfig, existsSync(localConfig) ? readFileSync(localConfig) : null)
        await fixture.rpc('config/batchWrite', { filePath: localConfig, edits })
        const after = (await fixture.rpc('hooks/list', { cwds: [project] })).data.flatMap(group => group.hooks ?? []).filter(hook => owned.some(item => item.key === hook.key))
        if (after.some(hook => !hook.enabled || hook.trustStatus !== 'trusted')) fail('ACCEPTANCE_PROJECT_HOOK_UNTRUSTED', JSON.stringify(after.map(hook => ({ sourcePath: hook.sourcePath, key: hook.key, trustStatus: hook.trustStatus, enabled: hook.enabled }))))
        configuration.assertHooksUnchanged(); return after
      }
      fixture.setCodexOwnedHookFault = async fault => {
        if (harness !== 'codex' || !['disabled', 'untrusted'].includes(fault)) fail('ACCEPTANCE_SESSION_HOOK_FAULT_UNCONFIRMED', `${harness}/${fault}`)
        if (fixture.hookFault) {
          const { local, original } = fixture.hookFault
          if (original === null) rmSync(local, { force: true }); else writeFileSync(local, original, { mode: 0o600 })
          fixture.hookFault = null
        }
        const before = (await fixture.rpc('hooks/list', { cwds: [project] })).data.flatMap(group => group.hooks ?? [])
        const command = platform.hookCommand(process.execPath, [join(pkg, 'skill/scripts/parent-hook.mjs'), 'codex'])
        const owned = before.filter(hook => hook.command === command && realpathSync(hook.sourcePath) === realpathSync(configuration.hooks))
        if (owned.length !== 2) fail('ACCEPTANCE_GLOBAL_OWNED_HOOK_UNBOUND', '通常sourcePathの所有hook 2個を確定できません')
        const local = join(project, '.codex/config.toml')
        if (!fixture.backups.has(local)) fixture.modify(local, bytes => bytes ?? Buffer.from(''))
        fixture.hookFault = { local, original: fixture.backups.get(local) }
        const edits = [{ keyPath: 'features.hooks', value: fault !== 'disabled', mergeStrategy: 'replace' }]
        if (fault === 'untrusted') for (const hook of owned) edits.push({ keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: '0'.repeat(64) === hook.currentHash ? '1'.repeat(64) : '0'.repeat(64), mergeStrategy: 'replace' }, { keyPath: `hooks.state.${JSON.stringify(hook.key)}.enabled`, value: true, mergeStrategy: 'replace' })
        await fixture.rpc('config/batchWrite', { filePath: local, edits })
        const after = (await fixture.rpc('hooks/list', { cwds: [project] })).data.flatMap(group => group.hooks ?? [])
        const affected = after.filter(hook => owned.some(entry => entry.key === hook.key))
        if (fault === 'disabled' ? affected.some(hook => hook.enabled !== false) : affected.length !== 2 || affected.some(hook => hook.trustStatus !== 'untrusted' || realpathSync(hook.sourcePath) !== realpathSync(configuration.hooks))) fail('ACCEPTANCE_SESSION_HOOK_FAULT_NOT_EFFECTIVE', `${fault}: 公式hooks/listで実効障害を確認できません`)
        if (fault === 'untrusted' && !isDeepStrictEqual(before.filter(hook => !owned.some(entry => entry.key === hook.key)), after.filter(hook => !owned.some(entry => entry.key === hook.key)))) fail('ACCEPTANCE_FOREIGN_HOOK_EFFECTIVE_CHANGED', '専用project内でも非所有hookの状態を変更しました')
        configuration.assertHooksUnchanged()
        return { fault, local_config: local, before: owned, after: affected, official_method: 'hooks/list', global_sourcePath: configuration.hooks, normal_hook_bytes_equal: true }
      }
      fixture.addObserver = async ({ events, additionalArgs = [], appendToProductFile = false } = {}) => {
        const observer = join(project, 'acceptance-hook.mjs'), observations = join(directory, 'official-hook-events.jsonl'), controls = join(directory, 'hook-controls.json')
        writeFileSync(observer, nativeHookObserverSource(pathToFileURL(join(pkg, 'skill/scripts/parent-platform.mjs')).href), { mode: 0o600 })
        const command = platform.hookCommand(process.execPath, [observer, observations, controls, ...additionalArgs])
        if (!['claude', 'codex'].includes(harness) && !adapter.projectHookFile) fail('ACCEPTANCE_PROJECT_HOOK_PATH_UNCONFIRMED', `${harness}: 公式のproject hook配置が実測されていません`)
        const file = harness === 'claude' ? join(project, '.claude/settings.local.json') : harness === 'codex' ? join(project, '.codex/hooks.json') : appendToProductFile && harness === 'grok' ? join(project, '.grok/hooks/peertable-parent.json') : adapter.projectHookFile(project)
        const nativeEvents = events ?? (harness === 'cursor' ? ['preToolUse', 'postToolUse', 'afterMCPExecution'] : ['PreToolUse', 'PostToolUse', 'Stop'])
        fixture.modify(file, before => {
          const value = before ? JSON.parse(before.toString('utf8').replace(/^\uFEFF/u, '')) : { ...(harness === 'cursor' ? { version: 1 } : {}), hooks: {} }
          for (const event of nativeEvents) {
            const entry = harness === 'cursor' ? { command, timeout: 86400 } : { hooks: [{ type: 'command', command, timeout: 86400 }] }
            if (appendToProductFile) {
              if (harness !== 'grok') fail('ACCEPTANCE_PROJECT_PREHOOK_ORDER_UNCONFIRMED', '直列製品handlerへの追記は専用Grokだけです')
              appendGrokProductObserver(value, event, entry.hooks[0])
            } else value.hooks[event] = [...(value.hooks[event] ?? []), entry]
          }
          return Buffer.from(JSON.stringify(value, null, 2) + '\n')
        })
        if (harness === 'codex') await fixture.trustProjectHooks()
        fixture.observer = { observer, observations, controls, file, command }
        return fixture.observer
      }
      fixture.addProductCompetitors = async ({ count = 2, compatibilityHarness } = {}) => {
        if (!['claude', 'codex'].includes(harness) && !adapter.projectHookFile) fail('ACCEPTANCE_PROJECT_HOOK_PATH_UNCONFIRMED', harness)
        const file = harness === 'claude' ? join(project, '.claude/settings.local.json') : harness === 'codex' ? join(project, '.codex/hooks.json') : adapter.projectHookFile(project)
        const rows = join(directory, 'product-competitors.jsonl'), entry = join(project, 'product-competitor.mjs')
        // stdinは公式hook eventそのもの。製品のstdout/stderrを無加工で同じ親へ返す。
        writeFileSync(entry, `import {spawn} from 'node:child_process';import {appendFileSync} from 'node:fs';let raw='';for await(const c of process.stdin)raw+=c;const e=JSON.parse(raw.replace(/^\\uFEFF/u,''));const log=x=>appendFileSync(process.argv[2],JSON.stringify({at:new Date().toISOString(),pid:process.pid,parent:process.ppid,event:e,...x})+'\\n');log({phase:'started'});const child=spawn(process.execPath,[process.argv[3],process.argv[4]],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>{stdout+=c;process.stdout.write(c)});child.stderr.on('data',c=>{stderr+=c;process.stderr.write(c)});child.stdin.end(raw);child.on('exit',(code,signal)=>{log({phase:'completed',child_pid:child.pid,code,signal,stdout,stderr});process.exitCode=code??1});\n`, { mode: 0o600 })
        const commands = Array.from({ length: count }, (_, index) => platform.hookCommand(process.execPath, [entry, rows, join(pkg, 'skill/scripts/parent-hook.mjs'), compatibilityHarness ?? harness, String(index)]))
        const events = harness === 'cursor' ? ['postToolUse', 'afterMCPExecution'] : ['PostToolUse', 'Stop']
        fixture.modify(file, before => {
          const value = before ? JSON.parse(before.toString('utf8').replace(/^\uFEFF/u, '')) : { ...(harness === 'cursor' ? { version: 1 } : {}), hooks: {} }
          for (const event of events) {
            const handlers = commands.map(command => harness === 'cursor' ? { command } : { hooks: [{ type: 'command', command, ...(harness === 'claude' ? { asyncRewake: true } : {}), timeout: harness === 'claude' ? 86400 : 20, ...(harness === 'codex' ? { additionalContextLimit: 0 } : {}) }] })
            value.hooks[event] = [...(value.hooks[event] ?? []), ...handlers]
          }
          return Buffer.from(JSON.stringify(value, null, 2) + '\n')
        })
        if (harness === 'codex') await fixture.trustProjectHooks()
        fixture.competitors = { file, rows, entry, commands, count, compatibilityHarness }; return fixture.competitors
      }
      fixture.launch = async ({ resume } = {}) => {
        const cli = adapter.resolveCli(), launcher = join(directory, 'launcher.mjs'), input = join(directory, 'launch.json')
        const argv = harness === 'codex' ? ['-c', 'mcp_servers.peertable_parent.env_vars=["PEERTABLE_TOKEN_SOURCE_FILE"]', '-c', 'check_for_update_on_startup=false'] : harness === 'claude' ? [] : adapter.argv?.({ project, tokenFile }) ?? []
        if (fixture.sessionSettings && harness === 'claude') { const settings = join(project, 'session-settings.json'); writeJson(settings, fixture.sessionSettings); argv.push('--settings', settings) }
        if (model) argv.push(harness === 'codex' ? '-m' : '--model', model)
        if (resume) argv.unshift(...(harness === 'codex' ? ['resume', resume] : harness === 'claude' ? ['--resume', resume] : adapter.resumeArgs(resume)))
        const invocation = nativeInvocation(cli.executable, argv, { shellCommand: platform.shellCommand, interactive: true })
        writeJson(input, { executable: cli.executable, argv, invocation, project, tokenFile })
        // HOME・認証・model/provider設定はharnessの通常環境のまま。token参照だけを試験roomへ渡す。
        writeFileSync(launcher, `import {readFileSync} from 'node:fs';import {spawn} from 'node:child_process';const p=JSON.parse(readFileSync(process.argv[2],'utf8'));const child=spawn(p.invocation.executable,p.invocation.argv,{cwd:p.project,stdio:'inherit',env:{...process.env,PEERTABLE_TOKEN_SOURCE_FILE:p.tokenFile}});child.on('exit',(code)=>process.exit(code??1));\n`, { mode: 0o600 })
        if (!fixture.aiterm) fixture.aiterm = await openAiterm()
        if (!fixture.pty) fixture.pty = await fixture.aiterm.open(`pt-fixture-${randomUUID().slice(0, 8)}`, process.platform === 'win32' ? 'pwsh' : undefined)
        writeJson(fixture.identityArtifact, { at: new Date().toISOString(), project, harness, pty: fixture.pty, pane: fixture.paneOwner, native: fixture.nativeOwners, receiver: fixture.receiverOwners })
        await fixture.trackOwnProcesses()
        await fixture.aiterm.send(fixture.pty, platform.shellCommand(process.execPath, [launcher, input]))
        await until('通常HOMEの公式CLI起動', async () => { await fixture.trackOwnProcesses(); const action = adapter.startup(await fixture.aiterm.screen(fixture.pty)); if (action?.blocked) fail('ACCEPTANCE_FIXTURE_HARNESS_BLOCKED', action.blocked); if (action?.keys) { for (const key of action.keys) { await fixture.aiterm.key(fixture.pty, key); await sleep(500) } return false } return action?.ready }, 120000, 1500)
        fixture.ready = true
        if (adapter.afterStartup) await adapter.afterStartup()
        return fixture
      }
      fixture.submit = async text => { await fixture.aiterm.send(fixture.pty, text, false); await sleep(1500); await fixture.aiterm.key(fixture.pty, 'Enter') }
      fixture.refreshTarget = async (previousEndpoint = null) => {
        const spool = await until('fixture parent_join', async () => { await fixture.trackOwnProcesses(); return projectEndpoints(project).find(item => item.id !== previousEndpoint && item.read().name === name && item.read().runtime !== 'stopped') })
        const joined = await until('fixture verified', async () => { await fixture.trackOwnProcesses(); const state = spool.read(); if (state.state === 'failed') fail(state.error_code, 'fixtureのjoinが失敗しました'); return state.state === 'verified' ? state : null })
        fixture.session = joined.caller.conversation; fixture.owner = joined.caller.owner
        const file = await until('fixture公式transcript', () => adapter.transcript(fixture.session))
        const meta = { ...sourceMeta, harness, room, parent_session: fixture.session, parent_process: fixture.owner, endpoint_id: spool.id, harness_version: adapter.resolveCli().version }
        const sessionAtJoin = fixture.session
        const boundObserve = () => { const seen = adapter.read(file, { session: sessionAtJoin, spool }); return seen.deliveries ? seen : { ...seen, deliveries: seen.injections.flatMap(row => parseDelivered(row.text).map(delivery => ({ ...delivery, order: row.order, session: row.session ?? sessionAtJoin, turn_id: row.turn_id, hook: row.hook, boundary: { encoding: row.encoding ?? 'none' } }))), replies: seen.replies.map(reply => ({ ...reply, session: reply.session ?? sessionAtJoin })) } }
        fixture.target = { meta, spool, api: apiFor(room), observe: boundObserve, submit: fixture.submit, file, nativeStopFile: fixture.observer?.observations, screen: () => fixture.aiterm.screen(fixture.pty), fixture }
        return fixture.target
      }
      fixture.join = async (previousEndpoint = null) => { await fixture.submit(fixtureJoinInstruction({ harness, project, name })); return fixture.refreshTarget(previousEndpoint) }
      fixture.restore = () => { for (const [file, original] of fixture.backups) { if (original === null) rmSync(file, { force: true }); else { writeFileSync(file, original, { mode: 0o600 }); if (!readFileSync(file).equals(original)) fail('ACCEPTANCE_FIXTURE_RESTORE_FAILED', file) } }; fixture.backups.clear(); configuration.assertHooksUnchanged() }
      fixture.stop = async () => {
        await fixture.trackOwnProcesses()
        if (!fixture.ready || !fixture.owner || !platform.sameProcess(fixture.owner)) return
        const exit = harness === 'claude' ? '/exit' : harness === 'codex' ? '/quit' : adapter.exit
        if (!exit) {
          await fixture.aiterm.close(fixture.pty); fixture.pty = null
          await waitOwnedFixtureExit({ readEndpoints: () => projectEndpoints(project), sameProcess: platform.sameProcess, knownOwners: [...fixture.nativeOwners, ...fixture.receiverOwners, fixture.paneOwner].filter(Boolean), indexExists: id => existsSync(join(homedir(), '.peertable/parent-receivers/endpoints', `${id}.json`)) })
          fixture.ready = false; fixture.owner = null; fixture.paneOwner = null
          return
        }
        await fixture.submit(exit)
        await until('fixture親終了', () => !platform.sameProcess(fixture.owner), 30000)
      }
      fixture.stopOwnPane = async () => {
        await fixture.trackOwnProcesses()
        if (fixture.pty) { await fixture.aiterm.close(fixture.pty); fixture.pty = null }
        await waitOwnedFixtureExit({ readEndpoints: () => projectEndpoints(project), sameProcess: platform.sameProcess, knownOwners: [...fixture.nativeOwners, ...fixture.receiverOwners, fixture.paneOwner].filter(Boolean), indexExists: id => existsSync(join(homedir(), '.peertable/parent-receivers/endpoints', `${id}.json`)) })
        fixture.ready = false; fixture.owner = null; fixture.paneOwner = null
      }
      fixture.close = async () => {
        if (fixture.closed) return
        const errors = []
        try { fixture.restore() } catch (error) { errors.push(error) }
        try { await fixture.stop() } catch (error) { errors.push(error) }
        // 起動dialog失敗・joinなしでも、own paneを公式APIで閉じ、既知のnative親を終了させる。
        if (fixture.pty) {
          try { await fixture.trackOwnProcesses() } catch (error) { errors.push(error) }
          try { await fixture.aiterm.close(fixture.pty); fixture.pty = null } catch (error) { errors.push(error) }
        }
        try {
          await waitOwnedFixtureExit({ readEndpoints: () => projectEndpoints(project), sameProcess: platform.sameProcess, knownOwners: [...fixture.nativeOwners, ...fixture.receiverOwners, fixture.paneOwner].filter(Boolean), indexExists: id => existsSync(join(homedir(), '.peertable/parent-receivers/endpoints', `${id}.json`)), timeout: 30000 })
        } catch (error) { errors.push(error) }
        if (fixture.aiterm) { try { await fixture.aiterm.end(); fixture.aiterm = null } catch (error) { errors.push(error) } }
        try { await fixture.removeProjectTrust() } catch (error) { errors.push(error) }
        try { configuration.assertHooksUnchanged() } catch (error) { errors.push(error) }
        if (errors.length) fail('ACCEPTANCE_FIXTURE_CLEANUP_FAILED', JSON.stringify(errors.map(error => ({ code: error.code, message: error.message }))))
        fixture.closed = true; fixtures.delete(fixture)
      }
      fixtures.add(fixture)
      await fixture.ensureProjectTrust()
      if (adapter.prepare) await adapter.prepare()
      if (prepare) await prepare(fixture)
      await fixture.launch(); if (initialJoin) await fixture.join(); return fixture
    },
    async close() { const errors = []; for (const fixture of [...fixtures].reverse()) { try { await fixture.close() } catch (error) { errors.push({ code: error.code, message: error.message, directory: fixture.directory }) } } if (errors.length) fail('ACCEPTANCE_FIXTURE_CLEANUP_FAILED', JSON.stringify(errors)) },
  }
}
