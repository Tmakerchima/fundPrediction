const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

export const A_SHARE_UNIVERSE = [
  { symbol: "600519", name: "贵州茅台", sector: "消费" },
  { symbol: "000858", name: "五粮液", sector: "消费" },
  { symbol: "601318", name: "中国平安", sector: "金融" },
  { symbol: "600036", name: "招商银行", sector: "金融" },
  { symbol: "300750", name: "宁德时代", sector: "新能源" },
  { symbol: "002594", name: "比亚迪", sector: "汽车" },
  { symbol: "600900", name: "长江电力", sector: "公用事业" },
  { symbol: "601899", name: "紫金矿业", sector: "资源" },
  { symbol: "600276", name: "恒瑞医药", sector: "医药" },
  { symbol: "601166", name: "兴业银行", sector: "金融" },
  { symbol: "600030", name: "中信证券", sector: "金融" },
  { symbol: "000333", name: "美的集团", sector: "家电" },
  { symbol: "000651", name: "格力电器", sector: "家电" },
  { symbol: "002415", name: "海康威视", sector: "科技" },
  { symbol: "600887", name: "伊利股份", sector: "消费" },
];

export const US_STOCK_UNIVERSE = [
  { symbol: "AAPL", name: "Apple", sector: "Technology" },
  { symbol: "MSFT", name: "Microsoft", sector: "Technology" },
  { symbol: "NVDA", name: "NVIDIA", sector: "Semiconductors" },
  { symbol: "AMZN", name: "Amazon", sector: "Consumer" },
  { symbol: "GOOGL", name: "Alphabet", sector: "Communication" },
  { symbol: "META", name: "Meta Platforms", sector: "Communication" },
  { symbol: "TSLA", name: "Tesla", sector: "Automotive" },
  { symbol: "JPM", name: "JPMorgan Chase", sector: "Financials" },
  { symbol: "LLY", name: "Eli Lilly", sector: "Healthcare" },
  { symbol: "AVGO", name: "Broadcom", sector: "Semiconductors" },
  { symbol: "COST", name: "Costco", sector: "Consumer" },
  { symbol: "XOM", name: "Exxon Mobil", sector: "Energy" },
  { symbol: "UNH", name: "UnitedHealth", sector: "Healthcare" },
  { symbol: "V", name: "Visa", sector: "Financials" },
  { symbol: "MA", name: "Mastercard", sector: "Financials" },
];

function cacheGet(key) {
  const item = cache.get(key);
  return item && Date.now() - item.at < CACHE_TTL ? item.value : null;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchJson(url, referer = "https://finance.yahoo.com/") {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json,*/*", Referer: referer, "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`行情源返回 HTTP ${response.status}`);
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw new Error(`行情源连接失败：${lastError?.message ?? "未知错误"}`);
}

function aShareSecId(symbol) {
  if (!/^\d{6}$/.test(symbol)) throw new Error("A 股代码必须是 6 位数字");
  return `${/^(5|6|9)/.test(symbol) ? "1" : "0"}.${symbol}`;
}

export function normalizeSymbol(market, symbol) {
  const clean = String(symbol ?? "").trim().toUpperCase();
  if (market === "a") {
    if (!/^\d{6}$/.test(clean)) throw new Error("A 股代码必须是 6 位数字");
  } else if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(clean)) {
    throw new Error("美股代码格式不正确");
  }
  return clean;
}

async function getAHistory(symbol) {
  const exchange = /^(5|6|9)/.test(symbol) ? "sh" : "sz";
  const key = `${exchange}${symbol}`;
  const payload = await fetchJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${key},day,,,1000,qfq`, "https://gu.qq.com/");
  const rows = payload.data?.[key]?.qfqday ?? payload.data?.[key]?.day;
  if (!rows?.length) throw new Error(`未找到 A 股 ${symbol} 的行情`);
  const known = A_SHARE_UNIVERSE.find((item) => item.symbol === symbol);
  return {
    meta: { symbol, name: known?.name ?? symbol, exchange: exchange === "sh" ? "SSE" : "SZSE", currency: "CNY" },
    history: rows.map((row) => {
      return { date: row[0], open: Number(row[1]), close: Number(row[2]), high: Number(row[3]), low: Number(row[4]), volume: Number(row[5]) };
    }).filter((point) => Number.isFinite(point.close)),
  };
}

async function getUSHistory(symbol) {
  const end = new Date();
  const start = new Date(end); start.setUTCFullYear(end.getUTCFullYear() - 7);
  const iso = (date) => date.toISOString().slice(0, 10);
  const params = new URLSearchParams({ assetclass: "stocks", fromdate: iso(start), todate: iso(end), limit: "5000" });
  const payload = await fetchJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?${params}`, "https://www.nasdaq.com/");
  const rows = payload.data?.tradesTable?.rows;
  if (!rows?.length) throw new Error(`未找到美股 ${symbol} 的行情`);
  const number = (value) => Number(String(value ?? "").replace(/[$,]/g, ""));
  const history = rows.map((row) => {
    const [month, day, year] = row.date.split("/");
    return { date: `${year}-${month}-${day}`, open: number(row.open), close: number(row.close), high: number(row.high), low: number(row.low), volume: number(row.volume) };
  }).filter((point) => Number.isFinite(point.close)).sort((a, b) => a.date.localeCompare(b.date));
  return {
    meta: {
      symbol, name: symbol,
      exchange: "US", currency: "USD",
    },
    history,
  };
}

export async function getStockData(market, inputSymbol) {
  const symbol = normalizeSymbol(market, inputSymbol);
  const key = `stock:${market}:${symbol}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const value = market === "a" ? await getAHistory(symbol) : await getUSHistory(symbol);
  const known = (market === "a" ? A_SHARE_UNIVERSE : US_STOCK_UNIVERSE).find((item) => item.symbol === symbol);
  value.meta.sector = known?.sector ?? "未分类";
  if (known?.name) value.meta.name = known.name;
  return cacheSet(key, value);
}

export async function searchStocks(market, query) {
  const keyword = String(query ?? "").trim();
  if (!keyword) return [];
  if (market === "a") {
    const local = A_SHARE_UNIVERSE.filter((item) => item.symbol.includes(keyword) || item.name.includes(keyword)).slice(0, 8);
    if (/^\d{6}$/.test(keyword) && !local.some((item) => item.symbol === keyword)) {
      try { local.unshift((await getStockData("a", keyword)).meta); } catch { /* ignore unknown exact code */ }
    }
    return local.map((item) => ({ symbol: item.symbol, name: item.name, exchange: item.exchange ?? "A股", sector: item.sector ?? "未分类" }));
  }
  const local = US_STOCK_UNIVERSE.filter((item) => item.symbol.includes(keyword.toUpperCase()) || item.name.toLowerCase().includes(keyword.toLowerCase())).slice(0, 8);
  if (/^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(keyword) && !local.some((item) => item.symbol === keyword.toUpperCase())) {
    try { local.unshift((await getStockData("us", keyword)).meta); } catch { /* ignore unknown exact symbol */ }
  }
  return local.map((item) => ({ symbol: item.symbol, name: item.name, exchange: item.exchange ?? "US", sector: item.sector ?? "未分类" }));
}
