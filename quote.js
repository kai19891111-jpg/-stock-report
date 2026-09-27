/* ticker quote: TW digits -> .TW/.TWO, US letters as-is */
(function(){
  if (window.__quoteBarReady) return;
  window.__quoteBarReady = true;

  function el(tag, attrs, html){
    const n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function(k){ n.setAttribute(k, attrs[k]); });
    if (html != null) n.innerHTML = html;
    return n;
  }

  const style = el('style', null, `
    .qbar{position:sticky;top:52px;z-index:8;margin:0 0 14px;background:#0C2240;border:1px solid rgba(201,169,106,.35);padding:10px 12px;}
    .qbar-h{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;}
    .qbar-h b{color:#E4C98A;letter-spacing:.08em;font-size:12px;}
    .qbar-h small{color:#9AA8B8;font-size:11px;}
    .qrow{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
    .qrow input,.qrow select,.qrow button{font:inherit;}
    .qrow input{flex:1;min-width:160px;background:#071221;color:#F6F1E7;border:1px solid rgba(201,169,106,.35);padding:8px 10px;}
    .qrow select{background:#071221;color:#E4C98A;border:1px solid rgba(201,169,106,.35);padding:8px;}
    .qrow button{background:transparent;color:#E4C98A;border:1px solid #C9A96A;padding:8px 12px;cursor:pointer;}
    .qchips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;}
    .qchips button{background:#071221;color:#C5D0DE;border:1px solid rgba(201,169,106,.25);padding:4px 8px;font-size:11px;cursor:pointer;}
    .qout{margin-top:8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;}
    .qcard{background:#FFFcf7;color:#1A2332;padding:10px 12px;border-radius:4px;}
    .qcard .m{font-size:11px;color:#6B7280;}
    .qcard .n{font-weight:700;margin:2px 0;}
    .qcard .p{font-size:22px;font-weight:700;}
    .q-up{color:#B42318;} .q-dn{color:#0F6E66;} .q-err{color:#9A3412;font-size:12px;}
    @media(max-width:800px){.qbar{top:44px;}}
  `);
  document.head.appendChild(style);

  const bar = el('section', {id:'quote-bar', class:'qbar'});
  bar.innerHTML = `
    <div class="qbar-h"><b>代碼查價</b><small>台股數字／美股英文代碼，可逗號多筆</small></div>
    <form class="qrow" id="qform">
      <select id="qmarket" aria-label="市場">
        <option value="auto">自動判別</option>
        <option value="tw">台股</option>
        <option value="us">美股</option>
      </select>
      <input id="qinput" placeholder="例：3481、6770、2221 或 NVDA,TSLA" autocomplete="off" />
      <button type="submit">查詢</button>
    </form>
    <div class="qchips" id="qchips"></div>
    <div class="qout" id="qout"></div>
  `;

  const page = document.querySelector('main.page') || document.body;
  const nav = page.querySelector('nav.nav');
  if (nav && nav.nextSibling) page.insertBefore(bar, nav.nextSibling);
  else page.insertBefore(bar, page.firstChild);

  const chips = ['3481','6770','2221','2330','NVDA','TSLA','SPCX'];
  const chipBox = bar.querySelector('#qchips');
  chips.forEach(function(c){
    const b = el('button', {type:'button'});
    b.textContent = c;
    b.onclick = function(){ bar.querySelector('#qinput').value = c; lookup(); };
    chipBox.appendChild(b);
  });

  function normOne(raw, market){
    let s = String(raw||'').trim().toUpperCase();
    if (!s) return [];
    s = s.replace(/、/g,',').replace(/，/g,',');
    if (s.indexOf(',')>=0) return s.split(',').flatMap(function(x){ return normOne(x, market); });
    if (s.endsWith('.TW') || s.endsWith('.TWO') || s.endsWith('.US')) return [s];
    const isNum = /^\d{3,6}$/.test(s);
    const isUS = /^[A-Z.\-]{1,8}$/.test(s) && !isNum;
    if (market==='us' || (!isNum && isUS)) return [s];
    if (market==='tw' || isNum){
      if (s==='2221' || s==='3324') return [s+'.TWO'];
      return [s+'.TW', s+'.TWO'];
    }
    return [s];
  }

  function yahooUrls(sym){
    const y = 'https://query1.finance.yahoo.com/v8/finance/chart/'+encodeURIComponent(sym)+'?interval=1d&range=5d';
    return [
      y,
      'https://corsproxy.io/?'+encodeURIComponent(y),
      'https://api.allorigins.win/raw?url='+encodeURIComponent(y)
    ];
  }

  async function fetchJson(url){
    const r = await fetch(url, {headers:{'Accept':'application/json'}});
    if (!r.ok) throw new Error('http '+r.status);
    return r.json();
  }

  async function quoteSymbol(sym){
    let lastErr;
    const urls = yahooUrls(sym);
    for (let i=0;i<urls.length;i++){
      try{
        const d = await fetchJson(urls[i]);
        const res = d && d.chart && d.chart.result && d.chart.result[0];
        if (!res || !res.meta) throw new Error('no meta');
        const m = res.meta;
        const px = m.regularMarketPrice;
        const prev = m.chartPreviousClose || m.previousClose;
        if (px==null) throw new Error('no px');
        const chg = prev ? (px-prev) : null;
        const pct = (chg!=null && prev) ? chg/prev*100 : null;
        const exch = (m.exchangeName||'').toUpperCase();
        const market = (exch.indexOf('TAI')>=0 || exch==='TWO' || /\.TW/.test(sym)) ? '台股' : '美股';
        return {ok:true, sym:sym, name:m.shortName||m.symbol||sym, px:px, chg:chg, pct:pct, currency:m.currency||'', market:market, exch:m.exchangeName||''};
      }catch(e){ lastErr=e; }
    }
    return {ok:false, sym:sym, err: String(lastErr&&lastErr.message||lastErr||'fail')};
  }

  async function lookup(){
    const market = bar.querySelector('#qmarket').value;
    const raw = bar.querySelector('#qinput').value;
    const out = bar.querySelector('#qout');
    const parts = raw.split(/[,、， ]+/).filter(Boolean);
    if (!parts.length){ out.innerHTML = '<div class="q-err">請輸入代號，例如 3481 或 NVDA</div>'; return; }
    out.innerHTML = '<div class="qcard"><div class="m">查詢中…</div></div>';
    const wanted = [];
    parts.forEach(function(p){ normOne(p, market).forEach(function(s){ if (wanted.indexOf(s)<0) wanted.push(s); }); });
    const rows = [];
    for (const s of wanted){
      rows.push(await quoteSymbol(s));
    }
    const seen = {};
    const good = rows.filter(function(r){
      if (!r.ok) return false;
      const key = r.name+'|'+Math.round(r.px*100);
      if (seen[key]) return false;
      seen[key]=1; return true;
    });
    const bad = rows.filter(function(r){ return !r.ok; });
    if (!good.length){
      out.innerHTML = '<div class="q-err">查不到報價。台股請試 3481 或 2221.TWO；美股請試 NVDA。'+ (bad[0]?' ('+bad[0].err+')':'') +'</div>';
      return;
    }
    out.innerHTML = good.map(function(r){
      const cls = r.pct==null?'' : (r.pct>=0?'q-up':'q-dn');
      const chg = r.chg==null? 'N/A' : ((r.chg>=0?'+':'')+r.chg.toFixed(2));
      const pct = r.pct==null? '' : (' '+ (r.pct>=0?'+':'')+r.pct.toFixed(2)+'%');
      return '<div class="qcard"><div class="m">'+r.market+' · '+r.sym+' · '+r.exch+'</div><div class="n">'+r.name+'</div><div class="p '+cls+'">'+r.px.toLocaleString()+' <span style="font-size:13px">'+r.currency+' '+chg+pct+'</span></div></div>';
    }).join('');
  }

  bar.querySelector('#qform').addEventListener('submit', function(e){ e.preventDefault(); lookup(); });
})();