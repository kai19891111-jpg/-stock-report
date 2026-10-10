/* =====================================================================
   music.js｜背景音樂（精簡版）

   安裝：在 index.html 最後、</body> 之前加：
        <script src="./music.js"></script>

   做什麼：
   右下角一顆圓形「♪」按鈕（在 🖼 背景按鈕左邊）。按一下播放，再按一下暫停。
   歌曲播完自動從頭重播（無限循環），所以一首 3–5 分鐘的檔案就能一直播下去。
   音量請用手機／電腦本身的音量鍵（iPhone 的 Safari 不允許網頁調音量，所以拿掉了滑桿）。

   為什麼不能一開頁面就自動播：瀏覽器擋掉沒有經過點擊的有聲播放。
   音樂檔在按下去之後才開始下載，不按不耗流量。

   版權：這個 repo 是公開的，assets/ 裡的音樂任何人都能下載。
   只放自己做的、或授權寫明「可用於網站」的免版稅音樂，並保留授權來源紀錄。
   ===================================================================== */
(function () {
  "use strict";
  if (window.__bgm) return;
  window.__bgm = true;

  var SRC = (window.MUSIC_CONFIG && window.MUSIC_CONFIG.src) || "./assets/bgm.mp3";   // 要換歌只改這裡
  var audio = null, btn, msg;

  function say(text) { msg.textContent = text || ""; msg.hidden = !text; }

  function ensure() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = "none";
    audio.loop = true;
    audio.src = SRC;
    audio.addEventListener("playing", function () { say(""); paint(); });
    audio.addEventListener("pause", paint);
    audio.addEventListener("error", function () {
      say("找不到音樂檔 " + SRC + "，請確認已放進 assets/，檔名大小寫要一樣。");
      paint();
    });
    return audio;
  }
  function toggle() {
    var a = ensure();
    if (!a.paused) { a.pause(); return; }
    say("");
    var p = a.play();
    if (p && p.catch) p.catch(function (e) {
      if (e && e.name === "NotAllowedError") say("瀏覽器擋住了播放，請再按一次。");
      paint();
    });
  }
  function paint() {
    var on = !!audio && !audio.paused && !audio.error;
    btn.textContent = on ? "❚❚" : "♪";
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? "暫停背景音樂" : "播放背景音樂";
    btn.setAttribute("aria-label", btn.title);
    btn.classList.toggle("on", on);
  }

  function start() {
    var s = document.createElement("style");
    s.id = "music-style";
    s.textContent =
      "#music-box{position:fixed;z-index:200;right:calc(64px + env(safe-area-inset-right,0px));bottom:calc(12px + env(safe-area-inset-bottom,0px));" +
      "display:flex;flex-direction:column;align-items:flex-end;gap:6px}" +
      "#music-btn{width:44px;height:44px;padding:0;border-radius:50%;font:inherit;font-size:18px;line-height:1;font-weight:700;color:#fff;cursor:pointer;" +
      "background:rgba(7,24,46,.86);border:1px solid rgba(255,255,255,.4);box-shadow:0 6px 18px rgba(0,0,0,.35);" +
      "-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}" +
      "#music-btn.on{font-size:13px;border-color:var(--amber,#ffb450)}" +
      "#music-btn:hover{border-color:#fff}" +
      "#music-btn:focus-visible{outline:2px solid var(--blue,#8ec0ff);outline-offset:2px}" +
      "#music-box p{margin:0;padding:8px 12px;border-radius:10px;width:max-content;max-width:min(280px,calc(100vw - 88px));line-height:1.5;font-size:13px;color:#ffd9a3;background:rgba(7,24,46,.92);border:1px solid var(--amber,#ffb450)}" +
      "@media print{#music-box{display:none}}";
    document.head.appendChild(s);

    var box = document.createElement("div");
    box.id = "music-box";
    box.innerHTML = '<p id="music-msg" role="status" hidden></p><button type="button" id="music-btn" aria-pressed="false"></button>';
    document.body.appendChild(box);
    btn = box.querySelector("#music-btn");
    msg = box.querySelector("#music-msg");
    btn.addEventListener("click", toggle);
    paint();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.BGM = { toggle: toggle, src: SRC };
})();
