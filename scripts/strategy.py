"""Entry rules. Signal on T close; fill next open. No look-ahead."""
from __future__ import annotations

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
    rsi = sig.get("rsi14")
    lo, hi = params.get("rsi_lo", 40), params.get("rsi_hi", 70)
    if rsi is None or not (lo <= rsi <= hi):
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

def resolve_trade(entry_price, stop, target, bars):
    if entry_price is None or stop is None or target is None:
        return None
    risk = entry_price - stop
    if risk <= 0:
        return None
    for i, b in enumerate(bars):
        hit_stop = b.get("low") is not None and b["low"] <= stop
        hit_tgt = b.get("high") is not None and b["high"] >= target
        if hit_stop and hit_tgt:
            exit_px, status, amb = stop, "LOSS", True
        elif hit_stop:
            exit_px, status, amb = stop, "LOSS", False
        elif hit_tgt:
            exit_px, status, amb = target, "WIN", False
        else:
            continue
        profit = exit_px - entry_price
        return {
            "status": status,
            "exitDate": b.get("date"),
            "exitPrice": exit_px,
            "resultR": profit / risk,
            "resultPct": profit / entry_price * 100 if entry_price else None,
            "holdingDays": i + 1,
            "ambiguousDay": amb,
        }
    return None
