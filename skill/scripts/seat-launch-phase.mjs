// 着任指示を渡すまで、その席へのroom配達を保留する。状態はPeertableが所有する。
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const phasePath = (project, name) => join(project, '.team', 'seats', `${name}.launching`)
export const isSeatLaunching = (project, name) => existsSync(phasePath(project, name))
export function beginSeatLaunch(project, name) {
  mkdirSync(join(project, '.team', 'seats'), { recursive: true })
  writeFileSync(phasePath(project, name), `${process.pid}\n`, { flag: 'wx' })
}
export function endSeatLaunch(project, name) { rmSync(phasePath(project, name), { force: true }) }
