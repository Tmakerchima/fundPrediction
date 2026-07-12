const headers = { "User-Agent": "FundLens research MVP admin@example.com", Accept: "application/json,text/html,*/*" };
let secTickers;

async function fetchOk(url, extraHeaders = {}) {
  const response = await fetch(url, { headers: { ...headers, ...extraHeaders }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`报告源返回 HTTP ${response.status}`);
  return response;
}

function plainText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#\d+;/g, " ").replace(/\s+/g, " ").trim();
}

async function usReport(symbol) {
  secTickers ||= await (await fetchOk("https://www.sec.gov/files/company_tickers.json")).json();
  const company = Object.values(secTickers).find((item) => item.ticker.toUpperCase() === symbol.toUpperCase());
  if (!company) throw new Error(`SEC 中未找到 ${symbol}`);
  const cik = String(company.cik_str).padStart(10, "0");
  const submission = await (await fetchOk(`https://data.sec.gov/submissions/CIK${cik}.json`)).json();
  const recent = submission.filings.recent;
  const index = recent.form.findIndex((form) => ["10-K", "10-Q", "20-F", "6-K"].includes(form));
  if (index < 0) throw new Error("没有找到近期财务披露");
  const accession = recent.accessionNumber[index].replace(/-/g, "");
  const document = recent.primaryDocument[index];
  const url = `https://www.sec.gov/Archives/edgar/data/${company.cik_str}/${accession}/${document}`;
  const content = plainText(await (await fetchOk(url)).text()).slice(0, 24_000);
  return { company: submission.name, title: `${recent.form[index]} 财务披露`, form: recent.form[index], publishedAt: recent.filingDate[index], source: "SEC EDGAR", url, readable: content.length >= 80, content };
}

async function aShareReport(symbol) {
  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=100&page_index=1&ann_type=A&stock_list=${symbol}`;
  const payload = await (await fetchOk(url, { Referer: "https://data.eastmoney.com/" })).json();
  const reports = payload.data?.list ?? [];
  const report = reports.find((item) => /(?:年度报告|半年度报告|季度报告)(?!.*摘要)/.test(item.title))
    ?? reports.find((item) => /业绩预告|业绩快报|经营情况/.test(item.title));
  if (!report) throw new Error("没有发现近期定期报告");
  return { company: report.codes?.[0]?.short_name ?? symbol, title: report.title, publishedAt: String(report.notice_date).slice(0, 10), source: "上市公司公告（东方财富索引）", url: `https://pdf.dfcfw.com/pdf/H2_${report.art_code}_1.pdf`, readable: false, content: "" };
}

export async function discoverLatestReport(market, symbol) {
  return market === "us" ? usReport(symbol) : aShareReport(symbol);
}
