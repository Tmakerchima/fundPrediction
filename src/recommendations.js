import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getFastFundHistory,
  getFundFeeProfile,
  getFundMeta,
  getRankCandidateSnapshot,
  validateFundCode,
} from "./eastmoney.js";
import { buildAnalysis } from "./model.js";

const HORIZON = 10;
const RESULT_TTL = 30 * 60 * 1000;
const STATE_PATH = process.env.RECOMMENDATION_STATE_PATH || join(process.cwd(), ".runtime", "recommendations.json");
const MIN_SOURCE_COMPLETENESS = Number(process.env.MIN_SOURCE_COMPLETENESS || 0.8);
const MIN_ANALYSIS_COMPLETENESS = Number(process.env.MIN_ANALYSIS_COMPLETENESS || 0.7);
const CANDIDATES_PER_TYPE = Number(process.env.CANDIDATES_PER_TYPE || 40);
const HALF_TURNOVER = 0.5;
const STATE_VERSION = 4;
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
  if (backtest.oosR2VsRandomWalk > 0.05 && backtest.predictedUpInterval95?.lower >= 0.5) return "中等";
  if (backtest.oosR2VsRandomWalk > 0 && backtest.predictedUpWinRate >= 0.55) return "初步";
  return "偏低";
}

function normalCdfApprox(z) {
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

function weekKey(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function calendarDaysBetween(left, right) {
  return Math.max(1, Math.round((Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86400000));
}

function netReturnAfterFees(grossReturn, entryFee, exitFee) {
  if (![grossReturn, entryFee, exitFee].every(Number.isFinite)) return null;
  return (1 + grossReturn) * (1 - entryFee) * (1 - exitFee) - 1;
}

export function isTwoWeekCompatible(name) {
  return !/(养老|封闭|定期开放|定开|持有期|(?:三|六|九|十|\d+)个?月持有|(?:一|二|两|三|四|五|\d+)年持有)/.test(String(name));
}

export function eligibilityReasons(item) {
  const reasons = [];
  if (!item.fees?.verified) reasons.push("申赎费率未验证");
  if (!(item.projectedTwoWeekReturn > 0)) reasons.push("预测中枢不为正");
  if (!(item.netProjectedReturn > 0)) reasons.push("费用后预测不为正");
  if (!(item.rsi14 < 84)) reasons.push("RSI过热");
  if (!(item.backtest.oosR2VsRandomWalk > 0)) reasons.push("样本外R²未战胜随机游走");
  if (!(item.backtest.predictedUpSamples >= 20)) reasons.push("看涨样本少于20个");
  if (!(item.backtest.predictedUpInterval95?.lower >= 0.5)) reasons.push("历史看涨胜率置信下限未超过50%");
  if (!item.twoWeekCompatible) reasons.push("产品持有安排不适合两周操作");
  return reasons;
}

export function classifyEvidenceTier(item) {
  const base = item.twoWeekCompatible
    && item.fees?.verified
    && item.netProjectedReturn > 0
    && item.rsi14 < 84;
  if (base
    && item.backtest.oosR2VsRandomWalk > 0
    && item.backtest.predictedUpSamples >= 20
    && item.backtest.predictedUpInterval95?.lower >= 0.5) return "A";
  if (base
    && item.backtest.oosR2VsRandomWalk > 0
    && item.backtest.predictedUpSamples >= 20
    && item.backtest.predictedUpWinRate >= 0.55) return "B";
  if (base
    && item.backtest.oosR2VsRandomWalk > -0.25
    && item.backtest.predictedUpSamples >= 15
    && item.backtest.predictedUpWinRate >= 0.5) return "C";
  return null;
}

function finalizeCandidate(item, fees = item.fees) {
  const netProjectedReturn = netReturnAfterFees(
    item.projectedTwoWeekReturn,
    fees?.discountedPurchaseFee,
    fees?.redemptionFee,
  );
  const next = {
    ...item,
    fees,
    netProjectedReturn,
    netProfitProbability: netProjectedReturn === null
      ? null
      : normalCdfApprox(Math.log(1 + netProjectedReturn) / item.forecastRisk),
    empiricalProfitProbability: item.backtest.posteriorUpProbability,
    rankingScore: netProjectedReturn === null ? Number.NEGATIVE_INFINITY : netProjectedReturn / item.forecastRisk,
    errorCoverage: netProjectedReturn === null || !item.backtest.mape ? null : netProjectedReturn / item.backtest.mape,
  };
  next.ineligibilityReasons = eligibilityReasons(next);
  next.eligible = next.ineligibilityReasons.length === 0;
  next.evidenceTier = classifyEvidenceTier(next);
  next.recommendable = next.evidenceTier !== null;
  next.evidenceLabel = next.evidenceTier === "A"
    ? "A级强证据"
    : next.evidenceTier === "B"
      ? "B级条件候选"
      : next.evidenceTier === "C"
        ? "C级高风险候选"
        : "未达到候选门槛";
  next.riskWarning = next.evidenceTier === "A"
    ? "历史样本外证据相对较强，但仍可能亏损"
    : next.evidenceTier === "B"
      ? "获利期望尚可，但95%置信区间尚未排除随机性，仍可能亏损"
      : next.evidenceTier === "C"
        ? "仅达到宽松观察标准，误判和亏损风险较高"
        : "当前证据不足，不作为主页候选";
  next.holdingAction = next.netProjectedReturn !== null && next.netProjectedReturn <= 0
    ? "复核退出条件"
    : next.evidenceTier === "A"
      ? "本周持有，不追涨加仓"
      : next.recommendable
        ? "条件持有，暂不加仓"
        : "继续观察，暂不加仓";
  return next;
}

async function analyzeCandidate(candidate) {
  const history = await getFastFundHistory(candidate.code);
  if (history.length < 252) return null;
  const latest = history.at(-1);
  const dataAgeDays = Math.floor((Date.parse(currentShanghaiDate()) - Date.parse(latest.date)) / 86400000);
  if (dataAgeDays > 7) return null;

  const model = buildAnalysis(history, HORIZON, "balanced");
  const metrics = model.assessment.metrics;
  const forecast = model.forecast;
  const projectedReturn = metrics.projectedReturn;
  const lastForecast = forecast.at(-1);
  const plannedEntryDate = [addWeekdays(latest.date, 1), addWeekdays(currentShanghaiDate(), 1)].sort().at(-1);
  const plannedExitDate = addWeekdays(plannedEntryDate, HORIZON);
  const holdingDays = calendarDaysBetween(plannedEntryDate, plannedExitDate);
  let fees = {
    standardPurchaseFee: null,
    discountedPurchaseFee: null,
    redemptionFee: null,
    holdingDays,
    verified: false,
    sourceUrl: `https://fundf10.eastmoney.com/jjfl_${candidate.code}.html`,
  };
  const twoWeekCompatible = isTwoWeekCompatible(candidate.name);
  const meritsFeeCheck = twoWeekCompatible
    && projectedReturn > 0
    && metrics.rsi14 < 84
    && model.backtest.oosR2VsRandomWalk > -0.25
    && model.backtest.predictedUpSamples >= 15
    && model.backtest.predictedUpWinRate >= 0.5;
  const logSigma = Math.max((Math.log(lastForecast.upper80) - Math.log(lastForecast.lower80)) / (2 * 1.282), 0.0001);
  const tenDayRisk = Math.max(metrics.annualizedVolatility * Math.sqrt(HORIZON / 252), 0.005);
  const modelProfitProbability = normalCdfApprox(Math.log(lastForecast.nav / latest.nav) / logSigma);
  const startTwoWeeks = history.at(-11) ?? history[0];
  const item = {
    code: candidate.code,
    name: candidate.name,
    type: candidate.type,
    twoWeekCompatible,
    theme: themeOf(candidate.name),
    latestDate: latest.date,
    latestNav: latest.nav,
    recentTwoWeekReturn: latest.nav / startTwoWeeks.nav - 1,
    projectedTwoWeekReturn: projectedReturn,
    netProjectedReturn: null,
    modelProfitProbability,
    empiricalProfitProbability: model.backtest.posteriorUpProbability,
    netProfitProbability: null,
    forecastRisk: tenDayRisk,
    feeCheckEligible: meritsFeeCheck,
    plannedEntryDate,
    plannedExitDate,
    buyWindow: `${plannedEntryDate} 15:00 前提交；成交净值以基金确认规则为准`,
    sellWindow: `${plannedExitDate} 15:00 前复核；达到持有期后再按合同费率赎回`,
    executionNote: /QDII/i.test(candidate.type) ? "QDII通常存在更长确认时滞" : "场外基金通常按未知价原则确认",
    projectedRange80: {
      lower: lastForecast.lower80 / latest.nav - 1,
      upper: lastForecast.upper80 / latest.nav - 1,
    },
    annualizedVolatility: metrics.annualizedVolatility,
    downsideVolatility: metrics.downsideVolatility,
    maxDrawdown: metrics.maxDrawdown,
    rsi14: metrics.rsi14,
    modelScore: model.assessment.score,
    rankingScore: Number.NEGATIVE_INFINITY,
    errorCoverage: null,
    reliability: reliabilityOf(model.backtest),
    backtest: model.backtest,
    fees,
    returnSeries: history.slice(-127).map((point, index, series) =>
      index === 0 ? null : Math.log(point.nav / series[index - 1].nav),
    ).filter((value) => value !== null),
  };
  return finalizeCandidate(item, fees);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function correlation(left = [], right = []) {
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
  if (!items.length) return [];
  const inverse = items.map((item) => 1 / Math.max(item.annualizedVolatility, 0.08));
  const total = inverse.reduce((sum, value) => sum + value, 0);
  return items.map((item, index) => ({ ...item, weight: invested * inverse[index] / total }));
}

function portfolioVolatility(positions) {
  let variance = 0;
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      const corr = i === j ? 1 : correlation(positions[i].returnSeries, positions[j].returnSeries);
      variance += positions[i].weight * positions[j].weight
        * positions[i].annualizedVolatility * positions[j].annualizedVolatility * corr;
    }
  }
  return Math.sqrt(Math.max(variance, 0));
}

function publicFund(item) {
  const { returnSeries, ...safe } = item;
  return safe;
}

export function chooseDistinct(items, count, comparator) {
  const sorted = [...items].sort(comparator);
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

function selectionMetric(portfolioId, item) {
  if (portfolioId === "defensive") return -item.downsideVolatility;
  if (portfolioId === "tactical") return item.netProjectedReturn;
  return item.rankingScore;
}

function turnoverThreshold(portfolioId) {
  if (portfolioId === "defensive") return 0.02;
  if (portfolioId === "tactical") return 0.005;
  return 0.1;
}

export function applyHoldingBuffer(portfolioId, target, previousPositions = [], eligible = []) {
  const previousCodes = new Set(previousPositions.map((item) => item.code));
  const eligibleByCode = new Map(eligible.map((item) => [item.code, item]));
  const stabilized = [...target];
  const threshold = turnoverThreshold(portfolioId);
  for (const previous of previousPositions) {
    const incumbent = eligibleByCode.get(previous.code);
    if (!incumbent || stabilized.some((item) => item.code === incumbent.code)) continue;
    const challengerIndex = stabilized.findIndex((item) => !previousCodes.has(item.code));
    if (challengerIndex < 0) continue;
    const challenger = stabilized[challengerIndex];
    const advantage = selectionMetric(portfolioId, challenger) - selectionMetric(portfolioId, incumbent);
    if (advantage < threshold) stabilized[challengerIndex] = incumbent;
  }
  return stabilized;
}

function applyHalfTurnoverWeights(targetPositions, previousPositions = []) {
  if (!previousPositions.length) return targetPositions;
  const previousWeights = new Map(previousPositions.map((item) => [item.code, item.weight]));
  return targetPositions.map((item) => ({
    ...item,
    weight: (previousWeights.get(item.code) ?? 0) + HALF_TURNOVER * (item.weight - (previousWeights.get(item.code) ?? 0)),
  }));
}

function buildPortfolio(definition, items, previousPortfolio = null) {
  const tierRank = { A: 1, B: 2, C: 3 };
  const selectionTier = items.reduce((worst, item) =>
    (tierRank[item.evidenceTier] ?? 3) > (tierRank[worst] ?? 0) ? item.evidenceTier : worst, null);
  const riskBudgetMultiplier = selectionTier === "A" ? 1 : selectionTier === "B" ? 0.6 : selectionTier === "C" ? 0.35 : 0;
  const targetInvestedWeight = definition.investedWeight * riskBudgetMultiplier;
  const targetPositions = inverseVolWeights(items, targetInvestedWeight);
  const positions = applyHalfTurnoverWeights(targetPositions, previousPortfolio?.positions);
  const expectedReturn = positions.reduce((sum, item) => sum + item.weight * item.netProjectedReturn, 0);
  const grossExpectedReturn = positions.reduce((sum, item) => sum + item.weight * item.projectedTwoWeekReturn, 0);
  const annualizedVolatility = portfolioVolatility(positions);
  const tenDayVolatility = Math.max(annualizedVolatility * Math.sqrt(HORIZON / 252), 0.005);
  const profitProbability = positions.length ? normalCdfApprox(Math.log(1 + expectedReturn) / tenDayVolatility) : null;
  const investedWeight = positions.reduce((sum, item) => sum + item.weight, 0);
  const previousCodes = new Set(previousPortfolio?.positions?.map((item) => item.code) ?? []);
  const currentCodes = new Set(items.map((item) => item.code));
  return {
    id: definition.id,
    name: definition.name,
    philosophy: definition.philosophy,
    rationale: definition.rationale,
    selectionTier,
    selectionLabel: selectionTier === "A" ? "A级强证据组合" : selectionTier === "B" ? "B级条件组合" : selectionTier === "C" ? "C级高风险观察组合" : "现金观察",
    riskWarning: selectionTier === "A"
      ? "历史样本外证据相对较强，但仍不保证盈利"
      : selectionTier === "B"
        ? "获利期望尚可，但95%置信区间尚未排除随机性，仍有亏损可能"
        : selectionTier === "C"
          ? "仅达到宽松观察标准，误判和亏损风险较高，因此大幅保留现金"
          : "没有合适候选，保持现金",
    riskBudgetMultiplier,
    targetInvestedWeight,
    investedWeight,
    cashWeight: 1 - investedWeight,
    grossExpectedReturn,
    expectedReturn,
    annualizedVolatility,
    modelProfitProbability: profitProbability,
    score: profitProbability === null ? null : Math.round(Math.max(0, Math.min(100, profitProbability * 100))),
    plannedEntryDate: items[0]?.plannedEntryDate ?? null,
    plannedExitDate: items[0]?.plannedExitDate ?? null,
    buyWindow: items[0]?.buyWindow ?? "证据不足，本周保持现金",
    sellWindow: items[0]?.sellWindow ?? "无新增仓位",
    rebalancePolicy: "每周最多调仓一次；新标的必须越过持仓缓冲，权重只向目标调整50%",
    addPositionRule: "模型不因单日下跌自动加仓；已有持仓只有在费用后信号继续为正且仍通过样本外门槛时才继续持有。",
    exitRule: "掉出前三不等于卖出；费用后预测转负、样本外证据失效或触发个人止损时才复核退出。",
    changes: {
      added: items.filter((item) => !previousCodes.has(item.code)).map((item) => item.code),
      retained: items.filter((item) => previousCodes.has(item.code)).map((item) => item.code),
      reviewExit: (previousPortfolio?.positions ?? []).filter((item) => !currentCodes.has(item.code)).map((item) => item.code),
    },
    positions: positions.map((item) => ({
      ...publicFund(item),
      positionStatus: previousCodes.has(item.code)
        ? item.holdingAction
        : `${item.evidenceLabel}：${item.riskWarning}`,
    })),
  };
}

const DEFINITIONS = [
  {
    id: "defensive",
    name: "低波动防守组合",
    philosophy: "Downside-risk first",
    investedWeight: 0.55,
    rationale: "先按下行波动率和最大回撤筛选，再用反波动率分配；证据不足时允许持有更多现金。",
  },
  {
    id: "balanced",
    name: "费用后均衡组合",
    philosophy: "Net return / forecast risk",
    investedWeight: 0.75,
    rationale: "只在费用后预测为正且通过样本外门槛的基金中，按费用后收益风险比排序。",
  },
  {
    id: "tactical",
    name: "受限趋势组合",
    philosophy: "Net momentum with turnover buffer",
    investedWeight: 0.85,
    rationale: "优先费用后预测收益，但保留主题去重、持仓缓冲和部分调仓，避免每日追逐榜首。",
  },
];

function selectTargets(eligible, previousState) {
  const evidenceRank = { A: 1, B: 2, C: 3 };
  const byEvidence = (a, b) => (evidenceRank[a.evidenceTier] ?? 9) - (evidenceRank[b.evidenceTier] ?? 9);
  const comparators = {
    defensive: (a, b) => byEvidence(a, b) || a.downsideVolatility - b.downsideVolatility || b.maxDrawdown - a.maxDrawdown,
    balanced: (a, b) => byEvidence(a, b) || b.rankingScore - a.rankingScore,
    tactical: (a, b) => byEvidence(a, b) || b.netProjectedReturn - a.netProjectedReturn,
  };
  return DEFINITIONS.map((definition) => {
    const target = chooseDistinct(eligible, 3, comparators[definition.id]);
    const previousPortfolio = previousState?.portfolios?.find((portfolio) => portfolio.id === definition.id);
    const stabilized = applyHoldingBuffer(definition.id, target, previousPortfolio?.positions, eligible);
    return buildPortfolio(definition, stabilized, previousPortfolio);
  });
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function writeState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function collectSignals() {
  const candidateSnapshot = await getRankCandidateSnapshot(CANDIDATES_PER_TYPE);
  const analyzed = [];
  for (let start = 0; start < candidateSnapshot.candidates.length; start += 8) {
    const batch = candidateSnapshot.candidates.slice(start, start + 8);
    const settled = await Promise.allSettled(batch.map(analyzeCandidate));
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value) analyzed.push(result.value);
    }
  }
  const feeCandidates = analyzed
    .filter((item) => item.feeCheckEligible)
    .sort((a, b) => (b.projectedTwoWeekReturn / b.forecastRisk) - (a.projectedTwoWeekReturn / a.forecastRisk))
    .slice(0, 18);
  const feeResults = await Promise.allSettled(feeCandidates.map((item) =>
    getFundFeeProfile(item.code, item.fees.holdingDays)));
  const verifiedByCode = new Map();
  for (let index = 0; index < feeResults.length; index += 1) {
    const result = feeResults[index];
    if (result.status === "fulfilled") verifiedByCode.set(feeCandidates[index].code, result.value);
  }
  const finalized = analyzed.map((item) =>
    verifiedByCode.has(item.code) ? finalizeCandidate(item, verifiedByCode.get(item.code)) : item);
  return {
    ...candidateSnapshot,
    analyzed: finalized,
    analysisCompleteness: candidateSnapshot.candidates.length ? finalized.length / candidateSnapshot.candidates.length : 0,
  };
}

function refreshLockedPortfolios(portfolios, analyzed) {
  const currentByCode = new Map(analyzed.map((item) => [item.code, item]));
  return portfolios.map((portfolio) => {
    const positions = portfolio.positions.map((stored) => {
      const current = currentByCode.get(stored.code);
      return current ? { ...publicFund(current), weight: stored.weight, positionStatus: current.holdingAction } : stored;
    });
    const expectedReturn = positions.reduce((sum, item) => sum + item.weight * (item.netProjectedReturn ?? 0), 0);
    const grossExpectedReturn = positions.reduce((sum, item) => sum + item.weight * (item.projectedTwoWeekReturn ?? 0), 0);
    const investedWeight = positions.reduce((sum, item) => sum + item.weight, 0);
    const tenDayVolatility = Math.max(portfolio.annualizedVolatility * Math.sqrt(HORIZON / 252), 0.005);
    const probability = positions.length ? normalCdfApprox(Math.log(1 + expectedReturn) / tenDayVolatility) : null;
    return {
      ...portfolio,
      positions,
      expectedReturn,
      grossExpectedReturn,
      investedWeight,
      cashWeight: 1 - investedWeight,
      modelProfitProbability: probability,
      score: probability === null ? null : Math.round(Math.max(0, Math.min(100, probability * 100))),
    };
  });
}

function responseFrom(portfolios, signals, state, decisionStatus) {
  const allPositions = portfolios.flatMap((portfolio) => portfolio.positions);
  const allSelected = [...new Map(allPositions.map((position) => [position.code, position])).values()];
  const latestDate = signals.analyzed.map((item) => item.latestDate).sort().at(-1) ?? state?.asOf ?? null;
  const eligibleCount = signals.analyzed.filter((item) => item.eligible).length;
  const tierCounts = signals.analyzed.reduce((counts, item) => {
    if (item.evidenceTier) counts[item.evidenceTier] += 1;
    return counts;
  }, { A: 0, B: 0, C: 0 });
  return {
    portfolios,
    funds: allSelected,
    asOf: latestDate,
    generatedAt: new Date().toISOString(),
    decisionWeek: state?.weekKey ?? weekKey(currentShanghaiDate()),
    nextScheduledReview: addWeekdays(state?.weekKey ?? weekKey(currentShanghaiDate()), 5),
    decisionStatus,
    horizonTradingDays: HORIZON,
    universeSize: signals.candidates.length,
    analyzedCount: signals.analyzed.length,
    eligibleCount,
    tierCounts,
    recommendableCount: tierCounts.A + tierCounts.B + tierCounts.C,
    sourceCompleteness: signals.sourceCompleteness,
    analysisCompleteness: signals.analysisCompleteness,
    methodology: "近月排行榜候选池 → 1/3/12月等权趋势 → 仅用历史样本校准并向零收缩 → 真实费率扣减 → 历史看涨条件胜率分级 → 波动率配置与周度持仓缓冲",
    governance: {
      schedule: "预测信号按净值更新；交易组合每周最多更新一次",
      turnover: "保留满足门槛的原持仓；新增标的需越过缓冲；权重只调整目标变化的50%",
      forecastCalibration: "每个历史时点只用此前样本估计趋势预测的收缩系数；系数限制在0到1，不放大失效信号，也不把趋势自动反转成另一套策略",
      abstention: "A级不足时使用明确标注风险的B/C级条件候选，并按证据等级自动降低投入比例",
      feePolicy: "申购优惠费率和对应持有期赎回费来自公开费率页；实际平台费率仍需下单前核对",
    },
    concentrationWarning: allSelected.length < 3
      ? "当前可用候选不足三只，剩余风险预算保持现金。"
      : "已做主题去重，但基金底层持仓仍可能重合。",
    caveat: "B/C级只表示当前获利期望尚可，不代表已经证明稳定盈利，实际结果仍可能亏损。场外基金采用未知价原则，信号日净值不能当作实际成交净值。",
  };
}

export async function getTwoWeekRecommendations() {
  if (resultCache && Date.now() - resultCache.at < RESULT_TTL) return resultCache.value;
  const [signals, previousState] = await Promise.all([collectSignals(), readState()]);
  const validPreviousState = previousState?.version === STATE_VERSION ? previousState : null;
  const currentWeek = weekKey(currentShanghaiDate());
  const complete = signals.sourceCompleteness >= MIN_SOURCE_COMPLETENESS
    && signals.analysisCompleteness >= MIN_ANALYSIS_COMPLETENESS;

  if (validPreviousState?.weekKey === currentWeek) {
    const portfolios = refreshLockedPortfolios(validPreviousState.portfolios, signals.analyzed);
    const value = responseFrom(portfolios, signals, validPreviousState, complete
      ? "本周组合已锁定；仅更新每日信号，不因名次变化自动换仓"
      : "数据不完整；延续本周已锁定组合，不产生新交易");
    resultCache = { at: Date.now(), value };
    return value;
  }

  if (!complete && validPreviousState?.portfolios?.length) {
    const portfolios = refreshLockedPortfolios(validPreviousState.portfolios, signals.analyzed);
    const value = responseFrom(portfolios, signals, validPreviousState, "数据完整度不足；延续上期组合，不调仓");
    resultCache = { at: Date.now(), value };
    return value;
  }

  const recommendable = signals.analyzed.filter((item) => item.recommendable);
  const portfolios = selectTargets(recommendable, validPreviousState);
  const tierCounts = recommendable.reduce((counts, item) => {
    counts[item.evidenceTier] += 1;
    return counts;
  }, { A: 0, B: 0, C: 0 });
  const state = {
    version: STATE_VERSION,
    weekKey: currentWeek,
    asOf: signals.analyzed.map((item) => item.latestDate).sort().at(-1) ?? null,
    createdAt: new Date().toISOString(),
    portfolios,
  };
  await writeState(state);
  const decisionStatus = tierCounts.A > 0
    ? "本周包含A级强证据候选；仍不保证盈利"
    : tierCounts.B > 0
      ? "本周采用B级条件候选：获利期望尚可，但仍有亏损可能"
      : tierCounts.C > 0
        ? "本周仅有C级高风险观察候选：已降低仓位，亏损风险较高"
        : "没有基金达到宽松候选门槛；保持现金";
  const value = responseFrom(portfolios, signals, state, decisionStatus);
  resultCache = { at: Date.now(), value };
  return value;
}

export async function getHoldingReview(code, options = {}) {
  const cleanCode = validateFundCode(code);
  const fund = await getFundMeta(cleanCode);
  let signal = await analyzeCandidate({ code: cleanCode, name: fund.name, type: fund.type });
  if (!signal) throw new Error("该基金历史数据不足或净值过期，暂时无法评估持仓");
  try {
    signal = finalizeCandidate(signal, await getFundFeeProfile(cleanCode, signal.fees.holdingDays));
  } catch {
    // The holding review will disclose that the current fee could not be verified.
  }
  const purchaseDate = /^\d{4}-\d{2}-\d{2}$/.test(options.purchaseDate || "") ? options.purchaseDate : null;
  const purchaseNav = Number(options.purchaseNav);
  const amount = Number(options.amount);
  const holdingDays = purchaseDate ? calendarDaysBetween(purchaseDate, currentShanghaiDate()) : null;
  let exitFee = signal.fees.redemptionFee;
  let feeSourceUrl = signal.fees.sourceUrl;
  if (holdingDays) {
    try {
      const fees = await getFundFeeProfile(cleanCode, holdingDays);
      exitFee = fees.redemptionFee;
      feeSourceUrl = fees.sourceUrl;
    } catch {
      exitFee = null;
    }
  }
  const expectedAfterExitFee = Number.isFinite(exitFee)
    ? (1 + signal.projectedTwoWeekReturn) * (1 - exitFee) - 1
    : null;
  const unrealizedReturn = Number.isFinite(purchaseNav) && purchaseNav > 0 ? signal.latestNav / purchaseNav - 1 : null;
  const action = expectedAfterExitFee !== null && expectedAfterExitFee <= 0
    ? "复核退出条件"
    : signal.eligible
      ? "本周持有，不追涨加仓"
      : "继续观察，暂不加仓";
  return {
    fund,
    signal: publicFund(signal),
    holding: {
      purchaseDate,
      purchaseNav: Number.isFinite(purchaseNav) && purchaseNav > 0 ? purchaseNav : null,
      amount: Number.isFinite(amount) && amount > 0 ? amount : null,
      holdingDays,
      unrealizedReturn,
      estimatedExitFee: exitFee,
      expectedAfterExitFee,
      feeSourceUrl,
    },
    action,
    rationale: signal.ineligibilityReasons.length
      ? signal.ineligibilityReasons
      : ["费用后预测为正", "样本外R²为正", "历史看涨胜率置信下限不低于50%"],
    disclaimer: "持仓评估不会因为基金掉出主页前三就自动给出卖出指令；实际交易以前台显示的确认净值和销售平台费率为准。",
  };
}
