/**
 * 日経平均シグナル計算 — Cloudflare Workers版
 * signal_engine.py と同じロジック(重み・しきい値)をJavaScriptに移植。
 */

const NIKKEI_TICKER = "^N225";
const DOW_TICKER = "^DJI";
const SP500_TICKER = "^GSPC";
const FX_TICKER = "JPY=X";

const WEIGHTS = {
  trend: 0.30,
  rsi: 0.15,
  macd: 0.20,
  us_market: 0.20,
  fx: 0.15,
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

async function fetchChart(ticker, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=1d`;
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

function scoreUsMarket(dowCloses, spCloses) {
  const dowChg = pctChangeLast(dowCloses);
  const spChg = pctChangeLast(spCloses);
  const avgChg = (dowChg + spChg) / 2;
  const score = avgChg * 40;
  const detail = `NYダウ ${dowChg >= 0 ? "+" : ""}${dowChg.toFixed(2)}% / S&P500 ${spChg >= 0 ? "+" : ""}${spChg.toFixed(2)}%(前営業日比)`;
  return component("us_market", "米国市場の動き", score, detail);
}

function scoreFx(fxCloses) {
  const fxChg = pctChangeLast(fxCloses);
  const score = fxChg * 50;
  const direction = fxChg > 0 ? "円安" : fxChg < 0 ? "円高" : "横ばい";
  const wind = fxChg > 0 ? "追い風" : fxChg < 0 ? "逆風" : "中立";
  const detail = `ドル円 ${fxChg >= 0 ? "+" : ""}${fxChg.toFixed(2)}%(${direction}、輸出企業に${wind})`;
  return component("fx", "為替(ドル円)", score, detail);
}

function labelForScore(score) {
  if (score >= 40) return ["強気(上昇優勢)", "up_strong"];
  if (score >= 15) return ["やや強気", "up_weak"];
  if (score > -15) return ["中立", "neutral"];
  if (score > -40) return ["やや弱気", "down_weak"];
  return ["弱気(下落優勢)", "down_strong"];
}

export async function computeSignal() {
  const [nikkei, dow, sp, fx] = await Promise.all([
    fetchChart(NIKKEI_TICKER, "8mo"),
    fetchChart(DOW_TICKER, "5d"),
    fetchChart(SP500_TICKER, "5d"),
    fetchChart(FX_TICKER, "5d"),
  ]);

  const closes = nikkei.closes;
  const components = [
    scoreTrend(closes),
    scoreRsi(closes),
    scoreMacd(closes),
    scoreUsMarket(dow.closes, sp.closes),
    scoreFx(fx.closes),
  ];

  let composite = 0;
  for (const c of components) composite += c.score * WEIGHTS[c.key];
  composite = clip(composite);
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
