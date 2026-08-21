const WORKER_URL = 'https://stock-proxy.stu-108042.workers.dev';

let AUTO_REFRESH_INTERVAL = Number(localStorage.getItem('stockRefreshRate')) || 10000;

// ============================================================
// Symbol 工具
// ============================================================
function isIndexSymbol(symbol) {
    return String(symbol || '').trim().toUpperCase().startsWith('^');
}

function isForexSymbol(symbol) {
    const s = String(symbol || '').toUpperCase().trim();
    return s === 'USDTWD' || s === 'USD/TWD' || s === 'USDTWD=X';
}

function isCryptoSymbol(symbol) {
    const s = String(symbol || '').toUpperCase().replace('-USD', '').trim();
    return ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'BNB'].includes(s);
}

function isTaiwanSymbol(symbol) {
    const s = String(symbol || '').toUpperCase().trim();
    return /^\d{4,6}(\.(TW|TWO))?$/i.test(s);
}

function toYahooSymbol(symbol) {
    let s = String(symbol || '').trim().toUpperCase();
    if (isForexSymbol(s)) return 'USDTWD=X';
    if (isCryptoSymbol(s)) return `${s.replace('-USD', '')}-USD`;
    if (isIndexSymbol(s)) return s;
    if (/^\d{4,6}\.(TW|TWO)$/i.test(s)) return s;
    if (/^\d{4,6}$/.test(s)) return `${s}.TW`;
    return s;
}

function displaySymbol(symbol) {
    return String(symbol || '').replace(/\.(TW|TWO)$/i, '').replace(/=X$/i, '').replace(/-USD$/i, '');
}

function finnhubSymbol(symbol) {
    const displayed = displaySymbol(symbol);
    return isTaiwanSymbol(symbol) ? `${displayed}.TW` : displayed;
}

// ============================================================
// APIs
// ============================================================
async function fetchTwseName(code) {
    try {
        const res = await fetch(`${WORKER_URL}/?source=twse_name&symbol=${encodeURIComponent(displaySymbol(code))}`, { cache: 'no-store' });
        if (!res.ok) return null;
        return (await res.json())?.name || null;
    } catch { return null; }
}

async function fetchTwseMetrics(symbol) {
    try {
        const res = await fetch(`${WORKER_URL}/?source=twse_metrics&symbol=${encodeURIComponent(displaySymbol(symbol))}`, { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

async function fetchFinnhubWorker(symbol, endpoint, params = {}) {
    const query = new URLSearchParams({ source: 'finnhub', symbol: finnhubSymbol(symbol), endpoint, ...params });
    const res = await fetch(`${WORKER_URL}/?${query.toString()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`FINNHUB_PROXY_${res.status}`);
    return await res.json();
}

async function fetchFinnhubQuote(symbol) {
    const data = await fetchFinnhubWorker(symbol, 'quote');
    if (data?.c == null || Number(data.c) <= 0) throw new Error('FINNHUB_NO_QUOTE');
    const current = Number(data.c), previous = Number(data.pc);
    if (!Number.isFinite(previous) || previous <= 0) throw new Error('FINNHUB_NO_PREVIOUS_CLOSE');
    const change = current - previous;
    return {
        latestPrice: formatPrice(current, symbol),
        change: change.toFixed(isForexSymbol(symbol) ? 4 : 2),
        changePercent: ((change / previous) * 100).toFixed(2),
        isUp: change > 0, isFlat: change === 0,
        open: formatPrice(data.o, symbol), high: formatPrice(data.h, symbol),
        low: formatPrice(data.l, symbol), previousClose: formatPrice(previous, symbol), volume: '—'
    };
}

async function fetchFinnhubCompanyProfile(symbol) { return await fetchFinnhubWorker(symbol, 'profile2').catch(() => null); }
async function fetchFinnhubMetrics(symbol) { return await fetchFinnhubWorker(symbol, 'metric', { metric: 'all' }).catch(() => null); }

async function fetchForexData() {
    try {
        const res = await fetch(`${WORKER_URL}/?source=forex`, { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) throw new Error(data?.error || `FOREX_HTTP_${res.status}`);
        const rate = Number(data.rate ?? data.rates?.TWD);
        if (!Number.isFinite(rate) || rate <= 0) throw new Error('FOREX_NO_RATE');
        return { rate, changePercent: Number(data.changePercent ?? data.change_percent ?? data.percentChange ?? NaN), source: data.source || 'Frankfurter' };
    } catch { return null; }
}

async function fetchCryptoData() {
    try {
        const res = await fetch(`${WORKER_URL}/?source=crypto`, { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || data.error) throw new Error(data?.error || `CRYPTO_HTTP_${res.status}`);
        return data;
    } catch { return null; }
}

async function fetchYahooData(symbol, interval = currentPeriod.interval, range = currentPeriod.range) {
    let yahooSymbol = toYahooSymbol(symbol);
    const callApi = async (sym) => {
        const url = `${WORKER_URL}/?symbol=${encodeURIComponent(sym)}&interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('YAHOO_FAILED');
        const json = await res.json();
        if (json?.error) throw new Error(json.error);
        const result = json.chart?.result?.[0];
        if (!result) throw new Error(json.chart?.error?.description || 'NO_YAHOO_DATA');
        return result;
    };

    try {
        return await callApi(yahooSymbol);
    } catch (err) {
        if (/^\d{4,6}\.TW$/i.test(yahooSymbol)) {
            const fallbackSym = yahooSymbol.replace(/\.TW$/i, '.TWO');
            try {
                const res = await callApi(fallbackSym);
                const item = watchlist.find(s => s.symbol === symbol);
                if (item) { item.symbol = fallbackSym; saveWatchlist(); }
                if (currentSymbol === symbol) currentSymbol = fallbackSym;
                return res;
            } catch {}
        } else if (/^\d{4,6}\.TWO$/i.test(yahooSymbol)) {
            const fallbackSym = yahooSymbol.replace(/\.TWO$/i, '.TW');
            try {
                const res = await callApi(fallbackSym);
                const item = watchlist.find(s => s.symbol === symbol);
                if (item) { item.symbol = fallbackSym; saveWatchlist(); }
                if (currentSymbol === symbol) currentSymbol = fallbackSym;
                return res;
            } catch {}
        }
        throw err;
    }
}

// ============================================================
// 資料格式化
// ============================================================
function firstFinite(obj, keys) {
    for (const key of keys) {
        const value = obj?.[key], number = Number(value);
        if (value !== null && value !== undefined && value !== '' && Number.isFinite(number)) return number;
    }
    return null;
}
function formatMetric(value, suffix = '', decimals = 2) { return Number.isFinite(Number(value)) ? `${Number(value).toFixed(decimals)}${suffix}` : '—'; }
function formatPercentMetric(value) { return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : '—'; }
function formatCompactNumber(value) {
    if (!Number.isFinite(Number(value)) || value === '') return '—';
    const n = Number(value), a = Math.abs(n);
    if (a >= 1e12) return `${(n / 1e12).toFixed(2)} 兆`;
    if (a >= 1e9) return `${(n / 1e9).toFixed(2)} 十億`;
    if (a >= 1e6) return `${(n / 1e6).toFixed(2)} 百萬`;
    if (a >= 1e3) return `${(n / 1e3).toFixed(2)} 千`;
    return n.toFixed(2);
}
function formatVolume(value) {
    if (!Number.isFinite(Number(value)) || value === '') return '—';
    const n = Number(value);
    if (n >= 100000000) return `${(n / 100000000).toFixed(2)} 億`;
    if (n >= 10000) return `${(n / 10000).toFixed(2)} 萬`;
    return n.toLocaleString('zh-TW');
}
function formatPrice(value, symbol = '') {
    if (!Number.isFinite(Number(value)) || value === '') return '—';
    const n = Number(value);
    if (isForexSymbol(symbol)) return n.toFixed(4);
    if (isCryptoSymbol(symbol)) return n >= 1 ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 8 });
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

// 修正：嚴格取得當日昨收價，防止多日K線昨收抓錯
function parseQuote(result, symbol = '') {
    const meta = result?.meta || {}, quote = result?.indicators?.quote?.[0] || {};
    let lastClose = null, lastOpen = null, lastHigh = null, lastLow = null, lastVol = null;

    if (Array.isArray(quote.close) && quote.close.length > 0) {
        for (let i = quote.close.length - 1; i >= 0; i--) {
            if (quote.close[i] != null) {
                lastClose = quote.close[i];
                lastOpen = quote.open?.[i];
                lastHigh = quote.high?.[i];
                lastLow = quote.low?.[i];
                lastVol = quote.volume?.[i];
                break;
            }
        }
    }

    // 優先使用正規市場昨收價，避免被 chartPreviousClose (5天前) 污染
    let previousClose = Number(meta.regularMarketPreviousClose ?? meta.previousClose);
    const currentPrice = Number(meta.regularMarketPrice ?? lastClose);

    if (!Number.isFinite(previousClose) || previousClose <= 0) {
        // 如果沒有昨收，嘗試用倒數第二根非空的 close 作為基準
        if (Array.isArray(quote.close)) {
            const validCloses = quote.close.filter(v => v != null && Number.isFinite(Number(v)));
            if (validCloses.length >= 2) {
                previousClose = Number(validCloses[validCloses.length - 2]);
            }
        }
    }

    if (!Number.isFinite(previousClose)) {
        previousClose = Number(meta.chartPreviousClose);
    }

    if (!Number.isFinite(currentPrice)) throw new Error('NO_QUOTE_DATA');

    const change = Number.isFinite(previousClose) ? currentPrice - previousClose : 0;
    const changePercent = Number.isFinite(previousClose) && previousClose > 0 ? (change / previousClose) * 100 : 0;
    const decimals = isForexSymbol(symbol) ? 4 : (isCryptoSymbol(symbol) && currentPrice < 1 ? 6 : 2);

    return {
        latestPrice: formatPrice(currentPrice, symbol),
        change: change.toFixed(decimals),
        changePercent: changePercent.toFixed(2),
        isUp: change > 0,
        isFlat: change === 0,
        open: formatPrice(meta.regularMarketOpen ?? lastOpen, symbol),
        high: formatPrice(meta.regularMarketDayHigh ?? lastHigh, symbol),
        low: formatPrice(meta.regularMarketDayLow ?? lastLow, symbol),
        previousClose: formatPrice(previousClose, symbol),
        volume: formatVolume(meta.regularMarketVolume ?? lastVol)
    };
}

function parseCandles(result) {
    const timestamps = result?.timestamp || [], quote = result?.indicators?.quote?.[0];
    if (!timestamps.length || !quote) throw new Error('NO_CANDLE_DATA');

    const chartData = [];
    for (let i = 0; i < timestamps.length; i++) {
        const open = quote.open?.[i], high = quote.high?.[i], low = quote.low?.[i], close = quote.close?.[i];
        if ([open, high, low, close].some(v => v == null || !Number.isFinite(Number(v)))) continue;
        chartData.push({
            time: ['1d', '1wk', '1mo'].includes(currentPeriod.interval) ? new Date(timestamps[i] * 1000).toISOString().split('T')[0] : timestamps[i],
            open: Number(open), high: Number(high), low: Number(low), close: Number(close)
        });
    }
    return chartData;
}

function applyCurrentPriceToQuote(quote, currentPrice, previousClose, symbol, fallbackChangePercent = NaN) {
    if (!quote) quote = { open: '—', high: '—', low: '—', previousClose: '—', volume: '—' };
    const current = Number(currentPrice), previous = Number(previousClose);
    if (!Number.isFinite(current) || current <= 0) return quote;

    let change = 0, percent = 0;
    if (Number.isFinite(previous) && previous > 0) {
        change = current - previous;
        percent = (change / previous) * 100;
    } else if (Number.isFinite(Number(fallbackChangePercent))) {
        percent = Number(fallbackChangePercent);
        const estPrev = current / (1 + percent / 100);
        if (Number.isFinite(estPrev) && estPrev > 0) { change = current - estPrev; quote.previousClose = formatPrice(estPrev, symbol); }
    }

    const decimals = isForexSymbol(symbol) ? 4 : (isCryptoSymbol(symbol) && current < 1 ? 6 : 2);
    quote.latestPrice = formatPrice(current, symbol);
    quote.change = change.toFixed(decimals);
    quote.changePercent = percent.toFixed(2);
    quote.isUp = change > 0; quote.isFlat = change === 0;
    return quote;
}

// ============================================================
// UI Render Helpers
// ============================================================
function setText(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; }
function setMetric(id, value) { const el = document.getElementById(id); if (el) el.textContent = value ?? '—'; }
function escapeHtmlAttribute(value) { return String(value).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function resetFundamentals() {
    ['metric-pe', 'metric-eps', 'metric-marketcap', 'metric-beta', 'metric-52high', 'metric-52low', 'metric-dividend', 'metric-roe', 'metric-gross-margin', 'metric-op-margin', 'metric-net-margin', 'metric-revenue-growth', 'metric-forward-pe', 'metric-peg', 'metric-ev-ebitda', 'metric-shares', 'profile-country', 'profile-industry', 'profile-ipo', 'profile-currency'].forEach(id => setMetric(id, '—'));
    setMetric('fundamentals-status', '—'); setMetric('fundamentals-note', '—'); setMetric('profile-note', '—');
    const subtitle = document.getElementById('fundamentals-subtitle'); if (subtitle) subtitle.textContent = 'Finnhub · Fundamental Metrics';
    const desc = document.getElementById('profile-description'); if (desc) { desc.textContent = ''; desc.classList.add('hidden'); }
    const link = document.getElementById('company-web-link'); if (link) { link.href = '#'; link.classList.add('hidden'); }
}

function renderFinnhubMetrics(result, profile, symbol) {
    const m = result?.metric || {}, p = profile || {};
    setMetric('metric-pe', formatMetric(firstFinite(m, ['peNormalizedAnnual', 'peTTM', 'peBasicExclExtraTTM', 'peExclExtraTTM'])));
    setMetric('metric-eps', formatMetric(firstFinite(m, ['epsNormalizedAnnual', 'epsTTM', 'epsBasicExclExtraItemsTTM'])));
    setMetric('metric-marketcap', formatCompactNumber(firstFinite(m, ['marketCapitalization'])));
    setMetric('metric-beta', formatMetric(firstFinite(m, ['beta'])));
    setMetric('metric-52high', formatMetric(firstFinite(m, ['52WeekHigh'])));
    setMetric('metric-52low', formatMetric(firstFinite(m, ['52WeekLow'])));
    setMetric('metric-dividend', formatPercentMetric(firstFinite(m, ['dividendYieldIndicatedAnnual', 'dividendYieldTTM', 'currentDividendYieldTTM'])));
    setMetric('metric-roe', formatPercentMetric(firstFinite(m, ['roeTTM', 'roeRfy'])));
    setMetric('metric-gross-margin', formatPercentMetric(firstFinite(m, ['grossMarginTTM', 'grossMargin5Y'])));
    setMetric('metric-op-margin', formatPercentMetric(firstFinite(m, ['operatingMarginTTM', 'operatingMargin5Y'])));
    setMetric('metric-net-margin', formatPercentMetric(firstFinite(m, ['netProfitMarginTTM', 'netProfitMargin5Y'])));
    setMetric('metric-revenue-growth', formatPercentMetric(firstFinite(m, ['revenueGrowthTTMYoy', 'revenueGrowth5Y'])));
    setMetric('metric-forward-pe', formatMetric(firstFinite(m, ['forwardPE', 'peForwardAnnual'])));
    setMetric('metric-peg', formatMetric(firstFinite(m, ['pegRatio', 'peRatio', 'PEG'])));
    setMetric('metric-ev-ebitda', formatMetric(firstFinite(m, ['enterpriseValueEbitdaTTM', 'evToEbitda', 'evEbitda'])));
    setMetric('metric-shares', formatCompactNumber(firstFinite(m, ['shareOutstanding'])));
    setMetric('fundamentals-status', 'Finnhub 已載入'); setMetric('fundamentals-note', `資料來源：Finnhub · ${displaySymbol(symbol)}`);
    setMetric('profile-country', p.country || '—'); setMetric('profile-industry', p.finnhubIndustry || '—'); setMetric('profile-ipo', p.ipo || '—'); setMetric('profile-currency', p.currency || '—');
    const desc = document.getElementById('profile-description'); if (desc && p.name) { desc.textContent = `${p.name}${p.finnhubIndustry ? ` · ${p.finnhubIndustry}` : ''}`; desc.classList.add('hidden'); }
    const link = document.getElementById('company-web-link'); if (link && p.weburl) { link.href = p.weburl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.classList.remove('hidden'); }
    setMetric('profile-note', `公司：${p.name || displaySymbol(symbol)} · 交易所：${p.exchange || '—'}`);
}

function renderTwseMetrics(twseData, symbol, quoteResult, currentPrice) {
    resetFundamentals();
    const isOtc = String(symbol).toUpperCase().includes('.TWO'), marketName = isOtc ? '櫃買中心 (TPEx)' : '證交所 (TWSE)';
    const subtitle = document.getElementById('fundamentals-subtitle'); if (subtitle) subtitle.textContent = `台灣在地市場 · ${twseData?.source || marketName}`;
    const peVal = Number(twseData?.pe), priceVal = Number(String(currentPrice).replace(/,/g, ''));
    setMetric('metric-pe', twseData?.pe !== '0' && twseData?.pe ? twseData.pe : '—');
    if (Number.isFinite(priceVal) && Number.isFinite(peVal) && peVal > 0) setMetric('metric-eps', (priceVal / peVal).toFixed(2));
    setMetric('metric-dividend', twseData?.dividendYield || '—'); setMetric('metric-shares', twseData?.pb || '—');
    const meta = quoteResult?.meta || {}, quotes = quoteResult?.indicators?.quote?.[0] || {};
    let high52 = meta.fiftyTwoWeekHigh, low52 = meta.fiftyTwoWeekLow;
    if (!high52 && Array.isArray(quotes.high)) { const values = quotes.high.filter(v => v != null && Number.isFinite(Number(v))); if (values.length) high52 = Math.max(...values); }
    if (!low52 && Array.isArray(quotes.low)) { const values = quotes.low.filter(v => v != null && Number.isFinite(Number(v))); if (values.length) low52 = Math.min(...values); }
    setMetric('metric-52high', formatPrice(high52, symbol)); setMetric('metric-52low', formatPrice(low52, symbol));
    if (meta.marketCap) setMetric('metric-marketcap', formatCompactNumber(meta.marketCap));
    setMetric('fundamentals-status', `${twseData?.source || marketName} 已載入`); setMetric('fundamentals-note', `資料來源：${twseData?.source || marketName} + Yahoo Finance · 代碼 ${displaySymbol(symbol)}`);
    setMetric('profile-country', '台灣'); setMetric('profile-industry', meta.fullExchangeName || (isOtc ? '上櫃股票' : '上市股票')); setMetric('profile-currency', meta.currency || 'TWD');
    const desc = document.getElementById('profile-description'); if (desc) { desc.textContent = `${meta.longName || displaySymbol(symbol)} - 台灣在地公開資訊（包含本益比、殖利率、股價淨值比，EPS 由股價與本益比推算）。`; desc.classList.add('hidden'); }
    setMetric('profile-note', `市場別：${marketName} · 代碼：${displaySymbol(symbol)}`);
}

function renderCompanyInfo(result, symbol, quote, source = 'Yahoo Finance') {
    const meta = result?.meta || {}, isOtc = String(symbol).toUpperCase().includes('.TWO');
    const mapMarketState = { REGULAR: '正常交易', PRE: '盤前交易', POST: '盤後交易', PREPRE: '盤前', POSTPOST: '盤後', CLOSED: '休市' };
    const mapType = { EQUITY: '股票', ETF: 'ETF', MUTUALFUND: '共同基金', INDEX: '指數', CURRENCY: '外匯', FUTURE: '期貨', CRYPTOCURRENCY: '加密貨幣' };
    
    if (isForexSymbol(symbol)) {
        setCompanyField('company-long-name', '美元/台幣 (USD/TWD)'); setCompanyField('company-exchange', '外匯市場 (Forex)'); setCompanyField('company-market', 'Forex');
        setCompanyField('company-currency', 'TWD'); setCompanyField('company-type', '外匯'); setCompanyField('company-market-state', mapMarketState[meta.marketState] || '全球外匯市場');
        setCompanyField('company-symbol', 'USD/TWD');
    } else if (isCryptoSymbol(symbol)) {
        const nameMap = { BTC: '比特幣', ETH: '以太幣', SOL: 'Solana', XRP: 'XRP', ADA: 'Cardano', DOGE: 'Dogecoin', BNB: 'BNB' };
        setCompanyField('company-long-name', nameMap[displaySymbol(symbol)] || displaySymbol(symbol)); setCompanyField('company-exchange', '加密貨幣'); setCompanyField('company-market', 'Crypto');
        setCompanyField('company-currency', 'USD'); setCompanyField('company-type', '加密貨幣'); setCompanyField('company-market-state', '24 小時市場');
        setCompanyField('company-symbol', displaySymbol(symbol));
    } else {
        const companyName = SPECIAL_NAME_MAP[symbol] || meta.longName || meta.shortName || watchlist.find(s => s.symbol === symbol)?.name || displaySymbol(symbol);
        setCompanyField('company-long-name', companyName); setCompanyField('company-exchange', meta.fullExchangeName || meta.exchangeName || (isOtc ? '櫃買中心 (TPEx)' : '證交所 (TWSE)'));
        setCompanyField('company-market', meta.market || meta.exchangeName || '—'); setCompanyField('company-currency', meta.currency || meta.currencyCode || '—');
        setCompanyField('company-type', mapType[meta.instrumentType || meta.quoteType] || meta.instrumentType || meta.quoteType || '—'); setCompanyField('company-market-state', mapMarketState[meta.marketState] || meta.marketState || '—');
        setCompanyField('company-symbol', displaySymbol(symbol));
    }
    setCompanyField('company-price', quote?.latestPrice || '—');
    const note = document.getElementById('company-info-note'); if (note) note.textContent = `資料來源：${source} · ${meta.fullExchangeName || meta.exchangeName || '交易市場'} · 代碼 ${displaySymbol(symbol)}`;
}

function renderFinnhubCompanyInfo(profile, symbol, quote) {
    const p = profile || {};
    setCompanyField('company-long-name', p.name || watchlist.find(s => s.symbol === symbol)?.name || displaySymbol(symbol));
    setCompanyField('company-exchange', p.exchange || '—'); setCompanyField('company-market', p.finnhubIndustry || '—'); setCompanyField('company-currency', p.currency || '—');
    setCompanyField('company-type', p.shareClassFIGI ? '股票' : '—'); setCompanyField('company-market-state', 'Finnhub 即時資料');
    setCompanyField('company-symbol', displaySymbol(symbol)); setCompanyField('company-price', quote?.latestPrice || '—');
    const note = document.getElementById('company-info-note');
    if (note) {
        const extra = [p.country ? `國家 ${p.country}` : '', p.marketCapitalization ? `市值 ${Number(p.marketCapitalization).toLocaleString('zh-TW')} 百萬` : '', p.ipo ? `IPO ${p.ipo}` : ''].filter(Boolean).join(' · ');
        note.textContent = `資料來源：Finnhub · ${p.exchange || '交易市場'} · ${displaySymbol(symbol)}` + (extra ? ` · ${extra}` : '');
    }
}

function setCompanyField(id, value) { const el = document.getElementById(id); if (el) el.textContent = value ?? '—'; }
function clearCompanyInfo() {
    ['company-long-name', 'company-exchange', 'company-market', 'company-currency', 'company-type', 'company-market-state', 'company-symbol', 'company-price'].forEach(id => setCompanyField(id, '—'));
    const note = document.getElementById('company-info-note'); if (note) note.textContent = '選擇股票後會自動載入公司基本資訊。';
}
function toggleCompanyInfo() {
    const card = document.getElementById('company-info-card'); if (!card) return;
    const button = card.querySelector('button'); card.classList.toggle('collapsed');
    if (button) button.textContent = card.classList.contains('collapsed') ? '展開' : '收合';
}

// ============================================================
// 大盤核心指數看板配置
// ============================================================
const INDICES_CONFIG = [
    { id: 'twii', symbol: '^TWII', name: '加權指數' },
    { id: 'soxx', symbol: 'SOXX', name: '費城半導體 (SOXX)' },
    { id: 'ixic', symbol: '^IXIC', name: 'NASDAQ' },
    { id: 'gspc', symbol: '^GSPC', name: 'S&P 500' }
];

const SPECIAL_NAME_MAP = {
    '^TWII': '加權指數',
    '^TWOII': '櫃買指數',
    'SOXX': '費城半導體 ETF',
    '^IXIC': '那斯達克綜合指數',
    '^GSPC': '標普 500 指數',
    '^DJI': '道瓊工業指數',
    '^SOX': '費城半導體指數'
};

async function fetchMarketIndices() {
    for (const idx of INDICES_CONFIG) {
        try {
            const data = await fetchYahooData(idx.symbol, '1d', '5d');
            if (data) {
                const quote = parseQuote(data, idx.symbol);
                const priceEl = document.getElementById(`idx-${idx.id}-price`);
                const changeEl = document.getElementById(`idx-${idx.id}-change`);
                if (priceEl) priceEl.textContent = quote.latestPrice;
                if (changeEl) {
                    const sign = quote.isUp ? '+' : '';
                    changeEl.textContent = `${sign}${quote.change} (${sign}${quote.changePercent}%)`;
                    changeEl.className = `text-[11px] mt-0.5 font-medium ${quote.isFlat ? 'text-gray-500' : (quote.isUp ? 'price-up' : 'price-down')}`;
                }
            }
        } catch (e) {}
    }
}

// ============================================================
// Watchlist Management
// ============================================================
let watchlist = JSON.parse(localStorage.getItem('stockWatchlist') || 'null') || [
    { symbol: 'AMD', name: '超微', color: 'orange' },
    { symbol: 'USDTWD', name: '美元/台幣匯率', color: 'blue' },
    { symbol: 'BTC', name: '比特幣', color: 'yellow' },
    { symbol: '2330.TW', name: '台積電', color: 'cyan' }
];
let quoteCache = JSON.parse(localStorage.getItem('stockQuoteCache') || '{}');
let sortMode = localStorage.getItem('stockSortMode') || 'manual';
let currentSymbol = localStorage.getItem('stockCurrentSymbol') || (watchlist.length > 0 ? watchlist[0].symbol : null);
let currentPeriod = { interval: '5m', range: '5d', label: '5分K' };
const COLOR_KEYS = ['orange', 'blue', 'green', 'cyan', 'purple', 'pink', 'yellow', 'red', 'indigo', 'teal'];
const COLOR_MAP = { orange: 'bg-orange-500/20 text-orange-400', blue: 'bg-blue-500/20 text-blue-400', green: 'bg-green-500/20 text-green-400', cyan: 'bg-cyan-500/20 text-cyan-400', purple: 'bg-purple-500/20 text-purple-400', pink: 'bg-pink-500/20 text-pink-400', yellow: 'bg-yellow-500/20 text-yellow-400', red: 'bg-red-500/20 text-red-400', indigo: 'bg-indigo-500/20 text-indigo-400', teal: 'bg-teal-500/20 text-teal-400' };

function saveWatchlist() {
    localStorage.setItem('stockWatchlist', JSON.stringify(watchlist));
    localStorage.setItem('stockSortMode', sortMode);
    localStorage.setItem('stockQuoteCache', JSON.stringify(quoteCache));
    if (currentSymbol) localStorage.setItem('stockCurrentSymbol', currentSymbol);
}

function changeSort(value) { sortMode = value; saveWatchlist(); renderWatchlist(); }

function sortedWatchlist() {
    const arr = [...watchlist];
    if (sortMode === 'manual') return arr;
    const getNumber = stock => Number(String(quoteCache[stock.symbol]?.latestPrice ?? '').replace(/,/g, ''));
    const getChange = stock => Number(quoteCache[stock.symbol]?.changePercent ?? NaN);
    arr.sort((a, b) => {
        let av, bv;
        switch (sortMode) {
            case 'symbol-asc': return a.symbol.localeCompare(b.symbol, undefined, { numeric: true });
            case 'symbol-desc': return b.symbol.localeCompare(a.symbol, undefined, { numeric: true });
            case 'name-asc': return (a.name || a.symbol).localeCompare(b.name || b.symbol, 'zh-Hant');
            case 'name-desc': return (b.name || b.symbol).localeCompare(a.name || a.symbol, 'zh-Hant');
            case 'price-asc': av = getNumber(a); bv = getNumber(b); return (Number.isNaN(av) ? Infinity : av) - (Number.isNaN(bv) ? Infinity : bv);
            case 'price-desc': av = getNumber(a); bv = getNumber(b); return (Number.isNaN(bv) ? -Infinity : bv) - (Number.isNaN(av) ? -Infinity : av);
            case 'change-asc': av = getChange(a); bv = getChange(b); return (Number.isNaN(av) ? Infinity : av) - (Number.isNaN(bv) ? Infinity : bv);
            case 'change-desc': av = getChange(a); bv = getChange(b); return (Number.isNaN(bv) ? -Infinity : bv) - (Number.isNaN(av) ? -Infinity : av);
            default: return 0;
        }
    });
    return arr;
}

let sortableInstance = null;
function renderWatchlist() {
    const listEl = document.getElementById('stock-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    const sorted = sortedWatchlist();
    if (sorted.length === 0) { listEl.innerHTML = `<p class="text-center text-gray-600 text-sm py-8">尚未新增任何股票</p>`; return; }

    sorted.forEach(stock => {
        const colorClass = COLOR_MAP[stock.color] || COLOR_MAP.blue, quote = quoteCache[stock.symbol], btn = document.createElement('button');
        btn.className = `stock-btn w-full text-left px-3 py-2.5 rounded-xl text-gray-400 flex items-center gap-2 group ${currentSymbol === stock.symbol ? 'bg-white/10 text-white' : ''}`;
        btn.dataset.symbol = stock.symbol; btn.onclick = () => loadStock(stock.symbol);
        const priceText = quote?.latestPrice ? `<span class="text-[10px] text-gray-400">${quote.latestPrice}</span>` : '';
        const changeNumber = Number(quote?.changePercent);
        const changeText = quote?.changePercent != null && Number.isFinite(changeNumber) ? `<span class="text-[10px] ${changeNumber >= 0 ? 'price-up' : 'price-down'}">${changeNumber >= 0 ? '+' : ''}${changeNumber.toFixed(2)}%</span>` : '';
        btn.innerHTML = `
            <span class="drag-handle text-lg px-2 py-1 ${sortMode === 'manual' ? 'cursor-grab hover:text-white' : 'opacity-30'}" title="${sortMode === 'manual' ? '拖曳排序' : '切換到自訂順序後可拖曳'}">⋮</span>
            <span class="w-8 h-8 rounded-lg ${colorClass} flex items-center justify-center text-[10px] font-bold shrink-0">${displaySymbol(stock.symbol).slice(0, 4)}</span>
            <div class="flex-1 min-w-0">
                <div class="font-medium text-sm truncate">${stock.name || displaySymbol(stock.symbol)}</div>
                <div class="text-[11px] text-gray-500 flex items-center gap-2"><span>${displaySymbol(stock.symbol)}</span>${priceText}${changeText}</div>
            </div>
            <button class="delete-btn text-gray-600 hover:text-red-400 p-1 rounded-lg hover:bg-red-500/10" onclick="event.stopPropagation(); removeStockBySymbol('${escapeHtmlAttribute(stock.symbol)}')" title="移除">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
        `;
        listEl.appendChild(btn);
    });

    if (!sortableInstance && typeof Sortable !== 'undefined') {
        sortableInstance = new Sortable(listEl, {
            animation: 150, handle: '.drag-handle', disabled: sortMode !== 'manual',
            onEnd(evt) {
                if (evt.oldIndex == null || evt.newIndex == null) return;
                const item = watchlist.splice(evt.oldIndex, 1)[0];
                if (!item) return;
                watchlist.splice(evt.newIndex, 0, item);
                saveWatchlist();
            }
        });
    } else if (sortableInstance) {
        sortableInstance.option('disabled', sortMode !== 'manual');
    }
}

async function addStock() {
    const input = document.getElementById('stock-input');
    if (!input) return;
    const raw = input.value.trim().toUpperCase();
    if (!raw) { input.focus(); return; }
    if (!/^[A-Z0-9.\-=\/^]+$/.test(raw)) { alert('請輸入有效的代碼，例如 2330、SOXX、USDTWD、BTC、^TWII'); return; }

    let symbol = raw;
    if (isForexSymbol(raw)) symbol = 'USDTWD';
    else if (isCryptoSymbol(raw)) symbol = raw.replace('-USD', '');
    else if (isIndexSymbol(raw)) symbol = raw;
    else if (/^\d{4,6}$/.test(raw)) {
        try { const twRes = await fetchYahooData(`${raw}.TW`, '1d', '5d'); if (twRes) symbol = `${raw}.TW`; }
        catch { try { const twoRes = await fetchYahooData(`${raw}.TWO`, '1d', '5d'); if (twoRes) symbol = `${raw}.TWO`; } catch { symbol = `${raw}.TW`; } }
    }

    if (watchlist.some(s => s.symbol === symbol || displaySymbol(s.symbol) === displaySymbol(symbol))) { alert(`${displaySymbol(symbol)} 已經在清單中了`); input.value = ''; return; }

    const color = COLOR_KEYS[Math.floor(Math.random() * COLOR_KEYS.length)];
    let name = SPECIAL_NAME_MAP[symbol] || displaySymbol(symbol);
    if (isForexSymbol(symbol)) name = '美元/台幣匯率';
    else if (isCryptoSymbol(symbol)) { const cryptoNames = { BTC: '比特幣', ETH: '以太幣', SOL: 'Solana', XRP: 'XRP', ADA: 'Cardano', DOGE: 'Dogecoin', BNB: 'BNB' }; name = cryptoNames[symbol] || symbol; }
    else if (isTaiwanSymbol(symbol)) name = (await fetchTwseName(displaySymbol(symbol))) || displaySymbol(symbol);

    watchlist.push({ symbol, name, color }); saveWatchlist(); renderWatchlist(); input.value = ''; await loadStock(symbol);
}

function removeStockBySymbol(symbol) { const index = watchlist.findIndex(s => s.symbol === symbol); if (index >= 0) removeStock(index); }
function removeStock(index) {
    const removed = watchlist[index]; if (!removed) return;
    if (!confirm(`確定要移除 ${displaySymbol(removed.symbol)} 嗎？`)) return;
    watchlist.splice(index, 1); delete quoteCache[removed.symbol]; saveWatchlist(); renderWatchlist();
    if (currentSymbol === removed.symbol) {
        currentSymbol = watchlist.length > 0 ? watchlist[0].symbol : null; currentChartData = []; saveWatchlist(); stopAutoRefresh();
        if (currentSymbol) loadStock(currentSymbol);
        else {
            setText('stock-symbol-title', '—'); setText('stock-name', '選擇或新增股票以查看詳情');
            ['current-price', 'price-change', 'open-price', 'high-price', 'low-price', 'previous-close', 'volume', 'last-update'].forEach(id => setText(id, '—'));
            const emptyState = document.getElementById('empty-state'); if (emptyState) emptyState.style.display = 'flex';
            if (candlestickSeries) candlestickSeries.setData([]); clearCompanyInfo(); resetFundamentals();
        }
    }
}

// ============================================================
// 圖表初始化與邏輯
// ============================================================
let chart = null, candlestickSeries = null, currentChartData = [], chartResizeObserver = null, chartResizeHandler = null, autoRefreshTimer = null, isLoadingStock = false;

function initChart() {
    const container = document.getElementById('chart-container');
    if (!container || typeof LightweightCharts === 'undefined' || chart) return false;
    if (container.clientHeight <= 0) container.style.minHeight = window.innerWidth < 768 ? '330px' : '400px';

    const isMobile = window.innerWidth < 768;
    const gridColor = isDarkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)';
    const scaleBorderColor = isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    const textColor = isDarkMode ? '#9ca3af' : '#52525b';

    chart = LightweightCharts.createChart(container, {
        layout: { textColor: textColor, background: { type: 'solid', color: 'transparent' }, fontSize: 12 },
        grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal, vertLine: { color: 'rgba(255,255,255,0.2)', width: 1, style: 2 }, horzLine: { color: 'rgba(255,255,255,0.2)', width: 1, style: 2 } },
        timeScale: {
            borderColor: scaleBorderColor, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true,
            tickMarkFormatter: (time) => {
                const date = new Date(time * 1000), hours = String(date.getHours()).padStart(2, '0'), minutes = String(date.getMinutes()).padStart(2, '0'), month = date.getMonth() + 1, day = date.getDate();
                if (['1d', '1wk', '1mo'].includes(currentPeriod.interval)) return `${month}月${day}日`;
                return `${hours}:${minutes}`;
            }
        },
        rightPriceScale: { borderColor: scaleBorderColor },
        handleScroll: { mouseWheel: false, pressedMouseMove: !isMobile, horzTouchDrag: true, vertTouchDrag: true },
        handleScale: { axisPressedMouseMove: !isMobile, mouseWheel: false, pinch: true }
    });

    candlestickSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
        upColor: '#ef4444', downColor: '#10b981', borderVisible: true,
        borderUpColor: '#ef4444', borderDownColor: '#10b981', wickUpColor: '#ef4444', wickDownColor: '#10b981'
    });

    setupChartResize(container);
    return true;
}

function setupChartResize(container) {
    if (!chart || !container) return;
    if (chartResizeObserver) { try { chartResizeObserver.disconnect(); } catch {} }
    if (chartResizeHandler) window.removeEventListener('resize', chartResizeHandler);

    let lastWidth = 0, lastHeight = 0;
    const resizeChart = () => {
        if (!chart || !container) return;
        let width = container.clientWidth, height = container.clientHeight;
        if (width <= 0) return;
        if (height <= 0) height = window.innerWidth < 768 ? 330 : 400;
        if (width === lastWidth && height === lastHeight) return;
        lastWidth = width; lastHeight = height; chart.applyOptions({ width, height });
    };

    chartResizeHandler = resizeChart;
    chartResizeObserver = new ResizeObserver(() => requestAnimationFrame(resizeChart));
    chartResizeObserver.observe(container);
    window.addEventListener('resize', chartResizeHandler);

    requestAnimationFrame(resizeChart); setTimeout(resizeChart, 100); setTimeout(resizeChart, 500);
}

function setupChartKeyboard() {
    window.addEventListener('keydown', event => {
        if (document.activeElement?.tagName === 'INPUT' || !chart) return;
        const timeScale = chart.timeScale(), visibleRange = timeScale.getVisibleLogicalRange();
        if (!visibleRange) return;
        const span = visibleRange.to - visibleRange.from, zoomFactor = 0.2;
        if (event.key === '+' || event.key === '=') {
            const newSpan = Math.max(5, span * (1 - zoomFactor)), center = (visibleRange.from + visibleRange.to) / 2;
            timeScale.setVisibleLogicalRange({ from: center - newSpan / 2, to: center + newSpan / 2 });
            event.preventDefault();
        } else if (event.key === '-' || event.key === '_') {
            const newSpan = span * (1 + zoomFactor), center = (visibleRange.from + visibleRange.to) / 2;
            timeScale.setVisibleLogicalRange({ from: center - newSpan / 2, to: center + newSpan / 2 });
            event.preventDefault();
        }
    });
}

// ============================================================
// Load Stock 主流程
// ============================================================
async function loadStock(symbol, isSilent = false) {
    if (!symbol || (isLoadingStock && !isSilent)) return;
    currentSymbol = symbol; saveWatchlist();

    if (!isSilent) {
        document.querySelectorAll('.stock-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.symbol === symbol));
        const stockItem = watchlist.find(s => s.symbol === symbol);
        const finalDisplayName = SPECIAL_NAME_MAP[symbol] || stockItem?.name || displaySymbol(symbol);
        setText('stock-symbol-title', finalDisplayName); setText('stock-name', displaySymbol(symbol));
        const loadingBadge = document.getElementById('loading-badge'); if (loadingBadge) loadingBadge.classList.remove('hidden');
        const emptyState = document.getElementById('empty-state'); if (emptyState) emptyState.style.display = 'none';
        ['current-price', 'price-change', 'open-price', 'high-price', 'low-price', 'previous-close', 'volume'].forEach(id => setText(id, '—'));
        const priceChange = document.getElementById('price-change'); if (priceChange) priceChange.className = 'text-sm sm:text-base font-bold px-2.5 py-1 rounded-lg bg-white/5 border border-white/5';
        const currentPrice = document.getElementById('current-price'); if (currentPrice) currentPrice.className = 'text-4xl sm:text-5xl font-black text-white tracking-tight leading-none transition-colors duration-300';
        setText('chart-status', `${currentPeriod.label} · 載入中`); resetFundamentals();
    }

    isLoadingStock = true;
    try {
        let quote = null, chartData = [], yahooResult = null, yahooError = null;

        try {
            yahooResult = await fetchYahooData(symbol);
            if (yahooResult) {
                try { quote = parseQuote(yahooResult, symbol); } catch {}
                try { chartData = parseCandles(yahooResult); } catch {}
            }
        } catch (error) { yahooError = error; }

        if (isForexSymbol(symbol)) {
            try {
                const forex = await fetchForexData();
                if (forex?.rate) {
                    const prevClose = yahooResult?.meta?.regularMarketPreviousClose ?? yahooResult?.meta?.previousClose ?? yahooResult?.meta?.chartPreviousClose;
                    quote = applyCurrentPriceToQuote(quote, forex.rate, prevClose, symbol, forex.changePercent);
                    if (!isSilent) renderCompanyInfo(yahooResult, symbol, quote, yahooResult ? 'Frankfurter 現價 + Yahoo Finance K線' : 'Frankfurter');
                }
            } catch {}
            if (!quote && quoteCache[symbol]) quote = quoteCache[symbol];
        } else if (isCryptoSymbol(symbol)) {
            try {
                const cryptoJson = await fetchCryptoData(), cryptoSymbol = displaySymbol(symbol).toUpperCase(), crypto = cryptoJson?.[cryptoSymbol];
                if (crypto) {
                    const currentPrice = Number(crypto.usd ?? crypto.price), cryptoChange = Number(crypto.usd_24h_change ?? crypto.changePercent ?? crypto.change_24h ?? NaN);
                    const previous = yahooResult?.meta?.regularMarketPreviousClose ?? yahooResult?.meta?.previousClose ?? yahooResult?.meta?.chartPreviousClose;
                    quote = applyCurrentPriceToQuote(quote, currentPrice, previous, symbol, cryptoChange);
                    if (!isSilent) renderCompanyInfo(yahooResult, symbol, quote, yahooResult ? 'CoinGecko 現價 + Yahoo Finance K線' : 'CoinGecko');
                }
            } catch {}
            if (!quote && quoteCache[symbol]) quote = quoteCache[symbol];
        } else if (isTaiwanSymbol(symbol)) {
            let twseMetricsData = null;
            try { twseMetricsData = await fetchTwseMetrics(symbol); } catch {}
            if (twseMetricsData && !isSilent) {
                const rawPrice = quote?.latestPrice ? Number(quote.latestPrice.replace(/,/g, '')) : NaN;
                renderTwseMetrics(twseMetricsData, symbol, yahooResult, rawPrice);
            }
            if (!isSilent && yahooResult) {
                renderCompanyInfo(yahooResult, symbol, quote, `Yahoo Finance + ${String(symbol).toUpperCase().includes('.TWO') ? '櫃買中心' : '證交所'}`);
                const stockItem = watchlist.find(s => s.symbol === symbol);
                if (stockItem && (stockItem.name === displaySymbol(symbol) || !stockItem.name)) {
                    const longName = yahooResult.meta?.longName || yahooResult.meta?.shortName;
                    if (longName) { stockItem.name = longName; saveWatchlist(); renderWatchlist(); setText('stock-symbol-title', longName); }
                }
            }
        } else {
            if (!quote && !isIndexSymbol(symbol)) { try { quote = await fetchFinnhubQuote(symbol); } catch {} }
            if (!isSilent) {
                if (isIndexSymbol(symbol)) renderCompanyInfo(yahooResult, symbol, quote, 'Yahoo Finance');
                else {
                    const companyProfile = await fetchFinnhubCompanyProfile(symbol).catch(() => null), metricResult = await fetchFinnhubMetrics(symbol).catch(() => null);
                    if (companyProfile) renderFinnhubCompanyInfo(companyProfile, symbol, quote);
                    else if (yahooResult) renderCompanyInfo(yahooResult, symbol, quote);
                    if (metricResult) renderFinnhubMetrics(metricResult, companyProfile, symbol);
                }
            }
        }

        if (!quote && quoteCache[symbol]) quote = quoteCache[symbol];
        if (!quote) throw (yahooError || new Error('NO_QUOTE_DATA'));

        quoteCache[symbol] = quote; saveWatchlist();

        setText('current-price', quote.latestPrice); setText('open-price', quote.open); setText('high-price', quote.high); setText('low-price', quote.low); setText('previous-close', quote.previousClose); setText('volume', quote.volume);

        const changeEl = document.getElementById('price-change'), changeNumber = Number(quote.change), changePercent = Number(quote.changePercent);
        const isUp = Number.isFinite(changeNumber) && changeNumber > 0, isDown = Number.isFinite(changeNumber) && changeNumber < 0, isFlat = !isUp && !isDown, sign = isUp ? '+' : '';
        if (changeEl) changeEl.textContent = `${sign}${quote.change} (${sign}${Number.isFinite(changePercent) ? changePercent.toFixed(2) : '0.00'}%)`;

        const currentPriceEl = document.getElementById('current-price');
        const baseChangeClass = 'text-sm sm:text-base font-bold px-2.5 py-1 rounded-lg border transition-colors duration-300';
        const basePriceClass = 'text-4xl sm:text-5xl font-black tracking-tight leading-none transition-colors duration-300';
        if (isFlat) {
            if (changeEl) changeEl.className = `${baseChangeClass} bg-white/5 border-white/5 text-gray-400`;
            if (currentPriceEl) currentPriceEl.className = `${basePriceClass} text-gray-300`;
        } else if (isUp) {
            if (changeEl) changeEl.className = `${baseChangeClass} bg-white/5 border-white/5 price-up`;
            if (currentPriceEl) currentPriceEl.className = `${basePriceClass} price-up`;
        } else {
            if (changeEl) changeEl.className = `${baseChangeClass} bg-white/5 border-white/5 price-down`;
            if (currentPriceEl) currentPriceEl.className = `${basePriceClass} price-down`;
        }

        const stockItem = watchlist.find(s => s.symbol === symbol);
        const finalDisplayName = SPECIAL_NAME_MAP[symbol] || stockItem?.name || yahooResult?.meta?.longName || displaySymbol(symbol);
        setText('stock-symbol-title', finalDisplayName); setText('stock-name', displaySymbol(symbol));

        if (chart && candlestickSeries && chartData.length > 0) {
            currentChartData = chartData; candlestickSeries.setData(chartData);
            try { chart.timeScale().scrollToRealTime(); } catch {}
            setText('chart-status', `${currentPeriod.label} · ${chartData.length} 根`);
        } else {
            if (candlestickSeries && currentChartData.length > 0) {
                candlestickSeries.setData(currentChartData); setText('chart-status', `${currentPeriod.label} · 保留上一筆 K 線`);
            } else { setText('chart-status', yahooError ? 'K線資料暫時無法取得' : '目前週期沒有 K 線資料'); }
        }

        const now = new Date(); setText('last-update', `最後更新：${now.toLocaleString('zh-TW', { hour12: false })}`); renderWatchlist();

    } catch (error) {
        console.error('loadStock error:', error);
        if (!isSilent) {
            setText('chart-status', '資料取得失敗'); setText('stock-name', `找不到 ${displaySymbol(symbol)} 的資料，請確認代碼`); setText('price-change', '載入失敗');
        }
    } finally {
        isLoadingStock = false;
        if (!isSilent) { const loadingBadge = document.getElementById('loading-badge'); if (loadingBadge) loadingBadge.classList.add('hidden'); }
    }

    if (!isSilent && window.innerWidth < 768) {
        const sidebar = document.getElementById('sidebar'), overlay = document.getElementById('overlay');
        if (sidebar) sidebar.classList.remove('open'); if (overlay) overlay.classList.remove('show');
    }

    restartAutoRefresh();
}

function startAutoRefresh() {
    stopAutoRefresh(); if (!currentSymbol) return;
    autoRefreshTimer = setInterval(() => {
        if (!document.hidden) {
            if (currentSymbol) loadStock(currentSymbol, true);
            fetchMarketIndices();
        }
    }, Math.max(AUTO_REFRESH_INTERVAL, 3000));
}
function stopAutoRefresh() { if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; } }
function restartAutoRefresh() { stopAutoRefresh(); if (currentSymbol) startAutoRefresh(); }

document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAutoRefresh();
    else if (currentSymbol) { loadStock(currentSymbol, true); fetchMarketIndices(); startAutoRefresh(); }
});

async function changePeriod(button) {
    if (!button) return;
    document.querySelectorAll('.period-btn').forEach(btn => btn.classList.remove('active')); button.classList.add('active');
    currentPeriod = { interval: button.dataset.interval, range: button.dataset.range, label: button.textContent.trim() };
    setText('chart-status', `${currentPeriod.label} · 載入中`);
    if (currentSymbol) await loadStock(currentSymbol);
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar'), overlay = document.getElementById('overlay');
    if (sidebar) sidebar.classList.toggle('open'); if (overlay) overlay.classList.toggle('show');
}

// ============================================================
// 日夜模式 (Dark / Light Mode) 修正版
// ============================================================
let isDarkMode = localStorage.getItem('stockThemeMode') !== 'light';

function toggleDarkMode() {
    isDarkMode = !isDarkMode;
    localStorage.setItem('stockThemeMode', isDarkMode ? 'dark' : 'light');
    applyDarkModeUI();
}

function applyDarkModeUI() {
    const sunIcon = document.getElementById('theme-sun-icon');
    const moonIcon = document.getElementById('theme-moon-icon');
    
    if (isDarkMode) {
        document.body.classList.remove('light-mode');
        if (sunIcon) sunIcon.classList.add('hidden');
        if (moonIcon) moonIcon.classList.remove('hidden');
    } else {
        document.body.classList.add('light-mode');
        if (sunIcon) sunIcon.classList.remove('hidden');
        if (moonIcon) moonIcon.classList.add('hidden');
    }

    if (chart) {
        chart.applyOptions({
            layout: { 
                textColor: isDarkMode ? '#9ca3af' : '#52525b', 
                background: { type: 'solid', color: 'transparent' } 
            },
            grid: { 
                vertLines: { color: isDarkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }, 
                horzLines: { color: isDarkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' } 
            },
            timeScale: { 
                borderColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' 
            },
            rightPriceScale: { 
                borderColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' 
            }
        });
    }
}

// ============================================================
// 初始化與事件綁定
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
    initChart();
    setupChartKeyboard();
    
    const sortSelect = document.getElementById('sort-select'); 
    if (sortSelect) sortSelect.value = sortMode;
    
    loadUserPreferences(); 
    renderWatchlist(); 
    fetchMarketIndices();
    
    for (const stock of watchlist) {
        if (isTaiwanSymbol(stock.symbol)) {
            const code = displaySymbol(stock.symbol);
            if (stock.name === code || !stock.name || /^\d+$/.test(stock.name)) {
                const fetchedName = await fetchTwseName(code); 
                if (fetchedName) stock.name = fetchedName;
            }
        }
    }
    saveWatchlist(); 
    renderWatchlist();

    if (currentSymbol && watchlist.some(stock => stock.symbol === currentSymbol)) await loadStock(currentSymbol);
    else if (watchlist.length > 0) { currentSymbol = watchlist[0].symbol; await loadStock(currentSymbol); }
    startAutoRefresh();
});

// ============================================================
// Modal
// ============================================================
function toggleModal(modalId, show) {
    const overlay = document.getElementById('modal-overlay'), modal = document.getElementById(modalId);
    if (!overlay || !modal) return;
    if (show) {
        if (window.innerWidth < 768) { const sidebar = document.getElementById('sidebar'); if (sidebar) sidebar.classList.remove('open'); }
        overlay.classList.remove('hidden'); modal.classList.remove('hidden');
        setTimeout(() => { overlay.classList.remove('opacity-0'); modal.classList.remove('opacity-0', 'scale-95'); }, 10);
    } else {
        overlay.classList.add('opacity-0'); modal.classList.add('opacity-0', 'scale-95');
        setTimeout(() => { overlay.classList.add('hidden'); modal.classList.add('hidden'); }, 300);
    }
}
function openSettingsModal() { toggleModal('settings-modal', true); }
function openProfileModal() { toggleModal('profile-modal', true); }
function closeModals() { toggleModal('settings-modal', false); toggleModal('profile-modal', false); }
window.addEventListener('keydown', event => { if (event.key === 'Escape') closeModals(); });

// ============================================================
// 主題色與偏好設定
// ============================================================
const THEMES = {
    blue: { primary: '#3b82f6', secondary: '#8b5cf6', bg1: 'rgba(59, 130, 246, 0.1)', bg2: 'rgba(139, 92, 246, 0.1)' },
    emerald: { primary: '#10b981', secondary: '#06b6d4', bg1: 'rgba(16, 185, 129, 0.1)', bg2: 'rgba(6, 182, 212, 0.1)' },
    purple: { primary: '#a855f7', secondary: '#ec4899', bg1: 'rgba(168, 85, 247, 0.1)', bg2: 'rgba(236, 72, 153, 0.1)' },
    orange: { primary: '#f97316', secondary: '#facc15', bg1: 'rgba(249, 115, 22, 0.1)', bg2: 'rgba(250, 204, 21, 0.1)' }
};

function loadUserPreferences() {
    const savedColorMode = localStorage.getItem('stockKlineColor') || 'red-green';
    const savedRefreshRate = localStorage.getItem('stockRefreshRate') || '10000';
    const savedTheme = localStorage.getItem('stockTheme') || 'blue';

    const colorSelect = document.getElementById('kline-color'), refreshSelect = document.getElementById('refresh-rate');
    if (colorSelect) { colorSelect.value = savedColorMode; colorSelect.onchange = applySettings; }
    if (refreshSelect) { refreshSelect.value = savedRefreshRate; refreshSelect.onchange = applySettings; }

    applyDarkModeUI();
    updateChartColors(savedColorMode);
    AUTO_REFRESH_INTERVAL = Math.max(Number(savedRefreshRate) || 10000, 3000);
    changeThemeColor(savedTheme, false);
}

function changeThemeColor(themeName, save = true) {
    const theme = THEMES[themeName] || THEMES.blue;
    if (save) localStorage.setItem('stockTheme', themeName);

    document.querySelectorAll('.theme-btn').forEach(btn => { btn.classList.remove('ring-2', 'ring-offset-2', 'ring-offset-[#18181b]'); btn.style.boxShadow = ''; });
    const activeBtn = document.getElementById(`theme-btn-${themeName}`);
    if (activeBtn) { activeBtn.classList.add('ring-2', 'ring-offset-2', 'ring-offset-[#18181b]'); activeBtn.style.setProperty('--tw-ring-color', theme.primary); }

    document.documentElement.style.setProperty('--theme-color-1', theme.bg1);
    document.documentElement.style.setProperty('--theme-color-2', theme.bg2);

    let themeStyleTag = document.getElementById('dynamic-theme-vars');
    if (!themeStyleTag) { themeStyleTag = document.createElement('style'); themeStyleTag.id = 'dynamic-theme-vars'; document.head.appendChild(themeStyleTag); }

    themeStyleTag.innerHTML = `
        :root { --theme-primary: ${theme.primary}; --theme-secondary: ${theme.secondary}; }
        .from-blue-400 { --tw-gradient-from: ${theme.primary} !important; }
        .to-purple-400 { --tw-gradient-to: ${theme.secondary} !important; }
        .bg-blue-500\\/20 { background-color: ${theme.primary}33 !important; }
        .text-blue-300 { color: ${theme.primary} !important; }
        .active.period-btn { background-color: ${theme.primary}33 !important; color: ${theme.primary} !important; }
        .bg-blue-600 { background-color: ${theme.primary} !important; }
        .hover\\:bg-blue-500:hover { background-color: ${theme.secondary} !important; }
        .from-blue-600 { --tw-gradient-from: ${theme.primary} !important; }
        .to-purple-600 { --tw-gradient-to: ${theme.secondary} !important; }
        .to-purple-500 { --tw-gradient-to: ${theme.secondary} !important; }
        input:focus, select:focus { border-color: ${theme.primary}80 !important; box-shadow: 0 0 0 1px ${theme.primary}4D !important; }
        body.light-mode .active.period-btn { background-color: ${theme.primary}22 !important; color: ${theme.primary} !important; font-weight: bold; }
    `;
}

function applySettings() {
    const colorSelect = document.getElementById('kline-color'), refreshSelect = document.getElementById('refresh-rate');
    if (!colorSelect || !refreshSelect) return;
    const colorMode = colorSelect.value, refreshRate = refreshSelect.value;

    localStorage.setItem('stockKlineColor', colorMode);
    localStorage.setItem('stockRefreshRate', refreshRate);

    updateChartColors(colorMode);
    AUTO_REFRESH_INTERVAL = Math.max(Number(refreshRate) || 10000, 3000);
    restartAutoRefresh();
}

function updateChartColors(mode) {
    if (candlestickSeries) {
        if (mode === 'green-red') {
            candlestickSeries.applyOptions({ borderVisible: true, upColor: '#10b981', downColor: '#ef4444', borderUpColor: '#10b981', borderDownColor: '#ef4444', wickUpColor: '#10b981', wickDownColor: '#ef4444' });
        } else {
            candlestickSeries.applyOptions({ borderVisible: true, upColor: '#ef4444', downColor: '#10b981', borderUpColor: '#ef4444', borderDownColor: '#10b981', wickUpColor: '#ef4444', wickDownColor: '#10b981' });
        }
    }

    let styleTag = document.getElementById('dynamic-theme-styles');
    if (!styleTag) { styleTag = document.createElement('style'); styleTag.id = 'dynamic-theme-styles'; document.head.appendChild(styleTag); }

    if (mode === 'green-red') {
        styleTag.innerHTML = `
            .price-up { color: #10b981 !important; text-shadow: 0 0 12px rgba(16, 185, 129, 0.25) !important; }
            .price-down { color: #ef4444 !important; text-shadow: 0 0 12px rgba(239, 68, 68, 0.25) !important; }
            body.light-mode .price-up { color: #059669 !important; text-shadow: none !important; }
            body.light-mode .price-down { color: #dc2626 !important; text-shadow: none !important; }
        `;
    } else {
        styleTag.innerHTML = `
            .price-up { color: #ef4444 !important; text-shadow: 0 0 12px rgba(239, 68, 68, 0.25) !important; }
            .price-down { color: #10b981 !important; text-shadow: 0 0 12px rgba(16, 185, 129, 0.25) !important; }
            body.light-mode .price-up { color: #dc2626 !important; text-shadow: none !important; }
            body.light-mode .price-down { color: #059669 !important; text-shadow: none !important; }
        `;
    }

    renderWatchlist();
    fetchMarketIndices();
}

window.addEventListener('resize', () => {
    if (!chart) return;
    const container = document.getElementById('chart-container');
    if (!container) return;
    requestAnimationFrame(() => {
        const width = container.clientWidth; let height = container.clientHeight;
        if (width <= 0) return;
        if (height <= 0) height = window.innerWidth < 768 ? 330 : 400;
        chart.applyOptions({ width, height });
    });
});

// ============================================================
// 全域導出 API
// ============================================================
window.loadStock = loadStock;
window.addStock = addStock;
window.removeStock = removeStock;
window.removeStockBySymbol = removeStockBySymbol;
window.changeSort = changeSort;
window.changePeriod = changePeriod;
window.toggleSidebar = toggleSidebar;
window.openSettingsModal = openSettingsModal;
window.openProfileModal = openProfileModal;
window.closeModals = closeModals;
window.toggleCompanyInfo = toggleCompanyInfo;
window.changeThemeColor = changeThemeColor;
window.applySettings = applySettings;
window.toggleDarkMode = toggleDarkMode;