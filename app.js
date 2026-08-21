/*
========================================
股票觀測站 v5
========================================

如果你部署了自己的 Cloudflare Worker：

請修改下面這一行。

例如：

const WORKER_URL =
  "https://your-worker.workers.dev";

========================================
*/

const WORKER_URL =
  "https://stock-proxy.stu-108042.workers.dev";


/* ======================================
   SETTINGS
====================================== */

let AUTO_REFRESH_INTERVAL =
  Number(
    localStorage.getItem("stockRefreshRate") ||
    10000
  );


/* ======================================
   WATCHLIST
====================================== */

let watchlist =
  JSON.parse(
    localStorage.getItem("stockWatchlistV5") ||
    "null"
  ) ||
  [
    {
      symbol: "2330.TW",
      name: "台積電"
    },
    {
      symbol: "2454.TW",
      name: "聯發科"
    },
    {
      symbol: "AAPL",
      name: "Apple"
    },
    {
      symbol: "NVDA",
      name: "NVIDIA"
    }
  ];


let currentSymbol =
  localStorage.getItem(
    "stockCurrentSymbolV5"
  ) ||
  watchlist[0]?.symbol ||
  null;


let sortMode =
  localStorage.getItem(
    "stockSortV5"
  ) ||
  "manual";


let alerts =
  JSON.parse(
    localStorage.getItem(
      "stockAlertsV5"
    ) ||
    "[]"
  );


let quoteCache = {};

let autoRefreshTimer = null;


/* ======================================
   CHART
====================================== */

let currentPeriod = {
  interval: "5m",
  range: "5d",
  label: "5分"
};


let chart = null;

let candleSeries = null;

let ma5Series = null;

let ma20Series = null;

let ma60Series = null;


/* ======================================
   SYMBOL HELPERS
====================================== */

function isForexSymbol(symbol) {

  return [
    "USDTWD",
    "USD/TWD",
    "USDTWD=X"
  ].includes(
    symbol.toUpperCase()
  );

}


function isCryptoSymbol(symbol) {

  return [
    "BTC",
    "ETH",
    "SOL",
    "XRP",
    "ADA",
    "DOGE",
    "BNB"
  ].includes(
    symbol
      .toUpperCase()
      .replace("-USD", "")
  );

}


function isTaiwanSymbol(symbol) {

  return /^\d{4,6}(\.TW|\.TWO)?$/i.test(
    symbol
  );

}


function displaySymbol(symbol) {

  return String(symbol)
    .replace(
      /\.(TW|TWO)$/i,
      ""
    )
    .replace(
      /=X$/i,
      ""
    )
    .replace(
      /-USD$/i,
      ""
    );

}


function toYahooSymbol(symbol) {

  symbol =
    symbol
      .trim()
      .toUpperCase();


  if (
    isForexSymbol(symbol)
  ) {

    return "USDTWD=X";

  }


  if (
    isCryptoSymbol(symbol)
  ) {

    return (
      symbol
        .replace("-USD", "") +
      "-USD"
    );

  }


  if (
    /^\d{4,6}\.(TW|TWO)$/i.test(
      symbol
    )
  ) {

    return symbol;

  }


  if (
    /^\d{4,6}$/.test(symbol)
  ) {

    return `${symbol}.TW`;

  }


  return symbol;
}


/* ======================================
   API
====================================== */

async function api(url) {

  const response =
    await fetch(
      url,
      {
        cache: "no-store"
      }
    );


  if (!response.ok) {

    throw new Error(
      `HTTP_${response.status}`
    );

  }


  return response.json();
}


async function worker(
  source,
  params = {}
) {

  const query =
    new URLSearchParams({
      source,
      ...params
    });


  return api(
    `${WORKER_URL}/?${query}`
  );
}


async function yahoo(symbol) {

  return worker(
    "",
    {
      symbol:
        toYahooSymbol(symbol),

      interval:
        currentPeriod.interval,

      range:
        currentPeriod.range
    }
  );
}


/* ======================================
   UTILITIES
====================================== */

function esc(value) {

  return String(
    value ?? ""
  ).replace(
    /[&<>"']/g,
    match => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[match])
  );

}


function set(
  id,
  value
) {

  const element =
    document.getElementById(id);

  if (element) {

    element.textContent =
      value ?? "—";

  }

}


function fmt(value) {

  if (
    value == null ||
    !Number.isFinite(
      Number(value)
    )
  ) {

    return "—";

  }


  return Number(value)
    .toLocaleString(
      "en-US",
      {
        maximumFractionDigits: 4
      }
    );

}


function pct(value) {

  if (
    value == null ||
    !Number.isFinite(
      Number(value)
    )
  ) {

    return "—";

  }


  return `${Number(value).toFixed(2)}%`;

}


function vol(value) {

  if (
    value == null ||
    !Number.isFinite(
      Number(value)
    )
  ) {

    return "—";

  }


  value =
    Number(value);


  if (value >= 1e8) {

    return (
      (value / 1e8).toFixed(2) +
      "億"
    );

  }


  if (value >= 1e4) {

    return (
      (value / 1e4).toFixed(2) +
      "萬"
    );

  }


  return value.toLocaleString();

}


/* ======================================
   TECHNICAL INDICATORS
====================================== */

function sma(
  values,
  period
) {

  return values.map(
    (_, index) => {

      if (
        index <
        period - 1
      ) {

        return null;

      }


      return values
        .slice(
          index - period + 1,
          index + 1
        )
        .reduce(
          (sum, value) =>
            sum + value,
          0
        ) / period;

    }
  );

}


function ema(
  values,
  period
) {

  const result =
    Array(values.length)
      .fill(null);


  let previous = null;

  const multiplier =
    2 / (period + 1);


  values.forEach(
    (value, index) => {

      if (
        index ===
        period - 1
      ) {

        previous =
          values
            .slice(
              0,
              period
            )
            .reduce(
              (a, b) =>
                a + b,
              0
            ) /
          period;

        result[index] =
          previous;

      }
      else if (
        index >= period
      ) {

        previous =
          value *
            multiplier +
          previous *
            (1 - multiplier);

        result[index] =
          previous;

      }

    }
  );


  return result;
}


function RSI(
  values,
  period = 14
) {

  const result =
    Array(values.length)
      .fill(null);


  if (
    values.length <= period
  ) {

    return result;

  }


  let gain = 0;

  let loss = 0;


  for (
    let i = 1;
    i <= period;
    i++
  ) {

    const difference =
      values[i] -
      values[i - 1];


    gain +=
      Math.max(
        difference,
        0
      );


    loss +=
      Math.max(
        -difference,
        0
      );

  }


  let averageGain =
    gain / period;

  let averageLoss =
    loss / period;


  result[period] =
    averageLoss
      ? 100 -
        100 /
          (
            1 +
            averageGain /
              averageLoss
          )
      : 100;


  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const difference =
      values[i] -
      values[i - 1];


    averageGain =
      (
        averageGain *
          (period - 1) +
        Math.max(
          difference,
          0
        )
      ) / period;


    averageLoss =
      (
        averageLoss *
          (period - 1) +
        Math.max(
          -difference,
          0
        )
      ) / period;


    result[i] =
      averageLoss
        ? 100 -
          100 /
            (
              1 +
              averageGain /
                averageLoss
            )
        : 100;

  }


  return result;
}


function MACD(values) {

  const fast =
    ema(
      values,
      12
    );


  const slow =
    ema(
      values,
      26
    );


  const macd =
    values.map(
      (_, index) => {

        if (
          fast[index] == null ||
          slow[index] == null
        ) {

          return null;

        }


        return (
          fast[index] -
          slow[index]
        );

      }
    );


  const signal =
    ema(
      macd.map(
        value =>
          value ?? 0
      ),
      9
    );


  return {
    macd,
    signal
  };

}


/* ======================================
   YAHOO DATA
====================================== */

function quoteFrom(result) {

  const meta =
    result.meta || {};


  const quote =
    result
      .indicators
      ?.quote?.[0] ||
    {};


  let index =
    (
      quote.close ||
      []
    ).length - 1;


  while (
    index >= 0 &&
    quote.close?.[index] == null
  ) {

    index--;

  }


  const price =
    Number(
      meta.regularMarketPrice ??
      quote.close?.[index]
    );


  const previous =
    Number(
      meta.regularMarketPreviousClose ??
      meta.previousClose ??
      meta.chartPreviousClose
    );


  return {

    price,

    previous,

    change:
      price - previous,

    changePercent:
      previous
        ? (
            (price - previous) /
            previous
          ) *
          100
        : 0,

    open:
      meta.regularMarketOpen ??
      quote.open?.[index],

    high:
      meta.regularMarketDayHigh ??
      quote.high?.[index],

    low:
      meta.regularMarketDayLow ??
      quote.low?.[index],

    volume:
      meta.regularMarketVolume ??
      quote.volume?.[index],

    marketState:
      meta.marketState

  };

}


function candlesFrom(result) {

  const timestamps =
    result.timestamp ||
    [];


  const quote =
    result
      .indicators
      ?.quote?.[0] ||
    {};


  const candles = [];


  for (
    let index = 0;
    index < timestamps.length;
    index++
  ) {

    if (
      [
        quote.open?.[index],
        quote.high?.[index],
        quote.low?.[index],
        quote.close?.[index]
      ].some(
        value => value == null
      )
    ) {

      continue;

    }


    candles.push({

      time:
        currentPeriod.interval ===
        "1d"

          ? new Date(
              timestamps[index] *
                1000
            )
              .toISOString()
              .slice(0, 10)

          : timestamps[index],

      open:
        Number(
          quote.open[index]
        ),

      high:
        Number(
          quote.high[index]
        ),

      low:
        Number(
          quote.low[index]
        ),

      close:
        Number(
          quote.close[index]
        ),

      volume:
        Number(
          quote.volume?.[index] ||
          0
        )

    });

  }


  return candles;
}


/* ======================================
   TECHNICAL RENDER
====================================== */

function renderTechnical(
  candles,
  quote
) {

  const closes =
    candles.map(
      candle =>
        candle.close
    );


  const ma5 =
    sma(
      closes,
      5
    );


  const ma20 =
    sma(
      closes,
      20
    );


  const ma60 =
    sma(
      closes,
      60
    );


  const rsi =
    RSI(
      closes
    );


  const macd =
    MACD(
      closes
    );


  const index =
    closes.length - 1;


  let score = 0;


  if (
    ma20[index] &&
    quote.price >
      ma20[index]
  ) {

    score += 25;

  }


  if (
    ma60[index] &&
    quote.price >
      ma60[index]
  ) {

    score += 25;

  }


  if (
    rsi[index] >= 50
  ) {

    score += 20;

  }


  if (
    macd.macd[index] >
    macd.signal[index]
  ) {

    score += 20;

  }


  if (
    ma20[index] &&
    ma60[index] &&
    ma20[index] >
      ma60[index]
  ) {

    score += 10;

  }


  if (
    score >= 70
  ) {

    set(
      "trend-value",
      "強勢多頭"
    );

  }
  else if (
    score >= 50
  ) {

    set(
      "trend-value",
      "偏多"
    );

  }
  else if (
    score >= 35
  ) {

    set(
      "trend-value",
      "震盪"
    );

  }
  else {

    set(
      "trend-value",
      "偏弱"
    );

  }


  set(
    "trend-note",
    `技術評分 ${score}/100`
  );


  set(
    "rsi-value",
    rsi[index]?.toFixed(1) ||
    "—"
  );


  set(
    "rsi-note",

    rsi[index] >= 70
      ? "偏熱"

      : rsi[index] <= 30
        ? "超賣"

        : "中性"
  );


  set(
    "ma20-value",
    ma20[index]
      ? fmt(ma20[index])
      : "—"
  );


  set(
    "ma20-note",

    ma20[index]
      ? quote.price >=
        ma20[index]
        ? "價格在 MA20 上方"
        : "價格在 MA20 下方"
      : "—"
  );


  set(
    "tech-ma5",
    fmt(ma5[index])
  );


  set(
    "tech-ma20",
    fmt(ma20[index])
  );


  set(
    "tech-ma60",
    fmt(ma60[index])
  );


  set(
    "tech-rsi",
    rsi[index]?.toFixed(1) ||
    "—"
  );


  set(
    "tech-macd",
    fmt(
      macd.macd[index]
    )
  );


  set(
    "tech-signal",
    fmt(
      macd.signal[index]
    )
  );


  set(
    "tech-volume",
    vol(
      candles[index]
        ?.volume
    )
  );


  set(
    "tech-score",
    `${score}/100`
  );


  set(
    "technical-status",
    `${candles.length} 根 K 線`
  );


  /* Chart */

  if (candleSeries) {

    candleSeries.setData(
      candles.map(
        candle => ({
          time:
            candle.time,

          open:
            candle.open,

          high:
            candle.high,

          low:
            candle.low,

          close:
            candle.close
        })
      )
    );

  }


  if (ma5Series) {

    ma5Series.setData(
      candles
        .map(
          (candle, index) => {

            if (
              ma5[index] == null
            ) {

              return null;

            }


            return {

              time:
                candle.time,

              value:
                ma5[index]

            };

          }
        )
        .filter(Boolean)
    );

  }


  if (ma20Series) {

    ma20Series.setData(
      candles
        .map(
          (candle, index) => {

            if (
              ma20[index] == null
            ) {

              return null;

            }


            return {

              time:
                candle.time,

              value:
                ma20[index]

            };

          }
        )
        .filter(Boolean)
    );

  }


  if (ma60Series) {

    ma60Series.setData(
      candles
        .map(
          (candle, index) => {

            if (
              ma60[index] == null
            ) {

              return null;

            }


            return {

              time:
                candle.time,

              value:
                ma60[index]

            };

          }
        )
        .filter(Boolean)
    );

  }


  if (chart) {

    chart
      .timeScale()
      .fitContent();

  }

}


/* ======================================
   QUOTE RENDER
====================================== */

function renderQuote(
  quote
) {

  set(
    "current-price",
    fmt(quote.price)
  );


  set(
    "open-price",
    fmt(quote.open)
  );


  set(
    "high-price",
    fmt(quote.high)
  );


  set(
    "low-price",
    fmt(quote.low)
  );


  set(
    "previous-close",
    fmt(quote.previous)
  );


  set(
    "volume",
    vol(quote.volume)
  );


  const change =
    document.getElementById(
      "price-change"
    );


  const className =
    quote.change > 0

      ? "price-up"

      : quote.change < 0

        ? "price-down"

        : "price-flat";


  change.className =
    className;


  change.textContent =
    `${quote.change >= 0 ? "+" : ""}` +
    `${quote.change.toFixed(2)} ` +
    `(${quote.change >= 0 ? "+" : ""}` +
    `${quote.changePercent.toFixed(2)}%)`;


  set(
    "market-state",
    quote.marketState ||
    "—"
  );

}


/* ======================================
   WATCHLIST
====================================== */

function renderWatchlist() {

  const element =
    document.getElementById(
      "stock-list"
    );


  element.innerHTML = "";


  set(
    "watch-count",
    `${watchlist.length} 支自選`
  );


  let list =
    [...watchlist];


  if (
    sortMode !== "manual"
  ) {

    list.sort(
      (a, b) => {

        const qa =
          quoteCache[a.symbol];

        const qb =
          quoteCache[b.symbol];


        if (
          sortMode ===
          "change-desc"
        ) {

          return (
            (qb?.changePercent || 0) -
            (qa?.changePercent || 0)
          );

        }


        if (
          sortMode ===
          "change-asc"
        ) {

          return (
            (qa?.changePercent || 0) -
            (qb?.changePercent || 0)
          );

        }


        if (
          sortMode ===
          "price-desc"
        ) {

          return (
            (qb?.price || 0) -
            (qa?.price || 0)
          );

        }


        if (
          sortMode ===
          "price-asc"
        ) {

          return (
            (qa?.price || 0) -
            (qb?.price || 0)
          );

        }


        if (
          sortMode ===
          "symbol-asc"
        ) {

          return a.symbol.localeCompare(
            b.symbol
          );

        }


        return 0;

      }
    );

  }


  list.forEach(
    stock => {

      const quote =
        quoteCache[
          stock.symbol
        ];


      const item =
        document.createElement(
          "div"
        );


      item.className =
        `stock-item ${
          stock.symbol ===
          currentSymbol
            ? "active"
            : ""
        }`;


      item.dataset.symbol =
        stock.symbol;


      item.innerHTML = `

        <span class="drag">
          ⋮⋮
        </span>

        <span class="stock-logo">
          ${esc(
            displaySymbol(
              stock.symbol
            ).slice(0, 5)
          )}
        </span>

        <button
          style="
            all:unset;
            display:flex;
            flex:1;
            align-items:center;
            gap:8px
          "
          onclick="
            loadStock(
              '${esc(stock.symbol)}'
            )
          "
        >

          <span class="stock-main">

            <span class="stock-name">
              ${esc(
                stock.name ||
                displaySymbol(
                  stock.symbol
                )
              )}
            </span>

            <span class="stock-sub">
              ${esc(
                displaySymbol(
                  stock.symbol
                )
              )}
            </span>

          </span>


          <span class="stock-right">

            <span class="stock-price">
              ${
                quote
                  ? fmt(
                      quote.price
                    )
                  : "—"
              }
            </span>

            <span
              class="${
                quote?.change >= 0
                  ? "price-up"
                  : "price-down"
              } stock-change"
            >

              ${
                quote
                  ? `${
                      quote.change >= 0
                        ? "+"
                        : ""
                    }${quote.changePercent.toFixed(
                      2
                    )}%`
                  : ""
              }

            </span>

          </span>

        </button>


        <button
          class="delete"
          onclick="
            event.stopPropagation();
            removeStock(
              '${esc(stock.symbol)}'
            )
          "
        >
          ×
        </button>

      `;


      element.appendChild(
        item
      );

    }
  );


  renderOverview();

}


/* ======================================
   DASHBOARD
====================================== */

function renderOverview() {

  const element =
    document.getElementById(
      "watch-overview"
    );


  const items =
    watchlist.filter(
      stock =>
        quoteCache[
          stock.symbol
        ]
    );


  if (!items.length) {

    element.innerHTML =
      `<div class="note">
        正在載入自選股行情…
      </div>`;

  }
  else {

    element.innerHTML =
      items
        .map(
          stock => {

            const quote =
              quoteCache[
                stock.symbol
              ];


            return `

              <div
                class="watch-overview-item"
                onclick="
                  loadStock(
                    '${esc(
                      stock.symbol
                    )}'
                  )
                "
              >

                <div class="watch-line">

                  <b>
                    ${esc(
                      displaySymbol(
                        stock.symbol
                      )
                    )}
                  </b>

                  <span
                    class="${
                      quote.change >= 0
                        ? "price-up"
                        : "price-down"
                    }"
                  >
                    ${
                      quote.change >= 0
                        ? "+"
                        : ""
                    }${quote.changePercent.toFixed(
                      2
                    )}%
                  </span>

                </div>


                <div class="watch-line">

                  <span>
                    ${esc(
                      stock.name ||
                      ""
                    )}
                  </span>

                  <b>
                    ${fmt(
                      quote.price
                    )}
                  </b>

                </div>

              </div>

            `;

          }
        )
        .join("");

  }


  set(
    "watch-summary",
    `${items.length}/${watchlist.length} 已更新`
  );


  const movers =
    [...items].sort(
      (a, b) =>
        quoteCache[
          b.symbol
        ].changePercent -
        quoteCache[
          a.symbol
        ].changePercent
    );


  document.getElementById(
    "movers-list"
  ).innerHTML =

    movers.length

      ? movers
          .slice(0, 6)
          .map(
            stock => {

              const quote =
                quoteCache[
                  stock.symbol
                ];


              return `

                <div class="mover">

                  <b>
                    ${esc(
                      displaySymbol(
                        stock.symbol
                      )
                    )}
                  </b>

                  <span
                    class="${
                      quote.change >= 0
                        ? "price-up"
                        : "price-down"
                    }"
                  >
                    ${
                      quote.change >= 0
                        ? "+"
                        : ""
                    }${quote.changePercent.toFixed(
                      2
                    )}%
                  </span>

                </div>

              `;

            }
          )
          .join("")

      : `<div class="note">
          —
        </div>`;

}


/* ======================================
   MARKET INDEX
====================================== */

async function loadMarkets() {

  const symbols = [

    [
      "台灣加權",
      "^TWII"
    ],

    [
      "S&P 500",
      "^GSPC"
    ],

    [
      "NASDAQ",
      "^IXIC"
    ],

    [
      "費城半導體",
      "^SOX"
    ]

  ];


  const element =
    document.getElementById(
      "market-grid"
    );


  element.innerHTML =
    `
      <div class="market-card glass">
        載入大盤…
      </div>
    `.repeat(4);


  const data =
    await Promise.all(

      symbols.map(
        async pair => {

          try {

            const result =
              await worker(
                "",
                {
                  symbol:
                    pair[1],

                  interval:
                    "1d",

                  range:
                    "5d"
                }
              );


            return [
              pair[0],
              quoteFrom(result)
            ];

          }
          catch {

            return [
              pair[0],
              null
            ];

          }

        }
      )

    );


  element.innerHTML =
    data
      .map(
        ([name, quote]) => `

          <div class="market-card glass">

            <div class="market-top">

              <span>
                ${name}
              </span>

              <span>
                指數
              </span>

            </div>


            <div class="market-price">

              ${
                quote
                  ? fmt(
                      quote.price
                    )
                  : "—"
              }

            </div>


            <div
              class="market-change ${
                quote?.change >= 0
                  ? "price-up"
                  : "price-down"
              }"
            >

              ${
                quote
                  ? `${
                      quote.change >= 0
                        ? "+"
                        : ""
                    }${quote.change.toFixed(
                      2
                    )} (${
                      quote.change >= 0
                        ? "+"
                        : ""
                    }${quote.changePercent.toFixed(
                      2
                    )}%)`
                  : "暫無資料"
              }

            </div>


            <div class="market-meta">

              ${
                quote?.marketState ||
                "Market Index"
              }

            </div>

          </div>

        `
      )
      .join("");

}


/* ======================================
   NEWS
====================================== */

async function loadNews(
  symbol
) {

  const element =
    document.getElementById(
      "news-list"
    );


  if (!symbol) {

    element.innerHTML =
      `<div class="note">
        —
      </div>`;

    return;

  }


  element.innerHTML =
    `<div class="note">
      新聞載入中…
    </div>`;


  try {

    const result =
      await worker(
        "news",
        {
          symbol:
            displaySymbol(symbol)
        }
      );


    const news =
      result.news ||
      result.results ||
      result ||
      [];


    if (
      !Array.isArray(news) ||
      !news.length
    ) {

      throw new Error(
        "NO_NEWS"
      );

    }


    element.innerHTML =
      news
        .slice(0, 10)
        .map(
          item => {

            const url =
              item.url ||
              item.link ||
              "#";


            const timestamp =
              item.providerPublishTime;


            const date =
              timestamp
                ? new Date(
                    timestamp * 1000
                  ).toLocaleString(
                    "zh-TW",
                    {
                      hour12: false
                    }
                  )
                : (
                    item.datetime ||
                    ""
                  );


            return `

              <a
                class="news-item"
                href="${esc(url)}"
                target="_blank"
                rel="noopener"
              >

                <div class="news-title">

                  <span class="news-badge">
                    ${esc(
                      item.publisher ||
                      item.source ||
                      "NEWS"
                    )}
                  </span>

                  ${esc(
                    item.title ||
                    "未命名新聞"
                  )}

                </div>


                <div class="news-meta">
                  ${esc(date)}
                </div>

              </a>

            `;

          }
        )
        .join("");

  }
  catch {

    element.innerHTML =
      `<div class="note">
        目前沒有可取得的新聞資料。
      </div>`;

  }

}


/* ======================================
   CHIP DATA
====================================== */

async function loadChips(
  symbol
) {

  const summary =
    document.getElementById(
      "chip-summary"
    );


  const table =
    document.getElementById(
      "chip-table"
    );


  summary.innerHTML = "";

  table.innerHTML = "";


  if (
    !isTaiwanSymbol(symbol)
  ) {

    set(
      "chip-status",
      "非台股"
    );


    set(
      "chip-note",
      "目前籌碼面以台股三大法人為主；美股與加密貨幣不強行捏造籌碼數據。"
    );


    return;

  }


  try {

    const result =
      await worker(
        "chips",
        {
          symbol:
            displaySymbol(symbol)
        }
      );


    const rows =
      result.rows ||
      [];


    set(
      "chip-status",
      result.date
        ? `${result.date} · 三大法人`
        : "已載入"
    );


    const latest =
      rows[
        rows.length - 1
      ];


    if (latest) {

      const values = [

        [
          "外資",
          latest.foreign
        ],

        [
          "投信",
          latest.trust
        ],

        [
          "自營商",
          latest.dealer
        ]

      ];


      summary.innerHTML =
        values
          .map(
            item => `

              <div class="chip-box">

                <span>
                  ${item[0]}
                </span>

                <b
                  class="${
                    Number(item[1]) >= 0
                      ? "chip-up"
                      : "chip-down"
                  }"
                >
                  ${fmt(
                    Number(
                      item[1]
                    )
                  )}
                </b>

                <small>
                  張
                </small>

              </div>

            `
          )
          .join("");

    }


    table.innerHTML = `

      <table>

        <thead>

          <tr>

            <th>
              日期
            </th>

            <th>
              外資
            </th>

            <th>
              投信
            </th>

            <th>
              自營商
            </th>

            <th>
              合計
            </th>

          </tr>

        </thead>


        <tbody>

          ${rows
            .slice(-8)
            .reverse()
            .map(
              row => `

                <tr>

                  <td>
                    ${esc(
                      row.date
                    )}
                  </td>

                  <td
                    class="${
                      row.foreign >= 0
                        ? "chip-up"
                        : "chip-down"
                    }"
                  >
                    ${fmt(
                      row.foreign
                    )}
                  </td>

                  <td
                    class="${
                      row.trust >= 0
                        ? "chip-up"
                        : "chip-down"
                    }"
                  >
                    ${fmt(
                      row.trust
                    )}
                  </td>

                  <td
                    class="${
                      row.dealer >= 0
                        ? "chip-up"
                        : "chip-down"
                    }"
                  >
                    ${fmt(
                      row.dealer
                    )}
                  </td>

                  <td
                    class="${
                      row.total >= 0
                        ? "chip-up"
                        : "chip-down"
                    }"
                  >
                    ${fmt(
                      row.total
                    )}
                  </td>

                </tr>

              `
            )
            .join("")}

        </tbody>

      </table>

    `;

  }
  catch {

    set(
      "chip-status",
      "暫無資料"
    );


    set(
      "chip-note",
      "籌碼資料需要 Cloudflare Worker 的 chips endpoint。"
    );

  }

}


/* ======================================
   LOAD STOCK
====================================== */

async function loadStock(
  symbol,
  silent = false
) {

  currentSymbol =
    symbol;


  localStorage.setItem(
    "stockCurrentSymbolV5",
    symbol
  );


  renderWatchlist();


  if (!silent) {

    set(
      "stock-symbol-title",
      displaySymbol(symbol)
    );


    set(
      "stock-name",
      watchlist.find(
        stock =>
          stock.symbol ===
          symbol
      )?.name ||
      displaySymbol(symbol)
    );


    set(
      "chart-status",
      "載入中…"
    );


    loadNews(symbol);

    loadChips(symbol);

  }


  try {

    const result =
      await yahoo(symbol);


    const quote =
      quoteFrom(result);


    const candles =
      candlesFrom(result);


    quoteCache[
      symbol
    ] =
      quote;


    renderQuote(
      quote
    );


    renderTechnical(
      candles,
      quote
    );


    set(
      "stock-symbol-title",
      displaySymbol(symbol)
    );


    set(
      "stock-name",

      watchlist.find(
        stock =>
          stock.symbol ===
          symbol
      )?.name ||

      result.meta
        ?.longName ||

      displaySymbol(symbol)
    );


    set(
      "last-update",
      `最後更新 ${new Date().toLocaleString(
        "zh-TW",
        {
          hour12: false
        }
      )}`
    );


    set(
      "chart-status",
      `${currentPeriod.label} · ${candles.length} 根`
    );


    set(
      "range-value",
      "—"
    );


    checkAlerts(
      quote
    );


    renderWatchlist();

    updateFavorite();


    if (!silent) {

      loadFundamentals(
        symbol
      );

      loadNews(
        symbol
      );

      loadChips(
        symbol
      );

    }

  }
  catch (error) {

    console.error(
      error
    );


    set(
      "chart-status",
      "資料取得失敗"
    );

  }


  restartAutoRefresh();

}


/* ======================================
   FUNDAMENTALS
====================================== */

async function loadFundamentals(
  symbol
) {

  const fields = [

    "metric-pe",

    "metric-eps",

    "metric-marketcap",

    "metric-beta",

    "metric-52high",

    "metric-52low",

    "metric-dividend",

    "metric-roe",

    "metric-gross-margin",

    "metric-op-margin",

    "metric-net-margin",

    "metric-revenue-growth"

  ];


  fields.forEach(
    field =>
      set(
        field,
        "—"
      )
  );


  try {

    if (
      isTaiwanSymbol(
        symbol
      )
    ) {

      const result =
        await worker(
          "twse_metrics",
          {
            symbol:
              displaySymbol(
                symbol
              )
          }
        );


      set(
        "metric-pe",
        result.pe
      );


      set(
        "metric-eps",
        result.eps
      );


      set(
        "metric-52high",
        result.high52
      );


      set(
        "metric-52low",
        result.low52
      );


      set(
        "metric-dividend",
        result.dividendYield !=
        null
          ? `${result.dividendYield}%`
          : "—"
      );


      set(
        "fundamentals-status",
        "TWSE/TPEX"
      );


      set(
        "fundamentals-note",
        result.source ||
        "官方資料"
      );

    }
    else {

      const result =
        await worker(
          "finnhub",
          {
            symbol:
              displaySymbol(
                symbol
              ),

            endpoint:
              "metric",

            metric:
              "all"
          }
        );


      const metric =
        result.metric ||
        {};


      set(
        "metric-pe",
        metric.peTTM ??
        metric.peNormalizedAnnual
      );


      set(
        "metric-eps",
        metric.epsTTM
      );


      set(
        "metric-marketcap",
        metric.marketCapitalization
      );


      set(
        "metric-beta",
        metric.beta
      );


      set(
        "metric-52high",
        metric["52WeekHigh"]
      );


      set(
        "metric-52low",
        metric["52WeekLow"]
      );


      set(
        "metric-dividend",
        metric.dividendYieldIndicatedAnnual
          ? `${metric.dividendYieldIndicatedAnnual}%`
          : "—"
      );


      set(
        "metric-roe",
        metric.roeTTM
          ? `${metric.roeTTM}%`
          : "—"
      );


      set(
        "fundamentals-status",
        "Finnhub"
      );

    }

  }
  catch {

    set(
      "fundamentals-status",
      "暫無資料"
    );

  }

}


/* ======================================
   ADD STOCK
====================================== */

async function addStock() {

  const input =
    document.getElementById(
      "stock-input"
    );


  const raw =
    input.value
      .trim()
      .toUpperCase();


  if (!raw) {

    return;

  }


  const symbol =
    /^\d{4,6}$/.test(raw)
      ? `${raw}.TW`
      : raw;


  if (
    !watchlist.some(
      stock =>
        stock.symbol ===
        symbol
    )
  ) {

    watchlist.push({

      symbol,

      name:
        displaySymbol(
          symbol
        )

    });

  }


  input.value = "";


  save();


  await loadStock(
    symbol
  );

}


function quickAdd(
  symbol
) {

  document.getElementById(
    "stock-input"
  ).value =
    symbol;


  addStock();

}


/* ======================================
   REMOVE
====================================== */

function removeStock(
  symbol
) {

  watchlist =
    watchlist.filter(
      stock =>
        stock.symbol !==
        symbol
    );


  if (
    currentSymbol ===
    symbol
  ) {

    currentSymbol =
      watchlist[0]
        ?.symbol ||
      null;

  }


  save();

  renderWatchlist();


  if (
    currentSymbol
  ) {

    loadStock(
      currentSymbol
    );

  }

}


/* ======================================
   FAVORITE
====================================== */

function toggleFavorite() {

  if (!currentSymbol) {

    return;

  }


  if (
    watchlist.some(
      stock =>
        stock.symbol ===
        currentSymbol
    )
  ) {

    removeStock(
      currentSymbol
    );

  }
  else {

    watchlist.push({

      symbol:
        currentSymbol,

      name:
        displaySymbol(
          currentSymbol
        )

    });


    save();

    renderWatchlist();

  }


  updateFavorite();

}


function updateFavorite() {

  const button =
    document.getElementById(
      "favorite-btn"
    );


  const active =
    watchlist.some(
      stock =>
        stock.symbol ===
        currentSymbol
    );


  button.classList.toggle(
    "active",
    active
  );


  button.textContent =
    active
      ? "★"
      : "☆";

}


/* ======================================
   SORT
====================================== */

function changeSort(
  value
) {

  sortMode =
    value;


  localStorage.setItem(
    "stockSortV5",
    value
  );


  renderWatchlist();

}


/* ======================================
   PERIOD
====================================== */

async function changePeriod(
  button
) {

  document
    .querySelectorAll(
      ".period-btn"
    )
    .forEach(
      element =>
        element.classList.remove(
          "active"
        )
    );


  button.classList.add(
    "active"
  );


  currentPeriod = {

    interval:
      button.dataset.interval,

    range:
      button.dataset.range,

    label:
      button.textContent.trim()

  };


  if (
    currentSymbol
  ) {

    await loadStock(
      currentSymbol
    );

  }

}


/* ======================================
   ALERT
====================================== */

function checkAlerts(
  quote
) {

  alerts.forEach(
    alert => {

      if (
        alert.symbol !==
        currentSymbol
      ) {

        return;

      }


      if (
        alert.triggered
      ) {

        return;

      }


      const hit =
        alert.direction ===
        "above"

          ? quote.price >=
            alert.target

          : quote.price <=
            alert.target;


      if (hit) {

        alert.triggered =
          true;


        notify(

          `價格警報 ${displaySymbol(
            alert.symbol
          )}`,

          `${fmt(
            quote.price
          )} 已${
            alert.direction ===
            "above"
              ? "突破"
              : "跌破"
          } ${alert.target}`

        );


        save();

      }

    }
  );


  renderAlerts();

}


function renderAlerts() {

  const element =
    document.getElementById(
      "alert-list"
    );


  const currentAlerts =
    alerts.filter(
      alert =>
        alert.symbol ===
        currentSymbol
    );


  if (
    !currentAlerts.length
  ) {

    element.innerHTML =
      `<div class="note">
        目前沒有此標的的價格警報。
      </div>`;

    return;

  }


  element.innerHTML =
    currentAlerts
      .map(
        alert => `

          <div class="alert-item">

            <span>

              ${displaySymbol(
                alert.symbol
              )}

              ${
                alert.direction ===
                "above"
                  ? "突破"
                  : "跌破"
              }

              <b>
                ${alert.target}
              </b>

              ${
                alert.triggered
                  ? " · 已觸發"
                  : ""
              }

            </span>


            <span class="alert-actions">

              <button
                onclick="
                  deleteAlert(
                    ${alert.id}
                  )
                "
              >
                刪除
              </button>

            </span>

          </div>

        `
      )
      .join("");

}


function addAlert() {

  if (!currentSymbol) {

    return;

  }


  const target =
    Number(
      prompt(
        "目標價格："
      )
    );


  if (
    !Number.isFinite(
      target
    )
  ) {

    return;

  }


  const direction =
    prompt(
      "above = 突破、below = 跌破",
      "above"
    );


  if (
    ![
      "above",
      "below"
    ].includes(
      direction
    )
  ) {

    return;

  }


  alerts.push({

    id:
      Date.now(),

    symbol:
      currentSymbol,

    target,

    direction,

    triggered:
      false

  });


  save();

  renderAlerts();

}


function deleteAlert(
  id
) {

  alerts =
    alerts.filter(
      alert =>
        alert.id !==
        id
    );


  save();

  renderAlerts();

}


/* ======================================
   NOTIFICATION
====================================== */

function notify(
  title,
  body
) {

  if (
    "Notification" in window &&
    Notification.permission ===
      "granted"
  ) {

    new Notification(
      title,
      {
        body
      }
    );

  }
  else {

    alert(
      `${title}\n${body}`
    );

  }

}


async function requestNotifications() {

  if (
    "Notification" in window
  ) {

    await Notification.requestPermission();

  }

}


/* ======================================
   SIDEBAR
====================================== */

function toggleSidebar() {

  document
    .getElementById(
      "sidebar"
    )
    .classList.toggle(
      "open"
    );


  document
    .getElementById(
      "sidebar-overlay"
    )
    .classList.toggle(
      "show"
    );

}


/* ======================================
   SETTINGS
====================================== */

function openSettingsModal() {

  document
    .getElementById(
      "modal-overlay"
    )
    .classList.remove(
      "hidden"
    );


  document
    .getElementById(
      "settings-modal"
    )
    .classList.remove(
      "hidden"
    );

}


function closeModals() {

  document
    .getElementById(
      "modal-overlay"
    )
    .classList.add(
      "hidden"
    );


  document
    .getElementById(
      "settings-modal"
    )
    .classList.add(
      "hidden"
    );

}


/* ======================================
   THEME
====================================== */

function toggleDarkMode() {

  document.body.classList.toggle(
    "light-mode"
  );


  localStorage.setItem(
    "stockThemeModeV5",

    document.body.classList.contains(
      "light-mode"
    )
      ? "light"
      : "dark"
  );

}


function changeThemeColor(
  name
) {

  const colors = {

    blue: [
      "#3b82f6",
      "#8b5cf6"
    ],

    emerald: [
      "#10b981",
      "#06b6d4"
    ],

    purple: [
      "#a855f7",
      "#ec4899"
    ],

    orange: [
      "#f97316",
      "#facc15"
    ]

  };


  const color =
    colors[name] ||
    colors.blue;


  document.documentElement
    .style
    .setProperty(
      "--primary",
      color[0]
    );


  document.documentElement
    .style
    .setProperty(
      "--secondary",
      color[1]
    );


  localStorage.setItem(
    "stockThemeColorV5",
    name
  );

}


function applySettings() {

  AUTO_REFRESH_INTERVAL =
    Number(
      document.getElementById(
        "refresh-rate"
      ).value
    );


  localStorage.setItem(
    "stockRefreshRate",
    AUTO_REFRESH_INTERVAL
  );


  const mode =
    document.getElementById(
      "kline-color"
    ).value;


  updateChartColors(
    mode
  );


  restartAutoRefresh();

}


/* ======================================
   CHART COLORS
====================================== */

function updateChartColors(
  mode
) {

  const up =
    mode ===
    "green-red"

      ? "#10b981"

      : "#ef4444";


  const down =
    mode ===
    "green-red"

      ? "#ef4444"

      : "#10b981";


  if (
    candleSeries
  ) {

    candleSeries.applyOptions({

      upColor:
        up,

      downColor:
        down,

      borderUpColor:
        up,

      borderDownColor:
        down,

      wickUpColor:
        up,

      wickDownColor:
        down

    });

  }

}


/* ======================================
   AUTO REFRESH
====================================== */

function startAutoRefresh() {

  clearInterval(
    autoRefreshTimer
  );


  autoRefreshTimer =
    setInterval(
      () => {

        if (
          document.hidden
        ) {

          return;

        }


        watchlist.forEach(
          stock =>
            loadStock(
              stock.symbol,
              true
            )
        );


        loadMarkets();

      },

      AUTO_REFRESH_INTERVAL
    );

}


function restartAutoRefresh() {

  startAutoRefresh();

}


/* ======================================
   CHART INIT
====================================== */

function initChart() {

  const container =
    document.getElementById(
      "chart-container"
    );


  chart =
    LightweightCharts
      .createChart(
        container,
        {

          layout: {

            background: {
              type: "solid",

              color:
                "transparent"
            },

            textColor:
              "#8d96a5"

          },


          grid: {

            vertLines: {

              color:
                "rgba(255,255,255,.035)"

            },

            horzLines: {

              color:
                "rgba(255,255,255,.035)"

            }

          },


          rightPriceScale: {

            borderColor:
              "rgba(255,255,255,.08)"

          },


          timeScale: {

            borderColor:
              "rgba(255,255,255,.08)",

            timeVisible:
              true,

            secondsVisible:
              false

          }

        }
      );


  candleSeries =
    chart.addSeries(
      LightweightCharts.CandlestickSeries,
      {

        upColor:
          "#ef4444",

        downColor:
          "#10b981",

        borderUpColor:
          "#ef4444",

        borderDownColor:
          "#10b981",

        wickUpColor:
          "#ef4444",

        wickDownColor:
          "#10b981"

      }
    );


  ma5Series =
    chart.addSeries(
      LightweightCharts.LineSeries,
      {

        color:
          "#f59e0b",

        lineWidth:
          1

      }
    );


  ma20Series =
    chart.addSeries(
      LightweightCharts.LineSeries,
      {

        color:
          "#60a5fa",

        lineWidth:
          1

      }
    );


  ma60Series =
    chart.addSeries(
      LightweightCharts.LineSeries,
      {

        color:
          "#c084fc",

        lineWidth:
          1

      }
    );


  const observer =
    new ResizeObserver(
      () => {

        chart.applyOptions({

          width:
            container.clientWidth,

          height:
            container.clientHeight

        });

      }
    );


  observer.observe(
    container
  );

}


/* ======================================
   SAVE
====================================== */

function save() {

  localStorage.setItem(
    "stockWatchlistV5",
    JSON.stringify(
      watchlist
    )
  );


  localStorage.setItem(
    "stockAlertsV5",
    JSON.stringify(
      alerts
    )
  );

}


/* ======================================
   DRAG SORT
====================================== */

function enableDragSort() {

  const element =
    document.getElementById(
      "stock-list"
    );


  if (
    typeof Sortable ===
    "undefined"
  ) {

    return;

  }


  new Sortable(
    element,
    {

      animation: 150,

      handle: ".drag",

      onEnd: event => {

        if (
          sortMode !==
          "manual"
        ) {

          return;

        }


        const item =
          watchlist.splice(
            event.oldIndex,
            1
          )[0];


        watchlist.splice(
          event.newIndex,
          0,
          item
        );


        save();

      }

    }
  );

}


/* ======================================
   INIT
====================================== */

window.addEventListener(
  "DOMContentLoaded",
  async () => {

    if (
      localStorage.getItem(
        "stockThemeModeV5"
      ) === "light"
    ) {

      document.body.classList.add(
        "light-mode"
      );

    }


    changeThemeColor(
      localStorage.getItem(
        "stockThemeColorV5"
      ) ||
      "blue"
    );


    document.getElementById(
      "refresh-rate"
    ).value =
      String(
        AUTO_REFRESH_INTERVAL
      );


    document.getElementById(
      "sort-select"
    ).value =
      sortMode;


    initChart();

    renderWatchlist();

    renderAlerts();

    enableDragSort();


    await loadMarkets();


    if (
      currentSymbol
    ) {

      await loadStock(
        currentSymbol
      );

    }


    startAutoRefresh();

  }
);