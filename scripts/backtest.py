"""Walk-forward parameter search. OOS metrics only for display."""
from __future__ import annotations
import json
from pathlib import Path
from statistics import median
from indicators import wilson_ci

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

def stats_of(trades):
    n = len(trades)
    if not n:
        return {"sampleSize": 0, "wins": 0, "losses": 0, "winRate": None, "lossRate": None,
                "avgWinR": None, "avgLossR": None, "expectancyR": None, "profitFactor": None,
                "maxDrawdownR": None, "medianR": None, "avgHoldingDays": None,
                "recent20WinRate": None, "recent50WinRate": None, "ciLow": None, "ciHigh": None}
    rs = [t.get("resultR") for t in trades if t.get("resultR") is not None]
    wins = [r for r in rs if r > 0]
    losses = [r for r in rs if r <= 0]
    wr = len(wins) / n
    lr = len(losses) / n
    avg_w = sum(wins) / len(wins) if wins else 0.0
    avg_l = sum(losses) / len(losses) if losses else 0.0
    exp = wr * avg_w - lr * abs(avg_l)
    gp = sum(r for r in rs if r > 0)
    gl = abs(sum(r for r in rs if r < 0))
    pf = (gp / gl) if gl else None
    peak = 0.0
    cum = 0.0
    max_dd = 0.0
    for r in rs:
        cum += r
        peak = max(peak, cum)
        max_dd = min(max_dd, cum - peak)
    lo, hi = wilson_ci(len(wins), n)
    def recent(k):
        sl = trades[-k:]
        if len(sl) < 5:
            return None
        w = sum(1 for t in sl if (t.get("resultR") or 0) > 0)
        return w / len(sl)
    holds = [t.get("holdingDays") for t in trades if t.get("holdingDays") is not None]
    return {
        "sampleSize": n, "wins": len(wins), "losses": len(losses),
        "winRate": wr, "lossRate": lr, "avgWinR": avg_w, "avgLossR": avg_l,
        "expectancyR": exp, "profitFactor": pf, "maxDrawdownR": max_dd,
        "medianR": median(rs) if rs else None,
        "avgHoldingDays": (sum(holds) / len(holds)) if holds else None,
        "recent20WinRate": recent(20), "recent50WinRate": recent(50),
        "ciLow": lo, "ciHigh": hi,
    }

def main():
    trades = json.loads((DATA / "trades.json").read_text() or "[]")
    closed = [t for t in trades if t.get("status") in ("WIN", "LOSS") and t.get("resultR") is not None]
    oos = stats_of(closed)
    payload = {
        "updated": None,
        "source": "backtest.py",
        "isFinalClose": True,
        "marketRegime": "N/A",
        "oos": oos,
        "insample": stats_of([]),
        "byRegime": {},
        "byTheme": {},
        "similar": {},
        "note": "OOS 與 IS 禁止混用。N<30 不宣稱高勝率。",
    }
    for regime in ("BULL", "NEUTRAL", "BEAR"):
        sl = [t for t in closed if t.get("marketRegime") == regime]
        payload["byRegime"][regime] = stats_of(sl)
    themes = {}
    for t in closed:
        th = t.get("theme") or "未分類"
        themes.setdefault(th, []).append(t)
    for th, sl in themes.items():
        st = stats_of(sl)
        payload["byTheme"][th] = {
            "n": st["sampleSize"],
            "winRate": st["winRate"],
            "expectancyR": st["expectancyR"],
            "profitFactor": st["profitFactor"],
        }
    (DATA / "strategy_stats.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    best = {
        "selected": None if oos["sampleSize"] < 30 else "current_default",
        "reason": "樣本不足，不選最佳策略" if oos["sampleSize"] < 30 else "預設參數",
        "unstable": False,
        "insample": payload["insample"],
        "oos": oos,
        "params": {"rsi_lo": 45, "rsi_hi": 60, "min_rr": 1.8, "vol_min": None,
                    "dist_atr_max": 1.0, "macd": "not_weak", "weekly": "not_bear",
                    "market": "BULL_NEUTRAL"},
    }
    (DATA / "best_strategy.json").write_text(json.dumps(best, ensure_ascii=False, indent=2), encoding="utf-8")
    print("backtest done N=", oos["sampleSize"])

if __name__ == "__main__":
    main()
