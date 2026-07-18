/**
 * 日経平均シグナル計算 — Cloudflare Workers版
 * signal_engine.py と同じロジック(重み・しきい値)をJavaScriptに移植。
 */

const NIKKEI_TICKER = "^N225";
const FX_TICKER = "JPY=X";
const VIX_TICKER = "^VIX";

const WEIGHTS = {
  trend: 0.35,
  rsi: 0.15,
  macd: 0.22,
  fx: 0.16,
  vix: 0.12,
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
  const [nikkei, fx, vix] = await Promise.all([
    fetchChart(NIKKEI_TICKER, { range: "8mo" }),
    fetchChart(FX_TICKER, { range: "5d" }),
    fetchChart(VIX_TICKER, { range: "5d" }),
  ]);

  const closes = nikkei.closes;
  const components = [
    scoreTrend(closes),
    scoreRsi(closes),
    scoreMacd(closes),
    scoreFx(fx.closes),
    scoreVix(vix.closes),
  ];

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
  const [nikkei, fx, vix] = await Promise.all([
    fetchChart(NIKKEI_TICKER, { range: "8mo" }),
    fetchChart(FX_TICKER, { range: "6mo" }),
    fetchChart(VIX_TICKER, { range: "6mo" }),
  ]);

  const closes = nikkei.closes;
  const dates = nikkei.dates;

  const minIdx = 75; // SMA75に必要な最低本数
  const startIdx = Math.max(minIdx, closes.length - days);

  const history = [];
  for (let i = startIdx; i < closes.length; i++) {
    const d = dates[i];
    const sliceCloses = closes.slice(0, i + 1);

    const fxIdx = findIndexUpTo(fx.dates, d);
    const vixIdx = findIndexUpTo(vix.dates, d);
    if (fxIdx < 1 || vixIdx < 1) continue;

    const components = [
      scoreTrend(sliceCloses),
      scoreRsi(sliceCloses),
      scoreMacd(sliceCloses),
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

  const [nikkei, fx, vix] = await Promise.all([
    fetchChart(NIKKEI_TICKER, { period1: nikkeiPeriod1, period2 }),
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

    const components = [
      scoreTrend(sliceCloses),
      scoreRsi(sliceCloses),
      scoreMacd(sliceCloses),
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
