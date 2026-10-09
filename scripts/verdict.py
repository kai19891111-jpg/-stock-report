"""最終指示：把規則訊號、回測證據、風險分數合成「每檔一行」 -> data/verdict.json

讀 data/latest.json（行情與規則訊號）、data/strategy_stats.json（回測）、data/risk.json（風險分數）。
不連網路，只用標準函式庫；缺哪一份就少那一項，不會中斷。

每檔只會落在下面其中一類：

  go               可進場            規則訊號成立＋該市場回測證據達標＋風險沒有擋
  signal_unproven  有訊號，回測未達標  規則訊號成立、風險沒擋，但回測證據沒過
  signal_blocked   有訊號，風險沒過    規則訊號成立，但財報 3 日內／處置／注意股／風險中以上
  conditions       在進場區，等條件    價格到位了，還卡 RSI、MACD 等條件
  pullback         等回檔              離均線不遠（乖離 6% 以內），等收盤回到「買進上限價」
  no_chase         不追                乖離超過 6%
  below            均線之下            收盤低於進場區或已破失效價
  trend            趨勢不對            日線、週線或大盤是空頭
  avoid            不碰                處置股或注意股
  nodata           資料不足

「規則訊號」完全沿用 scripts/strategy.py 的 can_open_trade，這裡只是把沒過的條件逐條寫出來，
每次執行都會和 latest.json 的 entrySignal 互相核對；不一致時以 entrySignal 為準並記在 selfCheck。

這是條件核對，不是買賣建議，不自動下單。
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("VERDICT_DATA_DIR") or (ROOT / "data"))

# ---- 門檻：要調整只改這裡 ---------------------------------------------------
V = {
    "beats_min": 0.95,          # 回測要勝過多少比例的隨機進場（和 entry-gate.js 一致）
    "near_bias_max": 6.0,       # 乖離在這以內算「等回檔」，超過算「不追」
    "hot_bias": 15.0,           # 過熱
    "room_warn": 1.0,           # 到 20 日高的空間不到幾倍風險就提醒
}
MKT = {"TW": "台股", "US": "美股"}
REGIME = {"BULL": "多頭", "NEUTRAL": "盤整", "BEAR": "空頭"}
ORDER = ["go", "signal_unproven", "signal_blocked", "conditions", "pullback", "no_chase", "below", "trend", "avoid", "nodata"]
LABEL = {
    "go": "可進場", "signal_unproven": "有訊號，回測未達標", "signal_blocked": "有訊號，風險沒過",
    "conditions": "在進場區，等條件", "pullback": "等回檔", "no_chase": "不追",
    "below": "均線之下，等站回", "trend": "趨勢不對，不進場", "avoid": "不碰", "nodata": "資料不足",
}
ICON = {"go": "🟢", "signal_unproven": "🟡", "signal_blocked": "🔴", "conditions": "🔎", "pullback": "⏳",
        "no_chase": "✋", "below": "⬇", "trend": "⬇", "avoid": "⛔", "nodata": "⚪"}


# =============================================================================
# 小工具
# =============================================================================
def load(name):
    try:
        return json.loads((DATA / name).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v


def px(v, market):
    """和頁面一樣的價格寫法：美股固定兩位小數，台股最多兩位。"""
    if not num(v):
        return "—"
    if market == "US":
        return f"{v:,.2f}"
    s = f"{v:,.2f}"
    return s.rstrip("0").rstrip(".") if "." in s else s


def pct(v, nd=1):
    return "—" if not num(v) else ("+" if v > 0 else "−" if v < 0 else "") + f"{abs(v):.{nd}f}%"


def r_txt(v):
    return "—" if not num(v) else ("+" if v > 0 else "−" if v < 0 else "") + f"{abs(v):.2f}R"


# =============================================================================
# 規則條件逐條列出（和 strategy.can_open_trade 同一套、同一個順序）
# =============================================================================
def blockers(q, p):
    out = []

    def add(key, text):
        out.append({"key": key, "text": text})

    zone = q.get("zoneState")
    if zone != "IN_ZONE":
        add("zone", {"ABOVE_ZONE": "價格高於進場區", "BELOW_ZONE": "價格低於進場區",
                     "INVALIDATED": "收盤已跌破失效價"}.get(zone, "沒有進場區資料"))
    if "空" in (q.get("dailyTrend") or ""):
        add("daily", "日線空頭")
    weekly, wt = p.get("weekly", "not_bear"), q.get("weeklyTrend") or ""
    if weekly == "not_bear" and "空" in wt:
        add("weekly", "週線空頭")
    if weekly == "bull_only" and "多" not in wt:
        add("weekly", "週線不是多頭")
    rr, min_rr = q.get("entryRR"), p.get("min_rr", 1.8)
    if rr is None:
        add("rr", "報酬風險比算不出來")
    elif rr < min_rr or rr <= 0:
        add("rr", f"報酬風險比 {rr:.2f}（要 ≥{min_rr}）")
    stop, close, target = q.get("stop"), q.get("close"), q.get("target1")
    if stop is None or close is None or target is None:
        add("levels", "價位不完整")
    elif stop >= close or target <= close:
        add("levels", "收盤不在失效價和目標價之間")
    r, lo, hi = q.get("rsi14"), p.get("rsi_lo", 40), p.get("rsi_hi", 70)
    if r is None:
        add("rsi", "RSI 沒有資料")
    elif not (lo <= r <= hi):
        add("rsi", f"RSI {r:.0f}（要 {lo}–{hi}）")
    vr = q.get("volumeRatio")
    vmin, vmax = p.get("vol_min"), p.get("vol_max")
    if vmin is not None and (vr is None or vr < vmin):
        add("volume", f"量比 {vr:.2f}（要 ≥{vmin}）" if vr is not None else "量比沒有資料")
    if vmax is not None and (vr is None or vr > vmax):
        add("volume", f"量比 {vr:.2f}（要 ≤{vmax}）" if vr is not None else "量比沒有資料")
    min_risk = p.get("min_risk_pct")
    if min_risk is not None and num(stop) and num(close) and close and (close - stop) / close * 100 < min_risk:
        add("risk_pct", f"停損距離 {(close - stop) / close * 100:.1f}%（要 ≥{min_risk}%）")
    macd_rule, macd = p.get("macd", "any"), q.get("macd") or ""
    if macd_rule == "not_weak" and "轉弱" in macd:
        add("macd", "MACD 轉弱")
    if macd_rule == "above_zero" and "零軸上" not in macd:
        add("macd", "MACD 不在零軸上")
    dist, dmax = q.get("distanceATR"), p.get("dist_atr_max")
    if dmax is not None and dist is not None and dist > dmax:
        add("distance", f"離進場區 {dist:.1f} 倍 ATR（上限 {dmax}）")
    mkt, regime = p.get("market", "all"), q.get("marketRegime")
    if mkt == "BULL" and regime != "BULL":
        add("regime", "大盤不是多頭")
    if mkt == "BULL_NEUTRAL" and regime not in ("BULL", "NEUTRAL"):
        add("regime", "大盤空頭")
    return out


# =============================================================================
# 回測證據（每個市場各看各的；沒有分市場統計時退回全部市場）
# =============================================================================
def evidence(stats, market):
    if not stats:
        return {"ok": False, "scope": None, "why": "讀不到回測資料"}
    md = (stats.get("byMarketDetail") or {}).get(market)
    scope = MKT.get(market, market) if md else "全部市場"
    src = md or stats
    st, b = src.get("oos") or {}, src.get("benchmark")
    min_n = (stats.get("meta") or {}).get("minSample") or 30
    n = st.get("sampleSize") or 0
    floor = st.get("expLow") if num(st.get("expLow")) else st.get("expectancyR")
    beats = (b or {}).get("beats")
    fails = []
    if n < min_n:
        fails.append(f"後段只有 {n} 筆（要 {min_n} 筆）")
    if not num(floor):
        fails.append("期望值算不出來")
    elif floor <= 0:
        fails.append(f"期望值區間下緣 {r_txt(floor)}，沒有大於 0")
    if not num(beats):
        fails.append("沒有隨機進場對照")
    elif beats < V["beats_min"]:
        fails.append(f"只勝過 {beats:.1%} 的隨機進場（要 {V['beats_min']:.0%}）")
    good = f"後段期望值 {r_txt(st.get('expectancyR'))}（{n} 筆），勝過 {beats:.1%} 的隨機進場" if not fails else ""
    return {"ok": not fails, "scope": scope, "n": n, "expectancyR": st.get("expectancyR"), "expLow": st.get("expLow"),
            "expHigh": st.get("expHigh"), "winRate": st.get("winRate"), "beats": beats,
            "why": scope + "回測：" + ("、".join(fails) if fails else good)}


def regime_note(stats, market, regime):
    """目前大盤狀態下，這條規則過去的表現（只在樣本夠的時候講）。"""
    if not stats or regime not in REGIME:
        return None
    md = (stats.get("byMarketDetail") or {}).get(market)
    st = ((md or stats).get("byRegime") or {}).get(regime) or {}
    min_n = (stats.get("meta") or {}).get("minSample") or 30
    if (st.get("sampleSize") or 0) < min_n or not num(st.get("expectancyR")):
        return None
    scope = MKT.get(market, market) if md else "全部市場"
    return {"regime": regime, "n": st["sampleSize"], "expectancyR": st["expectancyR"], "expLow": st.get("expLow"),
            "text": f"大盤{REGIME[regime]}時，這條規則在{scope}的期望值是 {r_txt(st['expectancyR'])}（{st['sampleSize']} 筆）"}


def room_note(stats, room):
    """到 20 日高的空間不足時，附上回測裡同類訊號的表現（樣本夠才講）。"""
    if not stats or not num(room):
        return None
    min_n = (stats.get("meta") or {}).get("minSample") or 30
    for b in (stats.get("roomStudy") or {}).get("buckets") or []:
        if b.get("key") == "lt1" and room < 1 and (b.get("sampleSize") or 0) >= min_n and num(b.get("expectancyR")):
            return f"回測裡這類訊號的期望值是 {r_txt(b['expectancyR'])}（{b['sampleSize']} 筆）"
    return None


# =============================================================================
# 一檔的最終指示
# =============================================================================
def decide(sym, q, params, stats, risk_sym, max_hold):
    m = q.get("market")
    close, ma20, stop, target = q.get("close"), q.get("ma20"), q.get("stop"), q.get("target1")
    lo, hi, bias, high20 = q.get("entryLow"), q.get("entryHigh"), q.get("bias"), q.get("high20")
    base = {"market": m, "date": q.get("date"), "close": close, "ma20": ma20, "stop": stop, "target": target,
            "entryLow": lo, "entryHigh": hi, "bias": bias, "high20": high20, "rr": q.get("entryRR")}
    if not all(num(v) for v in (close, ma20, stop, target, lo, hi)):
        return dict(base, code="nodata", signal=False, blockers=[], text="行情或價位不完整，今天不判斷。", notes=[])

    bl = blockers(q, params)
    signal = not bl
    mismatch = isinstance(q.get("entrySignal"), bool) and q["entrySignal"] != signal
    if mismatch:                                   # 以規則本身為準
        signal = q["entrySignal"]
        bl = [] if signal else (bl or [{"key": "rule", "text": "規則沒有成立"}])

    min_rr = params.get("min_rr", 1.5)
    # 「買進上限價」：收盤要同時在進場區內、而且報酬風險比達標。目標價是收盤加固定幾倍 ATR，
    # 所以報酬風險比達標等於「收盤 ≤ 失效價 + (目標 − 收盤) ÷ 門檻」。
    buy_below = min(hi, stop + (target - close) / min_rr) if target > close else None
    if buy_below is not None and buy_below <= max(lo, stop):
        buy_below = None
    gap = (buy_below / close - 1) * 100 if buy_below else None
    room = (high20 - close) / (close - stop) if (num(high20) and close > stop) else None

    r = risk_sym or {}
    flags, gate = r.get("flags") or [], r.get("gate") or {}
    items = r.get("items") or {}
    ev = evidence(stats, m)
    notes = []

    keys = {b["key"] for b in bl}
    if signal:
        code = "signal_blocked" if gate.get("block") else ("go" if ev["ok"] else "signal_unproven")
    elif "disposition" in flags or "attention" in flags:
        code = "avoid"
    elif q.get("zoneState") in ("BELOW_ZONE", "INVALIDATED"):
        code = "below"
    elif keys & {"daily", "weekly", "regime"}:
        code = "trend"
    elif q.get("zoneState") == "IN_ZONE":
        code = "conditions"
    elif num(bias) and bias > V["near_bias_max"]:
        code = "no_chase"
    else:
        code = "pullback"

    plan = None
    others = [b["text"] for b in bl if b["key"] not in ("zone", "rr", "distance")]
    if signal:
        plan = {"entry": "下一個交易日開盤", "openLow": stop, "openHigh": target, "stop": stop, "target": target,
                "maxHoldDays": max_hold, "riskPerShare": close - stop}
        how = (f"下一個交易日開盤買；開盤價要在 {px(stop, m)}～{px(target, m)} 之間，否則不買。"
               f"停損 {px(stop, m)}、目標 {px(target, m)}，最多抱 {max_hold} 個交易日。")
        if code == "go":
            text = how
        elif code == "signal_unproven":
            text = "規則訊號成立，但回測證據沒過。照規則的做法是：" + how
        else:
            text = "規則訊號成立，但" + "、".join(gate.get("reasons") or ["風險沒過"]) + "，不進場。"
        if not ev["ok"] or code == "go":
            notes.append(ev["why"])
        rn = regime_note(stats, m, q.get("marketRegime"))
        if rn:
            notes.append(rn["text"])
        if num(room) and room < V["room_warn"]:
            extra = room_note(stats, room)
            notes.append(f"目標 {px(target, m)} 高於 20 日高 {px(high20, m)}；到前高的空間只有 {room:.2f} 倍風險"
                         + ("。" + extra if extra else ""))
    elif code == "avoid":
        why = (items.get("chips") or {}).get("why") or ("處置股" if "disposition" in flags else "注意股")
        text = why + "，不碰。"
    elif code == "below":
        text = ("收盤已跌破失效價 " + px(stop, m) + "，不進場。" if q.get("zoneState") == "INVALIDATED"
                else f"收盤 {px(close, m)} 低於進場區下緣 {px(lo, m)}，等收盤站回 {px(lo, m)} 以上再看訊號。")
    elif code == "trend":
        text = "、".join(b["text"] for b in bl if b["key"] in ("daily", "weekly", "regime")) + "，不進場。"
    elif code == "conditions":
        text = "價格已在進場區，還卡：" + "、".join(b["text"] for b in bl) + "。"
    elif code == "no_chase":
        hot = "過熱，" if num(bias) and bias > V["hot_bias"] else ""
        text = f"{hot}乖離 {pct(bias)}，不追。" + (f"收盤回到 {px(buy_below, m)} 以下（還差 {pct(gap)}）才會進入進場區。" if buy_below else "")
    else:  # pullback
        text = (f"等收盤回到 {px(buy_below, m)} 以下（還差 {pct(gap)}）再看訊號。" if buy_below
                else "離進場區不遠，但今天算不出買進上限價，等明天重算。")
    if code in ("pullback", "below") and others:
        text += "目前另外還卡：" + "、".join(others) + "。"

    earn = items.get("earnings") or {}
    if earn.get("score") in (1, 2):
        notes.append(earn.get("why"))
    if r and r.get("level") == "insufficient":
        notes.append(f"風險分數資料不足（只評了 {r.get('scored', 0)} 項）")
    if not r:
        notes.append("沒有風險分數")

    return dict(base, code=code, signal=signal, blockers=bl, buyBelow=buy_below, gapPct=gap, roomRR=room, plan=plan,
                text=text, notes=[n for n in notes if n], mismatch=mismatch or None,
                risk={"level": r.get("level"), "total": r.get("total"), "max": r.get("max"),
                      "reasons": gate.get("reasons") or []} if r else None,
                hold=hold_line(q, m, earn))


def hold_line(q, m, earn):
    """已經持有時怎麼看：全部用當天重算的均線與失效價，不寫死任何價位。"""
    close, ma20, stop, bias = q.get("close"), q.get("ma20"), q.get("stop"), q.get("bias")
    if close <= stop:
        code, text = "exit", f"收盤已跌破失效價 {px(stop, m)}，規則上這個部位已經失效，出場優先。"
    elif num(bias) and bias > V["hot_bias"]:
        code, text = "hot", (f"過熱（乖離 {pct(bias)}），不加碼。出場參考：收盤跌破 SMA20（{px(ma20, m)}），"
                             f"目前在它上方 {(close / ma20 - 1) * 100:.1f}%。失效價 {px(stop, m)}。")
    elif close < ma20:
        code, text = "watch", (f"收盤在 SMA20（{px(ma20, m)}）之下，還沒破失效價 {px(stop, m)}"
                               f"（距離 {(1 - stop / close) * 100:.1f}%）。收盤跌破失效價就是出場優先。")
    else:
        code, text = "keep", (f"續抱。失效價 {px(stop, m)}（距離 {(1 - stop / close) * 100:.1f}%），收盤跌破就是出場優先。"
                              "要加碼的話，條件和新進場一樣。")
    if earn.get("score") in (1, 2) and earn.get("why"):
        text += earn["why"] + "。"
    return {"code": code, "text": text}


# =============================================================================
# 資料檢查
# =============================================================================
def data_checks(latest, stats, risk, quotes):
    out = []

    def add(level, text):
        out.append({"level": level, "text": text})

    sessions, indices = latest.get("sessions") or {}, latest.get("indices") or {}
    for m, name in MKT.items():
        idx, ses = indices.get(m) or {}, sessions.get(m)
        if idx.get("date") and ses and idx["date"] < ses:
            add("warn", f"{name}大盤指數 {idx.get('symbol', '')} 停在 {idx['date']}，個股已是 {ses}；大盤多空是用舊的指數判斷的。")
        elif not idx.get("date") and ses:
            add("warn", f"{name}大盤指數沒有抓到，大盤多空以「盤整」計。")
    old = [s for s, q in quotes.items() if q.get("date") and sessions.get(q.get("market")) and q["date"] < sessions[q["market"]]]
    if old:
        add("warn", "這幾檔的日 K 不是最後一個交易日：" + "、".join(sorted(old)))
    if latest.get("skipped"):
        add("warn", "這幾檔今天沒有抓到行情：" + "、".join(latest["skipped"]))
    if not stats:
        add("warn", "讀不到回測統計，所有訊號都會被標成「回測未達標」。")
    elif not stats.get("byMarketDetail"):
        add("info", "回測還沒有分市場統計，暫時用全部市場的數字核對。")
    if not risk:
        add("warn", "讀不到風險分數（data/risk.json），最終指示沒有把財報、處置股、籌碼算進去。")
    else:
        if latest.get("dataTimestamp") and risk.get("generatedAt") and risk["generatedAt"] < latest["dataTimestamp"]:
            add("warn", "風險分數比行情舊，可能是上一次的結果。")
        ev = risk.get("events") or {}
        if not ev.get("fresh"):
            add("warn", "事件檔 events.json 超過 14 天沒更新，政策與財報事件沒有算進去。")
        syms = risk.get("symbols") or {}
        have = sum(1 for v in syms.values() if ((v.get("items") or {}).get("earnings") or {}).get("date"))
        if syms and have < len(syms):
            add("info", f"財報日只填了 {have}／{len(syms)} 檔，其餘沒辦法提醒財報前風險。")
        for k, s in (risk.get("sources") or {}).items():
            if s.get("skipped"):
                add("info", s["skipped"])
            elif s.get("fail") and not s.get("ok"):
                add("warn", f"資料來源 {k} 這次完全沒抓到。")
        thin = sum(1 for v in syms.values() if v.get("level") == "insufficient")
        if thin:
            add("info", f"{thin} 檔的風險分數資料不足（有分數的項目少於 3 項）。")
    return out


def self_check(quotes, params):
    """把這裡的逐條判斷和規則本身比一次；有 strategy.py 可以匯入時，連最近 20 個交易日的訊號一起比。"""
    res = {"checked": 0, "mismatch": []}
    for s, q in quotes.items():
        if isinstance(q.get("entrySignal"), bool):
            res["checked"] += 1
            if (not blockers(q, params)) != q["entrySignal"]:
                res["mismatch"].append(f"{s} {q.get('date')}")
    try:
        from strategy import can_open_trade      # 同一個資料夾
        for sig in load("signals.json") or []:
            res["checked"] += 1
            if (not blockers(sig, params)) != can_open_trade(sig, params):
                res["mismatch"].append(f"{sig.get('symbol')} {sig.get('date')}")
    except Exception as e:  # noqa: BLE001
        res["note"] = "沒有比對歷史訊號：" + str(e)[:80]
    res["mismatch"] = sorted(set(res["mismatch"]))[:20]
    return res


# =============================================================================
# 主流程
# =============================================================================
def main(now=None):
    now = now or datetime.now(timezone.utc)
    latest = load("latest.json")
    if not latest or not latest.get("quotes"):
        raise SystemExit("讀不到 data/latest.json 的 quotes，verdict.json 不更新")
    stats, risk = load("strategy_stats.json"), load("risk.json")
    params = latest.get("params") or (stats or {}).get("meta", {}).get("params") or {}
    max_hold = ((stats or {}).get("meta") or {}).get("maxHoldDays") or 20
    quotes = {s: q for s, q in latest["quotes"].items() if isinstance(q, dict) and q.get("market") in MKT}
    rs = (risk or {}).get("symbols") or {}

    symbols = {s: decide(s, q, params, stats, rs.get(s), max_hold) for s, q in quotes.items()}

    groups = {c: [] for c in ORDER}
    for s, v in symbols.items():
        groups[v["code"]].append(s)
    for c in ("pullback", "no_chase"):                    # 離買進上限價近的排前面
        groups[c].sort(key=lambda s: -(symbols[s].get("gapPct") if num(symbols[s].get("gapPct")) else -999))
    for c in ("go", "signal_unproven", "signal_blocked"):
        groups[c].sort(key=lambda s: -(symbols[s].get("rr") or 0))

    regimes = {m: ((latest.get("indices") or {}).get(m) or {}).get("regime") for m in MKT}
    out = {
        "generatedAt": now.isoformat(), "dataTimestamp": latest.get("dataTimestamp"),
        "sessions": latest.get("sessions"), "params": params, "minRR": params.get("min_rr"), "maxHoldDays": max_hold,
        "thresholds": V, "labels": LABEL, "icons": ICON, "order": ORDER,
        "regime": regimes,
        "evidence": {m: evidence(stats, m) for m in MKT},
        "regimeNotes": {m: regime_note(stats, m, regimes.get(m)) for m in MKT},
        "counts": {c: len(groups[c]) for c in ORDER}, "groups": groups,
        "checks": data_checks(latest, stats, risk, quotes),
        "selfCheck": self_check(quotes, params),
        "symbols": symbols,
    }
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "verdict.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    for c in ORDER:
        if groups[c]:
            print(f"{ICON[c]} {LABEL[c]}（{len(groups[c])}）：" + "、".join(groups[c]))
    for ch in out["checks"]:
        print("check", ch["level"], ch["text"])
    sc = out["selfCheck"]
    print("selfCheck", sc["checked"], "compared, mismatch:", sc["mismatch"] or "none", sc.get("note", ""))


if __name__ == "__main__":
    main()
