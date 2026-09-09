// roomのHTTP境界。失敗応答を空の台帳として扱わない。
import { readFileSync } from 'node:fs'

export class RoomApi {
  constructor(state, { credential, fetchImpl = fetch } = {}) {
    this.base = `${state.server_url.replace(/\/$/, '')}/api/${encodeURIComponent(state.room)}`
    this.credential = credential
    this.fetch = fetchImpl
  }
  async request(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' }
    if (method !== 'GET' && this.credential) {
      headers['X-Peertable-Token'] = readFileSync(this.credential, 'utf8').trim()
    }
    let response
    try {
      response = await this.fetch(path ? `${this.base}/${path}` : this.base, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw Object.assign(new Error(`roomへ到達できません: ${error.message}`), { code: 'PEERTABLE_ROOM_UNREACHABLE' })
    }
    if (!response.ok) throw Object.assign(new Error(`${method} ${path}: HTTP ${response.status}`), { code: 'PEERTABLE_ROOM_REQUEST_FAILED' })
    return response.json()
  }
  async members() { return (await this.request('members')).members }
}
