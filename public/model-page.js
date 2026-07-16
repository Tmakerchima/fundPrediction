const root = document.querySelector("#currentModelState");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

function percent(value, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}

function plainPercent(value, digits = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
}

function tierExplanation(result) {
  if (result.tierCounts.A > 0) return "存在A级候选：费用后收益为正，样本外R²为正，而且看涨胜率的95%置信下限已超过50%。这仍然只是历史证据，不是未来收益保证。";
  if (result.tierCounts.B > 0) return "当前最高只有B级：方向证据和样本数量尚可，但看涨胜率的置信区间仍未完全排除随机性，因此模型会降低投入比例。";
  if (result.tierCounts.C > 0) return "当前只有C级观察候选：它们通过了费用后正收益和最宽松的条件胜率门槛，但样本外证据不足，不能称为强买入。保留大部分现金是模型结论的一部分。";
  return "没有基金通过最低观察门槛。系统应保持现金，而不是为了凑满数量降低标准。";
}

function fundReason(fund) {
  const reasons = [];
  if (!(fund.backtest?.oosR2VsRandomWalk > 0)) reasons.push("样本外R²尚未战胜随机游走");
  if ((fund.backtest?.predictedUpSamples ?? 0) < 20) reasons.push("历史看涨样本少于20个");
  if (!(fund.backtest?.predictedUpInterval95?.lower >= 0.5)) reasons.push("看涨胜率95%下限仍低于50%");
  if (!reasons.length) reasons.push("已通过当前强证据门槛，但未来仍可能亏损");
  return reasons.join("；");
}

function render(result) {
  const funds = result.funds ?? [];
  root.innerHTML = `
    <div class="current-summary">
      <div class="status-cell"><span>本周系统结论</span><strong>${escapeHtml(result.decisionStatus)}</strong></div>
      <div><span>数据日期</span><strong>${escapeHtml(result.asOf)}</strong></div>
      <div><span>候选 / 分析</span><strong>${result.universeSize} / ${result.analyzedCount}</strong></div>
      <div><span>A / B / C</span><strong>${result.tierCounts.A} / ${result.tierCounts.B} / ${result.tierCounts.C}</strong></div>
      <div><span>分析完整度</span><strong>${plainPercent(result.analysisCompleteness, 0)}</strong></div>
    </div>
    <div class="rationale-callout"><strong>如何理解：</strong>${escapeHtml(tierExplanation(result))}</div>
    <div class="live-funds">
      ${funds.length ? funds.map((fund) => `
        <article class="live-fund">
          <div class="live-fund-head"><span>${escapeHtml(fund.code)}</span><b>${escapeHtml(fund.evidenceLabel)}</b></div>
          <h3>${escapeHtml(fund.name)}</h3>
          <div class="live-metrics">
            <div><span>费用前预测</span><strong>${percent(fund.projectedTwoWeekReturn)}</strong></div>
            <div><span>费用后预测</span><strong>${percent(fund.netProjectedReturn)}</strong></div>
            <div><span>样本外 R²</span><strong>${percent(fund.backtest?.oosR2VsRandomWalk, 1)}</strong></div>
            <div><span>历史看涨胜率</span><strong>${plainPercent(fund.backtest?.predictedUpWinRate)} / ${fund.backtest?.predictedUpSamples ?? 0}次</strong></div>
            <div><span>预测收缩系数 β</span><strong>${Number.isFinite(fund.backtest?.calibrationFactor) ? fund.backtest.calibrationFactor.toFixed(2) : "—"}</strong></div>
            <div><span>80%预测范围</span><strong>${percent(fund.projectedRange80?.lower, 1)} ～ ${percent(fund.projectedRange80?.upper, 1)}</strong></div>
          </div>
          <p>${escapeHtml(fundReason(fund))}。</p>
        </article>`).join("") : "<div class=\"model-loading\">本周没有进入主页的基金候选。</div>"}
    </div>`;
  document.querySelector("#dataAsOf").textContent = result.asOf || "—";
  document.querySelector("#sourceCompleteness").textContent = plainPercent(result.sourceCompleteness, 0);
  document.querySelector("#dataCoverage").textContent = `${result.analyzedCount} / ${result.universeSize}（${plainPercent(result.analysisCompleteness, 0)}）`;
}

try {
  const response = await fetch("/api/recommendations");
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  render(payload);
} catch (error) {
  root.innerHTML = `<div class="model-error">暂时无法读取本周推荐：${escapeHtml(error.message)}</div>`;
}
