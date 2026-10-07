"""Historical backtest over the downloaded daily bars.

1. Replays the entry rule day by day on every symbol (signal on close, fill next open,
   costs, gap-through-stop fills, time stop) and reports the earlier 70% of the period
   (in-sample) and the later 30% (out-of-sample) separately.
2. Small parameter search: parameters are chosen on the in-sample part only and then
   checked on the out-of-sample part.
3. Forward returns after each of the page's statuses (觀察進場 / 觀望 / 過熱 / 等待),
   compared with the average of all days.
"""
from __future__ import annotations
import json
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
GRID = {
    "rsi": [(45, 60), (40, 65), (40, 70)],
    "min_rr": [1.2, 1.5, 1.8],
    "market": ["BULL_NEUTRAL", "all"],
}
EMPTY = {"sampleSize": 0, "wins": 0, "losses": 0, "winRate": None, "lossRate": None,
         "avgWinR": None, "avgLossR": None, "expectancyR": None, "profitFactor": None,
         "maxDrawdownR": None, "medianR": None, "avgHoldingDays": None,
         "recent20WinRate": None, "recent50WinRate": None, "ciLow": None, "ciHigh": None}


def rounded(obj, nd=4):
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, dict):
        return {k: rounded(v, nd) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [rounded(v, nd) for v in obj]
    return obj


def stats_of(trades):
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

    def recent(k):
        sl = rs[-k:]
        return None if len(sl) < 5 else sum(1 for r in sl if r > 0) / len(sl)

    holds = [t["holdingDays"] for t in trades if t.get("holdingDays") is not None]
    return {
        "sampleSize": n, "wins": len(wins), "losses": len(losses),
        "winRate": len(wins) / n, "lossRate": len(losses) / n,
        "avgWinR": sum(wins) / len(wins) if wins else 0.0,
        "avgLossR": sum(losses) / len(losses) if losses else 0.0,
        "expectancyR": sum(rs) / n, "profitFactor": (gp / gl) if gl else None,
        "maxDrawdownR": max_dd, "medianR": median(rs),
        "avgHoldingDays": (sum(holds) / len(holds)) if holds else None,
        "recent20WinRate": recent(20), "recent50WinRate": recent(50), "ciLow": lo, "ciHigh": hi,
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
            tr = open_trade(sig, rows[i + 1]) if (sig and can_open_trade(sig, params)) else None
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


def split_date(data):
    dates = sorted({s["date"] for d in data.values() for s in d["sigs"] if s})
    return dates[int(len(dates) * IS_FRACTION)] if dates else None, (dates[0] if dates else None), (dates[-1] if dates else None)


def closed(trades):
    return [t for t in trades if t.get("status") in ("WIN", "LOSS") and t.get("resultR") is not None]


def label_of(p):
    return f"RSI {p['rsi_lo']}-{p['rsi_hi']}｜RR≥{p['min_rr']}｜大盤 {p['market']}"


def search(data, split):
    """Pick parameters on the in-sample part only; report how they did out-of-sample."""
    rows = []
    for lo, hi in GRID["rsi"]:
        for min_rr in GRID["min_rr"]:
            for mkt in GRID["market"]:
                p = dict(DEFAULT_PARAMS, rsi_lo=lo, rsi_hi=hi, min_rr=min_rr, market=mkt)
                tr = closed(simulate(data, p))
                rows.append({"params": p,
                             "insample": stats_of([t for t in tr if t["signalDate"] < split]),
                             "oos": stats_of([t for t in tr if t["signalDate"] >= split])})
    ok = [r for r in rows if r["insample"]["sampleSize"] >= MIN_SAMPLE]
    if not ok:
        return None, rows
    return max(ok, key=lambda r: r["insample"]["expectancyR"]), rows


def summarize(vals):
    if not vals:
        return {"n": 0, "mean": None, "median": None, "hitRate": None}
    return {"n": len(vals), "mean": sum(vals) / len(vals), "median": median(vals),
            "hitRate": sum(1 for v in vals if v > 0) / len(vals)}


def page_rule_study(data):
    """% return from the next open to the close N sessions after the signal day, by page status.

    Each status is counted once per streak (the day the status starts), so one long run of
    觀察進場 days is one sample, not twenty. The baseline is every day of every symbol.
    """
    acc = {s: {h: [] for h in HORIZONS} for s in ("go", "hold", "trim", "wait")}
    base = {h: [] for h in HORIZONS}
    for d in data.values():
        rows, sigs, prev = d["rows"], d["sigs"], None
        for i in range(len(rows) - 1):
            sig = sigs[i]
            if not sig or not sig.get("pageStatus"):
                prev = None
                continue
            st, entry = sig["pageStatus"], rows[i + 1]["open"]
            for h in HORIZONS:
                if i + h < len(rows) and entry:
                    r = (rows[i + h]["close"] / entry - 1) * 100
                    base[h].append(r)
                    if st != prev:
                        acc[st][h].append(r)
            prev = st
    return {
        "horizons": list(HORIZONS), "unit": "percent", "costsIncluded": False,
        "definition": "狀態開始當天收盤出訊號，隔日開盤進場，到訊號後第 N 個交易日收盤的報酬",
        "byStatus": {s: {str(h): summarize(v) for h, v in hs.items()} for s, hs in acc.items()},
        "baseline": {str(h): summarize(v) for h, v in base.items()},
    }


def main():
    now = datetime.now(timezone.utc).isoformat()
    data, regimes = load_all()
    if not data:
        raise SystemExit("no bars available; existing backtest files left untouched")
    split, first, last = split_date(data)
    trades = simulate(data, DEFAULT_PARAMS)
    done = closed(trades)
    ins = [t for t in done if t["signalDate"] < split]
    oos = [t for t in done if t["signalDate"] >= split]
    try:
        live = closed(json.loads((DATA / "trades.json").read_text(encoding="utf-8") or "[]"))
    except Exception:  # noqa: BLE001
        live = []

    by_theme = {}
    for t in done:
        by_theme.setdefault(t.get("theme") or "未分類", []).append(t)
    by_exit = {}
    for t in done:
        by_exit[t["exitReason"]] = by_exit.get(t["exitReason"], 0) + 1
    payload = {
        "updated": now, "source": "backtest.py", "isFinalClose": True,
        "meta": {"symbols": len(data), "from": first, "to": last, "splitDate": split,
                 "maxHoldDays": MAX_HOLD_DAYS, "costs": COSTS, "params": DEFAULT_PARAMS,
                 "openTrades": len(trades) - len(done), "minSample": MIN_SAMPLE},
        "marketRegime": {m: regimes[m].on(last) for m in MARKETS},
        "all": stats_of(done), "insample": stats_of(ins), "oos": stats_of(oos), "live": stats_of(live),
        "byRegime": {r: stats_of([t for t in done if t.get("marketRegime") == r]) for r in ("BULL", "NEUTRAL", "BEAR")},
        "byMarket": {m: stats_of([t for t in done if t.get("market") == m]) for m in MARKETS},
        "byTheme": {th: {"n": st["sampleSize"], "winRate": st["winRate"], "expectancyR": st["expectancyR"],
                         "profitFactor": st["profitFactor"]}
                    for th, st in ((th, stats_of(sl)) for th, sl in by_theme.items())},
        "byExit": by_exit, "similar": {},
        "pageRule": page_rule_study(data),
        "note": "insample＝前 70% 期間，oos＝後 30% 期間，兩者不混用；live＝實際逐日記錄的交易。N<30 不宣稱勝率。",
    }
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "strategy_stats.json").write_text(json.dumps(rounded(payload), ensure_ascii=False, indent=2), encoding="utf-8")
    (DATA / "backtest_trades.json").write_text(json.dumps(rounded(trades), ensure_ascii=False, indent=1), encoding="utf-8")

    best, grid = search(data, split)
    if best is None:
        out = {"selected": None, "reason": f"樣本不足（前段沒有任何參數組合達到 {MIN_SAMPLE} 筆），不選最佳策略",
               "unstable": False, "insample": payload["insample"], "oos": payload["oos"], "params": DEFAULT_PARAMS}
    else:
        o = best["oos"]
        thin = o["sampleSize"] < MIN_SAMPLE
        unstable = thin or (o["expectancyR"] or 0) <= 0
        out = {"selected": label_of(best["params"]),
               "reason": "前段期望值最高的參數；" + ("後段樣本不足，尚不能確認" if thin else
                                                  "後段期望值為負，視為不穩定" if unstable else "後段期望值仍為正"),
               "unstable": unstable, "insample": best["insample"], "oos": o, "params": best["params"]}
    out["candidates"] = [{"label": label_of(r["params"]), "insampleN": r["insample"]["sampleSize"],
                          "insampleExpectancyR": r["insample"]["expectancyR"], "oosN": r["oos"]["sampleSize"],
                          "oosExpectancyR": r["oos"]["expectancyR"]} for r in grid]
    out["note"] = "每日訊號仍使用預設參數；這裡只是對照，不會自動切換參數。"
    (DATA / "best_strategy.json").write_text(json.dumps(rounded(out), ensure_ascii=False, indent=2), encoding="utf-8")
    print("backtest done: symbols", len(data), "closed", len(done), "IS", len(ins), "OOS", len(oos), "split", split)


if __name__ == "__main__":
    main()