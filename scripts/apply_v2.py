"""一次性整理 index.html（可以重複執行，第二次之後不會再改任何東西）。

做五件事，其他內容（REPORT、POSITIONS、FX、STOCK_META、NAMES、DATA、主要畫面邏輯）完全不動：

  1. 移除 10/02 的 FINAL HOTFIX（樣式＋腳本）、寫死價位的「持倉判斷」（樣式＋腳本）、
     以及只靠它們顯示的「新增關注」區塊與導覽連結。
  2. 放一個「今日入場指示」區塊在摘要上面，導覽列第一個連結指到它。
  3. 狀態改名成位置標籤：觀察進場→均線附近、觀望／持有觀察→偏高、等待→均線之下、過熱不追→過熱。
     只改顯示的字，三條件的判斷方式不變。
  4. 在 risk-score.js 後面載入 verdict.js。
  5. 更新紀錄加一行。

用法：python scripts/apply_v2.py            （直接改 index.html）
      python scripts/apply_v2.py --dry-run  （只列出會改什麼，不寫檔）
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "index.html"
LOG = []


def log(status, what):
    LOG.append((status, what))


def remove(html, pattern, what, flags=re.S):
    """刪掉第一個符合的區塊（連同後面的空白）。找不到就當作已經刪過。"""
    m = re.search(pattern, html, flags)
    if not m:
        log("已經沒有", what)
        return html
    log("刪除", f"{what}（{html[m.start():m.end()].count(chr(10)) + 1} 行）")
    return html[:m.start()] + html[m.end():]


def swap(html, old, new, what):
    """把 old 換成 new。已經是 new 就跳過；兩個都找不到就記下來，不中斷。"""
    if old in html:
        log("修改", what)
        return html.replace(old, new)
    log("已經改過" if new in html else "找不到，略過", what)
    return html


def insert_before(html, anchor, block, marker, what):
    if marker in html:
        log("已經有了", what)
        return html
    if anchor not in html:
        log("找不到，略過", what)
        return html
    log("新增", what)
    return html.replace(anchor, block + anchor, 1)


def insert_after(html, anchor, block, marker, what):
    if marker in html:
        log("已經有了", what)
        return html
    if anchor not in html:
        log("找不到，略過", what)
        return html
    log("新增", what)
    return html.replace(anchor, anchor + block, 1)


NOT_END_COMMENT = r"(?:(?!-->).)*?"
NOT_END_SCRIPT = r"(?:(?!</script>).)*?"

VERDICT_SECTION = '''  <section id="verdict" class="panel">
    <h2>今日入場指示 <small id="verdict-stamp"></small></h2>
    <div id="verdict-body"><p class="note">讀取最終指示中…</p></div>
  </section>

'''
CHANGELOG_LINE = ('\n    "2026-10-09：新增「今日入場指示」，每一檔只給一個結論；狀態改名成位置標籤（均線附近／偏高／過熱／均線之下）；'
                  '回測加上分市場統計；處置股直接判高風險；移除 10/02 的 FINAL HOTFIX、寫死價位的持倉判斷與「新增關注」區塊。",')


def apply(html):
    # ---- 1. 舊補丁 --------------------------------------------------------
    html = remove(html, r"<!--" + NOT_END_COMMENT + r"STOCK REPORT FINAL HOTFIX" + NOT_END_COMMENT + r"-->\s*",
                  "FINAL HOTFIX 的說明註解")
    html = remove(html, r'<style id="final-hotfix-style">.*?</style>\s*', "FINAL HOTFIX 樣式")
    html = remove(html, r'<script id="final-hotfix-script">.*?</script>\s*', "FINAL HOTFIX 腳本")
    html = remove(html, r"<!--" + NOT_END_COMMENT + r"我的持倉｜續抱" + NOT_END_COMMENT + r"-->\s*", "持倉判斷的說明註解")
    html = remove(html, r"<style>\s*\.position-action-box.*?</style>\s*", "持倉判斷樣式")
    html = remove(html, r"<script>" + NOT_END_SCRIPT + r"HOLD_POSITION" + NOT_END_SCRIPT + r"</script>\s*",
                  "寫死價位的持倉判斷腳本")
    html = remove(html, r'[ \t]*<section id="u2-smart"[^>]*>.*?</section>\s*?\n', "「新增關注」區塊")
    html = remove(html, r'[ \t]*<a href="#u2-smart">[^<]*</a>\s*?\n', "導覽列的「新增關注」連結")

    # ---- 2. 今日入場指示 --------------------------------------------------
    html = insert_before(html, '  <section id="summary" class="panel">', VERDICT_SECTION, 'id="verdict-body"', "「今日入場指示」區塊")
    html = remove(html, r'[ \t]*<a href="#entry-pick">[^<]*</a>\s*?\n', "導覽列的「可進場選擇」連結")
    html = insert_after(html, "<nav>\n", '  <a href="#verdict">入場指示</a>\n', 'href="#verdict"', "導覽列的「入場指示」連結")

    # ---- 3. 狀態改名成位置標籤 --------------------------------------------
    html = swap(html,
                'const label = { go: "觀察進場", wait: "等待", hold: held ? "持有觀察" : "觀望", trim: held ? "過熱" : "過熱不追" }[cat];',
                'const label = { go: "均線附近", wait: "均線之下", hold: "偏高", trim: "過熱" }[cat];', "卡片的位置標籤")
    html = swap(html, '["go", "觀察進場", (a) => a.cat === "go"],', '["go", "均線附近", (a) => a.cat === "go"],', "篩選按鈕：均線附近")
    html = swap(html, '["hold", "觀望／持有觀察", (a) => a.cat === "hold"],', '["hold", "偏高", (a) => a.cat === "hold"],', "篩選按鈕：偏高")
    html = swap(html, '["wait", "等待", (a) => a.cat === "wait"],', '["wait", "均線之下", (a) => a.cat === "wait"],', "篩選按鈕：均線之下")
    html = swap(html, 'const names = { go: "觀察進場", hold: "觀望／持有觀察", trim: "過熱", wait: "等待" };',
                'const names = { go: "均線附近", hold: "偏高", trim: "過熱", wait: "均線之下" };', "回測表的狀態名稱")
    html = swap(html, '"<b>可進場觀察（" + go.length + " 檔）</b>：" + (go.length ? go.map(name).map(esc).join("、") : "目前沒有") + "。觀察進場不等於買進。"',
                '"<b>均線附近（" + go.length + " 檔）</b>：" + (go.length ? go.map(name).map(esc).join("、") : "目前沒有") + "。這是位置，不是進場訊號；能不能進場看最上面的「今日入場指示」。"',
                "摘要：均線附近")
    html = swap(html, 'go.length + " 檔觀察進場裡，達到 "', 'go.length + " 檔均線附近的股票裡，達到 "', "摘要：報酬風險比")
    html = swap(html, '"貼近 20 日高，指數本身不標觀察進場。"', '"貼近 20 日高。"', "大盤關卡說明")
    html = swap(html, "盤中價只當註記，不寫進日 K 與狀態。觀察進場不等於買進。", "盤中價只當註記，不寫進日 K 與狀態。位置標籤不是進場訊號。", "頁首說明")
    html = swap(html, "三條都過才是「觀察進場」，卡片上會寫沒過的是哪一條。", "三條都過標「均線附近」，卡片上會寫沒過的是哪一條。這是位置，不是進場訊號。", "使用方法：三條件")
    html = swap(html, "乖離超過 15% 顯示「過熱」（沒持倉是「過熱不追」）。", "乖離超過 15% 顯示「過熱」。", "使用方法：過熱")
    html = swap(html, "就算狀態是「觀察進場」也要留意。", "就算位置是「均線附近」也不進場。", "使用方法：報酬風險比")
    html = swap(html, "全部／觀察進場／規則進場訊號／持倉／報酬風險比達標", "全部／均線附近／規則進場訊號／持倉／報酬風險比達標", "使用方法：篩選按鈕")
    html = insert_after(html, "<h2>使用方法</h2>\n    <ol>\n",
                        "      <li>先看最上面的「今日入場指示」：每一檔只有一個結論（可進場／有訊號但沒全過／等回檔／不買）。"
                        "卡片上的位置標籤、進場條件核對、風險分數都是它的明細。</li>\n",
                        "先看最上面的「今日入場指示」", "使用方法：第一條")

    # ---- 4. 載入 verdict.js ----------------------------------------------
    tag = '<script src="./verdict.js"></script>'
    if tag in html:
        log("已經有了", "載入 verdict.js")
    elif '<script src="./risk-score.js"></script>' in html:
        log("新增", "載入 verdict.js")
        html = html.replace('<script src="./risk-score.js"></script>', '<script src="./risk-score.js"></script>\n' + tag, 1)
    elif "</body>" in html:
        log("新增", "載入 verdict.js（放在 </body> 前）")
        html = html.replace("</body>", tag + "\n</body>", 1)
    else:
        log("找不到，略過", "載入 verdict.js")

    # ---- 5. 更新紀錄 ------------------------------------------------------
    html = insert_after(html, "changelog: [", CHANGELOG_LINE, "新增「今日入場指示」，每一檔只給一個結論", "更新紀錄")
    return html


def main():
    dry = "--dry-run" in sys.argv
    before = TARGET.read_text(encoding="utf-8")
    after = apply(before)
    for status, what in LOG:
        print(f"{status:8s} {what}")
    missed = [w for s, w in LOG if s.startswith("找不到")]
    print(f"\n行數 {before.count(chr(10)) + 1} -> {after.count(chr(10)) + 1}；", "沒有變更" if after == before else "有變更", "（--dry-run，沒有寫檔）" if dry else "")
    if missed:
        print("有", len(missed), "項找不到對應的原文，沒有改：" + "、".join(missed))
    for must in ("const STOCK_META", "const DATA", "const POSITIONS", "const REPORT", 'id="cards"', 'id="pos-body"', "</html>"):
        if must in before and must not in after:
            raise SystemExit(f"安全檢查沒過：{must} 不見了，沒有寫檔")
    if not dry and after != before:
        TARGET.write_text(after, encoding="utf-8")


if __name__ == "__main__":
    main()
