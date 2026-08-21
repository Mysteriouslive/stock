export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method Not Allowed' }, 405);
    }

    const url = new URL(request.url);
    const source = url.searchParams.get('source');
    const symbolParam = url.searchParams.get('symbol');

    // 1. Forex (美元 / 台幣匯率)
    if (source === 'forex') {
      try {
        const res = await fetch('https://api.frankfurter.dev/v2/rate/USD/TWD', {
          headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
          cf: { cacheTtl: 1800, cacheEverything: true }
        });
        const data = await res.json();
        const rate = Number(data?.rate);
        if (Number.isFinite(rate) && rate > 0) {
          return jsonResponse({ rate, base: 'USD', quote: 'TWD', source: 'Frankfurter' }, 200, { 'Cache-Control': 'public, max-age=1800' });
        }
      } catch {}

      try {
        const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=TWD', {
          headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
          cf: { cacheTtl: 1800, cacheEverything: true }
        });
        const data = await res.json();
        const rate = Number(data?.rates?.TWD);
        if (Number.isFinite(rate) && rate > 0) {
          return jsonResponse({ rate, base: 'USD', quote: 'TWD', source: 'Frankfurter v1' }, 200, { 'Cache-Control': 'public, max-age=1800' });
        }
      } catch {}

      return jsonResponse({ error: 'Forex unavailable' }, 503);
    }

    // 2. Crypto (加密貨幣行情)
    if (source === 'crypto') {
      const cryptoMap = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple', ADA: 'cardano', DOGE: 'dogecoin', BNB: 'binancecoin' };
      try {
        const ids = Object.values(cryptoMap).join(',');
        const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`, {
          headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
          cf: { cacheTtl: 60, cacheEverything: true }
        });
        if (res.ok) {
          const data = await res.json();
          const result = {};
          for (const [sym, id] of Object.entries(cryptoMap)) {
            if (data[id]) {
              result[sym] = {
                usd: Number(data[id].usd),
                usd_24h_change: Number(data[id].usd_24h_change || 0)
              };
            }
          }
          return jsonResponse(result, 200, { 'Cache-Control': 'public, max-age=60' });
        }
      } catch {}

      return jsonResponse({ error: 'Crypto unavailable' }, 503);
    }

    // 3. TWSE Metrics (本益比、殖利率、淨值比)
    if (source === 'twse_metrics') {
      if (!symbolParam) return jsonResponse({ error: 'Missing symbol' }, 400);
      const code = symbolParam.replace(/\.(TW|TWO)$/i, '').replace(/^\^/, '').trim();
      try {
        const twseRes = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL', {
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
          cf: { cacheTtl: 3600, cacheEverything: true }
        });
        if (twseRes.ok) {
          const list = await twseRes.json();
          const item = list.find(x => String(x.Code || x.code) === code);
          if (item) {
            const { pe, dy, pb } = extractPeDyPb(item);
            return jsonResponse({ pe, dividendYield: dy, pb, source: '台灣證交所 (TWSE)' });
          }
        }
      } catch {}

      try {
        const tpexRes = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis', {
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
          cf: { cacheTtl: 3600, cacheEverything: true }
        });
        if (tpexRes.ok) {
          const list = await tpexRes.json();
          const item = list.find(x => String(x.SecuritiesCompanyCode || x.Code) === code);
          if (item) {
            const { pe, dy, pb } = extractPeDyPb(item);
            return jsonResponse({ pe, dividendYield: dy, pb, source: '櫃買中心 (TPEx)' });
          }
        }
      } catch {}

      return jsonResponse({ pe: '—', dividendYield: '—', pb: '—', source: '—' });
    }

    // 4. TWSE / TPEx Chip & History (三大法人與資券)
    if (source === 'twse_chip' || source === 'twse_chip_history') {
      if (!symbolParam) return jsonResponse({ error: 'Missing symbol' }, 400);
      const code = symbolParam.replace(/\.(TW|TWO)$/i, '').trim();
      if (!/^\d{4,6}$/.test(code)) return jsonResponse({ error: 'Taiwan stock code required' }, 400);

      const days = source === 'twse_chip_history' ? Math.min(Math.max(Number(url.searchParams.get('days')) || 15, 5), 15) : 7;
      const candidates = recentTradingDates(days + 6);

      const responses = await Promise.all(candidates.map(async candidate => {
        const [twseInst, twseMargin] = await Promise.all([
          fetchJson(`https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${candidate}&selectType=ALL`, 600),
          fetchJson(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date=${candidate}&selectType=ALL`, 600)
        ]);

        let instRow = twseInst?.data?.find(row => String(row?.[0] || '').trim() === code);
        let instFields = twseInst?.fields || [];
        let institutional = instRow ? parseInstitutionalRow(instFields, instRow) : null;

        if (!institutional) {
          const tpexTable = await fetchTpexInstitutional(candidate);
          if (tpexTable && tpexTable.has(code)) {
            institutional = tpexTable.get(code);
          }
        }

        const marginTable = twseMargin?.tables?.find(table => table?.fields?.includes('代號') && table?.data?.some(row => String(row?.[0] || '').trim() === code));
        const marginRow = marginTable?.data?.find(row => String(row?.[0] || '').trim() === code);
        const margin = marginRow ? parseMarginRow(marginTable?.fields || [], marginRow) : null;

        return (institutional || margin) ? { date: candidate, institutional, margin } : null;
      }));

      const validList = responses.filter(Boolean);

      if (source === 'twse_chip') {
        const latest = validList[0] || {};
        const financial = await fetchFinancialSummary(code);
        return jsonResponse({
          symbol: code,
          date: latest.date || null,
          institutional: latest.institutional || null,
          margin: latest.margin || null,
          financial,
          source: 'TWSE Open Data'
        }, 200, { 'Cache-Control': 'public, max-age=300' });
      } else {
        const history = validList.sort((a, b) => a.date.localeCompare(b.date)).slice(-days);
        return jsonResponse({ symbol: code, history: history.reverse(), source: 'TWSE Open Data' }, 200, { 'Cache-Control': 'public, max-age=600' });
      }
    }

    // 5. TWSE Name
    if (source === 'twse_name') {
      const code = symbolParam.replace(/\.(TW|TWO)$/i, '').replace(/^\^/, '').trim();
      try {
        const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
          cf: { cacheTtl: 86400, cacheEverything: true }
        });
        if (res.ok) {
          const list = await res.json();
          const item = list.find(x => x.Code === code);
          if (item && item.Name) return jsonResponse({ code, name: item.Name });
        }
      } catch {}

      try {
        const res = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', {
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
          cf: { cacheTtl: 86400, cacheEverything: true }
        });
        if (res.ok) {
          const list = await res.json();
          const item = list.find(x => x.SecuritiesCompanyCode === code);
          if (item && item.CompanyName) return jsonResponse({ code, name: item.CompanyName });
        }
      } catch {}

      return jsonResponse({ code, name: null });
    }

    // 6. Finnhub
    if (source === 'finnhub') {
      const finnhubApiKey = env.FINNHUB_API_KEY || '';
      if (!finnhubApiKey) return jsonResponse({ error: 'Finnhub API Key not configured' }, 500);

      const endpoint = url.searchParams.get('endpoint') || 'quote';
      const metric = url.searchParams.get('metric') || 'all';
      let finnhubUrl = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbolParam)}&token=${finnhubApiKey}`;
      if (endpoint === 'profile2') finnhubUrl = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbolParam)}&token=${finnhubApiKey}`;
      if (endpoint === 'metric') finnhubUrl = `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbolParam)}&metric=${metric}&token=${finnhubApiKey}`;

      try {
        const resp = await fetch(finnhubUrl, { headers: { Accept: 'application/json' }, cf: { cacheTtl: 60 } });
        const text = await resp.text();
        return new Response(text, {
          status: resp.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' }
        });
      } catch {
        return jsonResponse({ error: 'Finnhub proxy error' }, 500);
      }
    }

    // 7. Yahoo Finance
    if (!symbolParam) return jsonResponse({ error: 'Missing symbol' }, 400);
    const interval = url.searchParams.get('interval') || '1d';
    const range = url.searchParams.get('range') || '5d';
    let targetSymbol = symbolParam.trim();
    const cacheSeconds = interval === '1m' ? 5 : (interval === '1d' ? 60 : 15);

    const fetchYahoo = async (sym) => {
      const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}&events=history%2Cdiv%2Csplits&includePrePost=true`;
      const res = await fetch(yUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json' },
        cf: { cacheTtl: cacheSeconds, cacheEverything: true }
      });
      if (!res.ok) return null;
      return await res.json();
    };

    try {
      let data = await fetchYahoo(targetSymbol.startsWith('^') || !/^\d{4,6}$/.test(targetSymbol) ? targetSymbol : `${targetSymbol}.TW`);
      if (!data && /^\d{4,6}$/.test(targetSymbol)) data = await fetchYahoo(`${targetSymbol}.TWO`);
      if (!data) return jsonResponse({ error: 'Yahoo query failed', symbol: targetSymbol }, 404);
      return jsonResponse(data, 200, { 'Cache-Control': `public, max-age=${cacheSeconds}` });
    } catch (err) {
      return jsonResponse({ error: 'Proxy internal error', message: String(err) }, 500);
    }
  }
};

function extractPeDyPb(item) {
  let pe = '—', dy = '—', pb = '—';
  for (const [k, v] of Object.entries(item)) {
    const lk = k.toLowerCase();
    if ((lk.includes('pe') || lk.includes('priceearning') || lk.includes('本益比')) && v && v !== '0') pe = String(v);
    if ((lk.includes('dividend') || lk.includes('yield') || lk.includes('殖利率')) && v && v !== '0') dy = String(v).includes('%') ? String(v) : `${v}%`;
    if ((lk.includes('pb') || lk.includes('pricebook') || lk.includes('淨值比')) && v && v !== '0') pb = String(v);
  }
  return { pe, dy, pb };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      ...extraHeaders
    }
  });
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/,/g, '').replace(/--/g, ''));
  return Number.isFinite(number) ? number : null;
}

// 核心修正：外資精準抓取「不含外資自營商」，自營商抓「自行買賣 + 避險」
function parseInstitutionalRow(fields, row) {
  const read = (index) => (index >= 0 ? parseNumber(row[index]) : null);

  const cleanFields = fields.map(f => String(f || '').replace(/\s+/g, ''));

  // 1. 外資：匹配「不含外資自營商」或 TWSE/TPEx 標準外資欄位
  let foreignIdx = cleanFields.findIndex(f => f.includes('不含外資自營商') && f.includes('買賣超'));
  if (foreignIdx < 0) {
    foreignIdx = cleanFields.findIndex(f => (f.includes('外陸資') || f.includes('外資及陸資') || f.includes('外資')) && f.includes('買賣超') && !f.includes('外資自營商買賣超'));
  }
  const foreign = read(foreignIdx) ?? 0;

  // 2. 投信：匹配「投信」買賣超
  const trustIdx = cleanFields.findIndex(f => f.includes('投信') && f.includes('買賣超'));
  const trust = read(trustIdx) ?? 0;

  // 3. 自營商：優先找合計欄位，若無則加總 (自行買賣 + 避險)
  let dealer = null;
  const dealerTotalIdx = cleanFields.findIndex(f => f.includes('自營商買賣超股數合計') || (f.includes('自營商') && f.includes('合計') && f.includes('買賣超')));
  if (dealerTotalIdx >= 0) {
    dealer = read(dealerTotalIdx);
  }

  if (dealer === null) {
    const propIdx = cleanFields.findIndex(f => f.includes('自營商') && f.includes('自行買賣'));
    const hedgeIdx = cleanFields.findIndex(f => f.includes('自營商') && f.includes('避險'));
    
    const propVal = read(propIdx);
    const hedgeVal = read(hedgeIdx);

    if (propVal !== null || hedgeVal !== null) {
      dealer = (propVal ?? 0) + (hedgeVal ?? 0);
    }
  }

  const dealerNet = dealer ?? 0;

  // 4. 三大法人合計
  const totalIdx = cleanFields.findIndex(f => f.includes('三大法人') && f.includes('買賣超'));
  const total = read(totalIdx) ?? (foreign + trust + dealerNet);

  return {
    foreignNet: foreign,
    investmentTrustNet: trust,
    dealerNet: dealerNet,
    totalNet: total
  };
}

async function fetchTpexInstitutional(date) {
  const rocDate = toRocDate(date);
  const url = `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${rocDate}&response=json`;
  const data = await fetchJson(url, 600);
  if (!data) return null;

  const tables = data.tables || [];
  if (!tables.length) return null;
  const rows = tables[0].data || [];
  if (!rows.length) return null;

  const result = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 24) continue;
    const code = String(row[0] || '').trim().replace(/^=/, '').replace(/"/g, '');
    if (!code) continue;

    const foreign = parseNumber(row[10]) ?? 0;
    const trust = parseNumber(row[13]) ?? 0;
    const dealer = parseNumber(row[22]) ?? 0;
    const total = parseNumber(row[23]) ?? (foreign + trust + dealer);

    result.set(code, {
      foreignNet: foreign,
      investmentTrustNet: trust,
      dealerNet: dealer,
      totalNet: total
    });
  }
  return result;
}

function parseMarginRow(fields, row) {
  const findIndex = (group, label) => fields.findIndex(field => String(field).includes(group) && String(field).includes(label));
  const financingBalance = findIndex('融資', '今日餘額');
  const shortBalance = fields.findIndex((field, index) => String(field).includes('今日餘額') && index > financingBalance);
  const financingPrevious = findIndex('融資', '前日餘額');
  const shortPrevious = fields.findIndex((field, index) => String(field).includes('前日餘額') && index > financingPrevious);
  return {
    name: String(row[1] || '').trim(),
    financingBalance: financingBalance >= 0 ? parseNumber(row[financingBalance]) : null,
    financingChange: financingBalance >= 0 && financingPrevious >= 0 ? parseNumber(row[financingBalance]) - parseNumber(row[financingPrevious]) : null,
    shortBalance: shortBalance >= 0 ? parseNumber(row[shortBalance]) : null,
    shortChange: shortBalance >= 0 && shortPrevious >= 0 ? parseNumber(row[shortBalance]) - parseNumber(row[shortPrevious]) : null
  };
}

async function fetchFinancialSummary(code) {
  const rows = await fetchJson('https://openapi.twse.com.tw/v1/opendata/t187ap06_X_ci', 3600);
  const row = Array.isArray(rows) ? rows.find(item => String(item?.['公司代號'] || '') === code) : null;
  if (!row) return null;
  const find = words => {
    const key = Object.keys(row).find(name => words.some(word => name.includes(word)));
    return key ? parseNumber(row[key]) : null;
  };
  return { year: row['年度'] || null, quarter: row['季別'] || null, revenue: find(['營業收入']), grossProfit: find(['營業毛利']), operatingIncome: find(['營業利益']), netIncome: find(['本期淨利', '稅後淨利']) };
}

async function fetchJson(url, cacheTtl) {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, cf: { cacheTtl, cacheEverything: true } });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

function toRocDate(dateStr) {
  const y = Number(dateStr.substring(0, 4)) - 1911;
  return `${y}/${dateStr.substring(4, 6)}/${dateStr.substring(6, 8)}`;
}

function recentTradingDates(days) {
  const dates = [], date = new Date(Date.now() + 8 * 60 * 60 * 1000);
  for (let offset = 0; offset < days; offset++) {
    const candidate = new Date(date); candidate.setUTCDate(candidate.getUTCDate() - offset);
    dates.push(`${candidate.getUTCFullYear()}${String(candidate.getUTCMonth() + 1).padStart(2, '0')}${String(candidate.getUTCDate()).padStart(2, '0')}`);
  }
  return dates;
}