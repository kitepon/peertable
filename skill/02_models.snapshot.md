# Peertable seat placement snapshot

```yaml
schema: peertable.models-placement.v1
source_repository: https://github.com/kitepon/dotagents
source_path: docs/02_models.md
source_commit: dcf4d9064b5c4f21a7643cbd169b7047cf3607bf
captured_at: 2026-08-30
```

これはPeertableがrelease単位で所有する着席配置の既定値である。役割、順位、model slug、effortだけを同梱し、dotagentsの説明文や内部リンクは複製しない。外部表を使う場合は`PEERTABLE_MODELS_DOC`または`DOTAGENTS_ROOT`を明示する。

## 順位表（役割→1位〜3位）

| 役割 | 1位 | 2位 | 3位 |
|---|---|---|---|
| 統括 | オーナー指定 | — | — |
| 反証 | Grok 4.6×high | Sol×high | Opus 5×high |
| 監査・発見 | Grok 4.6×medium | Sonnet 5×medium | Terra×medium |
| 設計 | Opus 5×high | Grok 4.6×high | Sol×medium |
| 相談 | ChatGPT（gpt-connector・別quota） | Grok 4.6×medium | Fable 5×high |
| 実装 | Terra×high | Sonnet 5×medium | Grok 4.6×medium |
| 局所コーディング | Luna×medium | Sonnet 5×medium | Grok 4.6×medium |
| 軽作業 | Luna×low | Haiku | Grok 4.6×low |
| 調査 | Grok 4.6×low | Sonnet 5×medium | Sol×medium |

## モデル台帳

| モデル | slug |
|---|---|
| Claude Fable 5 | alias `fable` |
| Claude Opus 5 | alias `opus` |
| Claude Sonnet 5 | alias `sonnet` |
| Claude Haiku 4.5 | alias `haiku` |
| GPT-5.6 Sol | `gpt-5.6-sol` |
| GPT-5.6 Terra | `gpt-5.6-terra` |
| GPT-5.6 Luna | `gpt-5.6-luna` |
| Grok 4.6 | `grok-4.6` |
