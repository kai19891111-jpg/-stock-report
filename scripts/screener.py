"""自動選股雷達：掃描台股、美股、加密貨幣，找出最接近進場條件的標的 -> data/screener.json

  台股    證交所＋櫃買中心「全市場日收盤」，取成交金額前 TW_TOP 名（股價 > TW_MIN_PRICE、排除 ETF）
  美股    Nasdaq 全市場名單，取市值前 US_TOP 名（股價 > US_MIN_PRICE）；抓不到時用內建大型股名單
  加密    CoinGecko 市值前 CRYPTO_TOP 名，排除穩定幣與包裝／質押代幣；抓不到時用內建名單

每一檔都用和頁面同一套規則（scripts/strategy.py）算訊號，再逐條核對：
  收在 SMA20 上、乖離 0–6%、未貼近 20 日高、報酬風險比 ≥ 門檻、RSI 在區間內、
  日線週線不是空頭、MACD 沒轉弱、大盤不是空頭、量比 ≥ VOL_MIN
「規則進場訊號」＝回測那條規則（can_open_trade）今天成立。

結果只是提示：不會自動加入 STOCK_META，不下單。任何來源失敗都不會中斷，失敗原因寫在 screener.json。
只用標準函式庫。
"""
from __future__ import annotations

import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from marketdata import (DATA, MARKETS, TPEX_STOCKS_URL, TWSE_STOCKS_URL, _download, bars_of, completed,
                        load_universe, parse_chart)
from strategy import DEFAULT_PARAMS, NEAR_HIGH_PCT, RegimeLookup, build_signals, can_open_trade

TW_TOP, TW_MIN_PRICE = 300, 20.0
US_TOP, US_MIN_PRICE = 300, 5.0
CRYPTO_TOP = 30
PICKS = 10                    # 每個市場列幾檔
MIN_PASS = 7                  # 至少過幾條才列入
VOL_MIN = 1.2
WORKERS = 4
MIN_BARS = 80

STABLE = {"usdt", "usdc", "dai", "fdusd", "usde", "tusd", "pyusd", "usds", "usd1", "busd", "usdd", "gusd", "frax",
          "lusd", "usdp", "eurc", "rlusd", "usdx", "susde", "usdtb", "usd0", "bfusd", "usdf", "usdg", "xaut", "paxg"}
WRAPPED = re.compile(r"wrapped|staked|bridged|liquid|restak|binance-peg|\bweth\b|\bwbtc\b", re.I)
US_FALLBACK = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AVGO", "TSLA", "BRK-B", "JPM", "LLY", "V", "UNH",
               "XOM", "MA", "COST", "HD", "PG", "JNJ", "NFLX", "ABBV", "BAC", "CRM", "ORCL", "AMD", "KO", "CVX",
               "MRK", "PEP", "ADBE", "TMO", "WMT", "CSCO", "ACN", "LIN", "MCD", "ABT", "DIS", "QCOM", "INTU", "TXN",
               "IBM", "AMAT", "GE", "CAT", "NOW", "ISRG", "UBER", "PLTR", "MU", "LRCX", "KLAC", "PANW", "ANET",
               "SNPS", "CDNS", "MRVL", "CRWD", "ARM", "SMCI", "DELL", "VRT", "COIN", "MSTR", "HOOD", "RKLB", "TSM"]
CRYPTO_FALLBACK = ["BTC", "ETH", "XRP", "BNB", "SOL", "DOGE", "ADA", "TRX", "LINK", "AVAX", "XLM", "TON", "HBAR",
                   "SUI", "BCH", "DOT", "LTC", "SHIB", "UNI", "NEAR", "APT", "AAVE", "ICP", "ETC", "PEPE"]


def get(url, headers=None, timeout=30):
    import urllib.request
    h = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
         "Accept": "application/json, text/plain, */*"}
    h.update(headers or {})
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8-sig"))


def fnum(v):
    try:
        x = float(str(v).replace(",", "").replace("$", "").strip())
        return x if x == x else None
    except (TypeError, ValueError):
        return None


# =============================================================================
# 掃描池
# =============================================================================
def tw_pool(errors):
    rows = []
    for board, url, ck, nk, ckey, vkey, amt in (
            ("TW", TWSE_STOCKS_URL, "Code", "Name", "ClosingPrice", "TradeVolume", "TradeValue"),
            ("TWO", TPEX_STOCKS_URL, "SecuritiesCompanyCode", "CompanyName", "Close", "TradingShares", "TransactionAmount")):
        try:
            for r in get(url):
                code = str(r.get(ck) or "").strip()
                if not re.fullmatch(r"[1-9]\d{3}", code):          # 4 碼普通股；排除 ETF、權證、特別股
                    continue
                close, vol = fnum(r.get(ckey)), fnum(r.get(vkey)) or 0
                if not close or close < TW_MIN_PRICE:
                    continue
                value = fnum(r.get(amt)) or close * vol
                rows.append({"code": f"{code}.{board}", "name": str(r.get(nk) or "").strip(), "value": value})
        except Exception as e:  # noqa: BLE001
            errors.append(f"台股 {board} 全市場收盤抓不到：{type(e).__name__} {str(e)[:80]}")
    rows.sort(key=lambda x: -x["value"])
    return rows[:TW_TOP], "證交所＋櫃買中心全市場日收盤，成交金額前 %d 名" % TW_TOP


def us_pool(errors):
    try:
        raw = get("https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&download=true",
                  {"Origin": "https://www.nasdaq.com", "Referer": "https://www.nasdaq.com/"}, timeout=60)
        data = raw.get("data") or {}
        rows = data.get("rows") or ((data.get("table") or {}).get("rows")) or []
        out = []
        for r in rows:
            sym = str(r.get("symbol") or "").strip().upper()
            if not sym or not re.fullmatch(r"[A-Z]{1,5}([./][A-Z])?", sym):
                continue
            price, cap = fnum(r.get("lastsale")), fnum(r.get("marketCap"))
            if not price or price < US_MIN_PRICE or not cap:
                continue
            out.append({"code": re.sub(r"[./]", "-", sym), "name": str(r.get("name") or "")[:40], "value": cap})
        out.sort(key=lambda x: -x["value"])
        if len(out) >= 50:
            return out[:US_TOP], "Nasdaq 全市場名單，市值前 %d 名" % US_TOP
        errors.append(f"美股名單只抓到 {len(out)} 檔，改用內建大型股名單")
    except Exception as e:  # noqa: BLE001
        errors.append(f"美股名單抓不到（{type(e).__name__}），改用內建大型股名單")
    return [{"code": s, "name": s, "value": 0} for s in US_FALLBACK], "內建大型股名單（%d 檔）" % len(US_FALLBACK)


def crypto_pool(errors):
    try:
        raw = get("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=80&page=1")
        out = []
        for r in raw:
            sym = str(r.get("symbol") or "").lower()
            name = str(r.get("name") or "")
            if sym in STABLE or "usd" in sym or WRAPPED.search(name) or WRAPPED.search(str(r.get("id") or "")):
                continue
            out.append({"code": sym.upper() + "-USD", "name": name, "value": r.get("market_cap") or 0,
                        "cgPrice": r.get("current_price")})
            if len(out) >= CRYPTO_TOP:
                break
        if len(out) >= 10:
            return out, "CoinGecko 市值前 %d 名（排除穩定幣、包裝與質押代幣）" % CRYPTO_TOP
        errors.append("CoinGecko 名單太少，改用內建名單")
    except Exception as e:  # noqa: BLE001
        errors.append(f"CoinGecko 名單抓不到（{type(e).__name__}），改用內建名單")
    return [{"code": s + "-USD", "name": s, "value": 0} for s in CRYPTO_FALLBACK], "內建主流幣名單（%d 檔）" % len(CRYPTO_FALLBACK)


# =============================================================================
# 核對
# =============================================================================
def checks(sig, params=DEFAULT_PARAMS):
    """-> [(key, 過了沒, 說明)]"""
    bias, close, high20 = sig.get("bias"), sig.get("close"), sig.get("high20")
    rr, rsi, vr = sig.get("entryRR"), sig.get("rsi14"), sig.get("volumeRatio")
    near = bool(high20) and close is not None and (high20 - close) / high20 * 100 < NEAR_HIGH_PCT
    lo, hi = params.get("rsi_lo", 45), params.get("rsi_hi", 60)
    trend_ok = "空" not in (sig.get("dailyTrend") or "") and "空" not in (sig.get("weeklyTrend") or "")
    f = lambda v, nd=1: "—" if v is None else f"{v:.{nd}f}"  # noqa: E731
    return [
        ("above", bias is not None and bias >= 0, f"收在 SMA20 之上（乖離 {f(bias)}%）"),
        ("bias", bias is not None and 0 <= bias <= 6, "乖離 0–6%"),
        ("high", not near, "未貼近 20 日高"),
        ("rr", rr is not None and rr >= params.get("min_rr", 1.5), f"報酬風險比 {f(rr, 2)} ≥ {params.get('min_rr', 1.5)}"),
        ("rsi", rsi is not None and lo <= rsi <= hi, f"RSI {f(rsi, 0)}（{lo}–{hi}）"),
        ("trend", trend_ok, f"日線{sig.get('dailyTrend') or '—'}、週線{sig.get('weeklyTrend') or '—'}（不能是空頭）"),
        ("macd", "轉弱" not in (sig.get("macd") or ""), f"MACD {sig.get('macd') or '—'}（不能轉弱）"),
        ("market", sig.get("marketRegime") != "BEAR", "大盤" + {"BULL": "多頭", "NEUTRAL": "盤整", "BEAR": "空頭"}.get(sig.get("marketRegime"), "—")),
        ("vol", vr is not None and vr >= VOL_MIN, f"量比 {f(vr, 2)} ≥ {VOL_MIN}"),
    ]


def evaluate(item, market, regime, stamp, now=None):
    """抓日 K、算訊號、核對。-> 結果 dict 或 None"""
    code = item["code"]
    try:
        rows = completed(parse_chart(_download(code, "1y"), market), market, now)
    except Exception as e:  # noqa: BLE001
        return {"code": code, "error": f"{type(e).__name__}"}
    finally:
        time.sleep(0.1)
    if len(rows) < MIN_BARS:
        return {"code": code, "error": f"只有 {len(rows)} 根日 K"}
    cg = item.get("cgPrice")
    if cg and rows[-1]["close"] and abs(rows[-1]["close"] / cg - 1) > 0.3:   # Yahoo 同名代號對到別的幣
        return {"code": code, "error": "Yahoo 代號對不到同一個幣"}
    sig = build_signals(code, market, "雷達", rows, regime, stamp)[-1]
    if not sig:
        return {"code": code, "error": "歷史不足"}
    ck = checks(sig)
    passed = sum(1 for _k, ok, _t in ck if ok)
    prev = sig.get("prevClose")
    return {
        "code": code, "name": item.get("name") or code, "market": market, "date": sig["date"],
        "close": sig["close"], "pct": (sig["close"] / prev - 1) * 100 if prev else None,
        "entryLow": sig["entryLow"], "entryHigh": sig["entryHigh"], "stop": sig["stop"], "target1": sig["target1"],
        "rr": sig.get("entryRR"), "rsi": sig.get("rsi14"), "volRatio": sig.get("volumeRatio"), "bias": sig.get("bias"),
        "zone": sig.get("zoneState"), "dailyTrend": sig.get("dailyTrend"), "weeklyTrend": sig.get("weeklyTrend"),
        "regime": sig.get("marketRegime"), "entrySignal": can_open_trade(sig, DEFAULT_PARAMS),
        "passed": passed, "total": len(ck), "checks": [{"k": k, "ok": ok, "t": t} for k, ok, t in ck],
    }


def rank(results):
    ok = [r for r in results if r and not r.get("error")]
    cands = [r for r in ok if r["entrySignal"] or (r["passed"] >= MIN_PASS and r["bias"] is not None and -1.5 <= r["bias"] <= 8)]
    cands.sort(key=lambda r: (not r["entrySignal"], -r["passed"], -(r["rr"] or 0)))
    return cands


def scan(market, pool, regime, stamp, watched, now=None):
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        results = list(ex.map(lambda it: evaluate(it, market, regime, stamp, now), pool))
    errs = [r for r in results if r and r.get("error")]
    cands = rank(results)
    for r in cands:
        r["watched"] = r["code"] in watched
        if r["watched"]:
            r["group"] = watched[r["code"]]
    return {"scanned": len(pool), "ok": len(results) - len(errs), "failed": len(errs),
            "failedSample": [f"{e['code']}：{e['error']}" for e in errs[:8]],
            "candidates": len(cands), "signals": sum(1 for r in cands if r["entrySignal"]),
            "picks": cands[:PICKS]}


def main(argv=None, now=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    only = argv[argv.index("--market") + 1].upper() if "--market" in argv else None
    now = now or datetime.now(timezone.utc)
    stamp = now.isoformat()
    universe = load_universe()
    watched = {c: m + "|" + t for c, (m, t) in universe.items()}
    out = {"generatedAt": stamp, "params": dict(DEFAULT_PARAMS, minPass=MIN_PASS, volMin=VOL_MIN, picks=PICKS),
           "note": "自動選股只是提示：用同一套進場規則核對，不會自動加入觀察名單，也不下單。", "errors": [], "markets": {}}
    pools = {"TW": tw_pool, "US": us_pool, "CRYPTO": crypto_pool}
    for market, fn in pools.items():
        if only and market != only:
            continue
        t0 = time.time()
        pool, desc = fn(out["errors"])
        if not pool:
            out["markets"][market] = {"universe": desc, "scanned": 0, "picks": []}
            continue
        try:
            regime = RegimeLookup(bars_of(MARKETS[market]["index"], market, now=now, use_cache=True))
        except Exception as e:  # noqa: BLE001
            out["errors"].append(f"{market} 大盤日 K 抓不到，大盤一律當盤整：{type(e).__name__}")
            regime = RegimeLookup([])
        res = scan(market, pool, regime, stamp, watched, now)
        res["universe"] = desc
        res["seconds"] = round(time.time() - t0)
        res["session"] = max((p["date"] for p in res["picks"]), default=None)
        out["markets"][market] = res
        print(f"{market}: 掃描 {res['scanned']}，成功 {res['ok']}，候選 {res['candidates']}（規則訊號 {res['signals']}），"
              f"{res['seconds']} 秒；前幾名：" + "、".join(f"{p['code']}({p['passed']}/{p['total']})" for p in res["picks"][:5]))
    if not any(m.get("ok") for m in out["markets"].values()):
        print("一檔都沒掃到，保留上一份 screener.json。", out["errors"])
        return 1
    if only:                                   # 只跑單一市場時，其他市場沿用上一份
        try:
            prev = json.loads((DATA / "screener.json").read_text(encoding="utf-8"))
            for k, v in (prev.get("markets") or {}).items():
                out["markets"].setdefault(k, v)
        except Exception:  # noqa: BLE001
            pass
    rnd = lambda o: round(o, 4) if isinstance(o, float) else o  # noqa: E731

    def deep(o):
        if isinstance(o, dict):
            return {k: deep(v) for k, v in o.items()}
        if isinstance(o, list):
            return [deep(v) for v in o]
        return rnd(o)
    (DATA / "screener.json").write_text(json.dumps(deep(out), ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
