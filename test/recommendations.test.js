import test from "node:test";
import assert from "node:assert/strict";
import { parseFundFeeHtml } from "../src/eastmoney.js";
import { applyHoldingBuffer, chooseDistinct, classifyEvidenceTier, eligibilityReasons, isTwoWeekCompatible } from "../src/recommendations.js";

const feeHtml = `
  <label>申购费率</label><table><tr><th>适用金额</th><th>费率</th></tr>
  <tr><td>小于100万元</td><td><strike>1.50%</strike> | 0.15%</td></tr></table>
  <label>赎回费率</label><table><tr><th>适用期限</th><th>赎回费率</th></tr>
  <tr><td>小于等于6天</td><td>1.50%</td></tr>
  <tr><td>大于等于7天，小于等于29天</td><td>0.75%</td></tr>
  <tr><td>大于等于30天</td><td>0.00%</td></tr></table>`;

test("fee parser selects the displayed discount and applicable redemption band", () => {
  const twoWeek = parseFundFeeHtml(feeHtml, 14);
  assert.equal(twoWeek.standardPurchaseFee, 0.015);
  assert.equal(twoWeek.discountedPurchaseFee, 0.0015);
  assert.equal(twoWeek.redemptionFee, 0.0075);
  assert.equal(twoWeek.verified, true);
  assert.equal(parseFundFeeHtml(feeHtml, 3).redemptionFee, 0.015);
});

test("strict eligibility requires fees and sample-out evidence", () => {
  const item = {
    twoWeekCompatible: true,
    fees: { verified: true },
    projectedTwoWeekReturn: 0.02,
    netProjectedReturn: 0.01,
    rsi14: 50,
    backtest: {
      oosR2VsRandomWalk: 0.1,
      predictedUpSamples: 24,
      predictedUpWinRate: 0.6,
      predictedUpInterval95: { lower: 0.51 },
    },
  };
  assert.deepEqual(eligibilityReasons(item), []);
  assert.ok(eligibilityReasons({ ...item, netProjectedReturn: -0.01 }).includes("费用后预测不为正"));
});

test("evidence tiers relax confidence without hiding the risk distinction", () => {
  const base = {
    twoWeekCompatible: true,
    fees: { verified: true },
    netProjectedReturn: 0.01,
    rsi14: 50,
    backtest: {
      oosR2VsRandomWalk: 0.1,
      predictedUpSamples: 24,
      predictedUpWinRate: 0.6,
      predictedUpInterval95: { lower: 0.47 },
    },
  };
  assert.equal(classifyEvidenceTier(base), "B");
  assert.equal(classifyEvidenceTier({ ...base, backtest: { ...base.backtest, predictedUpInterval95: { lower: 0.51 } } }), "A");
  assert.equal(classifyEvidenceTier({ ...base, backtest: { ...base.backtest, oosR2VsRandomWalk: -0.1, predictedUpWinRate: 0.52 } }), "C");
});

test("long holding and retirement products are excluded from a two-week strategy", () => {
  assert.equal(isTwoWeekCompatible("易方达养老2055五年持有混合FOF"), false);
  assert.equal(isTwoWeekCompatible("某某六个月持有混合"), false);
  assert.equal(isTwoWeekCompatible("普通开放式混合A"), true);
});

test("distinct selector preserves the supplied low-risk ordering", () => {
  const items = [
    { code: "A", theme: "one", downsideVolatility: 0.2 },
    { code: "B", theme: "two", downsideVolatility: 0.1 },
    { code: "C", theme: "three", downsideVolatility: 0.15 },
  ];
  const selected = chooseDistinct(items, 3, (a, b) => a.downsideVolatility - b.downsideVolatility);
  assert.deepEqual(selected.map((item) => item.code), ["B", "C", "A"]);
});

test("weekly buffer retains an eligible incumbent for a marginal challenger", () => {
  const incumbent = { code: "OLD", theme: "one", rankingScore: 0.5, downsideVolatility: 0.1, netProjectedReturn: 0.01 };
  const challenger = { code: "NEW", theme: "two", rankingScore: 0.55, downsideVolatility: 0.1, netProjectedReturn: 0.01 };
  const result = applyHoldingBuffer("balanced", [challenger], [{ code: "OLD" }], [incumbent, challenger]);
  assert.equal(result[0].code, "OLD");
});
