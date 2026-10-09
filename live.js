/* =====================================================================
   live.js｜盤中即時報價（只當註記）

   安裝：
   1. 把這個檔案放在 repo 根目錄（和 index.html、verdict.js 同一層）。
   2. 在 index.html 最後、<script src="./verdict.js"></script> 的下一行加：
        <script src="./live.js"></script>
   不需要改 index.html 其他程式，不動 DATA、STOCK_META、POSITIONS。

   做什麼：
   在個股卡片、持倉卡片、指數表加一行「盤中 233.10 ▲ 2.62（+1.14%）」，開著頁面會自己更新。
   只是註記：不寫進日 K，不改位置標籤、風險分數、最終指示。那些仍然只看已完成的收盤。

   報價來源（同一檔取時間最新的那一筆）：
     A. 自架的 /api/quotes（repo 裡的 api/quotes.mjs 部署到 Vercel 之後，把網址填進「設定」）
     B. Finnhub（美股個股即時；在頁面「設定」貼上免費金鑰。金鑰只存在這台裝置的瀏覽器，不會進 GitHub）
     C. GitHub Actions 每 5 分鐘產生的快照（.github/workflows/intraday.yml → live 分支的 intraday.json）
        不用任何設定就有，但會延遲 5–20 分鐘。

   更新頻率：有 A 或 B 而且開盤中，每 15 秒；只有快照時每 60 秒；休市每 5 分鐘。分頁沒在看的時候暫停。

   這是條件核對的輔助，不是買賣建議，不自動下單。
   ===================================================================== */
(function () {
  "use strict";
  if (window.__liveQuotes) return;
  window.__liveQuotes = true;

  /* ---------- 設定：要調整只改這裡，或在這個檔案之前設 window.LIVE_CONFIG ---------- */
  var CFG = {
    apiBase: "",                 // 自架報價 API 的網址（例：https://xxx.vercel.app）。頁面「設定」填的優先
    snapshotUrl: "",             // 留空＝自動用這個 repo 的 live 分支
    branch: "live",
    fastSec: 15,                 // 有即時來源、開盤中
    slowSec: 60,                 // 只有快照、開盤中
    idleSec: 300,                // 休市
    snapshotEverySec: 60,        // 快照最快多久重讀一次
    timeoutMs: 8000
  };
  var user = window.LIVE_CONFIG || {};
  Object.keys(user).forEach(function (k) { CFG[k] = user[k]; });

  var STORE = "live-quotes-settings";
  var INDEX = ["^TWII", "^IXIC", "^SOX", "^TNX"];
  var TZ = { TW: "Asia/Taipei", US: "America/New_York" };
  var HOURS = { TW: [9 * 60, 13 * 60 + 30], US: [9 * 60 + 30, 16 * 60] };
  var MKT_NAME = { TW: "台股", US: "美股" };

  var Q = {};                    // code -> {price, prev, time(ms), provider}
  var info = { last: null, counts: {}, snapAt: null, errors: {}, busy: false };
  var settings = load();
  var timer = null, lastSnap = 0, snapCache = null;

  /* ---------- 小工具 ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var has = function (v) { return v !== null && v !== undefined && !isNaN(v) && isFinite(v); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  function load() {
    try { var o = JSON.parse(localStorage.getItem(STORE) || "{}"); return o && typeof o === "object" ? o : {}; }
    catch (e) { return {}; }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(settings)); return true; } catch (e) { return false; }
  }
  function data(code) { return (typeof DATA !== "undefined" && DATA[code]) || null; }
  function stockName(code) { return (typeof NAMES !== "undefined" && NAMES[code]) || code; }
  function market(code) {
    if (code === "^TWII") return "TW";
    if (code.charAt(0) === "^") return "US";
    return /\.TWO?$/.test(code) ? "TW" : "US";
  }
  function codes() {
    var out = [];
    if (typeof STOCK_META !== "undefined") {
      Object.keys(STOCK_META).forEach(function (k) { STOCK_META[k].forEach(function (c) { if (out.indexOf(c) < 0) out.push(c); }); });
    }
    return out.concat(INDEX);
  }
  function num(v, min, max) { return Number(v).toLocaleString("en-US", { minimumFractionDigits: min, maximumFractionDigits: max }); }
  function px(v, code) {                    // 和頁面同一套寫法
    if (!has(v)) return "—";
    if (code === "^TNX") return num(v, 3, 3);
    if (code.charAt(0) === "^" || market(code) === "US") return num(v, 2, 2);
    return num(v, 0, 2);
  }
  function clock(tz, ms) {                  // 那個時區的 {date:"2026-10-09", mins:從零點起的分鐘, wd:0-6}
    var p = {};
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
      .formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return { date: p.year + "-" + p.month + "-" + p.day, mins: (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10),
             wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
  }
  function state(mkt, ms) {                 // open 盤中｜pre 開盤前｜post 已收盤｜closed 週末
    var c = clock(TZ[mkt], ms || Date.now()), h = HOURS[mkt];
    if (c.wd === 0 || c.wd === 6) return "closed";
    return c.mins < h[0] ? "pre" : c.mins < h[1] ? "open" : "post";
  }
  var STATE_TEXT = { open: "盤中", pre: "未開盤", post: "已收盤", closed: "休市" };
  function taipei(ms, withDate) {
    try {
      var s = new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Taipei" });   // 2026-10-09 23:00:15
      return withDate ? s.slice(5, 10).replace("-", "/") + " " + s.slice(11, 16) : s.slice(11, 19);
    } catch (e) { return "—"; }
  }
  function getJson(url, opts) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, CFG.timeoutMs) : null;
    var o = opts || {};
    o.cache = "no-store";
    if (ctl) o.signal = ctl.signal;
    return fetch(url, o).then(function (r) {
      if (!r.ok) { var e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
      return r.json();
    }).finally(function () { if (t) clearTimeout(t); });
  }
  function toMs(v) {
    if (typeof v === "number") return v < 1e11 ? v * 1000 : v;
    var d = new Date(v).getTime();
    return isNaN(d) ? null : d;
  }

  /* ---------- 報價來源 ---------- */
  function apiBase() { return String(settings.apiBase || CFG.apiBase || "").replace(/\/+$/, ""); }
  function snapshotUrl() {
    if (CFG.snapshotUrl) return CFG.snapshotUrl;
    var m = /^([^.]+)\.github\.io$/.exec(location.hostname);
    var repo = location.pathname.split("/").filter(Boolean)[0];
    if (m && repo && !/\.html?$/.test(repo)) return "https://raw.githubusercontent.com/" + m[1] + "/" + repo + "/" + CFG.branch + "/intraday.json";
    return "./live-out/intraday.json";      // 本機測試
  }

  function fromApi(list) {                  // 自架的 /api/quotes
    var base = apiBase();
    if (!base) return Promise.resolve({});
    return getJson(base + "/api/quotes?symbols=" + encodeURIComponent(list.join(","))).then(function (j) {
      var out = {};
      Object.keys((j && j.quotes) || {}).forEach(function (c) {
        var q = j.quotes[c], t = toMs(q.time);
        if (has(q.price) && q.price > 0 && t) out[c] = { price: q.price, prev: has(q.previousClose) ? q.previousClose : null, time: t, provider: q.provider || "自架 API" };
      });
      delete info.errors.api;
      return out;
    }).catch(function (e) { info.errors.api = "自架 API 讀不到（" + e.message + "）"; return {}; });
  }

  function fromFinnhub(list) {              // 美股個股即時；指數與台股不支援
    var key = String(settings.finnhubKey || "").trim();
    var us = list.filter(function (c) { return market(c) === "US" && c.charAt(0) !== "^"; });
    if (!key || !us.length || info.finnhubOff > Date.now()) return Promise.resolve({});
    return Promise.all(us.map(function (c) {
      return getJson("https://finnhub.io/api/v1/quote?symbol=" + encodeURIComponent(c) + "&token=" + encodeURIComponent(key))
        .then(function (d) { return has(d.c) && d.c > 0 && d.t ? [c, { price: d.c, prev: has(d.pc) && d.pc > 0 ? d.pc : null, time: toMs(d.t), provider: "Finnhub" }] : null; })
        .catch(function (e) { return { error: e }; });
    })).then(function (rows) {
      var out = {}, bad = null;
      rows.forEach(function (r) { if (r && r.error) bad = r.error; else if (r) out[r[0]] = r[1]; });
      if (bad && (bad.status === 401 || bad.status === 403)) {
        info.errors.finnhub = "Finnhub 金鑰無效，請到「設定」重新貼上";
        info.finnhubOff = Date.now() + 10 * 60 * 1000;
      } else if (bad && bad.status === 429) {
        info.errors.finnhub = "Finnhub 次數用完，一分鐘後再試";
        info.finnhubOff = Date.now() + 60 * 1000;
      } else if (bad && !Object.keys(out).length) info.errors.finnhub = "Finnhub 讀不到（" + bad.message + "）";
      else delete info.errors.finnhub;
      return out;
    });
  }

  function fromSnapshot() {                 // GitHub Actions 的快照
    var now = Date.now();
    if (snapCache && now - lastSnap < CFG.snapshotEverySec * 1000) return Promise.resolve(snapCache);
    lastSnap = now;
    var url = snapshotUrl();
    return getJson(url + (url.indexOf("?") < 0 ? "?" : "&") + "t=" + Math.floor(now / 60000)).then(function (j) {
      var out = {};
      Object.keys((j && j.quotes) || {}).forEach(function (c) {
        var q = j.quotes[c], t = toMs(q.time);
        if (has(q.price) && q.price > 0 && t) out[c] = { price: q.price, prev: has(q.prevClose) ? q.prevClose : null, time: t, provider: "快照" };
      });
      info.snapAt = toMs(j && j.generatedAt);
      delete info.errors.snapshot;
      snapCache = out;
      return out;
    }).catch(function (e) {
      if (!snapCache) info.errors.snapshot = e.status === 404 ? "還沒有快照（intraday 排程跑過一次後才有）" : "快照讀不到（" + e.message + "）";
      return snapCache || {};
    });
  }

  function poll() {
    if (info.busy) return Promise.resolve();
    info.busy = true;
    var list = codes();
    return Promise.all([fromApi(list), fromFinnhub(list), fromSnapshot()]).then(function (sets) {
      var counts = {};
      list.forEach(function (c) {
        var best = null;
        sets.forEach(function (s) { var q = s[c]; if (q && (!best || q.time > best.time)) best = q; });   // 同時間以前面的來源為準
        if (best) { Q[c] = best; counts[best.provider] = (counts[best.provider] || 0) + 1; }
      });
      info.counts = counts;
      info.last = Date.now();
    }).catch(function () {}).then(function () {
      info.busy = false;
      paint();
    });
  }

  /* ---------- 一檔的註記 ---------- */
  function zone(s) {
    if (!s || s === "N/A") return null;
    var p = String(s).split("-").map(parseFloat).filter(function (x) { return !isNaN(x); });
    return p.length < 2 ? null : { lo: Math.min(p[0], p[1]), hi: Math.max(p[0], p[1]) };
  }
  function note(code) {
    var d = data(code), q = Q[code];
    if (!d || !q || !d.date) return null;
    var mkt = market(code);
    var qDate = clock(TZ[mkt], q.time).date;
    if (qDate <= d.date) return null;                       // 這筆報價就是已完成的那根日 K，不用再標
    var now = Date.now(), st = state(mkt, now), today = clock(TZ[mkt], now).date;
    var live = st === "open" && qDate === today;
    var label = live ? "盤中" : qDate === today ? "今日收盤（日 K 待同步）" : qDate.slice(5).replace("-", "/") + " 報價（日 K 待同步）";
    var base = has(q.prev) ? q.prev : d.p;
    var ch = q.price - base, pc = base ? ch / base * 100 : null;
    var dec = code === "^TNX" ? 3 : (code.charAt(0) === "^" || mkt === "US") ? 2 : null;
    var amt = dec === null ? num(Math.abs(ch), 0, 2) : num(Math.abs(ch), dec, dec);
    var move = !has(pc) ? "" : (pc > 0.004 ? "▲ " : pc < -0.004 ? "▼ " : "— ") + amt + "（" + (pc > 0 ? "+" : pc < 0 ? "−" : "") + Math.abs(pc).toFixed(2) + "%）";
    var hint = "";
    var inv = parseFloat(d.invalid), z = zone(d.entry);
    if (has(inv) && q.price <= inv) hint = "已跌破失效價 " + px(inv, code);
    else if (z && q.price >= z.lo && q.price <= z.hi) hint = "在進場區內";
    else if (z && q.price < z.lo) hint = "低於進場區";
    else if (z) hint = "高於進場區 " + ((q.price / z.hi - 1) * 100).toFixed(1) + "%";
    return { label: label, price: px(q.price, code), move: move, hint: hint, live: live,
             when: taipei(q.time, true), provider: q.provider, stale: live && now - q.time > 20 * 60 * 1000 };
  }
  function noteHTML(n) {
    return '<b>' + esc(n.label) + " " + esc(n.price) + "</b>" + (n.move ? " " + esc(n.move) : "") +
      '<span>' + esc(n.when) + " 台北｜" + esc(n.provider) + (n.stale ? "｜報價超過 20 分鐘沒更新" : "") +
      (n.hint ? "｜" + esc(n.hint) + "（收盤才算數）" : "｜不當作收盤") + "</span>";
  }

  /* ---------- 畫到頁面上 ---------- */
  function setNote(host, anchor, n) {
    var el = host.querySelector(":scope > .live-q");
    if (!n) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.className = "live-q";
      if (anchor && anchor.parentNode === host) anchor.insertAdjacentElement("afterend", el);
      else host.appendChild(el);
    }
    var html = noteHTML(n);
    if (el.__html !== html) { el.innerHTML = html; el.__html = html; }
    el.classList.toggle("on", !!n.live);
  }
  function paintCards() {
    var box = $("cards");
    if (box) Array.prototype.forEach.call(box.querySelectorAll("article.card[data-code]"), function (card) {
      setNote(card, card.querySelector(".live-note") || card.querySelector(".px"), note(card.getAttribute("data-code")));
    });
    var pos = $("pos-body");
    if (pos) Array.prototype.forEach.call(pos.querySelectorAll("article.card"), function (card) {
      var sub = card.querySelector(".sub");
      var code = sub ? String(sub.textContent).split("｜")[0].trim() : "";
      if (code) setNote(card, card.querySelector(".live-note") || card.querySelector(".px"), note(code));
    });
  }
  function paintIndex() {
    var body = $("index-body");
    if (!body) return;
    Array.prototype.forEach.call(body.querySelectorAll("tr"), function (tr) {
      var tag = tr.querySelector("td .note"), cell = tr.cells[4];
      var code = tag ? tag.textContent.trim() : "";
      if (!code || !cell) return;
      if (cell.__base === undefined) cell.__base = cell.innerHTML;
      var n = note(code);
      var html = n ? '<div class="live-q' + (n.live ? " on" : "") + '">' + noteHTML(n) + "</div>" : cell.__base;
      if (cell.__html !== html) { cell.innerHTML = html; cell.__html = html; }
    });
  }
  function paintBar() {
    var bar = $("live-bar");
    if (!bar) return;
    var bits = ["TW", "US"].map(function (m) { return MKT_NAME[m] + " " + STATE_TEXT[state(m)]; });
    var src = Object.keys(info.counts).map(function (k) {
      return k + " " + info.counts[k] + " 檔" + (k === "快照" && info.snapAt ? "（" + taipei(info.snapAt, true).slice(6) + " 產生）" : "");
    });
    var errs = Object.keys(info.errors).map(function (k) { return info.errors[k]; });
    var rt = realtime();
    var shown = document.querySelectorAll(".live-q").length;
    $("live-status").innerHTML =
      '<i class="' + (anyOpen() ? "dot on" : "dot") + '"></i><b>盤中報價</b>' +
      "<span>" + esc(bits.join("・")) + "</span>" +
      (info.last ? "<span>更新 " + esc(taipei(info.last)) + "</span>" : "<span>讀取中…</span>") +
      (src.length ? "<span>來源：" + esc(src.join("、")) + "</span>" : "") +
      (info.last && !shown ? "<span>目前沒有比日 K 更新的報價</span>" : "") +
      (errs.length ? '<span class="warn">' + esc(errs.join("；")) + "</span>" : "") +
      (!rt ? '<span class="dim">只有延遲快照；美股要即時請按「設定」貼 Finnhub 金鑰</span>' : "");
  }
  function paint() { paintCards(); paintIndex(); paintBar(); }

  /* ---------- 更新節奏 ---------- */
  function anyOpen() { return state("TW") === "open" || state("US") === "open"; }
  function realtime() { return !!apiBase() || (!!String(settings.finnhubKey || "").trim()); }
  function every() {
    if (!anyOpen()) return CFG.idleSec;
    var fast = !!apiBase() || (!!String(settings.finnhubKey || "").trim() && state("US") === "open");
    return fast ? CFG.fastSec : CFG.slowSec;
  }
  function loop() {
    clearTimeout(timer);
    var go = function () { timer = setTimeout(loop, every() * 1000); };
    if (document.hidden || document.documentElement.classList.contains("wall-on")) { go(); return; }   // 沒在看（或只看背景）就不抓
    poll().then(go);
  }

  /* ---------- 狀態列與設定 ---------- */
  function buildBar() {
    if ($("live-bar")) return;
    var bar = document.createElement("div");
    bar.id = "live-bar";
    bar.innerHTML =
      '<div class="live-row"><div id="live-status"></div>' +
      '<span class="live-btns"><button type="button" id="live-refresh">立即更新</button><button type="button" id="live-toggle" aria-expanded="false">設定</button></span></div>' +
      '<form id="live-form" hidden>' +
      '<label>Finnhub 金鑰（美股個股即時，免費申請：finnhub.io）<input id="live-key" type="password" autocomplete="off" spellcheck="false" placeholder="貼上 API key"></label>' +
      '<label>自架報價 API 網址（選填，api/quotes.mjs 部署後的網址）<input id="live-api" type="url" autocomplete="off" spellcheck="false" placeholder="https://你的專案.vercel.app"></label>' +
      '<div class="live-btns"><button type="submit">儲存</button><button type="button" id="live-clear">清除</button></div>' +
      '<p>金鑰與網址只存在這台裝置的瀏覽器，不會上傳到 GitHub；換裝置要再貼一次。沒有填也會顯示每 5 分鐘的延遲快照。盤中價只是註記，位置標籤與最終指示仍然只看收盤。</p>' +
      "</form>";
    var nav = document.querySelector("nav");
    if (nav && nav.parentNode) nav.parentNode.insertBefore(bar, nav.nextSibling);
    else document.body.insertBefore(bar, document.body.firstChild);

    var form = $("live-form"), toggle = $("live-toggle");
    toggle.addEventListener("click", function () {
      form.hidden = !form.hidden;
      toggle.setAttribute("aria-expanded", String(!form.hidden));
      if (!form.hidden) { $("live-key").value = settings.finnhubKey || ""; $("live-api").value = settings.apiBase || ""; }
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var api = $("live-api").value.trim();
      if (api && !/^https:\/\//.test(api)) { info.errors.form = "API 網址要用 https:// 開頭"; paintBar(); return; }
      delete info.errors.form;
      settings = { finnhubKey: $("live-key").value.trim(), apiBase: api };
      if (!save()) info.errors.form = "這個瀏覽器不能儲存設定（可能是無痕模式），關掉分頁後要重填";
      info.finnhubOff = 0;
      delete info.errors.finnhub;
      form.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      loop();
    });
    $("live-clear").addEventListener("click", function () {
      settings = {};
      try { localStorage.removeItem(STORE); } catch (e) { /* 沒關係 */ }
      $("live-key").value = ""; $("live-api").value = "";
      delete info.errors.finnhub; delete info.errors.api; delete info.errors.form;
      loop();
    });
    $("live-refresh").addEventListener("click", function () { lastSnap = 0; loop(); });
  }
  function addStyle() {
    if ($("live-style")) return;
    var s = document.createElement("style");
    s.id = "live-style";
    s.textContent =
      "#live-bar{position:relative;z-index:1;width:calc(100% - 24px);max-width:1056px;margin:10px auto 0;padding:8px 12px;box-sizing:border-box;border-radius:10px;border:1px solid var(--line,rgba(255,255,255,.14));background:rgba(8,28,58,.8);font-size:12px;line-height:1.6;color:var(--text,#f7f4ee)}" +
      "#live-bar .live-row{display:flex;gap:8px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}" +
      "#live-status{flex:1 1 260px;min-width:0}" +
      "#live-status b{margin-right:8px}#live-status span{display:inline-block;margin-right:10px;color:var(--muted,#c5d0de)}" +
      "#live-status span.warn{color:var(--amber,#ffb450)}#live-status span.dim{display:block;margin-right:0}" +
      "#live-bar .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#5c6570;vertical-align:1px}" +
      "#live-bar .dot.on{background:var(--green,#3dd68c)}" +
      "#live-bar .live-btns{display:flex;gap:6px;flex-wrap:wrap}" +
      "#live-bar button{font:inherit;color:var(--blue,#8ec0ff);background:transparent;border:1px solid var(--line,rgba(255,255,255,.14));border-radius:8px;padding:5px 10px;cursor:pointer;min-height:32px}" +
      "#live-bar button:hover{border-color:var(--blue,#8ec0ff)}#live-bar button:focus-visible,#live-bar input:focus-visible{outline:2px solid var(--blue,#8ec0ff);outline-offset:2px}" +
      "#live-form{margin-top:8px;padding-top:8px;border-top:1px solid var(--line,rgba(255,255,255,.14))}" +
      "#live-form label{display:block;margin-bottom:8px;color:var(--muted,#c5d0de)}" +
      "#live-form input{display:block;width:100%;max-width:460px;margin-top:4px;font:inherit;font-size:16px;color:var(--text,#f7f4ee);background:rgba(0,0,0,.25);border:1px solid var(--line,rgba(255,255,255,.14));border-radius:8px;padding:7px 9px;box-sizing:border-box}" +
      "#live-form p{margin:8px 0 0;color:var(--muted,#c5d0de)}" +
      ".live-q{margin-top:3px;font-size:12px;line-height:1.5;color:#e6d3a3;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}" +
      ".live-q b{font-size:13px}.live-q.on b::before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green,#3dd68c);margin-right:5px;vertical-align:2px}" +
      ".live-q span{display:block;font-size:11px;color:var(--muted,#c5d0de)}";
    document.head.appendChild(s);
  }

  /* ---------- 啟動 ---------- */
  function start() {
    addStyle();
    buildBar();
    ["cards", "pos-body", "index-body"].forEach(function (id) {
      var el = $(id);
      if (el) new MutationObserver(paint).observe(el, { childList: true });   // 頁面重畫時補回註記；只看清單本身，不會被自己加的內容觸發
    });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) loop(); });
    window.LiveQuotes = { refresh: loop, quotes: Q, info: info };
    paintBar();
    loop();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
