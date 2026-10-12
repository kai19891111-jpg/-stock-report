/* backtest.js — load and render strategy_stats.json into #bt-body */
(function () {
  const body = document.getElementById("bt-body");
  if (!body) return;

  function fmt(v, d = 3) {
    if (v == null || isNaN(v)) return "—";
    return Number(v).toFixed(d);
  }
  function pct(v) {
    if (v == null || isNaN(v)) return "—";
    return (v * 100).toFixed(1) + "%";
  }
  function n(v) { return v == null ? "—" : v; }

  function block(title, s) {
    if (!s || !s.sampleSize) return "";
    let h = `<div class="bt-block"><h3>${title}</h3>`;
    h += `<p>樣本 ${s.sampleSize}｜勝率 ${pct(s.winRate)}｜期望值 <b>${fmt(s.expectancyR)} R</b>`;
    if (s.expectancyExMaxR != null) {
      h += `｜去掉最大單筆後 ${fmt(s.expectancyExMaxR)} R`;
    }
    h += `</p>`;
    h += `<p class="note">最大單筆 ${fmt(s.maxSingleR)} R｜獲利因子 ${fmt(s.profitFactor, 2)}｜最大回撤 ${fmt(s.maxDrawdownR)} R｜平均持有 ${fmt(s.avgHoldingDays, 1)} 日</p>`;
    if (s.expLow != null) h += `<p class="note">期望值 95% 區間 ${fmt(s.expLow)} ～ ${fmt(s.expHigh)} R</p>`;
    h += `</div>`;
    return h;
  }

  fetch("data/strategy_stats.json")
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(data => {
      const meta = data.meta || {};
      let html = "";

      if (meta.outliers && meta.outliers.length) {
        html += `<p style="color:#c0392b;font-weight:600">⚠ 有 ${meta.outliers.length} 筆異常交易（|R| > 10），數字待確認</p>`;
      }

      html += `<p class="note">更新 ${data.updated || ""}｜${meta.from || ""} → ${meta.to || ""}｜分割 ${meta.splitDate || ""}｜參數 ${meta.paramsLabel || ""}</p>`;

      html += block("全部", data.all);
      html += block("前段（in-sample）", data.insample);
      html += block("後段（out-of-sample）", data.oos);

      if (data.benchmark) {
        const b = data.benchmark;
        html += `<div class="bt-block"><h3>隨機進場對照</h3>`;
        html += `<p>實際 ${fmt(b.actualR)} R｜隨機平均 ${fmt(b.meanR)} R｜勝過 ${pct(b.beats)} 的隨機組合</p>`;
        html += `<p class="note">${b.definition || ""}</p></div>`;
      }

      if (data.byMarket) {
        html += `<h3>分市場</h3>`;
        for (const m of Object.keys(data.byMarket)) {
          html += block(m, data.byMarket[m]);
        }
      }

      if (data.search) {
        const s = data.search;
        html += `<p class="note">參數搜尋：${s.selected || "無"}｜${s.reason || ""}</p>`;
      }

      body.innerHTML = html || `<p class="note">無回測資料</p>`;
      const stamp = document.getElementById("bt-stamp");
      if (stamp && data.updated) stamp.textContent = data.updated.slice(0, 10);
    })
    .catch(err => {
      body.innerHTML = `<p class="note">讀取回測資料失敗（${err}）。請確認 data/strategy_stats.json 存在。</p>`;
    });
})();
