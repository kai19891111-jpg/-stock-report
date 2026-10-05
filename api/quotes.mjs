/* ============================================================
   STOCK REALTIME MASTER
   單一後端設定檔

   檔案位置：
   /api/quotes.mjs

   功能：
   ✅ 台股 Fugle
   ✅ 美股 Finnhub
   ✅ 台股上市
   ✅ 台股上櫃
   ✅ 台股加權指數
   ✅ 美股個股
   ✅ 自動 CORS
   ✅ 自動快取
   ✅ API 失敗不中斷
   ✅ 過濾允許股票
   ✅ 統一回傳格式
   ✅ GitHub Pages 可直接使用
============================================================ */


/* ============================================================
   ① 主要設定
============================================================ */

const CONFIG = {

  /* 你的 GitHub Pages 網域 */

  allowedOrigin:
    'https://kai19891111-jpg.github.io',


  /* API 快取時間：9 秒 */

  cacheMs:
    9000,


  /* Fugle API */

  fugleBase:
    'https://api.fugle.tw/marketdata/v1.0/stock',


  /* Finnhub API */

  finnhubBase:
    'https://finnhub.io/api/v1'

};


/* ============================================================
   ② API KEY

   不要把真正 Key 寫在這裡。

   到：
   Vercel
   → Project
   → Settings
   → Environment Variables

   建立：

   FUGLE_API_KEY
   FINNHUB_API_KEY
============================================================ */

const FUGLE_API_KEY =
  process.env.FUGLE_API_KEY;


const FINNHUB_API_KEY =
  process.env.FINNHUB_API_KEY;


/* ============================================================
   ③ 股票清單
============================================================ */

const STOCKS = [

  /* ===== 台股 ===== */

  '2330.TW',
  '2454.TW',
  '2308.TW',

  '3324.TWO',
  '3653.TW',
  '3017.TW',

  '3189.TW',
  '3037.TW',
  '8046.TW',

  '6213.TW',
  '2383.TW',

  '3481.TW',
  '6770.TW',
  '2221.TWO',

  '8358.TWO',
  '3406.TW',
  '8210.TW',

  '2371.TW',
  '1303.TW',
  '2408.TW',

  '4919.TW',
  '4958.TW',
  '2327.TW',

  /* 台股加權 */

  '^TWII',


  /* ===== 美股 ===== */

  'TSM',
  'NVDA',
  'AMD',
  'AVGO',

  'MSFT',
  'META',
  'MU',
  'TSLA',

  'SPCX',


  /* ===== 指數 ===== */

  '^IXIC',
  '^SOX',
  '^TNX'

];


const ALLOWED =
  new Set(
    STOCKS
  );


/* ============================================================
   ④ 美股清單
============================================================ */

const US_CODES =
  new Set([

    'TSM',
    'NVDA',
    'AMD',
    'AVGO',

    'MSFT',
    'META',
    'MU',
    'TSLA',

    'SPCX',

    '^IXIC',
    '^SOX',
    '^TNX'

  ]);


/* ============================================================
   ⑤ 快取
============================================================ */

if (
  !globalThis.__QUOTE_MASTER_CACHE__
) {

  globalThis.__QUOTE_MASTER_CACHE__ =
    new Map();

}


const CACHE =
  globalThis.__QUOTE_MASTER_CACHE__;


/* ============================================================
   ⑥ 通用工具
============================================================ */

function toNumber(value) {

  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {

    return null;

  }


  const n =
    Number(value);


  return Number.isFinite(n)

    ? n

    : null;

}


function toISO(value) {

  let n =
    Number(value);


  if (
    !Number.isFinite(n) ||
    n <= 0
  ) {

    return null;

  }


  /* microseconds */

  if (
    n > 100000000000000
  ) {

    n /= 1000;

  }


  /* seconds */

  else if (
    n < 100000000000
  ) {

    n *= 1000;

  }


  try {

    return new Date(n)
      .toISOString();

  }

  catch {

    return null;

  }

}


/* ============================================================
   ⑦ CORS
============================================================ */

function headers() {

  return {

    'Content-Type':
      'application/json; charset=utf-8',

    'Access-Control-Allow-Origin':
      CONFIG.allowedOrigin,

    'Access-Control-Allow-Methods':
      'GET, OPTIONS',

    'Access-Control-Allow-Headers':
      'Content-Type',

    'Cache-Control':
      'no-store',

    'Vary':
      'Origin'

  };

}


function response(
  data,
  status = 200
) {

  return new Response(

    JSON.stringify(
      data,
      null,
      2
    ),

    {

      status,

      headers:
        headers()

    }

  );

}


/* ============================================================
   ⑧ OPTIONS
============================================================ */

export async function OPTIONS() {

  return new Response(
    null,
    {

      status: 204,

      headers:
        headers()

    }
  );

}


/* ============================================================
   ⑨ 台股代碼轉換
============================================================ */

function fugleSymbol(code) {

  /* 台灣加權指數 */

  if (
    code === '^TWII'
  ) {

    return 'IX0001';

  }


  return code

    .replace(
      '.TWO',
      ''
    )

    .replace(
      '.TW',
      ''
    );

}


/* ============================================================
   ⑩ 台股市場判斷
============================================================ */

function fugleMarket(code) {

  if (
    code === '^TWII'
  ) {

    return 'TSE';

  }


  if (
    code.endsWith('.TWO')
  ) {

    return 'OTC';

  }


  return 'TSE';

}


/* ============================================================
   ⑪ Fugle 單股行情
============================================================ */

async function getFugleQuote(code) {

  const symbol =
    fugleSymbol(code);


  const url =
    `${CONFIG.fugleBase}/intraday/quote/${encodeURIComponent(
      symbol
    )}`;


  const r =
    await fetch(
      url,
      {

        headers: {

          'X-API-KEY':
            FUGLE_API_KEY,

          'Accept':
            'application/json'

        },

        cache:
          'no-store'

      }
    );


  if (
    !r.ok
  ) {

    throw new Error(
      `Fugle ${code}: ${r.status}`
    );

  }


  const d =
    await r.json();


  const price =
    toNumber(
      d.lastPrice ??
      d.closePrice
    );


  if (
    price === null
  ) {

    throw new Error(
      `${code} 沒有有效價格`
    );

  }


  return {

    price,

    change:
      toNumber(
        d.change
      ),

    changePercent:
      toNumber(
        d.changePercent
      ),

    open:
      toNumber(
        d.openPrice
      ),

    high:
      toNumber(
        d.highPrice
      ),

    low:
      toNumber(
        d.lowPrice
      ),

    previousClose:
      toNumber(
        d.previousClose ??
        d.referencePrice
      ),

    volume:
      toNumber(
        d.total?.tradeVolume ??
        d.tradeVolume
      ),

    time:
      toISO(
        d.lastUpdated ??
        d.total?.time
      ),

    provider:
      'Fugle',

    market:
      fugleMarket(code)

  };

}


/* ============================================================
   ⑫ Finnhub 美股行情
============================================================ */

async function getFinnhubQuote(code) {

  const url =
    `${CONFIG.finnhubBase}/quote?symbol=${encodeURIComponent(
      code
    )}`;


  const r =
    await fetch(
      url,
      {

        headers: {

          'X-Finnhub-Token':
            FINNHUB_API_KEY,

          'Accept':
            'application/json'

        },

        cache:
          'no-store'

      }
    );


  if (
    !r.ok
  ) {

    throw new Error(
      `Finnhub ${code}: ${r.status}`
    );

  }


  const d =
    await r.json();


  const price =
    toNumber(
      d.c
    );


  if (
    price === null ||
    price === 0
  ) {

    throw new Error(
      `${code} 沒有有效價格`
    );

  }


  return {

    price,

    change:
      toNumber(
        d.d
      ),

    changePercent:
      toNumber(
        d.dp
      ),

    open:
      toNumber(
        d.o
      ),

    high:
      toNumber(
        d.h
      ),

    low:
      toNumber(
        d.l
      ),

    previousClose:
      toNumber(
        d.pc
      ),

    volume:
      null,

    time:
      toISO(
        d.t
      ),

    provider:
      'Finnhub',

    market:
      'US'

  };

}


/* ============================================================
   ⑬ 解析網址股票代碼
============================================================ */

function parseSymbols(request) {

  const url =
    new URL(
      request.url
    );


  const requested =
    url.searchParams.get(
      'symbols'
    );


  /*
    沒指定：
    全部抓。
  */

  if (
    !requested
  ) {

    return [
      ...STOCKS
    ];

  }


  return Array.from(

    new Set(

      requested

        .split(',')

        .map(
          x =>
            x.trim()
        )

        .filter(
          x =>
            ALLOWED.has(x)
        )

    )

  );

}


/* ============================================================
   ⑭ 單檔安全抓取
============================================================ */

async function safeQuote(code) {

  try {

    let quote;


    /* ===== 台股 ===== */

    if (
      code === '^TWII' ||
      code.endsWith('.TW') ||
      code.endsWith('.TWO')
    ) {

      quote =
        await getFugleQuote(
          code
        );

    }


    /* ===== 美股 ===== */

    else if (
      US_CODES.has(code)
    ) {

      quote =
        await getFinnhubQuote(
          code
        );

    }


    if (
      !quote
    ) {

      throw new Error(
        '沒有行情來源'
      );

    }


    return {

      code,

      quote,

      error:
        null

    };

  }

  catch (error) {

    return {

      code,

      quote:
        null,

      error:
        error.message

    };

  }

}


/* ============================================================
   ⑮ GET 主程式
============================================================ */

export async function GET(
  request
) {

  /* =========================================================
     檢查 API KEY
  ========================================================= */

  if (
    !FUGLE_API_KEY
  ) {

    return response(
      {

        ok:
          false,

        error:
          'Vercel 尚未設定 FUGLE_API_KEY'

      },
      500
    );

  }


  if (
    !FINNHUB_API_KEY
  ) {

    return response(
      {

        ok:
          false,

        error:
          'Vercel 尚未設定 FINNHUB_API_KEY'

      },
      500
    );

  }


  /* =========================================================
     股票
  ========================================================= */

  const symbols =
    parseSymbols(
      request
    );


  if (
    !symbols.length
  ) {

    return response(
      {

        ok:
          false,

        error:
          '沒有有效股票代碼'

      },
      400
    );

  }


  /* =========================================================
     快取
  ========================================================= */

  const cacheKey =
    symbols
      .slice()
      .sort()
      .join(',');


  const cached =
    CACHE.get(
      cacheKey
    );


  if (
    cached &&
    Date.now() -
    cached.timestamp <
    CONFIG.cacheMs
  ) {

    return response(
      {

        ...cached.data,

        cached:
          true

      }
    );

  }


  /* =========================================================
     同時抓所有股票
  ========================================================= */

  const results =
    await Promise.all(

      symbols.map(
        safeQuote
      )

    );


  const quotes = {};

  const errors = {};


  results.forEach(
    item => {

      if (
        item.quote
      ) {

        quotes[item.code] =
          item.quote;

      }


      if (
        item.error
      ) {

        errors[item.code] =
          item.error;

      }

    }
  );


  /* =========================================================
     回傳
  ========================================================= */

  const data = {

    ok:
      true,

    generatedAt:
      new Date()
        .toISOString(),

    requested:
      symbols.length,

    received:
      Object.keys(
        quotes
      ).length,

    cached:
      false,

    quotes,

    errors

  };


  CACHE.set(
    cacheKey,
    {

      timestamp:
        Date.now(),

      data

    }
  );


  return response(
    data
  );

}