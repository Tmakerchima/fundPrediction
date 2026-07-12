const HISTORY_URL = "https://api.fund.eastmoney.com/f10/lsjz";
const SEARCH_URL = "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx";
const RANK_URL = "https://api.fund.eastmoney.com/FundTradeRank/GetRankList";
const FAST_HISTORY_URL = "https://fund.eastmoney.com/pingzhongdata";
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

function cacheGet(key) {
  const item = cache.get(key);
  if (!item || Date.now() - item.at > CACHE_TTL) return null;
  return item.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function eastmoneyFetch(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json,text/plain,*/*",
          Referer: "https://fund.eastmoney.com/",
          "User-Agent": "Mozilla/5.0 FundLens-MVP/0.1",
        },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`数据源返回 HTTP ${response.status}`);
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw new Error(`东方财富连接失败：${lastError?.message ?? "未知错误"}`);
}

async function eastmoneyText(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/javascript,text/plain,*/*",
      Referer: "https://fund.eastmoney.com/",
      "User-Agent": "FundLens-MVP/0.1 (+research-only)",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`数据源返回 HTTP ${response.status}`);
  return response.text();
}

export function validateFundCode(code) {
  if (!/^\d{6}$/.test(code)) throw new Error("基金代码必须是 6 位数字");
  return code;
}

export async function searchFunds(query) {
  const keyword = String(query ?? "").trim().slice(0, 30);
  if (!keyword) return [];
  const key = `search:${keyword}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const params = new URLSearchParams({ m: "1", key: keyword });
  const payload = await eastmoneyFetch(`${SEARCH_URL}?${params}`);
  const results = (payload.Datas ?? [])
    .filter((item) => item.CATEGORYDESC === "基金" && /^\d{6}$/.test(item.CODE))
    .slice(0, 8)
    .map((item) => ({
      code: item.CODE,
      name: item.NAME,
      type: item.FundBaseInfo?.FTYPE ?? "场外基金",
      company: item.FundBaseInfo?.JJGS ?? "",
      latestNav: item.FundBaseInfo?.DWJZ ?? null,
      latestDate: item.FundBaseInfo?.FSRQ ?? null,
      purchasable: item.FundBaseInfo?.ISBUY === "1",
    }));
  return cacheSet(key, results);
}

export async function getFundMeta(code) {
  const results = await searchFunds(validateFundCode(code));
  const exact = results.find((item) => item.code === code);
  if (!exact) throw new Error(`未找到基金 ${code}，请确认它是公开发行的场外基金代码`);
  return exact;
}

export async function getFundHistory(code) {
  validateFundCode(code);
  const key = `history:${code}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const pageSize = 20; // 数据源当前会把更大的 pageSize 强制降为 20。
  const fetchPage = (pageIndex) => {
    const params = new URLSearchParams({
      fundCode: code,
      pageIndex: String(pageIndex),
      pageSize: String(pageSize),
      startDate: "",
      endDate: "",
    });
    return eastmoneyFetch(`${HISTORY_URL}?${params}`);
  };
  const first = await fetchPage(1);
  if (first.ErrCode !== 0 || !first.Data?.LSJZList?.length) {
    throw new Error(first.ErrMsg || `基金 ${code} 暂无可用净值数据`);
  }
  // 约 3.2 个交易年足够支撑 MVP 的 3Y 图表和滚动验证。
  const totalPages = Math.min(40, Math.ceil((first.TotalCount || pageSize) / pageSize));
  const pages = [first];
  for (let start = 2; start <= totalPages; start += 8) {
    const batch = [];
    for (let page = start; page < Math.min(start + 8, totalPages + 1); page += 1) batch.push(fetchPage(page));
    pages.push(...(await Promise.all(batch)));
  }
  const rows = pages.flatMap((page) => page.Data?.LSJZList ?? []);
  const points = rows
    .map((item) => ({
      date: item.FSRQ,
      nav: Number(item.DWJZ),
      accumulatedNav: Number(item.LJJZ) || null,
      dailyChange: Number(item.JZZZL) / 100 || 0,
    }))
    .filter((item) => item.date && Number.isFinite(item.nav) && item.nav > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (points.length < 40) throw new Error("历史净值少于 40 个交易日，暂不支持预测");
  return cacheSet(key, points);
}

export async function getFastFundHistory(code) {
  validateFundCode(code);
  const key = `fast-history:${code}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const source = await eastmoneyText(`${FAST_HISTORY_URL}/${code}.js`);
  const match = source.match(/var Data_netWorthTrend = (\[[\s\S]*?\]);/);
  if (!match) throw new Error(`基金 ${code} 暂无快速净值数据`);
  const rows = JSON.parse(match[1]);
  const points = rows
    .map((item) => ({
      date: new Date(Number(item.x) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10),
      nav: Number(item.y),
      dailyChange: Number(item.equityReturn || 0) / 100,
    }))
    .filter((item) => item.date && Number.isFinite(item.nav) && item.nav > 0)
    .slice(-800);
  if (points.length < 40) throw new Error(`基金 ${code} 历史净值不足`);
  return cacheSet(key, points);
}

function productKey(name) {
  return name
    .replace(/\([^)]*美元[^)]*\)/g, "")
    .replace(/(?:发起式)?[A-E]类?(?:人民币)?$/i, "")
    .replace(/[A-E]$/i, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

export async function getRankCandidates(perType = 10) {
  const key = `rank-candidates:${perType}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const fundTypes = ["gp", "hh", "zs", "zq", "qdii"];
  const payloads = await Promise.allSettled(
    fundTypes.map(async (fundType) => {
      const params = new URLSearchParams({
        ft: fundType,
        sc: "1y",
        st: "desc",
        pi: "1",
        pn: String(perType),
        cp: "",
        ct: "",
        cd: "",
        ms: "",
        fr: "",
        plevel: "",
        fst: "",
        ftype: "",
        fr1: "",
        fl: "0",
        isab: "1",
      });
      return eastmoneyFetch(`${RANK_URL}?${params}`);
    }),
  );
  const raw = payloads.flatMap((result) => {
    if (result.status !== "fulfilled") return [];
    const payload = result.value;
    if (payload.ErrCode !== 0 || !payload.Data) return [];
    const data = typeof payload.Data === "string" ? JSON.parse(payload.Data) : payload.Data;
    return data.datas ?? [];
  });
  const candidates = raw
    .map((entry) => {
      const row = entry.split("|");
      return {
        code: row[0],
        name: row[1],
        type: row[2],
        latestDate: row[3],
        latestNav: Number(row[4]),
        dailyReturn: Number(row[5]) / 100,
        weeklyReturn: Number(row[6]) / 100,
        monthlyReturn: Number(row[7]) / 100,
        quarterlyReturn: Number(row[8]) / 100,
        productKey: productKey(row[1]),
      };
    })
    .filter((item) => /^\d{6}$/.test(item.code) && Number.isFinite(item.latestNav));

  const deduplicated = new Map();
  for (const candidate of candidates) {
    const existing = deduplicated.get(candidate.productKey);
    const candidateIsA = /A(?:类)?(?:人民币)?$/i.test(candidate.name);
    const existingIsA = existing && /A(?:类)?(?:人民币)?$/i.test(existing.name);
    if (!existing || (candidateIsA && !existingIsA)) deduplicated.set(candidate.productKey, candidate);
  }
  return cacheSet(key, [...deduplicated.values()]);
}
