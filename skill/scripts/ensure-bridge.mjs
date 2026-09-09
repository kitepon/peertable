#!/usr/bin/env node
import { ensureBridge } from './ensure-project-runtime.mjs'
const [project, kind, ...args] = process.argv.slice(2)
try {
  console.log(JSON.stringify(await ensureBridge(project, kind, {
    force: args.includes('--force'), args: args.filter(arg => arg !== '--force'),
  })))
} catch (error) {
  console.error(`${error.code ?? 'PEERTABLE_RUNTIME_FAILED'}: ${error.message}`)
  process.exitCode = 1
}
