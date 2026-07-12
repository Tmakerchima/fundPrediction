import { getFastFundHistory, getRankCandidates } from "./eastmoney.js";
import { buildAnalysis } from "./model.js";

const RESULT_TTL = 30 * 60 * 1000;
let resultCache = null;

function themeOf(name) {
  const themes = [
    ["semiconductor", /半导体|芯片/],
    ["oil", /原油|石油|油气/],
    ["convertible-bond", /可转债|转债/],
    ["gold", /黄金|贵金属/],
    ["ai-tech", /人工智能|科技|创新|先进制造/],
    ["healthcare", /医药|医疗|生物/],
    ["consumer", /消费|食品|白酒/],
    ["hongkong", /恒生|港股|香港/],
  ];
  return themes.find(([, pattern]) => pattern.test(name))?.[0] ?? "broad";
}

function reliabilityOf(backtest) {
  if (backtest.oosR2VsRandomWalk > 0.05 && backtest.directionInterval95.lower >= 0.5) return "中等";
  if (backtest.oosR2VsRandomWalk > 0 && backtest.directionAccuracy >= 0.55) return "初步";
  return "偏低";
}

function normalCdfApprox(z) {
  // Logistic approximation to the standard normal CDF; sufficient for UI-level probability disclosure.
  return 1 / (1 + Math.exp(-1.702 * z));
}

function addWeekdays(dateText, count) {
  const date = new Date(`${dateText}T00:00:00Z`);
  let added = 0;
  while (added < count) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) added += 1;
  }
  return date.toISOString().slice(0, 10);
}

function currentShanghaiDate() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function analyzeCandidate(candidate) {
  const history = await getFastFundHistory(candidate.code);
  if (history.length < 252) return null;
  const latest = history.at(-1);
  const dataAgeDays = Math.floor((Date.parse(currentShanghaiDate()) - Date.parse(latest.date)) / 86400000);
  if (dataAgeDays > 7) return null;
  const model = buildAnalysis(history, 10, "balanced");
  const metrics = model.assessment.metrics;
  const forecast = model.forecast;
  const projectedReturn = metrics.projectedReturn;
  const lastForecast = forecast.at(-1);
  const logCenter = Math.log(lastForecast.nav / latest.nav);
  const logSigma = Math.max((Math.log(lastForecast.upper80) - Math.log(lastForecast.lower80)) / (2 * 1.282), 0.0001);
  const profitProbability = normalCdfApprox(logCenter / logSigma);
  const tenDayRisk = Math.max(metrics.annualizedVolatility * Math.sqrt(10 / 252), 0.005);
  const quality =
    projectedReturn / tenDayRisk +
    Math.max(-0.5, model.backtest.oosR2VsRandomWalk) * 0.25 +
    (model.backtest.directionAccuracy - 0.5) * 0.35 -
    model.backtest.mape * 0.8 -
    Math.max(0, metrics.rsi14 - 75) * 0.012;
  const startTwoWeeks = history.at(-11) ?? history[0];
  const plannedEntryDate = [addWeekdays(latest.date, 1), addWeekdays(currentShanghaiDate(), 1)].sort().at(-1);
  const plannedExitDate = addWeekdays(plannedEntryDate, 10);
  const executionNote = /QDII/i.test(candidate.type) ? "QDII 可能 T+2/T+3 确认" : "常规基金通常 T+1 确认";
  return {
    code: candidate.code,
    name: candidate.name,
    type: candidate.type,
    theme: themeOf(candidate.name),
    latestDate: latest.date,
    latestNav: latest.nav,
    recentTwoWeekReturn: latest.nav / startTwoWeeks.nav - 1,
    projectedTwoWeekReturn: projectedReturn,
    modelProfitProbability: profitProbability,
    plannedEntryDate,
    plannedExitDate,
    buyWindow: `${plannedEntryDate} 09:30–15:00 前提交`,
    sellWindow: `${plannedExitDate} 14:30–15:00 前复核并提交赎回`,
    executionNote,
    addPositionRule: "仅当净值较计划买入价回撤≥5%、模型评分≥55且10日中枢仍为正时，加仓原计划金额的25%（最多一次）",
    exitRule: "若模型中枢转负、评分低于35，或净值较计划买入价回撤≥8%，停止加仓并优先复核赎回",
    projectedRange80: {
      lower: forecast.at(-1).lower80 / latest.nav - 1,
      upper: forecast.at(-1).upper80 / latest.nav - 1,
    },
    annualizedVolatility: metrics.annualizedVolatility,
    maxDrawdown: metrics.maxDrawdown,
    rsi14: metrics.rsi14,
    modelScore: model.assessment.score,
    rankingScore: quality,
    reliability: reliabilityOf(model.backtest),
    backtest: model.backtest,
    returnSeries: history.slice(-127).map((point, index, series) => index === 0 ? null : Math.log(point.nav / series[index - 1].nav)).filter((value) => value !== null),
  };
}

function selectDiversified(analyzed, limit = 5) {
  const eligible = analyzed
    .filter((item) => item && item.projectedTwoWeekReturn > 0)
    .filter((item) => item.rsi14 < 84 && item.backtest.directionAccuracy >= 0.5)
    .sort((a, b) => b.rankingScore - a.rankingScore);
  const selected = [];
  const usedTypes = new Set();
  const usedThemes = new Set();

  // 第一轮每个大类最多一支，避免“最高分”全部来自同一行情主题。
  for (const item of eligible) {
    if (selected.length >= limit) break;
    if (usedTypes.has(item.type) || usedThemes.has(item.theme)) continue;
    selected.push(item);
    usedTypes.add(item.type);
    usedThemes.add(item.theme);
  }
  // 数据不足时放宽到每类两支，但仍不重复明显主题。
  for (const item of eligible) {
    if (selected.length >= limit) break;
    if (selected.some((selectedItem) => selectedItem.code === item.code)) continue;
    if (usedThemes.has(item.theme)) continue;
    const sameTypeCount = selected.filter((selectedItem) => selectedItem.type === item.type).length;
    if (sameTypeCount >= 2) continue;
    selected.push(item);
    usedThemes.add(item.theme);
  }
  // 最后一轮只保证同一基金产品不重复；页面会披露主题集中风险。
  for (const item of eligible) {
    if (selected.length >= limit) break;
    if (selected.some((selectedItem) => selectedItem.code === item.code)) continue;
    const sameTypeCount = selected.filter((selectedItem) => selectedItem.type === item.type).length;
    if (sameTypeCount >= 3) continue;
    selected.push(item);
  }
  return selected.map((item, index) => ({ ...item, rank: index + 1 }));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function correlation(left, right) {
  const size = Math.min(left.length, right.length);
  if (size < 20) return 0;
  const a = left.slice(-size);
  const b = right.slice(-size);
  const meanA = mean(a);
  const meanB = mean(b);
  let numerator = 0;
  let denominatorA = 0;
  let denominatorB = 0;
  for (let index = 0; index < size; index += 1) {
    const da = a[index] - meanA;
    const db = b[index] - meanB;
    numerator += da * db;
    denominatorA += da ** 2;
    denominatorB += db ** 2;
  }
  return denominatorA && denominatorB ? numerator / Math.sqrt(denominatorA * denominatorB) : 0;
}

function inverseVolWeights(items, invested) {
  const inverse = items.map((item) => 1 / Math.max(item.annualizedVolatility, 0.08));
  const total = inverse.reduce((sum, value) => sum + value, 0);
  return items.map((item, index) => ({ ...item, weight: invested * inverse[index] / total }));
}

function portfolioVolatility(positions) {
  let variance = 0;
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      const corr = i === j ? 1 : correlation(positions[i].returnSeries, positions[j].returnSeries);
      variance += positions[i].weight * positions[j].weight *
        positions[i].annualizedVolatility * positions[j].annualizedVolatility * corr;
    }
  }
  return Math.sqrt(Math.max(variance, 0));
}

function publicFund(item) {
  const { returnSeries, ...safe } = item;
  return safe;
}

function buildPortfolio(id, name, philosophy, items, invested, rationale) {
  const positions = inverseVolWeights(items, invested);
  const expectedReturn = positions.reduce((sum, item) => sum + item.weight * item.projectedTwoWeekReturn, 0);
  const annualizedVolatility = portfolioVolatility(positions);
  const tenDayVolatility = Math.max(annualizedVolatility * Math.sqrt(10 / 252), 0.005);
  const profitProbability = normalCdfApprox(Math.log(1 + expectedReturn) / tenDayVolatility);
  const score = Math.round(Math.max(0, Math.min(100, normalCdfApprox(Math.log(1 + expectedReturn) / tenDayVolatility) * 100)));
  return {
    id,
    name,
    philosophy,
    rationale,
    investedWeight: invested,
    cashWeight: 1 - invested,
    expectedReturn,
    annualizedVolatility,
    modelProfitProbability: profitProbability,
    score,
    plannedEntryDate: items[0]?.plannedEntryDate,
    plannedExitDate: items[0]?.plannedExitDate,
    buyWindow: items[0]?.buyWindow,
    sellWindow: items[0]?.sellWindow,
    addPositionRule: "组合层面不追跌加仓；只有单个持仓回撤≥5%、组合预测仍为正且现金仓位足够时，补充该持仓原计划金额的25%，最多一次。",
    exitRule: "若组合预测中枢转负或组合回撤达到8%，停止加仓并复核减仓；QDII 以实际确认日为准。",
    positions: positions.map((item) => ({
      code: item.code,
      name: item.name,
      type: item.type,
      weight: item.weight,
      projectedTwoWeekReturn: item.projectedTwoWeekReturn,
      modelProfitProbability: item.modelProfitProbability,
      reliability: item.reliability,
    })),
  };
}

function chooseDistinct(items, count, sortBy = "rankingScore") {
  const sorted = [...items].sort((a, b) => b[sortBy] - a[sortBy]);
  const selected = [];
  const themes = new Set();
  for (const item of sorted) {
    if (selected.length >= count) break;
    if (themes.has(item.theme)) continue;
    selected.push(item);
    themes.add(item.theme);
  }
  for (const item of sorted) {
    if (selected.length >= count) break;
    if (!selected.some((selectedItem) => selectedItem.code === item.code)) selected.push(item);
  }
  return selected;
}

export async function getTwoWeekRecommendations() {
  if (resultCache && Date.now() - resultCache.at < RESULT_TTL) return resultCache.value;
  const candidates = await getRankCandidates(20);
  const analyzed = [];
  for (let start = 0; start < candidates.length; start += 8) {
    const batch = candidates.slice(start, start + 8);
    const settled = await Promise.allSettled(batch.map(analyzeCandidate));
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value) analyzed.push(result.value);
    }
  }
  const eligible = analyzed
    .filter((item) => item && item.projectedTwoWeekReturn > 0 && item.rsi14 < 84 && item.backtest.directionAccuracy >= 0.5)
    .sort((a, b) => b.rankingScore - a.rankingScore);
  if (eligible.length < 3) throw new Error("当前候选池没有足够的基金构成三套组合");
  const defensive = chooseDistinct([...eligible].sort((a, b) => a.annualizedVolatility - b.annualizedVolatility), 3, "projectedTwoWeekReturn");
  const balanced = chooseDistinct(eligible, 3);
  const aggressive = chooseDistinct([...eligible].sort((a, b) => b.projectedTwoWeekReturn - a.projectedTwoWeekReturn), 3, "projectedTwoWeekReturn");
  const portfolios = [
    buildPortfolio("defensive", "低波动防守组合", "Cash + low-volatility drawdown control", defensive, 0.55, "用现金仓位、低波动权重和回撤约束代理安全边际；本 MVP 没有估值数据，不声称计算 Graham 内在价值。"),
    buildPortfolio("balanced", "均衡型组合", "Simplified Markowitz risk budget", balanced, 0.75, "在预期收益、波动率和历史相关性之间做风险预算，避免押注单一主题。"),
    buildPortfolio("tactical", "趋势型组合", "Carhart-style momentum with a risk cap", aggressive, 0.85, "只作为短周期战术仓位；动量可能带来超额收益，也可能快速反转，因此保留现金和退出线。"),
  ];
  const latestDate = analyzed.map((item) => item.latestDate).sort().at(-1);
  const allPositions = portfolios.flatMap((portfolio) => portfolio.positions);
  const allSelected = [...new Map(allPositions.map((position) => [position.code, position])).values()];
  const positionCounts = allPositions.reduce((counts, item) => ({ ...counts, [item.code]: (counts[item.code] || 0) + 1 }), {});
  const concentratedTheme = Object.entries(positionCounts).sort((a, b) => b[1] - a[1])[0];
  const value = {
    portfolios,
    funds: allSelected,
    asOf: latestDate,
    generatedAt: new Date().toISOString(),
    horizonTradingDays: 10,
    universeSize: candidates.length,
    analyzedCount: analyzed.length,
    methodology: "各大类近一月候选池 → 10 日集成预测 → 样本外与风险过滤 → 类型和主题去重",
    concentrationWarning: concentratedTheme?.[1] > 1
      ? `三个组合共用基金 ${concentratedTheme[0]}（出现 ${concentratedTheme[1]} 次），不能视为完全分散。`
      : "三个组合没有重复基金，但仍不等同于完成资产配置。",
    caveat: "这是动态研究关注榜，不是买入清单。候选池预筛选带有动量与选择偏差，当前回测尚未覆盖历史横截面选基过程；日期按工作日估算，节假日和基金合同优先。",
  };
  resultCache = { at: Date.now(), value };
  return value;
}
