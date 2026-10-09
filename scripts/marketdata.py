"""Shared market data layer: symbol universe, Yahoo daily bars, completed-bar check.

Everything downstream (signals, live trade log, backtest) only ever sees bars whose
session has actually finished, so an intraday snapshot can never be stored as a close.
"""
from __future__ import annotations
import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
# Bars are cached outside data/ so the workflow's `git add data/*.json` never commits them.
CACHE = Path(os.environ.get("BARS_CACHE") or (ROOT / ".cache" / "bars"))
OFFLINE = os.environ.get("BARS_OFFLINE") == "1"   # tests: read the cache only, never the network
CACHE_MAX_AGE_SEC = 6 * 3600

MARKETS = {
    "TW": {"tz": ZoneInfo("Asia/Taipei"), "close": (13, 30), "index": "^TWII"},
    "US": {"tz": ZoneInfo("America/New_York"), "close": (16, 0), "index": "^IXIC"},
}
# Shown in the page's index table only; not used by the entry rule.
EXTRA_INDICES = {"^SOX": "US", "^TNX": "US"}
# A daily bar counts as final this long after the closing bell (closing auction, vendor lag).
SETTLE_MINUTES = 20
# 加權指數：證交所官方的開高低收。Yahoo 的 ^TWII 常常晚一天才補上高低點，甚至整根日K不見。
TWSE_INDEX_URL = "https://openapi.twse.com.tw/v1/indicesReport/MI_5MINS_HIST"
OFFICIAL_INDEX = {"^TWII"}
MAX_INDEX_MOVE = 0.15       # an official bar this far from the previous close is treated as bad data

# Used only if STOCK_META cannot be read from index.html.
FALLBACK_META = {
    "TW|AI晶片": ["2330.TW", "2454.TW"], "TW|AI電源": ["2308.TW"],
    "TW|AI散熱": ["3324.TWO", "3653.TW", "3017.TW"], "TW|ABF": ["3189.TW", "3037.TW", "8046.TW"],
    "TW|CCL": ["6213.TW", "2383.TW"], "TW|面板／光電": ["3481.TW"],
    "TW|晶圓代工＋記憶體": ["6770.TW"], "TW|半導體廠務": ["2221.TWO"],
    "US|AI晶片": ["TSM", "NVDA", "AMD", "AVGO"], "US|AI雲端": ["MSFT", "META"],
    "US|AI記憶體": ["MU"], "US|AI自駕機器人": ["TSLA"], "US|航太科技": ["SPCX"],
    "TW|AI伺服器／機櫃": ["8210.TW"], "TW|AI基建／電力": ["2371.TW"], "TW|光學／CPO": ["3406.TW"],
    "TW|記憶體": ["2408.TW"], "TW|CCL／電子材料": ["1303.TW"],
    "TW|PCB／銅箔": ["8358.TWO", "4958.TW"], "TW|電池監測IC": ["4919.TW"], "TW|被動元件": ["2327.TW"],
}


def load_universe():
    """symbol -> (market, theme). Read from index.html so the page and the scripts share one list."""
    meta = None
    try:
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        m = re.search(r"const STOCK_META\s*=\s*(\{.*?\});", html, re.S)
        meta = json.loads(m.group(1))
    except Exception as e:  # noqa: BLE001
        print("warn: cannot read STOCK_META from index.html, using the built-in list:", e)
    if not meta:
        meta = FALLBACK_META
    out = {}
    for key, codes in meta.items():
        market, theme = key.split("|", 1)
        if market not in MARKETS:
            continue
        for code in codes:
            out[code] = (market, theme)
    return out


def is_final(date_iso, market, now=None):
    """True once the session of `date_iso` has closed (plus a settle buffer) on that exchange."""
    now = now or datetime.now(timezone.utc)
    m = MARKETS[market]
    y, mo, d = (int(x) for x in date_iso.split("-"))
    close = datetime(y, mo, d, m["close"][0], m["close"][1], tzinfo=m["tz"]) + timedelta(minutes=SETTLE_MINUTES)
    return now >= close


def completed(rows, market, now=None):
    """Drop trailing bars whose session is still in progress."""
    rows = list(rows)
    while rows and not is_final(rows[-1]["date"], market, now):
        rows.pop()
    return rows


def parse_chart(raw, market):
    """Yahoo chart JSON -> list of bars. Dates are exchange-local; incomplete rows are dropped."""
    res = raw["chart"]["result"][0]
    ts = res.get("timestamp") or []
    q = res["indicators"]["quote"][0]
    tz = MARKETS[market]["tz"]
    by_date = {}
    for i, t in enumerate(ts):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if o is None or h is None or l is None or c is None or c <= 0:
            continue
        d = datetime.fromtimestamp(t, tz=tz).date().isoformat()
        by_date[d] = {"date": d, "open": o, "high": h, "low": l, "close": c, "volume": q["volume"][i] or 0}
    return [by_date[d] for d in sorted(by_date)]


def _download(symbol, rng):
    last = None
    for host in ("query1", "query2"):
        url = (f"https://{host}.finance.yahoo.com/v8/finance/chart/"
               f"{urllib.parse.quote(symbol)}?interval=1d&range={rng}")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 stock-report"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.0)
    raise last


def parse_twse_index(raw):
    """證交所「發行量加權股價指數歷史資料」-> bars. Dates are ROC (1151007 = 2026-10-07); no volume."""
    out = {}
    for r in raw or []:
        m = re.fullmatch(r"(\d{3})(\d{2})(\d{2})", str(r.get("Date") or "").strip())
        try:
            o, h, l, c = (float(str(r[k]).replace(",", "")) for k in
                          ("OpeningIndex", "HighestIndex", "LowestIndex", "ClosingIndex"))
        except (KeyError, TypeError, ValueError):
            continue
        if not m or c <= 0 or not (l <= c <= h and l <= o <= h):
            continue
        d = f"{int(m.group(1)) + 1911:04d}-{m.group(2)}-{m.group(3)}"
        out[d] = {"date": d, "open": o, "high": h, "low": l, "close": c, "volume": 0}
    return [out[d] for d in sorted(out)]


def merge_official(rows, official):
    """Official bars replace Yahoo's for the same day and add days Yahoo has not published yet.

    Yahoo's volume is kept. An official bar more than MAX_INDEX_MOVE away from the bar before it
    is ignored, so one bad row from the exchange feed cannot move the averages.
    """
    by = {b["date"]: b for b in rows}
    used = 0
    for b in official:
        earlier = [d for d in by if d < b["date"]]
        prev = by[max(earlier)]["close"] if earlier else None
        if prev and abs(b["close"] / prev - 1) > MAX_INDEX_MOVE:
            print("warn: official index bar ignored (too far from previous close):", b["date"], b["close"])
            continue
        by[b["date"]] = dict(b, volume=(by.get(b["date"]) or {}).get("volume") or 0)
        used += 1
    return [by[d] for d in sorted(by)], used


def _official_index():
    req = urllib.request.Request(TWSE_INDEX_URL, headers={"User-Agent": "Mozilla/5.0 stock-report",
                                                           "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return parse_twse_index(json.loads(r.read().decode("utf-8-sig")))


def bars_of(symbol, market, rng="2y", now=None, use_cache=False):
    """Completed daily bars for `symbol`. With use_cache, reuse bars fetched earlier in this run."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / (re.sub(r"[^A-Za-z0-9._-]", "_", symbol) + ".json")
    fresh = path.exists() and (time.time() - path.stat().st_mtime) < CACHE_MAX_AGE_SEC
    if OFFLINE or (use_cache and fresh):
        if not path.exists():
            raise FileNotFoundError(f"no cached bars for {symbol}")
        rows = json.loads(path.read_text(encoding="utf-8"))
    else:
        rows = parse_chart(_download(symbol, rng), market)
        if symbol in OFFICIAL_INDEX:
            try:
                rows, used = merge_official(rows, _official_index())
                print("index", symbol, "official bars merged:", used, "last", rows[-1]["date"] if rows else None)
            except Exception as e:  # noqa: BLE001
                print("warn: official index unavailable, using Yahoo only:", e)
        path.write_text(json.dumps(rows), encoding="utf-8")
        time.sleep(0.25)   # be polite to the data source
    return completed(rows, market, now)
