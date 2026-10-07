"""Entry rules and trade simulation. Signal on T close; fill next open. No look-ahead.

The same functions feed the daily signal file, the live trade log and the backtest,
so what the backtest measures is exactly the rule that produces today's signals.
"""
from __future__ import annotations
from bisect import bisect_right
from datetime import date
from indicators import sma, rsi, atr, macd_hist

DEFAULT_PARAMS = {"rsi_lo": 45, "rsi_hi": 60, "min_rr": 1.8, "vol_min": None,
                  "dist_atr_max": 1.0, "macd": "not_weak", "weekly": "not_bear",
                  "market": "BULL_NEUTRAL"}

MAX_HOLD_DAYS = 20          # time stop: close the trade at this session's close
MIN_HISTORY = 60            # bars needed before a signal is produced (SMA60)
NEAR_HIGH_PCT = 1.0         # "貼近 20 日高": within this % of the 20-day high
MIN_RISK_ATR = 0.5          # a stop closer than this many ATR gives a meaningless reward/risk ratio

# Round-trip costs per market, as fractions of price.
# TW: 0.1425% broker fee each side + 0.3% transaction tax on the sell. Odd-lot minimum fees are not modelled.
COSTS = {
    "TW": {"fee": 0.001425, "sell_tax": 0.003, "slip": 0.0005},
    "US": {"fee": 0.0, "sell_tax": 0.0, "slip": 0.0005},
}


def zone_state(price, entry_low, entry_high, invalid_price):
    if price is None or entry_low is None or entry_high is None:
        return "NO_DATA"
    if invalid_price is not None and price <= invalid_price:
        return "INVALIDATED"
    if price < entry_low:
        return "BELOW_ZONE"
    if entry_low <= price <= entry_high:
        return "IN_ZONE"
    return "ABOVE_ZONE"


def daily_trend(close, ma20, ma60):
    if close is None or ma20 is None:
        return None
    if close < ma20 and (ma60 is None or ma20 < ma60):
        return "空頭"
    if close > ma20 and (ma60 is None or ma20 > ma60):
        return "多頭"
    return "盤整"


def market_regime(index_close, ma20, ma60):
    if index_close is None or ma20 is None or ma60 is None:
        return "NEUTRAL"
    if index_close > ma20 > ma60:
        return "BULL"
    if index_close < ma20 < ma60:
        return "BEAR"
    return "NEUTRAL"


def weekly_trend_series(rows):
    """Weekly trend for every daily bar, from weekly closes known on that day (10/30-week averages)."""
    out, done, cur_key, cur_close = [], [], None, None
    for b in rows:
        y, m, d = (int(x) for x in b["date"].split("-"))
        key = tuple(date(y, m, d).isocalendar())[:2]
        if cur_key is not None and key != cur_key:
            done.append(cur_close)
        cur_key, cur_close = key, b["close"]
        weeks = done[-29:] + [cur_close]
        w10 = sum(weeks[-10:]) / 10 if len(weeks) >= 10 else None
        w30 = sum(weeks) / 30 if len(weeks) >= 30 else None
        out.append(daily_trend(cur_close, w10, w30))
    return out


class RegimeLookup:
    """Market regime of an index (加權 / Nasdaq) on or before a given date."""

    def __init__(self, index_rows):
        closes = [b["close"] for b in index_rows]
        m20, m60 = sma(closes, 20), sma(closes, 60)
        self.dates = [b["date"] for b in index_rows]
        self.values = [market_regime(c, m20[i], m60[i]) for i, c in enumerate(closes)]

    def on(self, date_iso):
        i = bisect_right(self.dates, date_iso) - 1
        return self.values[i] if i >= 0 else "NEUTRAL"


def page_status(close, ma20, high20):
    """The report page's three-condition status: go / hold / trim / wait."""
    if close is None or ma20 is None or ma20 <= 0:
        return None
    bias = (close / ma20 - 1) * 100
    if bias > 15:
        return "trim"
    if bias < 0:
        return "wait"
    near = bool(high20) and (high20 - close) / high20 * 100 < NEAR_HIGH_PCT
    return "go" if (bias <= 6 and not near) else "hold"


def build_signals(symbol, market, theme, rows, regime, stamp=None):
    """One signal per completed bar (None until there is enough history)."""
    closes = [b["close"] for b in rows]
    highs = [b["high"] for b in rows]
    lows = [b["low"] for b in rows]
    vols = [b["volume"] or 0 for b in rows]
    ma20, ma60 = sma(closes, 20), sma(closes, 60)
    rsi14, atr14 = rsi(closes, 14), atr(highs, lows, closes, 14)
    _line, _sig, hist = macd_hist(closes)
    vol_ma = sma(vols, 20)
    weekly = weekly_trend_series(rows)
    out = []
    for i, b in enumerate(rows):
        a, m20, m60 = atr14[i], ma20[i], ma60[i]
        if i < MIN_HISTORY - 1 or m20 is None or m60 is None or not a:
            out.append(None)
            continue
        close = b["close"]
        entry_high, entry_low = m20 * 1.01, m20 * 0.985
        stop = m20 - a * 1.2
        target1 = close + a * 2.2
        # Reward and risk are both measured from the same reference price (the signal close).
        rr = (target1 - close) / (close - stop) if (close - stop) >= a * MIN_RISK_ATR else None
        macd_txt = "零軸上" if (hist[i] or 0) >= 0 else "零軸下"
        if hist[i] is not None and hist[i - 1] is not None and hist[i] < hist[i - 1] < 0:
            macd_txt = "轉弱"
        high20 = max(highs[i - 19:i + 1])
        out.append({
            "date": b["date"], "symbol": symbol, "market": market, "theme": theme,
            "open": b["open"], "high": b["high"], "low": b["low"], "close": close,
            "ma20": m20, "ma60": m60, "rsi14": rsi14[i], "macd": macd_txt,
            "volumeRatio": (vols[i] / vol_ma[i]) if vol_ma[i] else None, "atr14": a,
            "dailyTrend": daily_trend(close, m20, m60), "weeklyTrend": weekly[i],
            "entryLow": entry_low, "entryHigh": entry_high, "maxEntry": entry_high,
            "stop": stop, "target1": target1, "target2": target1 + a,
            "entryRR": rr, "zoneState": zone_state(close, entry_low, entry_high, stop),
            "distanceATR": (close - entry_high) / a,
            "high20": high20, "bias": (close / m20 - 1) * 100,
            "pageStatus": page_status(close, m20, high20),
            "conditionScore": None, "marketRegime": regime.on(b["date"]),
            "themeTrend": None, "signal": "WATCH", "dataTimestamp": stamp,
            "isFinalClose": True, "source": "yahoo",
        })
    return out


def can_open_trade(sig, params):
    if sig.get("zoneState") != "IN_ZONE":
        return False
    if (sig.get("dailyTrend") or "").find("空") >= 0:
        return False
    weekly = params.get("weekly", "not_bear")
    wt = sig.get("weeklyTrend") or ""
    if weekly == "not_bear" and "空" in wt:
        return False
    if weekly == "bull_only" and "多" not in wt:
        return False
    rr = sig.get("entryRR")
    if rr is None or rr < params.get("min_rr", 1.8):
        return False
    if rr <= 0:
        return False
    stop = sig.get("stop")
    entry_ref = sig.get("close")
    target = sig.get("target1")
    if stop is None or entry_ref is None or target is None:
        return False
    if stop >= entry_ref or target <= entry_ref:
        return False
    r = sig.get("rsi14")
    lo, hi = params.get("rsi_lo", 40), params.get("rsi_hi", 70)
    if r is None or not (lo <= r <= hi):
        return False
    vmin = params.get("vol_min")
    if vmin is not None and (sig.get("volumeRatio") is None or sig["volumeRatio"] < vmin):
        return False
    macd_rule = params.get("macd", "any")
    if macd_rule == "not_weak" and (sig.get("macd") or "").find("轉弱") >= 0:
        return False
    if macd_rule == "above_zero" and (sig.get("macd") or "").find("零軸上") < 0:
        return False
    dist = sig.get("distanceATR")
    dmax = params.get("dist_atr_max")
    if dmax is not None and dist is not None and dist > dmax:
        return False
    mkt = params.get("market", "all")
    regime = sig.get("marketRegime")
    if mkt == "BULL" and regime != "BULL":
        return False
    if mkt == "BULL_NEUTRAL" and regime not in ("BULL", "NEUTRAL"):
        return False
    return True


def open_trade(sig, next_bar):
    """Enter at the open of the session after the signal. None if that open is already past stop/target."""
    entry = next_bar.get("open")
    if entry is None or not (sig["stop"] < entry < sig["target1"]):
        return None
    return {
        "id": f"{sig['symbol']}-{sig['date']}", "symbol": sig["symbol"], "market": sig["market"],
        "signalDate": sig["date"], "entryDate": next_bar["date"], "entryPrice": entry,
        "stopPrice": sig["stop"], "target1": sig["target1"], "target2": sig["target2"],
        "rsi": sig["rsi14"], "macd": sig["macd"], "volumeRatio": sig["volumeRatio"], "atr": sig["atr14"],
        "dailyTrend": sig["dailyTrend"], "weeklyTrend": sig["weeklyTrend"],
        "marketRegime": sig["marketRegime"], "theme": sig["theme"], "status": "OPEN",
        "exitDate": None, "exitPrice": None, "exitReason": None, "resultR": None, "resultPct": None,
        "holdingDays": None, "ambiguousDay": False,
    }


def net_profit(entry, exit_px, market):
    """Profit per share after fees, tax and slippage."""
    c = COSTS.get(market, COSTS["US"])
    paid = entry * (1 + c["slip"] + c["fee"])
    got = exit_px * (1 - c["slip"] - c["fee"] - c["sell_tax"])
    return got - paid


def simulate_exit(entry_price, stop, target, bars, market, max_hold=MAX_HOLD_DAYS):
    """Walk forward from the entry session (bars[0]). Returns the exit, or None while still open.

    - A gap open through the stop fills at the open, not at the stop price.
    - If one bar touches both stop and target, the stop is assumed to come first.
    - After `max_hold` sessions the trade is closed at that session's close.
    """
    if entry_price is None or stop is None or target is None:
        return None
    risk = entry_price - stop
    if risk <= 0:
        return None
    for i, b in enumerate(bars):
        o, h, l, c = b.get("open"), b.get("high"), b.get("low"), b.get("close")
        if h is None or l is None or c is None:
            continue
        amb = False
        if i > 0 and o is not None and o <= stop:
            exit_px, reason = o, "gap_stop"
        elif i > 0 and o is not None and o >= target:
            exit_px, reason = o, "gap_target"
        elif l <= stop:
            exit_px, reason, amb = stop, "stop", h >= target
        elif h >= target:
            exit_px, reason = target, "target"
        elif i + 1 >= max_hold:
            exit_px, reason = c, "time"
        else:
            continue
        profit = net_profit(entry_price, exit_px, market)
        return {
            "status": "WIN" if profit > 0 else "LOSS",
            "exitDate": b.get("date"), "exitPrice": exit_px, "exitReason": reason,
            "resultR": profit / risk, "resultPct": profit / entry_price * 100,
            "holdingDays": i + 1, "ambiguousDay": amb,
        }
    return None