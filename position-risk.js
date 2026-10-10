/* =====================================================================
   position-risk.js｜持倉風險金額＋日 K 日期檢查＋股數保守估算

   安裝：
   1. 把這個檔案放在 repo 根目錄（和 index.html、verdict.js 同一層）。
   2. 在 index.html 最後、<script src="./live.js"></script> 的下一行加：
        <script src="./position-risk.js"></script>
   不需要改 Python 腳本，不動 DATA、STOCK_META、POSITIONS。

   做什麼：
   A.「我的持倉」多一塊「碰到失效價會賠多少」：
      每個部位從現價跌到失效價會回吐多少台幣、到時相對成本是賺是賠，以及全部加總。
      失效價用卡片上同一個數字（DATA 的 invalid，也就是腳本每天重算的停損）。
   B. 日 K 日期檢查：照交易日曆算「現在應該已經有哪一天的日 K」，頁面上的日 K 比它舊就亮警示。
      原本的過期警示只看腳本執行時間；腳本有跑、但資料來源回傳舊日 K 時不會亮，這裡補上。
      休市日要自己加進下面的 holidays，沒加的話休市隔天會多亮一次警示。
   C. 股數保守估算：在「每筆最多賠」算出的股數後面，用回測裡虧損交易的平均倍數再算一個保守股數
      （停損單遇到跳空與成本，實際平均賠的比預計多）。

   這是條件核對的輔助，不是買賣建議，不自動下單。
   ===================================================================== */
(function () {
  "use strict";
  if (window.__positionRisk) return;
  window.__positionRisk = true;

  /* ---------- 設定：要調整只改這裡，或在這個檔案之前設 window.POSITION_RISK_CONFIG ---------- */
  var CFG = {
    holidays: {                                  // 平日休市的日期（週末不用填）
      TW: ["2026-10-09", "2026-10-26", "2027-01-01"],
      US: ["2026-11-26", "2026-12-25", "2027-01-01"]
    },
    closeMin: { TW: 13 * 60 + 30, US: 16 * 60 },  // 收盤時間（當地，從零點起的分鐘）
    bufferMin: { TW: 120, US: 240 },             // 收盤後多久才算「自動更新應該跑完了」
    warnMissing: 1,                              // 少幾個交易日的日 K 就亮警示
    bigGivebackPct: 10                           // 全部碰到失效價的回吐超過總市值幾 % 就用警示色
  };
  var user = window.POSITION_RISK_CONFIG || {};
  Object.keys(user).forEach(function (k) { CFG[k] = user[k]; });

  var TZ = { TW: "Asia/Taipei", US: "America/New_York" };
  var MKT_NAME = { TW: "台股", US: "美股" };
  var lossR = null;                              // 回測裡虧損交易平均賠幾倍的預計金額（讀 strategy_stats.json）

  /* ---------- 小工具 ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var has = function (v) { return v !== null && v !== undefined && v !== "" && !isNaN(v) && isFinite(v); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&", "<": "<", ">": ">", '"': """, "'": "&#39;" }[c];
    });
  };
  function g(name) {                             // 讀頁面的全域常數，沒有就回 null
    try {
      if (name === "POSITIONS") return typeof POSITIONS !== "undefined" ? POSITIONS : null;
      if (name === "DATA") return typeof DATA !== "undefined" ? DATA : null;
      if (name === "FX") return typeof FX !== "undefined" ? FX : null;
      if (name === "NAMES") return typeof NAMES !== "undefined" ? NAMES : null;
      if (name === "STOCK_META") return typeof STOCK_META !== "undefined" ? STOCK_META : null;
    } catch (e) {}
    return null;
  }
  function nm(code) { var n = g("NAMES"); return (n && n[code]) || code; }
  function num(v, min, max) { return Number(v).toLocaleString("en-US", { minimumFractionDigits: min, maximumFractionDigits: max }); }
  function twd(v) { return "NT$" + num(Math.round(Math.abs(v)), 0, 0); }
  function signedTwd(v) { var r = Math.round(v); return (r > 0 ? "+" : r < 0 ? "−" : "") + twd(r); }
  function px(v, ccy) { return ccy === "TWD" ? num(v, 0, 2) : num(v, 2, 2); }
  function md(iso) { return iso ? String(iso).slice(5, 7) + "/" + String(iso).slice(8, 10) : "—"; }

  /* =====================================================================
     A. 碰到失效價會賠多少
     ===================================================================== */
  function riskRows() {
    var P = g("POSITIONS"), D = g("DATA"), F = g("FX");
    if (!P || !D) return null;
    var rows = [];
    P.forEach(function (p) {
      var d = D[p.code];
      var price = has(p.quote) && p.quote > 0 ? p.quote : (d && has(d.p) ? d.p : null);
      var fx = p.ccy === "TWD" ? 1 : (F && has(F.USDTWD) ? F.USDTWD : null);
      if (!has(price) || !has(fx) || !has(p.qty) || !has(p.cost)) return;
      var stop = d ? parseFloat(d.invalid) : NaN;
      var r = { code: p.code, ccy: p.ccy, price: price, stop: has(stop) && stop > 0 ? stop : null,
                value: p.qty * price * fx, pl: p.qty * (price - p.cost) * fx };
      if (r.stop !== null) {
        r.broken = price <= r.stop;
        r.give = r.broken ? 0 : p.qty * (price - r.stop) * fx;          // 從現價跌到失效價會少掉多少
        r.plAtStop = r.broken ? r.pl : p.qty * (r.stop - p.cost) * fx;  // 到失效價時相對成本的損益
        r.dist = (1 - r.stop / price) * 100;
      }
      rows.push(r);
    });
    return rows;
  }

  function riskHTML(rows) {
    var withStop = rows.filter(function (r) { return r.stop !== null; });
    var noStop = rows.filter(function (r) { return r.stop === null; });
    var total = rows.reduce(function (s, r) { return s + r.value; }, 0);
    var plNow = rows.reduce(function (s, r) { return s + r.pl; }, 0);
    var give = withStop.reduce(function (s, r) { return s + r.give; }, 0);
    var plAfter = rows.reduce(function (s, r) { return s + (r.stop !== null ? r.plAtStop : r.pl); }, 0);
    var givePct = total ? give / total * 100 : 0;
    var top = withStop.slice().sort(function (a, b) { return b.give - a.give; })[0];

    var h = "<h3>碰到失效價會賠多少 <small>用卡片上同一個失效價換算成台幣</small></h3>";
    if (withStop.length) {
      h += '<p class="pr-sum' + (givePct >= CFG.bigGivebackPct ? " pr-warn" : "") + '">' +
        (withStop.length === rows.length ? "全部" : withStop.length + " 個部位") + "碰到失效價：未實現損益會從 <b>" + esc(signedTwd(plNow)) +
        "</b> 變成 <b>" + esc(signedTwd(plAfter)) + "</b>，回吐 <b>" + esc(twd(give)) + "</b>（總市值的 " + givePct.toFixed(1) + "%）。" +
        (top && give > 0 && withStop.length > 1 ? "其中 " + esc(nm(top.code)) + " 佔 " + esc(twd(top.give)) + "。" : "") + "</p>";
    }
    h += "<ul>" + rows.map(function (r) {
      if (r.stop === null) {
        return '<li class="pr-na"><b>' + esc(nm(r.code)) + "</b><span>沒有失效價，算不出來。這個部位沒有算進上面的合計。</span></li>";
      }
      if (r.broken) {
        return '<li class="pr-broken"><b>' + esc(nm(r.code)) + "</b><span>現價 " + px(r.price, r.ccy) + " 已經在失效價 " + px(r.stop, r.ccy) +
          " 以下。目前相對成本 " + esc(signedTwd(r.pl)) + "。</span></li>";
      }
      return "<li><b>" + esc(nm(r.code)) + "</b><span>現價 " + px(r.price, r.ccy) + " → 失效價 " + px(r.stop, r.ccy) + "（−" + r.dist.toFixed(1) +
        "%）</span><span>回吐 <b>" + esc(twd(r.give)) + "</b>｜到時相對成本 <b class=\"" + (r.plAtStop < 0 ? "pr-neg" : "pr-pos") + '">' +
        esc(signedTwd(r.plAtStop)) + "</b></span></li>";
    }).join("") + "</ul>";
    h += '<p class="note">失效價每天跟著 SMA20 和波動重算，不是買進時設的停損。跳空開低時實際成交價會比失效價差' +
      (noStop.length ? "；有 " + noStop.length + " 個部位沒有失效價" : "") + "。美元部位用頁面的固定匯率換算。</p>";
    return h;
  }

  function renderRisk() {
    var pos = $("pos-body");
    if (!pos) return;
    var rows = riskRows();
    var el = $("pr-risk");
    if (!rows || !rows.length) { if (el) el.remove(); return; }
    var html = riskHTML(rows);
    if (el && el.parentNode === pos && el.__html === html) return;      // 內容沒變就不動，避免自己觸發自己
    if (!el || el.parentNode !== pos) {
      el = document.createElement("div");
      el.id = "pr-risk"; el.className = "pr-risk";
      var hold = pos.querySelector("#vd-hold");
      if (hold && hold.parentNode === pos) pos.insertBefore(el, hold); else pos.appendChild(el);
    }
    el.innerHTML = html; el.__html = html;
  }

  /* =====================================================================
     B. 日 K 日期檢查
     ===================================================================== */
  function clock(tz, ms) {                       // 那個時區的 {date:"2026-10-09", mins:從零點起的分鐘}
    var p = {};
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return { date: p.year + "-" + p.month + "-" + p.day, mins: (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10) };
  }
  function addDays(iso, n) {
    var a = iso.split("-");
    return new Date(Date.UTC(+a[0], +a[1] - 1, +a[2]) + n * 864e5).toISOString().slice(0, 10);
  }
  function isSession(mkt, iso) {
    var a = iso.split("-"), wd = new Date(Date.UTC(+a[0], +a[1] - 1, +a[2])).getUTCDay();
    return wd !== 0 && wd !== 6 && ((CFG.holidays && CFG.holidays[mkt]) || []).indexOf(iso) < 0;
  }
  function expectedLast(mkt, now) {              // 現在應該已經收完、而且自動更新跑過的最後一個交易日
    var c = clock(TZ[mkt], now), d = c.date;
    for (var i = 0; i < 20; i++) {
      if (isSession(mkt, d) && (d !== c.date || c.mins >= CFG.closeMin[mkt] + CFG.bufferMin[mkt])) return d;
      d = addDays(d, -1);
    }
    return null;
  }
  function actualLast(mkt) {                     // 頁面上這個市場最新的日 K 日期
    var M = g("STOCK_META"), D = g("DATA"), best = null;
    if (!M || !D) return null;
    Object.keys(M).forEach(function (key) {
      if (key.split("|")[0] !== mkt) return;
      M[key].forEach(function (c) { if (D[c] && D[c].date && (!best || D[c].date > best)) best = D[c].date; });
    });
    return best;
  }
  function missingSessions(mkt, actual, expected) {
    var n = 0, d = expected;
    for (var i = 0; i < 40 && d > actual; i++) { if (isSession(mkt, d)) n++; d = addDays(d, -1); }
    return n;
  }
  function checkDates() {
    var now = Date.now(), msgs = [];
    ["TW", "US"].forEach(function (m) {
      var actual = actualLast(m), expected = expectedLast(m, now);
      if (!actual || !expected || actual >= expected) return;
      var n = missingSessions(m, actual, expected);
      if (n >= CFG.warnMissing) msgs.push(MKT_NAME[m] + "日 K 停在 " + md(actual) + "，照交易日算應該已經有 " + md(expected) + "（少 " + n + " 個交易日）");
    });
    var el = $("pr-date-banner");
    if (!msgs.length) { if (el) el.hidden = true; return; }
    if (!el) {
      el = document.createElement("div");
      el.id = "pr-date-banner"; el.className = "banner";
      var ref = $("stale-banner");
      if (ref && ref.parentNode) ref.parentNode.insertBefore(el, ref.nextSibling);
      else document.body.insertBefore(el, document.body.firstChild);
    }
    el.hidden = false;
    el.textContent = msgs.join("；") + "。價位、位置標籤與入場指示都是用舊日 K 算的。如果那幾天是休市，把日期加進 position-risk.js 的 holidays；不是的話，請到 GitHub Actions 看自動更新有沒有抓到新資料。";
  }

  /* =====================================================================
     C. 股數保守估算
     ===================================================================== */
  function adjustShares() {
    var body = $("verdict-body");
    if (!body || !has(lossR) || lossR <= 1.01) return;
    Array.prototype.forEach.call(body.querySelectorAll(".vd-shares"), function (p) {
      if (p.querySelector(".pr-adj")) return;
      var b = p.querySelector("b");
      var n = b ? parseInt(String(b.textContent).replace(/[^\d]/g, ""), 10) : NaN;
      if (!(n > 0)) return;
      var safe = Math.floor(n / lossR);
      var s = document.createElement("span");
      s.className = "pr-adj";
      s.textContent = "回測裡虧損的交易平均賠到預計金額的 " + lossR.toFixed(2) + " 倍（跳空開低、手續費與稅）。保守一點：" +
        (safe >= 1 ? "最多 " + safe.toLocaleString("en-US") + " 股。" : "連 1 股都超過預算，這一檔不買。");
      p.appendChild(s);
    });
  }

  /* ---------- 樣式 ---------- */
  function addStyle() {
    if ($("pr-style")) return;
    var s = document.createElement("style");
    s.id = "pr-style";
    var A = "var(--amber,#ffb450)", R = "var(--red,#ff6b6b)", G = "var(--green,#3dd68c)", M = "var(--muted,#c5d0de)";
    s.textContent =
      ".pr-risk{margin-top:12px;padding-top:4px;border-top:1px solid rgba(255,255,255,.14)}" +
      ".pr-risk h3{margin:16px 0 8px;font-size:15px}" +
      ".pr-risk h3 small{font-weight:400;font-size:12px;color:" + M + ";margin-left:8px}" +
      ".pr-risk .pr-sum{margin:0 0 8px;font-size:13.5px;line-height:1.6}" +
      ".pr-risk .pr-sum.pr-warn{color:" + A + "}.pr-risk .pr-sum b{font-variant-numeric:tabular-nums}" +
      ".pr-risk ul{list-style:none;margin:0 0 8px;padding:0;font-size:13px;line-height:1.55}" +
      ".pr-risk li{margin:6px 0;padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.14);border-left:4px solid #5c6570;background:rgba(0,0,0,.18)}" +
      ".pr-risk li>b{display:block;font-size:14px}.pr-risk li span{display:block;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}" +
      ".pr-risk li.pr-broken{border-left-color:" + R + "}.pr-risk li.pr-na{border-left-color:" + A + ";color:" + M + "}" +
      ".pr-risk .pr-neg{color:" + R + "}.pr-risk .pr-pos{color:" + G + "}" +
      ".vd-shares .pr-adj{display:block;color:" + M + ";font-size:12.5px;margin-top:2px}";
    document.head.appendChild(s);
  }

  /* ---------- 啟動 ---------- */
  function start() {
    addStyle();
    var pos = $("pos-body"), cards = $("cards"), vb = $("verdict-body");
    if (pos) new MutationObserver(renderRisk).observe(pos, { childList: true });        // 持倉重畫（行情更新）時跟著重算
    if (cards) new MutationObserver(checkDates).observe(cards, { childList: true });    // 行情更新後 DATA 的日期會變
    if (vb) new MutationObserver(adjustShares).observe(vb, { childList: true });        // 入場指示重畫時補上保守股數
    renderRisk();
    setTimeout(checkDates, 1500);                 // 等 latest.json 併進 DATA 再檢查，免得先閃一下舊日期
    document.addEventListener("visibilitychange", function () { if (!document.hidden) checkDates(); });
    fetch("./data/strategy_stats.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (S) {
        var v = S && S.all && S.all.avgLossR;
        if (has(v) && v < 0) { lossR = Math.abs(v); adjustShares(); }
      });
    window.PositionRisk = { refresh: function () { renderRisk(); checkDates(); adjustShares(); } };
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
