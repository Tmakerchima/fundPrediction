import { buildAnalysis } from "./model.js";
import { A_SHARE_UNIVERSE, US_STOCK_UNIVERSE, getStockData } from "./stock-data.js";

function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function std(values) { const avg = mean(values); return Math.sqrt(mean(values.map((value) => (value - avg) ** 2))); }
function sma(values, period) { return mean(values.slice(-period)); }
function maxDrawdown(values) { let peak = values[0] ?? 1; let worst = 0; for (const value of values) { peak = Math.max(peak, value); worst = Math.min(worst, value / peak - 1); } return worst; }

function trendBacktest(history, tradingCost) {
  if (history.length < 220) return { annualizedReturn: 0, sharpe: 0, maxDrawdown: 0, activeRate: 0, samples: 0 };
  const closes = history.map((point) => point.close);
  let equity = 1;
  let active = false;
  let activeDays = 0;
  const returns = [];
  const curve = [1];
  for (let index = 200; index < closes.length; index += 1) {
    const historyBefore = closes.slice(0, index);
    const signal = closes[index - 1] > sma(historyBefore, 50) && sma(historyBefore, 50) > sma(historyBefore, 200);
    let daily = signal ? closes[index] / closes[index - 1] - 1 : 0;
    if (signal !== active) daily -= tradingCost;
    active = signal;
    if (signal) activeDays += 1;
    equity *= 1 + daily;
    returns.push(daily);
    curve.push(equity);
  }
  const volatility = std(returns) * Math.sqrt(252);
  return {
    annualizedReturn: equity > 0 ? equity ** (252 / Math.max(1, returns.length)) - 1 : -1,
    volatility,
    sharpe: volatility ? mean(returns) * 252 / volatility : 0,
    maxDrawdown: maxDrawdown(curve),
    activeRate: activeDays / Math.max(1, returns.length),
    samples: returns.length,
  };
}

export function analyzeStock(meta, history, market, horizon = 10) {
  if (history.length < 220) throw new Error("至少需要 220 个交易日行情");
  const points = history.map((point) => ({ date: point.date, nav: point.close }));
  const model = buildAnalysis(points, horizon, "balanced");
  const closes = history.map((point) => point.close);
  const latest = history.at(-1);
  const previous = history.at(-2);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const volumeRatio = latest.volume / Math.max(1, mean(history.slice(-21, -1).map((point) => point.volume)));
  const trend = latest.close > ma50 && ma50 > ma200 ? "多头" : latest.close < ma50 && ma50 < ma200 ? "空头" : "震荡";
  const strategy = trendBacktest(history, market === "a" ? 0.001 : 0.0005);
  const probability = model.assessment.score / 100;
  const action = trend === "多头" && probability >= 0.6 ? "多头候选" : trend === "空头" || probability < 0.45 ? "谨慎回避" : "等待确认";
  return {
    meta,
    latest: { ...latest, change: previous ? latest.close / previous.close - 1 : 0 },
    history,
    forecast: model.forecast,
    assessment: model.assessment,
    validation: model.backtest,
    strategy,
    technicals: { ma20, ma50, ma200, volumeRatio, trend, action },
    methodology: "SMA50/200 趋势过滤 + 10日风险调整预测 + 波动率控制 + 不重叠样本外验证",
  };
}

export async function getStockRecommendations(market) {
  const universe = market === "a" ? A_SHARE_UNIVERSE : US_STOCK_UNIVERSE;
  const analyzed = [];
  for (let start = 0; start < universe.length; start += 5) {
    const batch = universe.slice(start, start + 5);
    const results = await Promise.allSettled(batch.map(async (item) => {
      const data = await getStockData(market, item.symbol);
      return analyzeStock({ ...data.meta, ...item }, data.history, market, 10);
    }));
    for (const result of results) if (result.status === "fulfilled") analyzed.push(result.value);
  }
  const candidates = analyzed
    .filter((item) => item.assessment.metrics.projectedReturn > 0 && item.technicals.trend !== "空头")
    .sort((a, b) => {
      const probabilityDiff = b.assessment.score - a.assessment.score;
      return probabilityDiff || b.validation.oosR2VsRandomWalk - a.validation.oosR2VsRandomWalk;
    });
  const selected = [];
  const sectors = new Set();
  for (const item of candidates) {
    if (selected.length >= 3) break;
    if (sectors.has(item.meta.sector)) continue;
    selected.push(item); sectors.add(item.meta.sector);
  }
  const fallback = analyzed.sort((a, b) => b.assessment.score - a.assessment.score);
  for (const item of fallback) {
    if (selected.length >= 3) break;
    if (!selected.some((chosen) => chosen.meta.symbol === item.meta.symbol)) selected.push(item);
  }
  for (const item of candidates) {
    if (selected.length >= 3) break;
    if (!selected.some((chosen) => chosen.meta.symbol === item.meta.symbol)) selected.push(item);
  }
  return {
    market,
    generatedAt: new Date().toISOString(),
    universeSize: universe.length,
    methodology: "流动性代表池 → SMA50/200 趋势过滤 → 10日盈利概率 → 样本外R²复核 → 行业去重",
    stocks: selected.map((item, index) => ({
      rank: index + 1, symbol: item.meta.symbol, name: item.meta.name, sector: item.meta.sector,
      price: item.latest.close, date: item.latest.date, trend: item.technicals.trend,
      action: item.technicals.action, projectedReturn: item.assessment.metrics.projectedReturn,
      probability: item.assessment.score / 100, annualizedVolatility: item.assessment.metrics.annualizedVolatility,
      directionAccuracy: item.validation.directionAccuracy, oosR2: item.validation.oosR2VsRandomWalk,
    })),
  };
}
