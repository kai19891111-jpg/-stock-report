/* 股票分析報告優化補丁 V2 */
(function () {
  'use strict';
  var REPORT_META = { snapshotDate: '2026-09-25', twTradeDate: '2026-09-24', usTradeDate: '2026-09-24', bondTradeDate: '2026-09-24', timezone: 'Asia/Taipei', staleAfterDays: 1 };
  var TW_HOLIDAYS = { '2026-09-25': 1, '2026-09-28': 1, '2026-10-09': 1, '2026-10-26': 1 };
  function dateKeyInTZ(tz) {
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    var o = {}; parts.forEach(function (p) { if (p.type !== 'literal') o[p.type] = p.value; });
    return o.year + '-' + o.month + '-' + o.day;
  }
  function clockInTZ(tz) {
    var parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date());
    var o = {}; parts.forEach(function (p) { if (p.type !== 'literal') o[p.type] = p.value; });
    return o.hour + ':' + o.minute + ':' + o.second;
  }
  function parseDateUTC(s) { var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; }
  function calendarAgeDays(fromDate, toDate) { var a = parseDateUTC(fromDate), b = parseDateUTC(toDate); if (a == null || b == null) return null; return Math.max(0, Math.floor((b - a) / 86400000)); }
  function parseNum(v) {
    if (v == null) return null;
    var s = String(v).replace(/,/g, '').replace(/%/g, '').replace(/：1.*/, '').trim();
    if (!s || s === 'N/A' || s === '—' || s.indexOf('N/A') >= 0) return null;
    var m = s.match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null;
  }
  function parseRange(v) {
    if (!v || String(v).indexOf('N/A') >= 0) return { low: null, high: null };
    var m = String(v).match(/([\d,.]+)\s*[～~-]\s*([\d,.]+)/);
    return m ? { low: parseNum(m[1]), high: parseNum(m[2]) } : { low: null, high: null };
  }
  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"').replace(/'/g, '&#039;');
  }
  function isWeekend(dateKey) { var t = parseDateUTC(dateKey); if (t == null) return false; var d = new Date(t).getUTCDay(); return d === 0 || d === 6; }
  function isTWClosed(dateKey) { return isWeekend(dateKey) || !!TW_HOLIDAYS[dateKey]; }
  function replaceNoneText() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), nodes = [];
    while (walker.nextNode()) { if (walker.currentNode.nodeValue && walker.currentNode.nodeValue.indexOf('None') >= 0) nodes.push(walker.currentNode); }
    nodes.forEach(function (n) { n.nodeValue = n.nodeValue.replace(/\bNone\b/g, 'N/A'); });
  }
  function dataStatusFor(s, todayKey) {
    var missing = [];
    if (s.priceNum == null) missing.push('現價');
    if (s.ma20 == null) missing.push('MA20');
    if (s.rsi == null) missing.push('RSI');
    if (missing.length) return '🔴 缺關鍵資料：' + missing.join('、');
    var tradeDate = s.tradeDate || ((String(s.symbol || '').indexOf('.TW') >= 0 || String(s.symbol || '').indexOf('.TWO') >= 0) ? REPORT_META.twTradeDate : REPORT_META.usTradeDate);
    var age = calendarAgeDays(tradeDate, todayKey);
    if (age == null) return '🟡 資料日期未知';
    if (age === 0) return '🟢 最新交易日資料';
    if (age <= REPORT_META.staleAfterDays) return '🟡 延遲 ' + age + ' 天';
    return '🔴 資料已過期 ' + age + ' 天';
  }
  function mustGate(s) {
    var entryRR = parseNum(s.entryRR), invalid = parseNum(s.invalidPrice);
    var dailyOK = !!s.dailyTrend && s.dailyTrend.indexOf('空') < 0;
    var weeklyOK = !!s.weeklyTrend && s.weeklyTrend.indexOf('空') < 0;
    var ma20OK = !!(s.must && s.must.ma20Ok);
    var rrOK = entryRR != null && entryRR >= 1.5;
    var structureOK = invalid == null || s.priceNum == null || s.priceNum > invalid;
    return { pass: dailyOK && weeklyOK && ma20OK && rrOK && structureOK, dailyOK: dailyOK, weeklyOK: weeklyOK, ma20OK: ma20OK, rrOK: rrOK, structureOK: structureOK };
  }
  function heatScore(s) {
    var score = 0, r1Dist = parseNum(s.distR1);
    if (s.rsi != null) { if (s.rsi >= 80) score += 40; else if (s.rsi >= 75) score += 32; else if (s.rsi >= 70) score += 24; else if (s.rsi >= 65) score += 10; }
    if (s.changePct != null) { if (s.changePct >= 8) score += 25; else if (s.changePct >= 5) score += 18; else if (s.changePct >= 3) score += 10; }
    if (r1Dist != null) { if (r1Dist <= 1) score += 25; else if (r1Dist <= 2) score += 18; else if (r1Dist <= 4) score += 8; }
    if (s.ma20 != null && s.priceNum != null && s.ma20 > 0) {
      var gap = ((s.priceNum - s.ma20) / s.ma20) * 100;
      if (gap >= 15) score += 20; else if (gap >= 10) score += 14; else if (gap >= 6) score += 8;
    }
    if (s.volRatio != null) { if (s.volRatio >= 2) score += 8; else if (s.volRatio >= 1.5) score += 4; }
    return Math.min(100, score);
  }
  function opportunityScore(s) {
    var gate = s.gate;
    if (String(s.unheldStatus || '').indexOf('🔴') >= 0) return -100;
    if (!gate.dailyOK || !gate.weeklyOK || !gate.structureOK) return -80;
    var score = 0;
    if (s.inZone) score += 40;
    else if (s.belowZone) score -= 25;
    else if (s.distPct != null && s.distPct <= 1) score += 30;
    else if (s.distPct != null && s.distPct <= 3) score += 20;
    else if (s.distPct != null && s.distPct <= 8) score += 8;
    else if (s.distPct != null && s.distPct > 8) score -= 10;
    if (gate.dailyOK) score += 10;
    if (gate.weeklyOK) score += 8;
    if (gate.ma20OK) score += 8;
    if (gate.rrOK) score += 14;
    if (s.bonus && s.bonus.macdOk) score += 6;
    if (s.bonus && s.bonus.volOk) score += 5;
    if (s.bonus && s.bonus.spaceOk) score += 5;
    score -= Math.round((s.heatScore || 0) * 0.35);
    if (!gate.pass) score = Math.min(score, 49);
    return score;
  }
  function upgradeStocks() {
    var stocks = Array.isArray(window.__REPORT_STOCKS) ? window.__REPORT_STOCKS : [];
    var todayKey = dateKeyInTZ(REPORT_META.timezone);
    stocks.forEach(function (s) {
      var range = parseRange(s.entryZone), price = s.priceNum;
      s.inZone = price != null && range.low != null && range.high != null && price >= range.low && price <= range.high;
      s.belowZone = price != null && range.low != null && price < range.low;
      if (price != null && range.high != null && range.high > 0) s.distPct = ((price - range.high) / range.high) * 100;
      if (range.low == null || range.high == null) s.distLabel = 'N/A';
      else if (s.inZone) s.distLabel = '✅ 已進入進場區';
      else if (s.belowZone) s.distLabel = '🔴 已跌破進場區下緣 -' + (((range.low - price) / range.low) * 100).toFixed(1) + '%';
      else if (s.distPct != null && s.distPct <= 1) s.distLabel = '🟡 非常接近 +' + s.distPct.toFixed(1) + '%';
      else if (s.distPct != null && s.distPct <= 3) s.distLabel = '👀 接近 +' + s.distPct.toFixed(1) + '%';
      else if (s.distPct != null && s.distPct <= 8) s.distLabel = '⏳ 等待回檔 +' + s.distPct.toFixed(1) + '%';
      else if (s.distPct != null) s.distLabel = '🟠 不宜追價 +' + s.distPct.toFixed(1) + '%';
      s.dataStatus = dataStatusFor(s, todayKey);
      s.gate = mustGate(s);
      s.heatScore = heatScore(s);
      s.score = opportunityScore(s);
    });
    return stocks;
  }
  function changeClass(v) { return v != null && v >= 0 ? 'chg-up' : 'chg-dn'; }
  function changeText(s) { if (s.changePct == null) return 'N/A'; return (s.changePct > 0 ? '+' : '') + s.changePct.toFixed(2) + '%'; }
  function renderOpportunity(stocks) {
    var root = document.getElementById('opportunity-body');
    if (!root) return;
    var eligible = stocks.filter(function (s) { return String(s.unheldStatus || '').indexOf('🔴') < 0; }).sort(function (a, b) { return b.score - a.score; });
    var top = eligible.slice().sort(function (a, b) { return Number(b.gate.pass) - Number(a.gate.pass) || b.score - a.score; }).slice(0, 5);
    var near = eligible.filter(function (s) { return s.inZone || (!s.belowZone && s.distPct != null && s.distPct <= 3); });
    var hot = stocks.filter(function (s) { return s.heatScore >= 50; }).sort(function (a, b) { return b.heatScore - a.heatScore; });
    var weak = stocks.filter(function (s) { return String(s.unheldStatus || '').indexOf('🔴') >= 0 || !s.gate.structureOK; });
    var wait = eligible.filter(function (s) { return !s.inZone && !s.belowZone && s.distPct != null && s.distPct > 3; });
    function gateReason(s) {
      var missing = [];
      if (!s.gate.dailyOK) missing.push('日線');
      if (!s.gate.weeklyOK) missing.push('週線');
      if (!s.gate.ma20OK) missing.push('MA20');
      if (!s.gate.rrOK) missing.push('風報比');
      if (!s.gate.structureOK) missing.push('結構');
      return s.gate.pass ? '✅ Gate PASS' : ('尚缺：' + (missing.join('、') || '收盤確認'));
    }
    function item(s, extra) {
      return '<div class="opp-item"><b>' + escapeHtml(s.name) + '</b>' + escapeHtml(s.unheldStatus || '⚪ 資料不足') + '<br>現價 ' + escapeHtml(s.price || 'N/A') + ' <span class="' + changeClass(s.changePct) + '">' + escapeHtml(changeText(s)) + '</span><br>' + escapeHtml(s.distLabel || 'N/A') + '<br>風報比：' + escapeHtml(s.entryRR || s.rr || 'N/A') + '<br>Heat：' + s.heatScore + '/100<br>Score：' + s.score + '<br>' + (extra || '') + '</div>';
    }
    function box(title, list, extraFn) {
      var body = list.length ? list.map(function (s) { return item(s, extraFn(s)); }).join('') : '<div class="trade-empty">目前無</div>';
      return '<div class="opp-box"><h3>' + title + '</h3>' + body + '</div>';
    }
    root.innerHTML = '<div class="opp-grid">' + box('⭐ 最接近進場條件', top, gateReason) + box('👀 優先觀察', near.slice(0, 8), function (s) { return gateReason(s) + '｜等待確認'; }) + box('🔥 過熱勿追', hot.slice(0, 8), function () { return 'RSI／漲幅／壓力／MA20乖離／量能綜合'; }) + box('⚠️ 結構轉弱', weak, function () { return '結構優先於分數'; }) + box('⏳ 等待回檔', wait.slice(0, 10), function () { return '等待回到有效進場區'; }) + '</div><p class="upgrade-note" style="padding:0 12px 12px;color:#4B5563">系統先檢查必要條件 Gate，再比較 Opportunity Score。分數代表條件完成度，不代表實際勝率。</p>';
  }
  function renderSession() {
    var root = document.getElementById('session-body');
    if (!root) return;
    var today = dateKeyInTZ('Asia/Taipei'), clock = clockInTZ('Asia/Taipei'), closed = isTWClosed(today);
    var age = calendarAgeDays(REPORT_META.twTradeDate, today);
    var twState = closed ? '今日休市／非交易日' : (clock < '08:30:00' ? '盤前' : (clock < '09:00:00' ? '開盤前準備' : (clock <= '13:30:00' ? '🟢 台股盤中' : '收盤後')));
    var stale = age != null && age > REPORT_META.staleAfterDays;
    root.innerHTML = '<div class="session-box"><b>🇹🇼 台股市場狀態</b>現在：' + today + ' ' + clock + '（台北）<br>狀態：' + twState + '<br>行情資料：' + REPORT_META.twTradeDate + '<br>' + (stale ? '<strong>⚠️ 行情不是最新交易日，請更新資料後再使用新訊號。</strong>' : '🟢 資料新鮮度正常') + '</div><div class="session-box"><b>🇺🇸 美股提醒時段</b>盤前 → 09:30 ET 開盤 → 12:30 ET 盤中 → 16:00 ET 收盤<br>美股資料：' + REPORT_META.usTradeDate + '<br>沒有接即時行情 API 時，系統不會把舊收盤資料假裝成即時價格。</div>';
  }
  function updateAlertState(stocks) {
    var KEY = 'MARKET_REPORT_ALERT_STATE_V2', prev = {}, next = {}, changes = [];
    try { prev = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { prev = {}; }
    stocks.forEach(function (s) {
      var current = { unheldStatus: s.unheldStatus || '', heldStatus: s.heldStatus || '', inZone: !!s.inZone, belowZone: !!s.belowZone, heatBand: s.heatScore >= 70 ? 'HOT' : (s.heatScore >= 50 ? 'WARM' : 'NORMAL'), tradeDate: s.tradeDate || '' };
      next[s.name] = current;
      var old = prev[s.name];
      if (old && JSON.stringify(old) !== JSON.stringify(current)) changes.push({ name: s.name, from: old, to: current });
    });
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) {}
    window.__ALERT_STATE = next; window.__ALERT_CHANGES = changes;
  }
  function copyPlain(text, btn) {
    function success() { if (!btn) return; var old = btn.textContent; btn.textContent = '✅ 已複製'; setTimeout(function () { btn.textContent = old; }, 1200); }
    function fallback() {
      var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); success(); } catch (e) { alert(text); } ta.remove();
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(success).catch(fallback); else fallback();
  }
  function replaceButton(id) { var old = document.getElementById(id); if (!old) return null; var fresh = old.cloneNode(true); old.replaceWith(fresh); return fresh; }
  function bindCopyButtons(stocks) {
    var sorted = stocks.slice().sort(function (a, b) { return b.score - a.score; });
    function block(s) { return s.name + '\n' + (s.unheldStatus || '') + '\n' + (s.distLabel || '') + '\nGate：' + (s.gate.pass ? 'PASS' : 'WAIT') + '\nScore：' + s.score + '\nHeat：' + s.heatScore + '/100'; }
    var tradeText = ['🚦 今日交易提示', '台股資料：' + REPORT_META.twTradeDate, '美股資料：' + REPORT_META.usTradeDate, '', '⭐ 條件完成度最高'].concat(sorted.slice(0, 8).map(block)).join('\n\n');
    var opportunityText = ['🎯 今日機會', '資料日期：' + REPORT_META.twTradeDate, ''].concat(sorted.filter(function (s) { return String(s.unheldStatus || '').indexOf('🔴') < 0; }).slice(0, 8).map(block)).join('\n\n');
    var watchText = ['⭐ 我的關注股', '資料日期：' + REPORT_META.twTradeDate, ''].concat(stocks.map(function (s) { return s.name + '｜' + (s.unheldStatus || '') + '｜現價 ' + (s.price || 'N/A') + '｜' + (s.distLabel || ''); })).join('\n');
    var map = { copyTradeAlert: tradeText, copyOpp: opportunityText, copyWatch: watchText };
    Object.keys(map).forEach(function (id) { var btn = replaceButton(id); if (btn) btn.addEventListener('click', function () { copyPlain(map[id], btn); }); });
  }
  function updateTitle() { document.title = '技術與基本面報告｜' + dateKeyInTZ(REPORT_META.timezone) + '｜行情 ' + REPORT_META.twTradeDate; }
  function runUpgrade() {
    replaceNoneText(); updateTitle();
    var stocks = upgradeStocks();
    if (!stocks.length) { console.warn('[Market Upgrade] missing __REPORT_STOCKS'); return; }
    renderOpportunity(stocks); renderSession(); updateAlertState(stocks); bindCopyButtons(stocks);
    window.__REPORT_META = REPORT_META; window.__REPORT_STOCKS = stocks;
    console.log('✅ 股票報告優化完成');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(runUpgrade, 0); }, { once: true });
  else setTimeout(runUpgrade, 80);
})();
