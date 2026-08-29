#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(process.argv[2] ?? new URL('../room/server.mjs', import.meta.url), 'utf8')

assert.match(source, /if\(st\)c\.classList\.add\('is-'\+st\)/,
  'fresh statusだけをchip classへ写す')
assert.match(source, /\.chip\.is-busy \.av\{animation:seat-working [^}]* infinite/,
  'busy avatarは継続的に作業中を示す')
assert.match(source, /\.chip\.is-busy \.st\{animation:seat-beat [^}]* infinite/,
  'busy status dotも継続的に脈動する')
assert.match(source, /\.chip\.is-busy\.pulse \.av\{animation:seat-working [^,]* infinite,pulse [^}]* 2\}/,
  'busy中も既存の直近発言pulseを合成する')
assert.match(source, /@media \(prefers-reduced-motion:reduce\)\{\.chip\.is-busy \.av,\.chip\.is-busy \.st,\.chip\.is-blocked \.av,\.victory\{animation:none\}\}/,
  'reduced-motionではbusyと祝祭の動きを止める')
assert.match(source, /nameRow\.appendChild\(el\('span','state-label',stateText\)\)/,
  '状態名を点だけでなく常設文字として表示する')
assert.match(source, /id\.appendChild\(el\('span','activity',m\.activity_text\?\?'現在作業未取得'\)\)/,
  '現在作業をホバー内でなく常設表示する')
assert.match(source, /if\(isActivityMessage\(m\)\)scheduleMemberRefresh\(\)/,
  '現在作業の自己申告を受信したらmember表示を即時更新する')
assert.ok(source.includes("/^(?:\\\\[(?:done|完了|accept(?:ed)?|受理)\\\\]|(?:受入|受理)[:：\\\\s])/i"),
  '完了判定のescapeを配信HTMLまで保ち、system以外の先頭マーカーだけを採る')
assert.match(source, /if\(!apply\(m,true\)\)return[\s\S]*if\(isCompletion\(m\)\)celebrate\(m\.from\)/,
  '祝祭は重複排除後のlive SSEだけから呼ぶ')
assert.doesNotMatch(source, /function catchUp\([^)]*\)\{[\s\S]{0,900}celebrate\(/,
  'history/catch-upで祝祭を再生しない')
assert.match(source, /setTimeout\(\(\)=>v\.remove\(\),1600\)/,
  '祝祭要素は一度だけ表示して除去する')

console.log('member activity fx repro: green')
