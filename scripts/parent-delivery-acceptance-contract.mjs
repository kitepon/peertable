// 必須scenarioの目録正本。受入手順と公開gateで共有する。
export const scenarios = {
  audience: 'DM・親を含む複数宛・all各1回、送信者/room/seq/宛先/原文一致',
  busy: '作業を保持して同じ会話へ配送', final_race: '最終応答/終了競合で欠落重複なし', idle: 'オーナー入力なしで同じ会話が再開',
  consecutive: 'seq順の連続配送と2通目以降の待機', no_external_tools: '外部作業toolなしでも受信維持', no_tools: '全tool省略時の維持または明示rearm_pendingと原文保持',
  original: '日本語・改行・引用・長文の全量回収', burst: '回収上限超過の未読保持', source_reconnect: 'HTTP/SSE再接続catch-upで重複欠落なし',
  process_recovery: 'ready継承/sending unknown/submitted再送なし', claim_race: '受信口間claimで1回だけ出力', output_interruption: '削除/claim後中断はunknownと原文保持',
  receipt_retry: '受付後のreceipt失敗はreceiptだけ復旧', session_change: 'clear/終了/別会話/resumeで旧本文誤流入なし', parallel_rooms: '複数room/親会話の所有分離',
  unavailable_hook: '無効/未承認/実行file欠落は原因付き失敗', foreign_ownership: '利用者/Aitermのqueue・hook・承認・順序保持', compatibility_hooks: '互換hookの二重相関なし',
  background_end: 'task cancel/timeout/終了は成功へ丸めない', lease: '有限lease更新とendpoint/cursor/本文保持', binding_deadline: '束縛/probe期限のtyped failure',
  slot_race: '複数hook開始でも1slot', lifecycle: '同版/新版更新・teardownで親processと履歴保持', package: 'npm packの配布物から同じ経路が成立。公開後もregistry版で再確認',
}
