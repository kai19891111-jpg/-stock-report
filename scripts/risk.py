"""風險計分：data/latest.json + data/events.json + 公開資料 -> data/risk.json

每檔股票五個項目，各 0-2 分；抓不到資料的項目寫 score=null（頁面顯示 N/A），不猜、不計分。

  tech          技術過熱    乖離 <6% = 0｜6-15% = 1｜>15% = 2            來源 data/latest.json
  earnings      財報事件    >10 個交易日 = 0｜4-10 = 1｜3 日內 = 2        來源 data/events.json 的 earnings；
                                                                          美股沒填的自動抓（Yahoo→Nasdaq→Finnhub→SEC 推估）
  fundamentals  基本面      營收年增<0、年增率連兩個月放緩、毛利率年減>1pt，
                            中一項 1 分、兩項以上 2 分                    台股 FinMind｜美股 SEC EDGAR（備援 Yahoo）
                                                                          TSM 和台積電是同一家公司，直接用 2330 的數字
  chips         籌碼        法人賣且融資增 = 1｜注意股／處置股 = 2        台股 FinMind＋證交所＋櫃買
                            放空餘額月增且佔流通股達門檻 = 1｜
                            列入 Reg SHO 門檻名單 = 2                     美股 Yahoo／Nasdaq 放空餘額＋交易所名單
  policy        政策政治    兩週內有排定事件 = 1｜不利政策已公告 = 2      來源 data/events.json 的 events

處置股不看總分，直接判「高」。

財報日的優先順序：events.json 手填（已確認）＞自動抓到且來源標示已確認＞自動抓到的預估日。
預估日會在理由裡寫「預估」，照樣計分（寧可早提醒）；不想讓預估日計分，把 T["earn_estimated_scores"] 改成 False。

只用標準函式庫。任何一個來源失敗都不會中斷，該項目寫 N/A，失敗原因記在 risk.json 的 sources。
這是條件核對，不是買賣建議，不自動下單。
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

try:                                    # 美股補資料層；檔案不在時美股那幾項照舊寫 N/A
    import us_data
except Exception as _e:  # noqa: BLE001
    us_data = None
    print("warn: scripts/us_data.py 讀不到，美股財報日／籌碼不自動補：", _e)

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("RISK_DATA_DIR") or (ROOT / "data"))
TZ = {"TW": ZoneInfo("Asia/Taipei"), "US": ZoneInfo("America/New_York")}

FINMIND = "https://api.finmindtrade.com/api/v4/data"
FINMIND_TOKEN = os.environ.get("FINMIND_TOKEN", "")      # 選填；沒有也能跑，只是每小時次數較少
# SEC 規定 User-Agent 要留聯絡方式，例如 "stock-report you@example.com"。
# 沒設定 SEC_UA 時，在 GitHub Actions 上自動用 repo 擁有者的 GitHub noreply 信箱，不用另外設 secret。
_OWNER = os.environ.get("GITHUB_REPOSITORY_OWNER", "")
SEC_UA = (os.environ.get("SEC_UA", "").strip()
          or (f"stock-report {_OWNER}@users.noreply.github.com" if _OWNER else ""))
NO_NET = os.environ.get("RISK_OFFLINE") == "1"           # 測試用：不連網路

# 同一家公司在兩個市場掛牌：美股這檔的基本面直接用台股那檔（月營收比季報即時）
US_TW_TWIN = {"TSM": "2330"}
AUTO_EARNINGS_MARKETS = {"US"}                           # 哪些市場的財報日沒填時自動抓

# ---- 門檻：要調整只改這裡 ---------------------------------------------------
T = {
    "bias_mid": 6.0, "bias_high": 15.0,          # 乖離 %
    "earn_near": 3, "earn_mid": 10,              # 距財報日的交易日數
    "margin_drop_pt": 1.0,                       # 毛利率年減超過幾個百分點算轉弱
    "slow_min_pt": 10.0,                         # 營收年增率連兩個月走低，而且合計少掉幾個百分點以上才算放緩
    "flow_days": 5,                              # 法人、融資看最近幾個交易日
    "event_ahead_days": 14,                      # 排定事件提前幾天開始計分（日曆日）
    "announced_default_days": 30,                # 已公告事件沒寫 expires 時，計分幾天
    "events_stale_days": 14,                     # events.json 超過幾天沒更新，政策項目改 N/A
    "min_scored": 3,                             # 少於幾項有分數就標「資料不足」
    "short_up_pct": 10.0,                        # 美股：放空餘額比前一個月增加幾 % 以上才算增加
    "short_float_min": 2.0,                      # 美股：放空餘額佔流通股幾 % 以上才計分（太低的變動沒有意義）
    "earn_estimated_scores": True,               # 預估（公司還沒確認）的財報日要不要計分
    "earn_cache_days": 10,                       # 自動抓不到時，上一次抓到的財報日幾天內還能用
    "low_max": 3.5, "mid_max": 6.5,              # 換算成 10 分制後：<=3.5 低、<=6.5 中、其餘高
}
LABEL = {"tech": "過熱", "earnings": "財報", "fundamentals": "基本面", "chips": "籌碼", "policy": "政策"}
ORDER = ["tech", "earnings", "fundamentals", "chips", "policy"]


# =============================================================================
# 小工具
# =============================================================================
def item(score, why, **extra):
    out = {"score": score, "why": why}
    out.update({k: v for k, v in extra.items() if v is not None})
    return out


def na(why, **extra):
    return item(None, why, **extra)


def to_date(s):
    try:
        return date.fromisoformat(str(s)[:10])
    except Exception:  # noqa: BLE001
        return None


def business_days(a, b):
    """a 之後到 b（含）的週一到週五天數。不知道休市日，遇到連假會多算一兩天。"""
    n, d = 0, a
    while d < b:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    return n


def roc_dates(text):
    """'115/10/08～115/10/15' 或 '1151008~1151019' -> [date, date]"""
    out = []
    for y, m, d in re.findall(r"(\d{3})/?(\d{2})/?(\d{2})", str(text or "")):
        try:
            out.append(date(int(y) + 1911, int(m), int(d)))
        except ValueError:
            pass
    return out


def signed(v, nd=2):
    return ("+" if v > 0 else "") + f"{v:.{nd}f}"


class Sources:
    """記錄每個資料來源成功／失敗幾次，寫進 risk.json 方便查為什麼是 N/A。"""

    def __init__(self):
        self.s = {}

    def _d(self, name):
        return self.s.setdefault(name, {"ok": 0, "fail": 0})

    def call(self, name, fn, *args):
        try:
            out = fn(*args)
            self._d(name)["ok"] += 1
            return out
        except Exception as e:  # noqa: BLE001
            d = self._d(name)
            d["fail"] += 1
            d["lastError"] = (type(e).__name__ + ": " + str(e))[:160]
            return None

    def skip(self, name, why):
        self._d(name)["skipped"] = why

    def streak_failed(self, name, n=5):
        d = self.s.get(name) or {}
        return d.get("ok", 0) == 0 and d.get("fail", 0) >= n


# =============================================================================
# 抓資料（全部可以失敗）
# =============================================================================
def get_json(url, headers=None, timeout=25, tries=2):
    last = None
    for _ in range(tries):
        try:
            h = {"User-Agent": "Mozilla/5.0 stock-report", "Accept": "application/json"}
            h.update(headers or {})
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8-sig"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5)
    raise last


def finmind(dataset, stock_id, start):
    q = urllib.parse.urlencode({"dataset": dataset, "data_id": stock_id, "start_date": start})
    headers = {"Authorization": "Bearer " + FINMIND_TOKEN} if FINMIND_TOKEN else None
    raw = get_json(FINMIND + "?" + q, headers)
    if raw.get("status") != 200:
        raise RuntimeError(str(raw.get("msg")))
    time.sleep(0.3)
    return raw.get("data") or []


def fetch_twse_punish():
    return get_json("https://openapi.twse.com.tw/v1/announcement/punish")


def fetch_twse_notice():
    return get_json("https://openapi.twse.com.tw/v1/announcement/notice")


def fetch_tpex_disposal():
    return get_json("https://www.tpex.org.tw/openapi/v1/tpex_disposal_information")


def fetch_tpex_warning():
    return get_json("https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information")


def fetch_sec_tickers():
    raw = get_json("https://www.sec.gov/files/company_tickers.json", {"User-Agent": SEC_UA})
    return {str(v["ticker"]).upper(): int(v["cik_str"]) for v in raw.values()}


def fetch_sec_facts(cik):
    time.sleep(0.3)
    return get_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json", {"User-Agent": SEC_UA}, timeout=60)


# =============================================================================
# 把原始資料整理成數字（純函式，方便測試）
# =============================================================================
def build_lists(punish, notice, tpex_disposal, tpex_warning):
    """-> {"disposition": {code: (start, end)}, "attention": {code: 日期字串}, "complete": 四份名單是否都抓到}"""
    disp, att = {}, {}
    for r in punish or []:
        ds = roc_dates(r.get("DispositionPeriod"))
        if r.get("Code") and len(ds) >= 2:
            disp[str(r["Code"]).strip()] = (ds[0], ds[1])
    for r in tpex_disposal or []:
        ds = roc_dates(r.get("DispositionPeriod"))
        code = r.get("SecuritiesCompanyCode") or r.get("Code")
        if code and len(ds) >= 2:
            disp[str(code).strip()] = (ds[0], ds[1])
    for r in notice or []:
        if str(r.get("Code") or "").strip():           # 當天沒有注意股時，證交所回一筆空白紀錄
            ds = roc_dates(r.get("Date"))
            att[str(r["Code"]).strip()] = ds[0].isoformat() if ds else ""
    for r in tpex_warning or []:
        code = r.get("SecuritiesCompanyCode") or r.get("Code")
        if str(code or "").strip():
            ds = roc_dates(r.get("Date"))
            att[str(code).strip()] = ds[0].isoformat() if ds else ""
    complete = all(x is not None for x in (punish, notice, tpex_disposal, tpex_warning))
    return {"disposition": disp, "attention": att, "complete": complete}


def revenue_yoy(rows):
    """FinMind TaiwanStockMonthRevenue -> 最新月營收年增率，以及年增率是不是連兩個月放緩"""
    by = {(r["revenue_year"], r["revenue_month"]): r["revenue"] for r in rows or [] if r.get("revenue")}
    if not by:
        return None

    def yoy(k):
        prev = by.get((k[0] - 1, k[1]))
        return (by[k] / prev - 1) * 100 if (k in by and prev) else None

    def back(k, n):                       # n 個月前
        idx = k[0] * 12 + (k[1] - 1) - n
        return (idx // 12, idx % 12 + 1)

    last = max(by)
    now = yoy(last)
    if now is None:
        return None
    trail = [yoy(back(last, 2)), yoy(back(last, 1)), now]
    slowing = (all(v is not None for v in trail) and trail[0] > trail[1] > trail[2]
               and trail[0] - trail[2] >= T["slow_min_pt"])
    return {"yoy": now, "period": f"{last[0]}-{last[1]:02d}", "slowing": slowing,
            "trail": trail if all(v is not None for v in trail) else None}


def margin_change(rows):
    """FinMind TaiwanStockFinancialStatements（單季）-> 最新一季毛利率與去年同季的差（百分點）"""
    rev, gp = {}, {}
    for r in rows or []:
        if r.get("type") == "Revenue":
            rev[r["date"]] = r["value"]
        elif r.get("type") == "GrossProfit":
            gp[r["date"]] = r["value"]
    dates = sorted(d for d in rev if d in gp and rev[d])
    if not dates:
        return None
    last = dates[-1]
    prev = str(int(last[:4]) - 1) + last[4:]
    if prev not in dates:
        return None
    gm = lambda d: gp[d] / rev[d] * 100  # noqa: E731
    return {"change": gm(last) - gm(prev), "gm": gm(last), "period": last}


def flows(inst_rows, margin_rows, n):
    """FinMind 三大法人買賣超＋融資餘額 -> 最近 n 個交易日合計"""
    out = {}
    by = {}
    for r in inst_rows or []:
        by[r["date"]] = by.get(r["date"], 0) + (r.get("buy") or 0) - (r.get("sell") or 0)
    days = sorted(by)[-n:]
    if days:
        out["instNet"] = sum(by[d] for d in days)          # 單位：股
        out["instDate"] = days[-1]
    m = sorted((r for r in margin_rows or [] if r.get("MarginPurchaseTodayBalance") is not None), key=lambda r: r["date"])[-(n + 1):]
    if len(m) >= 2:
        out["marginChange"] = m[-1]["MarginPurchaseTodayBalance"] - m[0]["MarginPurchaseTodayBalance"]   # 單位：張
        out["marginDate"] = m[-1]["date"]
    return out


REV_TAGS = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet",
            "RevenueFromContractWithCustomerIncludingAssessedTax"]
COST_TAGS = ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"]


def sec_series(facts, tags, derived=None):
    """季末日期 -> 單季金額。取資料最新的那個 tag（公司會換科目名稱）。

    10-K 只揭露全年，不單獨揭露第四季，所以第四季＝全年 − 前三季累計（兩個數字都是公司申報的）。
    這樣算出來的季末日期會放進 derived（有傳的話）。
    """
    best, best_derived = {}, set()
    gaap = ((facts or {}).get("facts") or {}).get("us-gaap") or {}
    for tag in tags:
        q, ytd9, fy = {}, {}, {}
        for u in ((gaap.get(tag) or {}).get("units") or {}).get("USD") or []:
            a, b = to_date(u.get("start")), to_date(u.get("end"))
            if not a or not b or u.get("val") is None:
                continue
            n = (b - a).days
            if 80 <= n <= 100:
                q[b.isoformat()] = u["val"]
            elif 260 <= n <= 285:
                ytd9[b.isoformat()] = (a, u["val"])
            elif 350 <= n <= 380:
                fy[b.isoformat()] = (a, u["val"])
        got = set()
        for end, (start, total) in fy.items():
            if end in q:
                continue
            same_year = [(e, v) for e, (st, v) in ytd9.items()
                         if abs((st - start).days) <= 7 and 80 <= (to_date(end) - to_date(e)).days <= 100]
            if same_year:
                q[end] = total - max(same_year)[1]
                got.add(end)
        if q and (not best or max(q) > max(best)):
            best, best_derived = q, got
    if derived is not None:
        derived.clear()
        derived.update(best_derived)
    return best


def series_fundamentals(rev, gp, today, cost=None):
    """{季末: 單季營收}、{季末: 單季毛利} -> (營收年增, 毛利率變化)。SEC 與 Yahoo 共用。"""
    if not rev:
        return None, None
    last = max(rev)
    if (today - to_date(last)).days > 230:
        return None, None
    prior = next((d for d in sorted(rev) if 350 <= (to_date(last) - to_date(d)).days <= 380), None)
    if not prior or not rev[prior]:
        return None, None
    r = {"yoy": (rev[last] / rev[prior] - 1) * 100, "period": last}
    gp = dict(gp or {})
    if last not in gp or prior not in gp:
        gp = {d: rev[d] - cost[d] for d in (last, prior) if d in (cost or {})}
    m = None
    if last in gp and prior in gp and rev[last]:
        gm_last, gm_prior = gp[last] / rev[last] * 100, gp[prior] / rev[prior] * 100
        m = {"change": gm_last - gm_prior, "gm": gm_last, "period": last}
    return r, m


def us_fundamentals(facts, today):
    """SEC companyfacts -> (營收年增, 毛利率變化, 最新一季是不是「全年 − 前三季」算出來的)"""
    derived = set()
    rev = sec_series(facts, REV_TAGS, derived)
    if not rev:
        return None, None, False
    r, m = series_fundamentals(rev, sec_series(facts, ["GrossProfit"]), today, sec_series(facts, COST_TAGS))
    return r, m, bool(r) and r["period"] in derived


# =============================================================================
# 事件檔
# =============================================================================
def load_events(now_date):
    """讀 data/events.json。沒有來源網址或日期格式錯的事件一律不採用，列在 rejected。"""
    out = {"earnings": {}, "events": [], "rejected": [], "updatedAt": None, "fresh": False, "exists": False}
    p = DATA / "events.json"
    if not p.exists():
        return out
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        out["rejected"].append({"id": "events.json", "reason": "JSON 格式錯誤：" + str(e)[:80]})
        return out
    out["exists"] = True
    up = to_date(raw.get("updatedAt"))
    out["updatedAt"] = up.isoformat() if up else None
    out["fresh"] = bool(up) and 0 <= (now_date - up).days <= T["events_stale_days"]
    ok_src = lambda s: isinstance(s, str) and s.startswith(("https://", "http://"))  # noqa: E731
    for sym, e in (raw.get("earnings") or {}).items():
        if isinstance(e, dict) and to_date(e.get("date")) and ok_src(e.get("source")):
            out["earnings"][sym] = {"date": to_date(e["date"]).isoformat(), "source": e["source"]}
        else:
            out["rejected"].append({"id": "earnings:" + str(sym), "reason": "缺 date 或 source"})
    for e in raw.get("events") or []:
        eid = str((e or {}).get("id") or (e or {}).get("title") or "?")
        if not isinstance(e, dict) or not to_date(e.get("date")) or not ok_src(e.get("source")):
            out["rejected"].append({"id": eid, "reason": "缺 date 或 source"})
        elif e.get("type") not in ("scheduled", "announced"):
            out["rejected"].append({"id": eid, "reason": "type 必須是 scheduled 或 announced"})
        elif not e.get("targets") or not e.get("title"):
            out["rejected"].append({"id": eid, "reason": "缺 targets 或 title"})
        elif e.get("item", "policy") not in ("policy", "fundamental"):
            out["rejected"].append({"id": eid, "reason": "item 必須是 policy 或 fundamental"})
        elif e.get("item") == "fundamental" and e["type"] != "announced":
            out["rejected"].append({"id": eid, "reason": "item=fundamental 只能搭配 type=announced"})
        else:
            out["events"].append(e)
    return out


def active_events(events, sym, market, group, today):
    """回傳對這檔股票目前有效的事件：[(分數, 事件)]"""
    out = []
    for e in events:
        tg = e["targets"]
        if not ("*" in tg or market in tg or group in tg or sym in tg):
            continue
        d = to_date(e["date"])
        if e["type"] == "scheduled":
            if 0 <= (d - today).days <= T["event_ahead_days"]:
                out.append((1, e))
        else:
            end = to_date(e.get("expires")) or d + timedelta(days=T["announced_default_days"])
            if d <= today <= end:
                out.append((2, e))
    return out


# =============================================================================
# 五個項目的計分
# =============================================================================
def score_tech(q):
    close, ma20 = q.get("close"), q.get("ma20")
    bias = q.get("bias")
    if bias is None and close and ma20:
        bias = (close / ma20 - 1) * 100
    if bias is None:
        return na("沒有乖離資料")
    s = 2 if bias > T["bias_high"] else 1 if bias >= T["bias_mid"] else 0
    return item(s, f"乖離 {signed(bias)}%", date=q.get("date"))


def score_earnings(today, e, miss="events.json 沒有這檔的財報日"):
    if not e:
        return na(miss)
    d = to_date(e["date"])
    if d < today:
        return na(f"財報日 {d.isoformat()} 已過，等下一次日期", date=d.isoformat(), source=e["source"])
    n = business_days(today, d)
    s = 2 if n <= T["earn_near"] else 1 if n <= T["earn_mid"] else 0
    extra = {"date": d.isoformat(), "source": e["source"], "days": n, "provider": e.get("provider")}
    if not e.get("estimated"):
        tail = f"（{e['provider']}，已確認）" if e.get("provider") else ""
        return item(s, f"財報 {d.isoformat()}，還有 {n} 個交易日{tail}", **extra)
    span = f"～{e['dateEnd'][5:]}" if e.get("dateEnd") else ""
    why = f"財報約 {d.isoformat()}{span}（{e.get('provider') or '自動'}預估，公司尚未確認），還有 {n} 個交易日"
    if e.get("stale"):
        why += f"；這是 {e['stale']} 抓到的結果"
    if not T["earn_estimated_scores"]:
        return na(why + "；預估日不計分", estimated=True, **extra)
    return item(s, why, estimated=True, **extra)


def score_fundamentals(rev, mar, cuts, note="", source=None, miss="營收與毛利率都抓不到"):
    if cuts:
        e = cuts[0]
        return item(2, "財測下修：" + e["title"], date=e["date"], source=e["source"])
    if rev is None and mar is None:
        return na(miss)
    weak, bits, period = 0, [], None
    if rev is not None:
        weak += rev["yoy"] < 0
        bits.append(f"營收年增 {signed(rev['yoy'], 1)}%（{rev['period']}）")
        if rev.get("slowing"):
            weak += 1
            bits.append("年增率連兩個月放緩（" + "→".join(signed(v, 0) + "%" for v in rev["trail"]) + "）")
        period = rev["period"]
    else:
        bits.append("營收 N/A")
    if mar is not None:
        weak += mar["change"] < -T["margin_drop_pt"]
        bits.append(f"毛利率 {mar['gm']:.1f}%，年變動 {signed(mar['change'], 1)} 個百分點（{mar['period']}）")
        period = period or mar["period"]
    else:
        bits.append("毛利率 N/A")
    return item(min(2, int(weak)), "、".join(bits) + (f"（{note}）" if note else ""), date=period, source=source,
                partial=(rev is None or mar is None) or None)


def score_chips(code, today, lists, fl):
    """code 是不含 .TW 的股票代號"""
    disp = (lists or {}).get("disposition", {}).get(code)
    if disp and today <= disp[1]:
        return item(2, f"處置股 {disp[0].isoformat()}～{disp[1].isoformat()}", date=disp[0].isoformat(), flag="disposition")
    if code in (lists or {}).get("attention", {}):
        d = lists["attention"][code]
        return item(2, "列入注意股" + (f"（{d}）" if d else ""), date=d or None, flag="attention")
    note = "" if (lists or {}).get("complete") else "；注意／處置名單沒有完整抓到"
    if "instNet" not in fl or "marginChange" not in fl:
        return na("法人或融資資料抓不到" + note)
    lots = fl["instNet"] / 1000
    s = 1 if (fl["instNet"] < 0 and fl["marginChange"] > 0) else 0
    why = f"近 {T['flow_days']} 日法人 {signed(lots, 0)} 張、融資 {signed(fl['marginChange'], 0)} 張"
    return item(s, why + note, date=fl.get("instDate"))


def score_chips_us(sym, short, regsho):
    """美股籌碼：Reg SHO 門檻名單（類似注意股）= 2；放空餘額月增且佔流通股達門檻 = 1。

    regsho = {"symbols": {代號}, "date": 名單日期, "complete": Nasdaq 與 NYSE 兩份都抓到了沒}
    short  = {"shares": 放空餘額, "prior": 前一期, "pctFloat": 佔流通股 %, "date": 結算日, "provider": 來源}
    """
    reg = regsho or {}
    if sym in (reg.get("symbols") or set()):
        return item(2, "列入 Reg SHO 門檻名單（連續交割失敗）" + (f"（{reg['date']}）" if reg.get("date") else ""),
                    date=reg.get("date"), flag="attention")
    note = "" if reg.get("complete") else "；Reg SHO 門檻名單沒有完整抓到"
    if not short or not short.get("shares") or not short.get("prior"):
        return na("放空餘額抓不到" + note)
    chg = (short["shares"] / short["prior"] - 1) * 100
    pf = short.get("pctFloat")
    up = chg >= T["short_up_pct"]
    s = 1 if (up and (pf is None or pf >= T["short_float_min"])) else 0
    lots = short["shares"] / 1e6
    why = (f"放空餘額 {lots:,.1f} 百萬股" + (f"（佔流通股 {pf:.1f}%）" if pf is not None else "")
           + f"，較前期 {signed(chg, 1)}%")
    if up and not s:
        why += f"；佔比低於 {T['short_float_min']:.0f}% 不計分"
    return item(s, why + (f"（{short['provider']}）" if short.get("provider") else "") + note, date=short.get("date"))


def score_policy(ev, hits):
    if not ev["exists"]:
        return na("沒有 data/events.json")
    if not ev["fresh"]:
        return na(f"events.json 超過 {T['events_stale_days']} 天沒更新（上次 {ev['updatedAt'] or '未填'}）")
    if not hits:
        return item(0, f"{T['event_ahead_days']} 天內沒有排定事件，也沒有生效中的不利政策", date=ev["updatedAt"])
    s, e = sorted(hits, key=lambda x: (-x[0], x[1]["date"]))[0]      # 分數高的優先，同分取日期最近的
    more = f"（另有 {len(hits) - 1} 件）" if len(hits) > 1 else ""
    return item(s, f"{e['date']} {e['title']}{more}", date=e["date"], source=e["source"])


def summarise(items):
    scored = [k for k in ORDER if items[k]["score"] is not None]
    total = sum(items[k]["score"] for k in scored)
    mx = 2 * len(scored)
    score10 = round(total / mx * 10, 1) if mx else None
    if len(scored) < T["min_scored"]:
        level = "insufficient"
    else:
        level = "low" if score10 <= T["low_max"] else "mid" if score10 <= T["mid_max"] else "high"
    flags = [f for f in (
        "earnings_soon" if items["earnings"]["score"] == 2 else None,
        items["chips"].get("flag"),
        "overheated" if items["tech"]["score"] == 2 else None) if f]
    if "disposition" in flags:            # 處置股：分盤交易、要預收款券，流動性風險不看總分
        level = "high"
    reasons = []
    if "earnings_soon" in flags:
        reasons.append("財報前觀察")
    if "disposition" in flags:
        reasons.append("處置股")
    if "attention" in flags:
        reasons.append("注意股")
    if level in ("mid", "high") and "disposition" not in flags:
        reasons.append("風險" + ("高" if level == "high" else "中"))
    return {"total": total, "max": mx, "scored": len(scored), "score10": score10, "level": level,
            "flags": flags, "gate": {"block": bool(reasons), "reasons": reasons}, "items": items}


# =============================================================================
# 美股：自動補財報日、放空餘額、門檻名單（scripts/us_data.py）
# =============================================================================
EARN_CACHE = "earnings_auto.json"


def load_earn_cache():
    try:
        return dict(json.loads((DATA / EARN_CACHE).read_text(encoding="utf-8")).get("symbols") or {})
    except Exception:  # noqa: BLE001
        return {}


def save_earn_cache(cache, now):
    (DATA / EARN_CACHE).write_text(json.dumps({
        "updatedAt": now.isoformat(),
        "note": "scripts/risk.py 自動抓到的美股財報日。要指定日期請改 data/events.json 的 earnings，那邊永遠優先。",
        "symbols": {k: cache[k] for k in sorted(cache)}}, ensure_ascii=False, indent=2), encoding="utf-8")


class USData:
    """一次執行共用的美股連線與快取。每個來源都可以失敗，失敗就換下一個。"""

    def __init__(self, src, today, sec_map):
        self.src, self.today, self.sec_map = src, today, sec_map or {}
        self.cache = load_earn_cache()
        self.yahoo, self._tried, self._summary = None, False, {}
        self.regsho = None
        self.auto_earnings = 0

    def _login(self):
        if not self._tried:
            self._tried = True
            y = us_data.Yahoo()
            if self.src.call("yahoo_login", y.login):
                self.yahoo = y
        return self.yahoo

    def summary(self, sym):
        if sym not in self._summary:
            res = None
            if self._login() and not self.src.streak_failed("yahoo", 3):
                res = self.src.call("yahoo", self.yahoo.summary, sym)
            self._summary[sym] = res
        return self._summary[sym]

    def earnings(self, sym):
        t = self.today
        e = us_data.yahoo_earnings(self.summary(sym), sym, t)
        if not e and not self.src.streak_failed("nasdaq_earnings", 3):
            e = us_data.nasdaq_earnings(self.src.call("nasdaq_earnings", us_data.fetch_nasdaq_earnings, sym), sym, t)
        if not e and us_data.FINNHUB_API_KEY and not self.src.streak_failed("finnhub_earnings", 3):
            e = us_data.finnhub_earnings(self.src.call("finnhub_earnings", us_data.fetch_finnhub_earnings, sym, t), sym, t)
        if e:
            self.cache[sym] = dict(e, fetchedAt=t.isoformat())
            self.auto_earnings += 1
            return e
        c = self.cache.get(sym) or {}
        d, got = to_date(c.get("date")), to_date(c.get("fetchedAt"))
        if d and got and d >= t and 0 <= (t - got).days <= T["earn_cache_days"] and c.get("source"):
            self.auto_earnings += 1
            return dict(c, stale=got.isoformat() if got < t else None)
        cik = self.sec_map.get(sym.upper())
        if cik and SEC_UA and not self.src.streak_failed("sec_submissions", 3):
            sub = self.src.call("sec_submissions", us_data.fetch_sec_submissions, cik, SEC_UA)
            e = us_data.estimate_from_history(us_data.sec_release_dates(sub), t, cik)
            if e:
                self.auto_earnings += 1
            return e
        return None

    def short(self, sym):
        s = us_data.yahoo_short(self.summary(sym))
        if not s and not self.src.streak_failed("nasdaq_short", 3):
            s = us_data.nasdaq_short(self.src.call("nasdaq_short", us_data.fetch_nasdaq_short, sym))
        return s

    def load_regsho(self):
        syms, dates, ok = set(), [], 0
        for name, fn in (("regsho_nasdaq", us_data.fetch_threshold_nasdaq), ("regsho_nyse", us_data.fetch_threshold_nyse)):
            got = self.src.call(name, us_data.latest_threshold, fn, self.today)
            if got:
                syms |= got[0]
                dates.append(got[1])
                ok += 1
        self.regsho = {"symbols": syms, "date": min(dates) if dates else None, "complete": ok == 2}
        return self.regsho

    def yahoo_fundamentals(self, sym):
        if self.src.streak_failed("yahoo_fundamentals", 3):
            return None, None
        got = self.src.call("yahoo_fundamentals", us_data.fetch_yahoo_series, sym, self.today)
        return series_fundamentals(got[0], got[1], self.today) if got else (None, None)


# =============================================================================
# 主流程
# =============================================================================
def main(now=None):
    now = now or datetime.now(timezone.utc)
    try:
        latest = json.loads((DATA / "latest.json").read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"讀不到 data/latest.json（{e}），risk.json 不更新")
    quotes = {s: q for s, q in (latest.get("quotes") or {}).items() if isinstance(q, dict) and q.get("market") in TZ}
    if not quotes:
        raise SystemExit("data/latest.json 沒有 quotes，risk.json 不更新")

    today = {m: now.astimezone(tz).date() for m, tz in TZ.items()}
    ev = load_events(today["TW"])
    src = Sources()

    lists = None
    if any(q["market"] == "TW" for q in quotes.values()):
        lists = build_lists(src.call("twse_punish", fetch_twse_punish), src.call("twse_notice", fetch_twse_notice),
                            src.call("tpex_disposal", fetch_tpex_disposal), src.call("tpex_warning", fetch_tpex_warning))

    sec_map, usd = None, None
    if any(q["market"] == "US" for q in quotes.values()):
        if SEC_UA:
            sec_map = src.call("sec_tickers", fetch_sec_tickers)
        else:
            src.skip("sec", "沒有設定 SEC_UA，美股基本面改用 Yahoo 備援")
        if us_data and not NO_NET:
            usd = USData(src, today["US"], sec_map)
            usd.load_regsho()
        elif not us_data:
            src.skip("us_data", "少了 scripts/us_data.py，美股財報日與籌碼沒有自動補")

    def fm(dataset, code, days_back, t):
        if src.streak_failed("finmind"):                 # 連續失敗（多半是次數用完）就不再打
            return None
        return src.call("finmind", finmind, dataset, code, (t - timedelta(days=days_back)).isoformat())

    fund_cache = {}

    def tw_fund(code, t):                                # 同一檔只抓一次（TSM 會再用到 2330）
        if code not in fund_cache:
            fund_cache[code] = (revenue_yoy(fm("TaiwanStockMonthRevenue", code, 520, t)),
                                margin_change(fm("TaiwanStockFinancialStatements", code, 560, t)))
        return fund_cache[code]

    out = {}
    for sym, q in quotes.items():
        market, t = q["market"], today[q["market"]]
        group = market + "|" + str(q.get("theme") or "")
        hits = active_events(ev["events"], sym, market, group, t)
        cuts = [e for s, e in hits if e.get("item") == "fundamental"]
        pol = [(s, e) for s, e in hits if e.get("item", "policy") == "policy"]

        earn, earn_miss = ev["earnings"].get(sym), "events.json 沒有這檔的財報日"
        if usd and market in AUTO_EARNINGS_MARKETS and (not earn or to_date(earn["date"]) < t):
            auto = usd.earnings(sym)
            if auto:
                earn = auto
            elif not earn:
                earn_miss = "events.json 沒填，自動來源（Yahoo／Nasdaq／SEC）也抓不到財報日"

        note, fsrc, fmiss = "", None, "營收與毛利率都抓不到"
        if market == "TW":
            code = sym.split(".")[0]
            rev, mar = tw_fund(code, t)
            fl = flows(fm("TaiwanStockInstitutionalInvestorsBuySell", code, 20, t),
                       fm("TaiwanStockMarginPurchaseShortSale", code, 20, t), T["flow_days"])
            chips = score_chips(code, t, lists, fl)
        else:
            rev = mar = None
            twin = US_TW_TWIN.get(sym.upper())
            if twin:
                rev, mar = tw_fund(twin, today["TW"])
                note = f"和台股 {twin} 是同一家公司，用它的月營收與季報"
            if rev is None and mar is None:
                note = ""
                cik = (sec_map or {}).get(sym.upper())
                if cik:
                    rev, mar, derived = us_fundamentals(src.call("sec_facts", fetch_sec_facts, cik), t)
                    if rev is not None or mar is not None:
                        note = "SEC 申報" + ("；第四季＝全年 − 前三季" if derived else "")
                        fsrc = f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=10-Q&CIK={cik:010d}"
                elif sec_map is not None:
                    fmiss = "SEC 找不到這個代號（ETF 或非美國申報公司），Yahoo 也沒有季報"
            if rev is None and mar is None and usd:
                rev, mar = usd.yahoo_fundamentals(sym)
                if rev is not None or mar is not None:
                    note = "Yahoo 財報摘要"
                    fsrc = "https://finance.yahoo.com/quote/" + urllib.parse.quote(sym) + "/financials/"
            if usd:
                chips = score_chips_us(sym.upper(), usd.short(sym), usd.regsho)
            else:
                chips = na("美股籌碼（放空餘額、Reg SHO 名單）這次沒有抓")
        out[sym] = summarise({
            "tech": score_tech(q),
            "earnings": score_earnings(t, earn, earn_miss),
            "fundamentals": score_fundamentals(rev, mar, cuts, note, fsrc, fmiss),
            "chips": chips,
            "policy": score_policy(ev, pol),
        })
        out[sym].update({"market": market, "group": group})

    DATA.mkdir(parents=True, exist_ok=True)
    if usd:
        try:
            save_earn_cache(usd.cache, now)
        except Exception as e:  # noqa: BLE001
            print("warn: earnings_auto.json 沒寫成：", e)
    (DATA / "risk.json").write_text(json.dumps({
        "generatedAt": now.isoformat(), "today": {m: d.isoformat() for m, d in today.items()},
        "thresholds": T, "labels": LABEL, "order": ORDER, "sources": src.s,
        "events": {"updatedAt": ev["updatedAt"], "fresh": ev["fresh"], "used": len(ev["events"]),
                   "earnings": len(ev["earnings"]), "autoEarnings": usd.auto_earnings if usd else 0,
                   "rejected": ev["rejected"]},
        "symbols": out}, ensure_ascii=False, indent=2), encoding="utf-8")

    name = {"low": "低", "mid": "中", "high": "高", "insufficient": "資料不足"}
    for sym, r in sorted(out.items(), key=lambda kv: (-(kv[1]["score10"] or -1), kv[0])):
        cells = " ".join(f"{LABEL[k]}{'-' if r['items'][k]['score'] is None else r['items'][k]['score']}" for k in ORDER)
        print(f"{sym:10s} {r['total']}/{r['max']:<2d} {name[r['level']]:4s} {cells}")
    print("sources", json.dumps(src.s, ensure_ascii=False))
    if ev["rejected"]:
        print("rejected events", json.dumps(ev["rejected"], ensure_ascii=False))


if __name__ == "__main__":
    main()
