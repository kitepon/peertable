#!/usr/bin/env node
// Claude Codeの公式hook（PreToolUse／PostToolUse／Stop／SessionEnd）。本文はasyncRewakeのstderrで返す。本体はaiterm-steer-delivery。
import { runClaudeHookMain } from 'aiterm-steer-delivery'
import { PEERTABLE_PROFILE } from './parent-steer.mjs'
await runClaudeHookMain(PEERTABLE_PROFILE)
