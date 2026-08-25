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

    // Official TWSE real-time quote.  Use this for listed shares and the
    // TAIEX; Yahoo remains the historical-candle provider.
    if (source === 'twse_realtime') {
      if (!symbolParam) return jsonResponse({ error: 'Missing symbol' }, 400);
      const symbol = symbolParam.trim().toUpperCase();
      const code = symbol.replace(/\.(TW|TWO)$/i, '');
      const isTaiex = code === '^TWII' || code === 'TWII' || code === 'T00';
      if (!isTaiex && !/^\d{4,6}$/.test(code)) return jsonResponse({ error: 'Taiwan symbol required' }, 400);
      const channels = isTaiex ? ['tse_t00.tw'] : [`tse_${code}.tw`, `otc_${code}.tw`];
      try {
        const liveUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(channels.join('|'))}&json=1&delay=0&_=${Date.now()}`;
        const response = await fetch(liveUrl, {
          headers: { Accept: 'application/json', Referer: 'https://mis.twse.com.tw/stock/index.jsp', 'User-Agent': 'Mozilla/5.0' },
          cf: { cacheTtl: 0, cacheEverything: false }
        });
        const payload = await response.json();
        const item = (payload?.msgArray || []).find(entry => {
          const last = parseNumber(entry?.z);
          return Number.isFinite(last) && last > 0;
        });
        if (!item) return jsonResponse({ error: 'TWSE realtime quote unavailable' }, 503);
        const price = parseNumber(item.z), previousClose = parseNumber(item.y);
        const change = Number.isFinite(previousClose) ? price - previousClose : 0;
        return jsonResponse({
          symbol: isTaiex ? '^TWII' : code, date: item.d || null, time: item.t || null,
          price, previousClose, change, changePercent: previousClose > 0 ? change / previousClose * 100 : 0,
          open: parseNumber(item.o), high: parseNumber(item.h), low: parseNumber(item.l),
          volume: (parseNumber(item.v) ?? 0) * 1000, source: 'TWSE MIS'
        }, 200, { 'Cache-Control': 'no-store, max-age=0' });
      } catch (error) {
        return jsonResponse({ error: 'TWSE realtime quote error', message: String(error) }, 503);
      }
    }

    // Official TWSE end-of-day quote. Yahoo's chart metadata can lag or omit
    // the previous close for Taiwan symbols, so use this for the dashboard's
    // price-change and yesterday-close fields.
    if (source === 'twse_quote') {
      if (!symbolParam) return jsonResponse({ error: 'Missing symbol' }, 400);
      const code = symbolParam.replace(/\.(TW|TWO)$/i, '').trim();
      if (!/^\d{4,6}$/.test(code)) return jsonResponse({ error: 'Taiwan stock code required' }, 400);
      for (const date of recentTradingDates(12)) {
        const quote = await fetchTwseCloseForDate(date, code);
        if (quote) return jsonResponse(quote, 200, { 'Cache-Control': 'public, max-age=60' });
      }
      return jsonResponse({ error: 'TWSE quote unavailable' }, 503);
    }

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

      // CoinGecko occasionally rate-limits public requests.  Keep the same
      // response shape with Binance as a fallback so the dashboard remains
      // usable instead of failing the entire crypto watchlist.
      try {
        const pairs = Object.fromEntries(Object.keys(cryptoMap).map(symbol => [symbol, `${symbol}USDT`]));
        const entries = await Promise.all(Object.entries(pairs).map(async ([symbol, pair]) => {
          const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`, {
            headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
            cf: { cacheTtl: 60, cacheEverything: true }
          });
          if (!res.ok) return null;
          const data = await res.json();
          const usd = Number(data?.lastPrice), change = Number(data?.priceChangePercent);
          return Number.isFinite(usd) ? [symbol, { usd, usd_24h_change: Number.isFinite(change) ? change : 0 }] : null;
        }));
        const result = Object.fromEntries(entries.filter(Boolean));
        if (Object.keys(result).length > 0) {
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

      const days = source === 'twse_chip_history' ? Math.min(Math.max(Number(url.searchParams.get('days')) || 15, 5), 30) : 7;

      // 修正:改用「循序嘗試、抓滿即停」取代一次全部平行送出，
      // 避免同時對 TWSE/TPEx 發出過多請求觸發限流或超過 Worker 執行時間。
      // 回溯緩衝加大到 days*1.5+10，涵蓋連續假期(如春節)造成的多日無交易資料狀況。
      const maxLookback = Math.ceil(days * 1.5) + 10;
      const candidates = recentTradingDates(maxLookback);
      const validList = [];
      // Historical rows only need institutional trades.  Skipping the much
      // larger margin endpoint for every date keeps the Worker within its
      // execution budget and lets all requested days reach the frontend.
      // TWSE throttles repeated requests originating from the same Worker IP.
      // Fetching history one trading date at a time is slower, but reliably
      // returns every requested day instead of only the first successful row.
      const BATCH_SIZE = source === 'twse_chip_history' ? 1 : 4;

      for (let i = 0; i < candidates.length && validList.length < days; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(candidate => fetchChipForDate(candidate, code, source === 'twse_chip')));
        for (const result of batchResults) {
          if (result) validList.push(result);
        }
      }

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
        const history = validList
          .sort((a, b) => a.date.localeCompare(b.date))
          .slice(-days);
        return jsonResponse({ symbol: code, history: history.reverse(), source: 'TWSE Open Data' }, 200, { 'Cache-Control': 'public, max-age=60' });
      }
    }

    // 5. TWSE Name
    if (source === 'twse_name') {
      if (!symbolParam) return jsonResponse({ error: 'Missing symbol' }, 400);
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
      if (!symbolParam) return jsonResponse({ error: 'Missing symbol' }, 400);

      const endpoint = url.searchParams.get('endpoint') || 'quote';
      const metric = url.searchParams.get('metric') || 'all';
      let finnhubUrl = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbolParam)}&token=${finnhubApiKey}`;
      if (endpoint === 'profile2') finnhubUrl = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbolParam)}&token=${finnhubApiKey}`;
      if (endpoint === 'metric') finnhubUrl = `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbolParam)}&metric=${encodeURIComponent(metric)}&token=${finnhubApiKey}`;

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

// 修正:PE/PB 的比對關鍵字太短(如 'pe'、'pb')容易誤中其他英文欄位名稱
// (例如包含 "type"、"open" 之類字串)。改用更完整、不易誤判的關鍵字。
function extractPeDyPb(item) {
  let pe = '—', dy = '—', pb = '—';
  for (const [k, v] of Object.entries(item)) {
    const lk = k.toLowerCase().replace(/\s+/g, '');
    const isPe = lk.includes('peratio') || lk.includes('priceearningratio') || k.includes('本益比');
    const isDy = lk.includes('dividendyield') || lk.includes('yieldratio') || k.includes('殖利率');
    const isPb = lk.includes('pbratio') || lk.includes('pricebookratio') || k.includes('股價淨值比') || k.includes('淨值比');

    if (isPe && v && v !== '0') pe = String(v);
    if (isDy && v && v !== '0') dy = String(v).includes('%') ? String(v) : `${v}%`;
    if (isPb && v && v !== '0') pb = String(v);
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

// 新增:單一日期的籌碼資料查詢，抽成獨立函式供批次呼叫使用
async function fetchChipForDate(candidate, code, includeMargin = false) {
  const [twseInst, twseMargin] = await Promise.all([
    fetchJson(`https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${candidate}&selectType=ALL`, 600),
    includeMargin ? fetchJson(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date=${candidate}&selectType=ALL`, 600) : Promise.resolve(null)
  ]);

  let instRow = twseInst?.data?.find(row => String(row?.[0] || '').trim() === code);
  let instFields = twseInst?.fields || [];
  let institutional = instRow ? parseInstitutionalRow(instFields, instRow) : null;

  // Do not call TPEx for weekends and exchange holidays; doing so repeatedly
  // causes upstream throttling before the next valid TWSE date is reached.
  const weekday = new Date(`${candidate.slice(0, 4)}-${candidate.slice(4, 6)}-${candidate.slice(6, 8)}T00:00:00Z`).getUTCDay();
  if (!institutional && weekday !== 0 && weekday !== 6) {
    const tpexTable = await fetchTpexInstitutional(candidate);
    if (tpexTable && tpexTable.has(code)) {
      institutional = tpexTable.get(code);
    }
  }

  // MI_MARGN has used both「證券代號」and「代號」as its first column. Select
  // the security table by its actual stock-code row, not a volatile caption.
  const marginTable = twseMargin?.tables?.find(table => table?.data?.some(row => String(row?.[0] || '').trim() === code && Array.isArray(row) && row.length >= 13));
  const marginRow = marginTable?.data?.find(row => String(row?.[0] || '').trim() === code);
  const margin = marginRow ? parseMarginRow(marginTable?.fields || [], marginRow) : null;

  return (institutional || margin) ? { date: candidate, institutional, margin } : null;
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

// 修正核心 bug:TWSE MI_MARGN (selectType=ALL) 回傳的欄位固定為
// ["代號","名稱","買進","賣出","現金(券)償還","前日餘額","今日餘額","次一營業日限額",
//  "買進","賣出","現券償還","前日餘額","今日餘額","次一營業日限額","資券互抵","註記"]
// 融資與融券的「前日餘額」「今日餘額」欄位名稱完全相同、本身不含「融資」「融券」字樣，
// 只能靠出現順序區分：第一次出現＝融資群組，第二次出現＝融券群組(官方固定順序：資在前、券在後)。
// 原本用 findIndex('融資', '今日餘額') 這種名稱比對永遠找不到融資欄位，導致融資餘額顯示為 null，
// 融券餘額卻誤抓到本屬於融資的數值。
function parseMarginRow(fields, row) {
  const cleanFields = fields.map(f => String(f || '').replace(/\s+/g, ''));

  const findAllIndexes = (label) => cleanFields.reduce((acc, field, index) => {
    if (field.includes(label)) acc.push(index);
    return acc;
  }, []);

  const [financingBalance, shortBalance] = findAllIndexes('今日餘額');
  const [financingPrevious, shortPrevious] = findAllIndexes('前日餘額');

  const has = (index) => Number.isInteger(index) && index >= 0;

  // Current TWSE layout uses 5/6 for financing and 11/12 for short selling.
  // Header lookup remains primary; numeric positions protect against a
  // temporary response-encoding or wording change.
  const financePrev = has(financingPrevious) ? financingPrevious : (row.length > 6 ? 5 : -1);
  const financeNow = has(financingBalance) ? financingBalance : (row.length > 6 ? 6 : -1);
  const shortPrev = has(shortPrevious) ? shortPrevious : (row.length > 12 ? 11 : -1);
  const shortNow = has(shortBalance) ? shortBalance : (row.length > 12 ? 12 : -1);
  const change = (now, previous) => {
    const current = parseNumber(row[now]), prior = parseNumber(row[previous]);
    return current !== null && prior !== null ? current - prior : null;
  };
  return {
    name: String(row[1] || '').trim(),
    financingBalance: has(financeNow) ? parseNumber(row[financeNow]) : null,
    financingChange: has(financeNow) && has(financePrev) ? change(financeNow, financePrev) : null,
    shortBalance: has(shortNow) ? parseNumber(row[shortNow]) : null,
    shortChange: has(shortNow) && has(shortPrev) ? change(shortNow, shortPrev) : null
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

async function fetchTwseCloseForDate(date, code) {
  const data = await fetchJson(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json&date=${date}&type=ALLBUT0999`, 60);
  const table = data?.tables?.find(item => item?.fields?.includes('證券代號') && item?.fields?.includes('收盤價'));
  const row = table?.data?.find(item => String(item?.[0] || '').trim() === code);
  if (!table || !row) return null;
  const indexOf = field => table.fields.indexOf(field);
  const close = parseNumber(row[indexOf('收盤價')]);
  const open = parseNumber(row[indexOf('開盤價')]);
  const high = parseNumber(row[indexOf('最高價')]);
  const low = parseNumber(row[indexOf('最低價')]);
  const volume = parseNumber(row[indexOf('成交股數')]);
  const changeValue = parseNumber(row[indexOf('漲跌價差')]);
  const signText = String(row[indexOf('漲跌(+/-)')] || '').replace(/<[^>]*>/g, '');
  const sign = signText.includes('-') || signText.includes('green') ? -1 : 1;
  if (!Number.isFinite(close)) return null;
  const change = Number.isFinite(changeValue) ? Math.abs(changeValue) * sign : 0;
  const previousClose = close - change;
  return { symbol: code, date, price: close, previousClose, change, changePercent: previousClose > 0 ? change / previousClose * 100 : 0, open, high, low, volume };
}
