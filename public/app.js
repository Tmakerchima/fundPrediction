const state = { code: null, horizon: 20, risk: "balanced", range: 252, data: null, searchTimer: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const fmtPercent = (value, digits = 2) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
const fmtNumber = (value, digits = 4) => Number(value).toFixed(digits);
const escapeHtml = (text) => String(text).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 4800);
}

function setLoading(loading) {
  $("#loadingOverlay").classList.toggle("hidden", !loading);
}

async function api(path) {
  const response = await fetch(path);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

async function postApi(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

function renderFundLlmPanel() {
  const dashboard = $("#dashboard");
  dashboard.querySelector(".fund-llm-panel")?.remove();
  const panel = document.createElement("section");
  panel.className = "panel fund-llm-panel";
  panel.innerHTML = `<span class="section-kicker">QWEN EVIDENCE REVIEW · 不修改量化预测</span><h3>基金季报、公告与新闻审查</h3><p>粘贴原文并保留来源和发布日期。没有证据时，Qwen 必须回答证据不足。</p><textarea id="fundLlmEvidence" placeholder="来源：基金公司季报；发布日期：...；原文：..."></textarea><button id="fundLlmButton">让 Qwen 审查证据</button><div id="fundLlmOutput"></div>`;
  dashboard.append(panel);
  $("#fundLlmButton").onclick = async () => {
    const button = $("#fundLlmButton"), output = $("#fundLlmOutput"), { fund, model } = state.data;
    button.disabled = true; button.textContent = "Qwen 审查中…"; output.textContent = "";
    try {
      const result = await postApi("/api/llm/review", { asset: { market: "fund", symbol: fund.code, name: fund.name }, quant: { projectedReturn: model.assessment.metrics.projectedReturn, profitProbability: model.assessment.score / 100, oosR2: model.backtest.oosR2VsRandomWalk, directionAccuracy: model.backtest.directionAccuracy, maxDrawdown: model.assessment.metrics.maxDrawdown }, evidence: $("#fundLlmEvidence").value });
      const r = result.review;
      output.innerHTML = `<strong>${escapeHtml(r.verdict || "证据不足")}</strong><p>${escapeHtml(r.summary || "")}</p><p>主要风险：${escapeHtml((r.risks || []).join("；") || "未识别")}</p><p>与量化信号：${escapeHtml(r.quantConflict || "无法判断")}</p>`;
    } catch (error) { output.textContent = error.message; }
    finally { button.disabled = false; button.textContent = "让 Qwen 审查证据"; }
  };
}

async function loadFund(code) {
  if (!/^\d{6}$/.test(code)) return showToast("请输入正确的 6 位基金代码");
  state.code = code;
  setLoading(true);
  try {
    const params = new URLSearchParams({ horizon: state.horizon, risk: state.risk });
    state.data = await api(`/api/funds/${code}/analysis?${params}`);
    renderDashboard();
    $("#hero").classList.add("hidden");
    $("#recommendationsSection").classList.add("hidden");
    $("#featureRow").classList.add("hidden");
    $("#dashboard").classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(false);
  }
}

function renderDashboard() {
  const { fund, latest, history, model, meta } = state.data;
  $("#fundType").textContent = fund.type;
  $("#fundCode").textContent = fund.code;
  $("#fundName").textContent = fund.name;
  $("#latestNav").textContent = fmtNumber(latest.nav);
  $("#latestDate").textContent = `${latest.date} 更新`;
  const change = $("#latestChange");
  change.textContent = `${fmtPercent(latest.change)} 今日`;
  change.className = `quote-change ${latest.change >= 0 ? "positive" : "negative"}`;

  const daysOld = Math.floor((Date.now() - new Date(`${latest.date}T00:00:00+08:00`).getTime()) / 86400000);
  $("#freshness").innerHTML = `<span></span>${daysOld > 5 ? `净值已滞后 ${daysOld} 天` : "数据已校验"}`;
  renderSignal(model.assessment);
  renderMetrics(model.assessment.metrics);
  $("#directionAccuracy").textContent = `${(model.backtest.directionAccuracy * 100).toFixed(1)}%`;
  $("#directionInterval").textContent = `95% 区间 ${(model.backtest.directionInterval95.lower * 100).toFixed(0)}%–${(model.backtest.directionInterval95.upper * 100).toFixed(0)}%`;
  $("#mape").textContent = `${(model.backtest.mape * 100).toFixed(2)}%`;
  $("#sampleCount").textContent = `${model.backtest.samples} 个样本外预测点`;
  $("#oosR2").textContent = `${model.backtest.oosR2VsRandomWalk >= 0 ? "+" : ""}${(model.backtest.oosR2VsRandomWalk * 100).toFixed(1)}%`;
  $("#dataSource").textContent = `${meta.dataSource} · ${new Date(meta.generatedAt).toLocaleString("zh-CN", { hour12: false })}`;
  renderChart(history, model.forecast);
  renderFundLlmPanel();
}

function renderSignal(assessment) {
  $("#score").textContent = assessment.score;
  $("#scoreRing").style.setProperty("--score-angle", `${assessment.score * 3.6}deg`);
  const pill = $("#actionPill");
  pill.textContent = assessment.action;
  pill.className = `action-pill ${assessment.tone === "negative" ? "negative" : assessment.tone === "watch" || assessment.tone === "neutral" ? "watch" : ""}`;
  $("#reasonList").innerHTML = assessment.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
}

function renderMetrics(metrics) {
  const items = [
    ["近 20 日收益", fmtPercent(metrics.return20), "短期动量"],
    ["近 60 日收益", fmtPercent(metrics.return60), "中期动量"],
    ["近一年收益", fmtPercent(metrics.return252), "历史表现"],
    ["预测区间中枢", fmtPercent(metrics.projectedReturn), `${state.horizon} 个交易日`],
    ["年化波动", `${(metrics.annualizedVolatility * 100).toFixed(1)}%`, "近一年"],
    ["最大回撤", `${(metrics.maxDrawdown * 100).toFixed(1)}%`, "近一年"],
    ["Sharpe", metrics.sharpe.toFixed(2), "未扣无风险利率"],
    ["RSI 14", metrics.rsi14.toFixed(1), metrics.rsi14 > 70 ? "偏热" : metrics.rsi14 < 30 ? "偏冷" : "中性"],
  ];
  $("#metricsGrid").innerHTML = items.map(([label, value, note]) => `<div class="metric"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join("");
}

function renderChart(history, forecast) {
  const svg = $("#mainChart");
  const width = Math.max(500, $("#chartWrap").clientWidth);
  const height = Math.max(280, $("#chartWrap").clientHeight);
  const pad = { top: 15, right: 58, bottom: 24, left: 8 };
  const visibleHistory = state.range === "all" ? history : history.slice(-state.range);
  const all = [...visibleHistory, ...forecast];
  const values = [...visibleHistory.map((p) => p.nav), ...forecast.flatMap((p) => [p.lower80, p.upper80])];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.max(max - min, max * .02);
  const yMin = min - spread * .09;
  const yMax = max + spread * .09;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const x = (index) => pad.left + (index / Math.max(1, all.length - 1)) * plotW;
  const y = (value) => pad.top + ((yMax - value) / (yMax - yMin)) * plotH;
  const path = (points, accessor, offset = 0) => points.map((point, index) => `${index ? "L" : "M"}${x(offset + index).toFixed(2)},${y(accessor(point)).toFixed(2)}`).join(" ");
  const historyPath = path(visibleHistory, (p) => p.nav);
  const forecastOffset = visibleHistory.length - 1;
  const connectedForecast = [{ ...visibleHistory.at(-1), lower80: visibleHistory.at(-1).nav, upper80: visibleHistory.at(-1).nav }, ...forecast];
  const forecastPath = path(connectedForecast, (p) => p.nav, forecastOffset);
  const upper = connectedForecast.map((p, i) => `${i ? "L" : "M"}${x(forecastOffset + i).toFixed(2)},${y(p.upper80).toFixed(2)}`).join(" ");
  const lower = [...connectedForecast].reverse().map((p, reverseIndex) => {
    const i = connectedForecast.length - 1 - reverseIndex;
    return `L${x(forecastOffset + i).toFixed(2)},${y(p.lower80).toFixed(2)}`;
  }).join(" ");
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = yMax - ((yMax - yMin) * index) / 4;
    const yy = y(value);
    return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${yy}" y2="${yy}" stroke="rgba(255,255,255,.055)"/><text x="${width - pad.right + 9}" y="${yy + 3}" fill="#69727e" font-size="9">${value.toFixed(3)}</text>`;
  }).join("");
  const boundaryX = x(forecastOffset);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <defs><linearGradient id="lineFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dce2e9" stop-opacity=".13"/><stop offset="1" stop-color="#dce2e9" stop-opacity="0"/></linearGradient><linearGradient id="forecastFill" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#39e59e" stop-opacity=".05"/><stop offset="1" stop-color="#39e59e" stop-opacity=".22"/></linearGradient></defs>
    ${grid}
    <path d="${historyPath} L${x(forecastOffset)},${y(yMin)} L${pad.left},${y(yMin)} Z" fill="url(#lineFill)"/>
    <path d="${upper} ${lower} Z" fill="url(#forecastFill)" stroke="none"/>
    <line x1="${boundaryX}" x2="${boundaryX}" y1="${pad.top}" y2="${height - pad.bottom}" stroke="rgba(57,229,158,.22)" stroke-dasharray="3 5"/>
    <text x="${boundaryX + 7}" y="${pad.top + 10}" fill="#39e59e" font-size="8" letter-spacing="1">FORECAST</text>
    <path d="${historyPath}" fill="none" stroke="#dce2e9" stroke-width="1.8" vector-effect="non-scaling-stroke"/>
    <path d="${forecastPath}" fill="none" stroke="#39e59e" stroke-width="2" stroke-dasharray="5 5" vector-effect="non-scaling-stroke"/>
    <circle cx="${x(all.length - 1)}" cy="${y(forecast.at(-1).nav)}" r="4" fill="#39e59e" stroke="#0b1913" stroke-width="3"/>
  `;
  bindChartTooltip(svg, all, x, y);
}

function bindChartTooltip(svg, points, x, y) {
  const tooltip = $("#chartTooltip");
  svg.onmousemove = (event) => {
    const rect = svg.getBoundingClientRect();
    const mouseX = ((event.clientX - rect.left) / rect.width) * svg.viewBox.baseVal.width;
    const index = Math.max(0, Math.min(points.length - 1, Math.round((mouseX - 8) / (svg.viewBox.baseVal.width - 66) * (points.length - 1))));
    const point = points[index];
    tooltip.innerHTML = `<strong>${escapeHtml(point.date)}</strong><br>净值 ${fmtNumber(point.nav)}${point.lower80 ? " · 预测" : ""}`;
    tooltip.style.left = `${(x(index) / svg.viewBox.baseVal.width) * 100}%`;
    tooltip.style.top = `${(y(point.nav) / svg.viewBox.baseVal.height) * 100}%`;
    tooltip.classList.remove("hidden");
  };
  svg.onmouseleave = () => tooltip.classList.add("hidden");
}

async function searchSuggestions(query) {
  const container = $("#suggestions");
  if (query.trim().length < 2) return container.classList.add("hidden");
  try {
    const { funds } = await api(`/api/funds/search?q=${encodeURIComponent(query.trim())}`);
    if (!funds.length) return container.classList.add("hidden");
    container.innerHTML = funds.map((fund) => `<button class="suggestion" data-code="${fund.code}"><strong>${escapeHtml(fund.name)} <span>${fund.code}</span></strong><small>${escapeHtml(fund.type)}</small></button>`).join("");
    container.classList.remove("hidden");
    container.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => {
      $("#fundSearch").value = button.dataset.code;
      container.classList.add("hidden");
      loadFund(button.dataset.code);
    }));
  } catch { container.classList.add("hidden"); }
}

$("#fundSearch").addEventListener("input", (event) => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => searchSuggestions(event.target.value), 250);
});
$("#fundSearch").addEventListener("keydown", (event) => { if (event.key === "Enter") loadFund(event.target.value.trim()); });
$("#searchButton").addEventListener("click", () => loadFund($("#fundSearch").value.trim()));
$$('[data-code]').forEach((button) => button.addEventListener("click", () => loadFund(button.dataset.code)));
$("#backButton").addEventListener("click", () => {
  $("#dashboard").classList.add("hidden");
  $("#hero").classList.remove("hidden");
  $("#recommendationsSection").classList.remove("hidden");
  $("#featureRow").classList.remove("hidden");
  $("#fundSearch").focus();
});

$("#horizonControl").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-horizon]");
  if (!button || Number(button.dataset.horizon) === state.horizon) return;
  state.horizon = Number(button.dataset.horizon);
  $$("#horizonControl button").forEach((item) => item.classList.toggle("active", item === button));
  loadFund(state.code);
});
$("#riskControl").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-risk]");
  if (!button || button.dataset.risk === state.risk) return;
  state.risk = button.dataset.risk;
  $$("#riskControl button").forEach((item) => item.classList.toggle("active", item === button));
  loadFund(state.code);
});
$("#rangeTabs").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-range]");
  if (!button) return;
  state.range = button.dataset.range === "all" ? "all" : Number(button.dataset.range);
  $$("#rangeTabs button").forEach((item) => item.classList.toggle("active", item === button));
  renderChart(state.data.history, state.data.model.forecast);
});
window.addEventListener("resize", () => { if (state.data) renderChart(state.data.history, state.data.model.forecast); });

$("#aboutButton").addEventListener("click", () => $("#aboutDialog").showModal());
$("#dialogClose").addEventListener("click", () => $("#aboutDialog").close());
document.addEventListener("click", (event) => { if (!$("#searchShell").contains(event.target)) $("#suggestions").classList.add("hidden"); });

async function loadRecommendations() {
  const grid = $("#recommendationGrid");
  try {
    const result = await api("/api/recommendations");
    grid.innerHTML = result.portfolios.map((portfolio) => `<article class="portfolio-card">
      <div class="portfolio-card-top"><span class="recommendation-rank">${escapeHtml(portfolio.name)}</span><span>${escapeHtml(portfolio.philosophy)}</span></div>
      <h3>${escapeHtml(portfolio.rationale)}</h3>
      <div class="portfolio-stats"><span>费用前中枢 <strong>${portfolio.positions.length ? fmtPercent(portfolio.grossExpectedReturn) : "—"}</strong></span><span>费用后中枢 <strong>${portfolio.positions.length ? fmtPercent(portfolio.expectedReturn) : "—"}</strong></span><span>现金仓位 <strong>${(portfolio.cashWeight * 100).toFixed(0)}%</strong></span></div>
      <div class="recommendation-schedule"><span>决策周期</span><strong>${escapeHtml(result.decisionWeek)} 当周锁定</strong><span>计划窗口</span><strong>${escapeHtml(portfolio.buyWindow)}</strong><span>调仓纪律</span><strong>${escapeHtml(portfolio.rebalancePolicy)}</strong></div>
      <div class="portfolio-positions"><span>通过严格门槛的组合持仓</span>${portfolio.positions.length ? portfolio.positions.map((position) => `<button class="portfolio-fund" data-recommendation-code="${position.code}" title="${escapeHtml(position.positionStatus)}"><b>${escapeHtml(position.code)}</b><span>${escapeHtml(position.name)}</span><em>${(position.weight * 100).toFixed(0)}%</em></button>`).join("") : `<div class="portfolio-empty">没有基金通过本周全部门槛<br>系统保留现金，不强行补满三只</div>`}</div>
      ${portfolio.positions.length ? `<div class="portfolio-status">${portfolio.positions.map((position) => `${escapeHtml(position.code)}：费用后 ${fmtPercent(position.netProjectedReturn)} · ${escapeHtml(position.positionStatus)}`).join("<br>")}</div>` : ""}
      <small class="portfolio-note">${escapeHtml(portfolio.exitRule)}</small>
    </article>`).join("");
    $("#recommendationDisclosure").textContent = `${result.decisionStatus} ${result.concentrationWarning} 候选池 ${result.universeSize} 只，成功分析 ${result.analyzedCount} 只，通过严格门槛 ${result.eligibleCount} 只。数据源完整度 ${(result.sourceCompleteness * 100).toFixed(0)}%，分析完整度 ${(result.analysisCompleteness * 100).toFixed(0)}%。${result.caveat}`;
    grid.querySelectorAll("[data-recommendation-code]").forEach((button) => button.addEventListener("click", () => loadFund(button.dataset.recommendationCode)));
  } catch (error) {
    grid.innerHTML = `<div class="recommendation-loading">关注榜暂时无法计算：${escapeHtml(error.message)}</div>`;
  }
}

const HOLDINGS_KEY = "fundlens-holdings-v1";

function storedHoldings() {
  try { return JSON.parse(localStorage.getItem(HOLDINGS_KEY) || "[]"); }
  catch { return []; }
}

function saveHoldings(holdings) {
  localStorage.setItem(HOLDINGS_KEY, JSON.stringify(holdings));
}

async function renderHoldings() {
  const container = $("#holdingList");
  const holdings = storedHoldings();
  if (!holdings.length) {
    container.innerHTML = `<div class="holding-empty">尚未记录持仓</div>`;
    return;
  }
  container.innerHTML = `<div class="holding-empty">正在按最新净值复核 ${holdings.length} 个持仓…</div>`;
  const reviews = await Promise.allSettled(holdings.map(async (holding) => {
    const params = new URLSearchParams();
    if (holding.purchaseDate) params.set("purchaseDate", holding.purchaseDate);
    if (holding.purchaseNav) params.set("purchaseNav", holding.purchaseNav);
    if (holding.amount) params.set("amount", holding.amount);
    return api(`/api/funds/${holding.code}/holding-review?${params}`);
  }));
  container.innerHTML = reviews.map((result, index) => {
    const saved = holdings[index];
    if (result.status === "rejected") return `<article class="holding-card"><div><span>${escapeHtml(saved.code)}</span><strong>暂时无法复核</strong></div><div class="holding-action"><span>原因</span><strong>${escapeHtml(result.reason.message)}</strong></div><button class="holding-remove" data-remove-holding="${escapeHtml(saved.code)}">删除</button></article>`;
    const review = result.value;
    const holding = review.holding;
    return `<article class="holding-card">
      <div><span>${escapeHtml(review.fund.code)} · ${escapeHtml(review.fund.type)}</span><strong>${escapeHtml(review.fund.name)}</strong></div>
      <div><span>最新净值</span><strong>${fmtNumber(review.signal.latestNav)}</strong></div>
      <div><span>持仓收益</span><strong>${holding.unrealizedReturn === null ? "待填写确认净值" : fmtPercent(holding.unrealizedReturn)}</strong></div>
      <div class="holding-action"><span>独立持仓结论</span><strong>${escapeHtml(review.action)}</strong><span>${escapeHtml(review.rationale.join("；"))}</span></div>
      <button class="holding-remove" data-remove-holding="${escapeHtml(saved.code)}">删除</button>
    </article>`;
  }).join("");
  container.querySelectorAll("[data-remove-holding]").forEach((button) => button.addEventListener("click", () => {
    saveHoldings(storedHoldings().filter((holding) => holding.code !== button.dataset.removeHolding));
    renderHoldings();
  }));
}

$("#holdingForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const code = $("#holdingCode").value.trim();
  if (!/^\d{6}$/.test(code)) return showToast("请输入正确的6位基金代码");
  const record = {
    code,
    purchaseDate: $("#holdingDate").value || null,
    purchaseNav: Number($("#holdingNav").value) || null,
    amount: Number($("#holdingAmount").value) || null,
  };
  const holdings = storedHoldings().filter((holding) => holding.code !== code);
  holdings.push(record);
  saveHoldings(holdings);
  renderHoldings();
  showToast("持仓已保存在当前浏览器");
});

loadRecommendations();
renderHoldings();
