"""盤中報價快照 -> intraday.json（放在 live 分支，頁面的 live.js 會讀）

只給頁面的「盤中註記」用：不寫進日 K、不改 latest.json、不影響訊號與最終指示。
由 .github/workflows/intraday.yml 在台股與美股盤中每 5 分鐘跑一次；兩個市場都收盤超過 45 分鐘時直接結束。

    python scripts/intraday.py                 # 有市場開盤才抓
    python scripts/intraday.py --force         # 不管開不開盤都抓一次
    python scripts/intraday.py --out x.json    # 指定輸出位置（預設 live-out/intraday.json）

只用標準函式庫。
"""
from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from marketdata import EXTRA_INDICES, MARKETS, ROOT, _download, load_universe, parse_chart

OPEN = {"TW": (9, 0), "US": (9, 30)}
AFTER_CLOSE_MIN = 45        # 收盤後還繼續抓多久（讓快照帶到收盤價）
WORKERS = 6


def session_state(market, now):
    """open 盤中｜settling 剛收盤｜closed 休市。不知道國定假日，假日當天會照抓，價格就是上一個收盤。"""
    m = MARKETS[market]
    local = now.astimezone(m["tz"])
    if local.weekday() >= 5:
        return "closed"
    mins = local.hour * 60 + local.minute
    o = OPEN[market][0] * 60 + OPEN[market][1]
    c = m["close"][0] * 60 + m["close"][1]
    if o <= mins < c:
        return "open"
    if c <= mins < c + AFTER_CLOSE_MIN:
        return "settling"
    return "closed"


def snapshot(raw, market):
    """Yahoo chart JSON -> 一筆報價。前收取「報價那一天之前」最後一根日 K 的收盤，不用 chartPreviousClose
    （range=5d 時那是五天前的收盤）。"""
    res = raw["chart"]["result"][0]
    meta = res.get("meta") or {}
    price, ts = meta.get("regularMarketPrice"), meta.get("regularMarketTime")
    if not isinstance(price, (int, float)) or price <= 0 or not ts:
        return None
    when = datetime.fromtimestamp(int(ts), tz=timezone.utc)
    day = when.astimezone(MARKETS[market]["tz"]).date().isoformat()
    prev = [b["close"] for b in parse_chart(raw, market) if b["date"] < day]
    num = lambda v: round(v, 4) if isinstance(v, (int, float)) else None  # noqa: E731
    return {"price": round(price, 4), "prevClose": num(prev[-1]) if prev else None, "time": when.isoformat(),
            "date": day, "high": num(meta.get("regularMarketDayHigh")), "low": num(meta.get("regularMarketDayLow")),
            "volume": meta.get("regularMarketVolume"), "market": market}


def fetch_one(args):
    symbol, market = args
    try:
        return symbol, snapshot(_download(symbol, "5d"), market), None
    except Exception as e:  # noqa: BLE001
        return symbol, None, (type(e).__name__ + ": " + str(e))[:120]


def main(argv=None, now=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    now = now or datetime.now(timezone.utc)
    out = Path(argv[argv.index("--out") + 1]) if "--out" in argv else ROOT / "live-out" / "intraday.json"
    state = {m: session_state(m, now) for m in MARKETS}
    if "--force" not in argv and all(s == "closed" for s in state.values()):
        print("兩個市場都休市，這次不抓。", state)
        return 0

    wanted = {s: m for s, (m, _theme) in load_universe().items()}
    for m, cfg in MARKETS.items():
        wanted[cfg["index"]] = m
    wanted.update(EXTRA_INDICES)
    quotes, errors = {}, {}
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for symbol, q, err in pool.map(fetch_one, sorted(wanted.items())):
            if q:
                quotes[symbol] = q
            else:
                errors[symbol] = err or "沒有報價"
    if not quotes:
        print("一檔都沒抓到，保留上一份快照。", errors)
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"generatedAt": now.isoformat(), "source": "Yahoo", "state": state,
                               "note": "盤中註記用的快照，不是收盤價，不寫進日 K。",
                               "quotes": quotes, "errors": errors}, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    print("quotes", len(quotes), "errors", len(errors), "state", state, "->", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
