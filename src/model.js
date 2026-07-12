const TRADING_DAYS = 252;

export function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function std(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function returnsOf(values) {
  const returns = [];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i - 1] > 0) returns.push(Math.log(values[i] / values[i - 1]));
  }
  return returns;
}

function linearSlope(values) {
  if (values.length < 2) return 0;
  const xAvg = (values.length - 1) / 2;
  const yAvg = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < values.length; i += 1) {
    numerator += (i - xAvg) * (values[i] - yAvg);
    denominator += (i - xAvg) ** 2;
  }
  return denominator ? numerator / denominator : 0;
}

function ewma(values, alpha = 0.12) {
  if (!values.length) return 0;
  let result = values[0];
  for (let i = 1; i < values.length; i += 1) result = alpha * values[i] + (1 - alpha) * result;
  return result;
}

function quantile(values, probability) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - position) + sorted[upper] * (position - lower);
}

function normalCdf(value) {
  return 1 / (1 + Math.exp(-1.702 * value));
}

function maxDrawdown(values) {
  let peak = values[0] ?? 0;
  let worst = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) worst = Math.min(worst, value / peak - 1);
  }
  return worst;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const relativeStrength = gains / losses;
  return 100 - 100 / (1 + relativeStrength);
}

function nextWeekday(dateText, offset) {
  const date = new Date(`${dateText}T00:00:00+08:00`);
  let added = 0;
  while (added < offset) {
    date.setDate(date.getDate() + 1);
    if (date.getDay() !== 0 && date.getDay() !== 6) added += 1;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Forecast log NAV with a conservative ensemble:
 * 45% damped local trend, 35% exponentially weighted momentum, 20% mean reversion.
 */
export function forecastNav(points, horizon = 20) {
  if (points.length < 40) throw new Error("至少需要 40 个净值数据点才能预测");
  const values = points.map((point) => point.nav);
  const latest = values.at(-1);
  const logWindow = values.slice(-60).map(Math.log);
  const recentReturns = returnsOf(values.slice(-91));
  const trendDaily = linearSlope(logWindow);
  const momentumDaily = ewma(recentReturns.slice(-30), 0.12);
  const average60 = mean(values.slice(-60));
  const reversionTotal = Math.log(average60 / latest) * 0.18;
  const residualVol = std(recentReturns.slice(-60));
  const dailyDrift = clamp(0.45 * trendDaily + 0.35 * momentumDaily, -0.012, 0.012);
  const forecast = [];

  for (let step = 1; step <= horizon; step += 1) {
    const damping = (1 - Math.exp(-step / 24)) * 24;
    const reversion = reversionTotal * (1 - Math.exp(-step / 45));
    const logReturn = dailyDrift * damping + 0.2 * reversion;
    const expected = latest * Math.exp(logReturn);
    const uncertainty = Math.max(residualVol, 0.0025) * Math.sqrt(step);
    forecast.push({
      date: nextWeekday(points.at(-1).date, step),
      nav: expected,
      lower80: expected * Math.exp(-1.282 * uncertainty),
      upper80: expected * Math.exp(1.282 * uncertainty),
      lower95: expected * Math.exp(-1.96 * uncertainty),
      upper95: expected * Math.exp(1.96 * uncertainty),
    });
  }
  return forecast;
}

function predictAt(values, horizon) {
  const latest = values.at(-1);
  const logWindow = values.slice(-60).map(Math.log);
  const recentReturns = returnsOf(values.slice(-91));
  const trendDaily = linearSlope(logWindow);
  const momentumDaily = ewma(recentReturns.slice(-30), 0.12);
  const average60 = mean(values.slice(-60));
  const reversionTotal = Math.log(average60 / latest) * 0.18;
  const dailyDrift = clamp(0.45 * trendDaily + 0.35 * momentumDaily, -0.012, 0.012);
  const damping = (1 - Math.exp(-horizon / 24)) * 24;
  const reversion = reversionTotal * (1 - Math.exp(-horizon / 45));
  return latest * Math.exp(dailyDrift * damping + 0.2 * reversion);
}

function wilsonInterval(successes, total, z = 1.96) {
  if (!total) return { lower: 0, upper: 1 };
  const rate = successes / total;
  const denominator = 1 + (z ** 2) / total;
  const center = (rate + (z ** 2) / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt((rate * (1 - rate)) / total + (z ** 2) / (4 * total ** 2));
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

export function backtest(points, horizon = 20) {
  const values = points.map((point) => point.nav);
  const available = Math.min(500, Math.floor(values.length * 0.6));
  const start = Math.max(60, values.length - available - horizon);
  const errors = [];
  const modelSquaredErrors = [];
  const baselineSquaredErrors = [];
  let directionHits = 0;
  let directionCount = 0;
  let predictedUpCount = 0;
  let predictedUpWins = 0;
  let predictedUpRealizedReturn = 0;
  // 使用不重叠的预测窗口，使方向命中率样本更接近统计独立。
  for (let index = start; index + horizon < values.length; index += horizon) {
    const history = values.slice(0, index + 1);
    const predicted = predictAt(history, horizon);
    const actual = values[index + horizon];
    errors.push(Math.abs(predicted - actual) / actual);
    modelSquaredErrors.push((predicted - actual) ** 2);
    baselineSquaredErrors.push((values[index] - actual) ** 2);
    const predictedDirection = Math.sign(predicted / values[index] - 1);
    const actualDirection = Math.sign(actual / values[index] - 1);
    if (predictedDirection === actualDirection) directionHits += 1;
    directionCount += 1;
    if (predictedDirection > 0) {
      predictedUpCount += 1;
      if (actualDirection > 0) predictedUpWins += 1;
      predictedUpRealizedReturn += actual / values[index] - 1;
    }
  }
  const modelSse = modelSquaredErrors.reduce((sum, value) => sum + value, 0);
  const baselineSse = baselineSquaredErrors.reduce((sum, value) => sum + value, 0);
  return {
    samples: errors.length,
    mape: mean(errors),
    directionAccuracy: directionCount ? directionHits / directionCount : 0,
    directionInterval95: wilsonInterval(directionHits, directionCount),
    oosR2VsRandomWalk: baselineSse > 0 ? 1 - modelSse / baselineSse : 0,
    predictedUpSamples: predictedUpCount,
    predictedUpWinRate: predictedUpCount ? predictedUpWins / predictedUpCount : null,
    predictedUpAverageReturn: predictedUpCount ? predictedUpRealizedReturn / predictedUpCount : null,
  };
}

export function analyzeRisk(points, forecast, riskProfile = "balanced") {
  const values = points.map((point) => point.nav);
  const returns = returnsOf(values);
  const latest = values.at(-1);
  const projectedReturn = forecast.at(-1).nav / latest - 1;
  const return20 = values.length > 20 ? latest / values.at(-21) - 1 : 0;
  const return60 = values.length > 60 ? latest / values.at(-61) - 1 : 0;
  const return252 = values.length > 252 ? latest / values.at(-253) - 1 : latest / values[0] - 1;
  const vol = std(returns.slice(-252)) * Math.sqrt(TRADING_DAYS);
  const downside = std(returns.slice(-252).filter((value) => value < 0)) * Math.sqrt(TRADING_DAYS);
  const sharpe = vol ? mean(returns.slice(-252)) * TRADING_DAYS / vol : 0;
  const drawdown = maxDrawdown(values.slice(-252));
  const currentRsi = rsi(values);
  const var95 = Math.abs(quantile(returns.slice(-252), 0.05));
  const ma20 = mean(values.slice(-20));
  const ma60 = mean(values.slice(-60));

  const forecastVolatility = Math.max(vol * Math.sqrt(forecast.length / TRADING_DAYS), 0.005);
  const signalZ = Math.log(1 + projectedReturn) / forecastVolatility;
  // 评分是模型分布假设下的盈利概率，不再是人为加减分表。
  const score = Math.round(clamp(normalCdf(signalZ) * 100, 0, 100));
  let action = "谨慎观察";
  let tone = "neutral";
  const positiveThreshold = riskProfile === "conservative" ? 70 : riskProfile === "aggressive" ? 55 : 60;
  const negativeThreshold = riskProfile === "conservative" ? 40 : 35;
  if (score >= positiveThreshold) {
    action = "可考虑分批定投";
    tone = "positive";
  } else if (score >= 55) {
    action = "小额分批观察";
    tone = "watch";
  } else if (score < negativeThreshold) {
    action = "暂缓新增投入";
    tone = "negative";
  }

  const reasons = [
    `${forecast.length} 个交易日模型中枢${projectedReturn >= 0 ? "上行" : "下行"} ${Math.abs(projectedReturn * 100).toFixed(2)}%`,
    `近 60 日收益 ${return60 >= 0 ? "+" : ""}${(return60 * 100).toFixed(2)}%，趋势${ma20 > ma60 ? "偏强" : "偏弱"}`,
    `近一年年化波动 ${(vol * 100).toFixed(1)}%，最大回撤 ${(drawdown * 100).toFixed(1)}%`,
  ];
  if (currentRsi > 75) reasons.push("RSI 处于偏热区间，短期追高风险增加");
  if (currentRsi < 25) reasons.push("RSI 处于偏冷区间，但不代表已经见底");

  return {
    score,
    action,
    tone,
    reasons,
    metrics: {
      return20,
      return60,
      return252,
      annualizedVolatility: vol,
      downsideVolatility: downside,
      sharpe,
      maxDrawdown: drawdown,
      rsi14: currentRsi,
      dailyVar95: var95,
      projectedReturn,
      forecastVolatility,
      signalZ,
      ma20,
      ma60,
    },
  };
}

export function buildAnalysis(points, horizon = 20, riskProfile = "balanced") {
  const cleanHorizon = clamp(Number(horizon) || 20, 5, 60);
  const forecast = forecastNav(points, cleanHorizon);
  return {
    forecast,
    backtest: backtest(points, Math.min(cleanHorizon, 20)),
    assessment: analyzeRisk(points, forecast, riskProfile),
  };
}
