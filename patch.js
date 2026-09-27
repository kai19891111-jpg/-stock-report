(function(){
  function fmtPct(v){ return (v==null || isNaN(v)) ? "N/A" : (v*100).toFixed(1)+"%"; }
  function fmtR(v){ return (v==null || isNaN(v)) ? "N/A" : ((v>=0?"+":"")+Number(v).toFixed(2)+"R"); }
  function card(k,v,s){
    return '<div class="stat-card" style="background:#F7F1E6;color:#1A2332;padding:10px 12px;border:1px solid #E7DFD0"><b style="display:block;font-size:11px;color:#6B7280">'+k+'</b><div style="font-size:18px;font-weight:700">'+v+'</div><div style="font-size:11px;color:#6B7280">'+s+'</div></div>';
  }
  function renderStats(st){
    st = st || {};
    var oos = st.oos || {};
    var n = oos.sampleSize || 0;
    var sampleLabel = n<30 ? "⚪ 樣本不足" : (n<100 ? "🟡 初步統計" : "🟢 樣本較充分");
    var ci = (oos.ciLow==null||oos.ciHigh==null) ? "N/A" : (fmtPct(oos.ciLow)+"～"+fmtPct(oos.ciHigh));
    var el = document.getElementById("strategy-stats");
    if(!el){
      el = document.createElement("section");
      el.id = "strategy-stats";
      el.className = "trade-alert-panel";
      var host = document.getElementById("trade-alert");
      if(host) host.insertAdjacentElement("afterend", el);
      else return;
    }
    el.innerHTML = '<div class="trade-alert-head"><div class="trade-alert-title">📊 策略實績</div><small style="color:#9AA8B8">決策輔助，禁止自動下單</small></div>'+
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;padding:12px">'+
      card("樣本 N", n?String(n):"N/A", sampleLabel)+
      card("OOS 勝率", n>=30?fmtPct(oos.winRate):"N/A", "95% CI "+(n>=30?ci:"N/A"))+
      card("Expected R", n>=30?fmtR(oos.expectancyR):"N/A", "主要評估指標")+
      card("Profit Factor", n>=30 && oos.profitFactor!=null?Number(oos.profitFactor).toFixed(2):"N/A", "毛利/毛損")+
      card("Max DD", n>=30?fmtR(oos.maxDrawdownR):"N/A", "累積 R")+
      card("最近20", n>=30?fmtPct(oos.recent20WinRate):"N/A", "50筆 "+(n>=30?fmtPct(oos.recent50WinRate):"N/A"))+
      card("市場", st.marketRegime||"N/A", "分環境統計")+
      card("更新", st.updated||"N/A", st.isFinalClose===false?"🟡 盤中資料":"正式收盤")+
      '</div><p class="upgrade-note" style="padding:0 14px 12px">歷史數據＋技術條件＋風險報酬＋樣本外回測。N&lt;30 不顯示高勝率。</p>';
  }
  function attachHist(stats){
    var stocks = window.__REPORT_STOCKS || [];
    var similar = (stats && stats.similar) || {};
    stocks.forEach(function(s){
      s.hist = similar[s.symbol] || similar[s.name] || {n:0};
      s.conditionScore = s.conditionScore!=null ? s.conditionScore : s.score;
    });
    renderStats(stats);
  }
  fetch("./data/strategy_stats.json").then(function(r){ return r.ok?r.json():null; }).then(function(j){
    window.__STRATEGY_STATS = j || {oos:{sampleSize:0}};
    attachHist(window.__STRATEGY_STATS);
  }).catch(function(){
    attachHist({oos:{sampleSize:0}, marketRegime:"N/A"});
  });
})();
