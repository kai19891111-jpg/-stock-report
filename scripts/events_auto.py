"""自動維護 data/events.json 的排定事件，讓風險分數的「政策」項目不會因為沒人手動更新而變 N/A。

每次 update-stock-report 先跑這支：
  - 把下面日曆裡「今天之後」的 FOMC、美國 CPI、台灣央行理監事會寫進 events（id 以 auto- 開頭）
  - 已經過去的 auto- 事件移除；手填的事件與 earnings 完全不動
  - 手填事件裡已經有同一天、同一類（標題含 FOMC／CPI／理監事會）的就不重複加
  - updatedAt 改成今天（台北），表示排定事件已核對到今天

日曆要每年補一次（官方通常前一年公布）。日曆用完時 risk.py 照樣只看手填事件。
只用標準函式庫。
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "events.json"
TPE = ZoneInfo("Asia/Taipei")

FED = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
BLS = "https://www.bls.gov/schedule/news_release/cpi.htm"
CBC = "https://www.cbc.gov.tw/tw/cp-302-189514-82841-1.html"

# FOMC 利率決議日（會議第二天）。2027 年為 Fed 2025-09-05 公布的暫定日程。
FOMC = [
    ("2026-10-28", "10/27–28", False), ("2026-12-09", "12/8–9", True),
    ("2027-01-27", "1/26–27", False), ("2027-03-17", "3/16–17", True), ("2027-04-28", "4/27–28", False),
    ("2027-06-09", "6/8–9", True), ("2027-07-28", "7/27–28", False), ("2027-09-15", "9/14–15", True),
    ("2027-10-27", "10/26–27", False), ("2027-12-08", "12/7–8", True),
]
# 美國 CPI 公布日（BLS 時程，美東 8:30）。
CPI = [
    ("2026-11-10", "10 月"), ("2026-12-10", "11 月"), ("2027-01-13", "12 月"), ("2027-02-11", "1 月"),
    ("2027-03-10", "2 月"), ("2027-04-13", "3 月"), ("2027-05-12", "4 月"), ("2027-06-10", "5 月"),
    ("2027-07-14", "6 月"), ("2027-08-11", "7 月"), ("2027-09-14", "8 月"), ("2027-10-14", "9 月"),
    ("2027-11-10", "10 月"), ("2027-12-10", "11 月"),
]
# 台灣央行理監事聯席會議（115 年日程）。116 年日程公布後補上。
CBC_MEETINGS = [("2026-12-17", "第 4 季")]

KINDS = {"fomc": "FOMC", "cpi": "CPI", "cbc": "理監事會"}


def calendar():
    out = []
    for d, span, sep in FOMC:
        out.append({"id": f"auto-fomc-{d}", "kind": "fomc", "type": "scheduled", "date": d,
                    "title": f"FOMC 利率決議（{span} 會議{'，附經濟預測' if sep else ''}）", "targets": ["*"], "source": FED})
    for d, m in CPI:
        out.append({"id": f"auto-cpi-{d}", "kind": "cpi", "type": "scheduled", "date": d,
                    "title": f"美國 {m} CPI 公布", "targets": ["US", "CRYPTO", "TW"], "source": BLS})
    for d, q in CBC_MEETINGS:
        out.append({"id": f"auto-cbc-{d}", "kind": "cbc", "type": "scheduled", "date": d,
                    "title": f"台灣央行{q}理監事會（利率決議）", "targets": ["TW"], "source": CBC})
    return out


def merge(raw, today):
    """raw = events.json 內容 -> (新內容, 加了幾件, 移除幾件)"""
    raw = dict(raw or {})
    manual = [e for e in (raw.get("events") or []) if not str((e or {}).get("id", "")).startswith("auto-")]
    old_auto = [e for e in (raw.get("events") or []) if str((e or {}).get("id", "")).startswith("auto-")]
    taken = {(str(e.get("date")), k) for e in manual for k, word in KINDS.items() if word in str(e.get("title", ""))}
    auto = []
    for e in calendar():
        if e["date"] < today.isoformat() or (e["date"], e["kind"]) in taken:
            continue
        auto.append({k: v for k, v in e.items() if k != "kind"})
    # 已經過去的手填排定事件保留（risk.py 自己會忽略），避免刪掉使用者的紀錄
    raw["events"] = manual + auto
    if auto:                      # 日曆用完時不更新日期，讓 risk.py 照常提醒「太久沒更新」
        raw["updatedAt"] = today.isoformat()
    raw["autoNote"] = "id 以 auto- 開頭的是 scripts/events_auto.py 依官方日程自動加的，每次更新會重寫；手填事件不會被動到。"
    removed = len([e for e in old_auto if e.get("id") not in {a["id"] for a in auto}])
    added = len([a for a in auto if a["id"] not in {e.get("id") for e in old_auto}])
    return raw, added, removed


def main(now=None):
    now = now or datetime.now(timezone.utc)
    today = now.astimezone(TPE).date()
    try:
        raw = json.loads(EVENTS.read_text(encoding="utf-8")) if EVENTS.exists() else {}
    except Exception as e:  # noqa: BLE001
        print("events.json 讀不到或格式錯，不動它：", e)
        return 1
    new, added, removed = merge(raw, today)
    EVENTS.write_text(json.dumps(new, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    future = sorted(e["date"] for e in new["events"] if str(e.get("id", "")).startswith("auto-"))
    print(f"events.json 更新：自動事件新增 {added}、移除 {removed}，接下來 {len(future)} 件"
          + (f"（到 {future[-1]}）" if future else "；日曆已用完，請補新年度日程"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
