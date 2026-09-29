#!/usr/bin/env node
// 親の背景で起動する受信process（Cursorのidle時、Grok等）。次の本文を受け取り、1行のJSONで出して終わる。
// 結果のnext_wait_processを同じ背景APIへ渡すと、受信を張り直せる。本体はaiterm-steer-delivery。
import { runChannelReceiveMain } from 'aiterm-steer-delivery'
import { PEERTABLE_PROFILE } from './parent-steer.mjs'
await runChannelReceiveMain(PEERTABLE_PROFILE)
