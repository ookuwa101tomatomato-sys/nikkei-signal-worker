/**
 * 日経平均シグナル計算 — Cloudflare Workers版
 * signal_engine.py と同じロジック(重み・しきい値)をJavaScriptに移植。
 */

import * as XLSX from "xlsx";

const NIKKEI_TICKER = "^N225";
const NIKKEI_FUTURES_TICKER = "NIY=F"; // CME日経225先物(円建て) — トレンド/RSI/MACDの算出元
const FX_TICKER = "JPY=X";
const VIX_TICKER = "^VIX";
const MARGIN_PAGE_URL = "https://www.jpx.co.jp/markets/statistics-equities/margin/04.html"; // 信用取引現在高(JPX公式、週次)
const INVESTOR_TYPE_PAGE_URL = "https://www.jpx.co.jp/markets/statistics-equities/investor-type/index.html"; // 投資部門別売買状況(JPX公式、週次)

const INDICATOR_MIN_LEN = 75; // SMA75に必要な最低本数(これ未満の先物データしかない場合は現物にフォールバック)

const WEIGHTS = {
  trend: 0.29,
  rsi: 0.12,
  macd: 0.18,
  fx: 0.13,
  vix: 0.10,
  margin: 0.09,
  foreign_flow: 0.09,
};

function clip(value, lo = -100, hi = 100) {
  return Math.max(lo, Math.min(hi, value));
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ewm(values, alpha) {
  const out = new Array(values.length);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period = 14) {
  const n = closes.length;
  const gains = new Array(n).fill(0);
  const losses = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const delta = closes[i] - closes[i - 1];
    gains[i] = delta > 0 ? delta : 0;
    losses[i] = delta < 0 ? -delta : 0;
  }
  const alpha = 1 / period;
  const avgGain = ewm(gains, alpha);
  const avgLoss = ewm(losses, alpha);
  const out = new Array(n).fill(50);
  for (let i = 0; i < n; i++) {
    if (avgLoss[i] === 0) {
      out[i] = avgGain[i] === 0 ? 50 : 100;
      continue;
    }
    const rs = avgGain[i] / avgLoss[i];
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ewm(closes, 2 / (fast + 1));
  const emaSlow = ewm(closes, 2 / (slow + 1));
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = ewm(macdLine, 2 / (signalPeriod + 1));
  const hist = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, hist };
}

function last(arr) {
  return arr[arr.length - 1];
}

function polarityFromScore(score) {
  if (score >= 15) return "up";
  if (score <= -15) return "down";
  return "neutral";
}

function component(key, label, score, detail) {
  const clipped = clip(score);
  return { key, label, score: Math.round(clipped * 10) / 10, detail, polarity: polarityFromScore(clipped), weight: WEIGHTS[key] };
}

async function fetchChart(ticker, params) {
  // params は { range: "8mo" } または { period1: unix, period2: unix } のどちらか
  const qs =
    "range" in params
      ? `range=${params.range}`
      : `period1=${params.period1}&period2=${params.period2}`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${qs}&interval=1d`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error(`データ取得に失敗しました: ${ticker} (HTTP ${res.status})`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`データ取得に失敗しました: ${ticker}`);

  const timestamps = result.timestamp || [];
  const closesRaw = result.indicators?.quote?.[0]?.close || [];
  const gmtoffset = result.meta?.gmtoffset || 0;

  const dates = [];
  const closes = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closesRaw[i] === null || closesRaw[i] === undefined) continue;
    const localMs = (timestamps[i] + gmtoffset) * 1000;
    dates.push(new Date(localMs).toISOString().slice(0, 10));
    closes.push(closesRaw[i]);
  }
  return { dates, closes };
}

// 先物は上場前の期間だとHTTPエラーになるため、失敗時は空データを返して
// 呼び出し側で現物データへのフォールバックを行えるようにする
async function fetchChartSafe(ticker, params) {
  try {
    return await fetchChart(ticker, params);
  } catch (err) {
    return { dates: [], closes: [] };
  }
}

const MARGIN_BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml",
};

// JPX「信用取引現在高」ページから最新のExcelファイルのURLを見つける
async function findLatestMarginXlsUrl() {
  const res = await fetch(MARGIN_PAGE_URL, { headers: MARGIN_BROWSER_HEADERS });
  if (!res.ok) throw new Error(`JPXページ取得に失敗しました (HTTP ${res.status})`);
  const html = await res.text();

  const matches = [...html.matchAll(/href="(\/markets\/statistics-equities\/margin\/[^"]*?mtseisan(\d{8})00\.xls)"/g)];
  if (matches.length === 0) throw new Error("信用取引現在高のExcelリンクが見つかりません");

  matches.sort((a, b) => Number(a[2]) - Number(b[2]));
  const latest = matches[matches.length - 1];
  return "https://www.jpx.co.jp" + latest[1];
}

// 信用取引現在高(二市場計・委託分)の最新値と前週比をExcelから抽出する
async function fetchMarginBalance() {
  const xlsUrl = await findLatestMarginXlsUrl();
  const xlsRes = await fetch(xlsUrl, { headers: MARGIN_BROWSER_HEADERS });
  if (!xlsRes.ok) throw new Error(`信用取引現在高Excelの取得に失敗しました (HTTP ${xlsRes.status})`);
  const buffer = await xlsRes.arrayBuffer();

  const workbook = XLSX.read(new Uint8Array(buffer), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });

  const titleRow = rows[0]?.[0] || "";
  const dateMatch = String(titleRow).match(/(\d{4}\/\d{1,2}\/\d{1,2})/);
  const asOfDate = dateMatch ? dateMatch[1] : null;

  const totalRowIdx = rows.findIndex((row) => row.some((cell) => typeof cell === "string" && cell.includes("二市場計")));
  if (totalRowIdx < 0) throw new Error("「二市場計」の行が見つかりません");
  const valueRow = rows[totalRowIdx + 1];
  if (!valueRow || !valueRow.some((cell) => typeof cell === "string" && cell.includes("金額"))) {
    throw new Error("金額(百万円)の行が見つかりません");
  }

  // 列位置: [.., "金額Val.", 委託売残高, 前週比, 委託買残高, 前週比, 自己売残高, 前週比, 自己買残高, 前週比, 合計売残高, 前週比, 合計買残高, 前週比] (単位: 百万円)
  const buyBalanceMil = valueRow[5];
  const buyChangeMil = valueRow[6];
  const totalSellMil = valueRow[11];
  const totalBuyMil = valueRow[13];
  if (typeof buyBalanceMil !== "number" || typeof buyChangeMil !== "number") {
    throw new Error("信用買い残高の数値が想定形式と異なります");
  }

  // 信用倍率(貸借倍率) = 合計買残高 ÷ 合計売残高。株温計等で一般的に使われる定義に合わせる
  const ratio = typeof totalBuyMil === "number" && typeof totalSellMil === "number" && totalSellMil > 0
    ? totalBuyMil / totalSellMil
    : null;

  return { asOfDate, buyBalanceOku: buyBalanceMil / 100, buyChangeOku: buyChangeMil / 100, ratio };
}

// JPXのデータは週次更新のため、頻繁な再取得を避けて半日キャッシュする
async function fetchMarginBalanceCached() {
  const cache = caches.default;
  const cacheKey = new Request("https://internal-cache.example/margin-balance-cache-key-v2");
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const data = await fetchMarginBalance();
  const response = new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json", "Cache-Control": "public, max-age=43200" },
  });
  await cache.put(cacheKey, response);
  return data;
}

function parseJpxNumber(cell) {
  if (typeof cell === "number") return cell;
  if (typeof cell === "string" && cell.trim() !== "") return Number(cell.replace(/,/g, ""));
  return NaN;
}

// JPX「投資部門別売買状況(週間・二市場計・金額)」ページから最新のExcelファイルのURLを見つける
async function findLatestInvestorTypeXlsUrl() {
  const res = await fetch(INVESTOR_TYPE_PAGE_URL, { headers: MARGIN_BROWSER_HEADERS });
  if (!res.ok) throw new Error(`JPXページ取得に失敗しました (HTTP ${res.status})`);
  const html = await res.text();

  const matches = [...html.matchAll(/href="(\/markets\/statistics-equities\/investor-type\/[^"]*?stock_val_1_(\d{6})\.xls)"/g)];
  if (matches.length === 0) throw new Error("投資部門別売買状況のExcelリンクが見つかりません");

  matches.sort((a, b) => Number(a[2]) - Number(b[2]));
  const latest = matches[matches.length - 1];
  return "https://www.jpx.co.jp" + latest[1];
}

// 海外投資家の週間売買差引き(二市場計・金額)をExcelから抽出する
async function fetchForeignFlow() {
  const xlsUrl = await findLatestInvestorTypeXlsUrl();
  const xlsRes = await fetch(xlsUrl, { headers: MARGIN_BROWSER_HEADERS });
  if (!xlsRes.ok) throw new Error(`投資部門別売買状況Excelの取得に失敗しました (HTTP ${xlsRes.status})`);
  const buffer = await xlsRes.arrayBuffer();

  const workbook = XLSX.read(new Uint8Array(buffer), { type: "array" });
  const sheet = workbook.Sheets["Tokyo & Nagoya"];
  if (!sheet) throw new Error("「Tokyo & Nagoya」シートが見つかりません");
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });

  const weekLabelRow = rows[3]?.[0] || "";
  const weekMatch = String(weekLabelRow).match(/(\d{4}年\d{1,2}月第\d+週)/);
  const weekLabel = weekMatch ? weekMatch[1] : null;

  const totalRowIdx = rows.findIndex((row) => row[0] === "総　計");
  if (totalRowIdx < 0) throw new Error("「総計」の行が見つかりません");
  const totalRow = rows[totalRowIdx + 2];
  if (!totalRow || totalRow[1] !== "合計") throw new Error("総売買代金(合計)の行が想定形式と異なります");
  const totalValue = parseJpxNumber(totalRow[8]);

  const foreignRowIdx = rows.findIndex((row) => row[0] === "海外投資家");
  if (foreignRowIdx < 0) throw new Error("「海外投資家」の行が見つかりません");
  const foreignBuyRow = rows[foreignRowIdx + 1];
  if (!foreignBuyRow || foreignBuyRow[0] !== "Foreigners") throw new Error("海外投資家(買い)の行が想定形式と異なります");
  const netValue = parseJpxNumber(foreignBuyRow[10]);

  if (!Number.isFinite(totalValue) || !Number.isFinite(netValue) || totalValue === 0) {
    throw new Error("海外投資家フローの数値が想定形式と異なります");
  }

  return { weekLabel, netValueThousandYen: netValue, totalValueThousandYen: totalValue };
}

// JPXのデータは週次更新のため、頻繁な再取得を避けて半日キャッシュする
async function fetchForeignFlowCached() {
  const cache = caches.default;
  const cacheKey = new Request("https://internal-cache.example/foreign-flow-cache-key");
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const data = await fetchForeignFlow();
  const response = new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json", "Cache-Control": "public, max-age=43200" },
  });
  await cache.put(cacheKey, response);
  return data;
}

function scoreForeignFlow(flow) {
  const pctOfTotal = (flow.netValueThousandYen / flow.totalValueThousandYen) * 100;

  // 海外投資家の買い越しは強気材料、売り越しは弱気材料としてそのまま符号を使う
  const score = pctOfTotal * 50;

  const netOku = Math.round(flow.netValueThousandYen / 100000);
  const direction = netOku >= 0 ? "買い越し" : "売り越し";
  const detail = `海外投資家 ${Math.abs(netOku).toLocaleString("ja-JP")}億円の${direction}(二市場計・${flow.weekLabel || "直近週"})`;
  return component("foreign_flow", "海外投資家動向", score, detail);
}

function marginRatioLevel(ratio) {
  if (ratio >= 8) return ["高水準", -30];
  if (ratio >= 6) return ["やや高水準", -10];
  if (ratio > 3) return ["中立", 0];
  if (ratio > 1) return ["低水準", 20];
  return ["売り長(底値圏の可能性)", 40];
}

function scoreMarginBuying(margin) {
  const pctChange = (margin.buyChangeOku / (margin.buyBalanceOku - margin.buyChangeOku)) * 100;

  // 信用買い残の増加は将来の戻り待ち売り圧力の積み上がりとして弱気材料、
  // 減少は売り圧力の後退として強気材料とみなし、符号を反転する
  let score = -pctChange * 25;

  const oku = Math.round(margin.buyBalanceOku).toLocaleString("ja-JP");
  const chg = Math.round(margin.buyChangeOku).toLocaleString("ja-JP");
  let detail = `信用買い残(委託) ${oku}億円(前週比${margin.buyChangeOku >= 0 ? "+" : ""}${chg}億円、${margin.asOfDate}申込み現在)`;

  // 信用倍率(合計買残高÷合計売残高)が高いほど将来の売り圧力の積み上がりとして弱気材料に加点する
  if (typeof margin.ratio === "number") {
    const [levelLabel, levelScore] = marginRatioLevel(margin.ratio);
    score += levelScore;
    detail += ` — 信用倍率${margin.ratio.toFixed(2)}倍(${levelLabel})`;
  }

  return component("margin", "信用買い残", score, detail);
}

function scoreTrend(closes) {
  const sma5 = sma(closes, 5);
  const sma25 = sma(closes, 25);
  const sma75 = sma(closes, 75);

  const shortUp = last(sma5) > last(sma25);
  const midUp = last(sma25) > last(sma75);
  let points = (shortUp ? 50 : -50) + (midUp ? 30 : -30);

  let crossNote = "";
  const diffValid = [];
  for (let i = 0; i < closes.length; i++) {
    if (sma5[i] !== null && sma25[i] !== null) diffValid.push(sma5[i] - sma25[i]);
  }
  if (diffValid.length >= 4) {
    const recent = diffValid.slice(-4);
    const signs = recent.map((v) => Math.sign(v));
    let crossedUp = false;
    let crossedDown = false;
    for (let i = 1; i < signs.length; i++) {
      const d = signs[i] - signs[i - 1];
      if (d > 0) crossedUp = true;
      if (d < 0) crossedDown = true;
    }
    if (crossedUp) {
      points += 20;
      crossNote = "(直近でゴールデンクロス発生)";
    } else if (crossedDown) {
      points -= 20;
      crossNote = "(直近でデッドクロス発生)";
    }
  }

  const detail = `5日線は25日線を${shortUp ? "上" : "下"}回り、25日線は75日線を${midUp ? "上" : "下"}回っています${crossNote}`;
  return component("trend", "移動平均トレンド", points, detail);
}

function scoreRsi(closes) {
  const rsiSeries = rsi(closes, 14);
  const value = last(rsiSeries);
  const score = (value - 50) * 2;

  let state;
  if (value >= 70) state = "買われすぎ水準(反落に注意)";
  else if (value <= 30) state = "売られすぎ水準(反発の可能性)";
  else state = "中立圏";

  const detail = `RSI(14) = ${value.toFixed(1)} — ${state}`;
  return component("rsi", "RSI(相対力指数)", score, detail);
}

function scoreMacd(closes) {
  const { macdLine, signalLine, hist } = macd(closes);
  const histNow = last(hist);
  const window = hist.slice(-20).map((v) => Math.abs(v));
  const recentAvgAbs = Math.max(window.reduce((a, b) => a + b, 0) / window.length, 1e-9);
  const score = (histNow / recentAvgAbs) * 50;

  const above = last(macdLine) > last(signalLine);
  const detail = `MACDはシグナル線を${above ? "上" : "下"}回っています(ヒストグラム: ${histNow >= 0 ? "+" : ""}${histNow.toFixed(1)})`;
  return component("macd", "MACD", score, detail);
}

function pctChangeLast(closes) {
  if (closes.length < 2) return 0;
  const a = closes[closes.length - 2];
  const b = closes[closes.length - 1];
  return (b / a - 1) * 100;
}

function scoreFx(fxCloses) {
  const fxChg = pctChangeLast(fxCloses);
  const score = fxChg * 50;
  const direction = fxChg > 0 ? "円安" : fxChg < 0 ? "円高" : "横ばい";
  const wind = fxChg > 0 ? "追い風" : fxChg < 0 ? "逆風" : "中立";
  const detail = `ドル円 ${fxChg >= 0 ? "+" : ""}${fxChg.toFixed(2)}%(${direction}、輸出企業に${wind})`;
  return component("fx", "為替(ドル円)", score, detail);
}

function scoreVix(vixCloses) {
  const vixChg = pctChangeLast(vixCloses);
  const latestVix = last(vixCloses);

  // VIX上昇(恐怖の高まり)は弱気要因、下落は強気要因として符号を反転
  // VIXは日々の変動率自体が大きい(平常時でも±5%程度動く)ため、他指標より緩やかな係数にする
  let score = -vixChg * 6;
  if (latestVix >= 30) score -= 20;
  else if (latestVix >= 25) score -= 10;
  else if (latestVix <= 15) score += 10;

  let state;
  if (latestVix >= 30) state = "高水準(強い警戒)";
  else if (latestVix >= 20) state = "やや高水準";
  else if (latestVix <= 15) state = "低水準(平常)";
  else state = "中立水準";

  const detail = `VIX ${latestVix.toFixed(1)}(前日比${vixChg >= 0 ? "+" : ""}${vixChg.toFixed(2)}%) — ${state}`;
  return component("vix", "VIX(恐怖指数)", score, detail);
}

function weightedComposite(components) {
  let sum = 0;
  let weightSum = 0;
  for (const c of components) {
    sum += c.score * c.weight;
    weightSum += c.weight;
  }
  return weightSum > 0 ? sum / weightSum : 0;
}

function labelForScore(score) {
  if (score >= 40) return ["強気(上昇優勢)", "up_strong"];
  if (score >= 15) return ["やや強気", "up_weak"];
  if (score > -15) return ["中立", "neutral"];
  if (score > -40) return ["やや弱気", "down_weak"];
  return ["弱気(下落優勢)", "down_strong"];
}

export async function computeSignal() {
  const [nikkei, futures, fx, vix, margin, foreignFlow] = await Promise.all([
    fetchChart(NIKKEI_TICKER, { range: "8mo" }),
    fetchChartSafe(NIKKEI_FUTURES_TICKER, { range: "8mo" }),
    fetchChart(FX_TICKER, { range: "5d" }),
    fetchChart(VIX_TICKER, { range: "5d" }),
    fetchMarginBalanceCached().catch(() => null),
    fetchForeignFlowCached().catch(() => null),
  ]);

  const closes = nikkei.closes;
  const indicatorCloses = futures.closes.length >= INDICATOR_MIN_LEN ? futures.closes : closes;
  const components = [
    scoreTrend(indicatorCloses),
    scoreRsi(indicatorCloses),
    scoreMacd(indicatorCloses),
    scoreFx(fx.closes),
    scoreVix(vix.closes),
  ];
  if (margin) components.push(scoreMarginBuying(margin));
  if (foreignFlow) components.push(scoreForeignFlow(foreignFlow));

  const composite = clip(weightedComposite(components));
  const [label, polarity] = labelForScore(composite);

  const latestClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const latestChangePct = (latestClose / prevClose - 1) * 100;

  const tail = 90;
  const startIdx = Math.max(0, nikkei.dates.length - tail);
  const priceSeries = [];
  for (let i = startIdx; i < nikkei.dates.length; i++) {
    priceSeries.push({ date: nikkei.dates[i], close: Math.round(closes[i] * 100) / 100 });
  }

  const now = new Date();
  const tokyo = new Date(now.getTime() + 9 * 3600 * 1000);
  const updatedAt = tokyo.toISOString().replace("Z", "+09:00");

  return {
    updated_at: updatedAt,
    composite_score: Math.round(composite * 10) / 10,
    label,
    polarity,
    latest_close: Math.round(latestClose * 100) / 100,
    latest_change_pct: Math.round(latestChangePct * 100) / 100,
    components,
    price_series: priceSeries,
  };
}

function findIndexUpTo(dates, dateStr) {
  let idx = -1;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] <= dateStr) idx = i;
    else break;
  }
  return idx;
}

export async function computeHistory(days = 30) {
  const [nikkei, futures, fx, vix] = await Promise.all([
    fetchChart(NIKKEI_TICKER, { range: "8mo" }),
    fetchChartSafe(NIKKEI_FUTURES_TICKER, { range: "8mo" }),
    fetchChart(FX_TICKER, { range: "6mo" }),
    fetchChart(VIX_TICKER, { range: "6mo" }),
  ]);

  const closes = nikkei.closes;
  const dates = nikkei.dates;

  const minIdx = INDICATOR_MIN_LEN;
  const startIdx = Math.max(minIdx, closes.length - days);

  const history = [];
  for (let i = startIdx; i < closes.length; i++) {
    const d = dates[i];
    const sliceCloses = closes.slice(0, i + 1);

    const fxIdx = findIndexUpTo(fx.dates, d);
    const vixIdx = findIndexUpTo(vix.dates, d);
    if (fxIdx < 1 || vixIdx < 1) continue;

    const futuresIdx = findIndexUpTo(futures.dates, d);
    const indicatorCloses = futuresIdx >= INDICATOR_MIN_LEN ? futures.closes.slice(0, futuresIdx + 1) : sliceCloses;

    const components = [
      scoreTrend(indicatorCloses),
      scoreRsi(indicatorCloses),
      scoreMacd(indicatorCloses),
      scoreFx(fx.closes.slice(0, fxIdx + 1)),
      scoreVix(vix.closes.slice(0, vixIdx + 1)),
    ];

    const composite = clip(weightedComposite(components));
    const [label, polarity] = labelForScore(composite);

    history.push({
      date: d,
      score: Math.round(composite * 10) / 10,
      label,
      polarity,
      close: Math.round(closes[i] * 100) / 100,
    });
  }
  return history;
}

function dateToUnix(dateStr) {
  return Math.floor(new Date(dateStr + "T00:00:00Z").getTime() / 1000);
}

export async function computeCrashWindow(centerDateStr, beforeDays = 7, afterDays = 7) {
  const DAY = 24 * 3600;
  const centerUnix = dateToUnix(centerDateStr);
  const nikkeiPeriod1 = centerUnix - 200 * DAY; // SMA75計算分の余裕を持って過去に遡る
  const period2 = centerUnix + (afterDays + 10) * DAY;
  const fxPeriod1 = centerUnix - 60 * DAY;

  const [nikkei, futures, fx, vix] = await Promise.all([
    fetchChart(NIKKEI_TICKER, { period1: nikkeiPeriod1, period2 }),
    fetchChartSafe(NIKKEI_FUTURES_TICKER, { period1: nikkeiPeriod1, period2 }),
    fetchChart(FX_TICKER, { period1: fxPeriod1, period2 }),
    fetchChart(VIX_TICKER, { period1: fxPeriod1, period2 }),
  ]);

  const closes = nikkei.closes;
  const dates = nikkei.dates;

  const centerIdx = findIndexUpTo(dates, centerDateStr);
  if (centerIdx < 75) throw new Error("指定日周辺のデータが不足しています");

  const startIdx = Math.max(75, centerIdx - beforeDays);
  const endIdx = Math.min(dates.length - 1, centerIdx + afterDays);

  const rows = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const d = dates[i];
    const sliceCloses = closes.slice(0, i + 1);

    const fxIdx = findIndexUpTo(fx.dates, d);
    const vixIdx = findIndexUpTo(vix.dates, d);
    if (fxIdx < 1 || vixIdx < 1) continue;

    const futuresIdx = findIndexUpTo(futures.dates, d);
    const indicatorCloses = futuresIdx >= INDICATOR_MIN_LEN ? futures.closes.slice(0, futuresIdx + 1) : sliceCloses;

    const components = [
      scoreTrend(indicatorCloses),
      scoreRsi(indicatorCloses),
      scoreMacd(indicatorCloses),
      scoreFx(fx.closes.slice(0, fxIdx + 1)),
      scoreVix(vix.closes.slice(0, vixIdx + 1)),
    ];

    const composite = clip(weightedComposite(components));
    const [label, polarity] = labelForScore(composite);

    const changePct = i > 0 ? (closes[i] / closes[i - 1] - 1) * 100 : null;

    rows.push({
      date: d,
      score: Math.round(composite * 10) / 10,
      label,
      polarity,
      close: Math.round(closes[i] * 100) / 100,
      change_pct: changePct !== null ? Math.round(changePct * 100) / 100 : null,
      is_center: i === centerIdx,
    });
  }
  return rows;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/crash") {
      const date = url.searchParams.get("date") || "";
      const before = Math.max(1, Math.min(30, parseInt(url.searchParams.get("before") || "7", 10) || 7));
      const after = Math.max(1, Math.min(30, parseInt(url.searchParams.get("after") || "7", 10) || 7));

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return new Response(JSON.stringify({ ok: false, error: "date は YYYY-MM-DD 形式で指定してください" }), {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      const cache = caches.default;
      const cacheKey = new Request(url.origin + `/api/crash-cache-key?date=${date}&before=${before}&after=${after}`, request);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      try {
        const rows = await computeCrashWindow(date, before, after);
        const response = new Response(JSON.stringify({ ok: true, date, before, after, rows }), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=86400",
          },
        });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: String(err.message || err) }), {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/api/history") {
      const days = Math.max(5, Math.min(90, parseInt(url.searchParams.get("days") || "30", 10) || 30));
      const cache = caches.default;
      const cacheKey = new Request(url.origin + "/api/history-cache-key?days=" + days, request);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      try {
        const history = await computeHistory(days);
        const response = new Response(JSON.stringify({ ok: true, days, history }), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=1800",
          },
        });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: String(err.message || err) }), {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/api/signal") {
      const cache = caches.default;
      const cacheKey = new Request(url.origin + "/api/signal-cache-key", request);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      try {
        const data = await computeSignal();
        const response = new Response(JSON.stringify({ ok: true, ...data }), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=300",
          },
        });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: String(err.message || err) }), {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
