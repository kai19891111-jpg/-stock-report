/* =====================================================================
   risk-score.js｜風險分數（個股卡片用）

   安裝：
   1. 把這個檔案放在 repo 根目錄（和 index.html、entry-gate.js 同一層）。
   2. 在 index.html 最後、<script src="./entry-gate.js"></script> 的下一行加：
        <script src="./risk-score.js"></script>
   不需要改 index.html 其他程式，不動 DATA、STOCK_META、POSITIONS。

   做什麼：
   讀 scripts/risk.py 產生的 data/risk.json，在每張個股卡片加一塊風險分數，
   並在卡片區上方加一行總覽。

     五個項目各 0-2 分：過熱、財報、基本面、籌碼、政策。
     抓不到資料的項目顯示 N/A，不計分；有分數的項目少於 3 項標「資料不足」。
     狀態是「觀察進場」但風險沒過（財報 3 日內、處置／注意股、風險中或高）時，
     卡片會多一行提醒。原本的狀態徽章不會被改掉。

   這是條件核對，不是買賣建議，不自動下單。
   ===================================================================== */
(function () {
  "use strict";

  var STALE_HOURS = 96;                    // risk.json 超過幾小時沒更新就提醒（週末不會誤報）
  var R = null, loaded = false;

  var $ = function (id) { return document.getElementById(id); };
  var has = function (v) { return v !== null && v !== undefined && !isNaN(v); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var LEVEL = {
    low: { cls: "l", text: "低" },
    mid: { cls: "m", text: "中" },
    high: { cls: "h", text: "高" },
    insufficient: { cls: "n", text: "資料不足" }
  };
  function stockName(code) { return (typeof NAMES !== "undefined" && NAMES[code]) || code; }
  function order() { return (R && R.order) || ["tech", "earnings", "fundamentals", "chips", "policy"]; }
  function label(k) { return (R && R.labels && R.labels[k]) || k; }
  function safeUrl(u) { return typeof u === "string" && /^https?:\/\//.test(u) ? u : null; }
  function stamp(iso) {                    // 換成台北時間顯示
    var d = new Date(iso);
    if (isNaN(d)) return "—";
    try {
      return d.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    } catch (e) { return String(iso).slice(5, 16).replace("T", " "); }
  }
  function ageHours() { return R && R.generatedAt ? (Date.now() - new Date(R.generatedAt).getTime()) / 36e5 : null; }

  /* ---------- 畫在卡片上 ---------- */
  function riskHTML(v, status) {
    var lv = LEVEL[v.level] || LEVEL.insufficient;
    var total = order().length;
    var h = '<div class="risk risk-' + lv.cls + '">' +
      "<b>風險 " + (v.max ? v.total + "／" + v.max : "—") + "<span>" + lv.text + "</span></b>" +
      '<span class="risk-sub">有分數 ' + v.scored + "／" + total + " 項" + (v.scored < total ? "，其餘 N/A 不計分" : "") + "</span>";
    if (status === "觀察進場" && v.gate && v.gate.block) {
      h += '<p class="risk-warn">⚠ 狀態是觀察進場，但風險沒過：' + v.gate.reasons.map(esc).join("、") + "。先不新增部位。</p>";
    } else if (v.flags && v.flags.indexOf("earnings_soon") >= 0) {
      h += '<p class="risk-warn">⚠ 財報 3 個交易日內。</p>';
    }
    h += '<div class="risk-pips">' + order().map(function (k) {
      var it = v.items[k] || {};
      var s = has(it.score) ? it.score : null;
      return '<span class="rk' + (s === null ? "na" : s) + '">' + esc(label(k)) + " " + (s === null ? "N/A" : s) + "</span>";
    }).join("") + "</div>";
    h += "<details><summary>每一項的理由與資料日期</summary><ul>" + order().map(function (k) {
      var it = v.items[k] || {};
      var s = has(it.score) ? it.score : null;
      var url = safeUrl(it.source);
      return '<li class="rk' + (s === null ? "na" : s) + '"><i>' + (s === null ? "–" : s) + "</i><em>" + esc(label(k)) + "</em><span>" +
        esc(it.why || "") + (url ? ' <a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">來源</a>' : "") + "</span></li>";
    }).join("") + "</ul></details></div>";
    return h;
  }

  function decorate() {
    var box = $("cards");
    if (!box || !loaded) return;
    Array.prototype.forEach.call(box.querySelectorAll("article.card[data-code]"), function (card) {
      var old = card.querySelector(".risk");
      if (old) old.remove();
      var v = R && R.symbols && R.symbols[card.getAttribute("data-code")];
      if (!v) return;
      var anchor = card.querySelector(".gate") || card.querySelector(".why") || card.querySelector(".status");
      if (anchor) anchor.insertAdjacentHTML("afterend", riskHTML(v, card.getAttribute("data-status")));
      card.setAttribute("data-risk", v.level);
    });
    summary(box);
  }

  function summary(box) {
    var el = $("risk-summary");
    if (!el) {
      el = document.createElement("div");
      el.id = "risk-summary";
      el.className = "risk-summary";
      box.parentNode.insertBefore(el, box);
    }
    if (!R || !R.symbols) { el.textContent = "風險分數：讀不到 data/risk.json，卡片不顯示風險。"; return; }
    var by = { high: [], mid: [], low: [], insufficient: [] }, soon = [];
    Object.keys(R.symbols).forEach(function (c) {
      var v = R.symbols[c];
      (by[v.level] || by.insufficient).push(c);
      if (v.flags && v.flags.indexOf("earnings_soon") >= 0) soon.push(c);
    });
    var list = function (a) { return a.length ? "（" + a.map(stockName).map(esc).join("、") + "）" : ""; };
    var age = ageHours();
    var failed = Object.keys(R.sources || {}).filter(function (k) { var s = R.sources[k]; return s.fail > 0 || s.skipped; });
    el.innerHTML = "<b>風險分數</b>" +
      "<span>高 " + by.high.length + " 檔" + list(by.high) + "</span>" +
      "<span>中 " + by.mid.length + " 檔" + list(by.mid) + "</span>" +
      "<span>低 " + by.low.length + " 檔</span>" +
      "<span>資料不足 " + by.insufficient.length + " 檔</span>" +
      (soon.length ? "<span>財報 3 日內：" + soon.map(stockName).map(esc).join("、") + "</span>" : "") +
      "<em>計分時間 " + stamp(R.generatedAt) + "（台北）" +
      (has(age) && age > STALE_HOURS ? "，已超過 " + STALE_HOURS + " 小時沒更新，分數可能過期" : "") +
      (R.events && !R.events.fresh ? "｜事件檔 events.json 沒更新，政策項目為 N/A" : "") +
      (failed.length ? "｜有來源沒抓到：" + failed.map(esc).join("、") : "") +
      "｜分數低不代表安全，只代表這五項沒有亮燈。</em>";
  }

  /* ---------- 樣式 ---------- */
  function addStyle() {
    if ($("risk-style")) return;
    var s = document.createElement("style");
    s.id = "risk-style";
    s.textContent =
      ".risk{margin-top:8px;padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.14);border-left:4px solid #5c6570;background:rgba(0,0,0,.18);font-size:12px;line-height:1.5}" +
      ".risk>b{display:block;font-size:14px}" +
      ".risk>b span{margin-left:8px;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid currentColor}" +
      ".risk .risk-sub{display:block;color:var(--muted,#c5d0de)}" +
      ".risk .risk-warn{margin:6px 0 0;color:var(--amber,#ffb450);font-weight:600}" +
      ".risk-l{border-left-color:var(--green,#3dd68c)}.risk-l>b span{color:var(--green,#3dd68c)}" +
      ".risk-m{border-left-color:var(--amber,#ffb450)}.risk-m>b span{color:var(--amber,#ffb450)}" +
      ".risk-h{border-left-color:var(--red,#ff6b6b)}.risk-h>b span{color:var(--red,#ff6b6b)}" +
      ".risk-n>b span{color:var(--muted,#c5d0de)}" +
      ".risk-pips{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}" +
      ".risk-pips span{padding:1px 7px;border-radius:6px;border:1px solid rgba(255,255,255,.18);white-space:nowrap}" +
      ".risk-pips .rk1{border-color:var(--amber,#ffb450);color:var(--amber,#ffb450)}" +
      ".risk-pips .rk2{border-color:var(--red,#ff6b6b);color:var(--red,#ff6b6b);font-weight:700}" +
      ".risk-pips .rkna{color:var(--muted,#c5d0de);border-style:dashed}" +
      ".risk details{margin-top:6px}" +
      ".risk summary{cursor:pointer;color:var(--blue,#8ec0ff)}" +
      ".risk ul{list-style:none;margin:6px 0 0;padding:0}" +
      ".risk li{display:grid;grid-template-columns:14px 46px 1fr;gap:4px;padding:2px 0}" +
      ".risk li i{font-style:normal;font-weight:700}" +
      ".risk li em{font-style:normal;color:var(--muted,#c5d0de)}" +
      ".risk li span{overflow-wrap:anywhere}" +
      ".risk li.rk1 i{color:var(--amber,#ffb450)}.risk li.rk2 i{color:var(--red,#ff6b6b)}.risk li.rkna{color:var(--muted,#c5d0de)}" +
      ".risk a{color:var(--blue,#8ec0ff)}" +
      ".risk-summary{margin:0 0 10px;padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.18);font-size:12px;line-height:1.6}" +
      ".risk-summary b{margin-right:8px}" +
      ".risk-summary span{display:inline-block;margin-right:10px}" +
      ".risk-summary em{display:block;font-style:normal;color:var(--muted,#c5d0de);font-size:11px}";
    document.head.appendChild(s);
  }

  /* ---------- 啟動 ---------- */
  function start() {
    var box = $("cards");
    if (!box) return;
    addStyle();
    new MutationObserver(decorate).observe(box, { childList: true });   // 只看卡片清單本身，不會被自己加的內容觸發
    fetch("./data/risk.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (json) { R = json; loaded = true; decorate(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
