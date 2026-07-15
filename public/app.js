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

  let lastPriceSeries = null;
  let lastHistory = null;

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

  function drawSparkline(series) {
    lastPriceSeries = series;
    const svg = document.getElementById("sparkline");
    const wrap = document.getElementById("sparklineWrap");
    const width = wrap.clientWidth || 320;
    const height = 160;
    const pad = { top: 12, right: 8, bottom: 8, left: 8 };

    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.innerHTML = "";

    if (!series || series.length < 2) return;

    const closes = series.map((d) => d.close);
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const range = max - min || 1;
    const padY = range * 0.08;
    const yMin = min - padY;
    const yMax = max + padY;

    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;

    const xScale = (i) => pad.left + (i / (series.length - 1)) * innerW;
    const yScale = (v) => pad.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

    let linePath = "";
    series.forEach((d, i) => {
      const x = xScale(i);
      const y = yScale(d.close);
      linePath += (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1) + " ";
    });

    const baseline = pad.top + innerH;
    const areaPath =
      linePath + `L${xScale(series.length - 1).toFixed(1)},${baseline} L${xScale(0).toFixed(1)},${baseline} Z`;

    const seriesColor = getComputedStyle(document.documentElement).getPropertyValue("--series-blue").trim();

    const ns = "http://www.w3.org/2000/svg";

    const area = document.createElementNS(ns, "path");
    area.setAttribute("d", areaPath);
    area.setAttribute("fill", seriesColor);
    area.setAttribute("fill-opacity", "0.10");
    area.setAttribute("stroke", "none");
    svg.appendChild(area);

    const line = document.createElementNS(ns, "path");
    line.setAttribute("d", linePath.trim());
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", seriesColor);
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-linejoin", "round");
    line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);

    // 末端マーカー
    const lastX = xScale(series.length - 1);
    const lastY = yScale(series[series.length - 1].close);
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", lastX);
    dot.setAttribute("cy", lastY);
    dot.setAttribute("r", "4");
    dot.setAttribute("fill", seriesColor);
    svg.appendChild(dot);

    // クロスヘア(非表示状態で用意)
    const crosshair = document.createElementNS(ns, "line");
    crosshair.setAttribute("y1", pad.top);
    crosshair.setAttribute("y2", baseline);
    crosshair.setAttribute("stroke", "var(--baseline)");
    crosshair.setAttribute("stroke-width", "1");
    crosshair.setAttribute("visibility", "hidden");
    crosshair.setAttribute("id", "crosshairLine");
    svg.appendChild(crosshair);

    // ポインタ用の透明な当たり判定レイヤー
    const hit = document.createElementNS(ns, "rect");
    hit.setAttribute("x", "0");
    hit.setAttribute("y", "0");
    hit.setAttribute("width", width);
    hit.setAttribute("height", height);
    hit.setAttribute("fill", "transparent");
    svg.appendChild(hit);

    const tooltip = document.getElementById("chartTooltip");

    function handleMove(clientX) {
      const rect = svg.getBoundingClientRect();
      const relX = clientX - rect.left;
      let idx = Math.round(((relX - pad.left) / innerW) * (series.length - 1));
      idx = Math.max(0, Math.min(series.length - 1, idx));
      const point = series[idx];
      const x = xScale(idx);
      const y = yScale(point.close);

      crosshair.setAttribute("x1", x);
      crosshair.setAttribute("x2", x);
      crosshair.setAttribute("visibility", "visible");

      tooltip.hidden = false;
      tooltip.innerHTML = "";
      const dateDiv = document.createElement("div");
      dateDiv.textContent = point.date;
      const valDiv = document.createElement("div");
      valDiv.className = "val";
      valDiv.textContent = fmtNumber(point.close, 0) + " 円";
      tooltip.appendChild(dateDiv);
      tooltip.appendChild(valDiv);

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

  function drawHistoryChart(history) {
    lastHistory = history;
    const svg = document.getElementById("historyChart");
    const wrap = document.getElementById("historyWrap");
    const width = wrap.clientWidth || 320;
    const height = 140;
    const pad = { top: 12, right: 8, bottom: 8, left: 8 };

    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.innerHTML = "";

    if (!history || history.length < 2) return;

    const yMin = -100;
    const yMax = 100;
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;

    const xScale = (i) => pad.left + (i / (history.length - 1)) * innerW;
    const yScale = (v) => pad.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;
    const baselineY = yScale(0);

    let linePath = "";
    history.forEach((d, i) => {
      const x = xScale(i);
      const y = yScale(d.score);
      linePath += (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1) + " ";
    });
    linePath = linePath.trim();

    const lastX = xScale(history.length - 1);
    const firstX = xScale(0);
    const areaPath = `${linePath} L${lastX.toFixed(1)},${baselineY.toFixed(1)} L${firstX.toFixed(1)},${baselineY.toFixed(1)} Z`;

    const upColor = getComputedStyle(document.documentElement).getPropertyValue("--up").trim();
    const downColor = getComputedStyle(document.documentElement).getPropertyValue("--down").trim();
    const textPrimary = getComputedStyle(document.documentElement).getPropertyValue("--text-primary").trim();
    const baselineColor = getComputedStyle(document.documentElement).getPropertyValue("--baseline").trim();

    const ns = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(ns, "defs");
    const clipUpId = "historyClipUp";
    const clipDownId = "historyClipDown";

    const clipUp = document.createElementNS(ns, "clipPath");
    clipUp.setAttribute("id", clipUpId);
    const clipUpRect = document.createElementNS(ns, "rect");
    clipUpRect.setAttribute("x", "0");
    clipUpRect.setAttribute("y", "0");
    clipUpRect.setAttribute("width", width);
    clipUpRect.setAttribute("height", Math.max(baselineY, 0));
    clipUp.appendChild(clipUpRect);

    const clipDown = document.createElementNS(ns, "clipPath");
    clipDown.setAttribute("id", clipDownId);
    const clipDownRect = document.createElementNS(ns, "rect");
    clipDownRect.setAttribute("x", "0");
    clipDownRect.setAttribute("y", baselineY);
    clipDownRect.setAttribute("width", width);
    clipDownRect.setAttribute("height", Math.max(height - baselineY, 0));
    clipDown.appendChild(clipDownRect);

    defs.appendChild(clipUp);
    defs.appendChild(clipDown);
    svg.appendChild(defs);

    const areaUp = document.createElementNS(ns, "path");
    areaUp.setAttribute("d", areaPath);
    areaUp.setAttribute("fill", upColor);
    areaUp.setAttribute("fill-opacity", "0.10");
    areaUp.setAttribute("stroke", "none");
    areaUp.setAttribute("clip-path", `url(#${clipUpId})`);
    svg.appendChild(areaUp);

    const areaDown = document.createElementNS(ns, "path");
    areaDown.setAttribute("d", areaPath);
    areaDown.setAttribute("fill", downColor);
    areaDown.setAttribute("fill-opacity", "0.10");
    areaDown.setAttribute("stroke", "none");
    areaDown.setAttribute("clip-path", `url(#${clipDownId})`);
    svg.appendChild(areaDown);

    const baseline = document.createElementNS(ns, "line");
    baseline.setAttribute("x1", pad.left);
    baseline.setAttribute("x2", width - pad.right);
    baseline.setAttribute("y1", baselineY);
    baseline.setAttribute("y2", baselineY);
    baseline.setAttribute("stroke", baselineColor);
    baseline.setAttribute("stroke-width", "1");
    svg.appendChild(baseline);

    const textMuted = getComputedStyle(document.documentElement).getPropertyValue("--text-muted").trim();
    const upLabel = document.createElementNS(ns, "text");
    upLabel.setAttribute("x", pad.left);
    upLabel.setAttribute("y", pad.top + 10);
    upLabel.setAttribute("font-size", "11px");
    upLabel.setAttribute("fill", textMuted);
    upLabel.textContent = "強気";
    svg.appendChild(upLabel);

    const downLabel = document.createElementNS(ns, "text");
    downLabel.setAttribute("x", pad.left);
    downLabel.setAttribute("y", height - pad.bottom - 2);
    downLabel.setAttribute("font-size", "11px");
    downLabel.setAttribute("fill", textMuted);
    downLabel.textContent = "弱気";
    svg.appendChild(downLabel);

    const line = document.createElementNS(ns, "path");
    line.setAttribute("d", linePath);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", textPrimary);
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-linejoin", "round");
    line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);

    const lastY = yScale(history[history.length - 1].score);
    const lastPolarity = history[history.length - 1].polarity;
    const lastDotColor = lastPolarity === "up" ? upColor : lastPolarity === "down" ? downColor : textPrimary;
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", lastX);
    dot.setAttribute("cy", lastY);
    dot.setAttribute("r", "4");
    dot.setAttribute("fill", lastDotColor);
    svg.appendChild(dot);

    const crosshair = document.createElementNS(ns, "line");
    crosshair.setAttribute("y1", pad.top);
    crosshair.setAttribute("y2", height - pad.bottom);
    crosshair.setAttribute("stroke", baselineColor);
    crosshair.setAttribute("stroke-width", "1");
    crosshair.setAttribute("visibility", "hidden");
    svg.appendChild(crosshair);

    const hit = document.createElementNS(ns, "rect");
    hit.setAttribute("x", "0");
    hit.setAttribute("y", "0");
    hit.setAttribute("width", width);
    hit.setAttribute("height", height);
    hit.setAttribute("fill", "transparent");
    svg.appendChild(hit);

    const tooltip = document.getElementById("historyTooltip");

    function handleMove(clientX) {
      const rect = svg.getBoundingClientRect();
      const relX = clientX - rect.left;
      let idx = Math.round(((relX - pad.left) / innerW) * (history.length - 1));
      idx = Math.max(0, Math.min(history.length - 1, idx));
      const point = history[idx];
      const x = xScale(idx);
      const y = yScale(point.score);

      crosshair.setAttribute("x1", x);
      crosshair.setAttribute("x2", x);
      crosshair.setAttribute("visibility", "visible");

      tooltip.hidden = false;
      tooltip.innerHTML = "";
      const dateDiv = document.createElement("div");
      dateDiv.textContent = point.date + "(" + point.label + ")";
      const valDiv = document.createElement("div");
      valDiv.className = "val";
      valDiv.textContent = (point.score > 0 ? "+" : "") + point.score;
      tooltip.appendChild(dateDiv);
      tooltip.appendChild(valDiv);

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

  async function loadSignal() {
    const updatedEl = document.getElementById("updated");
    updatedEl.textContent = "更新中…";
    try {
      const [signalRes, historyRes] = await Promise.all([fetch("/api/signal"), fetch("/api/history?days=30")]);
      const data = await signalRes.json();
      if (!data.ok) throw new Error(data.error || "取得エラー");

      renderHero(data);
      renderMeter(data);
      renderBreakdown(data);
      drawSparkline(data.price_series);

      const historyData = await historyRes.json();
      if (historyData.ok) drawHistoryChart(historyData.history);

      const updated = new Date(data.updated_at);
      updatedEl.textContent = "最終更新: " + updated.toLocaleString("ja-JP");
    } catch (err) {
      updatedEl.textContent = "取得に失敗しました: " + err.message;
    }
  }

  document.getElementById("refreshBtn").addEventListener("click", loadSignal);
  window.addEventListener("resize", () => {
    if (lastPriceSeries) drawSparkline(lastPriceSeries);
    if (lastHistory) drawHistoryChart(lastHistory);
  });

  loadSignal();
})();
