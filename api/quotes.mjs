/* 不要刪這段。美股沒有 FINNHUB_API_KEY 時必須走 Yahoo，不可以因為缺少金鑰讓整個 /api/quotes 回 500。台股仍用 Fugle；只有請求含台股且沒有 FUGLE_API_KEY 才可 500。 */
const CONFIG = {
  allowedOrigin: 'https://kai19891111-jpg.github.io',
  cacheMs: 9000,
  fugleBase: 'https://api.fugle.tw/marketdata/v1.0/stock',
  finnhubBase: 'https://finnhub.io/api/v1',
  yahooChart: 'https://query1.finance.yahoo.com/v8/finance/chart'
};
const FUGLE_API_KEY = process.env.FUGLE_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const STOCKS = ['2330.TW','2454.TW','2308.TW','3324.TWO','3653.TW','3017.TW','3189.TW','3037.TW','8046.TW','6213.TW','2383.TW','3481.TW','6770.TW','2221.TWO','8358.TWO','3406.TW','8210.TW','2371.TW','1303.TW','2408.TW','4919.TW','4958.TW','2327.TW','^TWII','TSM','NVDA','AMD','AVGO','MSFT','META','MU','TSLA','SPCX','^IXIC','^SOX','^TNX'];
const ALLOWED = new Set(STOCKS);
const US_CODES = new Set(['TSM','NVDA','AMD','AVGO','MSFT','META','MU','TSLA','SPCX','^IXIC','^SOX','^TNX']);
if (!globalThis.__QUOTE_MASTER_CACHE__) globalThis.__QUOTE_MASTER_CACHE__ = new Map();
const CACHE = globalThis.__QUOTE_MASTER_CACHE__;
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function round2(value) {
  const n = toNumber(value);
  return n === null ? null : Math.round(n * 100) / 100;
}
function toISO(value) {
  let n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 100000000000000) n /= 1000;
  else if (n < 100000000000) n *= 1000;
  try { return new Date(n).toISOString(); } catch { return null; }
}
function headers() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': CONFIG.allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  };
}
function response(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: headers() });
}
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: headers() });
}
function fugleSymbol(code) {
  if (code === '^TWII') return 'IX0001';
  return code.replace('.TWO', '').replace('.TW', '');
}
function fugleMarket(code) {
  if (code === '^TWII') return 'TSE';
  return code.endsWith('.TWO') ? 'OTC' : 'TSE';
}
async function getFugleQuote(code) {
  const url = `${CONFIG.fugleBase}/intraday/quote/${encodeURIComponent(fugleSymbol(code))}`;
  const r = await fetch(url, { headers: { 'X-API-KEY': FUGLE_API_KEY, 'Accept': 'application/json' }, cache: 'no-store' });
  if (!r.ok) throw new Error(`Fugle ${code}: ${r.status}`);
  const d = await r.json();
  const price = toNumber(d.lastPrice ?? d.closePrice);
  if (price === null) throw new Error(`${code} 沒有有效價格`);
  return { price, change: toNumber(d.change), changePercent: toNumber(d.changePercent), open: toNumber(d.openPrice), high: toNumber(d.highPrice), low: toNumber(d.lowPrice), previousClose: toNumber(d.previousClose ?? d.referencePrice), volume: toNumber(d.total?.tradeVolume ?? d.tradeVolume), time: toISO(d.lastUpdated ?? d.total?.time), provider: 'Fugle', market: fugleMarket(code) };
}
async function getFinnhubQuote(code) {
  const url = `${CONFIG.finnhubBase}/quote?symbol=${encodeURIComponent(code)}&token=${encodeURIComponent(FINNHUB_API_KEY)}`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
  if (!r.ok) throw new Error(`Finnhub ${code}: ${r.status}`);
  const d = await r.json();
  const price = toNumber(d.c);
  if (price === null || price === 0) throw new Error(`${code} 沒有有效價格`);
  return { price, change: toNumber(d.d), changePercent: toNumber(d.dp), open: toNumber(d.o), high: toNumber(d.h), low: toNumber(d.l), previousClose: toNumber(d.pc), volume: null, time: toISO(d.t), provider: 'Finnhub', market: 'US' };
}
async function getYahooQuote(code) {
  const url = `${CONFIG.yahooChart}/${encodeURIComponent(code)}?interval=1d&range=5d`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' });
  if (!r.ok) throw new Error(`Yahoo ${code}: ${r.status}`);
  const body = await r.json();
  const meta = body?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`Yahoo ${code}: ${body?.chart?.error?.description || '沒有 chart meta'}`);
  const price = toNumber(meta.regularMarketPrice);
  const previousClose = toNumber(meta.previousClose ?? meta.chartPreviousClose);
  if (price === null || price === 0) throw new Error(`${code} 沒有有效價格`);
  return { price, change: previousClose === null ? null : round2(price - previousClose), changePercent: previousClose ? round2((price - previousClose) / previousClose * 100) : null, open: toNumber(meta.regularMarketOpen), high: toNumber(meta.regularMarketDayHigh), low: toNumber(meta.regularMarketDayLow), previousClose, volume: toNumber(meta.regularMarketVolume), time: toISO(meta.regularMarketTime), provider: 'Yahoo', market: 'US' };
}
async function getUsQuote(code) {
  if (FINNHUB_API_KEY && !code.startsWith('^')) {
    try { return await getFinnhubQuote(code); }
    catch (error) {
      const yahoo = await getYahooQuote(code);
      yahoo.fallback = error.message;
      return yahoo;
    }
  }
  return getYahooQuote(code);
}
function parseSymbols(request) {
  const requested = new URL(request.url).searchParams.get('symbols');
  if (!requested) return [...STOCKS];
  return Array.from(new Set(requested.split(',').map(x => x.trim()).filter(x => ALLOWED.has(x))));
}
async function safeQuote(code) {
  try {
    let quote;
    if (code === '^TWII' || code.endsWith('.TW') || code.endsWith('.TWO')) quote = await getFugleQuote(code);
    else if (US_CODES.has(code)) quote = await getUsQuote(code);
    if (!quote) throw new Error('沒有行情來源');
    return { code, quote, error: null };
  } catch (error) {
    return { code, quote: null, error: error.message };
  }
}
export async function GET(request) {
  const symbols = parseSymbols(request);
  const needsFugle = symbols.some(code => code === '^TWII' || code.endsWith('.TW') || code.endsWith('.TWO'));
  if (needsFugle && !FUGLE_API_KEY) return response({ ok: false, error: '有台股代碼，但 Vercel 尚未設定 FUGLE_API_KEY' }, 500);
  if (!symbols.length) return response({ ok: false, error: '沒有有效股票代碼' }, 400);
  const cacheKey = symbols.slice().sort().join(',');
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CONFIG.cacheMs) return response({ ...cached.data, cached: true });
  const results = await Promise.all(symbols.map(safeQuote));
  const quotes = {};
  const errors = {};
  results.forEach(item => { if (item.quote) quotes[item.code] = item.quote; if (item.error) errors[item.code] = item.error; });
  const data = { ok: Object.keys(quotes).length > 0, generatedAt: new Date().toISOString(), requested: symbols.length, received: Object.keys(quotes).length, cached: false, usProvider: FINNHUB_API_KEY ? 'finnhub-with-yahoo-fallback' : 'yahoo', quotes, errors };
  if (data.ok) CACHE.set(cacheKey, { timestamp: Date.now(), data });
  return response(data, data.ok ? 200 : 502);
}
