#!/usr/bin/env node
/* aso-pulse — 個人開発者のための ASO 週次スナップショット（公式 API・無料・依存ゼロ）
 *
 * App Store Connect 公式 API（.p8 キー）と公開 iTunes API だけで、
 * 自分のアプリの「ダウンロード / 表示・閲覧 / 評価 / 検索順位」を
 * 1 コマンドで Markdown 台帳に追記します。ブラウザ不要、npm install 不要。
 *
 *   使い方:  node aso-pulse.mjs            （config.json を読む）
 *   設定:    config.example.json をコピーして config.json を作成
 *
 * 4 つのデータブロック:
 *   1. ダウンロード  — Sales Reports（日次、直近 7 レポート日）
 *   2. 表示 / 閲覧   — Analytics Reports（初回は ONGOING リクエストを自動作成。
 *                      データ生成まで 24-48h かかるため、それまでは pending 表示）
 *   3. 評価         — 公開 lookup API（複数ストアフロント）
 *   4. 検索順位     — 公開 search API。陽性対照（必ずヒットするはずのクエリ）が
 *                      外れたらそのブロック全体を SUSPECT とマークし、
 *                      壊れた計測器のデータを本物として記録しない
 */
import { readFileSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { createSign, createPrivateKey } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.ASO_PULSE_CONFIG ?? join(HERE, "config.json");
if (!existsSync(CONFIG_PATH)) {
  console.error(`config.json が見つかりません（${CONFIG_PATH}）。config.example.json をコピーして作成してください。`);
  process.exit(1);
}
const C = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

// ---------- JWT（ES256）。launchd 等 PATH の無い環境でも動くよう外部コマンドは呼ばない ----------
function makeToken() {
  const pem = readFileSync(C.keyPath.replace(/^~/, process.env.HOME ?? "~"));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "ES256", kid: C.keyId, typ: "JWT" });
  const payload = b64({ iss: C.issuerId, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" });
  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  // JWT の ES256 は raw r||s 形式。DER のままだと 401 になる
  const sig = signer.sign({ key: createPrivateKey(pem), dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${header}.${payload}.${sig}`;
}
const H = { Authorization: `Bearer ${makeToken()}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ローカル日付。toISOString() は UTC なので午前に走らせると日付が 1 日ずれる
const _d = new Date();
const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, "0")}-${String(_d.getDate()).padStart(2, "0")}`;
const out = [];
const say = (s) => { out.push(s); console.log(s); };
const ascGet = async (url) => { const res = await fetch(url, { headers: H }); return { status: res.status, res }; };

// ---------- 1. Sales Reports ----------
async function salesBlock() {
  const perApp = Object.fromEntries(C.apps.map((a) => [a.id, 0]));
  const days = [];
  for (let back = 2; back <= 8; back++) {           // レポートは 1-2 日遅れで出る
    const d = new Date(Date.now() - back * 864e5).toISOString().slice(0, 10);
    const url = `https://api.appstoreconnect.apple.com/v1/salesReports?filter[frequency]=DAILY&filter[reportDate]=${d}&filter[reportType]=SALES&filter[reportSubType]=SUMMARY&filter[vendorNumber]=${C.vendorNumber}&filter[version]=1_0`;
    const { status, res } = await ascGet(url);
    // 404 = その日のレポートが存在しない = 全アカウントで取引ゼロの日（データ欠損ではない）
    if (status !== 200) { days.push(`${d}:${status === 404 ? "0件" : "HTTP" + status}`); await sleep(400); continue; }
    const tsv = gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
    const rows = tsv.trim().split("\n").map((l) => l.split("\t"));
    const head = rows[0];
    const iUnits = head.indexOf("Units"), iApple = head.indexOf("Apple Identifier"), iType = head.indexOf("Product Type Identifier");
    for (const r of rows.slice(1)) {
      // Product Type 1 系 = 新規ダウンロード。7 系はアップデートなので数えない
      if (perApp[r[iApple]] !== undefined && (r[iType] || "").startsWith("1")) perApp[r[iApple]] += Number(r[iUnits] || 0);
    }
    days.push(`${d}:ok`);
    await sleep(400);
  }
  say(`\n### ダウンロード（Sales Reports: ${days.join(" ")}）`);
  for (const a of C.apps) say(`- ${a.name}: ${perApp[a.id]}`);
}

// ---------- 2. Analytics Reports（表示 / 閲覧） ----------
async function ensureReportRequest(app) {
  if (app.analyticsRequestId) return app.analyticsRequestId;
  // 初回: ONGOING リクエストを作成し config.json に書き戻す
  const res = await fetch("https://api.appstoreconnect.apple.com/v1/analyticsReportRequests", {
    method: "POST", headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ data: { type: "analyticsReportRequests", attributes: { accessType: "ONGOING" },
      relationships: { app: { data: { type: "apps", id: app.id } } } } }),
  });
  if (res.status !== 201) return null;
  const id = (await res.json()).data.id;
  app.analyticsRequestId = id;
  writeFileSync(CONFIG_PATH, JSON.stringify(C, null, 2));
  return id;
}

async function analyticsBlock() {
  say(`\n### 表示 / 閲覧（Analytics Reports API）`);
  for (const a of C.apps) {
    try {
      const arr = await ensureReportRequest(a);
      if (!arr) { say(`- ${a.name}: リクエスト作成失敗`); continue; }
      let { status, res } = await ascGet(`https://api.appstoreconnect.apple.com/v1/analyticsReportRequests/${arr}/reports?filter[category]=APP_STORE_ENGAGEMENT&limit=50`);
      if (status !== 200) { say(`- ${a.name}: HTTP${status}`); continue; }
      const disc = ((await res.json()).data || []).find((r) => /discovery|engagement/i.test(r.attributes.name));
      if (!disc) { say(`- ${a.name}: pending（レポート生成待ち。ONGOING 作成から 24-48h）`); continue; }
      ({ status, res } = await ascGet(`https://api.appstoreconnect.apple.com/v1/analyticsReports/${disc.id}/instances?filter[granularity]=DAILY&limit=14`));
      const insts = status === 200 ? (await res.json()).data || [] : [];
      if (!insts.length) { say(`- ${a.name}: pending（日次インスタンス 0 件）`); continue; }
      const recent = insts.sort((x, y) => (y.attributes.processingDate || "").localeCompare(x.attributes.processingDate || "")).slice(0, 7);
      let imp = 0, pv = 0, cols = null;
      for (const inst of recent) {
        const segRes = await ascGet(`https://api.appstoreconnect.apple.com/v1/analyticsReportInstances/${inst.id}/segments`);
        if (segRes.status !== 200) continue;
        for (const seg of (await segRes.res.json()).data || []) {
          const raw = await fetch(seg.attributes.url);          // 署名付き URL。Authorization ヘッダ不要
          const csv = gunzipSync(Buffer.from(await raw.arrayBuffer())).toString("utf8");
          const rows = csv.trim().split("\n").map((l) => l.split("\t"));
          const head = rows[0];
          const iImp = head.findIndex((h) => /impression/i.test(h));
          const iPv = head.findIndex((h) => /page view/i.test(h));
          if (!cols) cols = head.join(" | ");
          for (const r of rows.slice(1)) {
            if (iImp >= 0) imp += Number(r[iImp]) || 0;
            if (iPv >= 0) pv += Number(r[iPv]) || 0;
          }
        }
        await sleep(300);
      }
      say(`- ${a.name}: 直近${recent.length}日 表示 ${imp} / 閲覧 ${pv}`);
      // 列名マッチが静かに壊れていないかの自己検査: 全 0 なら列ヘッダを吐く
      if (imp === 0 && pv === 0 && cols) say(`  ⚠️ 全 0。列ヘッダ: ${cols.slice(0, 160)}`);
    } catch (e) { say(`- ${a.name}: エラー ${String(e).slice(0, 80)}`); }
    await sleep(300);
  }
}

// ---------- 3. 評価（公開 lookup） ----------
async function ratingsBlock() {
  say(`\n### 評価（lookup API）`);
  for (const a of C.apps) {
    const parts = [];
    for (const cc of C.storefronts) {
      const d = await (await fetch(`https://itunes.apple.com/lookup?id=${a.id}&country=${cc}`)).json();
      parts.push(d.resultCount ? `${cc}: ${d.results[0].averageUserRating ?? "-"}★×${d.results[0].userRatingCount ?? 0}` : `${cc}: 未公開`);
      await sleep(300);
    }
    say(`- ${a.name}: ${parts.join(" / ")}`);
  }
}

// ---------- 4. 検索順位（公開 search・陽性対照つき） ----------
async function rankBlock() {
  const ctl = C.rankControl;
  const ctlRes = await (await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(ctl.term)}&country=${ctl.country}&entity=software&limit=50`)).json();
  const ctlHit = (ctlRes.results || []).findIndex((r) => String(r.trackId) === ctl.appId);
  say(`\n### 検索順位（search API、陽性対照 "${ctl.term}"@${ctl.country} → ${ctlHit < 0 ? "❌ SUSPECT（API 異常。本ブロックのデータは信用しない）" : `#${ctlHit + 1} ✓`}）`);
  for (const a of C.apps) {
    const lines = [];
    for (const [cc, kws] of Object.entries(a.keywords || {})) {
      for (const kw of kws) {
        const d = await (await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(kw)}&country=${cc}&entity=software&limit=50`)).json();
        const idx = (d.results || []).findIndex((r) => String(r.trackId) === a.id);
        lines.push(`${kw}@${cc}=${idx >= 0 ? "#" + (idx + 1) : ">50"}`);
        await sleep(400);  // search API は 429 が出やすい。急がない
      }
    }
    say(`- ${a.name}: ${lines.join("  ") || "(キーワード未設定)"}`);
  }
}

say(`\n---\n\n## ${today} スナップショット`);
await salesBlock();
await analyticsBlock();
await ratingsBlock();
await rankBlock();
const ledger = C.ledgerPath.replace(/^~/, process.env.HOME ?? "~");
appendFileSync(ledger, out.join("\n") + "\n");
console.log(`\n→ ${ledger} に追記しました`);
