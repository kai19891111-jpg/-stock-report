/* =====================================================================
   verdict.js｜最終指示（每檔一行＋頁首「今日入場指示」＋持倉指示）

   安裝：
   1. 把這個檔案放在 repo 根目錄（和 index.html 同一層）。
   2. index.html 最後、risk-score.js 的下一行加：
        <script src="./verdict.js"></script>
      （scripts/apply_v2.py 會自動加，也會放好 <section id="verdict">。）

   做什麼：
   讀 scripts/verdict.py 產生的 data/verdict.json。這個檔案不做任何判斷，只負責顯示：
     ・頁首「今日入場指示」：有訊號的、等回檔的（附買進上限價）、不買的（附原因）
     ・每張個股卡片最上面一行最終指示；進場條件核對與風險分數收進「明細」按鈕
     ・「我的持倉」每個部位一行持倉指示，全部用當天重算的價位
     ・填「每筆最多賠多少」就算出股數（只存在這台裝置）

   這是條件核對，不是買賣建議，不自動下單。
   ===================================================================== */
(function () {
  "use strict";

  var STALE_HOURS = 96;        // verdict.json 超過幾小時沒更新就提醒
  var BIG_POSITION = 50;       // 單一部位佔總市值超過幾 % 就提醒
  var KEY = "vdRiskPerTrade";

  var V = null, loaded = false, openCards = {};
  var $ = function (id) { return document.getElementById(id); };
  var has = function (v) { return v !== null && v !== undefined && !isNaN(v); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  function g(name) {                       // 讀頁面的全域常數（NAMES、POSITIONS、FX、DATA），沒有就回 null
    try {
      if (name === "NAMES") return typeof NAMES !== "undefined" ? NAMES : null;
      if (name === "POSITIONS") return typeof POSITIONS !== "undefined" ? POSITIONS : null;
      if (name === "FX") return typeof FX !== "undefined" ? FX : null;
      if (name === "DATA") return typeof DATA !== "undefined" ? DATA : null;
    } catch (e) {}
    return null;
  }
  function nm(code) { var n = g("NAMES"); return (n && n[code]) || code; }
  function px(v, market) {
    if (!has(v)) return "—";
    return Number(v).toLocaleString("en-US", market === "US"
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  function pct(v, nd) {
    if (!has(v)) return "—";
    return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(nd === undefined ? 1 : nd) + "%";
  }
  function md(iso) { return iso ? String(iso).slice(5, 7) + "/" + String(iso).slice(8, 10) : "—"; }
  function stamp(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "—";
    try {
      return d.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    } catch (e) { return String(iso).slice(5, 16).replace("T", " "); }
  }
  function label(code) { return (V.labels && V.labels[code]) || code; }
  function icon(code) { return (V.icons && V.icons[code]) || ""; }
  function sym(code) { return V.symbols[code]; }
  function fxOf(market) { var f = g("FX"); return market === "US" ? (f && has(f.USDTWD) ? f.USDTWD : null) : 1; }
  function riskBudget() {
    try { var v = parseFloat(localStorage.getItem(KEY)); return v > 0 ? v : null; } catch (e) { return null; }
  }
  var RISK_TXT = { low: "低", mid: "中", high: "高", insufficient: "資料不足" };
  function riskTxt(v) {
    if (!v.risk || !v.risk.level) return "沒有資料";
    return RISK_TXT[v.risk.level] + (has(v.risk.total) && v.risk.max ? " " + v.risk.total + "／" + v.risk.max : "");
  }

  /* ---------- 股數試算 ---------- */
  function sharesLine(v) {
    var budget = riskBudget();
    if (!budget || !v.plan || !has(v.plan.riskPerShare) || v.plan.riskPerShare <= 0) return "";
    var fx = fxOf(v.market);
    if (!fx) return '<p class="vd-shares">股數算不出來：頁面沒有美元匯率。</p>';
    var n = Math.floor(budget / (v.plan.riskPerShare * fx));
    if (n < 1) return '<p class="vd-shares">每筆最多賠 NT$' + budget.toLocaleString("en-US") + "：買 1 股的停損金額就超過了，這一檔不買。</p>";
    return '<p class="vd-shares">每筆最多賠 NT$' + budget.toLocaleString("en-US") + " → 最多 <b>" + n.toLocaleString("en-US") +
      " 股</b>（約 NT$" + Math.round(n * v.close * fx).toLocaleString("en-US") + "）。這是用收盤價估的，實際要用隔天開盤價重算。</p>";
  }

  /* ---------- 頁首：今日入場指示 ---------- */
  function signalRow(code) {
    var v = sym(code), m = v.market;
    return '<div class="vd-row vd-c-' + v.code + '">' +
      '<div class="vd-h"><b>' + icon(v.code) + " " + esc(nm(code)) + " <small>" + esc(code) + "</small></b><span>" + esc(label(v.code)) + "</span></div>" +
      '<div class="vd-kv"><span>收盤 <b>' + px(v.close, m) + "</b></span><span>停損 <b>" + px(v.stop, m) + "</b></span><span>目標 <b>" + px(v.target, m) +
      "</b></span><span>報酬風險比 <b>" + (has(v.rr) ? v.rr.toFixed(2) : "—") + "</b></span><span>風險 <b>" + esc(riskTxt(v)) + "</b></span></div>" +
      "<p>" + esc(v.text) + "</p>" +
      (v.notes && v.notes.length ? "<ul>" + v.notes.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") + "</ul>" : "") +
      sharesLine(v) + "</div>";
  }
  function waitRow(code) {
    var v = sym(code), m = v.market;
    var others = (v.blockers || []).filter(function (b) { return ["zone", "rr", "distance"].indexOf(b.key) < 0; }).map(function (b) { return b.text; });
    var earn = (v.notes || []).filter(function (n) { return n.indexOf("財報") === 0; });
    return '<div class="vd-w"><div class="vd-w-n"><b>' + esc(nm(code)) + "</b><small>" + esc(code) + "</small></div>" +
      '<div class="vd-w-g">還差 <b>' + pct(v.gapPct) + "</b></div>" +
      '<div class="vd-w-m">收盤 ' + px(v.close, m) + " → 回到 <b>" + (has(v.buyBelow) ? px(v.buyBelow, m) : "—") + "</b> 以下｜停損 " + px(v.stop, m) + "</div>" +
      (others.length ? '<div class="vd-w-x">另外還卡：' + esc(others.join("、")) + "</div>" : "") +
      (earn.length ? '<div class="vd-w-x">注意：' + esc(earn.join("、")) + "</div>" : "") + "</div>";
  }
  function noBuyGroup(code) {
    var list = (V.groups[code] || []);
    if (!list.length) return "";
    var body = list.map(function (c) {
      var v = sym(c), why = "";
      if (code === "no_chase") why = "乖離 " + pct(v.bias);
      else if (code === "avoid") why = v.text.replace(/，不碰。$/, "");
      else if (code === "trend") why = v.text.replace(/，不進場。$/, "");
      else if (code === "below") why = "收 " + px(v.close, v.market) + "，進場區下緣 " + px(v.entryLow, v.market);
      else if (code === "conditions") why = v.text.replace(/^價格已在進場區，還卡：/, "還卡 ").replace(/。$/, "");
      return "<span><b>" + esc(nm(c)) + "</b>" + (why ? " " + esc(why) : "") + "</span>";
    }).join("");
    return '<div class="vd-nb"><em>' + icon(code) + " " + esc(label(code)) + "（" + list.length + "）</em>" + body + "</div>";
  }
  function concentration() {               // 單一部位佔比（用頁面的 POSITIONS 現算）
    var P = g("POSITIONS"), D = g("DATA"), F = g("FX");
    if (!P || !D) return null;
    var rows = [], total = 0;
    P.forEach(function (p) {
      var price = p.quote || (D[p.code] && D[p.code].p);
      var fx = p.ccy === "TWD" ? 1 : (F && F.USDTWD);
      if (!has(price) || !has(fx)) return;
      var val = p.qty * price * fx;
      rows.push({ code: p.code, val: val });
      total += val;
    });
    if (!rows.length || !total) return null;
    rows.sort(function (a, b) { return b.val - a.val; });
    return { top: rows[0].code, w: rows[0].val / total * 100, n: rows.length };
  }

  function panel() {
    var body = $("verdict-body");
    if (!body) {
      var main = document.querySelector("main"), first = $("summary");
      if (!main) return;
      var sec = document.createElement("section");
      sec.id = "verdict"; sec.className = "panel";
      sec.innerHTML = '<h2>今日入場指示 <small id="verdict-stamp"></small></h2><div id="verdict-body"></div>';
      main.insertBefore(sec, first && first.parentNode === main ? first : main.firstChild);
      body = $("verdict-body");
    }
    var nav = document.querySelector("nav");
    if (nav && !nav.querySelector('a[href="#verdict"]')) nav.insertAdjacentHTML("afterbegin", '<a href="#verdict">入場指示</a>');
    if (!V || !V.symbols) {
      body.innerHTML = '<p class="note">讀不到 data/verdict.json，沒有最終指示。請確認 scripts/verdict.py 有在每日更新裡執行。</p>';
      return;
    }
    var c = V.counts, G = V.groups, ses = V.sessions || {};
    var sig = (G.go || []).concat(G.signal_unproven || [], G.signal_blocked || []);
    var rest = ["conditions", "no_chase", "below", "trend", "avoid", "nodata"];
    var restN = rest.reduce(function (s, k) { return s + (c[k] || 0); }, 0);
    var age = V.generatedAt ? (Date.now() - new Date(V.generatedAt).getTime()) / 36e5 : null;
    var st = $("verdict-stamp");
    if (st) st.textContent = "台股 " + md(ses.TW) + "｜美股 " + md(ses.US) + " 收盤｜計算 " + stamp(V.generatedAt) + " 台北";

    var h = '<p class="vd-top"><b class="' + (c.go ? "vd-ok" : "") + '">可進場 ' + (c.go || 0) + " 檔</b>" +
      "<span>有訊號但沒全過 " + ((c.signal_unproven || 0) + (c.signal_blocked || 0)) + " 檔</span>" +
      "<span>等回檔 " + (c.pullback || 0) + " 檔</span><span>其餘 " + restN + " 檔不買</span></p>";
    if (has(age) && age > STALE_HOURS) h += '<p class="vd-warn">這份指示是 ' + Math.floor(age) + " 小時前算的，可能已經過期。</p>";

    h += '<details class="vd-rules"><summary>統一規則（每一檔都用同一套）</summary><ol>' +
      "<li>只認「規則進場訊號」。卡片上的位置標籤（均線附近／偏高／過熱／均線之下）只是位置，不是訊號。</li>" +
      "<li>訊號出現後，下一個交易日開盤買。開盤價不在停損價和目標價之間就放棄。</li>" +
      "<li>買進當下就設停損。碰到停損價或目標價就出場，最多抱 " + esc(V.maxHoldDays || 20) + " 個交易日。</li>" +
      "<li>股數＝這一筆最多願意賠的金額 ÷（買進價 − 停損價）。</li>" +
      "<li>財報前 3 個交易日內、處置股、注意股、風險分數中以上，都不進場。</li></ol>" +
      '<p class="note">回測裡這條規則大約一半的交易是停損出場，所以第 4 點比選股重要。</p></details>';

    h += '<div class="vd-size"><label for="vd-risk">每筆最多賠 NT$</label><input id="vd-risk" type="number" inputmode="numeric" min="0" step="100" placeholder="例如 3000" value="' +
      (riskBudget() || "") + '"><span class="note">填了以後，有訊號的股票會算出股數。只存在你這台裝置。</span></div>';

    h += "<h3>有訊號（" + sig.length + "）</h3>";
    h += sig.length ? sig.map(signalRow).join("") : '<p class="note">今天沒有任何一檔出現規則進場訊號。</p>';

    var pb = G.pullback || [];
    h += "<h3>等回檔（" + pb.length + "）<small>離買進上限價近的排前面</small></h3>";
    h += pb.length
      ? '<div class="vd-wl">' + pb.map(waitRow).join("") + '</div><p class="note">「回到…以下」是用今天的均線和波動估的，每天會變。到價不等於可以買，還要等規則訊號出現。</p>'
      : '<p class="note">目前沒有。</p>';

    h += "<h3>不買（" + restN + "）</h3>" + (rest.map(noBuyGroup).join("") || '<p class="note">目前沒有。</p>');

    var notes = [];
    var con = concentration();
    if (con && con.n > 1 && con.w >= BIG_POSITION) notes.push(["warn", "最大部位 " + nm(con.top) + " 佔總市值 " + con.w.toFixed(1) + "%，整體損益幾乎由這一檔決定。"]);
    (V.checks || []).forEach(function (k) { notes.push([k.level, k.text]); });
    var seen = {};
    ["TW", "US"].forEach(function (m) {
      var r = V.regimeNotes && V.regimeNotes[m];
      if (r && r.text && !seen[r.text]) { seen[r.text] = true; notes.push(["info", r.text + "。"]); }
    });
    if (V.selfCheck && V.selfCheck.mismatch && V.selfCheck.mismatch.length) notes.push(["warn", "規則說明和規則本身有 " + V.selfCheck.mismatch.length + " 筆對不上（以規則為準）：" + V.selfCheck.mismatch.join("、")]);
    if (notes.length) {
      h += "<h3>部位與資料檢查</h3><ul class=\"vd-checks\">" + notes.map(function (n) {
        return '<li class="' + (n[0] === "warn" ? "w" : "i") + '">' + esc(n[1]) + "</li>";
      }).join("") + "</ul>";
    }
    h += '<p class="note">條件核對，不是買賣建議；要不要下單、下多少由你決定。</p>';
    body.innerHTML = h;
  }

  /* ---------- 個股卡片：最上面一行 ---------- */
  function cardHTML(v, open) {
    return '<div class="vd-card vd-c-' + v.code + '"><b>' + icon(v.code) + " " + esc(label(v.code)) + "</b><span>" + esc(v.text) + "</span>" +
      (v.notes && v.notes.length ? "<em>" + v.notes.map(esc).join("｜") + "</em>" : "") +
      '<button type="button" class="vd-more" aria-expanded="' + (open ? "true" : "false") + '">' + (open ? "收起明細" : "進場條件與風險明細") + "</button></div>";
  }
  function cards() {
    var box = $("cards");
    if (!box || !loaded) return;
    Array.prototype.forEach.call(box.querySelectorAll("article.card[data-code]"), function (card) {
      var old = card.querySelector(".vd-card");
      if (old) old.remove();
      var code = card.getAttribute("data-code");
      var v = V && V.symbols && V.symbols[code];
      if (!v) { card.classList.remove("vd-has", "vd-open"); return; }
      var anchor = card.querySelector(".status");
      if (!anchor) return;
      anchor.insertAdjacentHTML("beforebegin", cardHTML(v, !!openCards[code]));
      card.classList.add("vd-has");
      card.classList.toggle("vd-open", !!openCards[code]);
      card.setAttribute("data-verdict", v.code);
    });
  }

  /* ---------- 我的持倉：每個部位一行 ---------- */
  function holdings() {
    var pos = $("pos-body"), P = g("POSITIONS");
    if (!pos || !loaded || !V || !V.symbols || !P || pos.querySelector("#vd-hold")) return;
    var rows = P.map(function (p) {
      var v = V.symbols[p.code];
      if (!v || !v.hold) return "<li><b>" + esc(nm(p.code)) + "</b><span>沒有這一檔的最終指示。</span></li>";
      return '<li class="vd-h-' + esc(v.hold.code) + '"><b>' + esc(nm(p.code)) + "</b><span>" + esc(v.hold.text) +
        "</span><em>加碼：" + icon(v.code) + " " + esc(label(v.code)) + "</em></li>";
    }).join("");
    if (!rows) return;
    var el = document.createElement("div");
    el.id = "vd-hold"; el.className = "vd-hold";
    el.innerHTML = "<h3>持倉指示 <small>台股 " + md((V.sessions || {}).TW) + "｜美股 " + md((V.sessions || {}).US) + " 收盤後重算，沒有寫死的價位</small></h3><ul>" + rows + "</ul>";
    pos.appendChild(el);
  }

  /* ---------- 樣式 ---------- */
  function addStyle() {
    if ($("vd-style")) return;
    var s = document.createElement("style");
    s.id = "vd-style";
    var G = "var(--green,#3dd68c)", A = "var(--amber,#ffb450)", R = "var(--red,#ff6b6b)", M = "var(--muted,#c5d0de)", B = "var(--blue,#8ec0ff)";
    s.textContent =
      "#verdict h3,.vd-hold h3{margin:16px 0 8px;font-size:15px}" +
      "#verdict h3 small,.vd-hold h3 small{font-weight:400;font-size:12px;color:" + M + ";margin-left:8px}" +
      ".vd-top{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline;margin:0 0 8px;font-size:14px}" +
      ".vd-top b{font-size:18px}.vd-top b.vd-ok{color:" + G + "}.vd-top span{color:" + M + "}" +
      ".vd-warn{color:" + A + ";font-weight:600;margin:0 0 8px}" +
      ".vd-rules{margin:8px 0;font-size:13px;line-height:1.6}.vd-rules summary{cursor:pointer;color:" + B + "}.vd-rules ol{margin:6px 0 0;padding-left:20px}" +
      ".vd-size{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;margin:10px 0;font-size:13px}" +
      ".vd-size input{width:120px;padding:6px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.25);color:inherit;font:inherit}" +
      ".vd-row{margin:8px 0;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.14);border-left:4px solid #5c6570;background:rgba(0,0,0,.18);font-size:13px;line-height:1.55}" +
      ".vd-row p{margin:6px 0 0}.vd-row ul{margin:6px 0 0;padding-left:18px;color:" + M + "}" +
      ".vd-h{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline}.vd-h b{font-size:15px}.vd-h small{font-weight:400;color:" + M + "}.vd-h span{font-weight:600}" +
      ".vd-kv{display:flex;flex-wrap:wrap;gap:2px 14px;margin-top:4px;color:" + M + "}.vd-kv b{color:var(--text,#f7f4ee)}" +
      ".vd-shares{color:" + B + "}" +
      ".vd-c-go{border-left-color:" + G + "}.vd-c-go .vd-h span,.vd-card.vd-c-go b{color:" + G + "}" +
      ".vd-c-signal_unproven{border-left-color:" + A + "}.vd-c-signal_unproven .vd-h span,.vd-card.vd-c-signal_unproven b{color:" + A + "}" +
      ".vd-c-signal_blocked,.vd-c-avoid{border-left-color:" + R + "}.vd-c-signal_blocked .vd-h span,.vd-card.vd-c-signal_blocked b,.vd-card.vd-c-avoid b{color:" + R + "}" +
      ".vd-c-pullback,.vd-c-conditions{border-left-color:" + B + "}.vd-card.vd-c-pullback b,.vd-card.vd-c-conditions b{color:" + B + "}" +
      ".vd-w{display:grid;grid-template-columns:1fr auto;align-content:start;gap:2px 12px;padding:8px 2px;border-bottom:1px solid rgba(255,255,255,.1);font-size:13px;line-height:1.5}" +
      ".vd-w-n b{font-size:14px}.vd-w-n small{margin-left:6px;color:" + M + ";font-size:11px}" +
      ".vd-w-g{text-align:right;white-space:nowrap;color:" + M + "}.vd-w-g b{color:" + B + ";font-size:14px}" +
      ".vd-w-m,.vd-w-x{grid-column:1 / -1}.vd-w-m{color:" + M + "}.vd-w-m b{color:var(--text,#f7f4ee)}.vd-w-x{color:" + A + ";font-size:12.5px}" +
      "@media(min-width:900px){.vd-wl{display:grid;grid-template-columns:1fr 1fr;gap:0 28px}}" +
      ".vd-nb{margin:8px 0;font-size:13px;line-height:1.7}.vd-nb em{display:block;font-style:normal;font-weight:600}" +
      ".vd-nb span{display:inline-block;margin:2px 6px 2px 0;padding:1px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.16);color:" + M + "}.vd-nb span b{color:var(--text,#f7f4ee);font-weight:600}" +
      ".vd-checks{margin:0;padding-left:18px;font-size:13px;line-height:1.6}.vd-checks .w{color:" + A + "}.vd-checks .i{color:" + M + "}" +
      ".vd-card{margin:8px 0;padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.14);border-left:4px solid #5c6570;background:rgba(0,0,0,.22);font-size:12.5px;line-height:1.5}" +
      ".vd-card>b{display:block;font-size:15px}.vd-card>span{display:block}.vd-card>em{display:block;font-style:normal;color:" + M + ";font-size:11.5px;margin-top:2px}" +
      ".vd-more{margin-top:6px;padding:3px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.25);background:transparent;color:" + B + ";font:inherit;font-size:12px;cursor:pointer}" +
      "article.card.vd-has:not(.vd-open) .gate,article.card.vd-has:not(.vd-open) .risk{display:none}" +
      ".vd-hold{margin-top:12px;padding-top:4px;border-top:1px solid rgba(255,255,255,.14)}" +
      ".vd-hold ul{list-style:none;margin:0;padding:0;font-size:13px;line-height:1.55}" +
      ".vd-hold li{margin:6px 0;padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.14);border-left:4px solid " + G + ";background:rgba(0,0,0,.18)}" +
      ".vd-hold li b{display:block;font-size:14px}.vd-hold li span{display:block}.vd-hold li em{display:block;font-style:normal;color:" + M + ";font-size:12px;margin-top:2px}" +
      ".vd-hold li.vd-h-hot,.vd-hold li.vd-h-watch{border-left-color:" + A + "}.vd-hold li.vd-h-exit{border-left-color:" + R + "}";
    document.head.appendChild(s);
  }

  /* ---------- 啟動 ---------- */
  function renderAll() { panel(); cards(); holdings(); }
  function start() {
    addStyle();
    var box = $("cards"), pos = $("pos-body");
    if (box) {
      new MutationObserver(cards).observe(box, { childList: true });            // 只看卡片清單本身
      box.addEventListener("click", function (e) {
        var btn = e.target.closest && e.target.closest(".vd-more");
        if (!btn) return;
        var card = btn.closest("article.card"), code = card && card.getAttribute("data-code");
        if (!code) return;
        openCards[code] = !openCards[code];
        card.classList.toggle("vd-open", openCards[code]);
        btn.setAttribute("aria-expanded", openCards[code] ? "true" : "false");
        btn.textContent = openCards[code] ? "收起明細" : "進場條件與風險明細";
      });
    }
    if (pos) new MutationObserver(function () { holdings(); panel(); }).observe(pos, { childList: true });   // 持倉重畫（行情更新）時跟著重算
    document.addEventListener("change", function (e) {
      if (!e.target || e.target.id !== "vd-risk") return;
      try {
        var v = parseFloat(e.target.value);
        if (v > 0) localStorage.setItem(KEY, String(v)); else localStorage.removeItem(KEY);
      } catch (err) {}
      panel();
    });
    fetch("./data/verdict.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (json) { V = json; loaded = true; renderAll(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
