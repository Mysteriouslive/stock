const WORKER_URL = 'https://stock-proxy.stu-108042.workers.dev';
const AUTO_REFRESH_INTERVAL = 10000;

function isForexSymbol(symbol) { return symbol === 'USDTWD' || symbol === 'USD/TWD'; }
function isCryptoSymbol(symbol) { return ['BTC', 'ETH', 'SOL', 'XRP', 'ADA'].includes(symbol.toUpperCase()); }

async function fetchForexData() {
    try {
        const res = await fetch(`${WORKER_URL}/?source=forex`, { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) throw new Error(data?.error || `FOREX_HTTP_${res.status}`);
        const rate = Number(data.rate ?? data.rates?.TWD);
        if (!Number.isFinite(rate) || rate <= 0) throw new Error('FOREX_NO_RATE');
        return {
            rate,
            change: Number(data.change) || 0,
            changePercent: Number(data.changePercent) || 0,
            source: data.source || 'Frankfurter'
        };
    } catch (error) {
        console.error('fetchForexData:', error);
        return null;
    }
}

async function fetchCryptoData() {
    try {
        const res = await fetch(`${WORKER_URL}/?source=crypto`, { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || data.error) throw new Error(data?.error || `CRYPTO_HTTP_${res.status}`);
        return data;
    } catch (error) {
        console.error('fetchCryptoData:', error);
        return null;
    }
}

function finnhubSymbol(symbol) {
    return displaySymbol(symbol) + (isTaiwanSymbol(symbol) ? '.TW' : '');
}

async function fetchTwseName(code) {
    try {
        const res = await fetch(`${WORKER_URL}/?source=twse_name&symbol=${encodeURIComponent(code)}`, { cache: 'no-store' });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.name || null;
    } catch { return null; }
}

async function fetchTwseMetrics(symbol) {
    try {
        const code = displaySymbol(symbol);
        const res = await fetch(`${WORKER_URL}/?source=twse_metrics&symbol=${encodeURIComponent(code)}`, { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

async function fetchFinnhubWorker(symbol, endpoint, params = {}) {
    const query = new URLSearchParams({
        source: 'finnhub',
        symbol: finnhubSymbol(symbol),
        endpoint,
        ...params
    });
    const res = await fetch(`${WORKER_URL}/?${query.toString()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('FINNHUB_PROXY_' + res.status);
    return await res.json();
}

async function fetchFinnhubQuote(symbol) {
    const data = await fetchFinnhubWorker(symbol, 'quote');
    if (data.c == null || Number(data.c) <= 0) throw new Error('FINNHUB_NO_QUOTE');
    const current = Number(data.c);
    const previous = Number(data.pc);
    if (!Number.isFinite(previous) || previous <= 0) throw new Error('FINNHUB_NO_PREVIOUS_CLOSE');
    const change = current - previous;
    const changePercent = (change / previous) * 100;
    return {
        latestPrice: formatPrice(current),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        isUp: change > 0,
        isFlat: change === 0,
        open: formatPrice(data.o),
        high: formatPrice(data.h),
        low: formatPrice(data.l),
        previousClose: formatPrice(previous),
        volume: '—'
    };
}

async function fetchFinnhubCompanyProfile(symbol) { return await fetchFinnhubWorker(symbol, 'profile2'); }
async function fetchFinnhubMetrics(symbol) { return await fetchFinnhubWorker(symbol, 'metric', { metric: 'all' }); }

function firstFinite(obj, keys) {
    for (const key of keys) {
        const value = obj?.[key];
        const n = Number(value);
        if (value !== null && value !== undefined && value !== '' && Number.isFinite(n)) return n;
    }
    return null;
}

function formatMetric(value, suffix = '', decimals = 2) {
    if (value == null || value === '') return '—';
    const n = Number(value);
    return Number.isFinite(n) ? `${n.toFixed(decimals)}${suffix}` : '—';
}

function formatPercentMetric(value) {
    if (value == null || value === '') return '—';
    const n = Number(value);
    return Number.isFinite(n) ? `${n.toFixed(2)}%` : '—';
}

function formatCompactNumber(value) {
    if (value == null || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e12) return `${(n/1e12).toFixed(2)} 兆`;
    if (a >= 1e9) return `${(n/1e9).toFixed(2)} 十億`;
    if (a >= 1e6) return `${(n/1e6).toFixed(2)} 百萬`;
    if (a >= 1e3) return `${(n/1e3).toFixed(2)} 千`;
    return n.toFixed(2);
}

function setMetric(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function resetFundamentals() {
    [
        'metric-pe','metric-eps','metric-marketcap','metric-beta',
        'metric-52high','metric-52low','metric-dividend','metric-roe',
        'metric-gross-margin','metric-op-margin','metric-net-margin',
        'metric-revenue-growth','metric-forward-pe','metric-peg',
        'metric-ev-ebitda','metric-shares','profile-country',
        'profile-industry','profile-ipo','profile-currency'
    ].forEach(id => setMetric(id, '—'));
    setMetric('fundamentals-status', '—');
    setMetric('fundamentals-note', '—');
    setMetric('profile-note', '—');
    document.getElementById('fundamentals-subtitle').textContent = 'Finnhub · Fundamental Metrics';
    const desc = document.getElementById('profile-description');
    if (desc) { desc.textContent = ''; desc.classList.add('hidden'); }
    const link = document.getElementById('company-web-link');
    if (link) { link.href = '#'; link.classList.add('hidden'); }
}

function renderFinnhubMetrics(result, profile, symbol) {
    const m = result?.metric || {};
    const p = profile || {};
    setMetric('metric-pe', formatMetric(firstFinite(m, ['peNormalizedAnnual','peTTM','peBasicExclExtraTTM','peExclExtraTTM'])));
    setMetric('metric-eps', formatMetric(firstFinite(m, ['epsNormalizedAnnual','epsTTM','epsBasicExclExtraItemsTTM'])));
    setMetric('metric-marketcap', formatCompactNumber(firstFinite(m, ['marketCapitalization'])));
    setMetric('metric-beta', formatMetric(firstFinite(m, ['beta'])));
    setMetric('metric-52high', formatMetric(firstFinite(m, ['52WeekHigh'])));
    setMetric('metric-52low', formatMetric(firstFinite(m, ['52WeekLow'])));
    setMetric('metric-dividend', formatPercentMetric(firstFinite(m, ['dividendYieldIndicatedAnnual','dividendYieldTTM','currentDividendYieldTTM'])));
    setMetric('metric-roe', formatPercentMetric(firstFinite(m, ['roeTTM','roeRfy'])));
    setMetric('metric-gross-margin', formatPercentMetric(firstFinite(m, ['grossMarginTTM','grossMargin5Y'])));
    setMetric('metric-op-margin', formatPercentMetric(firstFinite(m, ['operatingMarginTTM','operatingMargin5Y'])));
    setMetric('metric-net-margin', formatPercentMetric(firstFinite(m, ['netProfitMarginTTM','netProfitMargin5Y'])));
    setMetric('metric-revenue-growth', formatPercentMetric(firstFinite(m, ['revenueGrowthTTMYoy','revenueGrowth5Y'])));
    setMetric('metric-forward-pe', formatMetric(firstFinite(m, ['forwardPE','peForwardAnnual'])));
    setMetric('metric-peg', formatMetric(firstFinite(m, ['pegRatio','peRatio','PEG'])));
    setMetric('metric-ev-ebitda', formatMetric(firstFinite(m, ['enterpriseValueEbitdaTTM','evToEbitda','evEbitda'])));
    setMetric('metric-shares', formatCompactNumber(firstFinite(m, ['shareOutstanding'])));
    setMetric('fundamentals-status', 'Finnhub 已載入');
    setMetric('fundamentals-note', `資料來源：Finnhub · ${displaySymbol(symbol)}`);
    setMetric('profile-country', p.country || '—');
    setMetric('profile-industry', p.finnhubIndustry || '—');
    setMetric('profile-ipo', p.ipo || '—');
    setMetric('profile-currency', p.currency || '—');
    
    const desc = document.getElementById('profile-description');
    if (desc && p.name) {
        desc.textContent = `${p.name}${p.finnhubIndustry ? ` · ${p.finnhubIndustry}` : ''}`;
        desc.classList.add('hidden');
    }
    const link = document.getElementById('company-web-link');
    if (link && p.weburl) {
        link.href = p.weburl;
        link.classList.remove('hidden');
    }
    setMetric('profile-note', `公司：${p.name || displaySymbol(symbol)} · 交易所：${p.exchange || '—'}`);
}

function renderTwseMetrics(twseData, symbol, quoteResult, currentPrice) {
    resetFundamentals();
    document.getElementById('fundamentals-subtitle').textContent = `台灣證交所/櫃買中心 · ${twseData.source}`;
    
    const peVal = Number(twseData.pe);
    const priceVal = Number(currentPrice);

    setMetric('metric-pe', twseData.pe !== '0' && twseData.pe ? twseData.pe : '—');
    
    if (Number.isFinite(priceVal) && Number.isFinite(peVal) && peVal > 0) {
        const estimatedEps = priceVal / peVal;
        setMetric('metric-eps', estimatedEps.toFixed(2));
    }

    setMetric('metric-dividend', twseData.dividendYield || '—');
    setMetric('metric-shares', twseData.pb || '—'); // 股價淨值比 PB

    const meta = quoteResult?.meta || {};
    const quotes = quoteResult?.indicators?.quote?.[0] || {};
    
    let high52 = meta.fiftyTwoWeekHigh;
    let low52 = meta.fiftyTwoWeekLow;
    
    if (!high52 && quotes.high) {
        high52 = Math.max(...quotes.high.filter(v => v != null));
    }
    if (!low52 && quotes.low) {
        low52 = Math.min(...quotes.low.filter(v => v != null));
    }

    setMetric('metric-52high', formatPrice(high52));
    setMetric('metric-52low', formatPrice(low52));
    
    if (meta.marketCap) {
        setMetric('metric-marketcap', formatCompactNumber(meta.marketCap));
    }

    setMetric('fundamentals-status', `${twseData.source} 已載入`);
    setMetric('fundamentals-note', `資料來源：${twseData.source} + Yahoo Finance · 代碼 ${displaySymbol(symbol)}`);
    
    setMetric('profile-country', '台灣');
    setMetric('profile-industry', meta.fullExchangeName || '上市櫃股票');
    setMetric('profile-currency', meta.currency || 'TWD');
    
    const desc = document.getElementById('profile-description');
    if (desc) {
        desc.textContent = `${meta.longName || displaySymbol(symbol)} - 台灣在地官方公開資訊（包含本益比、殖利率、股價淨值比，EPS 由股價與本益比推算）。`;
        desc.classList.add('hidden');
    }
    setMetric('profile-note', `市場別：${twseData.source} · 代碼：${displaySymbol(symbol)}`);
}

const DEFAULT_STOCKS = [
    { symbol: 'AMD', name: '超微', color: 'orange' },
    { symbol: 'USDTWD', name: '美元/台幣匯率', color: 'blue' },
    { symbol: 'BTC', name: '比特幣', color: 'yellow' },
    { symbol: '2330.TW', name: '台積電', color: 'cyan' }
];

const COLOR_MAP = {
    orange: 'bg-orange-500/20 text-orange-400', blue: 'bg-blue-500/20 text-blue-400',
    green: 'bg-green-500/20 text-green-400', cyan: 'bg-cyan-500/20 text-cyan-400',
    purple: 'bg-purple-500/20 text-purple-400', pink: 'bg-pink-500/20 text-pink-400',
    yellow: 'bg-yellow-500/20 text-yellow-400', red: 'bg-red-500/20 text-red-400',
    indigo: 'bg-indigo-500/20 text-indigo-400', teal: 'bg-teal-500/20 text-teal-400'
};

const COLOR_KEYS = Object.keys(COLOR_MAP);
let watchlist = JSON.parse(localStorage.getItem('stockWatchlist')) || [...DEFAULT_STOCKS];
let quoteCache = JSON.parse(localStorage.getItem('stockQuoteCache') || '{}');
let sortMode = localStorage.getItem('stockSortMode') || 'manual';
let currentSymbol = localStorage.getItem('stockCurrentSymbol') || (watchlist.length > 0 ? watchlist[0].symbol : null);

let currentPeriod = { interval: '5m', range: '5d', label: '5分K' };

function normalizeSymbol(input) {
    let s = input.trim().toUpperCase();
    if (isForexSymbol(s)) return 'USDTWD';
    if (isCryptoSymbol(s)) return s;
    if (/^\d{4,6}\.(TW|TWO)$/.test(s)) return s;
    if (/^\d{4,6}$/.test(s)) return `${s}.TW`;
    return s;
}

function displaySymbol(symbol) { return symbol.replace(/\.(TW|TWO)$/i, ''); }
function isTaiwanSymbol(symbol) { return /^\d{4,6}\.(TW|TWO)$/i.test(symbol) || /^\d{4,6}$/.test(symbol); }

function saveWatchlist() {
    localStorage.setItem('stockWatchlist', JSON.stringify(watchlist));
    localStorage.setItem('stockSortMode', sortMode);
    localStorage.setItem('stockQuoteCache', JSON.stringify(quoteCache));
    if (currentSymbol) {
        localStorage.setItem('stockCurrentSymbol', currentSymbol);
    }
}

function changeSort(value) {
    sortMode = value;
    saveWatchlist();
    renderWatchlist();
}

function sortedWatchlist() {
    const arr = [...watchlist];
    if (sortMode === 'manual') return arr;
    const getNumber = stock => Number(quoteCache[stock.symbol]?.latestPrice ?? NaN);
    const getChange = stock => Number(quoteCache[stock.symbol]?.changePercent ?? NaN);
    arr.sort((a, b) => {
        let av, bv;
        switch (sortMode) {
            case 'symbol-asc': return a.symbol.localeCompare(b.symbol, undefined, { numeric: true });
            case 'symbol-desc': return b.symbol.localeCompare(a.symbol, undefined, { numeric: true });
            case 'name-asc': return (a.name || a.symbol).localeCompare(b.name || b.symbol, 'zh-Hant');
            case 'name-desc': return (b.name || b.symbol).localeCompare(a.name || a.symbol, 'zh-Hant');
            case 'price-asc':
                av = getNumber(a); bv = getNumber(b);
                return (Number.isNaN(av) ? Infinity : av) - (Number.isNaN(bv) ? Infinity : bv);
            case 'price-desc':
                av = getNumber(a); bv = getNumber(b);
                return (Number.isNaN(bv) ? -Infinity : bv) - (Number.isNaN(av) ? -Infinity : av);
            case 'change-asc':
                av = getChange(a); bv = getChange(b);
                return (Number.isNaN(av) ? Infinity : av) - (Number.isNaN(bv) ? Infinity : bv);
            case 'change-desc':
                av = getChange(a); bv = getChange(b);
                return (Number.isNaN(bv) ? -Infinity : bv) - (Number.isNaN(av) ? -Infinity : av);
            default: return 0;
        }
    });
    return arr;
}

let sortableInstance = null;

function renderWatchlist() {
    const listEl = document.getElementById('stock-list');
    listEl.innerHTML = '';
    
    const sorted = sortedWatchlist();
    if (sorted.length === 0) {
        listEl.innerHTML = `<p class="text-center text-gray-600 text-sm py-8">尚未新增任何股票</p>`;
        return;
    }
    
    sorted.forEach((stock) => {
        const colorClass = COLOR_MAP[stock.color] || COLOR_MAP.blue;
        const quote = quoteCache[stock.symbol];
        const btn = document.createElement('button');
        
        btn.className = `stock-btn w-full text-left px-3 py-2.5 rounded-xl text-gray-400 flex items-center gap-2 group ${currentSymbol === stock.symbol ? 'bg-white/10 text-white' : ''}`;
        btn.dataset.symbol = stock.symbol;
        btn.onclick = () => loadStock(stock.symbol);
        
        const priceText = quote?.latestPrice ? `<span class="text-[10px] text-gray-400">${quote.latestPrice}</span>` : '';
        const changeText = quote?.changePercent ? `<span class="text-[10px] ${Number(quote.changePercent) >= 0 ? 'price-up' : 'price-down'}">${Number(quote.changePercent) >= 0 ? '+' : ''}${Number(quote.changePercent).toFixed(2)}%</span>` : '';
        
        btn.innerHTML = `
            <span class="drag-handle text-lg px-2 py-1 ${sortMode === 'manual' ? 'cursor-grab hover:text-white' : 'opacity-30'}" title="${sortMode === 'manual' ? '拖曳排序' : '切換到自訂順序後可拖曳'}">⋮</span>
            <span class="w-8 h-8 rounded-lg ${colorClass} flex items-center justify-center text-[10px] font-bold shrink-0">${displaySymbol(stock.symbol).slice(0, 4)}</span>
            <div class="flex-1 min-w-0">
                <div class="font-medium text-sm truncate">${stock.name || displaySymbol(stock.symbol)}</div>
                <div class="text-[11px] text-gray-500 flex items-center gap-2"><span>${displaySymbol(stock.symbol)}</span>${priceText}${changeText}</div>
            </div>
            <button class="delete-btn text-gray-600 hover:text-red-400 p-1 rounded-lg hover:bg-red-500/10" onclick="event.stopPropagation(); removeStockBySymbol('${stock.symbol}')" title="移除">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
        `;
        listEl.appendChild(btn);
    });

    initSortable();
}

function initSortable() {
    const listEl = document.getElementById('stock-list');
    if (sortableInstance) {
        sortableInstance.option('disabled', sortMode !== 'manual');
        return;
    }
    sortableInstance = new Sortable(listEl, {
        animation: 150,
        handle: '.drag-handle',
        disabled: sortMode !== 'manual',
        onEnd: function (evt) {
            const item = watchlist.splice(evt.oldIndex, 1)[0];
            watchlist.splice(evt.newIndex, 0, item);
            saveWatchlist();
        }
    });
}

async function addStock() {
    const input = document.getElementById('stock-input');
    const raw = input.value.trim().toUpperCase();
    if (!raw) { input.focus(); return; }
    if (!/^[A-Z0-9.\-]+$/.test(raw)) { alert('請輸入有效的代碼，例如 2330、USDTWD、BTC、AAPL'); return; }
    
    const symbol = normalizeSymbol(raw);
    if (watchlist.some(s => s.symbol === symbol)) { alert(`${displaySymbol(symbol)} 已經在清單中了`); input.value = ''; return; }
    const color = COLOR_KEYS[Math.floor(Math.random() * COLOR_KEYS.length)];
    
    let name = displaySymbol(symbol);
    if (isForexSymbol(symbol)) name = '美元/台幣匯率';
    else if (isCryptoSymbol(symbol)) name = symbol === 'BTC' ? '比特幣' : (symbol === 'ETH' ? '以太幣' : symbol);
    else if (isTaiwanSymbol(symbol)) {
        const code = displaySymbol(symbol);
        name = (await fetchTwseName(code)) || code;
    } else {
        name = symbol;
    }

    watchlist.push({ symbol, name, color });
    saveWatchlist();
    renderWatchlist();
    input.value = '';
    loadStock(symbol);
}

function removeStockBySymbol(symbol) {
    const index = watchlist.findIndex(s => s.symbol === symbol);
    if (index < 0) return;
    removeStock(index);
}

function removeStock(index) {
    const removed = watchlist[index];
    if (!removed) return;
    if (!confirm(`確定要移除 ${displaySymbol(removed.symbol)} 嗎？`)) return;
    watchlist.splice(index, 1);
    delete quoteCache[removed.symbol];
    saveWatchlist();
    renderWatchlist();
    if (currentSymbol === removed.symbol) {
        currentSymbol = watchlist.length > 0 ? watchlist[0].symbol : null;
        saveWatchlist();
        stopAutoRefresh();
        if (currentSymbol) {
            loadStock(currentSymbol);
        } else {
            document.getElementById('stock-symbol-title').textContent = '—';
            document.getElementById('stock-name').textContent = '選擇或新增股票以查看詳情';
            ['current-price','price-change','open-price','high-price','low-price','previous-close','volume','last-update'].forEach(id => document.getElementById(id).textContent = '—');
            document.getElementById('empty-state').style.display = 'flex';
            candlestickSeries.setData([]);
            clearCompanyInfo();
        }
    }
}

async function fetchYahooData(symbol, interval = currentPeriod.interval, range = currentPeriod.range) {
    const yahooSymbol = normalizeSymbol(symbol);
    const url = `${WORKER_URL}/?symbol=${encodeURIComponent(yahooSymbol)}&interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('YAHOO_FAILED');
    const json = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) throw new Error(json.chart?.error?.description || 'NO_YAHOO_DATA');
    return result;
}

function formatVolume(value) {
    if (value == null || Number.isNaN(Number(value))) return '—';
    const n = Number(value);
    if (n >= 100000000) return `${(n / 100000000).toFixed(2)} 億`;
    if (n >= 10000) return `${(n / 10000).toFixed(2)} 萬`;
    return n.toLocaleString('zh-TW');
}

function formatPrice(value) {
    if (value == null || Number.isNaN(Number(value))) return '—';
    return Number(value).toFixed(2);
}

function parseQuote(result) {
    const meta = result.meta || {};
    const quote = result.indicators?.quote?.[0] || {};

    let lastClose = null, lastOpen = null, lastHigh = null, lastLow = null, lastVol = null;

    if (quote.close && quote.close.length > 0) {
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

    const previousCloseValue = meta.regularMarketPreviousClose ?? meta.previousClose ?? meta.chartPreviousClose;
    let price = meta.regularMarketPrice ?? lastClose ?? previousCloseValue;
    if (price == null) throw new Error('NO_QUOTE_DATA');

    const previousClose = Number(previousCloseValue);
    const currentPrice = Number(price);
    const change = Number.isFinite(previousClose) ? currentPrice - previousClose : 0;
    const changePercent = Number.isFinite(previousClose) && previousClose > 0 ? (change / previousClose) * 100 : 0;

    return {
        latestPrice: formatPrice(currentPrice),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        isUp: change > 0,
        isFlat: change === 0,
        open: formatPrice(meta.regularMarketOpen ?? lastOpen),
        high: formatPrice(meta.regularMarketDayHigh ?? lastHigh),
        low: formatPrice(meta.regularMarketDayLow ?? lastLow),
        previousClose: formatPrice(previousClose),
        volume: formatVolume(meta.regularMarketVolume ?? lastVol)
    };
}

function parseCandles(result) {
    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0];
    if (!timestamps.length || !quote) throw new Error('NO_CANDLE_DATA');
    const chartData = [];
    for (let i = 0; i < timestamps.length; i++) {
        const open = quote.open?.[i], high = quote.high?.[i], low = quote.low?.[i], close = quote.close?.[i];
        if ([open, high, low, close].some(v => v == null)) continue;
        let time = (currentPeriod.interval === '1d') ? new Date(timestamps[i] * 1000).toISOString().split('T')[0] : timestamps[i];
        chartData.push({ time, open: Number(open), high: Number(high), low: Number(low), close: Number(close) });
    }
    return chartData;
}

let autoRefreshTimer = null; 

function marketStateText(state) {
    const map = { REGULAR: '正常交易', PRE: '盤前交易', POST: '盤後交易', PREPRE: '盤前', POSTPOST: '盤後', CLOSED: '休市' };
    return map[state] || state || '—';
}

function quoteTypeText(type) {
    const map = { EQUITY: '股票', ETF: 'ETF', MUTUALFUND: '共同基金', INDEX: '指數', CURRENCY: '外匯', FUTURE: '期貨', CRYPTOCURRENCY: '加密貨幣' };
    return map[type] || type || '—';
}

function setCompanyField(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value ?? '—';
}

function renderCompanyInfo(result, symbol, quote, source = 'Yahoo Finance') {
    const meta = result?.meta || {};
    setCompanyField('company-long-name', meta.longName || meta.shortName || watchlist.find(s => s.symbol === symbol)?.name || displaySymbol(symbol));
    setCompanyField('company-exchange', meta.fullExchangeName || meta.exchangeName || '—');
    setCompanyField('company-market', meta.market || meta.exchangeName || '—');
    setCompanyField('company-currency', meta.currency || meta.currencyCode || '—');
    setCompanyField('company-type', quoteTypeText(meta.instrumentType || meta.quoteType));
    setCompanyField('company-market-state', marketStateText(meta.marketState));
    setCompanyField('company-symbol', displaySymbol(symbol));
    setCompanyField('company-price', quote?.latestPrice || '—');
    const note = document.getElementById('company-info-note');
    if (note) note.textContent = `資料來源：${source} · ${meta.fullExchangeName || meta.exchangeName || '交易市場'} · 代碼 ${displaySymbol(symbol)}`;
}

function renderFinnhubCompanyInfo(profile, symbol, quote) {
    const p = profile || {};
    setCompanyField('company-long-name', p.name || watchlist.find(s => s.symbol === symbol)?.name || displaySymbol(symbol));
    setCompanyField('company-exchange', p.exchange || '—');
    setCompanyField('company-market', p.finnhubIndustry || '—');
    setCompanyField('company-currency', p.currency || '—');
    setCompanyField('company-type', p.shareClassFIGI ? '股票' : '—');
    setCompanyField('company-market-state', 'Finnhub 即時資料');
    setCompanyField('company-symbol', displaySymbol(symbol));
    setCompanyField('company-price', quote?.latestPrice || '—');
    const note = document.getElementById('company-info-note');
    if (note) {
        const extra = [p.country ? `國家 ${p.country}` : '', p.marketCapitalization ? `市值 ${Number(p.marketCapitalization).toLocaleString('zh-TW')} 百萬` : '', p.ipo ? `IPO ${p.ipo}` : ''].filter(Boolean).join(' · ');
        note.textContent = `資料來源：Finnhub · ${p.exchange || '交易市場'} · ${displaySymbol(symbol)}` + (extra ? ` · ${extra}` : '');
    }
}

function clearCompanyInfo() {
    ['company-long-name','company-exchange','company-market','company-currency','company-type','company-market-state','company-symbol','company-price'].forEach(id => setCompanyField(id, '—'));
    const note = document.getElementById('company-info-note');
    if (note) note.textContent = '選擇股票後會自動載入公司基本資訊。';
}

function toggleCompanyInfo() {
    const card = document.getElementById('company-info-card');
    const button = card.querySelector('button');
    card.classList.toggle('collapsed');
    button.textContent = card.classList.contains('collapsed') ? '展開' : '收合';
}

async function loadStock(symbol, isSilent = false) {
    currentSymbol = symbol;
    saveWatchlist();
    
    if (!isSilent) {
        document.querySelectorAll('.stock-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.symbol === symbol));
        const stockItem = watchlist.find(s => s.symbol === symbol);
        document.getElementById('stock-symbol-title').textContent = stockItem?.name || displaySymbol(symbol);
        document.getElementById('stock-name').textContent = displaySymbol(symbol);
        document.getElementById('loading-badge').classList.remove('hidden');
        document.getElementById('empty-state').style.display = 'none';
        ['current-price','price-change','open-price','high-price','low-price','previous-close','volume'].forEach(id => document.getElementById(id).textContent = '—');
        document.getElementById('price-change').className = 'text-base md:text-lg font-semibold px-2.5 py-1 rounded-lg bg-white/5';
        document.getElementById('current-price').className = 'text-4xl md:text-5xl font-extrabold text-white tracking-tight';
        document.getElementById('chart-status').textContent = `${currentPeriod.label} · 載入中`;
        resetFundamentals();
    }

    try {
        let quote = null;
        let companyProfile = null;
        let metricResult = null;
        let twseMetricsData = null;
        let quoteSource = 'Yahoo Finance';
        let chartData = [];
        let yahooError = null;

        // 1. 外匯匯率 (USDTWD)
        if (isForexSymbol(symbol)) {
            const forex = await fetchForexData();
            if (!forex) throw new Error('FOREX_NO_DATA');
            const rate = Number(forex.rate);
            const change = Number(forex.change || 0);
            const changePercent = Number(forex.changePercent || 0);

            quote = {
                latestPrice: rate.toFixed(4),
                change: change.toFixed(4),
                changePercent: changePercent.toFixed(2),
                isUp: change > 0,
                isFlat: change === 0,
                open: '—', high: '—', low: '—',
                previousClose: change !== 0 ? (rate - change).toFixed(4) : '—',
                volume: '—'
            };
            setCompanyField('company-long-name', '美元/台幣 (USD/TWD)');
            setCompanyField('company-exchange', `外匯市場 (${forex.source})`);
            setCompanyField('company-market', 'Forex');
            setCompanyField('company-currency', 'TWD');
            setCompanyField('company-type', '外匯');
            setCompanyField('company-market-state', '最新工作日匯率');
            setCompanyField('company-symbol', 'USD/TWD');
            setCompanyField('company-price', quote.latestPrice);
        } 
        // 2. 加密貨幣 (BTC, ETH, SOL)
        else if (isCryptoSymbol(symbol)) {
            const cryptoJson = await fetchCryptoData();
            const crypto = cryptoJson?.[symbol.toUpperCase()];
            const priceUSD = Number(crypto?.usd);
            const changePercent = Number(crypto?.usd_24h_change ?? crypto?.change24h ?? 0);

            if (!Number.isFinite(priceUSD) || priceUSD <= 0) throw new Error('CRYPTO_NO_PRICE');

            const previousClose = changePercent !== -100 ? priceUSD / (1 + changePercent / 100) : null;
            const change = Number.isFinite(previousClose) ? priceUSD - previousClose : 0;

            quote = {
                latestPrice: priceUSD.toLocaleString('en-US', { minimumFractionDigits: priceUSD >= 1 ? 2 : 6, maximumFractionDigits: priceUSD >= 1 ? 2 : 8 }),
                change: change.toFixed(priceUSD >= 1 ? 2 : 6),
                changePercent: changePercent.toFixed(2),
                isUp: changePercent > 0,
                isFlat: changePercent === 0,
                open: '—', high: '—', low: '—',
                previousClose: Number.isFinite(previousClose) ? previousClose.toLocaleString('en-US', { maximumFractionDigits: 8 }) : '—',
                volume: crypto?.usd_24h_vol ? Number(crypto.usd_24h_vol).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'
            };

            setCompanyField('company-long-name', { BTC: '比特幣', ETH: '以太幣', SOL: 'Solana', XRP: 'XRP', ADA: 'Cardano' }[symbol.toUpperCase()] || symbol.toUpperCase());
            setCompanyField('company-exchange', `加密貨幣 (${crypto?.source || 'CoinGecko'})`);
            setCompanyField('company-market', 'Crypto');
            setCompanyField('company-currency', 'USD');
            setCompanyField('company-type', '加密貨幣');
            setCompanyField('company-market-state', '24 小時市場');
            setCompanyField('company-symbol', symbol.toUpperCase());
            setCompanyField('company-price', quote.latestPrice);
        } 
        // 3. 一般台美股
        else {
            let quoteResult = null;
            try { quoteResult = await fetchYahooData(symbol, '5m', '1d'); if (quoteResult) quote = parseQuote(quoteResult); } catch (e) {}
            
            let yahooResult = null;
            try { 
                yahooResult = await fetchYahooData(symbol); 
                if (!quote && yahooResult) quote = parseQuote(yahooResult);
                if (yahooResult) chartData = parseCandles(yahooResult);
            } catch (e) { yahooError = e; }

            if (isTaiwanSymbol(symbol)) {
                try { twseMetricsData = await fetchTwseMetrics(symbol); } catch (e) {}
                if (twseMetricsData && !isSilent) {
                    renderTwseMetrics(twseMetricsData, symbol, yahooResult || quoteResult, quote?.latestPrice);
                    renderCompanyInfo(yahooResult || quoteResult, symbol, quote, 'Yahoo Finance + 證交所');
                }
            } else {
                if (!quote) {
                    try { quote = await fetchFinnhubQuote(symbol); quoteSource = 'Finnhub (無成交量)'; } catch (e) {}
                }
                if (!isSilent) {
                    companyProfile = await fetchFinnhubCompanyProfile(symbol).catch(() => null);
                    metricResult = await fetchFinnhubMetrics(symbol).catch(() => null);
                    if (companyProfile) renderFinnhubCompanyInfo(companyProfile, symbol, quote);
                    if (metricResult) renderFinnhubMetrics(metricResult, companyProfile, symbol);
                }
            }
        }

        if (!quote) throw (yahooError || new Error('NO_QUOTE_DATA'));

        quoteCache[symbol] = quote;
        saveWatchlist();

        document.getElementById('current-price').textContent = quote.latestPrice;
        document.getElementById('open-price').textContent = quote.open;
        document.getElementById('high-price').textContent = quote.high;
        document.getElementById('low-price').textContent = quote.low;
        document.getElementById('previous-close').textContent = quote.previousClose;
        document.getElementById('volume').textContent = quote.volume;

        const changeEl = document.getElementById('price-change');
        const sign = quote.isUp ? '+' : '';
        changeEl.textContent = `${sign}${quote.change} (${sign}${quote.changePercent}%)`;

        if (quote.isFlat) {
            changeEl.className = 'text-base md:text-lg font-semibold px-2.5 py-1 rounded-lg bg-white/5 text-gray-400';
            document.getElementById('current-price').className = 'text-4xl md:text-5xl font-extrabold tracking-tight text-gray-300';
        } else if (quote.isUp) {
            changeEl.className = 'text-base md:text-lg font-semibold px-2.5 py-1 rounded-lg bg-white/5 price-up';
            document.getElementById('current-price').className = 'text-4xl md:text-5xl font-extrabold tracking-tight price-up';
        } else {
            changeEl.className = 'text-base md:text-lg font-semibold px-2.5 py-1 rounded-lg bg-white/5 price-down';
            document.getElementById('current-price').className = 'text-4xl md:text-5xl font-extrabold tracking-tight price-down';
        }

        const stockItem = watchlist.find(s => s.symbol === symbol);
        document.getElementById('stock-symbol-title').textContent = stockItem?.name || displaySymbol(symbol);
        document.getElementById('stock-name').textContent = displaySymbol(symbol);

        if (chartData.length > 0) {
            candlestickSeries.setData(chartData);
            
            // 無論電腦或手機，載入或更新後都將視角鎖定在最新 K 線
            chart.timeScale().scrollToRealTime();

            document.getElementById('chart-status').textContent = `${currentPeriod.label} · ${chartData.length} 根`;
        } else if (!isSilent) {
            candlestickSeries.setData([]);
            document.getElementById('chart-status').textContent = isForexSymbol(symbol) || isCryptoSymbol(symbol) ? '此標的無 K 線圖表' : (yahooError ? 'K線資料取得失敗，但報價可正常顯示' : '目前週期沒有 K 線資料');
        }

        const now = new Date();
        document.getElementById('last-update').textContent = `最後更新：${now.toLocaleString('zh-TW', { hour12: false })}`;
        renderWatchlist();

    } catch (error) {
        console.error(error);
        if (!isSilent) {
            document.getElementById('chart-status').textContent = '資料取得失敗';
            if (error.message === 'NO_QUOTE_DATA') {
                document.getElementById('stock-name').textContent = '找不到報價資料，請確認代碼';
                document.getElementById('price-change').textContent = '報價失敗';
            } else if (error.message === 'NO_PREVIOUS_CLOSE') {
                document.getElementById('stock-name').textContent = '找不到昨收資料，無法正確計算漲幅';
                document.getElementById('price-change').textContent = '漲幅無法計算';
            } else if (error.message === 'NO_CANDLE_DATA') {
                document.getElementById('stock-name').textContent = '目前週期沒有 K 線資料';
                document.getElementById('price-change').textContent = 'K線失敗';
            } else if (error.message === 'YAHOO_FAILED') {
                document.getElementById('stock-name').textContent = '資料代理 Worker 連線失敗';
                document.getElementById('price-change').textContent = 'Worker 失敗';
            } else if (error.message === 'FOREX_NO_DATA') {
                document.getElementById('stock-name').textContent = 'USD/TWD 匯率來源暫時無法取得';
                document.getElementById('price-change').textContent = '匯率失敗';
            } else if (error.message === 'CRYPTO_NO_DATA' || error.message === 'CRYPTO_NO_PRICE') {
                document.getElementById('stock-name').textContent = `${displaySymbol(symbol)} 加密貨幣資料暫時無法取得`;
                document.getElementById('price-change').textContent = '加密貨幣失敗';
            } else {
                document.getElementById('stock-name').textContent = `找不到 ${displaySymbol(symbol)} 的資料`;
                document.getElementById('price-change').textContent = '載入失敗';
            }
        }
    } finally {
        if (!isSilent) {
            document.getElementById('loading-badge').classList.add('hidden');
        }
    }

    if (!isSilent && window.innerWidth < 768) {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('overlay').classList.remove('show');
    }

    restartAutoRefresh();
}

function startAutoRefresh() {
    stopAutoRefresh();
    autoRefreshTimer = setInterval(() => {
        if (!document.hidden && currentSymbol) {
            loadStock(currentSymbol, true);
        }
    }, AUTO_REFRESH_INTERVAL);
}

function stopAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }
}

function restartAutoRefresh() {
    stopAutoRefresh();
    startAutoRefresh();
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopAutoRefresh();
    } else {
        if (currentSymbol) {
            loadStock(currentSymbol, true);
            startAutoRefresh();
        }
    }
});

async function changePeriod(button) {
    document.querySelectorAll('.period-btn').forEach(btn => btn.classList.remove('active'));
    button.classList.add('active');
    currentPeriod = { interval: button.dataset.interval, range: button.dataset.range, label: button.textContent.trim() };
    if (currentSymbol && !isForexSymbol(currentSymbol) && !isCryptoSymbol(currentSymbol)) await loadStock(currentSymbol);
}

const chartContainer = document.getElementById('chart-container');
const isMobile = window.innerWidth < 768;
const chart = LightweightCharts.createChart(chartContainer, {
    layout: { textColor: '#9ca3af', background: { type: 'solid', color: 'transparent' }, fontSize: 12 },
    grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal, vertLine: { color: 'rgba(255,255,255,0.2)', width: 1, style: 2 }, horzLine: { color: 'rgba(255,255,255,0.2)', width: 1, style: 2 } },
    timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false },
    rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
    handleScroll: {
        mouseWheel: false, // 徹底禁用滑鼠滾輪滑動
        pressedMouseMove: !isMobile,
        horzTouchDrag: true,
        vertTouchDrag: true
    },
    handleScale: {
        axisPressedMouseMove: !isMobile,
        mouseWheel: false, // 徹底禁用滑鼠滾輪縮放
        pinch: true
    }
});

const candlestickSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#ef4444', downColor: '#10b981', borderVisible: false, wickUpColor: '#ef4444', wickDownColor: '#10b981'
});

// 鍵盤 [+] 與 [-] 縮放圖表時間軸
window.addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT') return;
    const timeScale = chart.timeScale();
    const visibleRange = timeScale.getVisibleLogicalRange();
    if (!visibleRange) return;

    const span = visibleRange.to - visibleRange.from;
    const zoomFactor = 0.2;

    if (e.key === '+' || e.key === '=') {
        const newSpan = Math.max(5, span * (1 - zoomFactor));
        const center = (visibleRange.from + visibleRange.to) / 2;
        timeScale.setVisibleLogicalRange({ from: center - newSpan / 2, to: center + newSpan / 2 });
        e.preventDefault();
    } else if (e.key === '-' || e.key === '_') {
        const newSpan = span * (1 + zoomFactor);
        const center = (visibleRange.from + visibleRange.to) / 2;
        timeScale.setVisibleLogicalRange({ from: center - newSpan / 2, to: center + newSpan / 2 });
        e.preventDefault();
    }
});

let currentChartWidth = chartContainer.clientWidth;
const resizeObserver = new ResizeObserver(() => {
    const newWidth = chartContainer.clientWidth;
    if (newWidth !== currentChartWidth || window.innerWidth > 768) {
        currentChartWidth = newWidth;
        chart.applyOptions({ width: chartContainer.clientWidth, height: chartContainer.clientHeight });
    }
});
resizeObserver.observe(chartContainer);

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('overlay').classList.toggle('show');
}

document.getElementById('sort-select').value = sortMode;

window.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('sort-select').value = sortMode;
    renderWatchlist();

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

    if (currentSymbol && watchlist.some(s => s.symbol === currentSymbol)) {
        loadStock(currentSymbol);
    } else if (watchlist.length > 0) {
        loadStock(watchlist[0].symbol);
    }
    startAutoRefresh();
});
    </script>
</body>
</html>
