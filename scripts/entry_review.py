"""入場時機重評 -> data/entry_review.json

每檔依「日線＋週線結構」重新算兩種入場方式，每個價位都寫出依據（哪一個擺盪高低點、哪一條均線、幾倍 ATR）：

  回檔承接：最近一個「仍在收盤下方」的支撐（擺盪低點／均線）上方 0.5 ATR 當觀察區，
            確認條件＝曾碰區間後收盤站回 MA5、收盤高於前一日高點、量比 >= 1.0。
  突破入場：收盤上方最近的壓力（擺盪高點／MA20／MA60）當觸發價，
            要「收盤站上＋量比 >= 1.5＋收在當日區間上 1/3」；週線空頭、壓力是下彎 MA60、
            或突破當天已超過觸發價 1 ATR 時，改成「等回測不破再進」。
  結構失效價：回檔＝支撐下方 0.5 ATR；突破＝觸發價下方最近的擺盪低點（沒有就用觸發價 − 1.5 ATR）。
  目標價：進場價上方第一、第二個壓力；上方已沒有紀錄內的壓力時，才用「進場價 + 3 ATR」並寫明。

狀態只有六種：條件已成立／等待回檔／等待突破確認／過熱不追價／結構轉弱／資料不足。
價格進了區間但確認條件沒過，不會標成已成立；大盤空頭、財報前 3 個交易日內也不會標成已成立。

不連網路：在 GitHub Actions 裡接在 update_market.py 後面跑，直接讀它剛抓好的日 K 快取（2 年）。
本機測試可以設 REVIEW_BARS=某個 {代號: [日K...]} 的 JSON 檔。
這是條件核對，不是買賣建議，不自動下單。
"""
from __future__ import annotations

import json
import os
from datetime import date, datetime, timezone
from pathlib import Path

from indicators import atr, rsi, sma
from strategy import daily_trend

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

P = {
    "pivot_k": 3,            # 日線擺盪點：左右各 3 根
    "wpivot_k": 2,           # 週線擺盪點：左右各 2 根
    "lookback": 120,         # 日線支撐壓力看最近 120 根
    "wlookback": 52,         # 週線看最近 52 週
    "merge_atr": 0.3,        # 相距 0.3 ATR 內的價位合併成一個
    "zone_atr": 0.5,         # 回檔觀察區寬度
    "stop_buf_atr": 0.5,     # 失效價放在支撐下方的緩衝（0.5 ATR，避開正常波動的假跌破）
    "brk_vol": 1.5,          # 突破量比
    "pb_vol": 1.0,           # 回檔確認量比
    "extended_atr": 1.0,     # 突破當天超過觸發價幾倍 ATR 就要等回測
    "hot_atr": 2.5,          # 收盤高於 MA20 幾倍 ATR 算過熱
    "hot_bias": 15.0,
    "hot_rsi": 75.0,
    "near_brk_atr": 2.0,     # 離觸發價幾倍 ATR 內才算「等待突破確認」
    "min_rr": 1.5,
    "earn_days": 3,
    "min_bars": 20,
}
STATUS = ["ready", "pullback", "breakout", "hot", "weak", "nodata"]
LABEL = {"ready": "條件已成立", "pullback": "等待回檔", "breakout": "等待突破確認",
         "hot": "過熱不追價", "weak": "結構轉弱", "nodata": "資料不足"}


def load(name, default=None):
    try:
        return json.loads((DATA / name).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def r(x, nd=2):
    return None if x is None else round(float(x), nd)


def pivots(rows, k, lookback, tag):
    """擺盪高低點（左右各 k 根都比它低／高）。最後 k 根還沒被確認，不算。"""
    rows = rows[-lookback:]
    hi, lo = [], []
    for i in range(k, len(rows) - k):
        h, l = rows[i]["high"], rows[i]["low"]
        if h is None or l is None:
            continue
        win = rows[i - k:i + k + 1]
        if all(h >= (b["high"] or -1) for b in win):
            hi.append({"price": h, "why": f"{tag}擺盪高點 {rows[i]['date']}"})
        if all(l <= (b["low"] or 1e18) for b in win):
            lo.append({"price": l, "why": f"{tag}擺盪低點 {rows[i]['date']}"})
    return hi, lo


def weekly(rows):
    out, key = [], None
    for b in rows:
        y, m, d = (int(x) for x in b["date"].split("-"))
        k = tuple(date(y, m, d).isocalendar())[:2]
        if k != key:
            out.append(dict(b, date=b["date"]))
            key = k
        else:
            w = out[-1]
            w["high"] = max(w["high"], b["high"])
            w["low"] = min(w["low"], b["low"])
            w["close"] = b["close"]
            w["volume"] = (w.get("volume") or 0) + (b.get("volume") or 0)
    return out


def merge(levels, gap):
    levels = sorted(levels, key=lambda x: x["price"])
    out = []
    for lv in levels:
        if out and abs(lv["price"] - out[-1]["price"]) <= gap:
            out[-1]["why"] += "＋" + lv["why"]
            continue
        out.append(dict(lv))
    return out


def trading_days_until(d_iso, today_iso):
    try:
        a = date.fromisoformat(today_iso)
        b = date.fromisoformat(d_iso)
    except (TypeError, ValueError):
        return None
    if b < a:
        return None
    n, cur = 0, a
    while cur < b:
        cur = date.fromordinal(cur.toordinal() + 1)
        if cur.weekday() < 5:
            n += 1
    return n


def plan_rr(entry, stop, t1, t2):
    risk = entry - stop if entry is not None and stop is not None else None
    if not risk or risk <= 0:
        return None, None
    rr1 = (t1["price"] - entry) / risk if t1 else None
    rr2 = (t2["price"] - entry) / risk if t2 else None
    return r(rr1), r(rr2)


def targets_above(res, price, a):
    ups = [x for x in res if x["price"] >= price + 0.5 * a]
    t1 = ups[0] if ups else {"price": price + 3 * a, "why": "紀錄內上方已無壓力，用進場價 + 3 ATR"}
    t2 = ups[1] if len(ups) > 1 else {"price": max(t1["price"], price) + 2 * a,
                                       "why": "第一目標上方已無紀錄內壓力，用第一目標 + 2 ATR"}
    return t1, t2


def review(sym, rows, q, regime, earn):
    """一檔的重評。rows＝完成日 K（舊到新），q＝latest.json 這檔的那一列（做為補充與交叉核對）。"""
    n = len(rows)
    base = {"symbol": sym, "bars": n, "date": rows[-1]["date"] if rows else (q or {}).get("date")}
    if n < P["min_bars"] or not q:
        return dict(base, status="nodata", label=LABEL["nodata"],
                    why=[f"可用日 K 只有 {n} 根（至少要 {P['min_bars']} 根），不算價位。"])
    c = [b["close"] for b in rows]
    h = [b["high"] for b in rows]
    lw = [b["low"] for b in rows]
    v = [b.get("volume") or 0 for b in rows]
    last = rows[-1]
    close = last["close"]
    if q.get("date") == last["date"] and q.get("close") and abs(q["close"] / close - 1) > 0.001:
        base["mismatch"] = f"收盤和 latest.json 不一致：{close} vs {q['close']}"

    def pick(series, key):     # 自己算得出來就用自己算的；歷史不夠才用 latest.json（腳本用 2 年日 K 算的）
        val = series[-1] if series and series[-1] is not None else None
        return (val, "calc") if val is not None else (q.get(key), "latest.json")

    ma5, _ = pick(sma(c, 5), "ma5")
    ma20, _ = pick(sma(c, 20), "ma20")
    ma60, src60 = pick(sma(c, 60), "ma60")
    a, _ = pick(atr(h, lw, c, 14), "atr14")
    rs = rsi(c, 14)
    rsi_now, _ = pick(rs, "rsi14")
    rsi_prev = rs[-2] if len(rs) > 1 else None
    vavg = sma(v, 20)
    vr = (v[-1] / vavg[-2]) if len(vavg) > 1 and vavg[-2] else q.get("volumeRatio")
    if not a or not ma20:
        return dict(base, status="nodata", label=LABEL["nodata"], why=["ATR 或 MA20 算不出來。"])
    ma20_prev = sma(c, 20)[-6] if n >= 25 else None
    ma20_up = (ma20_prev is not None and ma20 > ma20_prev)
    d_trend = daily_trend(close, ma20, ma60)
    w_trend = q.get("weeklyTrend")
    wk = weekly(rows)
    if len(wk) >= 30:
        wc = [x["close"] for x in wk]
        w10, w30 = sum(wc[-10:]) / 10, sum(wc[-30:]) / 30
        w_trend = daily_trend(wc[-1], w10, w30)

    # ---- 支撐壓力 ------------------------------------------------------------
    dh, dl = pivots(rows, P["pivot_k"], P["lookback"], "日線")
    wh, wl = pivots(wk, P["wpivot_k"], P["wlookback"], "週線") if len(wk) >= 10 else ([], [])
    levels = dh + dl + wh + wl
    levels.append({"price": ma20, "why": "MA20" + ("（上彎）" if ma20_up else "（下彎）")})
    if ma60:
        levels.append({"price": ma60, "why": "MA60" + ("" if src60 == "calc" else "（2 年日 K 算的）")})
    lo20 = min(lw[-20:])
    hi20 = max(h[-20:])
    levels.append({"price": hi20, "why": "近 20 日高"})
    levels.append({"price": lo20, "why": "近 20 日低"})
    for x in levels:      # 角色互換：跌破的前低變壓力、突破的前高變支撐
        if "擺盪低點" in x["why"] and x["price"] > close:
            x["why"] += "（跌破後轉壓力）"
        elif "擺盪高點" in x["why"] and x["price"] < close:
            x["why"] += "（突破後轉支撐）"
    gap = P["merge_atr"] * a
    res = merge([x for x in levels if x["price"] > close + 0.2 * a], gap)
    sup = merge([x for x in levels if x["price"] < close], gap)[::-1]     # 由近到遠

    out = dict(base, close=r(close), ma5=r(ma5), ma20=r(ma20), ma60=r(ma60), atr=r(a), rsi=r(rsi_now, 1),
               volRatio=r(vr), dailyTrend=d_trend, weeklyTrend=w_trend, marketRegime=regime,
               bias20=r((close / ma20 - 1) * 100), historyNote=None)
    if n < 130:
        out["historyNote"] = f"支撐壓力只取得到最近 {n} 根日 K（約 {len(wk)} 週）；MA60 與週線趨勢取自 latest.json（2 年日 K）。"

    # ---- 回檔承接 --------------------------------------------------------------
    pb = None
    if sup:
        s1 = sup[0]
        z_lo, z_hi = s1["price"], min(s1["price"] + P["zone_atr"] * a, close)
        stop = s1["price"] - P["stop_buf_atr"] * a
        entry = (z_lo + z_hi) / 2
        t1, t2 = targets_above(res, max(entry, close), a)
        rr1, rr2 = plan_rr(entry, stop, t1, t2)
        touched = min(lw[-3:]) <= z_hi
        conf = {
            "touch": touched,
            "aboveMA5": close > ma5 if ma5 else False,
            "abovePrevHigh": close > rows[-2]["high"],
            "volume": (vr or 0) >= P["pb_vol"],
            "rsiUp": rsi_now is not None and rsi_prev is not None and rsi_now > rsi_prev,
        }
        pb = {"zone": [r(z_lo), r(z_hi)], "zoneWhy": f"{s1['why']} {r(s1['price'])} 到上方 {P['zone_atr']} ATR",
              "confirm": "近 3 日最低碰到區間，之後收盤站回 MA5、收盤高於前一日高點、量比 ≥ 1.0、RSI 回升",
              "confirmState": conf, "entry": r(entry), "entryWhy": "區間中點",
              "stop": r(stop), "stopWhy": f"{s1['why']} 下方 {P['stop_buf_atr']} ATR",
              "t1": r(t1["price"]), "t1Why": t1["why"], "t2": r(t2["price"]), "t2Why": t2["why"],
              "rr1": rr1, "rr2": rr2}
    # ---- 突破入場 --------------------------------------------------------------
    bk = None
    if res:
        r1 = res[0]
        trig = r1["price"]
        lows_below = [x for x in sup if x["price"] < trig - 0.2 * a]
        if lows_below:
            stop, stop_why = lows_below[0]["price"] - P["stop_buf_atr"] * a, lows_below[0]["why"] + f" 下方 {P['stop_buf_atr']} ATR"
        else:
            stop, stop_why = trig - 1.5 * a, "觸發價 − 1.5 ATR（下方沒有紀錄內的支撐）"
        t1, t2 = targets_above(res[1:], trig, a)
        rr1, rr2 = plan_rr(trig, stop, t1, t2)
        need_retest = []
        if w_trend == "空頭":
            need_retest.append("週線空頭")
        if "MA60" in r1["why"] and ma60 and ma20 and ma20 < ma60:
            need_retest.append("觸發價是下彎的 MA60")
        bk = {"trigger": r(trig), "triggerWhy": r1["why"],
              "volume": f"量比 ≥ {P['brk_vol']}（以 20 日均量計），收盤在當日區間上 1/3",
              "retest": bool(need_retest), "retestWhy": "、".join(need_retest) or "突破當天若超過觸發價 1 ATR 才需等回測",
              "entry": r(trig), "entryWhy": "以觸發價計",
              "stop": r(stop), "stopWhy": stop_why,
              "t1": r(t1["price"]), "t1Why": t1["why"], "t2": r(t2["price"]), "t2Why": t2["why"],
              "rr1": rr1, "rr2": rr2, "distATR": r((trig - close) / a)}
    out["pullback"], out["breakout"] = pb, bk

    # ---- 狀態 ------------------------------------------------------------------
    why = []
    blockers = []
    if regime == "BEAR":
        blockers.append("大盤空頭（指數收在 MA20、MA60 之下）")
    if earn and earn.get("days") is not None and earn["days"] <= P["earn_days"]:
        blockers.append(f"財報 {earn['date']}，{earn['days']} 個交易日內")
    new_low = min(lw[-3:]) <= lo20 + 1e-9
    below_swing = bool(dl) and close < dl[-1]["price"]
    deep = close < ma20 - 0.5 * a
    # 結構轉弱：收盤在 MA20 與 MA60 之下，而且 MA20 下彎、收盤離 MA20 超過 0.5 ATR，
    # 或近 3 日創 20 日新低、或跌破最近的日線擺盪低點。剛好貼著 MA20 下方、沒破低的，算「等待突破確認」。
    under = close < ma20 and (ma60 is None or close < ma60)
    broke = under and ((not ma20_up and deep) or new_low or below_swing)
    hot = (close - ma20) > P["hot_atr"] * a or (out["bias20"] or 0) > P["hot_bias"] or (rsi_now or 0) > P["hot_rsi"]
    brk_today = False
    # 今天是否就是突破日：收盤站上「昨天以前」的最近壓力
    prev_res = merge([x for x in levels if x["price"] > rows[-2]["close"] + 0.2 * a and x["price"] <= close], gap)
    rng = (last["high"] - last["low"]) or 1e-9
    if prev_res:
        lv = prev_res[-1]["price"]
        if (vr or 0) >= P["brk_vol"] and (close - last["low"]) / rng >= 2 / 3:
            brk_today = True
            ext = (close - lv) > P["extended_atr"] * a
            out["breakoutToday"] = {"level": r(lv), "why": prev_res[-1]["why"], "extended": ext}

    if hot:
        st = "hot"
        why.append(f"收盤 {r(close)} 高於 MA20 {r(ma20)} 共 {r((close - ma20) / a, 1)} ATR／乖離 {out['bias20']}%／RSI {out['rsi']}，等回到 {pb['zone'] if pb else 'MA20'} 再看。")
    elif broke:
        st = "weak"
        reason = ("近 3 日創 20 日新低" if new_low else "收盤跌破最近的日線擺盪低點" if below_swing
                  else f"MA20 下彎、收盤在 MA20 下方 {r((ma20 - close) / a, 1)} ATR")
        why.append(f"收盤在 MA20、MA60 之下，且{reason}；先等止跌：不再破低、收盤站回 MA5，再看能否站上 MA20 {r(ma20)}。")
    else:
        ready_pb = bool(pb) and all(pb["confirmState"].values()) and (pb["rr1"] or 0) >= P["min_rr"]
        ready_bk = brk_today and not out.get("breakoutToday", {}).get("extended") and w_trend != "空頭"
        if (ready_pb or ready_bk) and not blockers:
            st = "ready"
            why.append("回檔確認條件全部成立。" if ready_pb else "今天帶量收盤突破，未過度延伸。")
        elif ready_pb or ready_bk:
            st = "breakout" if ready_bk else "pullback"
            why.append("技術條件成立，但被擋：" + "、".join(blockers) + "，先不標成已成立。")
        elif pb and pb["confirmState"]["touch"]:
            st = "pullback"
            miss = [k for k, ok in pb["confirmState"].items() if not ok]
            names = {"aboveMA5": "收盤站回 MA5", "abovePrevHigh": "收盤高於前一日高", "volume": "量比 ≥ 1.0", "rsiUp": "RSI 回升", "touch": "碰到區間"}
            why.append("價格已在回檔區間，但還缺：" + "、".join(names[k] for k in miss) + "。")
            if pb["rr1"] is not None and pb["rr1"] < P["min_rr"]:
                why.append(f"以區間中點計報酬風險比 {pb['rr1']}，低於 {P['min_rr']}。")
        elif bk and bk["distATR"] is not None and bk["distATR"] <= P["near_brk_atr"] and (d_trend != "多頭" or close < ma20):
            st = "breakout"
            why.append(f"收盤在觸發價 {bk['trigger']}（{bk['triggerWhy']}）下方 {bk['distATR']} ATR，等帶量站上" + ("後回測不破。" if bk["retest"] else "。"))
            if bk["rr1"] is not None and bk["rr1"] < P["min_rr"]:
                why.append(f"以觸發價計報酬風險比只有 {bk['rr1']}（失效價在 {bk['stop']}），突破當下也不追；要等突破後回測形成更高的低點再重算。")
        else:
            st = "pullback"
            why.append(f"結構未破、價格不在區間，等回到 {pb['zone']}（{pb['zoneWhy']}）。" if pb else "下方沒有紀錄內的支撐，不設回檔區。")
    if blockers:
        why.append("擋板：" + "、".join(blockers) + "。")
    out.update(status=st, label=LABEL[st], why=why, blockers=blockers)
    return out


def bars_from_env():
    p = os.environ.get("REVIEW_BARS")
    return json.loads(Path(p).read_text(encoding="utf-8")) if p else None


def main():
    latest = load("latest.json", {}) or {}
    risk = load("risk.json", {}) or {}
    notes = load("entry_review_notes.json", {}) or {}
    quotes = latest.get("quotes") or {}
    regimes = {m: (x or {}).get("regime") for m, x in (latest.get("indices") or {}).items()}
    local = bars_from_env()
    if local is None:
        from marketdata import bars_of, load_universe
        uni = load_universe()
    else:
        try:
            from marketdata import load_universe
            uni = load_universe()
        except Exception:  # noqa: BLE001
            uni = {s: (q.get("market"), q.get("theme")) for s, q in quotes.items()}
    out = {}
    for sym, (mkt, theme) in uni.items():
        q = quotes.get(sym)
        try:
            rows = local.get(sym, []) if local is not None else bars_of(sym, mkt, use_cache=True)
            rows = [b for b in rows if b.get("high") is not None and b.get("low") is not None and b.get("close")]
        except Exception as e:  # noqa: BLE001
            rows = []
            print("warn: no bars", sym, e)
        e = ((risk.get("symbols") or {}).get(sym) or {}).get("items", {}).get("earnings") or {}
        today = rows[-1]["date"] if rows else None
        earn = None
        if e.get("date") and today:
            earn = {"date": e["date"], "days": trading_days_until(e["date"], today)}
        rv = review(sym, rows, q, regimes.get(mkt), earn)
        rv.update(market=mkt, theme=theme)
        if earn:
            rv["earnings"] = earn
        out[sym] = rv
    counts = {k: sum(1 for x in out.values() if x["status"] == k) for k in STATUS}
    doc = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dataTimestamp": latest.get("dataTimestamp"),
        "sessions": latest.get("sessions"),
        "source": latest.get("source"),
        "isFinalClose": latest.get("isFinalClose"),
        "historyMode": "local-reconstruction" if local is not None else "actions-2y",
        "params": P, "labels": LABEL, "order": STATUS, "counts": counts,
        "regimes": regimes,
        "notes": notes,
        "symbols": out,
    }
    (DATA / "entry_review.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print("entry_review:", counts)


if __name__ == "__main__":
    main()
