(function(){
  ['smart-levels','group-sync'].forEach(id=>document.getElementById(id)?.remove());
  document.querySelectorAll('nav a[href="#smart-levels"],nav a[href="#group-sync"]').forEach(a=>a.remove());

  if (typeof DATA === 'undefined' || typeof STOCK_META === 'undefined' || typeof NAMES === 'undefined') {
    console.warn('整合補丁：找不到 DATA / STOCK_META / NAMES');
    return;
  }

  const EXTRA_META = {
    'TW|AI伺服器／機櫃':['8210.TW'],
    'TW|AI基建／電力':['2371.TW'],
    'TW|光學／CPO':['3406.TW'],
    'TW|記憶體':['2408.TW'],
    'TW|CCL／電子材料':['1303.TW'],
    'TW|PCB／銅箔':['8358.TWO','4958.TW'],
    'TW|電池監測IC':['4919.TW']
  };

  Object.entries(EXTRA_META).forEach(([k,list])=>{
    STOCK_META[k] = Array.from(new Set([...(STOCK_META[k]||[]), ...list]));
  });

  Object.assign(NAMES, {
    '2371.TW':'大同',
    '8210.TW':'勤誠',
    '3406.TW':'玉晶光',
    '2408.TW':'南亞科',
    '1303.TW':'南亞',
    '8358.TWO':'金居',
    '4958.TW':'臻鼎-KY',
    '4919.TW':'新唐'
  });

  const seed = {
    '8358.TWO':{p:505,ch:'N/A',pct:2.02,date:'2026-10-01',status:'持有觀察',entry:'484.50-502.00',invalid:'N/A',resist:'524.00',s20:'N/A',s60:'N/A',note:'10/01 收盤 505；截圖支撐 502／484.5，壓力 524／543'},
    '3406.TW':{p:950,ch:'N/A',pct:6.74,date:'2026-10-01',status:'持有觀察',entry:'917.00-947.00',invalid:'N/A',resist:'970.00',s20:'N/A',s60:'N/A',note:'10/01 收盤 950；截圖支撐 947／917，壓力 970／1000'},
    '8210.TW':{p:845,ch:'N/A',pct:1.08,date:'2026-10-01',status:'持有觀察',entry:'826.00-842.00',invalid:'N/A',resist:'858.00',s20:'N/A',s60:'N/A',note:'10/01 收盤 845；截圖支撐 842／826，壓力 858／919'},
    '2371.TW':{p:30.50,ch:'N/A',pct:0.16,date:'2026-10-01',status:'持有觀察',entry:'29.90-30.45',invalid:'N/A',resist:'30.90',s20:'N/A',s60:'N/A',note:'10/01 收盤 30.50；截圖支撐 30.45／29.90，壓力 30.90／31.65'},
    '1303.TW':{p:254,ch:'N/A',pct:-0.59,date:'2026-10-01',status:'等待',entry:'N/A',invalid:'N/A',resist:'N/A',s20:'N/A',s60:'N/A',note:'10/01 收盤 254；新聞題材為高階 CCL／電子材料，技術位待每日資料更新'},
    '2408.TW':{p:'N/A',ch:'N/A',pct:'N/A',date:'2026-10-01',status:'等待',entry:'N/A',invalid:'N/A',resist:'N/A',s20:'N/A',s60:'N/A',note:'新增關注：南亞科；截圖重點為 3D 晶圓封測／屏東設廠案，行情待同步'},
    '4919.TW':{p:'N/A',ch:'N/A',pct:'N/A',date:'2026-10-02',status:'等待',entry:'N/A',invalid:'N/A',resist:'N/A',s20:'N/A',s60:'N/A',note:'新增關注：新唐；電池診斷晶片 KA85010UA，預計 2027/1 提供樣品'},
    '4958.TW':{p:561,ch:'N/A',pct:'N/A',date:'持倉截圖',status:'持有觀察',entry:'N/A',invalid:'N/A',resist:'N/A',s20:'N/A',s60:'N/A',note:'持倉截圖：市價 561、均價 481.90、80 股；技術位待每日資料更新'}
  };

  Object.entries(seed).forEach(([code,obj])=>{
    if(!DATA[code]) DATA[code] = obj;
  });

  const extraCodes = ['8358.TWO','3406.TW','8210.TW','2371.TW','1303.TW','2408.TW','4919.TW','4958.TW'];
  try{
    if(typeof order !== 'undefined') extraCodes.forEach(c=>{ if(!order.includes(c)) order.push(c); });
  }catch(e){}

  const LEVELS = {
    '8358.TWO':{support:[502,484.5],resistance:[524,543]},
    '3406.TW':{support:[947,917],resistance:[970,1000]},
    '8210.TW':{support:[842,826],resistance:[858,919]},
    '2371.TW':{support:[30.45,29.90],resistance:[30.90,31.65]}
  };

  const MARKET_LEVELS = { support:48218, pivot:48380, resistance:48601 };
  const POSITION = { code:'4958.TW', shares:80, avg:481.90, market:561, pnl:6131, pnlPct:15.90 };

  const num = v => {
    if(v===null || v===undefined || v==='N/A' || v==='') return null;
    const n = Number(v); return Number.isFinite(n) ? n : null;
  };
  const fmt = v => {
    const n = num(v); if(n===null) return 'N/A';
    return Math.abs(n)>=1000 ? n.toLocaleString('en-US',{maximumFractionDigits:2}) : (Number.isInteger(n)?String(n):n.toFixed(2).replace(/\.00$/,''));
  };
  const dist = (level,current) => {
    const l=num(level), c=num(current); if(l===null || c===null || c===0) return 'N/A';
    const x=(l-c)/c*100; return `${x>0?'+':''}${x.toFixed(1)}%`;
  };
  const marketInfo = code => {
    let market='台股', group='其他';
    Object.entries(STOCK_META).some(([k,list])=>{
      if(list.includes(code)){
        const p=k.split('|'); market=p[0]==='TW'?'台股':'美股'; group=p[1]||'其他'; return true;
      }
      return false;
    });
    return {market,group};
  };
  const parseEntry = entry => {
    const m = String(entry||'').match(/-?\d+(?:\.\d+)?/g); return m ? m.map(Number).filter(Number.isFinite) : [];
  };
  const supports = code => {
    const d=DATA[code]; if(!d) return [];
    if(LEVELS[code]?.support) return LEVELS[code].support.slice(0,2);
    const p=num(d.p); if(p===null) return [];
    return Array.from(new Set([...parseEntry(d.entry),num(d.s20),num(d.s60),num(d.invalid)].filter(Number.isFinite)))
      .filter(x=>x<p).sort((a,b)=>b-a).slice(0,2);
  };
  const resistances = code => {
    const d=DATA[code]; if(!d) return [];
    if(LEVELS[code]?.resistance) return LEVELS[code].resistance.slice(0,2);
    const p=num(d.p), r=num(d.resist); return (p!==null && r!==null && r>p) ? [r] : [];
  };
  const scenario = code => {
    const d=DATA[code], s=supports(code), r=resistances(code), p=num(d?.p);
    return {
      high: r[0]!=null ? `若開高接近 ${fmt(r[0])}，觀察量價與是否能站穩；未站穩先視為壓力。` : '若開高，先觀察量價是否同步；目前沒有可靠上方壓力資料。',
      flat: s[0]!=null ? `若平開並守住 ${fmt(s[0])}，維持原結構觀察；接近壓力時等突破確認。` : '若平開，先看原趨勢、均線與量價。',
      low: s[0]!=null ? (s[1]!=null ? `若跌破 ${fmt(s[0])}，下一支撐看 ${fmt(s[1])}；兩層皆失守則短線轉弱。` : `若跌破 ${fmt(s[0])}，短線結構轉弱。`) : '若開低，先觀察 SMA20／SMA60 與失效價。',
      current:p
    };
  };

  const style = document.createElement('style');
  style.id='integrated-stock-patch-style';
  style.textContent=`
  .u2-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px}.u2-card{background:#091a2b;border:1px solid rgba(201,169,106,.2);border-radius:10px;padding:12px}.u2-card h3{margin:0 0 8px;color:var(--gold2);font-size:14px}.u2-row{display:flex;justify-content:space-between;gap:12px;margin:5px 0;font-size:12px}.u2-big{font-size:1.22rem;font-weight:800}.u2-muted{font-size:11px;color:var(--muted)}.u2-lv{padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06)}.u2-lv:last-child{border-bottom:none}.u2-scen{padding:9px;border-radius:8px;background:#071a2d;border:1px solid rgba(77,163,255,.2);font-size:12px}.u2-market{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.u2-market .u2-card{text-align:center}.u2-market .u2-big{color:var(--gold2)}.u2-pos{border-left:3px solid var(--green)}.u2-toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}.u2-toolbar select,.u2-toolbar button{background:#081a2d;color:var(--text);border:1px solid rgba(201,169,106,.35);border-radius:8px;padding:9px 10px}.u2-toolbar select{flex:1;min-width:190px}.u2-toolbar button{cursor:pointer;color:var(--gold2)}.u2-syncbar{height:7px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden}.u2-syncfill{height:100%;background:linear-gradient(90deg,#3dd68c,#4da3ff)}@media(max-width:650px){.u2-market{grid-template-columns:1fr}.u2-grid{grid-template-columns:1fr}}
  `;
  if(!document.getElementById(style.id)) document.head.appendChild(style);

  function rerenderMeta(){
    const el=document.getElementById('meta-panel'); if(!el) return;
    el.innerHTML=Object.entries(STOCK_META).map(([k,arr])=>`<div style="margin:8px 0;"><strong style="color:var(--gold)">${k}</strong>：${arr.map(c=>(NAMES[c]||c)+' '+c).join('、')}</div>`).join('');
  }

  function basicCard(code){
    const d=DATA[code], info=marketInfo(code), name=NAMES[code]||code;
    const pct = typeof d.pct==='number' ? `${d.pct>0?'+':''}${d.pct}%` : 'N/A';
    return `<div class="card u2-extra" data-code="${code}"><div class="title">${info.market}｜${info.group}｜${name}</div><div class="sub">${code}｜${d.date||'N/A'}｜${d.note||''}</div><div class="price">${fmt(d.p)}</div><div class="row"><span>漲跌幅</span><span>${pct}</span></div><div style="margin-top:6px;">${typeof badge==='function'?badge(d.status):d.status}</div><div class="row"><span>進場區</span><span>${d.entry||'N/A'}</span></div><div class="row"><span>失效價</span><span>${d.invalid||'N/A'}</span></div><div class="row"><span>壓力</span><span>${d.resist||'N/A'}</span></div></div>`;
  }

  ['watch-grid','decision-grid'].forEach(id=>{
    const g=document.getElementById(id); if(!g) return;
    extraCodes.forEach(code=>{ if(!g.textContent.includes(code)) g.insertAdjacentHTML('beforeend',basicCard(code)); });
  });

  rerenderMeta();

  const nav=document.querySelector('nav');
  if(nav){
    [['#u2-market-levels','大盤關卡'],['#u2-smart','新增關注'],['#u2-position','我的持倉'],['#u2-sync','族群同步'],['#guide','使用方法']].forEach(([href,label])=>{
      if(!nav.querySelector(`a[href="${href}"]`)){ const a=document.createElement('a'); a.href=href; a.textContent=label; nav.appendChild(a); }
    });
  }

  const indexSec=document.getElementById('index');
  if(indexSec && !document.getElementById('u2-market-levels')){
    const s=document.createElement('section'); s.id='u2-market-levels'; s.className='panel';
    s.innerHTML=`<h2>🇹🇼 台股大盤三道關卡</h2><div class="u2-market"><div class="u2-card"><div class="u2-muted">🛡️ 第一觀察支撐</div><div class="u2-big">${fmt(MARKET_LEVELS.support)}</div><div class="u2-muted">守住：短線結構仍可觀察</div></div><div class="u2-card"><div class="u2-muted">⚡ 短線突破關卡</div><div class="u2-big">${fmt(MARKET_LEVELS.pivot)}</div><div class="u2-muted">重新站穩：觀察續強</div></div><div class="u2-card"><div class="u2-muted">🔥 前波高點壓力</div><div class="u2-big">${fmt(MARKET_LEVELS.resistance)}</div><div class="u2-muted">突破＋站穩才算進一步轉強</div></div></div><p class="note">跌破 48,218 且站不回：短線結構轉弱，重新尋找下一層支撐。這三個價位來自你提供的 10/2 關卡圖，屬觀察位，不是保證目標。</p>`;
    indexSec.insertAdjacentElement('afterend',s);
  }

  const decisionSec=document.getElementById('decision');
  if(decisionSec && !document.getElementById('u2-smart')){
    const s=document.createElement('section'); s.id='u2-smart'; s.className='panel';
    s.innerHTML=`<h2>🧭 新增關注股｜智慧支撐壓力</h2><div class="u2-toolbar"><select id="u2-select"></select><button id="u2-copy">📋 複製分析</button></div><div id="u2-smart-body"></div>`;
    decisionSec.insertAdjacentElement('afterend',s);
    const sel=s.querySelector('#u2-select');
    extraCodes.forEach(code=>{ const o=document.createElement('option'); o.value=code; o.textContent=`${NAMES[code]}｜${code}`; sel.appendChild(o); });
    function render(code){
      const d=DATA[code], ss=supports(code), rr=resistances(code), sc=scenario(code), info=marketInfo(code);
      s.querySelector('#u2-smart-body').innerHTML=`<div class="u2-card"><h3>${NAMES[code]}｜${code} <span class="u2-muted">${info.group}</span></h3><div class="u2-row"><span>現價</span><span class="u2-big">${fmt(d.p)}</span></div><div class="u2-grid"><div><div class="u2-lv">🛡️ 近端支撐 <b>${fmt(ss[0])}</b><div class="u2-muted">距現價 ${dist(ss[0],d.p)}</div></div><div class="u2-lv">🛡️ 第二支撐 <b>${fmt(ss[1])}</b><div class="u2-muted">距現價 ${dist(ss[1],d.p)}</div></div></div><div><div class="u2-lv">⚡ 第一壓力 <b>${fmt(rr[0])}</b><div class="u2-muted">距現價 ${dist(rr[0],d.p)}</div></div><div class="u2-lv">🔥 第二壓力 <b>${fmt(rr[1])}</b><div class="u2-muted">距現價 ${dist(rr[1],d.p)}</div></div></div></div><div class="u2-grid" style="margin-top:10px"><div class="u2-scen"><b>🚀 開高</b><br>${sc.high}</div><div class="u2-scen"><b>➡️ 平開</b><br>${sc.flat}</div><div class="u2-scen"><b>⚠️ 開低</b><br>${sc.low}</div></div><p class="note">${d.note||''}</p></div>`;
    }
    sel.addEventListener('change',()=>render(sel.value));
    render(sel.value);
    s.querySelector('#u2-copy').addEventListener('click',async function(){
      const code=sel.value,d=DATA[code],ss=supports(code),rr=resistances(code),sc=scenario(code);
      const txt=`【${NAMES[code]} ${code}】\n現價：${fmt(d.p)}\n近端支撐：${fmt(ss[0])}（${dist(ss[0],d.p)}）\n第二支撐：${fmt(ss[1])}（${dist(ss[1],d.p)}）\n第一壓力：${fmt(rr[0])}（${dist(rr[0],d.p)}）\n第二壓力：${fmt(rr[1])}（${dist(rr[1],d.p)}）\n\n開高：${sc.high}\n平開：${sc.flat}\n開低：${sc.low}\n\n備註：${d.note||'N/A'}\n※僅供觀察，不構成投資建議。`;
      try{ await navigator.clipboard.writeText(txt); this.textContent='✅ 已複製'; setTimeout(()=>this.textContent='📋 複製分析',1200); }catch(e){}
    });
  }

  if(decisionSec && !document.getElementById('u2-position')){
    const s=document.createElement('section'); s.id='u2-position'; s.className='panel';
    const marketValue=POSITION.market*POSITION.shares, cost=POSITION.avg*POSITION.shares;
    s.innerHTML=`<h2>💼 我的持倉</h2><div class="u2-card u2-pos"><h3>${NAMES[POSITION.code]}｜${POSITION.code}</h3><div class="u2-row"><span>股數</span><b>${POSITION.shares}</b></div><div class="u2-row"><span>平均成本</span><b>${POSITION.avg.toFixed(2)}</b></div><div class="u2-row"><span>截圖市價</span><b>${POSITION.market.toFixed(2)}</b></div><div class="u2-row"><span>成本金額</span><b>${fmt(cost)}</b></div><div class="u2-row"><span>市值</span><b>${fmt(marketValue)}</b></div><div class="u2-row"><span>截圖損益</span><b>${fmt(POSITION.pnl)}（${POSITION.pnlPct.toFixed(2)}%）</b></div><p class="note">持倉數字沿用你提供的截圖；之後若市價變動，需由每日資料更新模組覆蓋。</p></div>`;
    const anchor=document.getElementById('u2-smart')||decisionSec; anchor.insertAdjacentElement('afterend',s);
  }

  if(decisionSec && !document.getElementById('u2-sync')){
    const s=document.createElement('section'); s.id='u2-sync'; s.className='panel'; s.innerHTML='<h2>📊 族群同步雷達</h2><div id="u2-sync-list"></div><p class="note">同步度＝當日上漲檔數 ÷ 有有效漲跌幅資料檔數；只表示當日一致性，不代表買進訊號。</p>';
    const anchor=document.getElementById('u2-position')||document.getElementById('u2-smart')||decisionSec; anchor.insertAdjacentElement('afterend',s);
    const box=s.querySelector('#u2-sync-list');
    box.innerHTML=Object.entries(STOCK_META).map(([g,list])=>{
      const rows=list.map(code=>({code,pct:num(DATA[code]?.pct)})).filter(x=>x.pct!==null);
      if(!rows.length) return '';
      const up=rows.filter(x=>x.pct>0).length, down=rows.filter(x=>x.pct<0).length, pct=Math.round(up/rows.length*100);
      const label=pct>=75?'同步偏強':pct>=50?'部分同步':'族群分化';
      return `<div class="u2-card" style="margin-bottom:8px"><div class="u2-row"><b>${g}</b><span>${pct}%｜${label}</span></div><div class="u2-syncbar"><div class="u2-syncfill" style="width:${pct}%"></div></div><div class="u2-muted" style="margin-top:5px">上漲 ${up}／下跌 ${down}／有效 ${rows.length}</div></div>`;
    }).join('');
  }


  if(!document.getElementById('guide')){
    const s=document.createElement('section'); s.id='guide'; s.className='panel';
    s.innerHTML=`<h2>📘 使用方法</h2><div class="u2-grid"><div class="u2-card"><h3>① 大盤三道關卡</h3><div class="u2-muted">48,218 看能否守住；48,380 看能否重新站穩；48,601 看突破後是否站穩。不要只看碰到價位，要看收盤／量價是否確認。</div></div><div class="u2-card"><h3>② 個股支撐／壓力</h3><div class="u2-muted">接近支撐先觀察是否止跌；接近第一壓力不追價；突破第一壓力後，再觀察是否往第二壓力移動。跌破兩層支撐則短線風險提高。</div></div><div class="u2-card"><h3>③ 開高／平開／開低</h3><div class="u2-muted">開高：看壓力能否站穩。平開：看近端支撐是否守住。開低：先看第一支撐，失守再看第二支撐。</div></div><div class="u2-card"><h3>④ 族群同步雷達</h3><div class="u2-muted">75% 以上表示當日多數同族群上漲；50%～74% 為部分同步；低於 50% 為分化。同步度只反映當日一致性，不等於買點。</div></div><div class="u2-card"><h3>⑤ 我的持倉</h3><div class="u2-muted">臻鼎-KY 的 80 股、均價 481.90、截圖市價 561 會獨立顯示。市價日後變動時，應以最新行情覆蓋，不把截圖價當永久現價。</div></div><div class="u2-card"><h3>⑥ 每日更新</h3><div class="u2-muted">金居、玉晶光、勤誠、大同先使用你截圖中的支撐壓力；其他新關注股若沒有可靠技術位會顯示 N/A，不自行亂算。等你的每日 DATA 更新後再自動補齊。</div></div></div><p class="note">流程建議：先看大盤方向 → 看族群同步 → 選個股 → 看支撐壓力 → 最後套用開高／平開／開低情境。所有價位都屬觀察工具，不保證未來漲跌。</p>`;
    const wrap=document.querySelector('.wrap'); const footer=wrap?.querySelector('.footer');
    if(footer) footer.insertAdjacentElement('beforebegin',s); else wrap?.appendChild(s);
  }
})();
