import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAnalysis } from "./model.js";
import { getFundHistory, getFundMeta, searchFunds, validateFundCode } from "./eastmoney.js";
import { getTwoWeekRecommendations } from "./recommendations.js";
import { getStockData, searchStocks } from "./stock-data.js";
import { analyzeStock, getStockRecommendations } from "./stock-analysis.js";
import { llmStatus, reviewEvidence } from "./llm-review.js";
import { discoverLatestReport } from "./report-discovery.js";

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function handleApi(request, response, url) {
  if (url.pathname === "/api/health") {
    return json(response, 200, { ok: true, service: "FundLens MVP", time: new Date().toISOString() });
  }
  if (url.pathname === "/api/llm/status") return json(response, 200, llmStatus());
  const reportMatch = url.pathname.match(/^\/api\/reports\/(a|us)\/([^/]+)$/);
  if (reportMatch) return json(response, 200, await discoverLatestReport(reportMatch[1], decodeURIComponent(reportMatch[2])));
  if (url.pathname === "/api/llm/review" && request.method === "POST") {
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 40_000) throw new Error("提交内容不能超过 40KB");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return json(response, 200, await reviewEvidence(body));
  }
  if (url.pathname === "/api/funds/search") {
    const funds = await searchFunds(url.searchParams.get("q"));
    return json(response, 200, { funds });
  }
  if (url.pathname === "/api/recommendations") {
    const recommendations = await getTwoWeekRecommendations();
    return json(response, 200, recommendations);
  }
  const stockSearch = url.pathname.match(/^\/api\/stocks\/(a|us)\/search$/);
  if (stockSearch) {
    const stocks = await searchStocks(stockSearch[1], url.searchParams.get("q"));
    return json(response, 200, { stocks });
  }
  const stockRecommendations = url.pathname.match(/^\/api\/stocks\/(a|us)\/recommendations$/);
  if (stockRecommendations) {
    return json(response, 200, await getStockRecommendations(stockRecommendations[1]));
  }
  const stockAnalysis = url.pathname.match(/^\/api\/stocks\/(a|us)\/([^/]+)\/analysis$/);
  if (stockAnalysis) {
    const market = stockAnalysis[1];
    const symbol = decodeURIComponent(stockAnalysis[2]);
    const horizon = Math.min(60, Math.max(5, Number(url.searchParams.get("horizon")) || 10));
    const data = await getStockData(market, symbol);
    return json(response, 200, analyzeStock(data.meta, data.history, market, horizon));
  }
  const match = url.pathname.match(/^\/api\/funds\/(\d{6})\/analysis$/);
  if (match) {
    const code = validateFundCode(match[1]);
    const horizon = Math.min(60, Math.max(5, Number(url.searchParams.get("horizon")) || 20));
    const risk = ["conservative", "balanced", "aggressive"].includes(url.searchParams.get("risk"))
      ? url.searchParams.get("risk")
      : "balanced";
    const [fund, history] = await Promise.all([getFundMeta(code), getFundHistory(code)]);
    const analysis = buildAnalysis(history, horizon, risk);
    const latest = history.at(-1);
    const previous = history.at(-2);
    return json(response, 200, {
      fund,
      latest: {
        ...latest,
        change: previous ? latest.nav / previous.nav - 1 : latest.dailyChange,
      },
      history,
      model: analysis,
      meta: {
        horizon,
        riskProfile: risk,
        generatedAt: new Date().toISOString(),
        dataSource: "东方财富公开基金数据",
        modelVersion: "ensemble-mvp-0.1",
        disclaimer: "模型仅基于历史净值进行概率推演，不构成投资建议，不保证未来收益。",
      },
    });
  }
  return json(response, 404, { error: "API 不存在" });
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = normalize(join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("not a file");
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(body);
  } catch {
    const body = await readFile(join(PUBLIC_DIR, "index.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    response.end(body);
  }
}

export const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
    else await serveStatic(response, decodeURIComponent(url.pathname));
  } catch (error) {
    console.error(error);
    json(response, 502, {
      error: error.message || "服务暂时不可用",
      hint: "公开数据接口可能临时限流，请稍后重试。",
    });
  }
});

if (process.env.NODE_ENV !== "test") {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`FundLens MVP running on port ${PORT}`);
  });
}
