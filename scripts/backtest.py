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
    vol = "不限" if p.get("vol_max") is None else f"≤{p['vol_max']}"
    risk = "不限" if p.get("min_risk_pct") is None else f"≥{p['min_risk_pct']}%"
    mkt = {"BULL_NEUTRAL": "多頭或盤整", "BULL": "多頭", "all": "不限"}.get(p.get("market"), p.get("market"))
    return f"報酬風險比≥{p['min_rr']}｜量比{vol}｜停損距離{risk}｜大盤{mkt}"


def search(data, split):
    """Pick parameters on the in-sample part only; report how they did out-of-sample."""
    rows = []
    for min_rr in GRID["min_rr"]:
        for vol_max in GRID["vol_max"]:
            for min_risk in GRID["min_risk_pct"]:
                for mkt in GRID["market"]:
                    p = dict(DEFAULT_PARAMS, min_rr=min_rr, vol_max=vol_max, min_risk_pct=min_risk, market=mkt)
                    tr = closed(simulate(data, p))
                    rows.append({"params": p,
                                 "insample": stats_of([t for t in tr if t["signalDate"] < split]),
                                 "oos": stats_of([t for t in tr if t["signalDate"] >= split])})
    ok = [r for r in rows if r["insample"]["sampleSize"] >= MIN_SAMPLE]
    if not ok:
        return None, rows
    return max(ok, key=lambda r: r["insample"]["expectancyR"]), rows


def random_entry_benchmark(data, trades, draws=BENCHMARK_DRAWS, seed=7):
    """Same symbols, same stop/target distances (in ATR), same costs and time stop - random entry days.

    Returns the spread of the average R over `draws` random portfolios and how many of them
    the real rule beat. If the rule is not clearly above this, its entries add nothing.
    """
    specs = [(t["symbol"], (t["entryPrice"] - t["stopPrice"]) / t["atr"], (t["target1"] - t["entryPrice"]) / t["atr"])
             for t in trades if t.get("atr")]
    if len(specs) < MIN_SAMPLE:
        return None
    eligible = {sym: [i for i, s in enumerate(d["sigs"][:-1]) if s] for sym, d in data.items()}
    rnd = random.Random(seed)
    means = []
    for _ in range(draws):
        tot, cnt = 0.0, 0
        for sym, k_stop, k_tgt in specs:
            d = data[sym]
            i = rnd.choice(eligible[sym])
            a, entry = d["sigs"][i]["atr14"], d["rows"][i + 1]["open"]
            res = simulate_exit(entry, entry - k_stop * a, entry + k_tgt * a, d["rows"][i + 1:], d["market"])
            if res:
                tot += res["resultR"]
                cnt += 1
        if cnt:
            means.append(tot / cnt)
    if not means:
        return None
    means.sort()
    actual = sum(t["resultR"] for t in trades) / len(trades)
    return {"draws": len(means), "trades": len(specs), "meanR": sum(means) / len(means),
            "p05": means[int(len(means) * 0.05)], "p95": means[int(len(means) * 0.95) - 1],
            "actualR": actual, "beats": sum(1 for m in means if m < actual) / len(means),
            "definition": "同樣的股票、同樣的停損停利距離與成本，但進場日隨機"}


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


def overheat_exit_study(data):
    """When a stock turns 過熱 (bias > 15%): what did holding on until a close below SMA20 add,
    compared with selling at the next open? Returns are % of that next open, before costs."""
    extra, days, dips, still_open = [], [], [], 0
    for d in data.values():
        rows, sigs, i, prev = d["rows"], d["sigs"], 0, None
        while i < len(rows) - 1:
            sig = sigs[i]
            st = sig["pageStatus"] if sig else None
            if st != "trim" or prev == "trim":
                prev = st
                i += 1
                continue
            start, base = i + 1, rows[i + 1]["open"]       # the "sell now" price
            j = start
            while j < len(rows) and not (sigs[j] and rows[j]["close"] < sigs[j]["ma20"]):
                j += 1
            if j + 1 >= len(rows):                          # never closed below SMA20 before the data ends
                still_open += 1
                break
            extra.append((rows[j + 1]["open"] / base - 1) * 100)
            days.append(j + 1 - start)
            dips.append((min(b["low"] for b in rows[start:j + 1]) / base - 1) * 100)
            prev, i = None, j + 1
    s = summarize(extra)
    return {
        "definition": "進入過熱後隔日開盤賣出，對比續抱到收盤跌破 SMA20 的隔日開盤才賣；數字是續抱多賺（或少賺）的百分比，未扣成本",
        "n": s["n"], "stillOpen": still_open, "meanExtra": s["mean"], "medianExtra": s["median"],
        "betterRate": s["hitRate"], "worstExtra": min(extra) if extra else None,
        "avgExtraDays": (sum(days) / len(days)) if days else None,
        "avgDeepestDip": (sum(dips) / len(dips)) if dips else None,
    }


def by_symbol(trades):
    tot = {}
    for t in trades:
        s = tot.setdefault(t["symbol"], {"symbol": t["symbol"], "n": 0, "totalR": 0.0})
        s["n"] += 1
        s["totalR"] += t["resultR"]
    ranked = sorted(tot.values(), key=lambda s: -s["totalR"])
    return {"totalR": sum(s["totalR"] for s in ranked), "top": ranked[:3], "bottom": ranked[-3:][::-1]}


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

    best, grid = search(data, split)
    if best is None:
        found = {"selected": None, "reason": f"樣本不足（前段沒有任何參數組合達到 {MIN_SAMPLE} 筆），不選最佳策略",
                 "unstable": False, "insample": stats_of(ins), "oos": stats_of(oos), "params": DEFAULT_PARAMS}
    else:
        o = best["oos"]
        thin = o["sampleSize"] < MIN_SAMPLE
        unstable = thin or (o["expectancyR"] or 0) <= 0
        found = {"selected": label_of(best["params"]),
                 "reason": "前段期望值最高的參數；" + ("後段樣本不足，尚不能確認" if thin else
                                                    "後段期望值為負，視為不穩定" if unstable else "後段期望值仍為正"),
                 "unstable": unstable, "insample": best["insample"], "oos": o, "params": best["params"]}
    found["sameAsDefault"] = all(found["params"].get(k) == DEFAULT_PARAMS.get(k) for k in DEFAULT_PARAMS)

    payload = {
        "updated": now, "source": "backtest.py", "isFinalClose": True,
        "meta": {"symbols": len(data), "from": first, "to": last, "splitDate": split,
                 "maxHoldDays": MAX_HOLD_DAYS, "costs": COSTS, "params": DEFAULT_PARAMS,
                 "paramsLabel": label_of(DEFAULT_PARAMS),
                 "openTrades": len(trades) - len(done), "minSample": MIN_SAMPLE},
        "marketRegime": {m: regimes[m].on(last) for m in MARKETS},
        "all": stats_of(done, ci=True), "insample": stats_of(ins, ci=True), "oos": stats_of(oos, ci=True),
        "live": stats_of(live),
        "benchmark": random_entry_benchmark(data, done),
        "bySymbol": by_symbol(done),
        "byRegime": {r: stats_of([t for t in done if t.get("marketRegime") == r]) for r in ("BULL", "NEUTRAL", "BEAR")},
        "byMarket": {m: stats_of([t for t in done if t.get("market") == m]) for m in MARKETS},
        "byTheme": {th: {"n": st["sampleSize"], "winRate": st["winRate"], "expectancyR": st["expectancyR"],
                         "profitFactor": st["profitFactor"]}
                    for th, st in ((th, stats_of(sl)) for th, sl in by_theme.items())},
        "byExit": by_exit, "similar": {},
        "search": {"candidates": len(grid), "selected": found["selected"], "reason": found["reason"],
                   "unstable": found["unstable"], "sameAsDefault": found["sameAsDefault"],
                   "insampleN": found["insample"]["sampleSize"], "insampleExpectancyR": found["insample"]["expectancyR"],
                   "oosN": found["oos"]["sampleSize"], "oosExpectancyR": found["oos"]["expectancyR"]},
        "pageRule": page_rule_study(data),
        "exitStudy": overheat_exit_study(data),
        "note": "insample＝前 70% 期間，oos＝後 30% 期間，兩者不混用；live＝實際逐日記錄的交易。N<30 不宣稱勝率。",
    }
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "strategy_stats.json").write_text(json.dumps(rounded(payload), ensure_ascii=False, indent=2), encoding="utf-8")
    (DATA / "backtest_trades.json").write_text(json.dumps(rounded(trades), ensure_ascii=False, indent=1), encoding="utf-8")

    found["candidates"] = [{"label": label_of(r["params"]), "insampleN": r["insample"]["sampleSize"],
                            "insampleExpectancyR": r["insample"]["expectancyR"], "oosN": r["oos"]["sampleSize"],
                            "oosExpectancyR": r["oos"]["expectancyR"]} for r in grid]
    found["note"] = "每日訊號仍使用 scripts/strategy.py 的預設參數；這裡只是對照，不會自動切換參數。"
    (DATA / "best_strategy.json").write_text(json.dumps(rounded(found), ensure_ascii=False, indent=2), encoding="utf-8")
    print("backtest done: symbols", len(data), "closed", len(done), "IS", len(ins), "OOS", len(oos), "split", split)


if __name__ == "__main__":
    main()
