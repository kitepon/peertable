const [name, model, effort, harness, mission] = process.argv.slice(2)
const body = { name, roles: ['統括'], observe: null, delivery: { kind: 'parent_watch', host: harness || '' } }
if (harness) { body.harness = harness; body.vendor = harness }
if (model) body.model = model
if (effort) body.effort = effort
if (mission) body.mission = mission
process.stdout.write(`${JSON.stringify(body)}\n`)
