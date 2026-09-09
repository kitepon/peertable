#!/usr/bin/env node
import assert from 'node:assert/strict'

import { supportsMemberObservation } from '../skill/scripts/seat-usage.mjs'

assert.equal(supportsMemberObservation({ members: [], capabilities: { member_observation_v1: true } }), true)
assert.equal(supportsMemberObservation({ members: [{ status: 'busy' }] }), false)

console.log('seat usage repro: 2/2 green')
