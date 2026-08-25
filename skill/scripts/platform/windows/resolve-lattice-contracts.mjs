import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Windows npm global shimまたはsource treeのlattice CLIから契約moduleを解決する。 */
export function resolveWindowsLatticeContracts(latticeCli) {
  const npmGlobal = join(dirname(latticeCli), 'node_modules', '@quolu', 'lattice', 'src', 'todo-contracts.mjs')
  if (existsSync(npmGlobal)) return npmGlobal
  return join(dirname(dirname(latticeCli)), 'src', 'todo-contracts.mjs')
}
