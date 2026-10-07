"""Daily update: completed Yahoo bars -> signals for every symbol on the page + live trade log.

Only sessions that have actually closed are used. Signals are rebuilt from the bars on
every run, so a bad snapshot can never get stuck in signals.json.
"""
from __future__ import annotations
import json
from datetime import datetime, timezone
from marketdata import DATA, MARKETS, bars_of, load_universe
from strategy import (DEFAULT_PARAMS, MIN_HISTORY, RegimeLookup, build_signals,
                      can_open_trade, open_trade, simulate_exit)

KEEP_SESSIONS = 20      # sessions of signals kept in signals.json
LIVE_LOOKBACK = 5       # sessions scanned for new live trades (covers a few missed runs)
MIN_BARS = 80


def load_json(name, default):
    p = DATA / name
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text(encoding="utf-8") or json.dumps(default))
    except Exception:  # noqa: BLE001
        return default


def rounded(obj, nd=4):
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, dict):
        return {k: rounded(v, nd) for k, v in obj.items()}
    if isinstance(obj, list):
        return [rounded(v, nd) for v in obj]
    return obj


def save_json(name, obj):
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / name).write_text(json.dumps(rounded(obj), ensure_ascii=False, indent=2), encoding="utf-8")


def load_regimes(now=None):
    regimes, index_info = {}, {}
    for market, m in MARKETS.items():
        rows = []
        try:
            rows = bars_of(m["index"], market, now=now)
        except Exception as e:  # noqa: BLE001
            print("warn: index", m["index"], "unavailable, regime falls back to NEUTRAL:", e)
        regimes[market] = RegimeLookup(rows)
        if rows:
            index_info[market] = {"symbol": m["index"], "date": rows[-1]["date"], "close": rows[-1]["close"],
                                  "regime": regimes[market].on(rows[-1]["date"])}
    return regimes, index_info


def update_live_trades(trades, symbol, market, rows, sigs):
    """Resolve open trades, then open new ones from the most recent signals (one per symbol at a time)."""
    idx = {b["date"]: i for i, b in enumerate(rows)}

    def resolve():
        for tr in trades:
            if tr.get("symbol") != symbol or tr.get("status") != "OPEN":
                continue
            start = idx.get(tr.get("entryDate"))
            if start is None:
                continue
            res = simulate_exit(tr["entryPrice"], tr["stopPrice"], tr["target1"], rows[start:], market)
            if res:
                tr.update(res)

    resolve()
    known = {(t.get("symbol"), t.get("signalDate")) for t in trades}
    for j in range(max(MIN_HISTORY, len(rows) - 1 - LIVE_LOOKBACK), len(rows) - 1):
        sig = sigs[j]
        if not sig or (symbol, sig["date"]) in known:
            continue
        if any(t.get("symbol") == symbol and t.get("status") == "OPEN" for t in trades):
            break
        last_exit = max((t.get("exitDate") or "" for t in trades if t.get("symbol") == symbol), default="")
        if sig["date"] < last_exit or not can_open_trade(sig, DEFAULT_PARAMS):
            continue
        tr = open_trade(sig, rows[j + 1])
        if tr:
            trades.append(tr)
            known.add((symbol, sig["date"]))
            resolve()


def main(now=None):
    universe = load_universe()
    stamp = (now or datetime.now(timezone.utc)).isoformat()
    regimes, index_info = load_regimes(now)
    trades = load_json("trades.json", [])
    signals, latest, skipped = [], {}, []
    for symbol, (market, theme) in universe.items():
        try:
            rows = bars_of(symbol, market, now=now)
        except Exception as e:  # noqa: BLE001
            print("skip", symbol, e)
            skipped.append(symbol)
            continue
        if len(rows) < MIN_BARS:
            print("skip", symbol, "only", len(rows), "bars")
            skipped.append(symbol)
            continue
        sigs = build_signals(symbol, market, theme, rows, regimes[market], stamp)
        if sigs[-1]:
            latest[symbol] = sigs[-1]
        signals.extend(s for s in sigs[-KEEP_SESSIONS:] if s)
        update_live_trades(trades, symbol, market, rows, sigs)
    if not latest:
        raise SystemExit("no market data fetched; existing data files left untouched")
    signals.sort(key=lambda s: (s["date"], s["symbol"]))
    sessions = {m: max((q["date"] for q in latest.values() if q["market"] == m), default=None) for m in MARKETS}
    save_json("signals.json", signals)
    save_json("trades.json", trades)
    save_json("latest.json", {"dataTimestamp": stamp, "marketTimestamp": stamp, "source": "yahoo",
                              "isFinalClose": True, "sessions": sessions, "indices": index_info,
                              "skipped": skipped, "quotes": latest})
    print("symbols", len(latest), "signals", len(signals), "trades", len(trades), "skipped", skipped)


if __name__ == "__main__":
    main()