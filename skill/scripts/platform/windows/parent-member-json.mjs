export function parentMember(name, model, effort, harness, mission) {
const body = { name, roles: ['統括'], observe: null, delivery: { kind: 'parent_watch', host: harness || '' } }
if (harness) { body.harness = harness; body.vendor = harness }
if (model) body.model = model
if (effort) body.effort = effort
if (mission) body.mission = mission
return body
}
const [name, model, effort, harness, mission] = process.argv.slice(2)
process.stdout.write(`${JSON.stringify(parentMember(name, model, effort, harness, mission))}\n`)
