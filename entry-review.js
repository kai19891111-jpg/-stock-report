/* 入場時機重評：讀 data/entry_review.json（scripts/entry_review.py 每次收盤更新後產生）
   - #review 區塊：資料時間、手寫判讀（只在同一根日 K 有效）、優先觀察名單、逐檔表格
   - 個股卡片：每張卡片多一行重評狀態，和「今日入場指示」不一致時標出來
   只讀不寫；不是買賣建議。 */
(function () {
  "use strict";
  var R = null, L = null, V = null, filter = "all";
  var ICON = { ready: "🟢", pullback: "⏳", breakout: "📈", hot: "🔥", weak: "⬇", nodata: "⚪" };
  var MKT = { TW: "台股", US: "美股", CRYPTO: "加密貨幣" };
  var TZ = { TW: "台北 UTC+8", US: "紐約 ET", CRYPTO: "UTC" };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function num(x) {
    if (x == null || isNaN(x)) return "—";
    var a = Math.abs(x), d = a >= 1000 ? 0 : a >= 100 ? 1 : 2;
    return Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function name(c) { try { return (typeof NAMES !== "undefined" && NAMES[c]) || c; } catch (e) { return c; } }
  function getJson(u) { return fetch(u + "?t=" + Date.now(), { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  function twTime(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) + "（台北）"; } catch (e) { return iso; }
  }

  function css() {
    if ($("rv-css")) return;
    var s = document.createElement("style");
    s.id = "rv-css";
    s.textContent =
      "#review table{width:100%;border-collapse:collapse;font-size:12.5px;margin:6px 0 14px}" +
      "#review th,#review td{border-bottom:1px solid rgba(255,255,255,.12);padding:6px 5px;text-align:left;vertical-align:top}" +
      "#review th{position:sticky;top:0;background:rgba(20,20,30,.95);font-weight:600}" +
      "#review .rv-wrap{overflow-x:auto}" +
      "#review .rv-st{white-space:nowrap;font-weight:600}" +
      ".rv-ready{color:#5fe0a0}.rv-weak{color:#ff8a8a}.rv-hot{color:#ffb36b}.rv-pullback,.rv-breakout{color:#e6d3a3}.rv-nodata{opacity:.7}" +
      "#review .rv-pri{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin:8px 0 14px}" +
      "#review .rv-pri article{border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:10px;font-size:13px}" +
      "#review .rv-pri b{display:block;margin-bottom:4px}" +
      "#review .rv-why{font-size:12px;opacity:.85}" +
      ".rv-card{font-size:12px;margin:6px 0;padding:6px 8px;border-left:3px solid #e6d3a3;background:rgba(255,255,255,.04)}" +
      ".rv-card.rv-mis{border-left-color:#ff8a8a}" +
      "#review .chips{margin:6px 0}";
    document.head.appendChild(s);
  }

  function sessionsMatch(valid) {
    var s = (R && R.sessions) || {};
    if (!valid) return false;
    return Object.keys(valid).every(function (k) { return !s[k] || s[k] === valid[k]; });
  }

  function plan(x) {
    var pb = x.pullback, bk = x.breakout;
    var zone = pb ? num(pb.zone[0]) + "–" + num(pb.zone[1]) : "—";
    var zoneWhy = pb ? pb.zoneWhy + "；確認：" + pb.confirm : "";
    var trig = bk ? "收盤站上 " + num(bk.trigger) + "＋" + bk.volume + (bk.retest ? "；需等回測不破（" + bk.retestWhy + "）" : "") : "—";
    var trigWhy = bk ? bk.triggerWhy : "";
    // 失效價／目標／RR：狀態是等突破就用突破計畫，其他用回檔計畫
    var use = (x.status === "breakout" && bk) ? bk : (pb || bk);
    var kind = use === bk ? "突破" : "回檔";
    var p = {
      zone: zone, zoneWhy: zoneWhy, trig: trig, trigWhy: trigWhy, kind: kind,
      stop: use ? num(use.stop) : "—", stopWhy: use ? use.stopWhy : "",
      tgt: use ? num(use.t1) + "／" + num(use.t2) : "—", tgtWhy: use ? "T1：" + use.t1Why + "；T2：" + use.t2Why : "",
      rr: x.status === "weak" ? "不計（結構轉弱，不設進場）" :
        use && use.rr1 != null ? use.rr1 + "／" + use.rr2 + "（" + kind + "，以 " + num(use.entry) + " 計）" : "算不出來"
    };
    if (x.status === "weak" && pb) p.zone = "止跌觀察 " + zone;
    return p;
  }

  function risk(x) {
    var a = [];
    (x.why || []).forEach(function (w) { a.push(w); });
    if (x.historyNote && R.historyMode !== "local-reconstruction") a.push(x.historyNote);
    if (x.mismatch) a.push("⚠ " + x.mismatch);
    return a;
  }

  function row(code, x) {
    var p = plan(x);
    var mk = x.market;
    return "<tr data-st='" + x.status + "'>" +
      "<td><b>" + esc(name(code)) + "</b><br><small>" + esc(code) + "｜" + esc(x.theme || "") + "</small></td>" +
      "<td>" + esc(x.date || "—") + "<br><small>收盤 " + num(x.close) + "｜" + esc(TZ[mk] || "") + "</small></td>" +
      "<td class='rv-st rv-" + x.status + "'>" + ICON[x.status] + " " + esc(x.label) + "</td>" +
      "<td title='" + esc(p.zoneWhy) + "'>" + p.zone + "<div class='rv-why'>" + esc(x.pullback ? x.pullback.zoneWhy : "") + "</div></td>" +
      "<td title='" + esc(p.trigWhy) + "'>" + esc(p.trig) + "<div class='rv-why'>" + esc(p.trigWhy) + "</div></td>" +
      "<td>" + p.stop + "<div class='rv-why'>" + esc(p.stopWhy) + "</div></td>" +
      "<td>" + p.tgt + "<div class='rv-why'>" + esc(p.tgtWhy) + "</div></td>" +
      "<td>" + esc(p.rr) + "</td>" +
      "<td class='rv-why'>" + risk(x).map(esc).join("<br>") + "</td></tr>";
  }

  function render() {
    var body = $("review-body");
    if (!body) return;
    if (!R) { body.innerHTML = "<p class='note'>讀不到 data/entry_review.json（下一次收盤自動更新後產生）。</p>"; return; }
    css();
    var S = R.symbols || {}, ses = R.sessions || {};
    var stamp = "行情：台股 " + (ses.TW || "—") + "、美股 " + (ses.US || "—") + "、加密 " + (ses.CRYPTO || "—") +
      "｜資料時間 " + twTime(R.dataTimestamp) + "｜來源 " + (R.source || "—") + (R.isFinalClose ? "（收盤完成日 K，非即時）" : "（非最終收盤）") +
      "｜重算 " + twTime(R.generatedAt);
    $("review-stamp").textContent = stamp;
    var h = "";
    if (L && L.dataTimestamp && R.dataTimestamp && L.dataTimestamp !== R.dataTimestamp) {
      h += "<div class='banner'>重評用的行情（" + esc(twTime(R.dataTimestamp)) + "）和目前卡片的行情（" + esc(twTime(L.dataTimestamp)) + "）不是同一批，價位以下一次自動更新為準。</div>";
    }
    if (R.historyMode === "local-reconstruction") {
      h += "<p class='note'>這一版是用 repo 內保存的近 7 週日 K 重建計算（MA60、週線趨勢取自 2 年日 K 的 latest.json）；下一次收盤自動更新會改用 2 年日 K 重算，支撐壓力可能更遠。</p>";
    }
    var N = R.notes || {};
    var fresh = sessionsMatch(N.validFor);
    if (N.market && N.market.length) {
      h += "<h3>盤勢與事件" + (fresh ? "" : "（⚠ 手寫判讀已過期，寫於 " + esc(N.writtenAt || "") + "，只看下方自動欄位）") + "</h3>";
      if (fresh) h += "<ul>" + N.market.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ul>";
    }
    if (fresh && N.priority && N.priority.length) {
      h += "<h3>優先觀察（不是可進場名單）</h3><div class='rv-pri'>" + N.priority.map(function (p) {
        var x = S[p.symbol] || {};
        return "<article><b>" + p.rank + ". " + esc(name(p.symbol)) + "（" + esc(p.symbol) + "）｜" + esc(p.horizon) + "｜" + (ICON[x.status] || "") + " " + esc(x.label || "") + "</b>" +
          "<div>" + esc(p.why) + "</div><div class='rv-why'><b>還缺：</b>" + esc(p.missing) + "</div><div class='rv-why'><b>風險：</b>" + esc(p.risk) + "</div></article>";
      }).join("") + "</div>";
      if (N.notPicked) h += "<p class='note'>" + esc(N.notPicked) + "</p>";
    }
    if (fresh && N.positions && N.positions.length) {
      h += "<h3>持倉對照</h3><ul>" + N.positions.map(function (p) { return "<li><b>" + esc(name(p.symbol)) + "</b>：" + esc(p.text) + "</li>"; }).join("") + "</ul>";
    }
    var c = R.counts || {};
    h += "<div class='chips' id='rv-chips'>" + ["all"].concat(R.order || []).map(function (k) {
      var lab = k === "all" ? "全部" : (ICON[k] + " " + (R.labels[k] || k) + " " + (c[k] || 0));
      return "<button type='button' class='chip" + (filter === k ? " on" : "") + "' data-f='" + k + "'>" + esc(lab) + "</button>";
    }).join("") + "</div>";
    ["TW", "US", "CRYPTO"].forEach(function (m) {
      var codes = Object.keys(S).filter(function (k) { return S[k].market === m && (filter === "all" || S[k].status === filter); });
      if (!codes.length) return;
      h += "<h3>" + MKT[m] + "（日 K " + esc(ses[m] || "") + "，" + TZ[m] + "）</h3><div class='rv-wrap'><table><thead><tr>" +
        "<th>股票</th><th>行情時間</th><th>目前狀態</th><th>回檔觀察區間</th><th>突破觸發條件</th><th>結構失效價</th><th>目標 T1／T2</th><th>報酬風險比</th><th>判斷依據／主要風險</th>" +
        "</tr></thead><tbody>" + codes.map(function (k) { return row(k, S[k]); }).join("") + "</tbody></table></div>";
    });
    if (fresh && N.additions && N.additions.length) {
      h += "<h3>本次新增追蹤</h3><ul>" + N.additions.map(function (a) {
        return "<li><b>" + esc(a.name) + "（" + esc(a.symbol) + "）｜" + esc(a.group) + "</b>：" + esc(a.basis) + " " + esc(a.note) +
          " " + (a.sources || []).map(function (u, i) { return "<a href='" + esc(u) + "' target='_blank' rel='noopener'>來源" + (i + 1) + "</a>"; }).join(" ") + "</li>";
      }).join("") + "</ul>";
      if (N.glassesRelated) h += "<p class='note'>" + esc(N.glassesRelated) + "</p>";
      if (N.notAdded) h += "<p class='note'>" + esc(N.notAdded) + "</p>";
    }
    var mis = mismatches();
    if (mis.length) h += "<h3>和「今日入場指示」不一致</h3><ul>" + mis.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ul>";
    h += "<p class='note'>規則：價格進了區間但確認條件沒過，不會標「條件已成立」；大盤空頭、財報 3 個交易日內也不會。RR＝(目標 − 進場價)÷(進場價 − 失效價)，進場價寫在括號內。條件核對，不是買賣建議，不自動下單。</p>";
    body.innerHTML = h;
    var ch = $("rv-chips");
    if (ch) ch.addEventListener("click", function (e) { var b = e.target.closest(".chip"); if (b) { filter = b.getAttribute("data-f"); render(); } });
  }

  function mismatches() {
    var out = [];
    if (!V || !V.symbols || !R) return out;
    Object.keys(R.symbols).forEach(function (k) {
      var x = R.symbols[k], v = V.symbols[k];
      if (!v) return;
      if (v.code === "go" && x.status !== "ready") out.push(name(k) + "：入場指示為「可進場」，重評為「" + x.label + "」，以較保守者為準。");
      if (x.status === "ready" && v.code !== "go") out.push(name(k) + "：重評條件已成立，但入場指示為「" + (V.labels[v.code] || v.code) + "」（回測／風險未過），不視為可進場。");
    });
    return out;
  }

  function cards() {
    if (!R) return;
    Array.prototype.forEach.call(document.querySelectorAll("#cards article.card[data-code], #crypto-cards article.card[data-code]"), function (card) {
      var old = card.querySelector(".rv-card");
      if (old) old.remove();
      var x = R.symbols[card.getAttribute("data-code")];
      if (!x) return;
      var p = plan(x);
      var v = V && V.symbols && V.symbols[card.getAttribute("data-code")];
      var mis = v && ((v.code === "go") !== (x.status === "ready"));
      var html = "<div class='rv-card" + (mis ? " rv-mis" : "") + "'><b>重評：" + ICON[x.status] + " " + esc(x.label) + "</b>" +
        "｜回檔區 " + p.zone + "｜突破 " + (x.breakout ? num(x.breakout.trigger) : "—") + "｜失效 " + p.stop + "｜T1／T2 " + p.tgt +
        (mis ? "｜⚠ 和入場指示不一致，以較保守者為準" : "") + " <a href='#review'>明細</a></div>";
      var anchor = card.querySelector(".vd-card") || card.querySelector(".status");
      if (anchor) anchor.insertAdjacentHTML("beforebegin", html);
    });
  }

  function start() {
    Promise.all([
      getJson("./data/entry_review.json").catch(function () { return null; }),
      getJson("./data/latest.json").catch(function () { return null; }),
      getJson("./data/verdict.json").catch(function () { return null; })
    ]).then(function (a) {
      R = a[0]; L = a[1]; V = a[2];
      render(); cards();
      var b = $("cards"), cb = $("crypto-cards");
      if (b) new MutationObserver(function () { setTimeout(cards, 0); }).observe(b, { childList: true });
      if (cb) new MutationObserver(function () { setTimeout(cards, 0); }).observe(cb, { childList: true });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
