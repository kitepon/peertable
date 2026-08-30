// 席TUIへの入力方言の**唯一の正本**。
//
// 各harness TUIは入力の作法が異なり（実被弾の履歴: Escapeを撃つとClaudeの実行中ターンが
// 死ぬ 2026-08-22 / 素打ち連打はCodexのcomposerを壊す 2026-08-29 / bracketed pasteの
// 終端コードはGrokへリテラル混入する 2026-08-30）、その違いを呼び出し側のAIやscriptに
// 覚えさせると、片方で検証した変更が他方を壊す事故が構造的に再発する（オーナー裁定
// 2026-08-30「その違いをAIに要求するのが間違い。ツール側がミスが起こらないように作れ」）。
//
// 方言はこの表だけに書く。呼び出し側はharness名を渡して結果を使うだけであり、
// 表に無いharnessは推測で送らず typed error で止まる——新harnessの追加は
// この表へ1行足すまで配達自体ができない、という形でミスを機械的に封じる。
export const HARNESS_INPUT_DIALECTS = Object.freeze({
  // Codex CLI: bracketed paste対応（素打ち連打はpaste burst検知を壊すので必ずpaste経由）
  codex: Object.freeze({ bracketed_paste: true }),
  // Claude Code: bracketed paste対応
  claude: Object.freeze({ bracketed_paste: true }),
  // Grok Build: bracketed paste**非対応**（終端コード ^[[201~ がリテラル混入して固着する）
  grok: Object.freeze({ bracketed_paste: false }),
})

export function seatInputDialect(harness) {
  const dialect = HARNESS_INPUT_DIALECTS[harness]
  if (dialect === undefined) {
    const error = new Error(`SEAT_INPUT_HARNESS_UNKNOWN: 入力方言表に '${harness}' が無い。`
      + 'skill/scripts/seat-input.mjs の HARNESS_INPUT_DIALECTS へ実測に基づく1行を追加するまで、この席へは配達できない')
    error.code = 'SEAT_INPUT_HARNESS_UNKNOWN'
    throw error
  }
  return dialect
}

/** tmux paste-buffer の argv を方言から組む。呼び出し側は -p の要否を知らない。 */
export function seatPasteArgs(harness, bufferName, target) {
  const dialect = seatInputDialect(harness)
  return ['paste-buffer', ...(dialect.bracketed_paste ? ['-p'] : []), '-d', '-b', bufferName, '-t', target]
}
