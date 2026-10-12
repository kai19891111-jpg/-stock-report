"""Historical backtest over the downloaded daily bars.

1. Replays the entry rule day by day on every symbol (signal on close, fill next open,
   costs, gap-through-stop fills, time stop) and reports the earlier 70% of the period
   (in-sample) and the later 30% (out-of-sample) separately.
2. Random-entry benchmark: the same trades with the same stop/target distances, but entered
   on random days. In a rising market almost anything makes money, so the rule has to beat this.
3. Small parameter search: parameters are chosen on the in-sample part only and then
   checked on the out-of-sample part. The daily signals do not switch automatically.
4. Forward returns after each of the page's statuses (觀察進場 / 觀望 / 過熱 / 等待),
   compared with the average of all days.
5. Exit study for 過熱 (bias > 15%): sell at once vs hold until a close below SMA20.
6. The same trades per market (台股 / 美股 each with its own out-of-sample numbers and its own
   random-entry benchmark) and per market regime, so a signal is checked against its own market.
7. Room study: the target is close + 2.2 ATR, which can sit above the 20-day high. Trades are
   split by how much room there was up to that high, to see whether that matters.
"""
from __future__ import annotations
import json
import random
from datetime import datetime, timezone
from statistics import median
from indicators import wilson_ci
from marketdata import DATA, MARKETS, bars_of, load_universe
from strategy import (COSTS, DEFAULT_PARAMS, MAX_HOLD_DAYS, RegimeLookup, build_signals,
                      can_open_trade, open_trade, simulate_exit)

MIN_BARS = 80
MIN_SAMPLE = 30             # below this, no win rate is claimed
IS_FRACTION = 0.7
HORIZONS = (5, 10, 20)
BENCHMARK_DRAWS = 300
GRID = {
    "min_rr": [1.2, 1.5, 1.8],
    "vol_max": [None, 1.2, 0.8],
    "min_risk_pct": [None, 1.5, 2.5],
    "market": ["BULL_NEUTRAL", "all"],
}
EMPTY = {"sampleSize": 0, "wins": 0, "losses": 0, "winRate": None, "lossRate": None,
         "avgWinR": None, "avgLossR": None, "expectancyR": None, "expLow": None, "expHigh": None,
         "profitFactor": None, "maxDrawdownR": None, "medianR": None, "avgHoldingDays": None,
         "recent20WinRate": None, "recent50WinRate": None, "ciLow": None, "ciHigh": None}


def rounded(obj, nd=4):
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, dict):
        return {k: rounded(v, nd) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [rounded(v, nd) for v in obj]
    return obj


def bootstrap_mean_ci(vals, draws=1000, seed=12345):
    """95% interval for the mean by resampling trades (None when there are too few)."""
    n = len(vals)
    if n < 10:
        return None, None
    rnd = random.Random(seed)
    means = sorted(sum(rnd.choices(vals, k=n)) / n for _ in range(draws))
    return means[int(draws * 0.025)], means[int(draws * 0.975) - 1]


def stats_of(trades, ci=False):
    trades = sorted((t for t in trades if t.get("resultR") is not None), key=lambda t: t.get("exitDate") or "")
    n = len(trades)
    if not n:
        return dict(EMPTY)
    rs = [t["resultR"] for t in trades]
    wins = [r for r in rs if r > 0]
    losses = [r for r in rs if r <= 0]
    gp, gl = sum(wins), abs(sum(losses))
    peak = cum = max_dd = 0.0
    for r in rs:
        cum += r
        peak = max(peak, cum)
        max_dd = min(max_dd, cum - peak)
    lo, hi = wilson_ci(len(wins), n)
    e_lo, e_hi = bootstrap_mean_ci(rs) if ci else (None, None)

    def recent(k):
        sl = rs[-k:]
        return None if len(sl) < 5 else sum(1 for r in sl if r > 0) / len(sl)

    holds = [t["holdingDays"] for t in trades if t.get("holdingDays") is not None]
    max_single = max(rs, key=abs) if rs else None
    ex_max = None
    if n >= 10 and max_single is not None:
        rs_ex = [r for r in rs if r != max_single]
        if rs_ex:
            ex_max = sum(rs_ex) / len(rs_ex)
    return {
        "sampleSize": n, "wins": len(wins), "losses": len(losses),
        "winRate": len(wins) / n, "lossRate": len(losses) / n,
        "avgWinR": sum(wins) / len(wins) if wins else 0.0,
        "avgLossR": sum(losses) / len(losses) if losses else 0.0,
        "expectancyR": sum(rs) / n, "expLow": e_lo, "expHigh": e_hi,
        "profitFactor": (gp / gl) if gl else None,
        "maxDrawdownR": max_dd, "medianR": median(rs),
        "avgHoldingDays": (sum(holds) / len(holds)) if holds else None,
        "recent20WinRate": recent(20), "recent50WinRate": recent(50), "ciLow": lo, "ciHigh": hi,
        "maxSingleR": max_single,
        "expectancyExMaxR": ex_max,
    }


def load_all():
    """Bars and per-bar signals for every symbol (reuses bars fetched by update_market.py)."""
    regimes = {}
    for market, m in MARKETS.items():
        rows = []
        try:
            rows = bars_of(m["index"], market, use_cache=True)
        except Exception as e:  # noqa: BLE001
            print("warn: index", m["index"], "unavailable:", e)
        regimes[market] = RegimeLookup(rows)
    data = {}
    for symbol, (market, theme) in load_universe().items():
        try:
            rows = bars_of(symbol, market, use_cache=True)
        except Exception as e:  # noqa: BLE001
            print("skip", symbol, e)
            continue
        if len(rows) < MIN_BARS:
            continue
        data[symbol] = {"market": market, "theme": theme, "rows": rows,
                        "sigs": build_signals(symbol, market, theme, rows, regimes[market])}
    return data, regimes


def simulate(data, params):
    """Replay the rule on every symbol. One position per symbol at a time."""
    trades = []
    for d in data.values():
        rows, sigs, i = d["rows"], d["sigs"], 0
        while i < len(rows) - 1:
            sig = sigs[i]
            tr = open_trade(sig, rows[i + 1], params) if (sig and can_open_trade(sig, params)) else None
            if not tr:
                i += 1
                continue
            res = simulate_exit(tr["entryPrice"], tr["stopPrice"], tr["target1"], rows[i + 1:], d["market"])
            trades.append(tr)
            if not res:
                break                      # still open at the end of the data
            tr.update(res)
            i += res["holdingDays"]        # next signal can come from the exit session onward
    return trades
