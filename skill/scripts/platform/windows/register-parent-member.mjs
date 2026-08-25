import { parentMember } from './parent-member-json.mjs'

const [url, room, name, model, effort, harness, mission] = process.argv.slice(2)
const token = process.env.PEERTABLE_POST_TOKEN
if (!url || !room || !name || !token) throw new Error('Windows parent登録にurl／room／name／tokenが必要です')
const response = await fetch(`${url}/api/${encodeURIComponent(room)}/members`, {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8', 'X-Peertable-Token': token },
  body: JSON.stringify(parentMember(name, model, effort, harness, mission)),
})
if (!response.ok) throw new Error(`Windows parent登録がHTTP ${response.status}で失敗しました`)
