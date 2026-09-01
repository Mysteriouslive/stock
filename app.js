const WORKER_URL = 'https://stock-proxy.stu-108042.workers.dev';

let AUTO_REFRESH_INTERVAL = Number(localStorage.getItem('stockRefreshRate')) || 10000;

// ============================================================
// 全域狀態變數宣告
// ============================================================
let mainChart = null, volChart = null, kdChart = null, rsiChart = null, macdChart = null;
let candlestickSeries = null, priceLineSeries = null, intradayAverageSeries = null, previousCloseSeries = null;
let ma5Series = null, ma20Series = null, ma60Series = null, upperBandSeries = null, lowerBandSeries = null;
let volSeries = null;
let kdSeriesK = null, kdSeriesD = null;
let rsiSeries = null;
let macdHistSeries = null, macdLineSeries = null, macdSignalSeries = null;
let sessionMarkers = null, currentChartData = [], intradayAverageData = [], currentPreviousClose = null, isSyncingTimeScale = false;
let autoRefreshTimer = null, isLoadingStock = false;
let workspaceScrollSaveFrame = null;
let activeLoadRequest = 0;
let chartAtRightEdge = true;
let chartDisplayMode = localStorage.getItem('stockChartDisplayMode') === 'line' ? 'line' : 'candles';

const mainIndicatorsState = { ma: true, bollinger: false };
const subIndicatorsState = { kd: true, rsi: false, macd: false };

let watchlist = JSON.parse(localStorage.getItem('stockWatchlist') || 'null') || [
    { symbol: 'AMD', name: '超微', color: 'orange' },
    { symbol: 'USDTWD', name: '美元/台幣匯率', color: 'blue' },
    { symbol: 'BTC', name: '比特幣', color: 'yellow' },
    { symbol: '2330.TW', name: '台積電', color: 'cyan' }
];
let quoteCache = JSON.parse(localStorage.getItem('stockQuoteCache') || '{}');
let sortMode = localStorage.getItem('stockSortMode') || 'manual';
let currentSymbol = localStorage.getItem('stockCurrentSymbol') || (watchlist.length > 0 ? watchlist[0].symbol : null);
let currentPeriod = (() => {
    try {
        const saved = JSON.parse(localStorage.getItem('stockChartPeriod') || 'null');
        if (saved && ['1m', '5m', '15m', '60m', '1d', '1wk', '1mo'].includes(saved.interval) && saved.range && saved.label) return saved;
    } catch {}
    return { interval: '1d', range: '6mo', label: '日K' };
})();
let currentTradingSession = ['all', 'regular', 'pre', 'post', 'night'].includes(localStorage.getItem('stockTradingSession'))
    ? localStorage.getItem('stockTradingSession')
    : 'all';

const COLOR_KEYS = ['orange', 'blue', 'green', 'cyan', 'purple', 'pink', 'yellow', 'red'];
const COLOR_MAP = { orange: 'bg-orange-500/20 text-orange-400', blue: 'bg-blue-500/20 text-blue-400', green: 'bg-green-500/20 text-green-400', cyan: 'bg-cyan-500/20 text-cyan-400', purple: 'bg-purple-500/20 text-purple-400', pink: 'bg-pink-500/20 text-pink-400', yellow: 'bg-yellow-500/20 text-yellow-400', red: 'bg-red-500/20 text-red-400' };

const INDICES_CONFIG = [
    { id: 'twii', symbol: '^TWII' },
    { id: 'soxx', symbol: 'SOXX' },
    { id: 'ixic', symbol: '^IXIC' },
    { id: 'gspc', symbol: '^GSPC' }
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

let currentChipTab = localStorage.getItem('stockChipTab') === 'holding' ? 'holding' : 'flow';
let cachedChipHistory = [];
let cachedChipLatest = null;
let isDarkMode = localStorage.getItem('stockThemeMode') !== 'light';
let sortableInstance = null;
let sidebarCompact = localStorage.getItem('stockSidebarCompact') === 'true';
let currentWorkspaceView = localStorage.getItem('stockWorkspaceView') || 'chart';
const finnhubCache = new Map();
let finnhubBackoffUntil = 0;

// ============================================================
// 1. Symbol 工具函式
// ============================================================
function isIndexSymbol(symbol) { return String(symbol || '').trim().toUpperCase().startsWith('^'); }
function isForexSymbol(symbol) { const s = String(symbol || '').toUpperCase().trim(); return s === 'USDTWD' || s === 'USD/TWD' || s === 'USDTWD=X'; }
function isCryptoSymbol(symbol) { const s = String(symbol || '').toUpperCase().replace('-USD', '').trim(); return ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'BNB'].includes(s); }
function isTaiwanSymbol(symbol) { const s = String(symbol || '').toUpperCase().trim(); return /^\d{4,6}(\.(TW|TWO))?$/i.test(s) || s.startsWith('^TW'); }
function isTaiwanStockSymbol(symbol) { return /^\d{4,6}(\.(TW|TWO))?$/i.test(String(symbol || '').toUpperCase().trim()); }

function toYahooSymbol(symbol) {
    let s = String(symbol || '').trim().toUpperCase();
    if (isForexSymbol(s)) return 'USDTWD=X';
    if (isCryptoSymbol(s)) return `${s.replace('-USD', '')}-USD`;
    if (isIndexSymbol(s)) return s;
    if (/^\d{4,6}\.(TW|TWO)$/i.test(s)) return s;
    if (/^\d{4,6}$/.test(s)) return `${s}.TW`;
    return s;
}

function displaySymbol(symbol) { return String(symbol || '').replace(/\.(TW|TWO)$/i, '').replace(/=X$/i, '').replace(/-USD$/i, ''); }
function finnhubSymbol(symbol) { const displayed = displaySymbol(symbol); return isTaiwanSymbol(symbol) ? `${displayed}.TW` : displayed; }
function getColorMode() { return localStorage.getItem('stockKlineColor') || 'auto-market'; }
function usesInternationalColors(symbol, mode = getColorMode()) { return mode === 'green-red' || (mode === 'auto-market' && !isTaiwanSymbol(symbol)); }

// ============================================================
// 2. 資料格式化與 DOM 輔助
// ============================================================
function setText(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; }
function setMetric(id, value) { const el = document.getElementById(id); if (el) el.textContent = value ?? '—'; }
function escapeHtmlAttribute(value) { return String(value).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

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
    if (!Number.isFinite(Number(value)) || value === '' || Number(value) <= 0) return '—';
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

function getChartDate(time) {
    if (typeof time === 'number') return new Date(time * 1000);
    if (typeof time === 'string') return new Date(`${time}T00:00:00`);
    if (time && typeof time === 'object' && Number.isFinite(time.year) && Number.isFinite(time.month) && Number.isFinite(time.day)) {
        return new Date(time.year, time.month - 1, time.day);
    }
    return new Date(NaN);
}

function formatChartTooltipTime(time) {
    const date = getChartDate(time);
    if (Number.isNaN(date.getTime())) return '—';
    if (['1d', '1wk', '1mo'].includes(currentPeriod.interval)) return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
    return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function setCompanyField(id, value) { const el = document.getElementById(id); if (el) el.textContent = value ?? '—'; }
function updateMarketState(state, symbol = '') {
    const badge = document.getElementById('market-state-badge');
    if (!badge) return;
    const status = String(state || '').toUpperCase();
    const states = { PRE: ['盤前', 'state-pre'], PREPRE: ['盤前', 'state-pre'], REGULAR: ['盤中', 'state-regular'], POST: ['盤後', 'state-post'], POSTPOST: ['盤後', 'state-post'], CLOSED: ['休市', 'state-closed'] };
    let fallback = ['—', 'state-unknown'];
    if (isCryptoSymbol(symbol) || isForexSymbol(symbol)) fallback = ['盤中', 'state-regular'];
    else {
        const timeZone = isTaiwanSymbol(symbol) ? 'Asia/Taipei' : 'America/New_York';
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map(part => [part.type, part.value]));
        const weekend = ['Sat', 'Sun'].includes(parts.weekday), minute = Number(parts.hour) * 60 + Number(parts.minute);
        if (!weekend) {
            const sessions = isTaiwanSymbol(symbol) ? [[510, 540, 'state-pre', '盤前'], [540, 810, 'state-regular', '盤中'], [810, 870, 'state-post', '盤後']] : [[240, 570, 'state-pre', '盤前'], [570, 960, 'state-regular', '盤中'], [960, 1200, 'state-post', '盤後']];
            const session = sessions.find(([start, end]) => minute >= start && minute < end);
            fallback = session ? [session[3], session[2]] : ['休市', 'state-closed'];
        } else fallback = ['休市', 'state-closed'];
    }
    const [label, className] = states[status] || fallback;
    badge.textContent = label;
    badge.className = `market-state-badge ${className}`;
}

function parseQuote(result, symbol = '') {
    const meta = result?.meta || {}, quote = result?.indicators?.quote?.[0] || {};
    const index = Array.isArray(quote.close) ? quote.close.map(Number).findLastIndex(Number.isFinite) : -1;
    const close = Number(meta.regularMarketPrice ?? quote.close?.[index]);
    if (!Number.isFinite(close)) throw new Error('NO_QUOTE_DATA');
    const finiteValue = value => value === null || value === undefined || value === '' ? NaN : Number(value);
    const reportedChange = finiteValue(meta.regularMarketChange);
    const reportedPercent = finiteValue(meta.regularMarketChangePercent);
    const explicitPrevious = finiteValue(meta.regularMarketPreviousClose ?? meta.previousClose);
    const latestCandleClose = finiteValue(quote.close?.[index]);
    const priorCandleClose = index > 0 ? finiteValue(quote.close?.slice(0, index).map(Number).findLast(Number.isFinite)) : NaN;
    let previous = explicitPrevious;
    if (!Number.isFinite(previous) && Number.isFinite(latestCandleClose)) {
        const sameAsLatestCandle = Math.abs(close - latestCandleClose) <= Math.max(Math.abs(close), 1) * 1e-8;
        previous = sameAsLatestCandle && Number.isFinite(priorCandleClose) ? priorCandleClose : latestCandleClose;
    }
    if (!Number.isFinite(previous)) previous = finiteValue(meta.chartPreviousClose);
    if (Number.isFinite(reportedChange)) previous = close - reportedChange;
    else if (Number.isFinite(reportedPercent) && reportedPercent > -100) previous = close / (1 + reportedPercent / 100);
    const change = Number.isFinite(reportedChange) ? reportedChange : (Number.isFinite(previous) ? close - previous : 0);
    const percent = Number.isFinite(reportedPercent) ? reportedPercent : (Number.isFinite(previous) && previous > 0 ? (change / previous) * 100 : 0);
    const decimals = isForexSymbol(symbol) ? 4 : (isCryptoSymbol(symbol) && close < 1 ? 6 : 2);
    return {
        latestPrice: formatPrice(close, symbol), change: change.toFixed(decimals), changePercent: percent.toFixed(2), isUp: change > 0, isFlat: change === 0,
        open: formatPrice(meta.regularMarketOpen ?? quote.open?.[index], symbol), high: formatPrice(meta.regularMarketDayHigh ?? quote.high?.[index], symbol),
        low: formatPrice(meta.regularMarketDayLow ?? quote.low?.[index], symbol), previousClose: formatPrice(previous, symbol), volume: formatVolume(meta.regularMarketVolume ?? quote.volume?.[index])
    };
}

function parseExtendedSessionQuote(result, symbol = '') {
    const meta = result?.meta || {}, quote = result?.indicators?.quote?.[0] || {};
    const now = Math.floor(Date.now() / 1000), periods = meta.currentTradingPeriod || {};
    const detectedState = now >= Number(periods.pre?.start) && now < Number(periods.pre?.end) ? 'PRE'
        : (now >= Number(periods.post?.start) && now < Number(periods.post?.end) ? 'POST' : '');
    const state = String(meta.marketState || detectedState).toUpperCase();
    if (!['PRE', 'PREPRE', 'POST', 'POSTPOST'].includes(state)) return null;
    const index = Array.isArray(quote.close) ? quote.close.map(Number).findLastIndex(Number.isFinite) : -1;
    const price = Number(quote.close?.[index]), regular = Number(meta.regularMarketPrice);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(regular) || regular <= 0) return null;
    const change = price - regular, percent = (change / regular) * 100;
    const label = state.startsWith('PRE') ? '盤前' : '盤後', sign = change > 0 ? '+' : '';
    return {
        label, price: formatPrice(price, symbol),
        changeText: `${sign}${change.toFixed(isForexSymbol(symbol) ? 4 : 2)} (${sign}${percent.toFixed(2)}%)`,
        tone: change > 0 ? 'price-up' : (change < 0 ? 'price-down' : 'text-gray-400')
    };
}

function renderExtendedSessionQuote(session) {
    const el = document.getElementById('extended-session-quote');
    if (!el) return;
    if (!session) {
        el.textContent = '';
        el.className = 'extended-session-quote hidden';
        return;
    }
    el.className = 'extended-session-quote';
    el.innerHTML = `<span class="extended-session-label">${session.label}</span><span>${session.price}</span><span class="extended-session-change ${session.tone}">${session.changeText}</span>`;
}

const TRADING_SESSION_LABELS = { all: '全部時段', regular: '盤中', pre: '盤前', post: '盤後', night: '夜盤' };

function getExchangeClockMinutes(timestamp, timeZone) {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit'
        }).formatToParts(new Date(timestamp * 1000));
        const hour = Number(parts.find(part => part.type === 'hour')?.value);
        const minute = Number(parts.find(part => part.type === 'minute')?.value);
        return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
    } catch { return null; }
}

function matchesTradingSession(timestamp, meta = {}) {
    if (currentTradingSession === 'all') return true;
    const continuousMarket = isCryptoSymbol(currentSymbol) || isForexSymbol(currentSymbol);
    const taiwanMarket = isTaiwanSymbol(currentSymbol);
    const timeZone = taiwanMarket ? 'Asia/Taipei' : (meta.exchangeTimezoneName || 'America/New_York');
    const minutes = getExchangeClockMinutes(timestamp, timeZone);
    if (minutes === null) return true;

    if (continuousMarket) {
        if (currentTradingSession === 'regular') return true;
        if (currentTradingSession === 'night') return minutes >= 18 * 60 || minutes < 6 * 60;
        return false;
    }
    if (taiwanMarket) {
        if (currentTradingSession === 'pre') return minutes >= 8 * 60 + 30 && minutes < 9 * 60;
        if (currentTradingSession === 'regular') return minutes >= 9 * 60 && minutes < 13 * 60 + 30;
        if (currentTradingSession === 'post') return minutes >= 13 * 60 + 30 && minutes < 14 * 60 + 30;
        return false;
    }
    if (currentTradingSession === 'pre') return minutes >= 4 * 60 && minutes < 9 * 60 + 30;
    if (currentTradingSession === 'regular') return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
    if (currentTradingSession === 'post') return minutes >= 16 * 60 && minutes < 20 * 60;
    return minutes >= 20 * 60 || minutes < 4 * 60;
}

function updateChartSessionState(rawCount, visibleCount) {
    const empty = document.getElementById('chart-session-empty');
    const live = document.getElementById('chart-live-status');
    const isLiveMinute = currentPeriod.interval === '1m';
    if (live) {
        live.classList.toggle('is-live', isLiveMinute);
        const label = isLiveMinute ? `${TRADING_SESSION_LABELS[currentTradingSession]} · 5 秒更新` : '歷史資料';
        const text = live.querySelector('span');
        if (text) text.textContent = label;
    }
    if (!empty) return;
    const shouldShow = currentTradingSession !== 'all' && visibleCount === 0;
    empty.classList.toggle('hidden', !shouldShow);
    empty.textContent = shouldShow ? `目前商品沒有${TRADING_SESSION_LABELS[currentTradingSession]}成交資料` : '';
}

function parseCandles(result) {
    const quote = result?.indicators?.quote?.[0], timestamps = result?.timestamp || [];
    if (!quote || !timestamps.length) return [];
    const daily = ['1d', '1wk', '1mo'].includes(currentPeriod.interval);
    const liveDailyPrice = Number(result?.meta?.regularMarketPrice);
    const candles = timestamps.flatMap((timestamp, index) => {
        const [open, high, low] = [quote.open?.[index], quote.high?.[index], quote.low?.[index]].map(Number);
        let close = Number(quote.close?.[index]);
        if (!Number.isFinite(close) && daily && index === timestamps.length - 1 && Number.isFinite(liveDailyPrice)) close = liveDailyPrice;
        if (![open, high, low, close].every(Number.isFinite)) return [];
        return [{ time: daily ? new Date(timestamp * 1000).toISOString().slice(0, 10) : timestamp, open, high, low, close, volume: Number(quote.volume?.[index]) || 0 }];
    });
    const visible = daily || currentTradingSession === 'all'
        ? candles
        : candles.filter(item => matchesTradingSession(Number(item.time), result?.meta || {}));
    updateChartSessionState(candles.length, visible.length);
    return visible;
}

function applyCurrentPriceToQuote(quote, price, previousClose, symbol, fallbackPercent = NaN) {
    const current = Number(price), previous = Number(previousClose);
    if (!Number.isFinite(current) || current <= 0) return quote;
    const suppliedPercent = Number(fallbackPercent);
    const useSuppliedPercent = Number.isFinite(suppliedPercent);
    let percent = useSuppliedPercent ? suppliedPercent : (Number.isFinite(previous) && previous > 0 ? ((current - previous) / previous) * 100 : NaN);
    if (!Number.isFinite(percent)) percent = 0;
    const base = !useSuppliedPercent && Number.isFinite(previous) && previous > 0 ? previous : current / (1 + percent / 100);
    const change = current - base, decimals = isForexSymbol(symbol) ? 4 : (isCryptoSymbol(symbol) && current < 1 ? 6 : 2);
    return { ...(quote || {}), latestPrice: formatPrice(current, symbol), change: change.toFixed(decimals), changePercent: percent.toFixed(2), isUp: change > 0, isFlat: change === 0, previousClose: formatPrice(base, symbol) };
}

function resetFundamentals() {
    ['metric-pe', 'metric-eps', 'metric-marketcap', 'metric-beta', 'metric-dividend', 'metric-52high', 'metric-52low', 'metric-roe', 'metric-gross-margin', 'metric-op-margin', 'metric-revenue-growth', 'metric-current-ratio'].forEach(id => setMetric(id, '—'));
    setMetric('fundamentals-status', '—');
}

function resetTechnicalAssessment() {
    setText('assessment-period', '—');
    setText('assessment-score', '—');
    setText('assessment-signal', '等待資料');
    setText('long-win-rate', '—'); setText('long-sample', '—');
    setText('short-win-rate', '—'); setText('short-sample', '—');
    setText('assessment-reasons', '—');
}

function calculateTechnicalScore(data) {
    if (!Array.isArray(data) || data.length < 20) return null;
    const last = data[data.length - 1], average = period => data.length >= period
        ? data.slice(-period).reduce((sum, item) => sum + item.close, 0) / period : NaN;
    const ma5 = average(5), ma20 = average(20), ma60 = average(60);
    const rsi = calculateRSIData(data).at(-1)?.value;
    const { kList, dList } = calculateKDData(data);
    const k = kList.at(-1)?.value, d = dList.at(-1)?.value;
    const { histList, difList, deaList } = calculateMACDData(data);
    const hist = histList.at(-1)?.value, dif = difList.at(-1)?.value, dea = deaList.at(-1)?.value;
    let score = 0;
    const reasons = [];
    if (Number.isFinite(ma20)) { const up = last.close >= ma20; score += up ? 20 : -20; reasons.push(`${up ? '收盤站上' : '收盤跌破'} MA20`); }
    if (Number.isFinite(ma5) && Number.isFinite(ma20)) { const up = ma5 >= ma20; score += up ? 15 : -15; reasons.push(`MA5 ${up ? '高於' : '低於'} MA20`); }
    if (Number.isFinite(ma20) && Number.isFinite(ma60)) { const up = ma20 >= ma60; score += up ? 15 : -15; reasons.push(`MA20 ${up ? '高於' : '低於'} MA60`); }
    if (Number.isFinite(rsi)) { const up = rsi >= 50; score += up ? 15 : -15; reasons.push(`RSI ${rsi.toFixed(1)} ${up ? '偏強' : '偏弱'}`); }
    if (Number.isFinite(dif) && Number.isFinite(dea)) { const up = dif >= dea; score += up ? 15 : -15; reasons.push(`MACD ${up ? '多方' : '空方'}排列`); }
    if (Number.isFinite(k) && Number.isFinite(d)) { const up = k >= d; score += up ? 10 : -10; reasons.push(`KD ${up ? '黃金' : '死亡'}交叉`); }
    if (Number.isFinite(hist)) score += hist >= 0 ? 10 : -10;
    return { score: Math.max(-100, Math.min(100, score)), reasons };
}

function updateTechnicalAssessment(data) {
    const assessment = calculateTechnicalScore(data);
    if (!assessment) { resetTechnicalAssessment(); return; }
    const horizon = Math.min(5, Math.max(1, Math.floor(data.length / 20)));
    let longWins = 0, longSamples = 0, shortWins = 0, shortSamples = 0;
    for (let index = 20; index + horizon < data.length; index++) {
        const historical = calculateTechnicalScore(data.slice(0, index + 1));
        if (!historical) continue;
        const futureReturn = (data[index + horizon].close - data[index].close) / data[index].close;
        if (historical.score >= 30) { longSamples++; if (futureReturn > 0) longWins++; }
        if (historical.score <= -30) { shortSamples++; if (futureReturn < 0) shortWins++; }
    }
    const signal = assessment.score >= 35 ? '偏多' : assessment.score <= -35 ? '偏空' : '震盪觀望';
    setText('assessment-period', `${currentPeriod.label} · ${data.length} 根`);
    setText('assessment-score', `${assessment.score > 0 ? '+' : ''}${assessment.score}`);
    setText('assessment-signal', signal);
    setText('long-win-rate', longSamples ? `${(longWins / longSamples * 100).toFixed(0)}%` : '樣本不足');
    setText('long-sample', longSamples ? `${longSamples} 次訊號 · ${horizon} 根後` : '尚無足夠訊號');
    setText('short-win-rate', shortSamples ? `${(shortWins / shortSamples * 100).toFixed(0)}%` : '樣本不足');
    setText('short-sample', shortSamples ? `${shortSamples} 次訊號 · ${horizon} 根後` : '尚無足夠訊號');
    setText('assessment-reasons', assessment.reasons.join(' · '));
}

function renderCompanyInfo(result, symbol, quote, source = 'Yahoo Finance') {
    const meta = result?.meta || {};
    setCompanyField('company-long-name', meta.longName || meta.shortName || displaySymbol(symbol));
    setCompanyField('company-exchange', meta.fullExchangeName || meta.exchangeName || '—');
    setCompanyField('company-market', source); setCompanyField('company-currency', meta.currency || '—');
    setCompanyField('company-type', meta.instrumentType || '—'); setCompanyField('company-market-state', meta.marketState || '—');
    setCompanyField('company-symbol', toYahooSymbol(symbol)); setCompanyField('company-price', quote?.latestPrice || '—');
}

function renderFinnhubCompanyInfo(profile, symbol, quote) {
    setCompanyField('company-long-name', profile?.name || displaySymbol(symbol)); setCompanyField('company-exchange', profile?.exchange || '—');
    setCompanyField('company-market', 'Finnhub'); setCompanyField('company-currency', profile?.currency || '—'); setCompanyField('company-type', profile?.finnhubIndustry || '—');
    setCompanyField('company-symbol', finnhubSymbol(symbol)); setCompanyField('company-price', quote?.latestPrice || '—');
}

function renderTwseMetrics(data, symbol, result, currentPrice) {
    const meta = result?.meta || {}; resetFundamentals();
    setMetric('metric-pe', data?.pe || '—'); setMetric('metric-dividend', data?.dividendYield || '—');
    setMetric('metric-marketcap', formatCompactNumber(meta.marketCap)); setMetric('fundamentals-status', `${data?.source || 'TWSE'} 已載入`);
}

function setChipVisibility(visible) {
    document.getElementById('nav-chip-btn')?.classList.toggle('hidden', !visible);
    if (!visible && currentWorkspaceView === 'chip') currentWorkspaceView = 'chart';
    applyWorkspaceView(currentWorkspaceView);
}
function renderChipContent() {
    const table = document.getElementById('chip-table-rows');
    if (!table) return;
    if (!cachedChipHistory.length) {
        table.innerHTML = '<div class="chip-empty-state"><b>目前沒有可用的法人籌碼</b><small>可能為非交易日、資料尚未公布，或商品不屬於上市櫃股票</small></div>';
        ['chip-total-today', 'chip-total-5d', 'chip-total-15d', 'chip-foreign-streak'].forEach(id => setText(id, '—'));
        renderChipHistoryChart([]); renderHoldingPie([]); return;
    }
    let foreignHolding = 0, trustHolding = 0, dealerHolding = 0;
    const chronologicalRows = [...cachedChipHistory].sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))).map(row => {
        const institutional = row.institutional || {};
        const foreign = Number(institutional.foreignNet ?? row.foreignNet ?? 0) / 1000;
        const trust = Number(institutional.investmentTrustNet ?? row.investmentTrustNet ?? 0) / 1000;
        const dealer = Number(institutional.dealerNet ?? row.dealerNet ?? 0) / 1000;
        foreignHolding += foreign; trustHolding += trust; dealerHolding += dealer;
        return { date: row.date || '—', foreign, trust, dealer, total: foreign + trust + dealer, foreignHolding, trustHolding, dealerHolding };
    });
    const rows = [...chronologicalRows].reverse();
    const signed = value => `${value > 0 ? '+' : ''}${Math.round(value).toLocaleString('zh-TW')}`;
    const color = value => value > 0 ? 'text-[#ef4444]' : value < 0 ? 'text-[#22c55e]' : 'text-gray-400';
    const latest = chronologicalRows.at(-1);
    const totalFor = list => list.reduce((sum, row) => sum + row.total, 0);
    const latestDirection = latest?.foreign > 0 ? 1 : latest?.foreign < 0 ? -1 : 0;
    let streak = 0;
    for (let index = chronologicalRows.length - 1; index >= 0; index--) {
        const direction = chronologicalRows[index].foreign > 0 ? 1 : chronologicalRows[index].foreign < 0 ? -1 : 0;
        if (!latestDirection || direction !== latestDirection) break;
        streak++;
    }
    setText('chip-total-today', latest ? `${signed(latest.total)} 張` : '—');
    setText('chip-total-5d', `${signed(totalFor(chronologicalRows.slice(-5)))} 張`);
    setText('chip-total-15d', `${signed(totalFor(chronologicalRows))} 張`);
    setText('chip-foreign-streak', latestDirection ? `連${latestDirection > 0 ? '買' : '賣'} ${streak} 日` : '今日持平');
    [['chip-total-today', latest?.total], ['chip-total-5d', totalFor(chronologicalRows.slice(-5))], ['chip-total-15d', totalFor(chronologicalRows)]].forEach(([id, value]) => {
        const element = document.getElementById(id);
        if (element) element.className = value > 0 ? 'price-up' : value < 0 ? 'price-down' : '';
    });
    table.innerHTML = rows.map(row => {
        const values = currentChipTab === 'holding' ? [row.foreignHolding, row.trustHolding, row.dealerHolding, row.foreignHolding + row.trustHolding + row.dealerHolding] : [row.foreign, row.trust, row.dealer, row.total];
        return `<div class="grid grid-cols-5 text-center py-2.5 px-1 hover:bg-white/[0.04] transition-colors items-center border-b border-white/5"><div class="text-gray-300 font-medium">${String(row.date).replace(/-/g, '/')}</div>${values.map(value => `<div class="font-semibold ${color(value)}">${signed(value)}</div>`).join('')}</div>`;
    }).join('');
    renderChipHistoryChart(chronologicalRows);
    renderHoldingPie(chronologicalRows);
}

function renderHoldingPie(rows) {
    const canvas = document.getElementById('chip-holding-pie');
    const legend = document.getElementById('chip-holding-legend');
    if (!canvas || !legend) return;
    const width = Math.max(canvas.clientWidth, 1), height = Math.max(canvas.clientHeight, 1);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    const context = canvas.getContext('2d'); if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    const totals = rows.reduce((sum, row) => { sum[0] += row.foreign; sum[1] += row.trust; sum[2] += row.dealer; return sum; }, [0, 0, 0]);
    const labels = ['外資', '投信', '自營商'], colors = ['#38bdf8', '#f87171', '#c084fc'];
    const values = totals.map(value => Math.abs(value));
    const total = values.reduce((sum, value) => sum + value, 0);
    if (!total) {
        context.fillStyle = 'rgba(148,163,184,.5)'; context.font = '12px sans-serif'; context.textAlign = 'center';
        context.fillText('本期無法人交易資料', width / 2, height / 2); legend.innerHTML = ''; return;
    }
    const centerX = width / 2, centerY = height / 2, radius = Math.max(24, Math.min(width, height) / 2 - 8);
    let start = -Math.PI / 2;
    values.forEach((value, index) => {
        const angle = value / total * Math.PI * 2;
        context.beginPath(); context.moveTo(centerX, centerY); context.arc(centerX, centerY, radius, start, start + angle); context.closePath();
        context.fillStyle = colors[index]; context.fill(); start += angle;
    });
    context.beginPath(); context.arc(centerX, centerY, radius * .58, 0, Math.PI * 2); context.fillStyle = isDarkMode ? '#131b1a' : '#f7fbf9'; context.fill();
    context.fillStyle = isDarkMode ? '#e5e7eb' : '#172a26'; context.font = '600 11px sans-serif'; context.textAlign = 'center'; context.fillText('近 15 日', centerX, centerY - 3);
    context.fillStyle = isDarkMode ? '#94a3b8' : '#687873'; context.font = '10px sans-serif'; context.fillText('交易結構', centerX, centerY + 12);
    legend.innerHTML = labels.map((label, index) => `<span><i style="background:${colors[index]}"></i>${label} ${totals[index] > 0 ? '+' : ''}${Math.round(totals[index]).toLocaleString('zh-TW')} 張 · ${(values[index] / total * 100).toFixed(1)}%</span>`).join('');
}

function renderChipHistoryChart(rows) {
    const canvas = document.getElementById('chip-history-chart');
    if (!canvas) return;
    const width = Math.max(canvas.clientWidth, 1), height = Math.max(canvas.clientHeight, 1);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    const context = canvas.getContext('2d'); if (!context) return;
    context.scale(ratio, ratio); context.clearRect(0, 0, width, height);
    if (!rows.length) return;
    const keys = currentChipTab === 'holding'
        ? ['foreignHolding', 'trustHolding', 'dealerHolding']
        : ['foreign', 'trust', 'dealer'];
    setText('chip-chart-mode-label', currentChipTab === 'holding' ? '區間累計淨買賣超 · 張' : '每日淨買賣超 · 張');
    const values = rows.flatMap(row => keys.map(key => Number(row[key]) || 0));
    const minValue = Math.min(0, ...values), maxValue = Math.max(0, ...values);
    const valueSpan = Math.max(1, maxValue - minValue);
    const padding = { top: 16, right: 14, bottom: 24, left: 54 };
    const plotWidth = Math.max(1, width - padding.left - padding.right);
    const plotHeight = Math.max(1, height - padding.top - padding.bottom);
    const xAt = index => padding.left + (rows.length === 1 ? plotWidth / 2 : index / (rows.length - 1) * plotWidth);
    const yAt = value => padding.top + (maxValue - value) / valueSpan * plotHeight;
    const gridColor = isDarkMode ? 'rgba(148,163,184,.12)' : 'rgba(71,85,105,.12)';
    const labelColor = isDarkMode ? 'rgba(148,163,184,.72)' : 'rgba(71,85,105,.72)';

    context.lineWidth = 1;
    context.strokeStyle = gridColor;
    context.fillStyle = labelColor;
    context.font = '10px ui-monospace, monospace';
    context.textAlign = 'right';
    [maxValue, (maxValue + minValue) / 2, minValue].forEach(value => {
        const y = yAt(value);
        context.beginPath(); context.moveTo(padding.left, y); context.lineTo(width - padding.right, y); context.stroke();
        context.fillText(Math.round(value).toLocaleString('zh-TW'), padding.left - 7, y + 3);
    });
    if (minValue < 0 && maxValue > 0) {
        context.strokeStyle = isDarkMode ? 'rgba(226,232,240,.32)' : 'rgba(51,65,85,.28)';
        context.beginPath(); context.moveTo(padding.left, yAt(0)); context.lineTo(width - padding.right, yAt(0)); context.stroke();
    }

    const colors = ['#38bdf8', '#f87171', '#c084fc'];
    keys.forEach((key, seriesIndex) => {
        context.strokeStyle = colors[seriesIndex];
        context.lineWidth = 2;
        context.lineJoin = 'round';
        context.lineCap = 'round';
        context.beginPath();
        rows.forEach((row, index) => {
            const x = xAt(index), y = yAt(Number(row[key]) || 0);
            if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
        });
        context.stroke();
        rows.forEach((row, index) => {
            const x = xAt(index), y = yAt(Number(row[key]) || 0);
            context.beginPath(); context.arc(x, y, 2.2, 0, Math.PI * 2);
            context.fillStyle = colors[seriesIndex]; context.fill();
        });
    });

    context.fillStyle = labelColor;
    context.font = '10px sans-serif';
    const labelIndexes = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
    labelIndexes.forEach((index, position) => {
        context.textAlign = position === 0 ? 'left' : position === labelIndexes.length - 1 ? 'right' : 'center';
        context.fillText(String(rows[index].date).slice(5).replace('-', '/'), xAt(index), height - 6);
    });
}
function renderChipData(data, history) {
    cachedChipLatest = data || null;
    const historyRows = Array.isArray(history?.history) ? history.history : (Array.isArray(data?.history) ? data.history : []);
    cachedChipHistory = historyRows.length
        ? historyRows
        : (data?.date && data?.institutional ? [{ date: data.date, institutional: data.institutional, margin: data.margin || null }] : []);
    const latestHistory = [...cachedChipHistory].sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))).at(-1);
    const date = data?.date || latestHistory?.date || '—';
    const provider = data?.source || history?.source || 'TWSE / TPEx Official Data';
    setMetric('chip-date', date); setMetric('chip-source-note', `資料來源：${provider} · 交易日 ${date}`);
    const margin = data?.margin || latestHistory?.margin || {};
    setMetric('margin-financing', Number.isFinite(Number(margin.financingBalance)) ? `${Math.round(Number(margin.financingBalance)).toLocaleString('zh-TW')} 張` : '—');
    setMetric('margin-financing-change', Number.isFinite(Number(margin.financingChange)) ? `${Number(margin.financingChange) >= 0 ? '+' : ''}${Math.round(Number(margin.financingChange)).toLocaleString('zh-TW')} 張` : '—');
    setMetric('margin-short', Number.isFinite(Number(margin.shortBalance)) ? `${Math.round(Number(margin.shortBalance)).toLocaleString('zh-TW')} 張` : '—');
    setMetric('margin-short-change', Number.isFinite(Number(margin.shortChange)) ? `${Number(margin.shortChange) >= 0 ? '+' : ''}${Math.round(Number(margin.shortChange)).toLocaleString('zh-TW')} 張` : '—');
    renderChipContent();
}

function applyChartDisplayMode() {
    const isLine = chartDisplayMode === 'line';
    const isIntradayLine = isLine && currentPeriod.interval === '1m';
    candlestickSeries?.applyOptions({ visible: !isLine });
    priceLineSeries?.applyOptions({ visible: isLine });
    intradayAverageSeries?.applyOptions({ visible: isIntradayLine });
    previousCloseSeries?.applyOptions({ visible: isIntradayLine });
    [ma5Series, ma20Series, ma60Series, upperBandSeries, lowerBandSeries].filter(Boolean).forEach(series => series.applyOptions({ visible: !isIntradayLine }));
    document.getElementById('chart-type-candles')?.setAttribute('aria-pressed', String(!isLine));
    document.getElementById('chart-type-line')?.setAttribute('aria-pressed', String(isLine));
    document.getElementById('hud-ohlc-row')?.classList.toggle('hidden', isLine);
    const hudMaRow = document.getElementById('hud-ma-row');
    if (hudMaRow) hudMaRow.style.display = isIntradayLine || !mainIndicatorsState.ma ? 'none' : 'flex';
    document.getElementById('intraday-line-legend')?.classList.toggle('hidden', !isIntradayLine);
    const periodLabel = currentPeriod.label || '日K';
    setText('period-label', isLine ? periodLabel.replace(/K$/, '線') : periodLabel.replace(/線$/, 'K'));
}

function setChartDisplayMode(mode) {
    chartDisplayMode = mode === 'line' ? 'line' : 'candles';
    localStorage.setItem('stockChartDisplayMode', chartDisplayMode);
    if (priceLineSeries) {
        priceLineSeries.setData(currentChartData.map(item => ({ time: item.time, value: item.close })));
    }
    applyChartDisplayMode();
    resetChartView();
}

function persistChartPreferences() {
    localStorage.setItem('stockChartPeriod', JSON.stringify(currentPeriod));
    localStorage.setItem('stockTradingSession', currentTradingSession);
}

function syncPeriodSelection() {
    const value = `${currentPeriod.interval}|${currentPeriod.range}`;
    document.querySelectorAll('#period-menu [role="option"]').forEach(button => {
        button.setAttribute('aria-selected', String(button.dataset.period === value));
    });
}

function updateTradingSessionControl() {
    const select = document.getElementById('trading-session-select');
    if (select) select.value = currentTradingSession;
    updateChartSessionState(currentChartData.length, currentChartData.length);
}

async function selectTradingSession(session) {
    currentTradingSession = TRADING_SESSION_LABELS[session] ? session : 'all';
    currentPeriod = { interval: '1m', range: '1d', label: '1分K' };
    chartDisplayMode = 'line';
    localStorage.setItem('stockChartDisplayMode', 'line');
    persistChartPreferences();
    syncPeriodSelection();
    updateTradingSessionControl();
    applyChartDisplayMode();
    if (currentSymbol) await loadStock(currentSymbol);
}

// ============================================================
// 自選股清單
// ============================================================
function saveWatchlist() {
    localStorage.setItem('stockWatchlist', JSON.stringify(watchlist));
    localStorage.setItem('stockSortMode', sortMode);
    localStorage.setItem('stockQuoteCache', JSON.stringify(quoteCache));
    if (currentSymbol) localStorage.setItem('stockCurrentSymbol', currentSymbol);
    else localStorage.removeItem('stockCurrentSymbol');
}

const SORT_LABELS = {
    manual: '自訂順序', 'symbol-asc': '代碼 ↑', 'symbol-desc': '代碼 ↓',
    'name-asc': '名稱 ↑', 'name-desc': '名稱 ↓', 'price-desc': '價格 ↓',
    'price-asc': '價格 ↑', 'change-desc': '漲幅 ↓', 'change-asc': '漲幅 ↑'
};

function changeSort(value) {
    sortMode = SORT_LABELS[value] ? value : 'manual';
    saveWatchlist();
    const select = document.getElementById('sort-select');
    const label = document.getElementById('sort-label');
    if (select) select.value = sortMode;
    if (label) label.textContent = SORT_LABELS[sortMode];
    document.querySelectorAll('#sort-menu [role="option"]').forEach(option => {
        option.setAttribute('aria-selected', String(option.dataset.sortValue === sortMode));
    });
    renderWatchlist();
}

function toggleSortMenu() {
    const picker = document.getElementById('sort-picker');
    const trigger = document.getElementById('sort-trigger');
    if (!picker || !trigger) return;
    const isOpen = picker.classList.toggle('open');
    trigger.setAttribute('aria-expanded', String(isOpen));
}

function selectSortOption(value) {
    changeSort(value);
    document.getElementById('sort-picker')?.classList.remove('open');
    document.getElementById('sort-trigger')?.setAttribute('aria-expanded', 'false');
}

function sortedWatchlist() {
    const result = [...watchlist];
    if (sortMode === 'manual') return result;
    const price = stock => Number(String(quoteCache[stock.symbol]?.latestPrice ?? '').replace(/,/g, ''));
    const change = stock => Number(quoteCache[stock.symbol]?.changePercent);
    const numericCompare = (a, b, descending = false) => {
        if (!Number.isFinite(a)) return Number.isFinite(b) ? 1 : 0;
        if (!Number.isFinite(b)) return -1;
        return descending ? b - a : a - b;
    };
    result.sort((a, b) => {
        switch (sortMode) {
            case 'symbol-asc': return a.symbol.localeCompare(b.symbol, undefined, { numeric: true });
            case 'symbol-desc': return b.symbol.localeCompare(a.symbol, undefined, { numeric: true });
            case 'name-asc': return (a.name || a.symbol).localeCompare(b.name || b.symbol, 'zh-Hant');
            case 'name-desc': return (b.name || b.symbol).localeCompare(a.name || a.symbol, 'zh-Hant');
            case 'price-asc': return numericCompare(price(a), price(b));
            case 'price-desc': return numericCompare(price(a), price(b), true);
            case 'change-asc': return numericCompare(change(a), change(b));
            case 'change-desc': return numericCompare(change(a), change(b), true);
            default: return 0;
        }
    });
    return result;
}

function renderWatchlist() {
    const list = document.getElementById('stock-list');
    if (!list) return;
    list.replaceChildren();
    const stocks = sortedWatchlist();
    if (!stocks.length) {
        list.innerHTML = '<div class="empty-state"><b>觀察清單是空的</b><span>在上方輸入代碼開始追蹤</span></div>';
        return;
    }

    stocks.forEach(stock => {
        const quote = quoteCache[stock.symbol];
        const change = Number(quote?.changePercent);
        const item = document.createElement('div');
        item.className = `stock-btn w-full text-left px-3 py-2.5 rounded-xl text-gray-400 flex items-center gap-2 group ${currentSymbol === stock.symbol ? 'active bg-white/10 text-white' : ''}`;
        item.classList.toggle('international-colors', usesInternationalColors(stock.symbol));
        item.dataset.symbol = stock.symbol;
        item.tabIndex = 0;
        item.setAttribute('role', 'button');
        item.setAttribute('aria-label', `查看 ${stock.name || displaySymbol(stock.symbol)}`);
        item.addEventListener('click', () => loadStock(stock.symbol));
        item.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); loadStock(stock.symbol); }
        });

        const handle = document.createElement('span');
        handle.className = `drag-handle text-lg px-2 py-1 ${sortMode === 'manual' ? 'cursor-grab hover:text-white' : 'opacity-30'}`;
        handle.title = sortMode === 'manual' ? '拖曳排序' : '切換到自訂順序後可拖曳';
        handle.textContent = '⋮';
        const badge = document.createElement('span');
        badge.className = `w-8 h-8 rounded-lg ${COLOR_MAP[stock.color] || COLOR_MAP.blue} flex items-center justify-center text-[10px] font-bold shrink-0`;
        badge.textContent = displaySymbol(stock.symbol).slice(0, 4);
        const details = document.createElement('div');
        details.className = 'watchlist-identity flex-1 min-w-0';
        const name = document.createElement('div'); name.className = 'font-medium text-sm truncate'; name.textContent = stock.name || displaySymbol(stock.symbol);
        const symbol = document.createElement('div'); symbol.className = 'watchlist-symbol'; symbol.textContent = displaySymbol(stock.symbol);
        details.append(name, symbol);
        const quoteInfo = document.createElement('div'); quoteInfo.className = 'watchlist-quote';
        const last = document.createElement('span'); last.className = 'watchlist-last'; last.textContent = quote?.latestPrice || '—';
        const changeValue = document.createElement('span'); changeValue.className = `watchlist-change ${Number.isFinite(change) ? (change >= 0 ? 'price-up' : 'price-down') : ''}`;
        changeValue.textContent = Number.isFinite(change) ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '—';
        quoteInfo.append(last, changeValue);
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'delete-btn text-gray-600 hover:text-red-400 p-1 rounded-lg hover:bg-red-500/10';
        remove.title = '移除'; remove.setAttribute('aria-label', `移除 ${stock.name || displaySymbol(stock.symbol)}`);
        remove.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>';
        remove.addEventListener('click', event => { event.stopPropagation(); removeStockBySymbol(stock.symbol); });
        item.append(handle, badge, details, quoteInfo, remove);
        list.appendChild(item);
    });

    if (!sortableInstance && typeof Sortable !== 'undefined') {
        sortableInstance = new Sortable(list, {
            animation: 150, handle: '.drag-handle', disabled: sortMode !== 'manual',
            onEnd() {
                if (sortMode !== 'manual') return;
                const order = [...list.children].map(item => item.dataset.symbol).filter(Boolean);
                const reordered = order.map(symbol => watchlist.find(stock => stock.symbol === symbol)).filter(Boolean);
                if (reordered.length === watchlist.length) { watchlist = reordered; saveWatchlist(); }
            }
        });
    } else if (sortableInstance) sortableInstance.option('disabled', sortMode !== 'manual');
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
    else if (/^\d{4,6}$/.test(raw)) {
        try { await fetchYahooData(`${raw}.TW`, '1d', '5d'); symbol = `${raw}.TW`; }
        catch { try { await fetchYahooData(`${raw}.TWO`, '1d', '5d'); symbol = `${raw}.TWO`; } catch { symbol = `${raw}.TW`; } }
    }
    if (watchlist.some(item => item.symbol === symbol || displaySymbol(item.symbol) === displaySymbol(symbol))) {
        alert(`${displaySymbol(symbol)} 已經在清單中了`); input.value = ''; return;
    }
    let name = SPECIAL_NAME_MAP[symbol] || displaySymbol(symbol);
    if (isForexSymbol(symbol)) name = '美元／台幣匯率';
    else if (isCryptoSymbol(symbol)) name = ({ BTC: '比特幣', ETH: '以太幣', SOL: 'Solana', XRP: 'XRP', ADA: 'Cardano', DOGE: 'Dogecoin', BNB: 'BNB' })[symbol] || symbol;
    else if (isTaiwanSymbol(symbol)) name = (await fetchTwseName(displaySymbol(symbol))) || displaySymbol(symbol);
    watchlist.push({ symbol, name, color: COLOR_KEYS[Math.floor(Math.random() * COLOR_KEYS.length)] });
    input.value = ''; saveWatchlist(); renderWatchlist(); await loadStock(symbol);
}

function removeStockBySymbol(symbol) { const index = watchlist.findIndex(stock => stock.symbol === symbol); if (index >= 0) removeStock(index); }
function removeStock(index) {
    const removed = watchlist[index];
    if (!removed || !confirm(`確定要移除 ${displaySymbol(removed.symbol)} 嗎？`)) return;
    watchlist.splice(index, 1); delete quoteCache[removed.symbol];
    if (currentSymbol === removed.symbol) currentSymbol = watchlist[0]?.symbol || null;
    saveWatchlist(); renderWatchlist();
    if (currentSymbol) loadStock(currentSymbol);
}

function getAllActiveCharts() {
    const charts = [mainChart, volChart];
    if (subIndicatorsState.kd) charts.push(kdChart);
    if (subIndicatorsState.rsi) charts.push(rsiChart);
    if (subIndicatorsState.macd) charts.push(macdChart);
    return charts.filter(Boolean);
}

function switchChipTab(tab) {
    currentChipTab = tab === 'holding' ? 'holding' : 'flow';
    localStorage.setItem('stockChipTab', currentChipTab);
    const flowButton = document.getElementById('chip-tab-flow');
    const holdingButton = document.getElementById('chip-tab-holding');
    flowButton?.classList.toggle('bg-white/15', currentChipTab === 'flow');
    flowButton?.classList.toggle('text-white', currentChipTab === 'flow');
    flowButton?.classList.toggle('text-gray-400', currentChipTab !== 'flow');
    holdingButton?.classList.toggle('bg-white/15', currentChipTab === 'holding');
    holdingButton?.classList.toggle('text-white', currentChipTab === 'holding');
    holdingButton?.classList.toggle('text-gray-400', currentChipTab !== 'holding');
    renderChipContent();
}

function jumpToSection(id, button) {
    const viewById = { 'overview-card': 'overview', 'chart-card': 'chart', 'chip-card': 'chip', 'fundamentals-card': 'fundamentals', 'news-card': 'news' };
    applyWorkspaceView(viewById[id] || 'chart', button);
}

function saveWorkspaceScroll(view = currentWorkspaceView) {
    const scroller = document.querySelector('.workspace-scroll');
    if (scroller) localStorage.setItem(`stockWorkspaceScroll:${view}`, String(Math.max(0, Math.round(scroller.scrollTop))));
}

function restoreWorkspaceScroll(view = currentWorkspaceView) {
    const scroller = document.querySelector('.workspace-scroll');
    if (!scroller) return;
    const saved = Number(localStorage.getItem(`stockWorkspaceScroll:${view}`));
    if (Number.isFinite(saved) && saved >= 0) scroller.scrollTop = saved;
}

function applyWorkspaceView(view = 'chart', button = null) {
    const previousView = currentWorkspaceView;
    if (previousView !== view) saveWorkspaceScroll(previousView);
    const navChip = document.getElementById('nav-chip-btn');
    if (view === 'chip' && navChip?.classList.contains('hidden')) view = 'chart';
    currentWorkspaceView = ['overview', 'chart', 'chip', 'fundamentals', 'news'].includes(view) ? view : 'chart';
    localStorage.setItem('stockWorkspaceView', currentWorkspaceView);

    const overview = document.getElementById('overview-card');
    const analysis = document.querySelector('.analysis-workbench');
    const chip = document.getElementById('chip-card');
    const research = document.querySelector('.research-grid');
    const fundamentals = document.getElementById('fundamentals-card');
    const news = document.getElementById('news-card');

    overview?.classList.toggle('workspace-hidden', currentWorkspaceView !== 'overview');
    analysis?.classList.toggle('workspace-hidden', currentWorkspaceView !== 'chart');
    chip?.classList.toggle('workspace-hidden', currentWorkspaceView !== 'chip');
    research?.classList.toggle('workspace-hidden', !['fundamentals', 'news'].includes(currentWorkspaceView));
    fundamentals?.classList.toggle('workspace-hidden', currentWorkspaceView !== 'fundamentals');
    news?.classList.toggle('workspace-hidden', currentWorkspaceView !== 'news');

    document.querySelectorAll('.section-nav-btn').forEach(item => {
        item.classList.toggle('active', item === button || item.dataset.view === currentWorkspaceView);
        item.setAttribute('aria-selected', String(item.dataset.view === currentWorkspaceView));
    });

    if (currentWorkspaceView === 'chart') {
        window.setTimeout(() => window.dispatchEvent(new Event('resize')), 40);
    } else if (currentWorkspaceView === 'chip') {
        window.setTimeout(() => renderChipContent(), 40);
    }
    window.setTimeout(() => restoreWorkspaceScroll(currentWorkspaceView), 60);
}

function setupWorkspaceTabs() {
    const nav = document.getElementById('main-section-nav');
    if (!nav) return;
    nav.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = [...nav.querySelectorAll('[role="tab"]')].filter(tab => !tab.classList.contains('hidden'));
        if (!tabs.length) return;
        const current = Math.max(tabs.indexOf(document.activeElement), 0);
        let next = current;
        if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
        if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        tabs[next].focus();
        tabs[next].click();
        event.preventDefault();
    });
}

// ============================================================
// 3. 核心 API 請求
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

async function fetchTwseChipData(symbol) {
    try {
        const res = await fetch(`${WORKER_URL}/?source=twse_chip&symbol=${encodeURIComponent(displaySymbol(symbol))}`, { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

async function fetchTwseChipHistory(symbol) {
    try {
        const res = await fetch(`${WORKER_URL}/?source=twse_chip_history&symbol=${encodeURIComponent(displaySymbol(symbol))}&days=15`, { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

async function fetchFinnhubWorker(symbol, endpoint, params = {}) {
    const query = new URLSearchParams({ source: 'finnhub', symbol: finnhubSymbol(symbol), endpoint, ...params });
    const cacheKey = query.toString();
    const ttl = endpoint === 'quote' ? 30_000 : 6 * 60 * 60 * 1000;
    const cached = finnhubCache.get(cacheKey);
    if (cached && Date.now() - cached.time < ttl) return cached.data;
    if (Date.now() < finnhubBackoffUntil) {
        if (cached) return cached.data;
        throw new Error('FINNHUB_RATE_LIMITED');
    }
    const res = await fetch(`${WORKER_URL}/?${query.toString()}`, { cache: 'no-store' });
    if (!res.ok) {
        if (res.status === 429) {
            const headerVal = res.headers.get('retry-after');
            const retryAfter = headerVal ? Number(headerVal) : NaN;
            finnhubBackoffUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000);
        }
        throw new Error(`FINNHUB_PROXY_${res.status}`);
    }
    const data = await res.json();
    finnhubCache.set(cacheKey, { data, time: Date.now() });
    return data;
}
async function fetchTwseQuote(symbol) {
    const res = await fetch(`${WORKER_URL}/?source=twse_quote&symbol=${encodeURIComponent(displaySymbol(symbol))}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`TWSE_QUOTE_${res.status}`);
    return await res.json();
}
async function fetchTwseRealtimeQuote(symbol) {
    const res = await fetch(`${WORKER_URL}/?source=twse_realtime&symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`TWSE_REALTIME_${res.status}`);
    return await res.json();
}
function applyTwseQuote(quote, official, symbol) {
    const price = Number(official?.price), previous = Number(official?.previousClose), change = Number(official?.change);
    if (!Number.isFinite(price) || !Number.isFinite(previous) || !Number.isFinite(change)) return quote;
    const percent = Number.isFinite(Number(official.changePercent)) ? Number(official.changePercent) : (change / previous) * 100;
    return {
        ...(quote || {}),
        latestPrice: formatPrice(price, symbol), previousClose: formatPrice(previous, symbol), change: change.toFixed(2), changePercent: percent.toFixed(2), isUp: change > 0, isFlat: change === 0,
        open: formatPrice(official.open, symbol), high: formatPrice(official.high, symbol), low: formatPrice(official.low, symbol), volume: formatVolume(official.volume)
    };
}

function applyTaiwanRealtimeCandle(data, quote) {
    if (!quote?.date) return data;
    const dateText = String(quote.date).replace(/\D/g, '');
    const price = Number(quote.price), open = Number(quote.open), high = Number(quote.high), low = Number(quote.low);
    if (dateText.length !== 8 || !Number.isFinite(price)) return data;

    if (currentPeriod.interval === '1m') {
        const timeText = String(quote.time || '').replace(/\D/g, '').padEnd(6, '0');
        const iso = `${dateText.slice(0, 4)}-${dateText.slice(4, 6)}-${dateText.slice(6, 8)}T${timeText.slice(0, 2)}:${timeText.slice(2, 4)}:${timeText.slice(4, 6)}+08:00`;
        const epoch = Math.floor(new Date(iso).getTime() / 60000) * 60;
        if (!Number.isFinite(epoch) || !matchesTradingSession(epoch, { exchangeTimezoneName: 'Asia/Taipei' })) return data;
        const next = [...data];
        const index = next.findIndex(item => Number(item.time) === epoch);
        const existing = index >= 0 ? next[index] : null;
        const candle = {
            time: epoch,
            open: existing?.open ?? price,
            high: Math.max(existing?.high ?? price, price),
            low: Math.min(existing?.low ?? price, price),
            close: price,
            volume: existing?.volume ?? 0
        };
        if (index >= 0) next[index] = candle;
        else if (!next.length || Number(next.at(-1).time) < epoch) next.push(candle);
        return next;
    }

    if (currentPeriod.interval !== '1d' || ![open, high, low].every(Number.isFinite)) return data;
    const time = `${dateText.slice(0, 4)}-${dateText.slice(4, 6)}-${dateText.slice(6, 8)}`;
    const candle = { time, open, high, low, close: price, volume: Number(quote.volume) || 0 };
    const next = [...data];
    const index = next.findIndex(item => item.time === time);
    if (index >= 0) next[index] = candle;
    else if (!next.length || String(next.at(-1).time) < time) next.push(candle);
    return next;
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

async function fetchFinnhubMetrics(symbol) { 
    return await fetchFinnhubWorker(symbol, 'metric', { metric: 'all' }).catch(() => null); 
}


function renderFinnhubMetrics(result) {
    const metric = result?.metric || {};
    if (!metric || Object.keys(metric).length === 0) { resetFundamentals(); return; }

    setMetric('metric-pe', formatMetric(firstFinite(metric, ['peNormalizedAnnual', 'peTTM'])));
    setMetric('metric-eps', formatMetric(firstFinite(metric, ['epsNormalizedAnnual', 'epsTTM'])));
    setMetric('metric-marketcap', formatCompactNumber(firstFinite(metric, ['marketCapitalization'])));
    setMetric('metric-beta', formatMetric(firstFinite(metric, ['beta'])));
    setMetric('metric-52high', formatMetric(firstFinite(metric, ['52WeekHigh'])));
    setMetric('metric-52low', formatMetric(firstFinite(metric, ['52WeekLow'])));
    setMetric('metric-dividend', formatPercentMetric(firstFinite(metric, ['dividendYieldIndicatedAnnual', 'dividendYieldTTM'])));
    setMetric('metric-roe', formatPercentMetric(firstFinite(metric, ['roeTTM', 'roeRfy'])));
    setMetric('metric-gross-margin', formatPercentMetric(firstFinite(metric, ['grossMarginTTM', 'grossMarginAnnual'])));
    setMetric('metric-op-margin', formatPercentMetric(firstFinite(metric, ['operatingMarginTTM', 'operatingMarginAnnual'])));
    
    setMetric('fundamentals-status', 'Finnhub 已載入');
}


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

// 統一且安全的 fetchMarketIndices
async function fetchMarketIndices() {
    const jobs = INDICES_CONFIG.map(async idx => {
        try {
            let quote = null;
            if (idx.symbol === '^TWII') {
                try {
                    const twse = await fetchTwseRealtimeQuote(idx.symbol);
                    if (twse) quote = applyTwseQuote(null, twse, idx.symbol);
                } catch {
                    const data = await fetchYahooData(idx.symbol, '1d', '5d');
                    quote = data ? parseQuote(data, idx.symbol) : null;
                }
            } else {
                const data = await fetchYahooData(idx.symbol, '1d', '5d');
                quote = data ? parseQuote(data, idx.symbol) : null;
            }

            if (!quote) return;
            const priceEl = document.getElementById(`idx-${idx.id}-price`);
            const changeEl = document.getElementById(`idx-${idx.id}-change`);
            changeEl?.closest('.index-card')?.classList.toggle('international-colors', usesInternationalColors(idx.symbol));
            if (priceEl) priceEl.textContent = quote.latestPrice || '—';
            if (changeEl) {
                const change = Number(quote.change);
                const percent = Number(quote.changePercent);
                const isUp = change > 0, isDown = change < 0, sign = isUp ? '+' : '';
                changeEl.textContent = `${sign}${Number.isFinite(change) ? quote.change : '0'} (${sign}${Number.isFinite(percent) ? quote.changePercent : '0.00'}%)`;
                changeEl.className = `text-[10px] mt-0.5 font-medium ${isUp ? 'price-up' : (isDown ? 'price-down' : 'text-gray-500')}`;
            }
        } catch (error) {
            console.warn(`[INDEX] ${idx.symbol} unavailable`, error);
        }
    });
    await Promise.allSettled(jobs);
}

// ==========================================
// 近期重要公告與新聞
// ==========================================
async function fetchNewsData(symbol) {
    const listEl = document.getElementById('news-list');
    const announcementEl = document.getElementById('important-announcement-list');
    if (!listEl && !announcementEl) return;
    if (listEl) listEl.innerHTML = '<div class="data-state"><span class="data-state-pulse"></span><b>正在同步市場新聞</b><small>Connecting to market feed</small></div>';
    if (announcementEl) announcementEl.innerHTML = '<span class="announcement-loading">正在同步最新公告…</span>';
    
    try {
        let url = `${WORKER_URL}/?source=news`;
        if (symbol && !isTaiwanSymbol(symbol) && !isCryptoSymbol(symbol) && !isIndexSymbol(symbol) && !isForexSymbol(symbol)) {
            url = `${WORKER_URL}/?source=news&symbol=${encodeURIComponent(finnhubSymbol(symbol))}`;
        }
        
        const res = await fetch(url);
        if (!res.ok) throw new Error('News fetch failed');
        const news = await res.json();
        
        if (!Array.isArray(news) || news.length === 0) {
            if (listEl) listEl.innerHTML = '<div class="data-state"><b>目前沒有相關新聞</b><small>稍後將自動取得最新內容</small></div>';
            if (announcementEl) announcementEl.innerHTML = '<span class="announcement-empty">目前沒有近期重要公告</span>';
            return;
        }

        if (announcementEl) {
            announcementEl.innerHTML = news.slice(0, 3).map(item => {
                const dateObj = new Date(item.datetime * 1000);
                const hasValidDate = Number.isFinite(dateObj.getTime());
                const dateStr = hasValidDate ? `${String(dateObj.getMonth()+1).padStart(2,'0')}/${String(dateObj.getDate()).padStart(2,'0')}` : '近期';
                const dateTime = hasValidDate ? dateObj.toISOString() : '';
                return `<a class="announcement-item" href="${escapeHtmlAttribute(item.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtmlAttribute(item.headline)}">
                    <time datetime="${dateTime}">${dateStr}</time>
                    <span>${escapeHtmlAttribute(item.headline)}</span>
                    <small>${escapeHtmlAttribute(item.source)}</small>
                </a>`;
            }).join('');
        }
        
        if (listEl) listEl.innerHTML = news.map(item => {
            const dateObj = new Date(item.datetime * 1000);
            const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth()+1).padStart(2,'0')}-${String(dateObj.getDate()).padStart(2,'0')}`;
            return `
            <a href="${escapeHtmlAttribute(item.url)}" target="_blank" rel="noopener noreferrer" class="block p-3 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/5 transition-colors">
                <div class="text-[10px] text-gray-400 mb-1">${dateStr} · ${escapeHtmlAttribute(item.source)}</div>
                <div class="text-sm font-semibold text-gray-200 line-clamp-2">${escapeHtmlAttribute(item.headline)}</div>
            </a>`;
        }).join('');
    } catch (error) {
        if (listEl) listEl.innerHTML = '<div class="data-state is-error"><b>新聞服務暫時無法連線</b><small>行情功能不受影響，請稍後再試</small></div>';
        if (announcementEl) announcementEl.innerHTML = '<span class="announcement-empty is-error">公告服務暫時無法連線</span>';
    }
}

// ============================================================
// 4. 指標演算法與圖表管理
// ============================================================
function calculateIndicatorData(data, period, valueGetter, mapper) {
    const result = [], values = [];
    data.forEach(item => {
        values.push(valueGetter(item));
        if (values.length < period) return;
        const window = values.slice(-period), average = window.reduce((sum, value) => sum + value, 0) / period;
        result.push(mapper(item, average, window));
    });
    return result;
}

function calculateKDData(data, n = 9) {
    const kList = [], dList = [];
    let prevK = 50, prevD = 50;

    data.forEach((item, idx) => {
        if (idx < n - 1) {
            kList.push({ time: item.time, value: 50 });
            dList.push({ time: item.time, value: 50 });
            return;
        }

        const slice = data.slice(idx - n + 1, idx + 1);
        const highest = Math.max(...slice.map(d => d.high));
        const lowest = Math.min(...slice.map(d => d.low));
        const rsv = highest === lowest ? 50 : ((item.close - lowest) / (highest - lowest)) * 100;

        const currentK = (2 / 3) * prevK + (1 / 3) * rsv;
        const currentD = (2 / 3) * prevD + (1 / 3) * currentK;

        prevK = currentK;
        prevD = currentD;

        kList.push({ time: item.time, value: Number(currentK.toFixed(2)) });
        dList.push({ time: item.time, value: Number(currentD.toFixed(2)) });
    });

    return { kList, dList };
}

function calculateRSIData(data, period = 14) {
    const result = [];
    let gains = 0, losses = 0;

    for (let i = 1; i < data.length; i++) {
        const diff = data[i].close - data[i - 1].close;
        if (i <= period) {
            if (diff >= 0) gains += diff; else losses -= diff;
            if (i === period) {
                const avgGain = gains / period, avgLoss = losses / period;
                const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
                result.push({ time: data[i].time, value: 100 - (100 / (1 + rs)) });
            }
        } else {
            const gain = diff >= 0 ? diff : 0;
            const loss = diff < 0 ? -diff : 0;
            gains = (gains * (period - 1) + gain) / period;
            losses = (losses * (period - 1) + loss) / period;
            const rs = losses === 0 ? 100 : gains / losses;
            result.push({ time: data[i].time, value: Number((100 - (100 / (1 + rs))).toFixed(2)) });
        }
    }
    return result;
}

function calculateMACDData(data) {
    const closes = data.map(d => d.close);
    const emaSeries = (period) => {
        const values = [], alpha = 2 / (period + 1);
        let val = closes[0];
        closes.forEach((close, i) => {
            val = i === 0 ? close : close * alpha + val * (1 - alpha);
            values.push(val);
        });
        return values;
    };

    const ema12 = emaSeries(12);
    const ema26 = emaSeries(26);
    const dif = closes.map((_, i) => ema12[i] - ema26[i]);

    const dea = [];
    let deaVal = dif[0];
    const signalAlpha = 2 / 10;
    dif.forEach((v, i) => {
        deaVal = i === 0 ? v : v * signalAlpha + deaVal * (1 - signalAlpha);
        dea.push(deaVal);
    });

    const histList = [], difList = [], deaList = [];
    data.forEach((d, i) => {
        const hist = (dif[i] - dea[i]) * 2;
        histList.push({ time: d.time, value: Number(hist.toFixed(3)), color: hist >= 0 ? '#ef4444' : '#10b981' });
        difList.push({ time: d.time, value: Number(dif[i].toFixed(3)) });
        deaList.push({ time: d.time, value: Number(dea[i].toFixed(3)) });
    });

    return { histList, difList, deaList };
}

function createBaseChart(container) {
    const isMobile = window.innerWidth < 768;
    const gridColor = isDarkMode ? 'rgba(148,184,174,0.055)' : 'rgba(45,82,71,0.055)';
    const scaleBorderColor = isDarkMode ? 'rgba(148,184,174,0.13)' : 'rgba(45,82,71,0.13)';
    const textColor = isDarkMode ? '#789088' : '#536c64';

    return LightweightCharts.createChart(container, {
        layout: { textColor: textColor, background: { type: 'solid', color: 'transparent' }, fontSize: 10 },
        grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        timeScale: {
            visible: true,
            borderColor: scaleBorderColor,
            timeVisible: true,
            secondsVisible: false,
            fixLeftEdge: true,
            fixRightEdge: true
        },
        rightPriceScale: { borderColor: scaleBorderColor, scaleMargins: { top: 0.1, bottom: 0.1 } },
        handleScroll: { mouseWheel: false, pressedMouseMove: !isMobile, horzTouchDrag: true, vertTouchDrag: true },
        handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: !isMobile }
    });
}

function initChart() {
    const mainEl = document.getElementById('pane-main');
    const volEl = document.getElementById('pane-vol');
    const kdEl = document.getElementById('pane-kd');
    const rsiEl = document.getElementById('pane-rsi');
    const macdEl = document.getElementById('pane-macd');

    if (!mainEl || typeof LightweightCharts === 'undefined' || mainChart) return false;

    mainChart = createBaseChart(mainEl);
    volChart = createBaseChart(volEl);
    volChart.priceScale('right').applyOptions({ scaleMargins: { top: 0.05, bottom: 0.02 } });
    kdChart = createBaseChart(kdEl);
    rsiChart = createBaseChart(rsiEl);
    macdChart = createBaseChart(macdEl);

    candlestickSeries = mainChart.addCandlestickSeries({
        upColor: '#ef4444', downColor: '#10b981', borderVisible: true,
        borderUpColor: '#ef4444', borderDownColor: '#10b981', wickUpColor: '#ef4444', wickDownColor: '#10b981'
    });
    priceLineSeries = mainChart.addAreaSeries({
        lineColor: '#4c8dff', lineWidth: 2,
        topColor: 'rgba(76, 141, 255, .24)', bottomColor: 'rgba(76, 141, 255, .015)',
        priceLineVisible: true, lastValueVisible: true,
        crosshairMarkerVisible: true, crosshairMarkerRadius: 4,
        visible: chartDisplayMode === 'line'
    });
    intradayAverageSeries = mainChart.addLineSeries({
        color: '#f2b84b', lineWidth: 1.5, priceLineVisible: false,
        lastValueVisible: false, crosshairMarkerVisible: false, visible: false
    });
    previousCloseSeries = mainChart.addLineSeries({
        color: 'rgba(148, 163, 184, .72)', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerVisible: false, visible: false
    });
    candlestickSeries.applyOptions({ visible: chartDisplayMode === 'candles' });
    ma5Series = mainChart.addLineSeries({ color: '#fb7185', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    ma20Series = mainChart.addLineSeries({ color: '#f59e0b', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    ma60Series = mainChart.addLineSeries({ color: '#38bdf8', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    upperBandSeries = mainChart.addLineSeries({ color: 'rgba(168,85,247,0.7)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    lowerBandSeries = mainChart.addLineSeries({ color: 'rgba(168,85,247,0.7)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

    volSeries = volChart.addHistogramSeries({ priceFormat: { type: 'volume' } });
    kdSeriesK = kdChart.addLineSeries({ color: '#38bdf8', lineWidth: 1.5, priceLineVisible: false });
    kdSeriesD = kdChart.addLineSeries({ color: '#f87171', lineWidth: 1.5, priceLineVisible: false });
    rsiSeries = rsiChart.addLineSeries({ color: '#c084fc', lineWidth: 1.5, priceLineVisible: false });
    macdHistSeries = macdChart.addHistogramSeries({ priceLineVisible: false });
    macdLineSeries = macdChart.addLineSeries({ color: '#38bdf8', lineWidth: 1.5, priceLineVisible: false });
    macdSignalSeries = macdChart.addLineSeries({ color: '#f87171', lineWidth: 1.5, priceLineVisible: false });

    const allCharts = [mainChart, volChart, kdChart, rsiChart, macdChart];
    allCharts.forEach(sourceChart => {
        sourceChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
            if (isSyncingTimeScale || !range) return;
            isSyncingTimeScale = true;
            allCharts.forEach(targetChart => {
                if (targetChart !== sourceChart) {
                    try { targetChart.timeScale().setVisibleLogicalRange(range); } catch {}
                }
            });
            isSyncingTimeScale = false;
        });
    });

    allCharts.forEach(c => c.subscribeCrosshairMove(updateCrosshairHUD));

    setupChartResize();
    setupChartKeyboard();
    updateVisibleSubPanes();
    applyChartDisplayMode();
    return true;
}

function setupChartKeyboard() {
    window.addEventListener('keydown', event => {
        if (document.activeElement?.tagName === 'INPUT' || !mainChart) return;
        const timeScale = mainChart.timeScale();
        const visibleRange = timeScale.getVisibleLogicalRange();
        if (!visibleRange) return;

        const span = visibleRange.to - visibleRange.from;
        const zoomFactor = 0.2;

        if (event.key === '+' || event.key === '=') {
            const newSpan = Math.max(5, span * (1 - zoomFactor));
            const center = (visibleRange.from + visibleRange.to) / 2;
            const newRange = { from: center - newSpan / 2, to: center + newSpan / 2 };
            getAllActiveCharts().forEach(c => {
                try { c.timeScale().setVisibleLogicalRange(newRange); } catch {}
            });
            event.preventDefault();
        } else if (event.key === '-' || event.key === '_') {
            const newSpan = span * (1 + zoomFactor);
            const center = (visibleRange.from + visibleRange.to) / 2;
            const newRange = { from: center - newSpan / 2, to: center + newSpan / 2 };
            getAllActiveCharts().forEach(c => {
                try { c.timeScale().setVisibleLogicalRange(newRange); } catch {}
            });
            event.preventDefault();
        }
    });
}

function updateVisibleSubPanes() {
    const kdWrap = document.getElementById('pane-kd-wrap');
    const rsiWrap = document.getElementById('pane-rsi-wrap');
    const macdWrap = document.getElementById('pane-macd-wrap');

    if (kdWrap) kdWrap.classList.toggle('hidden', !subIndicatorsState.kd);
    if (rsiWrap) rsiWrap.classList.toggle('hidden', !subIndicatorsState.rsi);
    if (macdWrap) macdWrap.classList.toggle('hidden', !subIndicatorsState.macd);

    requestAnimationFrame(() => {
        const width = document.getElementById('panes-wrapper')?.clientWidth || 0;
        if (width > 0) {
            mainChart?.applyOptions({ width, height: 300 });
            volChart?.applyOptions({ width, height: 65 });
            if (subIndicatorsState.kd && kdChart) kdChart.applyOptions({ width, height: 75 });
            if (subIndicatorsState.rsi && rsiChart) rsiChart.applyOptions({ width, height: 75 });
            if (subIndicatorsState.macd && macdChart) macdChart.applyOptions({ width, height: 80 });
        }
        resetChartView();
    });
}

function updateChartIndicators(data) {
    if (!data.length) {
        [intradayAverageSeries, previousCloseSeries, ma5Series, ma20Series, ma60Series, upperBandSeries, lowerBandSeries, volSeries, kdSeriesK, kdSeriesD, rsiSeries, macdHistSeries, macdLineSeries, macdSignalSeries]
            .filter(Boolean)
            .forEach(series => series.setData([]));
        intradayAverageData = []; currentPreviousClose = null;
        ['hud-date', 'hud-open', 'hud-high', 'hud-low', 'hud-close', 'hud-volume', 'hud-ma5', 'hud-ma20', 'hud-ma60', 'hud-kd-k', 'hud-kd-d', 'hud-rsi-val', 'hud-macd-dif', 'hud-macd-dea', 'hud-macd-hist', 'hud-live-price', 'hud-average-price', 'hud-previous-line']
            .forEach(id => setText(id, '—'));
        return;
    }
    const close = item => item.close;

    ma5Series?.setData(mainIndicatorsState.ma ? calculateIndicatorData(data, 5, close, (item, avg) => ({ time: item.time, value: avg })) : []);
    ma20Series?.setData(mainIndicatorsState.ma ? calculateIndicatorData(data, 20, close, (item, avg) => ({ time: item.time, value: avg })) : []);
    ma60Series?.setData(mainIndicatorsState.ma ? calculateIndicatorData(data, 60, close, (item, avg) => ({ time: item.time, value: avg })) : []);

    if (mainIndicatorsState.bollinger) {
        upperBandSeries?.setData(calculateIndicatorData(data, 20, close, (item, avg, val) => ({ time: item.time, value: avg + Math.sqrt(val.reduce((sum, v) => sum + (v - avg) ** 2, 0) / 20) * 2 })));
        lowerBandSeries?.setData(calculateIndicatorData(data, 20, close, (item, avg, val) => ({ time: item.time, value: avg - Math.sqrt(val.reduce((sum, v) => sum + (v - avg) ** 2, 0) / 20) * 2 })));
    } else {
        upperBandSeries?.setData([]); lowerBandSeries?.setData([]);
    }

    volSeries?.setData(data.filter(d => Number(d.volume) > 0).map(d => ({
        time: d.time,
        value: Number(d.volume),
        color: d.close >= d.open ? 'rgba(239, 68, 68, 0.75)' : 'rgba(16, 185, 129, 0.75)'
    })));

    if (subIndicatorsState.kd) {
        const { kList, dList } = calculateKDData(data);
        kdSeriesK?.setData(kList);
        kdSeriesD?.setData(dList);
    }
    if (subIndicatorsState.rsi) {
        rsiSeries?.setData(calculateRSIData(data));
    }
    if (subIndicatorsState.macd) {
        const { histList, difList, deaList } = calculateMACDData(data);
        macdHistSeries?.setData(histList);
        macdLineSeries?.setData(difList);
        macdSignalSeries?.setData(deaList);
    }

    const lastItem = data[data.length - 1];
    if (lastItem) updateChartHUD(lastItem);
}

function updateIntradayReferenceSeries(data, previousClose) {
    const validPrevious = Number(previousClose);
    currentPreviousClose = Number.isFinite(validPrevious) && validPrevious > 0 ? validPrevious : null;
    if (currentPeriod.interval !== '1m') {
        intradayAverageData = [];
        intradayAverageSeries?.setData([]);
        previousCloseSeries?.setData([]);
        return;
    }
    let cumulativeValue = 0, cumulativeVolume = 0, runningClose = 0;
    intradayAverageData = data.map((item, index) => {
        const volume = Math.max(0, Number(item.volume) || 0);
        const typicalPrice = (Number(item.high) + Number(item.low) + Number(item.close)) / 3;
        runningClose += Number(item.close);
        if (volume > 0 && Number.isFinite(typicalPrice)) {
            cumulativeValue += typicalPrice * volume;
            cumulativeVolume += volume;
        }
        const value = cumulativeVolume > 0 ? cumulativeValue / cumulativeVolume : runningClose / (index + 1);
        return { time: item.time, value };
    });
    intradayAverageSeries?.setData(intradayAverageData);
    previousCloseSeries?.setData(currentPreviousClose === null ? [] : data.map(item => ({ time: item.time, value: currentPreviousClose })));
    const last = data.at(-1), lastAverage = intradayAverageData.at(-1);
    updateIntradayLiveHud(last?.close);
    setText('hud-average-price', lastAverage ? formatPrice(lastAverage.value, currentSymbol) : '—');
    setText('hud-previous-line', currentPreviousClose === null ? '—' : formatPrice(currentPreviousClose, currentSymbol));
}

function updateIntradayLiveHud(price) {
    const element = document.getElementById('hud-live-price');
    const numericPrice = Number(price);
    if (!element || !Number.isFinite(numericPrice)) {
        if (element) { element.textContent = '—'; element.className = ''; }
        return;
    }
    const changePercent = currentPreviousClose ? (numericPrice - currentPreviousClose) / currentPreviousClose * 100 : null;
    const sign = Number(changePercent) > 0 ? '+' : '';
    element.textContent = `${formatPrice(numericPrice, currentSymbol)}${Number.isFinite(changePercent) ? ` ${sign}${changePercent.toFixed(2)}%` : ''}`;
    element.className = Number(changePercent) > 0 ? 'price-up' : Number(changePercent) < 0 ? 'price-down' : '';
}

function updateChartHUD(candle, timeStr) {
    if (!candle) return;
    const date = getChartDate(candle.time);
    const dateFormatted = timeStr || (['1d', '1wk', '1mo'].includes(currentPeriod.interval) ? `${date.getMonth() + 1}/${date.getDate()}` : `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`);

    setText('hud-date', dateFormatted);
    setText('hud-close', formatPrice(candle.close, currentSymbol));
    setText('hud-open', formatPrice(candle.open, currentSymbol));
    setText('hud-high', formatPrice(candle.high, currentSymbol));
    setText('hud-low', formatPrice(candle.low, currentSymbol));

    let volVal = candle.volume;
    if ((volVal == null || volVal === 0) && currentChartData.length > 0) {
        const found = currentChartData.find(d => d.time === candle.time);
        if (found) volVal = found.volume;
    }
    const volStr = formatVolume(volVal);
    setText('hud-volume', volStr);
    setText('hud-vol-val', volStr);
    if (currentPeriod.interval === '1m' && chartDisplayMode === 'line') {
        const average = intradayAverageData.find(item => item.time === candle.time)?.value;
        updateIntradayLiveHud(candle.close);
        setText('hud-average-price', Number.isFinite(average) ? formatPrice(average, currentSymbol) : '—');
        setText('hud-previous-line', currentPreviousClose === null ? '—' : formatPrice(currentPreviousClose, currentSymbol));
    }

    const closeEl = document.getElementById('hud-close');
    if (closeEl) closeEl.className = candle.close >= candle.open ? 'text-[#ef4444] font-bold font-mono' : 'text-[#10b981] font-bold font-mono';

    if (currentChartData.length > 0) {
        const idx = currentChartData.findIndex(d => d.time === candle.time);
        if (idx >= 0) {
            const getMa = (p) => idx >= p - 1 ? (currentChartData.slice(idx - p + 1, idx + 1).reduce((sum, d) => sum + d.close, 0) / p).toFixed(2) : '—';
            setText('hud-ma5', getMa(5));
            setText('hud-ma20', getMa(20));
            setText('hud-ma60', getMa(60));

            if (subIndicatorsState.kd) {
                const { kList, dList } = calculateKDData(currentChartData);
                setText('hud-kd-k', kList[idx]?.value ?? '—');
                setText('hud-kd-d', dList[idx]?.value ?? '—');
            }
            if (subIndicatorsState.rsi) {
                const rsiList = calculateRSIData(currentChartData);
                setText('hud-rsi-val', rsiList.find(r => r.time === candle.time)?.value ?? '—');
            }
            if (subIndicatorsState.macd) {
                const { histList, difList, deaList } = calculateMACDData(currentChartData);
                setText('hud-macd-dif', difList[idx]?.value ?? '—');
                setText('hud-macd-dea', deaList[idx]?.value ?? '—');
                setText('hud-macd-hist', histList[idx]?.value ?? '—');
            }
        }
    }
}

function updateCrosshairHUD(param) {
    if (!param || !param.time) return;
    const candle = currentChartData.find(d => d.time === param.time);
    if (!candle) return;
    const timeStr = formatChartTooltipTime(param.time);
    updateChartHUD(candle, timeStr);
}

// ============================================================
// 5. 標的資料載入主流程 (結合統一的 Yahoo/Finnhub Fallback)
// ============================================================
function persistCurrentSymbol(symbol) {
    if (!symbol) return;
    currentSymbol = symbol;
    try {
        localStorage.setItem('stockCurrentSymbol', symbol);
    } catch (error) {
        console.warn('Unable to persist current symbol', error);
    }
}

async function loadStock(symbol, isSilent = false) {
    if (!symbol) return;
    const requestId = ++activeLoadRequest;
    const isCurrentRequest = () => requestId === activeLoadRequest;
    persistCurrentSymbol(symbol);
    saveWatchlist();

    const isTw = isTaiwanSymbol(symbol);
    document.querySelector('.dashboard-header')?.classList.toggle('international-colors', usesInternationalColors(symbol));
    updateChartColors(getColorMode(), false);

    if (!isSilent) {
        document.querySelectorAll('.stock-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.symbol === symbol));
        const stockItem = watchlist.find(s => s.symbol === symbol);
        const finalDisplayName = SPECIAL_NAME_MAP[symbol] || stockItem?.name || displaySymbol(symbol);
        setText('stock-symbol-title', finalDisplayName); 
        setText('stock-name', displaySymbol(symbol));
        setText('hud-stock-title', `${displaySymbol(symbol)} ${stockItem?.name || ''}`);
        
        const loadingBadge = document.getElementById('loading-badge'); if (loadingBadge) loadingBadge.classList.remove('hidden');
        ['current-price', 'price-change', 'open-price', 'high-price', 'low-price', 'previous-close', 'volume'].forEach(id => setText(id, '—')); renderExtendedSessionQuote(null); updateMarketState('', symbol);
        const priceChange = document.getElementById('price-change'); if (priceChange) priceChange.className = 'text-sm sm:text-base font-bold px-2.5 py-1 rounded-lg bg-white/5 border border-white/5';
        const currentPrice = document.getElementById('current-price'); if (currentPrice) currentPrice.className = 'text-3xl sm:text-4xl font-black text-white tracking-tight leading-none transition-colors duration-300';
        resetFundamentals();
        resetTechnicalAssessment();
        currentChartData = [];
        if (candlestickSeries) candlestickSeries.setData([]);
        if (priceLineSeries) priceLineSeries.setData([]);
        updateChartIndicators([]);
        
        setChipVisibility(isTaiwanStockSymbol(symbol));
        fetchNewsData(symbol);
    }

    isLoadingStock = true;
    try {
        let quote = null, chartData = [], yahooResult = null, yahooError = null;

        // ========================================================
        // 第一層：Yahoo Finance (K線 + 報價)
        // ========================================================
        try {
            const quoteRequest = fetchYahooData(symbol, '1d', '5d');
            const chartRequest = currentPeriod.interval === '1d' && currentPeriod.range === '5d'
                ? quoteRequest
                : fetchYahooData(symbol);
            const extendedRequest = !isTw && !isIndexSymbol(symbol) && !isForexSymbol(symbol) && !isCryptoSymbol(symbol)
                ? fetchYahooData(symbol, '1m', '1d').catch(() => null)
                : Promise.resolve(null);
            const [quoteResult, chartResult, extendedResult] = await Promise.all([quoteRequest, chartRequest, extendedRequest]);
            yahooResult = quoteResult || chartResult;
            if (yahooResult) {
                try { quote = parseQuote(yahooResult, symbol); } catch {}
                try { chartData = parseCandles(chartResult || yahooResult); } catch {}
            }
            const extendedSession = parseExtendedSessionQuote(extendedResult, symbol);
            if (quote && extendedSession) quote.extendedSession = extendedSession;
        } catch (error) { yahooError = error; }

        if (isTw) {
            let officialQuote = null;
            try {
                officialQuote = await fetchTwseRealtimeQuote(symbol);
                quote = applyTwseQuote(quote, officialQuote, symbol);
            } catch {
                try { officialQuote = await fetchTwseQuote(symbol); quote = applyTwseQuote(quote, officialQuote, symbol); } catch {}
            }
            chartData = applyTaiwanRealtimeCandle(chartData, officialQuote);
            updateChartSessionState(chartData.length, chartData.length);
            let twseMetricsData = null;
            try { twseMetricsData = await fetchTwseMetrics(symbol); } catch {}
            if (twseMetricsData && !isSilent && isCurrentRequest()) {
                const rawPrice = quote?.latestPrice ? Number(quote.latestPrice.replace(/,/g, '')) : NaN;
                renderTwseMetrics(twseMetricsData, symbol, yahooResult, rawPrice);
            }
            if (!isSilent && yahooResult && isCurrentRequest()) {
                renderCompanyInfo(yahooResult, symbol, quote, `Yahoo Finance + ${String(symbol).toUpperCase().includes('.TWO') ? '櫃買中心' : '證交所'}`);
                const stockItem = watchlist.find(s => s.symbol === symbol);
                if (stockItem && (stockItem.name === displaySymbol(symbol) || !stockItem.name)) {
                    const longName = yahooResult.meta?.longName || yahooResult.meta?.shortName;
                    if (longName) { 
                        stockItem.name = longName; 
                        saveWatchlist(); 
                        renderWatchlist(); 
                        setText('stock-symbol-title', longName);
                        setText('hud-stock-title', `${displaySymbol(symbol)} ${longName}`);
                    }
                }
            }
            if (!isSilent) {
                void Promise.allSettled([
                    fetchTwseChipData(symbol),
                    fetchTwseChipHistory(symbol)
                ]).then(([chipDataResult, chipHistoryResult]) => {
                    if (!isCurrentRequest()) return;
                    renderChipData(
                        chipDataResult.status === 'fulfilled' ? chipDataResult.value : null,
                        chipHistoryResult.status === 'fulfilled' ? chipHistoryResult.value : null
                    );
                });
            }
        } else {
            if (isForexSymbol(symbol)) {
                try {
                    const forex = await fetchForexData();
                    if (forex?.rate) {
                        const prevClose = yahooResult?.meta?.regularMarketPreviousClose ?? yahooResult?.meta?.previousClose ?? yahooResult?.meta?.chartPreviousClose;
                        quote = applyCurrentPriceToQuote(quote, forex.rate, prevClose, symbol, forex.changePercent);
                        if (!isSilent && isCurrentRequest()) renderCompanyInfo(yahooResult, symbol, quote, yahooResult ? 'Frankfurter 現價 + Yahoo Finance K線' : 'Frankfurter');
                    }
                } catch {}
            } else if (isCryptoSymbol(symbol)) {
                try {
                    const cryptoJson = await fetchCryptoData(), cryptoSymbol = displaySymbol(symbol).toUpperCase(), crypto = cryptoJson?.[cryptoSymbol];
                    if (crypto) {
                        const currentPrice = Number(crypto.usd ?? crypto.price), cryptoChange = Number(crypto.usd_24h_change ?? crypto.changePercent ?? crypto.change_24h ?? NaN);
                        const previous = yahooResult?.meta?.regularMarketPreviousClose ?? yahooResult?.meta?.previousClose ?? yahooResult?.meta?.chartPreviousClose;
                        quote = applyCurrentPriceToQuote(quote, currentPrice, previous, symbol, cryptoChange);
                        if (!isSilent && isCurrentRequest()) renderCompanyInfo(yahooResult, symbol, quote, yahooResult ? 'CoinGecko 現價 + Yahoo Finance K線' : 'CoinGecko');
                    }
                } catch {}
            } else {
                // ========================================================
                // 第二層：Finnhub 報價 Fallback (若 Yahoo 失敗)
                // ========================================================
                if (!quote && !isIndexSymbol(symbol)) {
                    try {
                        const finnhubQuote = await fetchFinnhubQuote(symbol);
                        quote = finnhubQuote;
                    } catch {}
                }

                // ========================================================
                // 第三層：LocalStorage 快取最後防線
                // ========================================================
                if (!quote && quoteCache[symbol]) {
                    quote = quoteCache[symbol];
                }

                if (!isSilent && isCurrentRequest()) {
                    if (isIndexSymbol(symbol)) renderCompanyInfo(yahooResult, symbol, quote, 'Yahoo Finance');
                    else {
                        const [companyProfile, metricResult] = await Promise.all([
                            fetchFinnhubCompanyProfile(symbol).catch(() => null),
                            fetchFinnhubMetrics(symbol).catch(() => null)
                        ]);

                        if (companyProfile) renderFinnhubCompanyInfo(companyProfile, symbol, quote);
                        else if (yahooResult) renderCompanyInfo(yahooResult, symbol, quote);
                        
                        if (metricResult) renderFinnhubMetrics(metricResult);
                        else resetFundamentals();
                        
                    }
                }
            }
        }

        if (!quote) throw (yahooError || new Error(`無法取得 ${symbol} 報價`));

        if (!isCurrentRequest()) return;

        quoteCache[symbol] = quote; saveWatchlist();

        setText('current-price', quote.latestPrice); setText('open-price', quote.open); setText('high-price', quote.high); setText('low-price', quote.low); setText('previous-close', quote.previousClose); setText('volume', quote.volume); renderExtendedSessionQuote(quote.extendedSession); updateMarketState(yahooResult?.meta?.marketState, symbol);

        const changeEl = document.getElementById('price-change'), changeNumber = Number(quote.change), changePercent = Number(quote.changePercent);
        const isUp = Number.isFinite(changeNumber) && changeNumber > 0, isDown = Number.isFinite(changeNumber) && changeNumber < 0, isFlat = !isUp && !isDown, sign = isUp ? '+' : '';
        if (changeEl) changeEl.textContent = `${sign}${quote.change} (${sign}${Number.isFinite(changePercent) ? changePercent.toFixed(2) : '0.00'}%)`;

        const currentPriceEl = document.getElementById('current-price');
        const baseChangeClass = 'text-sm sm:text-base font-bold px-2.5 py-1 rounded-lg border transition-colors duration-300';
        const basePriceClass = 'text-3xl sm:text-4xl font-black tracking-tight leading-none transition-colors duration-300';
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

        if (mainChart && candlestickSeries && chartData.length > 0) {
            currentChartData = chartData; 
            candlestickSeries.setData(chartData);
            priceLineSeries?.setData(chartData.map(item => ({ time: item.time, value: item.close })));
            const previousCloseValue = Number(String(quote.previousClose || '').replace(/,/g, ''));
            updateIntradayReferenceSeries(chartData, previousCloseValue);
            applyChartDisplayMode();
            updateChartIndicators(chartData); 
            updateTechnicalAssessment(chartData);

            if (!isSilent || chartAtRightEdge) {
                chartAtRightEdge = true;
                getAllActiveCharts().forEach(c => {
                    try { c.timeScale().scrollToRealTime(); } catch {}
                });
            }
        }

        const now = new Date(); setText('last-update', `最後更新：${now.toLocaleString('zh-TW', { hour12: false })}`); renderWatchlist();
        setText('feed-status', 'Data feed active');

    } catch (error) {
        console.error('loadStock error:', error);
        if (!isSilent && isCurrentRequest()) {
            setText('stock-symbol-title', `⚠️ 暫時無法取得資料`);
            setText('stock-name', displaySymbol(symbol));
            setText('current-price', '—');
            setText('price-change', '等待自動重新連線...');
            ['open-price', 'high-price', 'low-price', 'previous-close', 'volume'].forEach(id => setText(id, '—')); renderExtendedSessionQuote(null);
            updateMarketState('', symbol);
            setText('last-update', '資料連線延遲，系統將自動重試');
        }
        setText('feed-status', 'Data feed delayed');
    } finally {
        if (isCurrentRequest()) {
            isLoadingStock = false;
            if (!isSilent) { const loadingBadge = document.getElementById('loading-badge'); if (loadingBadge) loadingBadge.classList.add('hidden'); }
        }
    }

    if (!isSilent && isCurrentRequest() && window.innerWidth < 768) {
        const sidebar = document.getElementById('sidebar'), overlay = document.getElementById('overlay');
        if (sidebar) sidebar.classList.remove('open'); if (overlay) overlay.classList.remove('show');
    }

    if (isCurrentRequest()) restartAutoRefresh();
}

async function refreshCurrentStock() {
    if (!currentSymbol) return;
    const symbol = currentSymbol;
    const button = document.getElementById('refresh-stock-btn');
    button?.classList.add('is-refreshing');
    try {
        await Promise.all([loadStock(symbol), fetchMarketIndices()]);
    } finally {
        button?.classList.remove('is-refreshing');
    }
}

function startAutoRefresh() {
    stopAutoRefresh(); if (!currentSymbol) return;
    const refreshInterval = currentPeriod.interval === '1m'
        ? Math.min(Math.max(AUTO_REFRESH_INTERVAL, 3_000), 5_000)
        : Math.max(AUTO_REFRESH_INTERVAL, 3_000);
    autoRefreshTimer = setInterval(() => {
        if (!document.hidden) {
            Promise.all([currentSymbol ? loadStock(currentSymbol, true) : Promise.resolve(), fetchMarketIndices()]);
        }
    }, refreshInterval);
}
function stopAutoRefresh() { if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; } }
function restartAutoRefresh() { stopAutoRefresh(); if (currentSymbol) startAutoRefresh(); }

// ============================================================
// 6. 微型選單控制
// ============================================================
function togglePeriodMenu() { closeAllMiniMenusExcept('period-picker'); document.getElementById('period-picker')?.classList.toggle('open'); }
function toggleMainMenu() { closeAllMiniMenusExcept('main-indicator-picker'); document.getElementById('main-indicator-picker')?.classList.toggle('open'); }
function toggleSubMenu() { closeAllMiniMenusExcept('sub-indicator-picker'); document.getElementById('sub-indicator-picker')?.classList.toggle('open'); }

function closeAllMiniMenusExcept(exceptId) {
    ['period-picker', 'main-indicator-picker', 'sub-indicator-picker'].forEach(id => {
        if (id !== exceptId) document.getElementById(id)?.classList.remove('open');
    });
}

function closeAllMiniMenus() {
    document.querySelectorAll('.period-picker, #main-indicator-picker, #sub-indicator-picker').forEach(el => el.classList.remove('open'));
}

async function selectPeriodOption(value, label) {
    const [interval, range] = value.split('|');
    currentPeriod = { interval, range, label };
    if (interval !== '1m') currentTradingSession = 'all';
    persistChartPreferences();
    updateTradingSessionControl();
    setText('period-label', chartDisplayMode === 'line' ? label.replace(/K$/, '線') : label);
    
    syncPeriodSelection();
    
    closeAllMiniMenus();
    if (currentSymbol) await loadStock(currentSymbol);
}

function toggleMainOption(type) {
    mainIndicatorsState[type] = !mainIndicatorsState[type];
    
    const optMa = document.getElementById('main-opt-ma');
    const optBB = document.getElementById('main-opt-bollinger');
    if (optMa) optMa.setAttribute('aria-selected', String(mainIndicatorsState.ma));
    if (optBB) optBB.setAttribute('aria-selected', String(mainIndicatorsState.bollinger));

    const activeList = [];
    if (mainIndicatorsState.ma) activeList.push('MA');
    if (mainIndicatorsState.bollinger) activeList.push('BB');
    setText('main-indicator-label', activeList.length > 0 ? activeList.join('+') : '無');

    const hudMaRow = document.getElementById('hud-ma-row');
    const hideForIntradayLine = chartDisplayMode === 'line' && currentPeriod.interval === '1m';
    if (hudMaRow) hudMaRow.style.display = mainIndicatorsState.ma && !hideForIntradayLine ? 'flex' : 'none';

    updateChartIndicators(currentChartData);
}

function toggleSubOption(type) {
    subIndicatorsState[type] = !subIndicatorsState[type];

    const opt = document.getElementById(`sub-opt-${type}`);
    if (opt) opt.setAttribute('aria-selected', String(subIndicatorsState[type]));

    const activeList = Object.keys(subIndicatorsState).filter(k => subIndicatorsState[k]);
    setText('sub-indicator-label', activeList.length > 0 ? activeList.map(k => k.toUpperCase()).join('+') : '無');

    updateVisibleSubPanes();
    updateChartIndicators(currentChartData);
}

function resetChartView() {
    getAllActiveCharts().forEach(c => c.timeScale().fitContent());
}

async function toggleChartFullscreen() {
    const card = document.getElementById('chart-card');
    if (!card) return;
    if (!document.fullscreenElement) await card.requestFullscreen?.();
    else await document.exitFullscreen?.();
    setTimeout(() => resetChartView(), 120);
}

function setupChartResize() {
    const handleResize = () => {
        const width = document.getElementById('panes-wrapper')?.clientWidth || 0;
        if (width <= 0) return;
        getAllActiveCharts().forEach(c => c.applyOptions({ width }));
    };
    window.addEventListener('resize', handleResize);
    setTimeout(handleResize, 100);
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar'), overlay = document.getElementById('overlay');
    if (!sidebar) return;
    const isOpen = sidebar.classList.toggle('open');
    if (overlay) overlay.classList.toggle('show', isOpen);
}

function applySidebarCompact() {
    const sidebar = document.getElementById('sidebar');
    const button = document.getElementById('sidebar-collapse-btn');
    if (!sidebar) return;
    const canCompact = window.innerWidth >= 768;
    sidebar.classList.toggle('compact', canCompact && sidebarCompact);
    if (button) {
        button.setAttribute('aria-expanded', String(!(canCompact && sidebarCompact)));
        button.setAttribute('aria-label', canCompact && sidebarCompact ? '展開側邊欄' : '收合側邊欄');
        button.title = canCompact && sidebarCompact ? '展開側邊欄' : '收合側邊欄';
    }
}

function toggleSidebarCompact() {
    sidebarCompact = !sidebarCompact;
    localStorage.setItem('stockSidebarCompact', String(sidebarCompact));
    applySidebarCompact();
    window.setTimeout(() => window.dispatchEvent(new Event('resize')), 280);
}

function setupIndexStripScroll() {
    const scroller = document.querySelector('main > .flex-1.overflow-y-auto'), strip = document.querySelector('.index-strip');
    if (!scroller || !strip) return;
    let scrollTimer = null;
    scroller.addEventListener('scroll', () => {
        strip.classList.toggle('is-scrolling', scroller.scrollTop > 8);
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => strip.classList.remove('is-scrolling'), 700);
    }, { passive: true });
}

// ============================================================
// 7. 日夜模式與偏好設定
// ============================================================
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

    const scaleBorderColor = isDarkMode ? 'rgba(148,184,174,0.13)' : 'rgba(45,82,71,0.13)';
    const textColor = isDarkMode ? '#789088' : '#536c64';
    const gridColor = isDarkMode ? 'rgba(148,184,174,0.055)' : 'rgba(45,82,71,0.055)';

    getAllActiveCharts().forEach(c => {
        c.applyOptions({
            layout: { textColor: textColor, background: { type: 'solid', color: 'transparent' } },
            grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
            timeScale: { borderColor: scaleBorderColor },
            rightPriceScale: { borderColor: scaleBorderColor }
        });
    });
}

function loadUserPreferences() {
    const savedColorMode = getColorMode();
    const savedRefreshRate = localStorage.getItem('stockRefreshRate') || '10000';

    const colorSelect = document.getElementById('kline-color'), refreshSelect = document.getElementById('refresh-rate');
    if (colorSelect) { colorSelect.value = savedColorMode; colorSelect.onchange = applySettings; }
    if (refreshSelect) { refreshSelect.value = savedRefreshRate; refreshSelect.onchange = applySettings; }

    applyDarkModeUI();
    updateChartColors(savedColorMode);
    AUTO_REFRESH_INTERVAL = Math.max(Number(savedRefreshRate) || 10000, 3000);
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

function updateChartColors(mode, refreshViews = true) {
    const useInternational = usesInternationalColors(currentSymbol, mode);
    if (candlestickSeries) {
        if (useInternational) {
            candlestickSeries.applyOptions({ borderVisible: true, upColor: '#10b981', downColor: '#ef4444', borderUpColor: '#10b981', borderDownColor: '#ef4444', wickUpColor: '#10b981', wickDownColor: '#ef4444' });
        } else {
            candlestickSeries.applyOptions({ borderVisible: true, upColor: '#ef4444', downColor: '#10b981', borderUpColor: '#ef4444', borderDownColor: '#10b981', wickUpColor: '#ef4444', wickDownColor: '#10b981' });
        }
    }

    if (refreshViews) {
        renderWatchlist();
        fetchMarketIndices();
    }
}

// ============================================================
// 8. Modal 控制
// ============================================================
function toggleModal(modalId, show) {
    const overlay = document.getElementById('modal-overlay'), modal = document.getElementById(modalId);
    if (!overlay || !modal) return;
    if (show) {
        overlay.classList.remove('modal-closing');
        if (window.innerWidth < 768) { const sidebar = document.getElementById('sidebar'); if (sidebar) sidebar.classList.remove('open'); }
        overlay.classList.remove('hidden'); modal.classList.remove('hidden');
        setTimeout(() => { overlay.classList.remove('opacity-0'); modal.classList.remove('opacity-0', 'scale-95'); }, 10);
    } else {
        overlay.classList.add('modal-closing');
        overlay.classList.add('opacity-0'); modal.classList.add('opacity-0', 'scale-95');
        setTimeout(() => { overlay.classList.add('hidden'); modal.classList.add('hidden'); }, 300);
    }
}
function openSettingsModal() { toggleModal('settings-modal', true); }
function openProfileModal() { toggleModal('profile-modal', true); }
function closeModals() { toggleModal('settings-modal', false); toggleModal('profile-modal', false); }

// ============================================================
// 9. 全域 API 掛載與啟動入口 (完美修正初始化與記憶股票)
// ============================================================
window.loadStock = loadStock;
window.addStock = addStock;
window.removeStock = removeStock;
window.removeStockBySymbol = removeStockBySymbol;
window.changeSort = changeSort;
window.toggleSortMenu = toggleSortMenu;
window.selectSortOption = selectSortOption;
window.togglePeriodMenu = togglePeriodMenu;
window.toggleMainMenu = toggleMainMenu;
window.toggleSubMenu = toggleSubMenu;
window.selectPeriodOption = selectPeriodOption;
window.selectTradingSession = selectTradingSession;
window.setChartDisplayMode = setChartDisplayMode;
window.toggleMainOption = toggleMainOption;
window.toggleSubOption = toggleSubOption;
window.toggleSidebar = toggleSidebar;
window.toggleSidebarCompact = toggleSidebarCompact;
window.openSettingsModal = openSettingsModal;
window.openProfileModal = openProfileModal;
window.closeModals = closeModals;
window.applySettings = applySettings;
window.toggleDarkMode = toggleDarkMode;
window.jumpToSection = jumpToSection;
window.resetChartView = resetChartView;
window.toggleChartFullscreen = toggleChartFullscreen;
window.switchChipTab = switchChipTab;
window.getAllActiveCharts = getAllActiveCharts;
window.refreshCurrentStock = refreshCurrentStock;

document.addEventListener('click', event => {
    if (!event.target.closest('.period-picker, #main-indicator-picker, #sub-indicator-picker')) {
        closeAllMiniMenus();
    }
    const sortPicker = document.getElementById('sort-picker');
    if (sortPicker && !sortPicker.contains(event.target)) {
        sortPicker.classList.remove('open');
        document.getElementById('sort-trigger')?.setAttribute('aria-expanded', 'false');
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAutoRefresh();
    else if (currentSymbol) { loadStock(currentSymbol, true); fetchMarketIndices(); startAutoRefresh(); }
});

window.addEventListener('keydown', event => { if (event.key === 'Escape') closeModals(); });
window.addEventListener('beforeunload', () => saveWorkspaceScroll());

window.addEventListener('DOMContentLoaded', async () => {
    if (currentTradingSession !== 'all') {
        currentPeriod = { interval: '1m', range: '1d', label: '1分K' };
        chartDisplayMode = 'line';
        localStorage.setItem('stockChartDisplayMode', 'line');
    }
    applySidebarCompact();
    initChart();
    syncPeriodSelection();
    updateTradingSessionControl();
    setupIndexStripScroll();
    setupWorkspaceTabs();
    changeSort(sortMode);
    loadUserPreferences(); 
    renderWatchlist(); 
    applyWorkspaceView(currentWorkspaceView);
    switchChipTab(currentChipTab);

    const workspaceScroller = document.querySelector('.workspace-scroll');
    workspaceScroller?.addEventListener('scroll', () => {
        if (workspaceScrollSaveFrame !== null) return;
        workspaceScrollSaveFrame = requestAnimationFrame(() => {
            workspaceScrollSaveFrame = null;
            saveWorkspaceScroll();
        });
    }, { passive: true });

    // 取得 localStorage 的最後瀏覽股票，確保重新整理後不會跳掉
    const savedSymbol = localStorage.getItem('stockCurrentSymbol');
    if (savedSymbol && watchlist.some(stock => stock.symbol === savedSymbol)) {
        currentSymbol = savedSymbol;
    } else if (!currentSymbol || !watchlist.some(stock => stock.symbol === currentSymbol)) {
        currentSymbol = watchlist[0]?.symbol || null;
        if (currentSymbol) persistCurrentSymbol(currentSymbol);
    }
    
    // 載入大盤摘要；公告會跟隨目前商品的新聞請求一起更新
    void fetchMarketIndices();
    
    for (const stock of watchlist) {
        if (isTaiwanSymbol(stock.symbol)) {
            const code = displaySymbol(stock.symbol);
            if (stock.name === code || !stock.name || /^\d+$/.test(stock.name)) {
                try {
                    const fetchedName = await fetchTwseName(code); 
                    if (fetchedName) stock.name = fetchedName;
                } catch {}
            }
        }
    }
    saveWatchlist(); 
    renderWatchlist();

    if (currentSymbol) {
        await loadStock(currentSymbol);
    }
    window.setTimeout(() => restoreWorkspaceScroll(currentWorkspaceView), 80);
    startAutoRefresh();
});

window.addEventListener('resize', applySidebarCompact);
