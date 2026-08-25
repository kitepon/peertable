#!/usr/bin/env node
import { writeFileSync } from 'node:fs'

const [
  output, room, serverUrl, publicUrl, mode, planKey, phasesJson,
  addedExclude, latticePreexisting, runtimePreexisting, addedRuntimeExclude,
  addedRootMcp, addedMcpExclude, externalPane, projectJsonPreexisting,
  workOrderAdapter, workOrderSpoolRef, latticeCli,
] = process.argv.slice(2)

const bool = (value) => value === 'true'
const state = {
  room,
  server_url: serverUrl,
  public_url: publicUrl,
  mode,
  plan_key: planKey,
  phases: JSON.parse(phasesJson),
  added_exclude: bool(addedExclude),
  lattice_preexisting: bool(latticePreexisting),
  runtime_preexisting: bool(runtimePreexisting),
  added_runtime_exclude: bool(addedRuntimeExclude),
  added_root_mcp: bool(addedRootMcp),
  added_mcp_exclude: bool(addedMcpExclude),
  external_pane: bool(externalPane),
  project_json_preexisting: bool(projectJsonPreexisting),
  work_order_adapter: bool(workOrderAdapter),
  work_order_spool_ref: workOrderSpoolRef,
  lattice_cli: latticeCli,
}
writeFileSync(output, `${JSON.stringify(state)}\n`, 'utf8')
