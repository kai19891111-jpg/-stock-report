/* =====================================================================
   optimus.js｜人形機器人（Tesla Optimus 等）｜台灣供應鏈關注名單，依零件類別分組

   安裝：index.html 裡要有 <section id="optimus">…<div id="optimus-body"></div></section>，
        並在最後載入 <script src="./optimus.js"></script>。

   資料來源（每天自動更新，這裡不寫死任何價格）：
     data/latest.json  收盤、漲跌、成交量、MA5/10/20/60、RSI、MACD、支撐（失效價／進場區下緣）、壓力（20 日高／目標價）
     data/risk.json    法人買賣超與融資（FinMind）、月營收年增率與毛利率

   要手動維護的只有下面的 OPTIMUS：每檔的供應鏈角色、目前的消息狀態、有沒有正式訂單。
   原則：沒有公司或 Tesla 正式確認的關係，confirmed 一律是 false，頁面只會寫「待確認」，不會寫「確定供貨」。
   ===================================================================== */
(function () {
  "use strict";
  if (window.__optimus) return;
  window.__optimus = true;

  /* cat：零件類別（頁面依這個分組）；tier：優先／延伸。
     news 一律寫「媒體報導」或「公司說法」；沒有正式確認的供貨關係，confirmed 一律 false。 */
  var CATS = ["減速傳動", "馬達驅動", "感測視覺", "線材連接", "整機系統", "AI 晶片"];
  var OPTIMUS = {
    updated: "2026-10-23",
    items: [
      { code: "2049.TW", cat: "減速傳動", tier: "優先", role: "諧波減速機、滾珠螺桿、線性滑軌、交叉滾柱軸承", news: "人形機器人送樣與布局（媒體報導）", confirmed: false },
      { code: "2233.TW", cat: "減速傳動", tier: "優先", role: "精密減速機、關節零件", news: "北美機器人客戶認證（媒體報導）", confirmed: false },
      { code: "2464.TW", cat: "減速傳動", tier: "優先", role: "諧波減速機、機器人關節", news: "媒體報導涉及 Tesla 供應鏈（待確認）", confirmed: false },
      { code: "1536.TW", cat: "減速傳動", tier: "延伸", role: "精密齒輪、傳動系統", news: "", confirmed: false },
      { code: "1597.TW", cat: "減速傳動", tier: "延伸", role: "線性滑軌、模組化關節、微型六軸手臂", news: "布局人形機器人模組化關節（媒體報導）", confirmed: false },
      { code: "4583.TW", cat: "減速傳動", tier: "延伸", role: "精密行星減速機（協作機器人腰、肩關節）", news: "已打入物流協作機器人供應鏈（媒體報導）", confirmed: false },
      { code: "4540.TWO", cat: "減速傳動", tier: "延伸", role: "線性執行器、行星式滾柱螺桿（靈巧手）", news: "預計 2026 年小批量生產（媒體報導）", confirmed: false },
      { code: "4576.TW", cat: "馬達驅動", tier: "優先", role: "馬達、驅動控制、關節模組", news: "人形機器人布局（媒體報導）", confirmed: false },
      { code: "1504.TW", cat: "馬達驅動", tier: "延伸", role: "馬達、驅動器", news: "", confirmed: false },
      { code: "1590.TW", cat: "馬達驅動", tier: "延伸", role: "氣動元件、致動器", news: "", confirmed: false },
      { code: "3019.TW", cat: "感測視覺", tier: "優先", role: "視覺鏡頭、光學感測", news: "媒體報導涉及 Tesla 供應鏈（待確認）", confirmed: false },
      { code: "2359.TW", cat: "感測視覺", tier: "延伸", role: "機器視覺、AI 軟體", news: "", confirmed: false },
      { code: "3023.TW", cat: "線材連接", tier: "延伸", role: "線束、連接器", news: "", confirmed: false },
      { code: "3665.TW", cat: "線材連接", tier: "延伸", role: "高階線纜、連接系統", news: "", confirmed: false },
      { code: "4585.TW", cat: "整機系統", tier: "延伸", role: "協作機器人（廣達集團）", news: "", confirmed: false },
      { code: "6215.TW", cat: "整機系統", tier: "延伸", role: "自動化系統、優必選台灣代理", news: "", confirmed: false },
      { code: "8374.TW", cat: "整機系統", tier: "延伸", role: "自動化設備、系統整合", news: "", confirmed: false },
      { code: "2317.TW", cat: "整機系統", tier: "延伸", role: "代工與機器人平台（集團布局）", news: "", confirmed: false },
      { code: "2330.TW", cat: "AI 晶片", tier: "延伸", role: "AI 晶片製造", news: "", confirmed: false }
    ]
  };

  var $ = function (id) { return document.getElementById(id); };
  var has = function (v) { return v !== null && v !== undefined && !isNaN(v); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  function num(v, min, max) { return Number(v).toLocaleString("en-US", { minimumFractionDigits: min, maximumFractionDigits: max }); }
  function px(v) { return has(v) ? num(v, 0, 2) : "—"; }
  function pct(v) { return has(v) ? (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%" : "—"; }
  function lots(v) { return has(v) ? num(Math.round(v / 1000), 0, 0) + " 張" : "—"; }   // 台股成交量：股 → 張
  function md(iso) { return iso ? String(iso).slice(5, 7) + "/" + String(iso).slice(8, 10) : "—"; }
  function nm(code) { try { if (typeof NAMES !== "undefined" && NAMES[code]) return NAMES[code]; } catch (e) {} return code; }
  function getJSON(u) { return fetch(u, { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }

  /* ---------- 觀察標籤（只看技術面；🔵 是另外一欄的供應鏈消息） ---------- */
  function tag(q) {
    if (!q || !has(q.close) || !has(q.ma20) || !has(q.ma60)) return ["n", "⚪", "資料不足"];
    var weakMacd = q.macd === "轉弱" || q.macd === "零軸下";
    if (q.close < q.ma60 || (q.close < q.ma20 && weakMacd))
      return ["r", "🔴", "技術面轉弱：留意風險"];
    if (q.close > q.ma20 && q.ma20 > q.ma60 && has(q.rsi14) && q.rsi14 >= 50 && !weakMacd)
      return ["g", "🟢", "技術面偏強：關注進場機會"];
    return ["y", "🟡", "盤整中：持續觀察"];
  }
  var TAG_RULE = "🟢＝收盤在 MA20 之上、MA20 在 MA60 之上、RSI ≥ 50、MACD 沒轉弱；🔴＝收盤跌破 MA60，或跌破 MA20 且 MACD 轉弱；其餘 🟡。標籤只是位置，進場仍以「今日入場指示」的規則訊號為準。";

  function maRow(q) {
    var c = q.close;
    return ["ma5", "ma10", "ma20", "ma60"].map(function (k) {
      var v = q[k], n = k.slice(2);
      if (!has(v)) return "<span>MA" + n + " —</span>";
      return '<span class="' + (c >= v ? "up" : "dn") + '">MA' + n + " " + px(v) + "</span>";
    }).join("");
  }

  function card(it, L, R) {
    var q = L && L.quotes && L.quotes[it.code];
    var r = R && R.symbols && R.symbols[it.code];
    var head = '<div class="op-h"><b>' + esc(nm(it.code)) + "</b><small>" + esc(it.code.replace(/\.TWO?$/, "")) + "｜" + esc(it.tier) + "關注</small></div>" +
      '<div class="op-role">' + esc(it.role) + "</div>";
    var supply = '<div class="op-news">🔵 ' + esc(it.news || "供應鏈延伸，無個別 Optimus 消息") +
      "<em>" + (it.confirmed ? "已正式確認" : "正式訂單：未確認（不視為確定供貨）") + "</em></div>";
    if (!q) {
      return '<article class="op-card">' + head + '<p class="note">行情還沒抓到，下一次自動更新後就會出現。</p>' + supply + "</article>";
    }
    var t = tag(q);
    var ch = has(q.prevClose) ? q.close - q.prevClose : null, cp = has(q.prevClose) && q.prevClose ? (q.close / q.prevClose - 1) * 100 : null;
    var support = [has(q.stop) ? "失效 " + px(q.stop) : null, has(q.entryLow) ? "進場區下緣 " + px(q.entryLow) : null].filter(Boolean).join("｜");
    var resist = [has(q.high20) ? "20 日高 " + px(q.high20) : null, has(q.target1) ? "目標 " + px(q.target1) : null].filter(Boolean).join("｜");
    var it2 = r && r.items ? r.items : {};
    return '<article class="op-card op-' + t[0] + '">' + head +
      '<div class="op-tag">' + t[1] + " " + esc(t[2]) + "</div>" +
      '<div class="op-px">' + px(q.close) + '<span class="' + (ch > 0 ? "up" : ch < 0 ? "dn" : "") + '">' +
        (has(ch) ? (ch > 0 ? "▲ " : ch < 0 ? "▼ " : "— ") + px(Math.abs(ch)) + "（" + pct(cp) + "）" : "") + "</span></div>" +
      '<div class="op-sub">日K ' + esc(q.date) + "｜成交量 " + lots(q.volume) + (has(q.volumeRatio) ? "（量比 " + q.volumeRatio.toFixed(2) + "）" : "") + "</div>" +
      '<div class="op-ma">' + maRow(q) + "</div>" +
      '<dl class="op-kv">' +
        "<dt>RSI／MACD</dt><dd>" + (has(q.rsi14) ? Math.round(q.rsi14) : "—") + "／" + esc(q.macd || "—") + "</dd>" +
        "<dt>支撐</dt><dd>" + esc(support || "—") + "</dd>" +
        "<dt>壓力</dt><dd>" + esc(resist || "—") + "</dd>" +
        "<dt>法人／融資</dt><dd>" + esc((it2.chips && it2.chips.why) || "—") + "</dd>" +
        "<dt>月營收</dt><dd>" + esc((it2.fundamentals && it2.fundamentals.why) || "—") + "</dd>" +
      "</dl>" + supply + "</article>";
  }

  function render(L, R) {
    var body = $("optimus-body");
    if (!body) return;
    var counts = { g: 0, y: 0, r: 0, n: 0 };
    OPTIMUS.items.forEach(function (it) { counts[tag(L && L.quotes && L.quotes[it.code])[0]]++; });
    var st = $("optimus-stamp");
    if (st) st.textContent = "名單更新 " + md(OPTIMUS.updated) + (L && L.sessions && L.sessions.TW ? "｜台股日K " + L.sessions.TW : "");
    var group = function (cat) {
      var list = OPTIMUS.items.filter(function (it) { return it.cat === cat; });
      if (!list.length) return "";
      list.sort(function (a, b) { return (a.tier === "優先" ? 0 : 1) - (b.tier === "優先" ? 0 : 1); });
      return '<h3>【' + esc(cat) + "】<small>" + list.length + " 檔</small></h3><div class=\"op-grid\">" +
        list.map(function (it) { return card(it, L, R); }).join("") + "</div>";
    };
    body.innerHTML =
      '<p class="op-sum"><span>🟢 偏強 ' + counts.g + "</span><span>🟡 盤整 " + counts.y + "</span><span>🔴 轉弱 " + counts.r + "</span>" +
      (counts.n ? "<span>⚪ 資料不足 " + counts.n + "</span>" : "") + "<span>🔵 供應鏈消息 待確認 " +
      OPTIMUS.items.filter(function (it) { return !it.confirmed; }).length + "</span></p>" +
      CATS.map(group).join("") +
      '<p class="note">' + esc(TAG_RULE) + "</p>" +
      '<p class="note">價格、均線、RSI、MACD、支撐壓力每個交易日收盤後自動更新；法人與月營收來自 FinMind。Tesla Optimus 的合作、送樣、量產消息與是否已有正式訂單，需要人工核對後更新名單，沒有正式確認前一律標「待確認」。</p>';
  }

  function addStyle() {
    if ($("optimus-style")) return;
    var s = document.createElement("style");
    s.id = "optimus-style";
    s.textContent =
      ".op-sum{display:flex;flex-wrap:wrap;gap:6px 14px;font-weight:700;margin:0 0 6px}" +
      ".op-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;margin-bottom:8px}" +
      ".op-card{background:rgba(8,32,64,.82);border:1px solid rgba(142,192,255,.45);border-left:4px solid #5c6570;border-radius:12px;padding:10px 12px;min-width:0}" +
      ".op-g{border-left-color:#3dd68c}.op-y{border-left-color:#e8b931}.op-r{border-left-color:#ff6b6b}" +
      ".op-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.op-h b{font-size:17px}.op-h small{color:var(--muted,#c5d0de)}" +
      ".op-role{font-size:13px;color:var(--muted,#c5d0de);margin:2px 0 6px}" +
      ".op-tag{font-weight:700;margin-bottom:4px}" +
      ".op-px{font-size:22px;font-weight:700}.op-px span{font-size:14px;margin-left:8px}" +
      ".op-card .up{color:#ff6b6b}.op-card .dn{color:#3dd68c}" +
      ".op-sub{font-size:12px;color:var(--muted,#c5d0de);margin-bottom:6px}" +
      ".op-ma{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:12px;margin-bottom:6px}" +
      ".op-kv{display:grid;grid-template-columns:76px 1fr;gap:3px 8px;margin:0 0 8px;font-size:13px}" +
      ".op-kv dt{color:var(--muted,#c5d0de)}.op-kv dd{margin:0;overflow-wrap:anywhere}" +
      ".op-news{font-size:13px;padding:6px 8px;border-radius:8px;background:rgba(80,140,255,.14);border:1px solid rgba(80,140,255,.35)}" +
      ".op-news em{display:block;font-style:normal;font-size:12px;color:var(--muted,#c5d0de)}";
    document.head.appendChild(s);
  }

  function start() {
    if (!$("optimus-body")) return;
    addStyle();
    render(null, null);
    Promise.all([getJSON("./data/latest.json"), getJSON("./data/risk.json")]).then(function (res) { render(res[0], res[1]); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
