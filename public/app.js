(function () {
  "use strict";

  const POLARITY_CLASS = {
    up_strong: "up",
    up_weak: "up",
    up: "up",
    down_strong: "down",
    down_weak: "down",
    down: "down",
    neutral: "neutral",
  };

  const STATUS_WORD = {
    up: "上昇要因",
    down: "下落要因",
    neutral: "中立",
  };

  const ARROW = { up: "▲", down: "▼", neutral: "●" };

  function fmtNumber(n, digits) {
    return Number(n).toLocaleString("ja-JP", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function renderHero(data) {
    const cls = POLARITY_CLASS[data.polarity] || "neutral";
    const arrow = document.getElementById("heroArrow");
    const figure = document.getElementById("heroFigure");
    const label = document.getElementById("heroLabel");
    const priceLine = document.getElementById("priceLine");

    arrow.textContent = ARROW[cls];
    arrow.className = "hero-arrow " + cls;

    const scoreText = (data.composite_score > 0 ? "+" : "") + data.composite_score;
    figure.textContent = scoreText;

    label.textContent = data.label;
    label.className = "hero-sub " + cls;

    const chgCls = data.latest_change_pct >= 0 ? "up" : "down";
    const chgSign = data.latest_change_pct >= 0 ? "+" : "";
    priceLine.innerHTML = "";
    const priceSpan = document.createElement("span");
    priceSpan.textContent = "終値 " + fmtNumber(data.latest_close, 2) + " 円 ";
    const chgSpan = document.createElement("span");
    chgSpan.className = "chg " + chgCls;
    chgSpan.textContent = "(" + chgSign + fmtNumber(data.latest_change_pct, 2) + "%)";
    priceLine.appendChild(priceSpan);
    priceLine.appendChild(chgSpan);
  }

  function renderMeter(data) {
    const score = Math.max(-100, Math.min(100, data.composite_score));
    const fill = document.getElementById("meterFill");
    const marker = document.getElementById("meterMarker");

    const halfPct = Math.abs(score) / 2; // 0..50, half of the track width
    if (score >= 0) {
      fill.className = "meter-fill up";
      fill.style.left = "50%";
      fill.style.width = halfPct + "%";
    } else {
      fill.className = "meter-fill down";
      fill.style.left = (50 - halfPct) + "%";
      fill.style.width = halfPct + "%";
    }
    marker.style.left = (50 + score / 2) + "%";
  }

  function renderBreakdown(data) {
    const list = document.getElementById("breakdownList");
    list.innerHTML = "";
    data.components.forEach((c) => {
      const cls = POLARITY_CLASS[c.polarity] || "neutral";

      const item = document.createElement("div");
      item.className = "breakdown-item";

      const icon = document.createElement("div");
      icon.className = "breakdown-icon " + cls;
      icon.textContent = ARROW[cls];
      item.appendChild(icon);

      const body = document.createElement("div");
      body.className = "breakdown-body";

      const top = document.createElement("div");
      top.className = "breakdown-top";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = c.label;
      const statusSpan = document.createElement("span");
      statusSpan.className = "status-word " + cls;
      statusSpan.textContent = STATUS_WORD[cls];
      top.appendChild(nameSpan);
      top.appendChild(statusSpan);
      body.appendChild(top);

      const detail = document.createElement("div");
      detail.className = "breakdown-detail";
      detail.textContent = c.detail;
      body.appendChild(detail);

      const weight = document.createElement("div");
      weight.className = "breakdown-weight";
      weight.textContent =
        "スコア " + (c.score > 0 ? "+" : "") + c.score + " / 重み " + Math.round(c.weight * 100) + "%";
      body.appendChild(weight);

      item.appendChild(body);
      list.appendChild(item);
    });
  }

  // "切りのいい" 目盛りを計算する(Heckbertのnice numbersアルゴリズム)
  function niceNumber(range, round) {
    if (range <= 0) return 1;
    const exponent = Math.floor(Math.log10(range));
    const fraction = range / Math.pow(10, exponent);
    let niceFraction;
    if (round) {
      if (fraction < 1.5) niceFraction = 1;
      else if (fraction < 3) niceFraction = 2;
      else if (fraction < 7) niceFraction = 5;
      else niceFraction = 10;
    } else {
      if (fraction <= 1) niceFraction = 1;
      else if (fraction <= 2) niceFraction = 2;
      else if (fraction <= 5) niceFraction = 5;
      else niceFraction = 10;
    }
    return niceFraction * Math.pow(10, exponent);
  }

  function niceTicks(min, max, maxTicks) {
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const range = niceNumber(max - min, false);
    const step = niceNumber(range / (maxTicks - 1), true);
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = niceMin; v <= niceMax + step * 1e-6; v += step) ticks.push(Math.round(v * 100) / 100);
    return { ticks, niceMin, niceMax };
  }

  const BAND_VAR = {
    up_strong: "--up-wash-strong",
    up_weak: "--up-wash-weak",
    neutral: "--neutral-mid",
    down_weak: "--down-wash-weak",
    down_strong: "--down-wash-strong",
  };

  const chartRegistry = {};

  // 日経平均の価格ライン(切りのいい数字の軸)と
  // シグナルの状態(横軸の色帯: 強気=青〜弱気=赤)を1つのチャートに重ねて描画する
  function drawChart(svgId, wrapId, tooltipId, rows, options = {}) {
    chartRegistry[svgId] = { rows, wrapId, tooltipId, options };

    const svg = document.getElementById(svgId);
    const wrap = document.getElementById(wrapId);
    const width = wrap.clientWidth || 320;
    const height = options.height || 200;
    const pad = { top: 10, right: 10, bottom: 8, left: 54 };

    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.innerHTML = "";

    if (!rows || rows.length < 2) return;

    const values = rows.map((r) => r.close);
    const { ticks, niceMin, niceMax } = niceTicks(Math.min(...values), Math.max(...values), 5);

    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const xScale = (i) => pad.left + (i / (rows.length - 1)) * innerW;
    const yScale = (v) => pad.top + innerH - ((v - niceMin) / (niceMax - niceMin)) * innerH;

    const textPrimary = getComputedStyle(document.documentElement).getPropertyValue("--text-primary").trim();
    const textSecondary = getComputedStyle(document.documentElement).getPropertyValue("--text-secondary").trim();
    const textMuted = getComputedStyle(document.documentElement).getPropertyValue("--text-muted").trim();
    const gridlineColor = getComputedStyle(document.documentElement).getPropertyValue("--gridline").trim();
    const seriesColor = getComputedStyle(document.documentElement).getPropertyValue("--series-blue").trim();
    const upColor = getComputedStyle(document.documentElement).getPropertyValue("--up").trim();
    const downColor = getComputedStyle(document.documentElement).getPropertyValue("--down").trim();

    // シグナルスコア(-100〜+100)は価格とスケールが異なるため、
    // 同じプロット領域の高さいっぱいに正規化した参考ラインとして重ねる(軸は表示しない)
    const scoreYScale = (v) => pad.top + innerH - ((v + 100) / 200) * innerH;

    const ns = "http://www.w3.org/2000/svg";

    // 背景の色帯(その日のシグナル状態)
    const halfStep = rows.length > 1 ? (xScale(1) - xScale(0)) / 2 : innerW / 2;
    rows.forEach((r, i) => {
      const varName = BAND_VAR[r.polarity];
      if (!varName) return;
      const x0 = Math.max(pad.left, xScale(i) - halfStep);
      const x1 = Math.min(width - pad.right, xScale(i) + halfStep);
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("x", x0.toFixed(1));
      rect.setAttribute("y", pad.top);
      rect.setAttribute("width", Math.max(0, x1 - x0).toFixed(1));
      rect.setAttribute("height", innerH);
      rect.style.fill = `var(${varName})`;
      svg.appendChild(rect);
    });

    // 横グリッド線 + 切りのいい数字の軸ラベル
    ticks.forEach((t) => {
      const y = yScale(t);
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", pad.left);
      line.setAttribute("x2", width - pad.right);
      line.setAttribute("y1", y.toFixed(1));
      line.setAttribute("y2", y.toFixed(1));
      line.setAttribute("stroke", gridlineColor);
      line.setAttribute("stroke-width", "1");
      svg.appendChild(line);

      const label = document.createElementNS(ns, "text");
      label.setAttribute("x", pad.left - 6);
      label.setAttribute("y", (y + 3).toFixed(1));
      label.setAttribute("font-size", "10px");
      label.setAttribute("text-anchor", "end");
      label.setAttribute("fill", textMuted);
      label.textContent = Math.round(t).toLocaleString("ja-JP");
      svg.appendChild(label);
    });

    // 日経平均 価格ライン
    let linePath = "";
    rows.forEach((r, i) => {
      const x = xScale(i);
      const y = yScale(r.close);
      linePath += (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1) + " ";
    });
    const line = document.createElementNS(ns, "path");
    line.setAttribute("d", linePath.trim());
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", seriesColor);
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-linejoin", "round");
    line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);

    // シグナルスコアの0ライン(中立の基準線)
    const zeroY = scoreYScale(0);
    const zeroLine = document.createElementNS(ns, "line");
    zeroLine.setAttribute("x1", pad.left);
    zeroLine.setAttribute("x2", width - pad.right);
    zeroLine.setAttribute("y1", zeroY.toFixed(1));
    zeroLine.setAttribute("y2", zeroY.toFixed(1));
    zeroLine.setAttribute("stroke", textMuted);
    zeroLine.setAttribute("stroke-width", "1");
    zeroLine.setAttribute("stroke-dasharray", "2 2");
    svg.appendChild(zeroLine);

    // シグナルスコアの参考ライン(破線、価格とは別スケール)
    let scoreLinePath = "";
    rows.forEach((r, i) => {
      const x = xScale(i);
      const y = scoreYScale(r.score);
      scoreLinePath += (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1) + " ";
    });
    const scoreLine = document.createElementNS(ns, "path");
    scoreLine.setAttribute("d", scoreLinePath.trim());
    scoreLine.setAttribute("fill", "none");
    scoreLine.setAttribute("stroke", textSecondary);
    scoreLine.setAttribute("stroke-width", "1.5");
    scoreLine.setAttribute("stroke-dasharray", "4 3");
    scoreLine.setAttribute("stroke-linejoin", "round");
    scoreLine.setAttribute("stroke-linecap", "round");
    svg.appendChild(scoreLine);

    const lastScoreRow = rows[rows.length - 1];
    const lastScorePolarity = POLARITY_CLASS[lastScoreRow.polarity] || "neutral";
    const scoreDotColor = lastScorePolarity === "up" ? upColor : lastScorePolarity === "down" ? downColor : textSecondary;
    const scoreDot = document.createElementNS(ns, "circle");
    scoreDot.setAttribute("cx", xScale(rows.length - 1));
    scoreDot.setAttribute("cy", scoreYScale(lastScoreRow.score));
    scoreDot.setAttribute("r", "3.5");
    scoreDot.setAttribute("fill", scoreDotColor);
    svg.appendChild(scoreDot);

    // 強調したい地点(暴落当日など)にリングを表示
    if (typeof options.highlightIndex === "number" && options.highlightIndex >= 0) {
      const hRow = rows[options.highlightIndex];
      const hx = xScale(options.highlightIndex);
      const hy = yScale(hRow.close);
      const ring = document.createElementNS(ns, "circle");
      ring.setAttribute("cx", hx);
      ring.setAttribute("cy", hy);
      ring.setAttribute("r", "7");
      ring.setAttribute("fill", "none");
      ring.setAttribute("stroke", textPrimary);
      ring.setAttribute("stroke-width", "2");
      svg.appendChild(ring);
    }

    // 末端マーカー
    const lastRow = rows[rows.length - 1];
    const lastX = xScale(rows.length - 1);
    const lastY = yScale(lastRow.close);
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", lastX);
    dot.setAttribute("cy", lastY);
    dot.setAttribute("r", "4");
    dot.setAttribute("fill", seriesColor);
    svg.appendChild(dot);

    // クロスヘア(非表示状態で用意)
    const crosshair = document.createElementNS(ns, "line");
    crosshair.setAttribute("y1", pad.top);
    crosshair.setAttribute("y2", height - pad.bottom);
    crosshair.setAttribute("stroke", "var(--baseline)");
    crosshair.setAttribute("stroke-width", "1");
    crosshair.setAttribute("visibility", "hidden");
    svg.appendChild(crosshair);

    // ポインタ用の透明な当たり判定レイヤー
    const hit = document.createElementNS(ns, "rect");
    hit.setAttribute("x", "0");
    hit.setAttribute("y", "0");
    hit.setAttribute("width", width);
    hit.setAttribute("height", height);
    hit.setAttribute("fill", "transparent");
    svg.appendChild(hit);

    const tooltip = document.getElementById(tooltipId);

    function handleMove(clientX) {
      const rect = svg.getBoundingClientRect();
      const relX = clientX - rect.left;
      let idx = Math.round(((relX - pad.left) / innerW) * (rows.length - 1));
      idx = Math.max(0, Math.min(rows.length - 1, idx));
      const point = rows[idx];
      const x = xScale(idx);
      const y = yScale(point.close);

      crosshair.setAttribute("x1", x);
      crosshair.setAttribute("x2", x);
      crosshair.setAttribute("visibility", "visible");

      tooltip.hidden = false;
      tooltip.innerHTML = "";

      const dateDiv = document.createElement("div");
      dateDiv.textContent = point.date + (point.is_center ? " ★" : "");
      const valDiv = document.createElement("div");
      valDiv.className = "val";
      valDiv.textContent = fmtNumber(point.close, 0) + "円";
      const subDiv = document.createElement("div");
      let subText = point.label + "(" + (point.score > 0 ? "+" : "") + point.score + ")";
      if (typeof point.change_pct === "number") {
        subText += "  前日比" + (point.change_pct >= 0 ? "+" : "") + point.change_pct + "%";
      }
      subDiv.textContent = subText;
      tooltip.appendChild(dateDiv);
      tooltip.appendChild(valDiv);
      tooltip.appendChild(subDiv);

      const wrapRect = wrap.getBoundingClientRect();
      tooltip.style.left = (x / width) * wrapRect.width + "px";
      tooltip.style.top = (y / height) * height + "px";
    }

    function handleLeave() {
      crosshair.setAttribute("visibility", "hidden");
      tooltip.hidden = true;
    }

    hit.addEventListener("pointermove", (e) => handleMove(e.clientX));
    hit.addEventListener("pointerdown", (e) => handleMove(e.clientX));
    hit.addEventListener("pointerleave", handleLeave);
  }

  // キャッシュを避けて必ずサーバーへ再取得しにいくためのクエリ
  function cacheBust(url) {
    return url + (url.includes("?") ? "&" : "?") + "_=" + Date.now();
  }

  async function loadSignal() {
    const updatedEl = document.getElementById("updated");
    updatedEl.textContent = "更新中…";
    try {
      const [signalRes, historyRes] = await Promise.all([
        fetch(cacheBust("/api/signal"), { cache: "no-store" }),
        fetch(cacheBust("/api/history?days=30"), { cache: "no-store" }),
      ]);
      const data = await signalRes.json();
      if (!data.ok) throw new Error(data.error || "取得エラー");

      renderHero(data);
      renderMeter(data);
      renderBreakdown(data);

      const historyData = await historyRes.json();
      if (historyData.ok) {
        drawChart("historyChart", "historyWrap", "historyTooltip", historyData.history);
      }

      const updated = new Date(data.updated_at);
      updatedEl.textContent = "最終更新: " + updated.toLocaleString("ja-JP");
    } catch (err) {
      updatedEl.textContent = "取得に失敗しました: " + err.message;
    }
  }

  function renderCrashTable(rows) {
    const table = document.getElementById("crashTable");
    table.innerHTML = "";
    rows.forEach((r) => {
      const cls = POLARITY_CLASS[r.polarity] || "neutral";

      const row = document.createElement("div");
      row.className = "crash-row" + (r.is_center ? " crash-row-center" : "");

      const dateSpan = document.createElement("span");
      dateSpan.className = "crash-date";
      dateSpan.textContent = r.date + (r.is_center ? " ★" : "");
      row.appendChild(dateSpan);

      const chgSpan = document.createElement("span");
      chgSpan.className = "crash-chg " + (r.change_pct >= 0 ? "up" : "down");
      chgSpan.textContent = (r.change_pct >= 0 ? "+" : "") + r.change_pct + "%";
      row.appendChild(chgSpan);

      const scoreSpan = document.createElement("span");
      scoreSpan.className = "crash-score " + cls;
      scoreSpan.textContent = (r.score > 0 ? "+" : "") + r.score;
      row.appendChild(scoreSpan);

      const labelSpan = document.createElement("span");
      labelSpan.className = "crash-label " + cls;
      labelSpan.textContent = r.label;
      row.appendChild(labelSpan);

      table.appendChild(row);
    });
  }

  async function loadCrash() {
    const select = document.getElementById("crashSelect");
    const date = select.value;
    const statusEl = document.getElementById("crashStatus");
    statusEl.textContent = "読み込み中…";
    try {
      const res = await fetch(`/api/crash?date=${date}&before=7&after=7`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "取得エラー");
      const centerIndex = data.rows.findIndex((r) => r.is_center);
      drawChart("crashChart", "crashChartWrap", "crashTooltip", data.rows, {
        highlightIndex: centerIndex,
      });
      renderCrashTable(data.rows);
      statusEl.textContent = "";
    } catch (err) {
      statusEl.textContent = "取得に失敗しました: " + err.message;
    }
  }

  document.getElementById("refreshBtn").addEventListener("click", loadSignal);
  document.getElementById("crashSelect").addEventListener("change", loadCrash);
  window.addEventListener("resize", () => {
    Object.entries(chartRegistry).forEach(([svgId, c]) => {
      drawChart(svgId, c.wrapId, c.tooltipId, c.rows, c.options);
    });
  });

  loadSignal();
  loadCrash();

  // 手動更新を待たずに最新状態へ追従できるよう、定期的に再取得する
  setInterval(loadSignal, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadSignal();
  });
})();
