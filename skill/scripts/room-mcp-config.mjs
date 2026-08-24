import { resolve } from 'node:path'

export function expectedRoomMcp(peertableRepo) {
  return { command: 'node', args: [resolve(peertableRepo, 'room', 'client.mjs')] }
}

export function isExpectedRoomMcp(current, expected) {
  return Boolean(current && typeof current === 'object' && !Array.isArray(current)
    && Object.keys(current).sort().join(',') === 'args,command'
    && current.command === expected.command
    && Array.isArray(current.args)
    && current.args.length === 1
    && current.args[0] === expected.args[0])
}

export function isPeertableRoomMcp(current) {
  return Boolean(current && typeof current === 'object' && !Array.isArray(current)
    && Object.keys(current).sort().join(',') === 'args,command'
    && current.command === 'node'
    && Array.isArray(current.args)
    && current.args.length === 1
    && typeof current.args[0] === 'string'
    && /(?:^|[\\/])room[\\/]client\.mjs$/u.test(current.args[0]))
}
