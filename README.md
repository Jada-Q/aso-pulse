# aso-pulse

個人開発者のための **ASO 週次スナップショット**。App Store Connect 公式 API（.p8 キー）と公開 iTunes API だけで、自分の全アプリの

1. **ダウンロード数**（Sales Reports）
2. **ストア表示・商品ページ閲覧**（Analytics Reports）
3. **評価**（複数ストアフロント）
4. **検索キーワード順位**（陽性対照つき）

を 1 コマンドで Markdown 台帳に追記します。**ブラウザ不要・npm install 不要・外部サービス不要・無料**。Node.js 18+ だけで動きます。

ASO ツールの無料プランは「1 アプリ・5 キーワード」が相場ですが、これは全アプリ・キーワード無制限・データは自分の手元の Markdown。launchd / cron に乗せれば完全自動の週報になります。

## セットアップ（5 分）

1. **API キーを作る**: App Store Connect → Users and Access → Integrations → App Store Connect API → 「Request Access」承認後「Generate API Key」（ロールは Sales/Analytics を読むなら Admin か Finance+Sales）。`.p8` は**一度しかダウンロードできない**ので安全な場所に保存
2. **Vendor Number を控える**: App Store Connect → Payments and Financial Reports の画面上部「Vendor #」
3. 設定ファイルを作る:
   ```sh
   cp config.example.json config.json   # 編集して自分の値を入れる
   ```
4. 実行:
   ```sh
   node aso-pulse.mjs
   ```

初回実行時に各アプリの Analytics レポート（ONGOING）を自動で申請します。表示・閲覧データは申請から **24-48 時間後**に流れ始めます（それまでは pending 表示 — 正常です）。

## 設計上のこだわり（ここが本体）

- **陽性対照（positive control）**: 検索順位ブロックは毎回「必ずヒットするはずのクエリ」を先に検証し、外れたらそのブロック全体を SUSPECT とマークします。壊れた計測器の出力を「圏外」として記録しない
- **「レポートなし」と「ゼロ」を区別**: Sales Reports の 404 は「その日は全アカウントで取引ゼロ」の意味。データ欠損と混同しない
- **全 0 のとき列ヘッダを出力**: Analytics の列名マッチが静かに壊れたとき、気づけるように

## ハマりどころ（実体験）

| 症状 | 原因 |
|---|---|
| `curl` が exit 3 | クエリの `fields[apps]` の角括弧が glob 展開される → `-g` をつける |
| launchd で `spawnSync node ENOENT` | launchd の PATH に nvm がない → `process.execPath` / 絶対パスを使う |
| 日付が 1 日ずれる | `toISOString()` は UTC。JST の午前に走らせると前日になる |
| JWT が 401 | ES256 署名は DER ではなく raw r\|\|s 形式（`dsaEncoding: "ieee-p1363"`） |

## ライセンス

MIT — 商用含めご自由に。

---

### English summary

Weekly ASO snapshot for indie iOS developers: downloads (Sales Reports), impressions/page views (Analytics Reports), ratings and keyword ranks (public iTunes APIs, with a positive-control check) — appended to a local Markdown ledger. Official App Store Connect API only, zero dependencies, free. Copy `config.example.json` to `config.json`, add your `.p8` key info, run `node aso-pulse.mjs`. MIT.
