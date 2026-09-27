"""Fetch Yahoo daily bars. Unique signals. Next-open fill. Final close only."""
from __future__ import annotations
import json, urllib.request
from datetime import datetime, timezone
from pathlib import Path
from indicators import sma, rsi, atr, macd_hist
from strategy import zone_state, daily_trend, market_regime, can_open_trade, resolve_trade

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
WATCH = {
    "NVDA": ("US", "AI晶片"), "AVGO": ("US", "AI晶片"), "TSM": ("US", "AI晶片"),
    "2330.TW": ("TW", "AI晶片"), "TSLA": ("US", "AI自駖"), "MU": ("US", "AI記憶體"),
    "3481.TW": ("TW", "面板／光電"), "6770.TW": ("TW", "AI記憶體"), "2221.TWO": ("TW", "半導體廠務"),
}
DEFAULT_PARAMS = {"rsi_lo": 45, "rsi_hi": 60, "min_rr": 1.8, "vol_min": None,
                  "dist_atr_max": 1.0, "macd": "not_weak", "weekly": "not_bear",
                  "market": "BULL_NEUTRAL"}

def load_json(path, default):
    p = DATA / path
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text(encoding="utf-8") or json.dumps(default))
    except Exception:
        return default

def save_json(path, obj):
    (DATA / path).write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")

def bars_of(symbol):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=2y"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 stock-report"})
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = json.loads(r.read().decode())
    res = raw["chart"]["result"][0]
    ts = res.get("timestamp") or []
    q = res["indicators"]["quote"][0]
    rows = []
    for i, t in enumerate(ts):
        d = datetime.fromtimestamp(t, tz=timezone.utc).date().isoformat()
        rows.append({"date": d, "open": q["open"][i], "high": q["high"][i],
                     "low": q["low"][i], "close": q["close"][i], "volume": q["volume"][i]})
    return rows

def main():
    signals = load_json("signals.json", [])
    trades = load_json("trades.json", [])
    existing_sig = {(s.get("date"), s.get("symbol")) for s in signals}
    existing_tr = {(t.get("symbol"), t.get("signalDate")) for t in trades}
    latest_quotes = {}
    now = datetime.now(timezone.utc).isoformat()
    for symbol, (market, theme) in WATCH.items():
        try:
            rows = bars_of(symbol)
        except Exception as e:
            print("skip", symbol, e)
            continue
        if len(rows) < 80:
            continue
        closes = [b["close"] for b in rows]
        highs = [b["high"] for b in rows]
        lows = [b["low"] for b in rows]
        vols = [b["volume"] or 0 for b in rows]
        ma20, ma60 = sma(closes, 20), sma(closes, 60)
        rsi14, atr14 = rsi(closes, 14), atr(highs, lows, closes, 14)
        _l, _s, hist = macd_hist(closes)
        vol_ma = sma(vols, 20)
        last, i = rows[-1], len(rows) - 1
        close, a = last["close"], atr14[i]
        entry_high = (ma20[i] * 1.01) if ma20[i] else None
        entry_low = (ma20[i] * 0.985) if ma20[i] else None
        stop = (ma20[i] - (a or 0) * 1.2) if ma20[i] else None
        target1 = (close + (a or 0) * 2.2) if a else None
        rr = None
        if entry_low and stop and target1 and entry_low > stop:
            risk = entry_low - stop
            if risk > 0:
                rr = (target1 - entry_low) / risk
        zs = zone_state(close, entry_low, entry_high, stop)
        dist_atr = ((close - entry_high) / a) if (a and a > 0 and entry_high is not None and close is not None) else None
        macd_txt = "零軸上" if (hist[i] or 0) >= 0 else "零軸下"
        if i > 1 and hist[i] is not None and hist[i - 1] is not None and hist[i] < hist[i - 1] < 0:
            macd_txt = "轉弱"
        vr = ((last["volume"] or 0) / vol_ma[i]) if vol_ma[i] else None
        sig = {
            "date": last["date"], "symbol": symbol, "market": market, "theme": theme,
            "open": last["open"], "high": last["high"], "low": last["low"], "close": close,
            "ma20": ma20[i], "ma60": ma60[i], "rsi14": rsi14[i], "macd": macd_txt,
            "volumeRatio": vr, "atr14": a, "dailyTrend": daily_trend(close, ma20[i], ma60[i]),
            "weeklyTrend": daily_trend(close, ma60[i], ma60[i]),
            "entryLow": entry_low, "entryHigh": entry_high, "maxEntry": entry_high,
            "stop": stop, "target1": target1, "target2": (target1 + (a or 0)) if target1 and a else None,
            "entryRR": rr, "zoneState": zs, "distanceATR": dist_atr,
            "conditionScore": None, "marketRegime": market_regime(close, ma20[i], ma60[i]),
            "themeTrend": None, "signal": "WATCH", "dataTimestamp": now,
            "isFinalClose": True, "source": "yahoo",
        }
        latest_quotes[symbol] = sig
        key = (sig["date"], sig["symbol"])
        if key not in existing_sig:
            signals.append(sig)
            existing_sig.add(key)
        if can_open_trade(sig, DEFAULT_PARAMS) and (symbol, sig["date"]) not in existing_tr:
            nxt = None
            for j, b in enumerate(rows):
                if b["date"] == sig["date"] and j + 1 < len(rows):
                    nxt = rows[j + 1]
                    break
            if nxt and nxt.get("open"):
                trades.append({
                    "id": f"{symbol}-{sig['date']}", "symbol": symbol,
                    "signalDate": sig["date"], "entryDate": nxt["date"],
                    "entryPrice": nxt["open"], "stopPrice": stop, "target1": target1,
                    "target2": sig["target2"], "rsi": sig["rsi14"], "macd": macd_txt,
                    "volumeRatio": vr, "atr": a, "dailyTrend": sig["dailyTrend"],
                    "weeklyTrend": sig["weeklyTrend"], "marketRegime": sig["marketRegime"],
                    "theme": theme, "status": "OPEN", "exitDate": None, "exitPrice": None,
                    "resultR": None, "resultPct": None, "holdingDays": None, "ambiguousDay": False,
                })
                existing_tr.add((symbol, sig["date"]))
        for tr in trades:
            if tr.get("symbol") != symbol or tr.get("status") != "OPEN":
                continue
            after = [b for b in rows if b["date"] > tr["entryDate"]]
            resolved = resolve_trade(tr["entryPrice"], tr["stopPrice"], tr["target1"], after)
            if resolved:
                tr.update(resolved)
    save_json("signals.json", signals)
    save_json("trades.json", trades)
    save_json("latest.json", {"dataTimestamp": now, "marketTimestamp": now, "source": "yahoo",
                               "isFinalClose": True, "quotes": latest_quotes})
    print("signals", len(signals), "trades", len(trades))

if __name__ == "__main__":
    main()
