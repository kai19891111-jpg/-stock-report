"""美股補資料層：財報日、放空餘額（籌碼）、Reg SHO 門檻名單、基本面備援。

risk.py 會用到這裡的函式。每個函式都可以失敗；失敗時由 risk.py 記在 risk.json 的 sources，
該項目寫 N/A，不會中斷，也不會猜數字。只用標準函式庫。

資料來源（依序嘗試，前一個抓到就不打後面的）：
  財報日      Yahoo calendarEvents → Nasdaq earnings-date → Finnhub（有 FINNHUB_API_KEY 才用）
              → 上一次抓到的結果（data/earnings_auto.json）→ 用 SEC 8-K 2.02 的歷年發布日推估
              公司還沒確認的日期一律標「預估」。data/events.json 手填的日期永遠優先。
  放空餘額    Yahoo defaultKeyStatistics → Nasdaq short-interest
  門檻名單    Nasdaq Trader、NYSE 每日公布的 Reg SHO Threshold List（連續交割失敗，類似注意股）
  基本面備援  Yahoo fundamentals-timeseries（SEC EDGAR 抓不到時才用）

這是條件核對，不是買賣建議，不自動下單。
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/126.0.0.0 Safari/537.36")
FINNHUB_API_KEY = os.environ.get("FINNHUB_API_KEY", "")     # 選填
MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}


# =============================================================================
# 小工具
# =============================================================================
def to_date(s):
    try:
        return date.fromisoformat(str(s)[:10])
    except Exception:  # noqa: BLE001
        return None


def raw(v):
    """Yahoo 的數字有時是 {"raw": 1.2, "fmt": "1.2"}，有時直接是數字。"""
    if isinstance(v, dict):
        v = v.get("raw")
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def to_number(s):
    """'1,234,567' / '2.94%' / 12.3 -> float；讀不出來回 None"""
    if isinstance(s, (int, float)) and not isinstance(s, bool):
        return float(s)
    try:
        return float(str(s).replace(",", "").replace("%", "").strip())
    except (TypeError, ValueError):
        return None


def ny_date(epoch):
    return datetime.fromtimestamp(int(epoch), tz=timezone.utc).astimezone(NY).date()


def http_get(url, headers=None, timeout=25, opener=None):
    h = {"User-Agent": BROWSER_UA, "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9"}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    with (opener.open(req, timeout=timeout) if opener else urllib.request.urlopen(req, timeout=timeout)) as r:
        return r.read()


def get_json(url, headers=None, timeout=25, opener=None):
    return json.loads(http_get(url, headers, timeout, opener).decode("utf-8-sig"))


# =============================================================================
# Yahoo：quoteSummary 需要先拿 cookie 與 crumb
# =============================================================================
class Yahoo:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.crumb = None

    def login(self):
        """拿 cookie 與 crumb。失敗會丟例外，由呼叫端記錄。"""
        try:
            http_get("https://fc.yahoo.com", {"Accept": "text/html"}, 15, self.opener)
        except urllib.error.HTTPError:
            pass                                    # 這個網址本來就回 404，重點是它發的 cookie
        last = None
        for host in ("query2", "query1"):
            try:
                c = http_get(f"https://{host}.finance.yahoo.com/v1/test/getcrumb", {"Accept": "text/plain"}, 15,
                             self.opener).decode("utf-8", "replace").strip()
                if c and len(c) < 40 and "<" not in c and " " not in c:
                    self.crumb = c
                    return True
                last = RuntimeError("crumb 格式不對：" + c[:40])
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(1.0)
        raise last

    def summary(self, symbol, modules=("calendarEvents", "defaultKeyStatistics")):
        if not self.crumb:
            raise RuntimeError("Yahoo 尚未登入")
        q = urllib.parse.urlencode({"modules": ",".join(modules), "crumb": self.crumb})
        data = get_json(f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{urllib.parse.quote(symbol)}?{q}",
                        None, 25, self.opener)
        res = ((data.get("quoteSummary") or {}).get("result") or [None])[0]
        if not res:
            raise RuntimeError(str(((data.get("quoteSummary") or {}).get("error") or {}).get("description") or "沒有資料"))
        time.sleep(0.3)
        return res


def yahoo_earnings(res, symbol, today):
    """quoteSummary.calendarEvents -> {"date","dateEnd","estimated","source","provider"}；沒有未來日期回 None"""
    e = ((res or {}).get("calendarEvents") or {}).get("earnings") or {}
    days = sorted({ny_date(v) for v in (raw(x) for x in e.get("earningsDate") or []) if v})
    days = [d for d in days if d >= today]
    if not days:
        return None
    # Yahoo 給兩個日期代表「落在這段期間」，本身就是還沒確認
    estimated = bool(e.get("isEarningsDateEstimate")) or len(days) > 1
    return {"date": days[0].isoformat(), "dateEnd": days[-1].isoformat() if len(days) > 1 else None,
            "estimated": estimated, "provider": "Yahoo",
            "source": f"https://finance.yahoo.com/quote/{urllib.parse.quote(symbol)}/"}


def yahoo_short(res):
    """quoteSummary.defaultKeyStatistics -> 放空餘額（股）、前期、佔流通股比例（%）"""
    k = (res or {}).get("defaultKeyStatistics") or {}
    cur, prev = raw(k.get("sharesShort")), raw(k.get("sharesShortPriorMonth"))
    if not cur or not prev:
        return None
    pf, when = raw(k.get("shortPercentOfFloat")), raw(k.get("dateShortInterest"))
    return {"shares": cur, "prior": prev, "pctFloat": pf * 100 if pf is not None else None,
            "date": ny_date(when).isoformat() if when else None, "provider": "Yahoo"}


def fetch_yahoo_series(symbol, today):
    """fundamentals-timeseries（不用 crumb）-> (單季營收, 單季毛利)，都是 {季末日期: 金額}"""
    p2 = int(datetime(today.year, today.month, today.day, tzinfo=timezone.utc).timestamp()) + 86400
    q = urllib.parse.urlencode({"symbol": symbol, "type": "quarterlyTotalRevenue,quarterlyGrossProfit",
                                "period1": p2 - 900 * 86400, "period2": p2, "merge": "false", "padTimeSeries": "false"})
    data = get_json("https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/"
                    f"{urllib.parse.quote(symbol)}?{q}")
    return parse_yahoo_series(data)


def parse_yahoo_series(data):
    rev, gp = {}, {}
    for r in ((data or {}).get("timeseries") or {}).get("result") or []:
        for key, box in (("quarterlyTotalRevenue", rev), ("quarterlyGrossProfit", gp)):
            for p in r.get(key) or []:
                v = raw((p or {}).get("reportedValue"))
                if p and to_date(p.get("asOfDate")) and v is not None:
                    box[str(p["asOfDate"])[:10]] = v
    return rev, gp


# =============================================================================
# Nasdaq（備援）
# =============================================================================
NASDAQ_HEADERS = {"Origin": "https://www.nasdaq.com", "Referer": "https://www.nasdaq.com/"}


def fetch_nasdaq_earnings(symbol):
    return get_json(f"https://api.nasdaq.com/api/analyst/{urllib.parse.quote(symbol)}/earnings-date", NASDAQ_HEADERS, 20)


def nasdaq_earnings(data, symbol, today):
    """'Earnings announcement* for NVDA: Nov 19, 2026'；有星號代表 Nasdaq 用歷年日期推算，還沒確認"""
    d = (data or {}).get("data") or {}
    text = str(d.get("announcement") or "")
    m = re.search(r":\s*([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})", text)
    if not m or m.group(1) not in MONTHS:
        return None
    try:
        when = date(int(m.group(3)), MONTHS[m.group(1)], int(m.group(2)))
    except ValueError:
        return None
    if when < today:
        return None
    estimated = "*" in text or "expected*" in str(d.get("reportText") or "")
    return {"date": when.isoformat(), "dateEnd": None, "estimated": estimated, "provider": "Nasdaq",
            "source": f"https://www.nasdaq.com/market-activity/stocks/{symbol.lower()}/earnings"}


def fetch_nasdaq_short(symbol):
    return get_json(f"https://api.nasdaq.com/api/quote/{urllib.parse.quote(symbol)}/short-interest?assetClass=stocks",
                    NASDAQ_HEADERS, 20)


def nasdaq_short(data):
    """Nasdaq 每半個月一筆，最新的在最前面。沒有佔流通股比例。"""
    rows = (((data or {}).get("data") or {}).get("shortInterestTable") or {}).get("rows") or []
    out = []
    for r in rows:
        v = to_number((r or {}).get("interest"))
        m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", str((r or {}).get("settlementDate") or "").strip())
        if v and m:
            out.append((date(int(m.group(3)), int(m.group(1)), int(m.group(2))), v))
    out.sort(reverse=True)
    if len(out) < 2:
        return None
    # 和 Yahoo 的「前一個月」對齊：找 20 天以前的那一筆，沒有就用上一筆
    prior = next((v for d, v in out[1:] if (out[0][0] - d).days >= 20), out[1][1])
    return {"shares": out[0][1], "prior": prior, "pctFloat": None, "date": out[0][0].isoformat(), "provider": "Nasdaq"}


# =============================================================================
# Finnhub（選用）
# =============================================================================
def fetch_finnhub_earnings(symbol, today):
    q = urllib.parse.urlencode({"symbol": symbol, "from": today.isoformat(),
                                "to": (today + timedelta(days=120)).isoformat(), "token": FINNHUB_API_KEY})
    return get_json("https://finnhub.io/api/v1/calendar/earnings?" + q, None, 20)


def finnhub_earnings(data, symbol, today):
    days = sorted(d for d in (to_date((r or {}).get("date")) for r in (data or {}).get("earningsCalendar") or [])
                  if d and d >= today)
    if not days:
        return None
    # Finnhub 不區分已確認／預估，保守起見標成預估
    return {"date": days[0].isoformat(), "dateEnd": None, "estimated": True, "provider": "Finnhub",
            "source": f"https://finnhub.io/api/v1/calendar/earnings?symbol={urllib.parse.quote(symbol)}"}


# =============================================================================
# SEC：歷年財報發布日（8-K 2.02）-> 推估下一次
# =============================================================================
def fetch_sec_submissions(cik, user_agent):
    time.sleep(0.3)
    return get_json(f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json", {"User-Agent": user_agent}, 40)


def sec_release_dates(sub):
    """submissions.filings.recent -> 歷次「發布營運成果」8-K（Item 2.02）的申報日"""
    rec = ((sub or {}).get("filings") or {}).get("recent") or {}
    forms, items, days = rec.get("form") or [], rec.get("items") or [], rec.get("filingDate") or []
    out = set()
    for i, f in enumerate(forms):
        if f == "8-K" and i < len(items) and i < len(days) and "2.02" in str(items[i]):
            d = to_date(days[i])
            if d:
                out.add(d)
    return sorted(out)


def estimate_from_history(history, today, cik=None):
    """去年同一季的發布日 + 52 週（同一個星期幾）。只是推估，一律標 estimated。"""
    if not history:
        return None
    last = history[-1]
    cands = sorted(d + timedelta(days=364) for d in history)
    # 要在今天之後、四個月內，而且離最近一次發布至少 45 天（避免把剛公布的那一季再算一次）
    nxt = next((d for d in cands if today <= d <= today + timedelta(days=125) and (d - last).days >= 45), None)
    if not nxt:
        return None
    src = ("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=8-K&CIK=" + f"{int(cik):010d}"
           if cik else "https://www.sec.gov/edgar/search/")
    return {"date": nxt.isoformat(), "dateEnd": None, "estimated": True, "provider": "SEC 歷年發布日推估", "source": src}


# =============================================================================
# Reg SHO 門檻名單（交易所每天公布；連續 5 個交割日有大量交割失敗才會上榜）
# =============================================================================
def parse_threshold(text):
    """'Symbol|Security Name|Market Category|Reg SHO Threshold Flag|...' -> {代號}"""
    out = set()
    for line in str(text or "").splitlines():
        cells = [c.strip() for c in line.split("|")]
        if len(cells) < 2 or not re.fullmatch(r"[A-Z][A-Z0-9.\-]{0,7}", cells[0]) or cells[0] == "SYMBOL":
            continue
        out.add(cells[0])
    return out


def _is_list(text):
    """名單檔第一行是 'Symbol|Security Name|...'；當天沒有任何股票上榜時可能是空白。HTML 錯誤頁不算。"""
    head = str(text or "").lstrip()[:200].lower()
    return head == "" or head.startswith("symbol|")


def fetch_threshold_nasdaq(day):
    text = http_get(f"https://www.nasdaqtrader.com/dynamic/symdir/regsho/nasdaqth{day:%Y%m%d}.txt",
                    {"Accept": "text/plain"}, 20).decode("utf-8", "replace")
    if not _is_list(text):
        raise RuntimeError("不是名單檔")
    return parse_threshold(text)


def fetch_threshold_nyse(day):
    out = set()
    for market in ("NYSE", "NYSE American", "NYSE Arca"):
        q = urllib.parse.urlencode({"selectedDate": day.isoformat(), "market": market})
        text = http_get("https://www.nyse.com/api/regulatory/threshold-securities/download?" + q,
                        {"Accept": "text/plain"}, 20).decode("utf-8", "replace")
        if not _is_list(text):
            raise RuntimeError("不是名單檔")
        out |= parse_threshold(text)
    return out


def latest_threshold(fetch, today, back=6):
    """名單在收盤後公布、休市日沒有檔案，所以從今天往回找最近一份。-> (名單, 日期)"""
    last = None
    for i in range(back + 1):
        day = today - timedelta(days=i)
        if day.weekday() >= 5:
            continue
        try:
            return fetch(day), day.isoformat()
        except Exception as e:  # noqa: BLE001
            last = e
    raise last or RuntimeError("找不到名單")
