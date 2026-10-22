/* =====================================================================
   screener.js｜自動選股雷達（讀 data/screener.json，由 scripts/screener.py 每次收盤更新後產生）

   安裝：index.html 裡要有 <section id="screener">…<div id="screener-body"></div></section>，
        並在最後載入 <script src="./screener.js"></script>。
   不動 DATA、STOCK_META、POSITIONS；只是提示，不會自動加入觀察名單，也不下單。
   ===================================================================== */
(function () {
  "use strict";
  if (window.__screener) return;
  window.__screener = true;

  var $ = function (id) { return document.getElementById(id); };
  var has = function (v) { return v !== null && v !== undefined && !isNaN(v); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var MK = [["TW", "台股"], ["US", "美股"], ["CRYPTO", "加密貨幣"]];
  var S = null, tab = null;
  try { tab = sessionStorage.getItem("screenerTab"); } catch (e) {}

  function num(v, min, max) { return Number(v).toLocaleString("en-US", { minimumFractionDigits: min, maximumFractionDigits: max }); }
  function px(v, m) {
    if (!has(v)) return "—";
    if (m === "TW") return num(v, 0, 2);
    if (m === "CRYPTO" && v < 1) return num(v, 4, 6);
    return num(v, 2, 2);
  }
  function pct(v) { return has(v) ? (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%" : "—"; }
  function nm(p) {
    try { if (typeof NAMES !== "undefined" && NAMES[p.code]) return NAMES[p.code]; } catch (e) {}
    return p.name || p.code;
  }
  function stamp(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    try { return d.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }); }
    catch (e) { return String(iso).slice(5, 16).replace("T", " "); }
  }

  function card(p, m) {
    var fails = (p.checks || []).filter(function (c) { return !c.ok; }).map(function (c) { return c.t; });
    var badges = (p.entrySignal ? '<span class="badge sig">規則進場訊號</span>' : "") +
      (p.watched ? '<span class="badge own">已在觀察名單</span>' : '<span class="badge sc-new">新發現</span>') +
      '<span class="badge sc-n">條件 ' + p.passed + "／" + p.total + "</span>";
    var inZone = p.zone === "IN_ZONE" ? "現價在進場區內" : p.zone === "ABOVE_ZONE" ? "現價高於進場區" : p.zone === "BELOW_ZONE" ? "現價低於進場區" : "";
    var code = String(p.code).replace(/\.TWO?$/, "").replace(/-USD$/, "");
    return '<article class="card sc-card"><div class="title">' + esc(nm(p)) + ' <small class="sc-code">' + esc(code) + "</small></div>" +
      '<div class="sub">' + (p.group ? esc(p.group.split("|")[1]) + "｜" : "") + "日K " + esc(p.date || "—") + "</div>" +
      '<div class="px">' + px(p.close, m) + '<span class="chg">' + pct(p.pct) + "</span></div>" +
      '<div class="status">' + badges + "</div>" +
      '<div class="kv">' +
        "<div><span>進場區</span><b>" + px(p.entryLow, m) + "–" + px(p.entryHigh, m) + "</b>" + (inZone ? "<em>" + inZone + "</em>" : "") + "</div>" +
        "<div><span>失效價</span><b>" + px(p.stop, m) + "</b>" + (has(p.stop) && p.close ? "<em>距離 " + ((1 - p.stop / p.close) * 100).toFixed(1) + "%</em>" : "") + "</div>" +
        "<div><span>目標價</span><b>" + px(p.target1, m) + "</b>" + (has(p.target1) && p.close ? "<em>距離 " + ((p.target1 / p.close - 1) * 100).toFixed(1) + "%</em>" : "") + "</div>" +
        "<div><span>報酬風險比</span><b>" + (has(p.rr) ? p.rr.toFixed(2) : "算不出來") + "</b><em>RSI " + (has(p.rsi) ? Math.round(p.rsi) : "—") +
          "｜量比 " + (has(p.volRatio) ? p.volRatio.toFixed(2) : "—") + "</em></div>" +
      "</div>" +
      '<div class="why sc-why">' + (fails.length ? "還卡：" + esc(fails.join("、")) : "九條全過") + "</div></article>";
  }

  function render() {
    var body = $("screener-body");
    if (!body) return;
    if (!S || !S.markets) {
      body.innerHTML = '<p class="note">選股雷達還沒跑過，下一次收盤自動更新後就會出現。</p>';
      return;
    }
    var avail = MK.filter(function (x) { return S.markets[x[0]]; });
    if (!avail.length) { body.innerHTML = '<p class="note">這次沒有掃描結果。</p>'; return; }
    if (!tab || !S.markets[tab]) tab = avail[0][0];
    var M = S.markets[tab];
    var st = $("screener-stamp");
    if (st) st.textContent = "更新 " + stamp(S.generatedAt) + " 台北";
    var h = '<div class="chips" role="tablist">' + avail.map(function (x) {
      var mm = S.markets[x[0]];
      return '<button type="button" class="chip" role="tab" data-sc="' + x[0] + '" aria-pressed="' + (x[0] === tab) + '">' +
        x[1] + "<b>" + ((mm.picks || []).length) + "</b></button>";
    }).join("") + "</div>";
    h += '<p class="note">' + esc(M.universe || "") + "：成功掃描 " + (M.ok || 0) + "／" + (M.scanned || 0) + " 檔，符合 " +
      (M.candidates || 0) + " 檔（其中規則進場訊號 " + (M.signals || 0) + " 檔），列出前 " + ((M.picks || []).length) + " 檔" +
      (M.session ? "｜日K " + esc(M.session) : "") + "。</p>";
    h += (M.picks && M.picks.length)
      ? '<div class="cards">' + M.picks.map(function (p) { return card(p, tab); }).join("") + "</div>"
      : '<p class="note">今天沒有接近進場條件的標的。</p>';
    var p = S.params || {};
    h += '<p class="note">排序：先看「規則進場訊號」（回測那條規則今天成立），再看九條條件過了幾條、報酬風險比。列入門檻：規則訊號成立，或至少過 ' +
      (p.minPass || 7) + " 條且乖離在 −1.5% 到 8% 之間。條件：收在 SMA20 上、乖離 0–6%、未貼近 20 日高、報酬風險比 ≥ " + (p.min_rr || 1.5) +
      "、RSI " + (p.rsi_lo || 45) + "–" + (p.rsi_hi || 60) + "、日線週線不是空頭、MACD 沒轉弱、大盤不是空頭、量比 ≥ " + (p.volMin || 1.2) +
      "。這只是提示，不會自動加入觀察名單，也不下單；「新發現」的股票沒有風險分數（財報、籌碼），進場前要自己核對。</p>";
    if (S.errors && S.errors.length) h += '<details class="note"><summary>資料來源提醒（' + S.errors.length + "）</summary>" + S.errors.map(esc).join("<br>") + "</details>";
    body.innerHTML = h;
  }

  function addStyle() {
    if ($("screener-style")) return;
    var s = document.createElement("style");
    s.id = "screener-style";
    s.textContent = ".sc-code{font-size:12px;color:var(--muted,#c5d0de);font-weight:500}" +
      ".badge.sc-new{background:#2d6a4f;color:#fff}.badge.sc-n{background:transparent;border:1px solid rgba(255,255,255,.4);color:var(--text,#fff)}" +
      ".sc-why{font-size:12px}";
    document.head.appendChild(s);
  }

  function start() {
    var body = $("screener-body");
    if (!body) return;
    addStyle();
    body.addEventListener("click", function (e) {
      var b = e.target.closest("[data-sc]");
      if (!b) return;
      tab = b.getAttribute("data-sc");
      try { sessionStorage.setItem("screenerTab", tab); } catch (err) {}
      render();
    });
    fetch("./data/screener.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { S = j; render(); })
      .catch(function () { S = null; render(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
