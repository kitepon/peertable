import { pathToFileURL } from 'node:url'

/** Windows絶対pathをNode ESM dynamic importが受理するfile URLへ変換する。 */
export function windowsImportSpecifier(path) {
  return pathToFileURL(path).href
}
