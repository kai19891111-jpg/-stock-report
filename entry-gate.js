/* =====================================================================
   entry-gate.js｜進場條件核對燈號（個股卡片用）

   安裝：
   1. 把這個檔案放在 repo 根目錄（和 index.html 同一層）。
   2. 在 index.html 最後的 </body> 前面加一行：
        <script src="./entry-gate.js"></script>
   不需要改動 index.html 其他任何程式，也不需要改 Python 腳本。

   做什麼：
   讀 data/latest.json 與 data/strategy_stats.json，在「個股卡片」每張卡片的
   狀態列下方加上核對結果，並在卡片區上方加一行總覽。

     🟢 全過｜符合進場條件   有規則進場訊號，五項全部通過
     🟡 差一項｜先等         有規則進場訊號，只有一項沒過
     🔴 未過｜不進場         有規則進場訊號，但兩項以上沒過，或樣本不足、價位過期
     ⚪ 無訊號｜不進場       今天沒有規則進場訊號

   五項核對：
     1 訊號日期    日 K 是該市場最後完成的交易日，且行情沒有過期
     2 回測優勢    後段（樣本外）期望值區間下緣 > 0，且勝過隨機進場 ≥ 95%
                   （回測有分市場統計時，台股看台股、美股看美股）
     3 樣本數      後段已平倉筆數 ≥ minSample（預設 30）
     4 報酬風險比  entryRR ≥ min_rr
     5 價位        使用腳本當日重算的價位，不是頁面內建的舊價位

   這是條件核對，不是買進建議，不保證獲利，不自動下單。
   ===================================================================== */
(function () {
  "use strict";

  /* ---------- 可調整的門檻 ---------- */
  var CFG = {
    beatsMin: 0.95,      // 勝過隨機進場的比例門檻（和回測區塊的文字判斷一致）
    period: "oos",       // 用哪一段回測核對：oos＝後段（樣本外）；也可改 "all"、"insample"
    maxAgeHours: 96      // 行情超過幾小時沒更新就視為過期（讀得到 REPORT 時以它為準）
  };

  var L = null, S = null, loaded = false;
  var $ = function (id) { return document.getElementById(id); };
  var has = function (v) { return v !== null && v !== undefined && !isNaN(v); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var R = function (v) { return !has(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "R"; };
  var P = function (v) { return !has(v) ? "—" : (v * 100).toFixed(0) + "%"; };
  var md = function (iso) { return iso ? String(iso).slice(5, 7) + "/" + String(iso).slice(8, 10) : "—"; };
  function px(v, market) {
    if (!has(v)) return "—";
    return Number(v).toLocaleString("en-US", market === "US"
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  function stockName(code) {
    try { if (typeof NAMES !== "undefined" && NAMES[code]) return NAMES[code]; } catch (e) {}
    return code;
  }
  function usesAutoLevels(code) {          // 頁面是否採用了 latest.json 的價位（而不是內建舊價位）
    try { if (typeof DATA !== "undefined" && DATA[code]) return DATA[code].auto === true; } catch (e) {}
    return true;
  }
  function maxAge() {
    try { if (typeof REPORT !== "undefined" && has(REPORT.autoStaleAfterHours)) return REPORT.autoStaleAfterHours; } catch (e) {}
    return CFG.maxAgeHours;
  }

  /* ---------- 核對一檔 ---------- */
  function check(code) {
    if (!L || !L.quotes || !L.quotes[code]) return null;
    var q = L.quotes[code];
    // 有分市場統計（byMarketDetail）就用這檔股票自己市場的數字；沒有就退回全部市場
    var mkt = (S && S.byMarketDetail && S.byMarketDetail[q.market]) || null;
    var src = mkt || S;
    var st = src ? (src[CFG.period] || src.all || null) : null;
    var b = src ? (src.benchmark || null) : null;
    var scope = mkt ? ({ TW: "台股", US: "美股" }[q.market] || q.market) : "全部市場";
    var meta = (S && S.meta) || {};
    var minN = has(meta.minSample) ? meta.minSample : 30;
    var minRR = (L.params && has(L.params.min_rr)) ? L.params.min_rr : 1.5;
    var session = (L.sessions || {})[q.market];
    var ageH = L.dataTimestamp ? (Date.now() - new Date(L.dataTimestamp).getTime()) / 36e5 : Infinity;
    var periodName = { oos: "後段", insample: "前段", all: "全部" }[CFG.period] || CFG.period;
    var items = [];

    // 1 訊號日期
    var dateOk = !!session && q.date === session, ageOk = ageH <= maxAge();
    items.push({ label: "訊號日期", ok: dateOk && ageOk,
      text: !dateOk ? "日K " + md(q.date) + "，不是最後完成的交易日（" + md(session) + "）"
          : !ageOk ? "行情已 " + Math.floor(ageH) + " 小時沒更新"
          : "日K " + md(q.date) + "，是最後完成的交易日" });

    // 2 回測優勢
    var expFloor = st ? (has(st.expLow) ? st.expLow : st.expectancyR) : null;
    var expOk = has(expFloor) && expFloor > 0;
    var beatsOk = !!b && has(b.beats) && b.beats >= CFG.beatsMin;
    items.push({ label: "回測優勢", ok: expOk && beatsOk,
      text: !st ? "讀不到回測資料"
          : scope + periodName + "期望值 " + R(st.expectancyR) + (has(st.expLow) ? "（區間 " + R(st.expLow) + " ~ " + R(st.expHigh) + "）" : "") +
            "；勝過 " + (b ? P(b.beats) : "—") + " 的隨機進場（門檻 " + P(CFG.beatsMin) + "）" });

    // 3 樣本數（沒過直接紅燈）
    var n = st && has(st.sampleSize) ? st.sampleSize : 0;
    items.push({ label: "樣本數", ok: n >= minN, hard: true,
      text: scope + periodName + "已平倉 " + n + " 筆（門檻 " + minN + "）" });

    // 4 報酬風險比
    items.push({ label: "報酬風險比", ok: has(q.entryRR) && q.entryRR >= minRR,
      text: has(q.entryRR) ? q.entryRR.toFixed(2) + "（門檻 " + minRR + "）" : "算不出來" });

    // 5 價位（沒過直接紅燈）
    var auto = usesAutoLevels(code);
    items.push({ label: "價位", ok: auto, hard: true,
      text: auto ? "腳本 " + md(q.date) + " 收盤後重算" : "頁面內建的舊價位，待重算" });

    var fails = items.filter(function (x) { return !x.ok; });
    var level;
    if (q.entrySignal !== true) level = "n";
    else if (fails.some(function (x) { return x.hard; }) || fails.length >= 2) level = "r";
    else if (fails.length === 1) level = "y";
    else level = "g";
    return { code: code, q: q, items: items, fails: fails, level: level, maxHold: meta.maxHoldDays || null };
  }

  var HEAD = {
    g: "🟢 全過｜符合進場條件",
    y: "🟡 差一項｜先等",
    r: "🔴 未過｜不進場",
    n: "⚪ 無訊號｜不進場"
  };

  /* ---------- 畫在卡片上 ---------- */
  function gateHTML(v) {
    if (v.level === "n") return '<div class="gate gate-n"><b>' + HEAD.n + "</b><span>今天沒有規則進場訊號</span></div>";
    var q = v.q;
    var h = '<div class="gate gate-' + v.level + '"><b>' + HEAD[v.level] + "</b>";
    if (v.level === "y") h += "<span>沒過：" + esc(v.fails[0].label) + "</span>";
    if (v.level === "r") h += "<span>沒過：" + v.fails.map(function (x) { return esc(x.label); }).join("、") + "</span>";
    h += "<ul>" + v.items.map(function (x) {
      return '<li class="' + (x.ok ? "ok" : "no") + '"><i>' + (x.ok ? "✓" : "✗") + "</i><em>" + esc(x.label) + "</em>" + esc(x.text) + "</li>";
    }).join("") + "</ul>";
    if (v.level === "g" || v.level === "y") {
      h += '<p class="gate-plan">回測規則的做法：下一個交易日開盤進場，開盤價要在失效價 ' + px(q.stop, q.market) +
        " 與目標價 " + px(q.target1, q.market) + " 之間，否則不進；之後盤中碰到失效價或目標價就出場" +
        (v.maxHold ? "，最多持有 " + v.maxHold + " 個交易日" : "") + "。</p>";
    }
    h += '<p class="gate-note">條件核對，不是買進建議；倉位大小與是否下單由你決定。</p></div>';
    return h;
  }

  function decorate() {
    var box = $("cards");
    if (!box || !loaded) return;
    Array.prototype.forEach.call(box.querySelectorAll("article.card[data-code]"), function (card) {
      var old = card.querySelector(".gate");
      if (old) old.remove();
      var v = check(card.getAttribute("data-code"));
      if (!v) return;
      var anchor = card.querySelector(".why") || card.querySelector(".status");
      if (anchor) anchor.insertAdjacentHTML("afterend", gateHTML(v));
      card.setAttribute("data-gate", v.level);
    });
    summary(box);
  }

  function summary(box) {
    var el = $("gate-summary");
    if (!el) {
      el = document.createElement("div");
      el.id = "gate-summary";
      el.className = "gate-summary";
      box.parentNode.insertBefore(el, box);
    }
    if (!L || !L.quotes) { el.textContent = "進場條件核對：讀不到自動行情（data/latest.json），無法核對。"; return; }
    var by = { g: [], y: [], r: [], n: [] };
    Object.keys(L.quotes).forEach(function (c) { var v = check(c); if (v) by[v.level].push(c); });
    var list = function (k) { return by[k].length ? "（" + by[k].map(stockName).map(esc).join("、") + "）" : ""; };
    el.innerHTML = "<b>進場條件核對</b>" +
      "<span>🟢 全過 " + by.g.length + " 檔" + list("g") + "</span>" +
      "<span>🟡 差一項 " + by.y.length + " 檔" + list("y") + "</span>" +
      "<span>🔴 未過 " + by.r.length + " 檔" + list("r") + "</span>" +
      "<span>⚪ 無訊號 " + by.n.length + " 檔</span>" +
      "<em>🟢 代表規則條件齊全，不代表這一筆會賺。</em>";
  }

  /* ---------- 樣式 ---------- */
  function addStyle() {
    if ($("gate-style")) return;
    var s = document.createElement("style");
    s.id = "gate-style";
    s.textContent =
      ".gate{margin-top:8px;padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.14);border-left:4px solid #5c6570;background:rgba(0,0,0,.18);font-size:12px;line-height:1.5}" +
      ".gate>b{display:block;font-size:14px}" +
      ".gate>span{display:block;color:var(--muted,#c5d0de)}" +
      ".gate ul{list-style:none;margin:6px 0 0;padding:0}" +
      ".gate li{display:grid;grid-template-columns:16px 76px 1fr;gap:4px;padding:1px 0}" +
      ".gate li i{font-style:normal;font-weight:700}" +
      ".gate li em{font-style:normal;color:var(--muted,#c5d0de)}" +
      ".gate li.ok i{color:var(--green,#3dd68c)}" +
      ".gate li.no{color:var(--amber,#ffb450)}" +
      ".gate li.no i,.gate li.no em{color:var(--amber,#ffb450)}" +
      ".gate p{margin:6px 0 0}" +
      ".gate .gate-note{color:var(--muted,#c5d0de);font-size:11px}" +
      ".gate-g{border-left-color:var(--green,#3dd68c)}" +
      ".gate-y{border-left-color:var(--amber,#ffb450)}" +
      ".gate-r{border-left-color:var(--red,#ff6b6b)}" +
      ".gate-n{padding:5px 10px;background:transparent}" +
      ".gate-n>b{display:inline;font-size:12px;font-weight:600;margin-right:6px}" +
      ".gate-n>span{display:inline}" +
      ".gate-summary{margin:0 0 10px;padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.18);font-size:13px;display:flex;flex-wrap:wrap;gap:4px 14px}" +
      ".gate-summary b{flex-basis:100%}" +
      ".gate-summary em{flex-basis:100%;font-style:normal;font-size:11px;color:var(--muted,#c5d0de)}";
    document.head.appendChild(s);
  }

  /* ---------- 啟動：讀資料，並在卡片重畫（切換篩選、行情更新）時重新標示 ---------- */
  function getJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function start() {
    var box = $("cards");
    if (!box) return;
    addStyle();
    new MutationObserver(decorate).observe(box, { childList: true });   // 只看卡片清單本身，不會被自己加的內容觸發
    Promise.all([getJSON("./data/latest.json"), getJSON("./data/strategy_stats.json")]).then(function (res) {
      L = res[0]; S = res[1]; loaded = true;
      decorate();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
