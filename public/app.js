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

  async function loadSignal() {
    const updatedEl = document.getElementById("updated");
    updatedEl.textContent = "更新中…";
    try {
      const res = await fetch("/api/signal");
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "取得エラー");

      renderHero(data);
      renderMeter(data);
      renderBreakdown(data);
      drawSparkline(data.price_series);

      const updated = new Date(data.updated_at);
      updatedEl.textContent = "最終更新: " + updated.toLocaleString("ja-JP");
    } catch (err) {
      updatedEl.textContent = "取得に失敗しました: " + err.message;
    }
  }

  document.getElementById("refreshBtn").addEventListener("click", loadSignal);
  window.addEventListener("resize", () => {
    if (lastPriceSeries) drawSparkline(lastPriceSeries);
  });

  loadSignal();
})();
