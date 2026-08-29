# Windows native bridge 起動修理

- 日付: 2026-08-29
- 状態: 実装・実機確認完了、release準備中
- 発見元: LiveTR の Peertable setup（Windows 11 native / psmux / PowerShell 7）

## 目的

Windows nativeで`setup.sh`を実行した時、`alarm-bridge`と`seat-status-bridge`が実際には起動していないのに、setupがscaffold完了まで進む欠陥を直す。同時に`doctor.sh`がnpmの`lattice.cmd`を直実行して`EINVAL`になる欠陥を直す。

## 原因

- `ensure-bridge.sh`はpsmux上のPowerShellへ、POSIX専用の`env ... node /c/... >> ... 2>&1`をコマンド文字列として渡している。PowerShellでは`env`とMSYS形式pathが成立せず、node起動前に終了する。
- `doctor.sh`はWindowsのnpm shim `lattice.cmd`を`execFileSync`へ直接渡す。NodeのWindows `execFileSync`は`.cmd`を直接実行できず`EINVAL`になる。

## 修正

- WindowsではPowerShell 7の`-EncodedCommand`を生成し、node実体、Windows path、必要env、引数、log redirectionをPowerShell構文で起動する。POSIX経路は変えない。
- Windows command shimの解決を引数汎用の一関数へまとめ、従来の`todo status`利用とdoctorの`status --json`の両方を同じ経路へ通す。
- PowerShell commandの実起動と`.cmd`解決をfocused testで固定する。

## 受入

- Windows focused testがPowerShell子processを起動し、project path・追加引数・envをfixtureへ正しく渡してlogを生成する。
- `windows-seat-mux-repro`が既存のtodo statusとdoctor用statusの両方をcmd.exe経由として検証する。
- LiveTRの既存卓で`ensure-bridge.sh ... alarm`と`seat-status`がrecordへ`ready_at`を書き、`doctor.sh`がLattice stateを読める。
- version bump、release gate、npm publish、global install、展開後の同じLiveTR卓smokeまで完遂する。

## 非目標

- ブリッジの業務ロジック、room wire、Lattice本体、Aiterm/psmuxの変更。
- POSIX環境の起動方法変更。
