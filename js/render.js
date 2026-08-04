/* ===== Glucose Intelligence — shared rendering layer (backend-agnostic) ===== */
/* Дані завантажуються/зберігаються ззовні (patient-app.js / doctor-app.js через Supabase).
   Цей файл лише рендерить те, що є в FULL_HISTORY / DEVICE_COLORS. */

let CAN_EDIT = true;              // false у режимі перегляду лікарем
let ON_SAVE_DEVICE_COLOR = null;  // async (deviceId, colorKeyOrNull) => void

function mergeReadings(a, b){
  const map = new Map();
  for(const r of a) map.set(r.t, {mgdl:r.mgdl, dev:r.dev});
  for(const r of b) map.set(r.t, {mgdl:r.mgdl, dev:r.dev}); // новіші дані переважають при точному збігу часу
  return [...map.entries()].map(([t,v])=>({t, mgdl:v.mgdl, mmol: mgdlToMmol(v.mgdl), dev:v.dev})).sort((x,y)=>x.t-y.t);
}

const SENSOR_COLORS = {
  green:  {hex:'#6dbf3f', label:'Зелений'},
  orange: {hex:'#e8a33d', label:'Помаранчевий'},
  blue:   {hex:'#6d9dc9', label:'Синій'},
  sand:   {hex:'#c7b393', label:'Пісочний'},
  gray:   {hex:'#93989f', label:'Сірий'}
};
let DEVICE_COLORS = {};
function deviceColorHex(dev){
  const key = dev && DEVICE_COLORS[dev];
  return (key && SENSOR_COLORS[key]) ? SENSOR_COLORS[key].hex : null;
}

function svgPathLength(points){
  let len=0;
  for(let i=1;i<points.length;i++){
    const dx=points[i][0]-points[i-1][0], dy=points[i][1]-points[i-1][1];
    len += Math.sqrt(dx*dx+dy*dy);
  }
  return len;
}

function animateValue(el, target, decimals, duration){
  if(!el) return;
  duration = duration || 900;
  const startTime = (typeof performance!=='undefined'&&performance.now)?performance.now():Date.now();
  function step(now){
    const elapsed = now-startTime;
    const progress = Math.min(1, elapsed/duration);
    const eased = 1-Math.pow(1-progress,3);
    el.textContent = (target*eased).toFixed(decimals);
    if(progress<1) requestAnimationFrame(step);
    else el.textContent = target.toFixed(decimals);
  }
  requestAnimationFrame(step);
}

function growWidths(containerEl, selector){
  const els = containerEl.querySelectorAll(selector);
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      els.forEach(el=>{ el.style.width = el.dataset.w + '%'; });
    });
  });
}

function buildSensorIconSvg(hex, w, h){
  w = w || 26; h = h || 39;
  const color = hex || '#5c6478';
  return `<svg width="${w}" height="${h}" viewBox="0 0 100 150" xmlns="http://www.w3.org/2000/svg">
    <rect x="10" y="118" width="80" height="24" rx="8" fill="#d9d5c9"/>
    <g stroke="#b8b3a2" stroke-width="1.6" opacity="0.7">
      <line x1="20" y1="120" x2="20" y2="140"/>
      <line x1="30" y1="120" x2="30" y2="140"/>
      <line x1="40" y1="120" x2="40" y2="140"/>
      <line x1="50" y1="120" x2="50" y2="140"/>
      <line x1="60" y1="120" x2="60" y2="140"/>
      <line x1="70" y1="120" x2="70" y2="140"/>
      <line x1="80" y1="120" x2="80" y2="140"/>
    </g>
    <rect x="12" y="48" width="76" height="74" fill="${color}"/>
    <path d="M12 48 Q12 6 50 6 Q88 6 88 48 Z" fill="#f5f3ec"/>
    <ellipse cx="34" cy="26" rx="9" ry="16" fill="#ffffff" opacity="0.35"/>
    <ellipse cx="50" cy="128" rx="34" ry="4" fill="#00000008"/>
  </svg>`;
}

const SENSOR_LIFESPAN_DAYS = 16;
function nowAsDeviceEpoch(){
  const d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
}

function pluralUk(n, forms){
  const mod10=n%10, mod100=n%100;
  if(mod100>=11&&mod100<=14) return forms[2];
  if(mod10===1) return forms[0];
  if(mod10>=2&&mod10<=4) return forms[1];
  return forms[2];
}

const COLORS = {
  vlow:'#93163a', low:'#e0527a', target:'#35c988', high:'#f0a93d', vhigh:'#e8483d',
  gold:'#c9a24b', goldBright:'#e8c775'
};
const PRINT_COLORS = {
  vlow:'#7a1030', low:'#b83a5a', target:'#1f8f5e', high:'#b8781f', vhigh:'#c0392b',
  gold:'#8a6d2e', goldBright:'#6b5420'
};
let PRINT_MODE = false;
function C(){ return PRINT_MODE ? PRINT_COLORS : COLORS; }
const BAND_ORDER = ['vlow','low','target','high','vhigh'];
const BAND_LABEL = {vlow:'Дуже низький (<3.0)', low:'Низький (3.0–3.9)', target:'Ціль (3.9–10.0)', high:'Високий (10.0–13.9)', vhigh:'Дуже високий (>13.9)'};
const BAND_LABEL_SHORT = {vlow:'Дуже низький', low:'Низький', target:'Ціль', high:'Високий', vhigh:'Дуже високий'};

let ALL_READINGS = [];
let FULL_HISTORY = [];
let CURRENT_DEVICE_FILTER = 'all';
let FILTERED = [];
let currentFilter = 'all';
let currentSearch = '';
let currentPage = 0;
const PAGE_SIZE = 40;

function dayWordUk(n){
  const mod10=n%10, mod100=n%100;
  if(mod100>=11&&mod100<=14) return 'днів';
  if(mod10===1) return 'день';
  if(mod10>=2&&mod10<=4) return 'дні';
  return 'днів';
}
function dayNameUk(date){
  const names=['Нд','Пн','Вт','Ср','Чт','Пт','Сб'];
  return names[date.getUTCDay()];
}
function griZone(g){
  if(g<20) return 'мінімальний ризик';
  if(g<40) return 'низький ризик';
  if(g<60) return 'помірний ризик';
  if(g<80) return 'високий ризик';
  return 'дуже високий ризик';
}
function kpiGoalHtml(ok, text){ return `<div class="kpi-goal ${ok?'ok':'warn'}">${text}</div>`; }

function smoothSvgPath(points){
  if(points.length<2) return '';
  let d = `M ${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for(let i=1;i<points.length-1;i++){
    const mx=(points[i][0]+points[i+1][0])/2, my=(points[i][1]+points[i+1][1])/2;
    d+=` Q ${points[i][0].toFixed(1)},${points[i][1].toFixed(1)} ${mx.toFixed(1)},${my.toFixed(1)}`;
  }
  const last = points[points.length-1];
  d+=` L ${last[0].toFixed(1)},${last[1].toFixed(1)}`;
  return d;
}

function buildGaugeSvg(value, bandKey){
  const size=220, stroke=14, r=(size-stroke)/2, cx=size/2, cy=size/2;
  const circumference = 2*Math.PI*r;
  const domainMin=2, domainMax=16;
  const frac = Math.max(0, Math.min(1, (value-domainMin)/(domainMax-domainMin)));
  const offset = circumference*(1-frac);
  const color = COLORS[bandKey];
  return `<svg class="gauge-svg" viewBox="0 0 ${size} ${size}">
    <defs>
      <filter id="gaugeGlow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(241,237,228,0.07)" stroke-width="${stroke}"/>
    <circle id="gaugeArc" class="gauge-arc" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
      stroke-linecap="round" stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${circumference.toFixed(1)}"
      data-target-offset="${offset.toFixed(1)}"
      transform="rotate(-90 ${cx} ${cy})" filter="url(#gaugeGlow)"/>
  </svg>`;
}

function buildSparkSvg(readings){
  const lastT = readings[readings.length-1].t;
  const cutoff = lastT - 3*60*60000;
  let last = readings.filter(r=>r.t>=cutoff);
  if(last.length<2) last = readings.slice(-20);
  if(last.length<2) return '<svg class="spark-svg"></svg>';
  const W=520,H=70,pad=6;
  const vals = last.map(r=>r.mmol);
  const minV=Math.min(...vals,3.9), maxV=Math.max(...vals,10.0);
  const yMin=minV-0.5, yMax=maxV+0.5;
  const X = i => pad + (i/(last.length-1))*(W-2*pad);
  const Y = v => pad + (H-2*pad) - ((v-yMin)/(yMax-yMin))*(H-2*pad);
  const pts = vals.map((v,i)=>[X(i),Y(v)]);
  const d = smoothSvgPath(pts);
  const len = svgPathLength(pts);
  const lastPt = pts[pts.length-1];
  const lastBand = band(last[last.length-1].mgdl);
  return `<svg class="spark-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" y1="${Y(3.9).toFixed(1)}" x2="${W}" y2="${Y(3.9).toFixed(1)}" stroke="${COLORS.target}" stroke-opacity=".25" stroke-dasharray="3 3"/>
    <line x1="0" y1="${Y(10.0).toFixed(1)}" x2="${W}" y2="${Y(10.0).toFixed(1)}" stroke="${COLORS.target}" stroke-opacity=".25" stroke-dasharray="3 3"/>
    <path d="${d}" class="draw-path" stroke-dasharray="${len.toFixed(0)}" stroke-dashoffset="${len.toFixed(0)}" fill="none" stroke="${COLORS.goldBright}" stroke-width="2" stroke-linecap="round"/>
    <circle cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="4" fill="${COLORS[lastBand]}"/>
  </svg>`;
}

function renderColorPicker(){
  const btn = document.getElementById('colorPickerBtn');
  const pop = document.getElementById('colorPopover');
  let dev = CURRENT_DEVICE_FILTER;
  if(dev==='all'){
    const distinctDevs = new Set(FULL_HISTORY.map(r=>r.dev));
    dev = distinctDevs.size===1 ? [...distinctDevs][0] : null;
  }
  if(!dev || !CAN_EDIT){ btn.style.visibility='hidden'; pop.classList.remove('open'); return; }
  btn.style.visibility='visible';
  const currentHex = deviceColorHex(dev);
  btn.innerHTML = buildSensorIconSvg(currentHex, 20, 30);
  pop.innerHTML = Object.entries(SENSOR_COLORS).map(([key,c])=>
    `<span class="color-swatch-icon ${DEVICE_COLORS[dev]===key?'selected':''}" data-key="${key}" title="${c.label}">${buildSensorIconSvg(c.hex, 24, 36)}</span>`
  ).join('');
  pop.querySelectorAll('.color-swatch-icon').forEach(sw=>{
    sw.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const key = sw.dataset.key;
      let newValue;
      if(DEVICE_COLORS[dev]===key){ delete DEVICE_COLORS[dev]; newValue = null; }
      else { DEVICE_COLORS[dev] = key; newValue = key; }
      pop.classList.remove('open');
      renderColorPicker();
      renderSensorTabs();
      if(ALL_READINGS.length) renderDaily(computeDaily(ALL_READINGS));
      if(ON_SAVE_DEVICE_COLOR) { try{ await ON_SAVE_DEVICE_COLOR(dev, newValue); }catch(err){ console.warn('Не вдалося зберегти колір', err); } }
    });
  });
}
document.getElementById('colorPickerBtn').addEventListener('click', (e)=>{
  e.stopPropagation();
  document.getElementById('colorPopover').classList.toggle('open');
});
document.addEventListener('click', ()=>{ document.getElementById('colorPopover').classList.remove('open'); });

function renderLifespanBadge(){
  const wrap = document.getElementById('lifespanBadgeWrap');
  const badge = document.getElementById('lifespanBadge');
  let dev = CURRENT_DEVICE_FILTER;
  if(dev==='all'){
    const distinctDevs = new Set(FULL_HISTORY.map(r=>r.dev));
    if(distinctDevs.size===1) dev = [...distinctDevs][0];
    else { wrap.style.display='none'; return; }
  }
  const devReadings = FULL_HISTORY.filter(r=>r.dev===dev);
  if(!devReadings.length){ wrap.style.display='none'; return; }
  const insertionT = devReadings[0].t;
  const lifespanMs = SENSOR_LIFESPAN_DAYS*86400000;
  const elapsed = nowAsDeviceEpoch() - insertionT;
  wrap.style.display = 'inline-flex';
  wrap.classList.remove('expired');
  if(elapsed < lifespanMs){
    badge.textContent = `⏳ ${formatDurationUk(lifespanMs - elapsed)} до заміни`;
  } else {
    const cycleNum = Math.floor(elapsed / lifespanMs) + 1;
    const intoCycle = elapsed % lifespanMs;
    badge.textContent = `🔄 Сенсор перезапущено (цикл ${cycleNum}) · ${formatDurationUk(lifespanMs - intoCycle)} до заміни`;
  }
}

function renderSensorComparison(){
  const card = document.getElementById('comparisonCard');
  const groups = new Map();
  for(const r of FULL_HISTORY){
    const dev = r.dev || 'unknown';
    if(!groups.has(dev)) groups.set(dev, []);
    groups.get(dev).push(r);
  }
  if(groups.size<=1){ card.style.display='none'; return; }
  card.style.display='block';
  const devices = [...groups.entries()].sort((a,b)=>a[1][0].t-b[1][0].t);
  const months=['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'];
  const fmt = t=>{ const d=new Date(t); return `${String(d.getUTCDate()).padStart(2,'0')} ${months[d.getUTCMonth()]}`; };
  document.getElementById('comparisonBody').innerHTML = devices.map(([dev,arr])=>{
    const stats = computeStats(arr);
    const hex = deviceColorHex(dev);
    const icon = hex ? buildSensorIconSvg(hex,13,20) : '';
    const days = ((arr[arr.length-1].t-arr[0].t)/86400000).toFixed(1);
    const rowClass = dev===CURRENT_DEVICE_FILTER ? 'active-row' : '';
    return `<tr class="${rowClass}">
      <td><span class="cmp-sensor">${icon}${deviceLabel(dev)}</span></td>
      <td class="mono">${fmt(arr[0].t)} – ${fmt(arr[arr.length-1].t)}</td>
      <td class="mono">${days}</td>
      <td class="mono">${stats.meanMmol.toFixed(1)}</td>
      <td class="mono">${stats.gmi.toFixed(1)}%</td>
      <td class="mono">${stats.cv.toFixed(1)}%</td>
      <td class="mono" style="color:${COLORS.target}">${stats.bandsPct.target.toFixed(1)}%</td>
      <td class="mono">${stats.gri.toFixed(1)}</td>
    </tr>`;
  }).join('');
}

function buildWeeklyTrendSvg(weekly){
  const W=1100,H=320,mL=48,mR=20,mT=20,mB=42;
  const pW=W-mL-mR, pH=H-mT-mB;
  const n = weekly.length;
  const gap = pW/n;
  const barW = Math.min(56, gap*0.5);

  const tirY = pct => mT + pH - (pct/100)*pH;
  const yMin=2, yMax=16;
  const mmolY = v => mT + pH - ((v-yMin)/(yMax-yMin))*pH;
  const months=['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'];

  let gridlines='';
  [0,25,50,75,100].forEach(pct=>{
    gridlines += `<line x1="${mL}" y1="${tirY(pct).toFixed(1)}" x2="${W-mR}" y2="${tirY(pct).toFixed(1)}" class="gridline"/>`;
    gridlines += `<text x="${mL-8}" y="${(tirY(pct)+4).toFixed(1)}" text-anchor="end" class="axis-label">${pct}%</text>`;
  });

  let bars='', labels='';
  weekly.forEach((w,i)=>{
    const cx = mL + gap*(i+0.5);
    const barColor = w.tirPct>=70? C().target : w.tirPct>=50? C().high : C().vhigh;
    const barTop = tirY(w.tirPct);
    bars += `<rect x="${(cx-barW/2).toFixed(1)}" y="${barTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${(mT+pH-barTop).toFixed(1)}" rx="4" fill="${barColor}" opacity="0.5"/>`;
    bars += `<text x="${cx.toFixed(1)}" y="${(barTop-8).toFixed(1)}" text-anchor="middle" class="axis-label" font-weight="700">${w.tirPct.toFixed(0)}%</text>`;
    const d1=new Date(w.startT), d2=new Date(w.endT);
    const lbl = d1.getUTCMonth()===d2.getUTCMonth()
      ? `${String(d1.getUTCDate()).padStart(2,'0')}–${String(d2.getUTCDate()).padStart(2,'0')} ${months[d1.getUTCMonth()]}`
      : `${String(d1.getUTCDate()).padStart(2,'0')}${months[d1.getUTCMonth()]}–${String(d2.getUTCDate()).padStart(2,'0')}${months[d2.getUTCMonth()]}`;
    labels += `<text x="${cx.toFixed(1)}" y="${H-mB+18}" text-anchor="middle" class="axis-label">${lbl}</text>`;
  });

  const linePts = weekly.map((w,i)=>[mL+gap*(i+0.5), mmolY(w.meanMmol)]);
  const linePath = smoothSvgPath(linePts);
  const len = svgPathLength(linePts);
  const drawAttrs = PRINT_MODE ? '' : `class="draw-path" stroke-dasharray="${len.toFixed(0)}" stroke-dashoffset="${len.toFixed(0)}"`;
  const dots = linePts.map(([x,y],i)=>`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${C().goldBright}"/><text x="${x.toFixed(1)}" y="${(y-11).toFixed(1)}" text-anchor="middle" class="axis-label" style="fill:${C().goldBright}">${weekly[i].meanMmol.toFixed(1)}</text>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="agp-svg" preserveAspectRatio="xMidYMid meet">
    <defs>
      <filter id="trendGlow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    ${gridlines}${bars}
    <path d="${linePath}" ${drawAttrs} fill="none" stroke="${C().goldBright}" stroke-width="2.4" stroke-linecap="round" filter="${PRINT_MODE?'':'url(#trendGlow)'}"/>
    ${dots}${labels}
  </svg>`;
}

function renderWeeklyTrend(){
  const card = document.getElementById('weeklyTrendCard');
  const weekly = computeWeeklyTrend(FULL_HISTORY);
  if(weekly.length<2){ card.style.display='none'; return; }
  card.style.display='block';
  document.getElementById('weeklyTrendChart').innerHTML = buildWeeklyTrendSvg(weekly);
}

function renderKPIs(stats){
  const grid = document.getElementById('kpiGrid');
  const cards = [
    { label:'Середній рівень глюкози', tip:null, value: stats.meanMmol, dec:1, sub:'ммоль/л',
      goal: kpiGoalHtml(stats.meanMmol<8.5, stats.meanMmol<8.5?'ціль &lt;8.5 ммоль/л':'вище цілі &lt;8.5 ммоль/л') },
    { label:'GMI (індикатор керування)', tip:'GMI (Glucose Management Indicator) — орієнтовний рівень HbA1c, розрахований із середньої глюкози CGM за цей період. Це не заміна лабораторного аналізу крові.', value: stats.gmi, dec:1, sub:'%',
      goal: kpiGoalHtml(stats.gmi<7, stats.gmi<7?'ціль &lt;7%':'вище цілі &lt;7%') },
    { label:'Варіабельність (CV)', tip:'Коефіцієнт варіації — наскільки сильно глюкоза коливається відносно середнього значення. Нижче значення означає стабільніший профіль і менший ризик різких перепадів.', value: stats.cv, dec:1, sub:'%',
      goal: kpiGoalHtml(stats.cv<=36, stats.cv<=36?'ціль ≤36%':'вище цілі ≤36%') },
    { label:'Час у цільовому діапазоні', tip:'TIR (Time in Range) — частка часу, коли глюкоза була в межах 3.9–10.0 ммоль/л. Ключовий показник контролю за міжнародними рекомендаціями ADA/ATTD.', value: stats.bandsPct.target, dec:1, sub:'%',
      goal: kpiGoalHtml(stats.bandsPct.target>70, stats.bandsPct.target>70?'ціль &gt;70%':'нижче цілі &gt;70%') },
    { label:'GRI (індекс ризику)', tip:'Glycemia Risk Index — комплексний бал 0–100 на основі часу вище й нижче цільового діапазону. Нижче значення означає менший розрахунковий ризик.', value: stats.gri, dec:1, sub:'/100',
      goal: `<div class="kpi-goal">${griZone(stats.gri)}</div>` },
  ];
  grid.innerHTML = cards.map((c,i)=>`
    <div class="kpi-card">
      <p class="kpi-label">${c.label}${c.tip?`<span class="info-icon" data-tip="${c.tip}">?</span>`:''}</p>
      <p class="kpi-value"><span class="kpi-num" id="kpiNum${i}">${PRINT_MODE?c.value.toFixed(c.dec):'0.0'}</span><span style="font-size:14px;color:var(--muted);font-weight:500;"> ${c.sub}</span></p>
      ${c.goal}
    </div>
  `).join('');
  if(!PRINT_MODE) cards.forEach((c,i)=>animateValue(document.getElementById('kpiNum'+i), c.value, c.dec, 1000));
}

function renderTIR(stats){
  const bar = document.getElementById('tirBar');
  bar.innerHTML = BAND_ORDER.map(k=>{
    const w = stats.bandsPct[k];
    const initialWidth = PRINT_MODE ? w : 0;
    return `<div class="tir-seg tir-${k}" data-w="${w}" style="width:${initialWidth}%" title="${BAND_LABEL_SHORT[k]}: ${w.toFixed(1)}%"></div>`;
  }).join('');
  if(!PRINT_MODE) growWidths(bar, '.tir-seg');
  document.getElementById('tirLegend').innerHTML = BAND_ORDER.map(k=>`
    <div class="legend-item"><span class="legend-dot" style="background:${C()[k]}"></span>${BAND_LABEL[k]}: <span class="legend-value">${stats.bandsPct[k].toFixed(1)}%</span></div>
  `).join('');
}

function computeAGPGeom(agp){
  const W=1100,H=380,mL=46,mR=14,mT=14,mB=34;
  const pW=W-mL-mR, pH=H-mT-mB;
  const n = agp.nBuckets;
  const smooth = f => smoothField(agp.buckets, f, 2);
  const p5s=smooth('p5'), p25s=smooth('p25'), p50s=smooth('p50'), p75s=smooth('p75'), p95s=smooth('p95');
  let yMin = Math.min(3, ...p5s);
  let yMax = Math.max(10, ...p95s);
  yMin = Math.max(0, Math.floor(yMin)-1);
  yMax = Math.ceil(yMax)+1;
  return {W,H,mL,mR,mT,mB,pW,pH,n,p5s,p25s,p50s,p75s,p95s,yMin,yMax};
}

function buildAGPSvg(agp){
  const g = computeAGPGeom(agp);
  const {W,H,mL,mR,mT,mB,pW,pH,n,yMin,yMax,p5s,p25s,p50s,p75s,p95s} = g;

  const X = i => mL + (i/n)*pW;
  const Y = v => mT + pH - ((v-yMin)/(yMax-yMin))*pH;
  const toPts = arr => arr.map((v,i)=>[X(i),Y(v)]);
  const p5pts=toPts(p5s), p95pts=toPts(p95s), p25pts=toPts(p25s), p75pts=toPts(p75s), p50pts=toPts(p50s);

  const outerPath = smoothSvgPath(p95pts)+' '+smoothSvgPath(p5pts.slice().reverse()).replace('M','L')+' Z';
  const innerPath = smoothSvgPath(p75pts)+' '+smoothSvgPath(p25pts.slice().reverse()).replace('M','L')+' Z';
  const medianPath = smoothSvgPath(p50pts);
  const medianLen = svgPathLength(p50pts);

  let gridlines='';
  for(let v=Math.ceil(yMin); v<=Math.floor(yMax); v+=2){
    gridlines+=`<line x1="${mL}" y1="${Y(v).toFixed(1)}" x2="${W-mR}" y2="${Y(v).toFixed(1)}" class="gridline"/>`;
    gridlines+=`<text x="${mL-8}" y="${(Y(v)+4).toFixed(1)}" class="axis-label" text-anchor="end">${v}</text>`;
  }
  const targetLines = `<line x1="${mL}" y1="${Y(3.9).toFixed(1)}" x2="${W-mR}" y2="${Y(3.9).toFixed(1)}" class="target-line"/>
    <line x1="${mL}" y1="${Y(10.0).toFixed(1)}" x2="${W-mR}" y2="${Y(10.0).toFixed(1)}" class="target-line"/>`;

  const hourLabels=['00:00','03:00','06:00','09:00','12:00','15:00','18:00','21:00','24:00'];
  let xticks='';
  for(let h=0;h<=24;h+=3){
    const bIdx = h*n/24;
    const xx = X(bIdx);
    xticks+=`<line x1="${xx.toFixed(1)}" y1="${mT}" x2="${xx.toFixed(1)}" y2="${H-mB}" class="gridline-v"/>`;
    xticks+=`<text x="${xx.toFixed(1)}" y="${H-mB+18}" class="axis-label" text-anchor="middle">${hourLabels[h/3]}</text>`;
  }

  const drawAttrs = PRINT_MODE ? '' : `class="draw-path" stroke-dasharray="${medianLen.toFixed(0)}" stroke-dashoffset="${medianLen.toFixed(0)}"`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="agp-svg" preserveAspectRatio="xMidYMid meet">
    <defs>
      <filter id="agpGlow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    ${gridlines}${xticks}
    <path d="${outerPath}" fill="${C().gold}" opacity="0.10"/>
    <path d="${innerPath}" fill="${C().gold}" opacity="0.22"/>
    ${targetLines}
    <path d="${medianPath}" ${drawAttrs} fill="none" stroke="${C().goldBright}" stroke-width="2.4" stroke-linecap="round" filter="${PRINT_MODE?'':'url(#agpGlow)'}"/>
    <line class="agp-cursor-line" id="agpCursorLine" x1="0" y1="${mT}" x2="0" y2="${H-mB}"/>
    <circle class="agp-cursor-dot" id="agpCursorDot" r="4.5"/>
  </svg>`;
}

function buildDaySparkSvg(dayReadings){
  const W=140,H=36,pad=3;
  const vals = dayReadings.map(r=>r.mmol);
  const yMin=2, yMax=16;
  const X = i => pad + (i/((dayReadings.length-1)||1))*(W-2*pad);
  const Y = v => pad + (H-2*pad) - ((Math.max(yMin,Math.min(yMax,v))-yMin)/(yMax-yMin))*(H-2*pad);
  const pts = vals.map((v,i)=>[X(i),Y(v)]);
  const d = smoothSvgPath(pts);
  const len = svgPathLength(pts);
  return `<svg class="day-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" y1="${Y(3.9).toFixed(1)}" x2="${W}" y2="${Y(3.9).toFixed(1)}" stroke="${C().target}" stroke-opacity=".2" stroke-width="1"/>
    <line x1="0" y1="${Y(10).toFixed(1)}" x2="${W}" y2="${Y(10).toFixed(1)}" stroke="${C().target}" stroke-opacity=".2" stroke-width="1"/>
    <path d="${d}" ${PRINT_MODE?'':`class="draw-path" stroke-dasharray="${len.toFixed(0)}" stroke-dashoffset="${len.toFixed(0)}"`} fill="none" stroke="${C().goldBright}" stroke-width="1.6"/>
  </svg>`;
}
function tirPillColor(tir){
  if(tir>=70) return C().target;
  if(tir>=50) return C().high;
  return C().vhigh;
}
function renderDaily(daily){
  document.getElementById('dailyNote').textContent = daily.length + ' календарних ' + dayWordUk(daily.length) + ' · клікніть на день для деталей';
  const multiSensor = CURRENT_DEVICE_FILTER==='all' && new Set(FULL_HISTORY.map(r=>r.dev)).size>1;
  document.getElementById('dailyStrip').innerHTML = daily.map(d=>{
    const pillColor = tirPillColor(d.tirPct);
    const dayDev = d.readings[0] && d.readings[0].dev;
    const devHex = multiSensor ? deviceColorHex(dayDev) : null;
    const devDot = devHex ? `<span class="day-dev-dot" style="background:${devHex}" title="${deviceLabel(dayDev)}"></span>` : '';
    return `<div class="day-card" data-key="${d.key}" tabindex="0" role="button">
      <div class="day-card-head">
        <span class="day-name">${dayNameUk(d.date)}</span>
        <span class="day-date">${String(d.date.getUTCDate()).padStart(2,'0')}.${String(d.date.getUTCMonth()+1).padStart(2,'0')}${devDot}</span>
      </div>
      ${buildDaySparkSvg(d.readings)}
      <div class="day-foot">
        <span class="day-mean">${d.meanMmol.toFixed(1)}</span>
        <span class="day-tir-pill" style="background:${pillColor}22;color:${pillColor}">${d.tirPct.toFixed(0)}%</span>
      </div>
    </div>`;
  }).join('');
}

function renderAnomalies(readings){
  const anomalies = detectAnomalies(readings);
  const gaps = detectGaps(readings);
  const el = document.getElementById('anomalyList');
  const multiSensor = new Set(readings.map(r=>r.dev)).size>1;

  let gapsHtml = '';
  if(gaps.length>0){
    const shownGaps = gaps.slice(0,10);
    gapsHtml = `
      <p class="anomaly-note" style="margin-top:18px;">Пропущені інтервали (втрата зв'язку сенсора, не рахуючи заміну сенсора): ${gaps.length}</p>
      ${shownGaps.map(g=>{
        const devTag = multiSensor ? `<span class="anomaly-dev">${deviceLabel(g.dev)}</span>` : '';
        return `<div class="anomaly-item">
          <span class="anomaly-dot anomaly-gap"></span>
          <span class="anomaly-time mono">${fmtDateTime(g.start)}</span>
          <span class="anomaly-detail">пропуск ${g.durationMin} хв (до ${fmtDateTime(g.end)})</span>
          ${devTag}
        </div>`;
      }).join('')}
      ${gaps.length>10 ? `<p class="card-note" style="margin-top:8px;">і ще ${gaps.length-10}…</p>` : ''}
    `;
  }

  if(anomalies.length===0 && gaps.length===0){
    el.innerHTML = `<p class="anomaly-ok">✓ Явних артефактів сенсора чи пропущених інтервалів не виявлено.</p>`;
    return;
  }
  if(anomalies.length===0){
    el.innerHTML = `<p class="anomaly-ok">✓ Явних артефактів сенсора (стрибків чи плато) не виявлено.</p>${gapsHtml}`;
    return;
  }
  const shown = anomalies.slice(0,15);
  const items = shown.map(a=>{
    const devTag = multiSensor ? `<span class="anomaly-dev">${deviceLabel(a.dev)}</span>` : '';
    return `
    <div class="anomaly-item">
      <span class="anomaly-dot anomaly-${a.type}"></span>
      <span class="anomaly-time mono">${fmtDateTime(a.t)}</span>
      <span class="anomaly-detail">${a.detail}</span>
      ${devTag}
    </div>
  `;}).join('');
  const more = anomalies.length>15 ? `<p class="card-note" style="margin-top:10px;">і ще ${anomalies.length-15}…</p>` : '';
  el.innerHTML = `
    <p class="anomaly-note">Знайдено ${anomalies.length} ${pluralUk(anomalies.length,['потенційну ділянку','потенційні ділянки','потенційних ділянок'])} для перевірки — це евристика (різкі стрибки понад 2.8 ммоль/л за 3 хв або плато довше 24 хв поспіль), а не медичний висновок. Реальні швидкі відновлення після гіпоглікемії теж іноді підпадають під цей критерій.</p>
    ${items}${more}${gapsHtml}
  `;
}

function exportAGPPng(){
  if(!ALL_READINGS.length) return;
  const agp = computeAGPBuckets(ALL_READINGS, 15);
  const wasPrint = PRINT_MODE;
  PRINT_MODE = true;
  const svgMarkup = buildAGPSvg(agp);
  PRINT_MODE = wasPrint;

  const wrapper = document.createElement('div');
  wrapper.style.position = 'fixed';
  wrapper.style.left = '-99999px';
  wrapper.innerHTML = svgMarkup;
  const svgEl = wrapper.querySelector('svg');
  document.body.appendChild(wrapper);
  const serialized = new XMLSerializer().serializeToString(svgEl);
  document.body.removeChild(wrapper);

  const W=1100, CH=380, padTop=64, padBottom=24;
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = W*scale; canvas.height = (CH+padTop+padBottom)*scale;
  const ctx = canvas.getContext('2d');
  if(!ctx){ alert('Браузер не підтримує створення зображення тут. Спробуйте друк (Ctrl+P) → «Зберегти як PDF».'); return; }
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0,0,W,CH+padTop+padBottom);
  ctx.fillStyle = '#17181c';
  ctx.font = '600 21px Georgia, "Times New Roman", serif';
  ctx.fillText('Glucose Intelligence — Вячеслав', 20, 30);
  ctx.fillStyle = '#5c6478';
  ctx.font = '13px Arial, sans-serif';
  ctx.fillText(document.getElementById('periodLabel').textContent + '  ·  AGP (5–95%, 25–75%, медіана)', 20, 50);

  const svgBlob = new Blob([serialized], {type:'image/svg+xml;charset=utf-8'});
  const url = URL.createObjectURL(svgBlob);
  const img = new Image(W, CH);
  img.onload = () => {
    ctx.drawImage(img, 0, padTop, W, CH);
    URL.revokeObjectURL(url);
    canvas.toBlob(blob => {
      if(!blob){ alert('Не вдалося створити зображення. Спробуйте друк (Ctrl+P) як альтернативу.'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'agp_' + new Date().toISOString().slice(0,10) + '.png';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }, 'image/png');
  };
  img.onerror = () => alert('Не вдалося створити зображення. Спробуйте друк (Ctrl+P) як альтернативу.');
  img.src = url;
}

function buildDayDetailSvg(day){
  const W=800,H=340,mL=48,mR=16,mT=16,mB=34;
  const pW=W-mL-mR, pH=H-mT-mB;
  const readings = day.readings;
  const vals = readings.map(r=>r.mmol);
  const yMin = Math.max(0, Math.floor(Math.min(3, Math.min(...vals)))-1);
  const yMax = Math.ceil(Math.max(10, Math.max(...vals)))+1;

  const X = t => {
    const d = new Date(t);
    const mins = d.getUTCHours()*60+d.getUTCMinutes();
    return mL + (mins/1440)*pW;
  };
  const Y = v => mT+pH-((v-yMin)/(yMax-yMin))*pH;

  const bandRect = (loV,hiV,color,op) => {
    const lo=Math.max(loV,yMin), hi=Math.min(hiV,yMax);
    if(hi<=lo) return '';
    return `<rect x="${mL}" y="${Y(hi).toFixed(1)}" width="${pW}" height="${(Y(lo)-Y(hi)).toFixed(1)}" fill="${color}" opacity="${op}"/>`;
  };
  let bg = '';
  bg += bandRect(yMin, 3.0, C().vlow, 0.10);
  bg += bandRect(3.0, 3.9, C().low, 0.10);
  bg += bandRect(3.9, 10.0, C().target, 0.07);
  bg += bandRect(10.0, 13.9, C().high, 0.10);
  bg += bandRect(13.9, yMax, C().vhigh, 0.10);

  const pts = readings.map(r=>[X(r.t), Y(r.mmol)]);
  const path = smoothSvgPath(pts);
  const pathLen = svgPathLength(pts);

  let grid='';
  for(let v=Math.ceil(yMin); v<=Math.floor(yMax); v+=2){
    grid += `<line x1="${mL}" y1="${Y(v).toFixed(1)}" x2="${W-mR}" y2="${Y(v).toFixed(1)}" class="gridline"/>`;
    grid += `<text x="${mL-8}" y="${(Y(v)+4).toFixed(1)}" class="axis-label" text-anchor="end">${v}</text>`;
  }
  const hourLabels=['00:00','03:00','06:00','09:00','12:00','15:00','18:00','21:00','24:00'];
  let xticks='';
  for(let h=0;h<=24;h+=3){
    const xx = mL + (h/24)*pW;
    xticks += `<line x1="${xx.toFixed(1)}" y1="${mT}" x2="${xx.toFixed(1)}" y2="${H-mB}" class="gridline-v"/>`;
    xticks += `<text x="${xx.toFixed(1)}" y="${H-mB+18}" class="axis-label" text-anchor="middle">${hourLabels[h/3]}</text>`;
  }

  let minR=readings[0], maxR=readings[0];
  for(const r of readings){ if(r.mgdl<minR.mgdl) minR=r; if(r.mgdl>maxR.mgdl) maxR=r; }
  const minPt=[X(minR.t),Y(minR.mmol)], maxPt=[X(maxR.t),Y(maxR.mmol)];

  return `<svg class="agp-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    <defs>
      <filter id="dayGlow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    ${bg}${grid}${xticks}
    <line x1="${mL}" y1="${Y(3.9).toFixed(1)}" x2="${W-mR}" y2="${Y(3.9).toFixed(1)}" class="target-line"/>
    <line x1="${mL}" y1="${Y(10.0).toFixed(1)}" x2="${W-mR}" y2="${Y(10.0).toFixed(1)}" class="target-line"/>
    <path d="${path}" class="draw-path" stroke-dasharray="${pathLen.toFixed(0)}" stroke-dashoffset="${pathLen.toFixed(0)}" fill="none" stroke="${C().goldBright}" stroke-width="2.2" stroke-linecap="round" filter="url(#dayGlow)"/>
    <circle cx="${minPt[0].toFixed(1)}" cy="${minPt[1].toFixed(1)}" r="4.5" fill="${C().vlow}"/>
    <circle cx="${maxPt[0].toFixed(1)}" cy="${maxPt[1].toFixed(1)}" r="4.5" fill="${C().vhigh}"/>
  </svg>`;
}

function openDayModal(dayKey){
  if(!ALL_READINGS.length) return;
  const daily = computeDaily(ALL_READINGS);
  const day = daily.find(d=>d.key===dayKey);
  if(!day) return;
  const mgdlVals = day.readings.map(r=>r.mgdl);
  const minMmol = mgdlToMmol(Math.min(...mgdlVals)), maxMmol = mgdlToMmol(Math.max(...mgdlVals));
  const dateStr = `${dayNameUk(day.date)}, ${String(day.date.getUTCDate()).padStart(2,'0')}.${String(day.date.getUTCMonth()+1).padStart(2,'0')}.${day.date.getUTCFullYear()}`;
  document.getElementById('dayModalBody').innerHTML = `
    <h3 class="card-title" style="margin:0 0 4px;">${dateStr}</h3>
    <p class="card-note" style="margin:0 0 16px;">${day.n} вимірів за цей день</p>
    <div class="day-modal-stats">
      <div class="day-modal-stat"><p class="kpi-label">Середнє</p><p class="kpi-value">${day.meanMmol.toFixed(1)}</p></div>
      <div class="day-modal-stat"><p class="kpi-label">Мінімум</p><p class="kpi-value" style="color:${C().vlow}">${minMmol.toFixed(1)}</p></div>
      <div class="day-modal-stat"><p class="kpi-label">Максимум</p><p class="kpi-value" style="color:${C().vhigh}">${maxMmol.toFixed(1)}</p></div>
      <div class="day-modal-stat"><p class="kpi-label">У цільовому діапазоні</p><p class="kpi-value" style="color:${C().target}">${day.tirPct.toFixed(0)}%</p></div>
    </div>
    <div style="margin-top:18px;">${buildDayDetailSvg(day)}</div>
  `;
  document.getElementById('dayModalOverlay').classList.add('open');
}
function closeDayModal(){
  document.getElementById('dayModalOverlay').classList.remove('open');
}

function wireAGPHover(agp){
  const g = computeAGPGeom(agp);
  const wrap = document.querySelector('.agp-wrap');
  const svgEl = document.querySelector('#agpChart svg');
  const tooltip = document.getElementById('agpTooltip');
  const cursorLine = document.getElementById('agpCursorLine');
  const cursorDot = document.getElementById('agpCursorDot');
  if(!wrap || !svgEl || !tooltip) return;

  const Y = v => g.mT + g.pH - ((v-g.yMin)/(g.yMax-g.yMin))*g.pH;

  function hide(){
    tooltip.classList.remove('show');
    cursorLine.style.opacity = 0;
    cursorDot.style.opacity = 0;
  }

  function onMove(clientX, clientY){
    const rect = svgEl.getBoundingClientRect();
    if(!rect.width || !rect.height) return;
    const relX = (clientX-rect.left)/rect.width;
    const svgX = relX*g.W;
    const bucketIdx = Math.round(((svgX-g.mL)/g.pW)*g.n);
    if(bucketIdx<0 || bucketIdx>=g.n) { hide(); return; }

    const p5=g.p5s[bucketIdx], p25=g.p25s[bucketIdx], p50=g.p50s[bucketIdx], p75=g.p75s[bucketIdx], p95=g.p95s[bucketIdx];
    const xPos = g.mL + (bucketIdx/g.n)*g.pW;
    const minutes = bucketIdx*agp.bucketMin;
    const hh = String(Math.floor(minutes/60)).padStart(2,'0'), mi = String(minutes%60).padStart(2,'0');

    cursorLine.setAttribute('x1', xPos.toFixed(1));
    cursorLine.setAttribute('x2', xPos.toFixed(1));
    cursorLine.style.opacity = 1;
    cursorDot.setAttribute('cx', xPos.toFixed(1));
    cursorDot.setAttribute('cy', Y(p50).toFixed(1));
    cursorDot.style.opacity = 1;

    tooltip.innerHTML = `
      <span class="t-time">${hh}:${mi}</span>
      <div class="t-row"><span>Медіана</span><span>${p50.toFixed(1)}</span></div>
      <div class="t-row"><span>25–75%</span><span>${p25.toFixed(1)}–${p75.toFixed(1)}</span></div>
      <div class="t-row"><span>5–95%</span><span>${p5.toFixed(1)}–${p95.toFixed(1)}</span></div>
    `;
    const wrapRect = wrap.getBoundingClientRect();
    const ttX = (clientX-wrapRect.left);
    const flip = ttX > wrapRect.width-190;
    tooltip.style.left = (flip ? ttX-190 : ttX+14) + 'px';
    tooltip.style.top = '8px';
    tooltip.classList.add('show');
  }

  svgEl.addEventListener('mousemove', e=>onMove(e.clientX, e.clientY));
  svgEl.addEventListener('mouseleave', hide);
  svgEl.addEventListener('touchmove', e=>{
    if(e.touches[0]) onMove(e.touches[0].clientX, e.touches[0].clientY);
  }, {passive:true});
  svgEl.addEventListener('touchend', hide);
}

function renderInsights(readings){
  const insights = computeInsights(readings);
  const multiSensor = new Set(readings.map(r=>r.dev)).size>1;
  document.getElementById('insightsNote').textContent = multiSensor
    ? 'об\'єднано по кількох сенсорах · перемкніть вкладку вгорі для одного сенсора'
    : 'автоматично виявлено в даних';
  document.getElementById('insightGrid').innerHTML = insights.map(ins=>`
    <div class="insight-card">
      <p class="insight-title">${ins.title}</p>
      <p class="insight-detail">${ins.detail.replace(/\n/g,'<br>')}</p>
    </div>
  `).join('');
}

function fmtDateTimeFull(t){
  const d = new Date(t);
  const dd=String(d.getUTCDate()).padStart(2,'0'), mm=String(d.getUTCMonth()+1).padStart(2,'0');
  const hh=String(d.getUTCHours()).padStart(2,'0'), mi=String(d.getUTCMinutes()).padStart(2,'0');
  return `${dd}.${mm} ${hh}:${mi}`;
}

function applyTableFilter(){
  let arr = ALL_READINGS.slice().reverse();
  if(currentFilter!=='all'){
    arr = arr.filter(r=>{
      const b = band(r.mgdl);
      if(currentFilter==='low') return b==='low'||b==='vlow';
      if(currentFilter==='high') return b==='high'||b==='vhigh';
      if(currentFilter==='target') return b==='target';
      return true;
    });
  }
  if(currentSearch.trim()){
    const q = currentSearch.trim().toLowerCase();
    arr = arr.filter(r=>fmtDateTimeFull(r.t).toLowerCase().includes(q) || deviceLabel(r.dev).toLowerCase().includes(q));
  }
  FILTERED = arr;
  currentPage = 0;
  renderTablePage();
}

function renderTablePage(){
  const start = currentPage*PAGE_SIZE;
  const pageItems = FILTERED.slice(start, start+PAGE_SIZE);
  document.getElementById('tableBody').innerHTML = pageItems.map(r=>{
    const b = band(r.mgdl);
    const d = new Date(r.t);
    const dateStr = `${String(d.getUTCDate()).padStart(2,'0')}.${String(d.getUTCMonth()+1).padStart(2,'0')}.${String(d.getUTCFullYear()).slice(2)}`;
    const timeStr = `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
    const devHex = deviceColorHex(r.dev);
    const sensorCell = r.dev
      ? `<span class="table-sensor">${devHex?`<span class="table-sensor-dot" style="background:${devHex}"></span>`:''}${deviceLabel(r.dev)}</span>`
      : '<span class="table-sensor muted">—</span>';
    return `<tr>
      <td>${dateStr}</td>
      <td class="mono">${timeStr}</td>
      <td class="mono">${r.mgdl}</td>
      <td><span class="val-pill"><span class="val-dot" style="background:${COLORS[b]}"></span>${r.mmol.toFixed(1)}</span></td>
      <td style="color:${COLORS[b]}">${BAND_LABEL_SHORT[b]}</td>
      <td>${sensorCell}</td>
    </tr>`;
  }).join('');
  document.getElementById('tableCount').textContent = FILTERED.length.toLocaleString('uk-UA') + ' записів';
  const totalPages = Math.max(1, Math.ceil(FILTERED.length/PAGE_SIZE));
  document.getElementById('pageInfo').textContent = `Сторінка ${currentPage+1} з ${totalPages}`;
  document.getElementById('prevPage').disabled = currentPage<=0;
  document.getElementById('nextPage').disabled = currentPage>=totalPages-1;
}

function exportCSV(){
  const rows = ['Дата;Час;мг/дл;ммоль/л;Діапазон'];
  for(const r of ALL_READINGS){
    const d = new Date(r.t);
    const dateStr = `${String(d.getUTCDate()).padStart(2,'0')}.${String(d.getUTCMonth()+1).padStart(2,'0')}.${d.getUTCFullYear()}`;
    const timeStr = `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
    const b = band(r.mgdl);
    rows.push(`${dateStr};${timeStr};${r.mgdl};${r.mmol.toFixed(2)};${BAND_LABEL_SHORT[b]}`);
  }
  const blob = new Blob(['\uFEFF'+rows.join('\n')], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'glucose_mmol_' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

let ON_SAVE_READINGS = null; // async (newlyImportedReadings) => void

function handleFile(file){
  if(!CAN_EDIT) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try{
      const text = e.target.result;
      const newReadings = parseAnytimeCSV(text);
      if(newReadings.length===0){ alert('Не вдалося знайти коректні виміри у файлі. Перевірте формат (Index;Name;Time;Glu).'); return; }
      FULL_HISTORY = mergeReadings(FULL_HISTORY, newReadings);
      CURRENT_DEVICE_FILTER = newReadings[0].dev || 'all';
      applyDeviceFilterAndRender();
      if(ON_SAVE_READINGS){
        try{ await ON_SAVE_READINGS(newReadings); }
        catch(err){ alert('Дані показано на екрані, але НЕ вдалося зберегти в хмару: ' + err.message); }
      }
    } catch(err){
      alert('Помилка обробки файлу: ' + err.message);
    }
  };
  reader.readAsText(file, 'utf-8');
}

function formatDurationUk(ms){
  const totalMinutes = Math.max(0, Math.floor(ms/60000));
  const days = Math.floor(totalMinutes/1440);
  const hours = Math.floor((totalMinutes%1440)/60);
  const mins = totalMinutes%60;
  const parts = [
    `${days} ${pluralUk(days,['день','дні','днів'])}`,
    `${hours} ${pluralUk(hours,['година','години','годин'])}`,
    `${mins} ${pluralUk(mins,['хвилина','хвилини','хвилин'])}`
  ];
  return parts.join(' ');
}

function periodLabelUk(stats, daily){
  const first = new Date(stats.first.t), last = new Date(stats.last.t);
  const months = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
  const f = `${first.getUTCDate()} ${months[first.getUTCMonth()]}`;
  const l = `${last.getUTCDate()} ${months[last.getUTCMonth()]} ${last.getUTCFullYear()}`;
  const duration = formatDurationUk(stats.last.t - stats.first.t);
  return `${duration}: ${f} – ${l}`;
}

function renderAll(readings){
  ALL_READINGS = readings;
  const stats = computeStats(readings);
  const daily = computeDaily(readings);
  const agp = computeAGPBuckets(readings, 15);
  const trend = trendArrow(readings);
  const last = readings[readings.length-1];
  const lastBand = band(last.mgdl);

  document.getElementById('periodLabel').textContent = periodLabelUk(stats, daily);
  document.getElementById('activeBadge').textContent = 'Сенсор активний ' + stats.active.toFixed(0) + '%';
  document.getElementById('sensorName').textContent = CURRENT_DEVICE_FILTER==='all'
    ? (FULL_HISTORY.length ? `${new Set(FULL_HISTORY.map(r=>r.dev||'—')).size} сенсор(и) за весь час` : 'Anytime CGM')
    : deviceLabel(CURRENT_DEVICE_FILTER);
  renderSensorTabs();
  renderColorPicker();
  renderLifespanBadge();
  renderSensorComparison();
  renderWeeklyTrend();

  document.getElementById('gaugeSvg').innerHTML = buildGaugeSvg(last.mmol, lastBand);
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      const arc = document.getElementById('gaugeArc');
      if(arc) arc.style.strokeDashoffset = arc.dataset.targetOffset;
    });
  });
  const gaugeValueEl = document.getElementById('gaugeValue');
  animateValue(gaugeValueEl, last.mmol, 1, 1000);
  gaugeValueEl.style.color = COLORS[lastBand];
  document.getElementById('gaugeTrend').innerHTML = `${trend.arrow} ${trend.label}`;
  document.getElementById('gaugeCaption').textContent = 'Останнє вимірювання: ' + fmtDateTime(last.t);

  const statusText = {vlow:'Дуже низький рівень', low:'Низький рівень', target:'У цільовому діапазоні', high:'Підвищений рівень', vhigh:'Дуже високий рівень'};
  const heroStatusEl = document.getElementById('heroStatus');
  heroStatusEl.textContent = statusText[lastBand];
  heroStatusEl.style.color = COLORS[lastBand];
  document.getElementById('heroDesc').textContent = `За ${formatDurationUk(stats.last.t-stats.first.t)} спостереження середній рівень глюкози становив ${stats.meanMmol.toFixed(1)} ммоль/л, ${stats.bandsPct.target.toFixed(0)}% часу — у цільовому діапазоні 3.9–10.0 ммоль/л.`;
  document.getElementById('sparkSvg').innerHTML = buildSparkSvg(readings);

  renderKPIs(stats);
  renderTIR(stats);
  document.getElementById('agpChart').innerHTML = buildAGPSvg(agp);
  wireAGPHover(agp);
  renderDaily(daily);
  renderInsights(readings);
  renderAnomalies(readings);


  document.getElementById('genFooter').textContent = `${stats.n.toLocaleString('uk-UA')} вимірів · створено ${new Date().toLocaleString('uk-UA',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}`;

  applyTableFilter();
}

function deviceLabel(dev){
  if(!dev) return 'Невідомий сенсор';
  return 'Anytime ' + dev;
}
function renderSensorTabs(){
  const el = document.getElementById('sensorTabs');
  if(!el) return;
  const groups = new Map();
  for(const r of FULL_HISTORY){
    const dev = r.dev || 'Невідомий';
    if(!groups.has(dev)) groups.set(dev, []);
    groups.get(dev).push(r);
  }
  if(groups.size<=1){ el.innerHTML=''; el.style.display='none'; return; }
  el.style.display='flex';
  const devices = [...groups.entries()].sort((a,b)=>a[1][0].t-b[1][0].t);
  const months=['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'];
  const fmt = t=>{ const d=new Date(t); return `${String(d.getUTCDate()).padStart(2,'0')} ${months[d.getUTCMonth()]}`; };
  let html = `<button class="sensor-tab ${CURRENT_DEVICE_FILTER==='all'?'active':''}" data-dev="all">Усі сенсори<span class="tab-sub">${FULL_HISTORY.length.toLocaleString('uk-UA')} вимірів</span></button>`;
  for(const [dev, arr] of devices){
    const range = `${fmt(arr[0].t)} – ${fmt(arr[arr.length-1].t)}`;
    const hex = deviceColorHex(dev);
    const icon = hex ? `<span class="tab-sensor-icon">${buildSensorIconSvg(hex, 12, 18)}</span>` : '';
    html += `<button class="sensor-tab ${CURRENT_DEVICE_FILTER===dev?'active':''}" data-dev="${dev}">${icon}${deviceLabel(dev)}<span class="tab-sub">${range}</span></button>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.sensor-tab').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      CURRENT_DEVICE_FILTER = btn.dataset.dev;
      applyDeviceFilterAndRender();
    });
  });
}
function applyDeviceFilterAndRender(){
  const subset = CURRENT_DEVICE_FILTER==='all' ? FULL_HISTORY : FULL_HISTORY.filter(r=>r.dev===CURRENT_DEVICE_FILTER);
  renderAll(subset.length ? subset : FULL_HISTORY);
  if(!subset.length) CURRENT_DEVICE_FILTER='all';
}

document.querySelectorAll('.filter-btn[data-filter]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.filter-btn[data-filter]').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    applyTableFilter();
  });
});
document.getElementById('searchInput').addEventListener('input', e=>{
  currentSearch = e.target.value;
  applyTableFilter();
});
document.getElementById('exportBtn').addEventListener('click', exportCSV);
document.getElementById('prevPage').addEventListener('click', ()=>{ if(currentPage>0){currentPage--; renderTablePage();} });
document.getElementById('nextPage').addEventListener('click', ()=>{
  const totalPages = Math.max(1, Math.ceil(FILTERED.length/PAGE_SIZE));
  if(currentPage<totalPages-1){currentPage++; renderTablePage();}
});

function exportBackup(){
  const payload = {
    app: 'glucose-intelligence',
    version: 1,
    exportedAt: new Date().toISOString(),
    readings: FULL_HISTORY.map(r=>[r.t, r.mgdl, r.dev||null]),
    deviceColors: DEVICE_COLORS
  };
  const blob = new Blob([JSON.stringify(payload)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'glucose_intelligence_backup_' + new Date().toISOString().slice(0,10) + '.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const COLLAPSE_KEY = 'glucose_intelligence_collapsed_v1';
function loadCollapseState(){
  try{ return JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {}; }catch(e){ return {}; }
}
function saveCollapseState(id, collapsed){
  const state = loadCollapseState();
  state[id] = collapsed;
  try{ localStorage.setItem(COLLAPSE_KEY, JSON.stringify(state)); }catch(e){}
}
function setCollapsed(bodyEl, btnEl, collapsed, animate){
  if(collapsed){
    if(animate){
      bodyEl.style.maxHeight = bodyEl.scrollHeight + 'px';
      requestAnimationFrame(()=>requestAnimationFrame(()=>{ bodyEl.style.maxHeight = '0px'; }));
    } else {
      bodyEl.style.maxHeight = '0px';
    }
    bodyEl.classList.add('collapsed');
    btnEl.classList.add('collapsed');
  } else {
    bodyEl.classList.remove('collapsed');
    btnEl.classList.remove('collapsed');
    bodyEl.style.maxHeight = bodyEl.scrollHeight + 'px';
    if(animate){
      bodyEl.addEventListener('transitionend', function h(){ bodyEl.style.maxHeight='none'; bodyEl.removeEventListener('transitionend',h); });
    } else {
      bodyEl.style.maxHeight = 'none';
    }
  }
}
function initCollapsibleCards(){
  const state = loadCollapseState();
  document.querySelectorAll('.collapse-btn').forEach(btn=>{
    const bodyEl = document.getElementById(btn.dataset.target);
    if(!bodyEl) return;
    const id = btn.dataset.target;
    const startCollapsed = !!state[id];
    setCollapsed(bodyEl, btn, startCollapsed, false);
    btn.addEventListener('click', ()=>{
      const willCollapse = !bodyEl.classList.contains('collapsed');
      setCollapsed(bodyEl, btn, willCollapse, true);
      saveCollapseState(id, willCollapse);
    });
  });
}
// re-measure open (non-collapsed) collapsible bodies after content changes, so max-height stays accurate
function refreshOpenCollapsibles(){
  document.querySelectorAll('.collapsible-body:not(.collapsed)').forEach(el=>{
    el.style.maxHeight = 'none';
  });
}

document.getElementById('printBtn').addEventListener('click', ()=>window.print());
window.addEventListener('beforeprint', ()=>{ PRINT_MODE = true; if(ALL_READINGS.length) renderAll(ALL_READINGS); });
window.addEventListener('afterprint', ()=>{ PRINT_MODE = false; if(ALL_READINGS.length) renderAll(ALL_READINGS); });

document.getElementById('pngBtn').addEventListener('click', exportAGPPng);

document.getElementById('dailyStrip').addEventListener('click', e=>{
  const card = e.target.closest('.day-card');
  if(card) openDayModal(card.dataset.key);
});
document.getElementById('dailyStrip').addEventListener('keydown', e=>{
  if(e.key==='Enter' || e.key===' '){
    const card = e.target.closest('.day-card');
    if(card){ e.preventDefault(); openDayModal(card.dataset.key); }
  }
});
document.getElementById('dayModalClose').addEventListener('click', closeDayModal);
document.getElementById('dayModalOverlay').addEventListener('click', e=>{
  if(e.target.id==='dayModalOverlay') closeDayModal();
});
document.addEventListener('keydown', e=>{
  if(e.key==='Escape') closeDayModal();
});
