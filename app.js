/*
==================================================
股票觀測站 v5
Cloudflare Worker
==================================================

支援：

GET /
    Yahoo Finance 行情

GET /?source=news&symbol=AAPL
    個股新聞

GET /?source=chips&symbol=2330
    台股三大法人

GET /?source=finnhub&symbol=AAPL&endpoint=metric&metric=all
    Finnhub 基本面

==================================================
*/


const corsHeaders = {

  "Access-Control-Allow-Origin": "*",

  "Access-Control-Allow-Methods":
    "GET, OPTIONS",

  "Access-Control-Allow-Headers":
    "Content-Type"

};


function json(
  data,
  status = 200
) {

  return new Response(

    JSON.stringify(
      data
    ),

    {

      status,

      headers: {

        "Content-Type":
          "application/json; charset=utf-8",

        ...corsHeaders

      }

    }

  );

}


/* =========================================
   YAHOO
========================================= */

function yahooChartURL(
  symbol
) {

  return (
    "https://query1.finance.yahoo.com" +
    "/v8/finance/chart/" +
    encodeURIComponent(symbol)
  );

}


async function yahoo(
  symbol,
  interval = "1d",
  range = "1y"
) {

  const url =
    `${yahooChartURL(symbol)}` +
    `?interval=${interval}` +
    `&range=${range}`;


  const response =
    await fetch(
      url,
      {

        headers: {

          "User-Agent":
            "Mozilla/5.0"

        }

      }
    );


  if (
    !response.ok
  ) {

    throw new Error(
      `YAHOO_${response.status}`
    );

  }


  return response.json();

}


/* =========================================
   TAIWAN INSTITUTIONAL
========================================= */

async function twseChips(
  code
) {

  const today =
    new Date();


  const rows = [];


  /*
  TWSE T86
  最近約 10 天
  */

  for (
    let i = 0;
    i < 15 &&
    rows.length < 10;
    i++
  ) {

    const date =
      new Date(
        today
      );


    date.setDate(
      date.getDate() -
      i
    );


    const yyyy =
      date.getFullYear();


    const mm =
      String(
        date.getMonth() + 1
      ).padStart(
        2,
        "0"
      );


    const dd =
      String(
        date.getDate()
      ).padStart(
        2,
        "0"
      );


    const dateString =
      `${yyyy}${mm}${dd}`;


    try {

      const url =
        "https://www.twse.com.tw/rwd/zh/fund/T86" +
        `?date=${dateString}` +
        "&selectType=ALLBUT0999" +
        "&response=json";


      const response =
        await fetch(
          url,
          {

            headers: {

              "User-Agent":
                "Mozilla/5.0"

            }

          }
        );


      if (
        !response.ok
      ) {

        continue;

      }


      const result =
        await response.json();


      const data =
        result.data ||
        [];


      const row =
        data.find(
          item =>
            String(
              item[0]
            ).trim() ===
            code
        );


      if (!row) {

        continue;

      }


      /*
      T86 欄位位置可能因官方格式調整而變動。
      這裡依目前常見 TWSE T86 欄位：
      外資、投信、自營商
      */

      const values =
        row.map(
          value =>
            Number(
              String(
                value
              ).replace(
                /,/g,
                ""
              )
            )
        );


      const foreign =
        values[4];


      const trust =
        values[10];


      const dealer =
        values[13];


      if (
        ![
          foreign,
          trust,
          dealer
        ].every(
          Number.isFinite
        )
      ) {

        continue;

      }


      rows.push({

        date:
          `${yyyy}/${mm}/${dd}`,

        foreign,

        trust,

        dealer,

        total:
          foreign +
          trust +
          dealer

      });

    }
    catch {

      continue;

    }

  }


  return {

    date:
      rows[0]?.date ||
      null,

    rows:
      rows.reverse()

  };

}


/* =========================================
   NEWS
========================================= */

async function news(
  symbol,
  env
) {

  /*
  優先使用 Finnhub。
  */

  if (
    env.FINNHUB_KEY
  ) {

    const end =
      Math.floor(
        Date.now() /
        1000
      );


    const start =
      end -
      7 * 86400;


    const from =
      new Date(
        start * 1000
      )
        .toISOString()
        .slice(
          0,
          10
        );


    const to =
      new Date(
        end * 1000
      )
        .toISOString()
        .slice(
          0,
          10
        );


    const url =
      "https://finnhub.io/api/v1/company-news" +
      `?symbol=${encodeURIComponent(symbol)}` +
      `&from=${from}` +
      `&to=${to}` +
      `&token=${env.FINNHUB_KEY}`;


    const response =
      await fetch(
        url
      );


    if (
      response.ok
    ) {

      return response.json();

    }

  }


  /*
  沒有 Finnhub Key 時
  使用 Yahoo Finance search。
  */

  const url =
    "https://query1.finance.yahoo.com" +
    "/v1/finance/search" +
    `?q=${encodeURIComponent(symbol)}` +
    "&newsCount=10";


  const response =
    await fetch(
      url,
      {

        headers: {

          "User-Agent":
            "Mozilla/5.0"

        }

      }
    );


  if (
    !response.ok
  ) {

    throw new Error(
      "NEWS_REQUEST_FAILED"
    );

  }


  const result =
    await response.json();


  return (
    result.news ||
    []
  );

}


/* =========================================
   FINNHUB
========================================= */

async function finnhub(
  symbol,
  endpoint,
  metric,
  env
) {

  if (
    !env.FINNHUB_KEY
  ) {

    return {

      error:
        "FINNHUB_KEY_NOT_CONFIGURED"

    };

  }


  const query =
    new URLSearchParams();


  query.set(
    "symbol",
    symbol
  );


  query.set(
    "token",
    env.FINNHUB_KEY
  );


  if (metric) {

    query.set(
      "metric",
      metric
    );

  }


  const url =
    `https://finnhub.io/api/v1/${endpoint}?${query}`;


  const response =
    await fetch(
      url
    );


  return response.json();

}


/* =========================================
   MAIN
========================================= */

export default {

  async fetch(
    request,
    env
  ) {

    if (
      request.method ===
      "OPTIONS"
    ) {

      return new Response(
        "",
        {
          headers:
            corsHeaders
        }
      );

    }


    const url =
      new URL(
        request.url
      );


    const source =
      url.searchParams.get(
        "source"
      );


    const symbol =
      url.searchParams.get(
        "symbol"
      ) ||
      "2330.TW";


    try {

      /*
      ========================================
      DEFAULT
      ========================================
      */

      if (!source) {

        const interval =
          url.searchParams.get(
            "interval"
          ) ||
          "5m";


        const range =
          url.searchParams.get(
            "range"
          ) ||
          "5d";


        const result =
          await yahoo(
            symbol,
            interval,
            range
          );


        return json(
          result
        );

      }


      /*
      ========================================
      NEWS
      ========================================
      */

      if (
        source ===
        "news"
      ) {

        const result =
          await news(
            symbol,
            env
          );


        return json({

          news:
            result

        });

      }


      /*
      ========================================
      CHIPS
      ========================================
      */

      if (
        source ===
        "chips"
      ) {

        const result =
          await twseChips(
            symbol
          );


        return json(
          result
        );

      }


      /*
      ========================================
      FINNHUB
      ========================================
      */

      if (
        source ===
        "finnhub"
      ) {

        const endpoint =
          url.searchParams.get(
            "endpoint"
          ) ||
          "metric";


        const metric =
          url.searchParams.get(
            "metric"
          );


        const result =
          await finnhub(
            symbol,
            endpoint,
            metric,
            env
          );


        return json(
          result
        );

      }


      /*
      ========================================
      TWSE FUNDAMENTALS
      ========================================

      如果你原本 Worker 已經有
      twse_metrics，
      建議把原本 implementation
      合併到這裡。

      ========================================
      */

      if (
        source ===
        "twse_metrics"
      ) {

        return json({

          source:
            "TWSE/TPEX",

          message:
            "請將你原 Worker 的 twse_metrics endpoint 合併到此處。"

        });

      }


      return json(

        {
          error:
            "UNKNOWN_SOURCE"
        },

        404

      );

    }
    catch (
      error
    ) {

      return json(

        {
          error:
            error.message ||
            String(error)
        },

        500

      );

    }

  }

};