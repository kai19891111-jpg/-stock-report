/* =====================================================================
   wallpaper.js｜只看背景

   安裝：
   1. 把這個檔案放在 repo 根目錄（和 index.html 同一層）。
   2. 在 index.html 的 <head> 裡、<title> 的下一行加：
        <script src="./wallpaper.js"></script>
      放在 <head> 是為了一開頁面就先套用，不會先閃一下報告再收起來。
   不需要改 index.html 其他程式。

   做什麼：
   右下角多一顆圓形「🖼」按鈕。按下去整份報告收起來，只剩大谷翔平的背景圖（去掉暗色遮罩）；
   再按「✕」或按 Esc 回來，捲動位置不變。手機直放時圖片寬度撐滿、上下置中，電腦／橫放整張顯示。
   選擇會記在這台裝置的瀏覽器：上次停在背景，下次開頁面就直接是背景。
   只看背景時，盤中報價（live.js）會暫停更新，回報告時立刻補抓一次；背景音樂（music.js）的按鈕會留著。
   ===================================================================== */
(function () {
  "use strict";
  if (window.__wallpaper) return;
  window.__wallpaper = true;

  var STORE = "wallpaper-mode";
  var IMAGE = "./assets/ohtani-cartoon.jpg";   // 和頁面背景同一張；要換圖只改這裡
  var root = document.documentElement;
  var btn = null, savedY = 0;

  function remembered() { try { return localStorage.getItem(STORE) === "1"; } catch (e) { return false; } }
  function remember(on) { try { localStorage.setItem(STORE, on ? "1" : "0"); } catch (e) { /* 無痕模式：這次有效，下次不記得 */ } }
  function isOn() { return root.classList.contains("wall-on"); }

  var s = document.createElement("style");
  s.id = "wallpaper-style";
  s.textContent =
    "html.wall-on body>*:not(#wall-btn):not(#music-box){display:none!important}" +
    "html.wall-on,html.wall-on body{height:100%;overflow:hidden}" +
    /* 手機直放：圖片寬度撐滿、上下置中，底下只留按鈕那一排 */
    "html.wall-on body:before{background:var(--bg,#07182e) url('" + IMAGE + "') center calc(50% - 28px) / min(100vw, calc((100dvh - 72px) * 0.671)) auto no-repeat}" +
    /* 螢幕比圖片寬（電腦、橫放的平板）時改成整張都看得到，兩側留底色 */
    "@media (min-aspect-ratio: 784/1168){html.wall-on body:before{background-size:auto min(92vh, 920px);background-position:center}}" +
    "#wall-btn{position:fixed;z-index:200;right:calc(12px + env(safe-area-inset-right,0px));bottom:calc(12px + env(safe-area-inset-bottom,0px));" +
    "width:44px;height:44px;padding:0;border-radius:50%;font:inherit;font-size:18px;line-height:1;color:#fff;cursor:pointer;" +
    "background:rgba(7,24,46,.86);border:1px solid rgba(255,255,255,.4);box-shadow:0 6px 18px rgba(0,0,0,.35);" +
    "-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}" +
    "#wall-btn:hover{border-color:#fff}" +
    "#wall-btn:focus-visible{outline:2px solid var(--blue,#8ec0ff);outline-offset:2px}" +
    "html.wall-on #wall-btn{background:rgba(7,24,46,.6)}" +
    "@media print{#wall-btn{display:none}}";
  document.head.appendChild(s);

  if (remembered()) root.classList.add("wall-on");      // 在畫面出現之前就套用

  function label() {
    if (!btn) return;
    var on = isOn();
    btn.textContent = on ? "✕" : "🖼";
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? "回報告（Esc）" : "收起報告，只看背景";
    btn.setAttribute("aria-label", btn.title);
  }
  function set(on) {
    if (on === isOn()) return;
    if (on) savedY = window.scrollY || 0;
    root.classList.toggle("wall-on", on);
    remember(on);
    label();
    if (!on) {
      var hash = location.hash ? document.getElementById(location.hash.slice(1)) : null;
      if (savedY) window.scrollTo({ top: savedY, behavior: "instant" });
      else if (hash) hash.scrollIntoView({ block: "start", behavior: "instant" });   // 一開頁面就是背景的情況：回報告時照網址的 # 位置
      if (window.LiveQuotes && window.LiveQuotes.refresh) window.LiveQuotes.refresh();
    }
  }

  function start() {
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "wall-btn";
    btn.addEventListener("click", function () { set(!isOn()); });
    document.body.appendChild(btn);
    label();
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && isOn()) set(false); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.Wallpaper = { show: function () { set(true); }, hide: function () { set(false); }, isOn: isOn };
})();
