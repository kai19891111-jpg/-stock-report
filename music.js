/* =====================================================================
   music.js｜背景音樂

   安裝：
   1. 把音樂檔放進 repo 的 assets/ 資料夾，檔名用英文或數字（例：assets/bgm.mp3）。
      建議 MP3，128–192 kbps，一首 3–6 MB。GitHub 單一檔案上限 100 MB。
   2. 把這個檔案放在 repo 根目錄（和 index.html 同一層）。
   3. 在 index.html 最後、</body> 之前加：
        <script src="./music.js"></script>
   4. 檔名不是 bgm.mp3、或有好幾首，改下面的 TRACKS。

   做什麼：
   右下角多一顆「♪ 音樂」按鈕。按下去開始播，播完自動接下一首，全部播完從頭再來；
   播放中會出現音量滑桿，有兩首以上時多一顆「下一首」。音量記在這台裝置。

   為什麼不能一開頁面就自動播：所有瀏覽器（尤其手機）都擋掉沒有經過點擊的有聲播放，
   所以每次開頁面要自己按一下。音樂檔在按下去之後才開始下載，不按不耗流量。

   注意：這個 repo 是公開的，放上去的音樂任何人都能下載。請放自己有權公開散布的音樂
   （自己做的、買了網站使用授權的、或免版稅音樂）。
   ===================================================================== */
(function () {
  "use strict";
  if (window.__bgm) return;
  window.__bgm = true;

  /* ---------- 設定：要換歌只改這裡 ---------- */
  var TRACKS = [
    "./assets/bgm.mp3"
    // "./assets/song2.mp3",
    // "./assets/song3.mp3"
  ];
  var DEFAULT_VOLUME = 0.5;                 // 0–1

  var user = window.MUSIC_CONFIG || {};
  if (Array.isArray(user.tracks) && user.tracks.length) TRACKS = user.tracks;

  var STORE = "bgm-volume";
  var audio = null, idx = 0, failed = 0, box, btn, next, vol, msg;

  function savedVolume() {
    try { var v = parseFloat(localStorage.getItem(STORE)); return v >= 0 && v <= 1 ? v : DEFAULT_VOLUME; }
    catch (e) { return DEFAULT_VOLUME; }
  }
  function fileName(src) { try { return decodeURIComponent(String(src).split("/").pop().split("?")[0]); } catch (e) { return String(src); } }
  function say(text) { msg.textContent = text || ""; msg.hidden = !text; }

  function ensure() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = "none";                 // 按下播放才下載
    audio.volume = savedVolume();
    audio.addEventListener("ended", function () { failed = 0; play(idx + 1); });
    audio.addEventListener("playing", function () { failed = 0; say(""); paint(); });
    audio.addEventListener("pause", paint);
    audio.addEventListener("error", function () {
      failed++;
      if (failed >= TRACKS.length) {         // 每一首都讀不到
        say("找不到音樂檔：" + TRACKS.map(fileName).join("、") + "。請確認檔案已放進 assets/，檔名大小寫要一樣。");
        paint();
      } else play(idx + 1);
    });
    return audio;
  }
  function play(i) {
    var a = ensure();
    idx = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
    a.src = TRACKS[idx];
    var p = a.play();
    if (p && p.catch) p.catch(function (e) {
      if (e && e.name === "NotAllowedError") say("瀏覽器擋住了播放，請再按一次。");
      paint();
    });
  }
  function toggle() {
    var a = ensure();
    if (!a.paused) { a.pause(); return; }
    failed = 0;
    say("");
    if (a.src && a.currentTime > 0 && !a.error) a.play().catch(paint);   // 從暫停的地方接著播
    else play(idx);
  }
  function paint() {
    var on = !!audio && !audio.paused && !audio.error;
    btn.textContent = on ? "♪ 暫停" : "♪ 音樂";
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? "正在播放：" + fileName(TRACKS[idx]) : "播放背景音樂";
    vol.hidden = !on;
    next.hidden = !on || TRACKS.length < 2;
    box.classList.toggle("on", on);
  }

  function start() {
    var s = document.createElement("style");
    s.id = "music-style";
    s.textContent =
      "#music-box{position:fixed;z-index:200;right:calc(12px + env(safe-area-inset-right,0px));bottom:calc(64px + env(safe-area-inset-bottom,0px));" +
      "display:flex;flex-direction:column;align-items:flex-end;gap:6px;max-width:calc(100vw - 24px);font-size:13px}" +
      "#music-box .row{display:flex;align-items:center;gap:6px;padding:0 4px 0 0;border-radius:999px}" +
      "#music-box.on .row{background:rgba(7,24,46,.86);border:1px solid rgba(255,255,255,.4);padding-left:12px;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}" +
      "#music-box button{min-height:44px;padding:0 16px;border-radius:999px;font:inherit;font-weight:600;color:#fff;cursor:pointer;" +
      "background:rgba(7,24,46,.86);border:1px solid rgba(255,255,255,.4);box-shadow:0 6px 18px rgba(0,0,0,.35);white-space:nowrap}" +
      "#music-box.on button{background:transparent;border-color:transparent;box-shadow:none;padding:0 12px}" +
      "#music-box button:hover{border-color:#fff}" +
      "#music-box button:focus-visible,#music-box input:focus-visible{outline:2px solid var(--blue,#8ec0ff);outline-offset:2px}" +
      "#music-box input[type=range]{width:96px;height:44px;margin:0;accent-color:var(--blue,#8ec0ff);background:transparent}" +
      "#music-box p{margin:0;padding:8px 12px;border-radius:10px;max-width:280px;line-height:1.5;color:#ffd9a3;background:rgba(7,24,46,.92);border:1px solid var(--amber,#ffb450)}" +
      "@media print{#music-box{display:none}}";
    document.head.appendChild(s);

    box = document.createElement("div");
    box.id = "music-box";
    box.innerHTML = '<p id="music-msg" role="status" hidden></p><div class="row">' +
      '<input id="music-vol" type="range" min="0" max="1" step="0.05" aria-label="音量" hidden>' +
      '<button type="button" id="music-next" aria-label="下一首" title="下一首" hidden>⏭</button>' +
      '<button type="button" id="music-btn" aria-pressed="false"></button></div>';
    document.body.appendChild(box);
    btn = box.querySelector("#music-btn"); next = box.querySelector("#music-next");
    vol = box.querySelector("#music-vol"); msg = box.querySelector("#music-msg");
    vol.value = String(savedVolume());
    btn.addEventListener("click", toggle);
    next.addEventListener("click", function () { failed = 0; play(idx + 1); });
    vol.addEventListener("input", function () {
      var v = parseFloat(vol.value);
      if (audio) audio.volume = v;
      try { localStorage.setItem(STORE, String(v)); } catch (e) { /* 沒關係 */ }
    });
    paint();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.BGM = { toggle: toggle, next: function () { play(idx + 1); }, tracks: TRACKS };
})();
