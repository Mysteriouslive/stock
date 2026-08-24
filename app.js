const WORKER_URL = 'https://stock-proxy.stu-108042.workers.dev';

let AUTO_REFRESH_INTERVAL = Number(localStorage.getItem('stockRefreshRate')) || 10000;

// ============================================================
// 全域狀態變數宣告
// ============================================================
let mainChart = null, volChart = null, kdChart = null, rsiChart = null, macdChart = null;
let candlestickSeries = null, ma5Series = null, ma20Series = null, ma60Series = null, upperBandSeries = null, lowerBandSeries = null;
let volSeries = null;
let kdSeriesK = null, kdSeriesD = null;
let rsiSeries = null;
let macdHistSeries = null, macdLineSeries = null, macdSignalSeries = null;
let sessionMarkers = null, currentChartData = [], isSyncingTimeScale = false;
let autoRefreshTimer = null, isLoadingStock = false;
let chartAtRightEdge = true;

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
let currentPeriod = { interval: '1d', range: '6mo', label: '日K' };

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

let currentChipTab = 'flow';
let cachedChipHistory = [];
let cachedChipLatest = null;
let isDarkMode = localStorage.getItem('stockThemeMode') !== 'light';
let sortableInstance = null;

// ============================================================
// 取得所有啟用的 Chart
// ============================================================
function getAllActiveCharts() {
    const list = [mainChart, volChart];
    if (subIndicatorsState.kd && kdChart) list.push(kdChart);
    if (subIndicatorsState.rsi && rsiChart) list.push(rsiChart);
    if (subIndicatorsState.macd && macdChart) list.push(macdChart);
    return list.filter(Boolean);
}

// ============================================================
// Symbol 工具
// ============================================================
function isIndexSymbol(symbol) { return String(symbol || '').trim().toUpperCase().startsWith('^'); }
function isForexSymbol(symbol) { const s = String(symbol || '').toUpperCase().trim(); return s === 'USDTWD' || s === 'USD/TWD' || s === 'USDTWD=X'; }
function isCryptoSymbol(symbol) { const s = String(symbol || '').toUpperCase().replace('-USD', '').trim(); return ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'BNB'].includes(s); }
function isTaiwanSymbol(symbol) { const s = String(symbol || '').toUpperCase().trim(); return /^\d{4,6}(\.(TW|TWO))?$/i.test(s) || s.startsWith('^TW'); }

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

// ============================================================
// 資料格式化工具
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

// ============================================================
// Watchlist 與 排序功能 (提前定義)
// ============================================================
function saveWatchlist() {
    localStorage.setItem('stockWatchlist', JSON.stringify(watchlist));
    localStorage.setItem('stockSortMode', sortMode);
    localStorage.setItem('stockQuoteCache', JSON.stringify(quoteCache));
    if (currentSymbol) localStorage.setItem('stockCurrentSymbol', currentSymbol);
}

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
                if (sortMode !== 'manual' || evt.oldIndex == null || evt.newIndex == null) return;
                const order = [...listEl.children].map(item => item.dataset.symbol).filter(Boolean);
                const reordered = order.map(symbol => watchlist.find(stock => stock.symbol === symbol)).filter(Boolean);
                if (reordered.length !== watchlist.length) return;
                watchlist = reordered;
                saveWatchlist();
            }
        });
    } else if (sortableInstance) {
        sortableInstance.option('disabled', sortMode !== 'manual');
    }
}

const SORT_LABELS = { manual: '自訂順序', 'symbol-asc': '代碼 ↑', 'symbol-desc': '代碼 ↓', 'name-asc': '名稱 ↑', 'name-desc': '名稱 ↓', 'price-desc': '價格 ↓', 'price-asc': '價格 ↑', 'change-desc': '漲幅 ↓', 'change-asc': '漲幅 ↑' };

function changeSort(value) {
    sortMode = value; saveWatchlist(); renderWatchlist();
    const select = document.getElementById('sort-select'), label = document.getElementById('sort-label');
    if (select) select.value = value;
    if (label) label.textContent = SORT_LABELS[value] || SORT_LABELS.manual;
    document.querySelectorAll('#sort-menu [role="option"]').forEach(option => option.setAttribute('aria-selected', option.dataset.sortValue === value ? 'true' : 'false'));
}

function toggleSortMenu() {
    const picker = document.getElementById('sort-picker'), trigger = document.getElementById('sort-trigger');
    if (!picker || !trigger) return;
    const open = picker.classList.toggle('open'); trigger.setAttribute('aria-expanded', String(open));
}

function selectSortOption(value) { changeSort(value); toggleSortMenu(); }

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
            setChipVisibility(false);
            resetFundamentals();
        }
    }
}

// ============================================================
// 獨立多 Panes 實例系統
// ============================================================
function createBaseChart(container) {
    const isMobile = window.innerWidth < 768;
    const gridColor = isDarkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)';
    const scaleBorderColor = isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    const textColor = isDarkMode ? '#9ca3af' : '#52525b';

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

    // 1. 初始化各獨立圖表實例
    mainChart = createBaseChart(mainEl);
    volChart = createBaseChart(volEl);
    
    volChart.priceScale('right').applyOptions({
        scaleMargins: { top: 0.05, bottom: 0.02 }
    });

    kdChart = createBaseChart(kdEl);
    rsiChart = createBaseChart(rsiEl);
    macdChart = createBaseChart(macdEl);

    // 2. 主圖 Series
    candlestickSeries = mainChart.addCandlestickSeries({
        upColor: '#ef4444', downColor: '#10b981', borderVisible: true,
        borderUpColor: '#ef4444', borderDownColor: '#10b981', wickUpColor: '#ef4444', wickDownColor: '#10b981'
    });
    ma5Series = mainChart.addLineSeries({ color: '#fb7185', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    ma20Series = mainChart.addLineSeries({ color: '#f59e0b', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    ma60Series = mainChart.addLineSeries({ color: '#38bdf8', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    upperBandSeries = mainChart.addLineSeries({ color: 'rgba(168,85,247,0.7)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    lowerBandSeries = mainChart.addLineSeries({ color: 'rgba(168,85,247,0.7)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

    // 3. 成交量 Series
    volSeries = volChart.addHistogramSeries({ priceFormat: { type: 'volume' } });

    // 4. KD Series
    kdSeriesK = kdChart.addLineSeries({ color: '#38bdf8', lineWidth: 1.5, priceLineVisible: false });
    kdSeriesD = kdChart.addLineSeries({ color: '#f87171', lineWidth: 1.5, priceLineVisible: false });

    // 5. RSI Series
    rsiSeries = rsiChart.addLineSeries({ color: '#c084fc', lineWidth: 1.5, priceLineVisible: false });

    // 6. MACD Series
    macdHistSeries = macdChart.addHistogramSeries({ priceLineVisible: false });
    macdLineSeries = macdChart.addLineSeries({ color: '#38bdf8', lineWidth: 1.5, priceLineVisible: false });
    macdSignalSeries = macdChart.addLineSeries({ color: '#f87171', lineWidth: 1.5, priceLineVisible: false });

    // 7. 多圖時間軸毫秒級雙向同步
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

    // 8. 準心 HUD 同步監聽
    allCharts.forEach(c => c.subscribeCrosshairMove(updateCrosshairHUD));

    setupChartResize();
    setupChartKeyboard();
    updateVisibleSubPanes();
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

// 指標計算
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

function updateChartIndicators(data) {
    if (!data.length) return;
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
// Load Stock 主流程
// ============================================================
async function loadStock(symbol, isSilent = false) {
    if (!symbol || (isLoadingStock && !isSilent)) return;
    currentSymbol = symbol; saveWatchlist();

    const isTw = isTaiwanSymbol(symbol);

    if (!isSilent) {
        document.querySelectorAll('.stock-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.symbol === symbol));
        const stockItem = watchlist.find(s => s.symbol === symbol);
        const finalDisplayName = SPECIAL_NAME_MAP[symbol] || stockItem?.name || displaySymbol(symbol);
        setText('stock-symbol-title', finalDisplayName); 
        setText('stock-name', displaySymbol(symbol));
        setText('hud-stock-title', `${displaySymbol(symbol)} ${stockItem?.name || ''}`);
        
        const loadingBadge = document.getElementById('loading-badge'); if (loadingBadge) loadingBadge.classList.remove('hidden');
        ['current-price', 'price-change', 'open-price', 'high-price', 'low-price', 'previous-close', 'volume'].forEach(id => setText(id, '—')); updateMarketState('', symbol);
        const priceChange = document.getElementById('price-change'); if (priceChange) priceChange.className = 'text-sm sm:text-base font-bold px-2.5 py-1 rounded-lg bg-white/5 border border-white/5';
        const currentPrice = document.getElementById('current-price'); if (currentPrice) currentPrice.className = 'text-3xl sm:text-4xl font-black text-white tracking-tight leading-none transition-colors duration-300';
        resetFundamentals();
        
        setChipVisibility(isTw);
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

        if (isTw) {
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
                const [chipData, chipHistory] = await Promise.all([
                    fetchTwseChipData(symbol),
                    fetchTwseChipHistory(symbol)
                ]);
                renderChipData(chipData, chipHistory);
            }
        } else {
            if (isForexSymbol(symbol)) {
                try {
                    const forex = await fetchForexData();
                    if (forex?.rate) {
                        const prevClose = yahooResult?.meta?.regularMarketPreviousClose ?? yahooResult?.meta?.previousClose ?? yahooResult?.meta?.chartPreviousClose;
                        quote = applyCurrentPriceToQuote(quote, forex.rate, prevClose, symbol, forex.changePercent);
                        if (!isSilent) renderCompanyInfo(yahooResult, symbol, quote, yahooResult ? 'Frankfurter 現價 + Yahoo Finance K線' : 'Frankfurter');
                    }
                } catch {}
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
        }

        if (!quote && quoteCache[symbol]) quote = quoteCache[symbol];
        if (!quote) throw (yahooError || new Error('NO_QUOTE_DATA'));

        quoteCache[symbol] = quote; saveWatchlist();

        setText('current-price', quote.latestPrice); setText('open-price', quote.open); setText('high-price', quote.high); setText('low-price', quote.low); setText('previous-close', quote.previousClose); setText('volume', quote.volume); updateMarketState(yahooResult?.meta?.marketState, symbol);

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
            updateChartIndicators(chartData); 
            updateSessionMarkers(chartData);

            if (!isSilent || chartAtRightEdge) {
                chartAtRightEdge = true;
                getAllActiveCharts().forEach(c => {
                    try { c.timeScale().scrollToRealTime(); } catch {}
                });
            }
        }

        const now = new Date(); setText('last-update', `最後更新：${now.toLocaleString('zh-TW', { hour12: false })}`); renderWatchlist();

    } catch (error) {
        console.error('loadStock error:', error);
        if (!isSilent) {
            setText('stock-name', `找不到 ${displaySymbol(symbol)} 的資料，請確認代碼`); setText('price-change', '載入失敗');
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

// ============================================================
// 微型選單控制
// ============================================================
function togglePeriodMenu() { closeAllMiniMenusExcept('period-picker'); document.getElementById('period-picker')?.classList.toggle('open'); }
function toggleRangeMenu() { closeAllMiniMenusExcept('range-picker'); document.getElementById('range-picker')?.classList.toggle('open'); }
function toggleMainMenu() { closeAllMiniMenusExcept('main-indicator-picker'); document.getElementById('main-indicator-picker')?.classList.toggle('open'); }
function toggleSubMenu() { closeAllMiniMenusExcept('sub-indicator-picker'); document.getElementById('sub-indicator-picker')?.classList.toggle('open'); }

function closeAllMiniMenusExcept(exceptId) {
    ['period-picker', 'range-picker', 'main-indicator-picker', 'sub-indicator-picker'].forEach(id => {
        if (id !== exceptId) document.getElementById(id)?.classList.remove('open');
    });
}

function closeAllMiniMenus() {
    document.querySelectorAll('.period-picker, .range-picker, #main-indicator-picker, #sub-indicator-picker').forEach(el => el.classList.remove('open'));
}

document.addEventListener('click', event => {
    if (!event.target.closest('.period-picker, .range-picker, #main-indicator-picker, #sub-indicator-picker')) {
        closeAllMiniMenus();
    }
});

async function selectPeriodOption(value, label) {
    const [interval, range] = value.split('|');
    currentPeriod = { interval, range, label };
    setText('period-label', label);
    
    document.querySelectorAll('#period-menu [role="option"]').forEach(btn => {
        btn.setAttribute('aria-selected', btn.dataset.period === value ? 'true' : 'false');
    });
    
    closeAllMiniMenus();
    if (currentSymbol) await loadStock(currentSymbol);
}

async function setChartRange(range, label) {
    currentPeriod.range = range;
    setText('range-label', label);
    
    document.querySelectorAll('#range-menu [role="option"]').forEach(btn => {
        btn.setAttribute('aria-selected', btn.dataset.range === range ? 'true' : 'false');
    });

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
    if (hudMaRow) hudMaRow.style.display = mainIndicatorsState.ma ? 'flex' : 'none';

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
    if (sidebar) sidebar.classList.toggle('open'); if (overlay) overlay.classList.toggle('show');
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
// 日夜模式 (Dark / Light Mode)
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

    const scaleBorderColor = isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    const textColor = isDarkMode ? '#9ca3af' : '#52525b';
    const gridColor = isDarkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)';

    getAllActiveCharts().forEach(c => {
        c.applyOptions({
            layout: { textColor: textColor, background: { type: 'solid', color: 'transparent' } },
            grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
            timeScale: { borderColor: scaleBorderColor },
            rightPriceScale: { borderColor: scaleBorderColor }
        });
    });
}

// ============================================================
// 初始化與事件綁定
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
    initChart();
    setupIndexStripScroll();
    changeSort(sortMode);
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
window.addEventListener('keydown', event => { if (event.key === 'Escape') closeModals(); });

// ============================================================
// 主題色與偏好設定
// ============================================================
function loadUserPreferences() {
    const savedColorMode = localStorage.getItem('stockKlineColor') || 'red-green';
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

function updateChartColors(mode) {
    if (candlestickSeries) {
        if (mode === 'green-red') {
            candlestickSeries.applyOptions({ borderVisible: true, upColor: '#10b981', downColor: '#ef4444', borderUpColor: '#10b981', borderDownColor: '#ef4444', wickUpColor: '#10b981', wickDownColor: '#ef4444' });
        } else {
            candlestickSeries.applyOptions({ borderVisible: true, upColor: '#ef4444', downColor: '#10b981', borderUpColor: '#ef4444', borderDownColor: '#10b981', wickUpColor: '#ef4444', wickDownColor: '#10b981' });
        }
    }

    renderWatchlist();
    fetchMarketIndices();
}

// ============================================================
// 全域導出 API (頂部全域綁定)
// ============================================================
window.loadStock = loadStock;
window.addStock = addStock;
window.removeStock = removeStock;
window.removeStockBySymbol = removeStockBySymbol;
window.changeSort = changeSort;
window.toggleSortMenu = toggleSortMenu;
window.selectSortOption = selectSortOption;
window.togglePeriodMenu = togglePeriodMenu;
window.toggleRangeMenu = toggleRangeMenu;
window.toggleMainMenu = toggleMainMenu;
window.toggleSubMenu = toggleSubMenu;
window.selectPeriodOption = selectPeriodOption;
window.setChartRange = setChartRange;
window.toggleMainOption = toggleMainOption;
window.toggleSubOption = toggleSubOption;
window.toggleSidebar = toggleSidebar;
window.openSettingsModal = openSettingsModal;
window.openProfileModal = openProfileModal;
window.closeModals = closeModals;
window.toggleCompanyInfo = toggleCompanyInfo;
window.applySettings = applySettings;
window.toggleDarkMode = toggleDarkMode;
window.jumpToSection = jumpToSection;
window.resetChartView = resetChartView;
window.toggleChartFullscreen = toggleChartFullscreen;
window.switchChipTab = switchChipTab;
window.getAllActiveCharts = getAllActiveCharts;