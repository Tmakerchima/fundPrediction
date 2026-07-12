import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRisk, backtest, buildAnalysis, forecastNav } from "../src/model.js";

function makePoints(length = 320, dailyGrowth = 0.0005) {
  const start = new Date("2024-01-01T00:00:00Z");
  return Array.from({ length }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return {
      date: date.toISOString().slice(0, 10),
      nav: Math.exp(index * dailyGrowth) * (1 + Math.sin(index / 11) * 0.005),
    };
  });
}

test("forecastNav returns bounded intervals and requested horizon", () => {
  const forecast = forecastNav(makePoints(), 20);
  assert.equal(forecast.length, 20);
  for (const point of forecast) {
    assert.ok(point.lower95 < point.lower80);
    assert.ok(point.lower80 < point.nav);
    assert.ok(point.nav < point.upper80);
    assert.ok(point.upper80 < point.upper95);
  }
});

test("upward series creates a finite assessment", () => {
  const points = makePoints();
  const forecast = forecastNav(points, 20);
  const assessment = analyzeRisk(points, forecast, "balanced");
  assert.ok(assessment.score >= 0 && assessment.score <= 100);
  assert.ok(Number.isFinite(assessment.metrics.annualizedVolatility));
  assert.ok(assessment.reasons.length >= 3);
});

test("walk-forward backtest never leaks past the prediction origin", () => {
  const result = backtest(makePoints(), 20);
  assert.ok(result.samples > 3);
  assert.ok(result.mape >= 0);
  assert.ok(result.directionAccuracy >= 0 && result.directionAccuracy <= 1);
  assert.ok(result.directionInterval95.lower <= result.directionAccuracy);
  assert.ok(result.directionInterval95.upper >= result.directionAccuracy);
  assert.ok(Number.isFinite(result.oosR2VsRandomWalk));
});

test("buildAnalysis clamps horizon", () => {
  assert.equal(buildAnalysis(makePoints(), 100).forecast.length, 60);
  assert.equal(buildAnalysis(makePoints(), 1).forecast.length, 5);
});
