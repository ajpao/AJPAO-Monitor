/* AJPAO-Monitor dashboard v2
 * LOCAL mode : fetch('/api/*')  — Flask + SQLite (LAN)
 * CLOUD mode : Firestore SDK    — Firebase Hosting (Cloud)
 */

const firebaseConfig = {
  apiKey:            "AIzaSyAGXb05vU8jYVmZGBecNCnvAOh1TDWRAXg",
  authDomain:        "ajpao-monitor.firebaseapp.com",
  projectId:         "ajpao-monitor",
  storageBucket:     "ajpao-monitor.firebasestorage.app",
  messagingSenderId: "487891341769",
  appId:             "1:487891341769:web:3e8228b373b9fc73e85818",
};

Chart.register(ChartDataLabels);

const C = {
  ok:'#00e5a0', info:'#3399ff', warn:'#ffcc00', danger:'#ff3355',
  accent:'#ff6b00', purple:'#a855f7', dim:'#7b8cae', text:'#e0eaff',
  grid:'rgba(29,47,80,.5)', panel:'#0c1424',
};

const charts = {};
let MODE = null, db = null, auth = null;
let cloudStatus = null, deviceTimer = null;

// ─── theme (dark / light) ──────────────────────────────────────────────────────

function syncChartColors(){
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim();
  C.text=g('--text'); C.dim=g('--dim'); C.ok=g('--ok'); C.info=g('--info');
  C.warn=g('--warn'); C.danger=g('--danger'); C.accent=g('--accent'); C.purple=g('--purple');
  C.panel=g('--panel');
  C.grid = (document.documentElement.getAttribute('data-theme')==='light')
    ? 'rgba(120,140,175,.28)' : 'rgba(29,47,80,.5)';
}
function applyThemeIcon(){
  const light = document.documentElement.getAttribute('data-theme')==='light';
  const btn = document.getElementById('themeBtn');
  if(btn){ btn.innerHTML = `<i data-lucide="${light?'sun':'moon'}"></i>`; if(window.lucide) lucide.createIcons(); }
}
function rerenderCharts(){
  syncChartColors();
  loadCompare();
  if(currentPanel==='system') loadDatePanel('system');
  else if(currentPanel==='monthly') loadMonthly();
  else loadDatePanel('temp');
}
function toggleTheme(){
  const light = document.documentElement.getAttribute('data-theme')==='light';
  if(light){ document.documentElement.removeAttribute('data-theme'); }
  else      { document.documentElement.setAttribute('data-theme','light'); }
  try{ localStorage.setItem('theme', light?'dark':'light'); }catch(e){}
  applyThemeIcon();
  rerenderCharts();
}

// ─── date helpers ────────────────────────────────────────────────────────────

const pad = n => String(n).padStart(2,'0');
function toDateStr(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function todayStr(){ return toDateStr(new Date()); }
function yesterdayStr(){ const d=new Date(); d.setDate(d.getDate()-1); return toDateStr(d); }
function fmtDateTH(s){
  const [y,m,day]=s.split('-');
  const months=['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  return `${+day} ${months[+m-1]} ${+y+543}`;
}
function uptimeFmt(bootTs){
  const sec = Math.floor((Date.now()/1000) - bootTs);
  const d=Math.floor(sec/86400), h=Math.floor((sec%86400)/3600), m=Math.floor((sec%3600)/60);
  return d>0 ? `${d}d ${h}h ${m}m` : h>0 ? `${h}h ${m}m` : `${m}m`;
}

// ─── chart helpers ───────────────────────────────────────────────────────────

function destroyChart(id){ if(charts[id]){ charts[id].destroy(); delete charts[id]; } }

function tempColor(v){ return v>=70?C.danger:v>=55?C.accent:v>=50?C.warn:C.info; }
function sysColor(v){ return v>=80?C.danger:v>=50?C.accent:null; }

const commonOpts = (unit,yMin,yMax) => ({
  responsive:true, maintainAspectRatio:false,
  interaction:{mode:'index',intersect:false},
  plugins:{
    legend:{display:false},
    tooltip:{callbacks:{label:ctx=>` ${ctx.parsed.y.toFixed(1)}${unit}`},
      backgroundColor:'rgba(12,20,36,.95)',borderColor:'rgba(29,47,80,.8)',borderWidth:1,
      titleColor:C.dim,bodyColor:C.text,padding:10},
    datalabels:{anchor:'end',align:'end',offset:1,color:C.dim,
      font:{size:11,weight:'bold',family:'Share Tech Mono'},
      formatter:v=>v==null?'':v.toFixed(1)},
  },
  layout:{padding:{top:18}},
  scales:{
    x:{ticks:{color:C.dim,font:{size:13,family:'Share Tech Mono'},maxRotation:0},
       grid:{color:C.grid}},
    y:{min:yMin,max:yMax,
       ticks:{color:C.dim,font:{size:13,family:'Share Tech Mono'},callback:v=>v.toFixed(0)+unit},
       grid:{color:C.grid}},
  },
});

function makeBarChart(id, labels, data, colorFn, unit, yPad=5){
  destroyChart(id);
  const el = document.getElementById(id);
  if(!el) return;
  if(!data||!data.length){ return; }
  const vals = data.filter(v=>v!=null);
  if(!vals.length) return;
  const mn=Math.min(...vals), mx=Math.max(...vals);
  const opts = commonOpts(unit, Math.max(0,mn-yPad), mx+yPad+2);
  charts[id] = new Chart(el, {
    type:'bar',
    data:{labels,datasets:[{
      data, borderRadius:4, borderSkipped:false,
      backgroundColor: data.map(v=>v==null?'transparent':colorFn(v)),
    }]},
    options:opts,
  });
}

function summaryHtml(data, unit){
  const vals = data.filter(v=>v!=null);
  if(!vals.length) return '';
  const mn=Math.min(...vals), mx=Math.max(...vals), avg=vals.reduce((a,b)=>a+b,0)/vals.length;
  return `
    <span class="sm-item"><span class="sm-lbl">MIN</span><span class="sm-min">${mn.toFixed(1)}${unit}</span></span>
    <span class="sm-item"><span class="sm-lbl">AVG</span><span class="sm-avg">${avg.toFixed(1)}${unit}</span></span>
    <span class="sm-item"><span class="sm-lbl">MAX</span><span class="sm-max">${mx.toFixed(1)}${unit}</span></span>`;
}

// ─── compare chart (today vs yesterday) ──────────────────────────────────────

function makeCompareChart(todayByHour, yestByHour){
  destroyChart('compareChart');
  const el = document.getElementById('compareChart');
  if(!el) return;

  const hours24 = Array.from({length:24},(_,i)=>`${pad(i)}:00`);
  const todayData  = hours24.map((_,i) => todayByHour[i] ?? null);
  const yestData   = hours24.map((_,i) => yestByHour[i]  ?? null);

  const todayVals = todayData.filter(v=>v!=null);
  const yestVals  = yestData.filter(v=>v!=null);
  const allVals   = [...todayVals,...yestVals];
  if(!allVals.length) return;

  const mn = Math.min(...allVals), mx = Math.max(...allVals);

  charts['compareChart'] = new Chart(el, {
    type:'bar',
    data:{
      labels:hours24,
      datasets:[
        { type:'bar', label:'วันนี้', data:todayData, order:2,
          backgroundColor:todayData.map(v=>v==null?'transparent':tempColor(v)+'cc'),
          borderRadius:3, borderSkipped:false },
        { type:'line', label:'เมื่อวาน', data:yestData, order:1,
          borderColor:'rgba(123,140,174,.55)', backgroundColor:'transparent',
          borderWidth:1.5, borderDash:[4,4],
          pointRadius:2, pointBackgroundColor:'rgba(123,140,174,.55)',
          spanGaps:true, tension:0.3, fill:false },
      ],
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{display:false},
        tooltip:{
          backgroundColor:'rgba(12,20,36,.95)',borderColor:'rgba(29,47,80,.8)',borderWidth:1,
          titleColor:C.dim,bodyColor:C.text,padding:10,
          callbacks:{label:ctx=>` ${ctx.dataset.label}: ${ctx.parsed.y!=null?ctx.parsed.y.toFixed(1)+'°C':'--'}`},
        },
        datalabels:{display:false},
      },
      layout:{padding:{top:8}},
      scales:{
        x:{ticks:{color:C.dim,font:{size:15,family:'Share Tech Mono'},maxRotation:0,maxTicksLimit:12},
           grid:{color:C.grid}},
        y:{min:Math.max(0,mn-5), max:mx+6,
           ticks:{color:C.dim,font:{size:15,family:'Share Tech Mono'},callback:v=>v+'°'},
           grid:{color:C.grid}},
      },
    },
  });

  // delta chip
  if(todayVals.length && yestVals.length){
    const tAvg = todayVals.reduce((a,b)=>a+b,0)/todayVals.length;
    const yAvg = yestVals.reduce((a,b)=>a+b,0)/yestVals.length;
    const diff = tAvg - yAvg;
    const chip = document.getElementById('deltaChip');
    chip.textContent = `${tAvg.toFixed(1)}° vs ${yAvg.toFixed(1)}° (${diff>=0?'+':''}${diff.toFixed(1)}°)`;
    chip.className = 'delta-chip ' + (diff>0.5?'up':diff<-0.5?'down':'');
  }

  // compare stats row
  if(todayVals.length){
    const tAvg = todayVals.reduce((a,b)=>a+b,0)/todayVals.length;
    const yAvg = yestVals.length ? yestVals.reduce((a,b)=>a+b,0)/yestVals.length : null;
    document.getElementById('cmpStats').innerHTML = `
      <div class="cs-item"><span class="cs-lbl"><i data-lucide="bar-chart-2"></i>วันนี้ AVG</span><span class="cs-val">${tAvg.toFixed(1)}°C</span></div>
      ${yAvg!=null?`<div class="cs-item"><span class="cs-lbl"><i data-lucide="history"></i>เมื่อวาน AVG</span><span class="cs-val">${yAvg.toFixed(1)}°C</span></div>`:''}
      <div class="cs-item"><span class="cs-lbl"><i data-lucide="arrow-down"></i>วันนี้ MIN</span><span class="cs-val ok">${Math.min(...todayVals).toFixed(1)}°C</span></div>
      <div class="cs-item"><span class="cs-lbl"><i data-lucide="arrow-up"></i>วันนี้ MAX</span><span class="cs-val danger">${Math.max(...todayVals).toFixed(1)}°C</span></div>`;
  }

  // บทวิเคราะห์แนวโน้ม (ภาษาคน)
  const ins = document.getElementById('cmpInsight');
  if(ins){
    ins.innerHTML = tempInsight(todayByHour, yestByHour);
    if(window.lucide) lucide.createIcons();
  }
}

// สร้างคำอธิบายแนวโน้มอุณหภูมิแบบอ่านง่าย
function tempInsight(todayByHour, yestByHour){
  const tHours = Object.keys(todayByHour).map(Number).filter(h=>todayByHour[h]!=null).sort((a,b)=>a-b);
  if(!tHours.length) return '';
  const tVals = tHours.map(h=>todayByHour[h]);
  const tAvg  = tVals.reduce((a,b)=>a+b,0)/tVals.length;

  const yVals = Object.values(yestByHour).filter(v=>v!=null);
  const yAvg  = yVals.length ? yVals.reduce((a,b)=>a+b,0)/yVals.length : null;

  // จุดร้อนสุด
  let maxH=tHours[0], maxV=todayByHour[maxH];
  tHours.forEach(h=>{ if(todayByHour[h]>maxV){ maxV=todayByHour[h]; maxH=h; } });

  // แนวโน้มล่าสุด (เทียบ ~3 ชม.ก่อนหน้า)
  const lastH=tHours[tHours.length-1], lastV=todayByHour[lastH];
  const refH = tHours.find(h=>h>=lastH-3) ?? tHours[0];
  const slope = lastV - todayByHour[refH];
  const span  = Math.max(1, lastH-refH);

  const L=[];
  // 1) เทียบเมื่อวาน
  if(yAvg!=null){
    const diff=tAvg-yAvg, a=Math.abs(diff);
    if(a<0.5)      L.push(['minus','',        `วันนี้เฉลี่ย <b>${tAvg.toFixed(1)}°</b> — พอๆ กับเมื่อวาน`]);
    else if(diff<0)L.push(['trending-down','ok',  `วันนี้เฉลี่ย <b>${tAvg.toFixed(1)}°</b> เย็นกว่าเมื่อวาน <b>${a.toFixed(1)}°</b>`]);
    else           L.push(['trending-up','warn',  `วันนี้เฉลี่ย <b>${tAvg.toFixed(1)}°</b> อุ่นกว่าเมื่อวาน <b>${a.toFixed(1)}°</b>`]);
  } else {
    L.push(['thermometer','', `วันนี้เฉลี่ย <b>${tAvg.toFixed(1)}°</b> (ยังไม่มีข้อมูลเมื่อวานให้เทียบ)`]);
  }
  // 2) จุดร้อนสุด
  L.push(['flame','', `ร้อนสุดวันนี้ <b>${maxV.toFixed(1)}°</b> ตอน <b>${pad(maxH)}:00</b>`]);
  // 3) แนวโน้มล่าสุด
  if(tHours.length>=2 && Math.abs(slope)>=0.4){
    if(slope<0) L.push(['arrow-down-right','ok',  `ช่วงนี้กำลัง<b>เย็นลง</b> (${slope.toFixed(1)}° ใน ~${span} ชม.)`]);
    else        L.push(['arrow-up-right','warn',  `ช่วงนี้กำลัง<b>ร้อนขึ้น</b> (+${slope.toFixed(1)}° ใน ~${span} ชม.)`]);
  } else if(tHours.length>=2){
    L.push(['minus','', `อุณหภูมิ<b>ทรงตัว</b>ในช่วงไม่กี่ชั่วโมงนี้`]);
  }
  // 4) ประเมินภาพรวม (จากจุดสูงสุด)
  if(maxV>=60)      L.push(['alert-triangle','danger', `เคยแตะจุด<b>ร้อนมาก</b> ควรเช็คการระบายความร้อน`]);
  else if(maxV>=52) L.push(['alert-circle','warn',     `เคยขึ้นระดับ<b>อุ่น</b> แต่ยังอยู่ในเกณฑ์รับได้`]);
  else              L.push(['circle-check','ok',        `อุณหภูมิอยู่ใน<b>เกณฑ์ปกติ</b>ดี`]);

  return L.map(([i,c,t])=>`<div class="ci-line ${c}"><i data-lucide="${i}"></i><span>${t}</span></div>`).join('');
}

// ─── LOCAL helpers ────────────────────────────────────────────────────────────

async function localFetchDate(date){
  return fetch(`/api/date?date=${date}`).then(r=>r.json());
}
async function localFetchMonthly(){
  const [temp, sys] = await Promise.all([
    fetch('/api/monthly').then(r=>r.json()),
    fetch('/api/system_monthly').then(r=>r.json()),
  ]);
  return {temp, sys};
}

function localToHourMap(labels, data){
  const m = {};
  labels.forEach((lbl,i)=>{ const h=parseInt(lbl); if(!isNaN(h)) m[h]=data[i]; });
  return m;
}

// ─── CLOUD helpers ────────────────────────────────────────────────────────────

const pad2 = n=>String(n).padStart(2,'0');

async function cloudFetchDate(dateStr){
  const d = new Date(dateStr+'T00:00:00');
  const nd = new Date(d); nd.setDate(nd.getDate()+1);
  const snap = await db.collection('readings').where('ts','>=',d).where('ts','<',nd).orderBy('ts').get();
  const rows = snap.docs.map(doc=>{
    const x=doc.data();
    return {h:x.ts.toDate().getHours(), temp:x.temp_c, cpu:x.cpu_pct, ram:x.ram_pct, disk:x.disk_pct};
  });
  const hourly = {};
  for(const r of rows){
    if(!hourly[r.h]) hourly[r.h]={t:[],c:[],r:[],d:[]};
    if(r.temp!=null) hourly[r.h].t.push(r.temp);
    if(r.cpu!=null)  hourly[r.h].c.push(r.cpu);
    if(r.ram!=null)  hourly[r.h].r.push(r.ram);
    if(r.disk!=null) hourly[r.h].d.push(r.disk);
  }
  const avg = a=>a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length*10)/10:null;
  const labels=[],temp=[],cpu=[],ram=[],disk=[];
  for(const h of Object.keys(hourly).map(Number).sort((a,b)=>a-b)){
    labels.push(`${pad2(h)}:00`);
    temp.push(avg(hourly[h].t)); cpu.push(avg(hourly[h].c));
    ram.push(avg(hourly[h].r));  disk.push(avg(hourly[h].d));
  }
  return {date:dateStr, labels, temp, cpu, ram, disk, count:rows.length};
}

async function cloudFetchMonthly(){
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const snap = await db.collection('readings').where('ts','>=',start).orderBy('ts').get();
  const rows = snap.docs.map(doc=>{
    const x=doc.data(), d=x.ts.toDate();
    return {day:d.getDate(), temp:x.temp_c, cpu:x.cpu_pct, ram:x.ram_pct, disk:x.disk_pct};
  });
  const buckets = {};
  for(const r of rows){
    if(!buckets[r.day]) buckets[r.day]={t:[],c:[],r:[],d:[]};
    if(r.temp!=null) buckets[r.day].t.push(r.temp);
    if(r.cpu!=null)  buckets[r.day].c.push(r.cpu);
    if(r.ram!=null)  buckets[r.day].r.push(r.ram);
    if(r.disk!=null) buckets[r.day].d.push(r.disk);
  }
  const avg = a=>a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length*10)/10:null;
  const days=Object.keys(buckets).map(Number).sort((a,b)=>a-b);
  const labels=days.map(String);
  const month=now.toLocaleDateString('th-TH',{month:'long',year:'numeric'});
  const temp=days.map(d=>avg(buckets[d].t)), cpu=days.map(d=>avg(buckets[d].c));
  const ram=days.map(d=>avg(buckets[d].r));
  return {temp:{labels,data:temp,month}, sys:{labels,cpu,ram,disk:days.map(d=>avg(buckets[d].d)),month}};
}

// ─── data fetcher (auto-select LOCAL / CLOUD) ─────────────────────────────────

async function fetchDate(date){
  return MODE==='local' ? localFetchDate(date) : cloudFetchDate(date);
}
async function fetchMonthly(){
  return MODE==='local' ? localFetchMonthly() : cloudFetchMonthly();
}

// ─── load compare (top card) ─────────────────────────────────────────────────

async function loadCompare(){
  try {
    const [td, yd] = await Promise.all([fetchDate(todayStr()), fetchDate(yesterdayStr())]);
    const todayMap={}, yestMap={};
    td.labels.forEach((lbl,i)=>{ const h=parseInt(lbl); if(!isNaN(h)) todayMap[h]=td.temp[i]; });
    yd.labels.forEach((lbl,i)=>{ const h=parseInt(lbl); if(!isNaN(h)) yestMap[h]=yd.temp[i]; });
    makeCompareChart(todayMap, yestMap);
  } catch(e){ console.error('compare error',e); }
}

// ─── load date panel ──────────────────────────────────────────────────────────

async function loadDatePanel(type){
  const dateInput = document.getElementById(type==='temp'?'tempDate':'sysDate');
  const date = dateInput.value || todayStr();
  dateInput.value = date;

  const isToday = date===todayStr(), isYest=date===yesterdayStr();
  ['today','yest'].forEach(k=>{
    const el=document.getElementById(`tq-${k}-${type}`);
    if(el) el.classList.remove('active');
  });
  if(isToday) document.getElementById(`tq-today-${type}`)?.classList.add('active');
  else if(isYest) document.getElementById(`tq-yest-${type}`)?.classList.add('active');

  const labelEl = document.getElementById(type==='temp'?'tempDateLabel':'sysDateLabel');
  if(labelEl) labelEl.textContent = isToday?'วันนี้':isYest?'เมื่อวาน':fmtDateTH(date);

  try {
    const d = await fetchDate(date);
    const count = d.count || 0;
    const countEl = document.getElementById(type==='temp'?'tempCount':'sysCount');
    if(countEl) countEl.textContent = count>0?`${count} records`:'';

    if(type==='temp'){
      const noData = document.getElementById('tempNoData');
      const canvas = document.getElementById('tempChart');
      if(!d.labels||!d.labels.length){
        noData.style.display='flex'; canvas.style.display='none';
        document.getElementById('tempSum').innerHTML=''; return;
      }
      noData.style.display='none'; canvas.style.display='block';
      makeBarChart('tempChart', d.labels, d.temp, tempColor, '°C', 5);
      document.getElementById('tempSum').innerHTML = summaryHtml(d.temp,'°C');
    } else {
      const noData = document.getElementById('sysNoData');
      const canvas = document.getElementById('cpuChart');
      if(!d.labels||!d.labels.length){
        noData.style.display='flex'; canvas.style.display='none';
        ['cpuSum','ramSum','diskSum'].forEach(id=>document.getElementById(id).innerHTML='');
        return;
      }
      noData.style.display='none'; canvas.style.display='block';
      makeBarChart('cpuChart', d.labels, d.cpu, v=>sysColor(v)||C.info, '%');
      makeBarChart('ramChart', d.labels, d.ram, v=>sysColor(v)||C.purple, '%');
      makeBarChart('diskChart',d.labels, d.disk,v=>sysColor(v)||C.warn, '%');
      document.getElementById('cpuSum').innerHTML  = summaryHtml(d.cpu,'%');
      document.getElementById('ramSum').innerHTML  = summaryHtml(d.ram,'%');
      document.getElementById('diskSum').innerHTML = summaryHtml(d.disk,'%');
    }
  } catch(e){ console.error('loadDatePanel error',e); }
}

function quickDate(type, which){
  const inputId = type==='temp'?'tempDate':'sysDate';
  document.getElementById(inputId).value = which==='today'?todayStr():yesterdayStr();
  loadDatePanel(type);
}

// ─── load monthly ─────────────────────────────────────────────────────────────

async function loadMonthly(){
  try {
    const {temp, sys} = await fetchMonthly();
    if(temp.month) document.getElementById('mTempTitle').textContent=temp.month;
    makeBarChart('mTempChart', temp.labels, temp.data, tempColor, '°C', 3);
    makeBarChart('mCpuChart',  sys.labels,  sys.cpu,   v=>sysColor(v)||C.info, '%');
    makeBarChart('mRamChart',  sys.labels,  sys.ram,   v=>sysColor(v)||C.purple, '%');
    document.getElementById('mTempSum').innerHTML = summaryHtml(temp.data,'°C');
    document.getElementById('mCpuSum').innerHTML  = summaryHtml(sys.cpu,'%');
    document.getElementById('mRamSum').innerHTML  = summaryHtml(sys.ram,'%');
  } catch(e){ console.error('monthly error',e); }
}

// ─── device tab (network / OS / processes) ─────────────────────────────────────

function setText(id,v){ const el=document.getElementById(id); if(el) el.textContent=v; }
// "Raspberry Pi 4 Model B Rev 1.2" → "Pi 4 Model B"
function shortModel(m){ return (m||'').replace(/^Raspberry\s+/i,'').replace(/\s+Rev.*$/i,'').trim() || m; }
function fmtSpeed(kbps){ return kbps>=1024 ? (kbps/1024).toFixed(1)+' MB/s' : kbps.toFixed(0)+' KB/s'; }

async function loadDevice(){
  if(MODE==='local'){
    try { renderDeviceLocal(await fetch('/api/sysinfo').then(r=>r.json())); }
    catch(e){ console.error('sysinfo error',e); }
  } else {
    renderDeviceCloud();
  }
}

function renderDeviceLocal(d){
  const o=d.os, n=d.net;
  setText('dModel',o.model); setText('dOS',o.os); setText('dKernel',o.kernel);
  setText('dHost',o.hostname); setText('dPy',o.python);
  setText('dUptime', uptimeFmt(o.boot_time));
  const net=document.getElementById('dNet');
  if(n.internet){ net.className='ir-val online';  net.innerHTML='<span class="live-dot"></span>ONLINE'; }
  else          { net.className='ir-val offline'; net.innerHTML='<span class="live-dot off"></span>OFFLINE'; }
  setText('dIP', n.ip||'--');
  document.getElementById('dIfaces').innerHTML = n.interfaces.map(i=>
    `<div class="info-row"><span class="ir-label">${i.name} ${i.up?'🟢':'⚪'}</span><span class="ir-val">${i.ip||'—'}</span></div>`
  ).join('');
  setText('dDown','↓ '+fmtSpeed(n.down_kbps));
  setText('dUp','↑ '+fmtSpeed(n.up_kbps));
  setText('dTotal',`↓ ${n.total_recv_mb} MB · ↑ ${n.total_sent_mb} MB`);
  renderProcs(d.procs);
  setText('dProcNote', (d.procs?.length||0)+' procs · live');
}

function renderProcs(procs){
  const body=document.getElementById('dProcBody');
  if(!procs||!procs.length){ body.innerHTML='<tr><td colspan="4" class="proc-empty">ไม่มีข้อมูล</td></tr>'; return; }
  body.innerHTML = procs.map(p=>{
    const cls = p.cpu>=50?'cpu-hi':p.cpu>=15?'cpu-mid':'';
    return `<tr><td class="pid">${p.pid}</td><td>${p.name}</td><td class="num ${cls}">${p.cpu.toFixed(1)}</td><td class="num">${p.mem.toFixed(1)}</td></tr>`;
  }).join('');
}

function renderDeviceCloud(){
  const x = cloudStatus || {};
  setText('dModel',x.model||'--'); setText('dOS',x.os||'--'); setText('dKernel',x.kernel||'--');
  setText('dHost',x.hostname||'--'); setText('dPy','—');
  setText('dUptime', x.uptime?uptimeFmt(x.uptime):'--');
  const net=document.getElementById('dNet'); net.textContent='—'; net.className='ir-val';
  setText('dIP', x.ip||'--');
  document.getElementById('dIfaces').innerHTML='';
  setText('dDown','—'); setText('dUp','—'); setText('dTotal','—');
  document.getElementById('dProcBody').innerHTML='<tr><td colspan="4" class="proc-empty">⚠ ดู process / speed สดได้เฉพาะตอนเปิดใน LAN</td></tr>';
  setText('dProcNote','LAN only');
}

// ─── service manager ───────────────────────────────────────────────────────────

async function loadServices(){
  const list=document.getElementById('svcList');
  if(MODE!=='local'){
    list.innerHTML='<div class="proc-empty">⚠ จัดการ service ได้เฉพาะตอนเปิดใน LAN</div>';
    setText('svcNote','LAN only'); return;
  }
  try{
    const d=await fetch('/api/services').then(r=>r.json());
    renderServices(d.services||[]);
  }catch(e){ list.innerHTML='<div class="proc-empty">โหลดไม่สำเร็จ</div>'; }
}

function renderServices(svcs){
  const list=document.getElementById('svcList');
  setText('svcNote', svcs.length+' services');
  if(!svcs.length){ list.innerHTML='<div class="proc-empty">ไม่มี service ในรายการ</div>'; return; }
  list.innerHTML=svcs.map(s=>{
    const on=s.active==='active', fail=s.active==='failed';
    const badge=fail?'fail':on?'on':'off';
    const btxt=(s.active||'?').toUpperCase();
    return `<div class="svc-row">
      <div class="svc-info">
        <div class="svc-name"><i data-lucide="box"></i>${s.name} <span class="svc-badge ${badge}">${btxt}</span></div>
        <div class="svc-desc">${s.desc||''}${s.enabled?' · '+s.enabled:''}</div>
      </div>
      <div class="svc-btns">
        <button class="svc-btn start" onclick="svcAction('${s.name}','start',this)" ${on?'disabled':''}>Start</button>
        <button class="svc-btn stop" onclick="svcAction('${s.name}','stop',this)" ${on?'':'disabled'}>Stop</button>
        <button class="svc-btn restart" onclick="svcAction('${s.name}','restart',this)">Restart</button>
      </div>
    </div>`;
  }).join('');
  if(window.lucide) lucide.createIcons();
}

async function svcAction(name, action, btn){
  const row=btn.closest('.svc-row');
  row.querySelectorAll('button').forEach(b=>b.disabled=true);
  btn.textContent='…';
  try{
    const d=await fetch(`/api/service/${name}/${action}`,{method:'POST'}).then(r=>r.json());
    if(!d.ok) alert('สั่ง '+action+' '+name+' ไม่สำเร็จ:\n'+(d.error||d.output||''));
  }catch(e){ alert('error: '+(e?.message||e)); }
  setTimeout(loadServices, 700);   // รอ systemd อัปเดตสถานะ
}

// ─── web terminal (full PTY ผ่าน WebSocket — ไม่มี timeout) ───────────────────────

let term=null, termSock=null, fitAddon=null, termInit=false;

function setupTerminal(){
  const note=document.getElementById('termNote');
  if(MODE!=='local'){
    note.textContent='⚠ ใช้ได้เฉพาะใน LAN';
    if(!termInit){
      termInit=true;
      document.getElementById('xterm').innerHTML=
        '<div class="proc-empty" style="padding:40px">Web Terminal (PTY) ใช้ได้เฉพาะตอนเปิดใน LAN<br>'
        +'(cloud เชื่อมต่อ shell ของ Pi โดยตรงไม่ได้)</div>';
    }
    return;
  }
  if(termInit){
    // กลับเข้าแท็บอีกครั้ง — เชื่อมใหม่ถ้าหลุด + จัดขนาด
    if(!termSock || termSock.readyState>1) connectTerm();
    if(fitAddon) setTimeout(()=>{ fitAddon.fit(); sendResize(); },60);
    if(term) term.focus();
    return;
  }
  termInit=true;
  term=new Terminal({fontFamily:"'Share Tech Mono', monospace", fontSize:13, cursorBlink:true,
    theme:{background:'#05080f', foreground:'#c8d6f0', cursor:'#ff6b00', selectionBackground:'#1d2f50'}});
  fitAddon=new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('xterm'));
  setTimeout(()=>fitAddon.fit(),60);
  term.onData(d=>{ if(termSock && termSock.readyState===1) termSock.send(JSON.stringify({type:'input',data:d})); });
  connectTerm();
  window.addEventListener('resize',()=>{
    if(fitAddon && document.getElementById('panel-terminal').classList.contains('active')){
      fitAddon.fit(); sendResize();
    }
  });
}

function connectTerm(){
  const proto = location.protocol==='https:'?'wss':'ws';
  termSock = new WebSocket(`${proto}://${location.host}/ws/terminal`);
  termSock.onopen    = ()=>{ sendResize(); if(term) term.focus(); };
  termSock.onmessage = e=>{ if(term) term.write(e.data); };
  termSock.onclose   = ()=>{ if(term) term.write('\r\n\x1b[31m[การเชื่อมต่อปิด — กดแท็บอื่นแล้วกลับมาเพื่อเชื่อมใหม่]\x1b[0m\r\n'); };
}

function sendResize(){
  if(termSock && termSock.readyState===1 && term)
    termSock.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
}

// ─── file transfer / dropzone (HTTP — LAN only) ──────────────────────────────────

let filesInit=false;

function setupFiles(){
  const note=document.getElementById('filesNote');
  const dz=document.getElementById('dropZone');
  if(MODE!=='local'){
    note.textContent='⚠ LAN only';
    dz.style.opacity='.5'; dz.style.pointerEvents='none';
    document.getElementById('filesBody').innerHTML='<tr><td colspan="4" class="proc-empty">รับ-ส่งไฟล์ได้เฉพาะตอนเปิดใน LAN</td></tr>';
    return;
  }
  if(!filesInit){ filesInit=true; bindDropzone(); }
  loadFiles();
}

function bindDropzone(){
  const dz=document.getElementById('dropZone'), inp=document.getElementById('fileInput');
  dz.addEventListener('click',()=>inp.click());
  inp.addEventListener('change',()=>{ if(inp.files.length) uploadFiles(inp.files); inp.value=''; });
  ['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('drag');}));
  ['dragleave','dragend'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('drag');}));
  dz.addEventListener('drop',e=>{ e.preventDefault(); dz.classList.remove('drag');
    if(e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });
}

function uploadFiles(fileList){
  const fd=new FormData();
  [...fileList].forEach(f=>fd.append('files',f));      // หลายไฟล์ ชื่อ field = "files"
  const bar=document.getElementById('upBar'), fill=document.getElementById('upBarFill');
  bar.style.display=''; fill.style.width='0';
  const xhr=new XMLHttpRequest();
  xhr.open('POST','/api/files/upload');
  xhr.upload.onprogress=e=>{ if(e.lengthComputable) fill.style.width=(e.loaded/e.total*100)+'%'; };
  xhr.onload=()=>{ fill.style.width='100%'; setTimeout(()=>bar.style.display='none',500);
    if(xhr.status===200) loadFiles(); else alert('อัปโหลดไม่สำเร็จ ('+xhr.status+')'); };
  xhr.onerror=()=>{ bar.style.display='none'; alert('อัปโหลดไม่สำเร็จ — เชื่อมต่อไม่ได้'); };
  xhr.send(fd);
}

async function loadFiles(){
  try{ renderFiles((await fetch('/api/files').then(r=>r.json())).files||[]); }
  catch(e){ document.getElementById('filesBody').innerHTML='<tr><td colspan="4" class="proc-empty">โหลดรายการไม่สำเร็จ</td></tr>'; }
}

function renderFiles(files){
  setText('filesNote', files.length+' files');
  const body=document.getElementById('filesBody');
  if(!files.length){ body.innerHTML='<tr><td colspan="4" class="proc-empty">ยังไม่มีไฟล์</td></tr>'; return; }
  body.innerHTML=files.map(f=>{
    const enc=encodeURIComponent(f.name);
    return `<tr>
      <td>${agEsc(f.name)}</td>
      <td class="num">${fmtFileSize(f.size)}</td>
      <td class="ft-time hide-sm">${fmtFileTime(f.mtime)}</td>
      <td><div class="ft-act">
        <button class="ft-btn dl" onclick="downloadFile('${enc}')"><i data-lucide="download"></i>โหลด</button>
        <button class="ft-btn del" onclick="deleteFile('${enc}')"><i data-lucide="trash-2"></i></button>
      </div></td></tr>`;
  }).join('');
  if(window.lucide) lucide.createIcons();
}

function downloadFile(enc){ window.location.href='/api/files/download/'+enc; }   // cookie ติดไปเอง

async function deleteFile(enc){
  const name=decodeURIComponent(enc);
  if(!confirm('ลบไฟล์ "'+name+'" ?')) return;
  try{
    const d=await fetch('/api/files/delete',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name})}).then(r=>r.json());
    if(d.ok) loadFiles(); else alert('ลบไม่สำเร็จ');
  }catch(e){ alert('ลบไม่สำเร็จ'); }
}

function fmtFileSize(b){
  if(b>=1073741824) return (b/1073741824).toFixed(1)+' GB';
  if(b>=1048576)    return (b/1048576).toFixed(1)+' MB';
  if(b>=1024)       return (b/1024).toFixed(1)+' KB';
  return b+' B';
}
function fmtFileTime(sec){
  const d=new Date(sec*1000);
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── notes (เขียนโน้ต / แปะลิงก์) — LAN ผ่าน API / Cloud ผ่าน Firestore realtime ──

let notesData=[], notesEditing=null, notesUnsub=null;

function setupNotes(){
  const ta=document.getElementById('noteNew');
  if(ta && !ta._bound){ ta._bound=true; ta.addEventListener('keydown',e=>{ if((e.ctrlKey||e.metaKey)&&e.key==='Enter') noteAdd(); }); }
  if(MODE==='local'){ loadNotes(); }
  else if(!notesUnsub){                    // cloud: realtime onSnapshot
    notesUnsub = db.collection('notes').onSnapshot(snap=>{
      const arr=[]; snap.forEach(d=>{ const x=d.data(); arr.push({id:d.id,title:x.title||'',text:x.text||'',updated:x.updated||0}); });
      arr.sort((a,b)=>b.updated-a.updated); renderNotes(arr);
    }, err=>console.error('notes snapshot',err));
  }
}

async function loadNotes(){
  try{ renderNotes((await fetch('/api/notes').then(r=>r.json())).notes||[]); }
  catch(e){ document.getElementById('notesList').innerHTML='<div class="note-empty">โหลดไม่สำเร็จ</div>'; }
}

function renderNotes(arr){ notesData=arr; drawNotes(); }

function noteLinkify(text){
  return agEsc(text)
    .replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/\n/g,'<br>');
}
function noteTime(sec){ if(!sec) return ''; const d=new Date(sec*1000);
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }

function drawNotes(){
  const list=document.getElementById('notesList');
  setText('notesNote', notesData.length+' notes');
  if(!notesData.length){ list.innerHTML='<div class="note-empty">ยังไม่มีโน้ต — เขียนหรือแปะลิงก์ด้านบนได้เลย</div>'; return; }
  list.innerHTML=notesData.map(n=>{
    if(n.id===notesEditing){
      return `<div class="note-card">
        <input class="note-title-input" id="noteEditTitle-${n.id}" value="${agEsc(n.title||'')}" placeholder="หัวข้อ (ไม่ใส่ก็ได้)">
        <textarea class="note-input" id="noteEdit-${n.id}" style="width:100%">${agEsc(n.text)}</textarea>
        <div class="note-foot"><span class="note-time">กำลังแก้ไข</span>
          <div class="note-acts">
            <button class="note-btn save" onclick="noteSave('${n.id}')"><i data-lucide="check"></i>บันทึก</button>
            <button class="note-btn" onclick="noteCancelEdit()"><i data-lucide="x"></i></button>
          </div></div></div>`;
    }
    const titleHtml = n.title ? `<div class="note-title"><i data-lucide="bookmark"></i>${agEsc(n.title)}</div>` : '';
    return `<div class="note-card">
      ${titleHtml}
      <div class="note-text">${noteLinkify(n.text)}</div>
      <div class="note-foot"><span class="note-time">${noteTime(n.updated)}</span>
        <div class="note-acts">
          <button class="note-btn edit" onclick="noteEdit('${n.id}')"><i data-lucide="pencil"></i>แก้ไข</button>
          <button class="note-btn del" onclick="noteDelete('${n.id}')"><i data-lucide="trash-2"></i></button>
        </div></div></div>`;
  }).join('');
  if(window.lucide) lucide.createIcons();
}

function noteEdit(id){ notesEditing=id; drawNotes(); }
function noteCancelEdit(){ notesEditing=null; drawNotes(); }

async function noteAdd(){
  const ta=document.getElementById('noteNew'); const text=ta.value.trim();
  const ti=document.getElementById('noteNewTitle'); const title=ti.value.trim();
  if(!text && !title) return;
  ta.value=''; ti.value='';
  if(MODE==='local'){ await fetch('/api/notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,text})}); loadNotes(); }
  else { const t=Math.floor(Date.now()/1000); await db.collection('notes').add({title,text,updated:t,created:t}); }
}

async function noteSave(id){
  const text=document.getElementById('noteEdit-'+id).value.trim();
  const title=(document.getElementById('noteEditTitle-'+id)?.value||'').trim();
  notesEditing=null;
  if(MODE==='local'){ await fetch('/api/notes/'+id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,text})}); loadNotes(); }
  else { await db.collection('notes').doc(id).set({title,text,updated:Math.floor(Date.now()/1000)},{merge:true}); }
}

async function noteDelete(id){
  if(!confirm('ลบโน้ตนี้?')) return;
  if(MODE==='local'){ await fetch('/api/notes/'+id+'/delete',{method:'POST'}); loadNotes(); }
  else { await db.collection('notes').doc(id).delete(); }
}

// ─── status cards ─────────────────────────────────────────────────────────────

function updateCards(d){
  if(!d) return;
  const tc = d.temp>=70?C.danger:d.temp>=55?C.accent:d.temp>=50?C.warn:C.info;
  const tempEl = document.getElementById('sTemp');
  tempEl.textContent = d.temp.toFixed(1)+'°';
  tempEl.style.color = tc;
  document.querySelector('.sc-temp .sc-bar').style.background = tc;
  const st = d.temp>=70?'🔥 ร้อนมาก!':d.temp>=55?'⚠️ อุ่น':d.temp>=50?'🟡 เริ่มอุ่น':'✅ ปกติ';
  document.getElementById('sTempSub').textContent = st;

  const cpuC = d.cpu>=80?C.danger:d.cpu>=50?C.accent:C.info;
  document.getElementById('sCpu').textContent = d.cpu.toFixed(1)+'%';
  document.getElementById('sCpu').style.color = cpuC;
  document.querySelector('.sc-cpu .sc-bar').style.background = cpuC;

  const ramC = d.ram>=80?C.danger:d.ram>=60?C.accent:C.purple;
  document.getElementById('sRam').textContent = d.ram.toFixed(1)+'%';
  document.getElementById('sRam').style.color = ramC;
  document.querySelector('.sc-ram .sc-bar').style.background = ramC;
  document.getElementById('sRamSub').textContent = `ว่าง ${d.ram_free_mb} MB`;

  const diskC = d.disk>=90?C.danger:d.disk>=70?C.accent:C.warn;
  document.getElementById('sDisk').textContent = d.disk.toFixed(1)+'%';
  document.getElementById('sDisk').style.color = diskC;
  document.querySelector('.sc-disk .sc-bar').style.background = diskC;
  document.getElementById('sDiskSub').textContent = `ว่าง ${d.disk_free_gb} GB`;

  if(d.uptime) document.getElementById('iUptime').textContent = uptimeFmt(d.uptime);
  if(d.model)    setText('iModel', shortModel(d.model));
  if(d.hostname) setText('iHostname', d.hostname);
  if(d.ip)       setText('iIP', d.ip);
  if(d.down_kbps!=null || d.up_kbps!=null)
    setText('iSpeed', `↓ ${fmtSpeed(d.down_kbps||0)} · ↑ ${fmtSpeed(d.up_kbps||0)}`);
  const now = new Date();
  document.getElementById('iLastSeen').textContent =
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// ─── AdGuard widget ─────────────────────────────────────────────────────────────

let agProtection=false, agEverSeen=false, agLoaded=false, currentPanel='temp';

// การ์ด AdGuard โชว์เฉพาะหน้า dashboard (แท็บ "อุณหภูมิ")
function applyAdguardVisibility(){
  document.getElementById('adguardCard').style.display = (currentPanel==='temp') ? '' : 'none';
}

// สลับ 3 สถานะของการ์ด: skeleton (กำลังโหลด) / data (มีข้อมูล) / offline (ติดต่อไม่ได้)
function setAgState(which){
  const sk=document.getElementById('agSkeleton');
  const body=document.getElementById('agBody');
  const off=document.getElementById('agOffline');
  if(sk)   sk.style.display   = which==='skeleton' ? '' : 'none';
  if(body) body.style.display = which==='data'     ? '' : 'none';
  if(off)  off.style.display  = which==='offline'  ? 'flex' : 'none';
}

function updateAdguard(ag){
  agLoaded = true;
  applyAdguardVisibility();

  if(!ag){                                  // ติดต่อ AdGuard ไม่ได้ / Offline → ซ่อน skeleton แสดงเตือน
    setAgState('offline');
    document.getElementById('agDot').className='ag-dot off';
    setText('agStatusText','OFFLINE');
    if(window.lucide) lucide.createIcons();
    return;
  }

  agEverSeen=true;
  setAgState('data');                       // มีข้อมูลแล้ว → ซ่อน skeleton แสดงข้อมูลจริง
  const total   = ag.dns_queries || 0;
  const blocked = ag.blocked_filtering || 0;
  const rate    = total>0 ? (blocked/total*100) : 0;   // Block Rate = (blocked / total) × 100
  setText('agTotal',   total.toLocaleString());
  setText('agBlocked', blocked.toLocaleString());
  setText('agRate',    rate.toFixed(1)+'%');

  agProtection = !!ag.protection_enabled;
  const st = document.getElementById('agState');
  st.innerHTML = agProtection
    ? '<i data-lucide="shield-check"></i>Active'
    : '<i data-lucide="pause-circle"></i>Paused';
  st.className = 'ag-protect-state '+(agProtection?'active':'paused');
  document.getElementById('agDot').className = 'ag-dot '+(agProtection?'on':'off');
  setText('agStatusText', agProtection ? 'Protection ON' : 'Protection OFF');
  document.getElementById('agToggleBtn').innerHTML =
    agProtection ? '<i data-lucide="power"></i>Disable' : '<i data-lucide="power"></i>Enable';
  renderAgTops(ag);
  if(window.lucide) lucide.createIcons();
}

function agEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function renderAgTop(id, arr, key){
  const el=document.getElementById(id);
  if(!el) return;
  if(!arr || !arr.length){ el.innerHTML='<div class="ag-top-empty">No data available</div>'; return; }
  el.innerHTML = arr.map((it,i)=>{
    const name=agEsc(it[key]||'-'), count=(it.count||0).toLocaleString();
    return `<div class="ag-top-row"><span class="ag-top-rank">${i+1}</span>`
      +`<span class="ag-top-name" title="${name}">${name}</span>`
      +`<span class="ag-top-count">${count}</span></div>`;
  }).join('');
}

function renderAgTops(ag){
  renderAgTop('agTopBlocked', ag.top_blocked, 'domain');
  renderAgTop('agTopQueries', ag.top_queries, 'domain');
  renderAgTop('agTopClients', ag.top_clients, 'client');
}

// เปิด/ปิด protection — LAN ยิง API ตรง / Cloud เขียน command doc (ต้อง login Google)
async function agControl(enabled, duration){
  if(MODE==='local'){
    try{
      const d=await fetch('/api/adguard/protection',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({enabled, duration:duration||0})}).then(r=>r.json());
      if(!d.ok){ alert('AdGuard: '+(d.error||'ทำคำสั่งไม่สำเร็จ')); return; }
      if(d.adguard) updateAdguard(d.adguard);
    }catch(e){ alert('error: '+(e?.message||e)); }
  } else {
    try{
      let user=auth.currentUser;
      if(!user){ const c=await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); user=c.user; }
      await db.collection('commands').doc('adguard').set({
        enabled, duration:duration||0,
        requested_at:firebase.firestore.FieldValue.serverTimestamp(),
        requested_by:user.email||user.uid, handled:false,
      });
      alert('ส่งคำสั่งแล้ว — Pi จะอัปเดตภายใน ~15 วินาที');
    }catch(e){ alert('error: '+(e?.message||e)); }
  }
}
function agToggle(){ agControl(!agProtection, 0); }
function agPause5(){ agControl(false, 300000); }   // ปิดชั่วคราว 5 นาที

// ─── panel switcher ───────────────────────────────────────────────────────────

const panelLoaded = {};

function switchPanel(name, btn){
  document.querySelectorAll('.sn-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.s-panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('panel-'+name).classList.add('active');

  currentPanel = name;
  applyAdguardVisibility();   // โชว์ AdGuard เฉพาะแท็บ "อุณหภูมิ"

  if(deviceTimer){ clearInterval(deviceTimer); deviceTimer=null; }

  if(!panelLoaded[name]){
    panelLoaded[name]=true;
    if(name==='temp') loadDatePanel('temp');
    else if(name==='system') loadDatePanel('system');
    else if(name==='monthly') loadMonthly();
    else if(name==='device'){ loadDevice(); loadServices(); }
    else if(name==='terminal') setupTerminal();
    else if(name==='files') setupFiles();
    else if(name==='notes') setupNotes();
  } else if(name==='device'){
    loadDevice(); loadServices();
  } else if(name==='files'){
    setupFiles();
  } else if(name==='notes'){
    setupNotes();
  }

  if(name==='device' && MODE==='local'){
    deviceTimer = setInterval(loadDevice, 5000);   // refresh speed/processes สด
  }
  if(name==='terminal' && MODE==='local'){
    const t=document.getElementById('termIn'); if(t && !t.disabled) t.focus();
  }
}

// ─── reboot ────────────────────────────────────────────────────────────────────

let pendingAction = 'reboot';

const POWER = {
  reboot:   { icon:'⚠️',  title:'ยืนยัน Reboot?',  btn:'ยืนยัน Reboot',
              subLocal:'Raspberry Pi จะ Restart และใช้เวลาประมาณ 1-2 นาทีกว่าจะกลับมา',
              subCloud:'ต้อง login ก่อนถึงจะสั่ง Reboot ได้ — Pi จะ Restart และใช้เวลา 1-2 นาที' },
  shutdown: { icon:'⏻',   title:'ยืนยัน Shutdown?', btn:'ยืนยัน Shutdown',
              subLocal:'Raspberry Pi จะปิดเครื่อง — ต้องไปกดเปิดที่เครื่องเองถึงจะกลับมา ⚠️',
              subCloud:'ต้อง login ก่อนถึงจะสั่ง Shutdown ได้ — Pi จะปิดเครื่อง (ต้องเปิดเองที่เครื่อง)' },
};

function confirmPower(action){
  pendingAction = action;
  const p = POWER[action];
  document.getElementById('modalIcon').textContent = p.icon;
  document.getElementById('modalTitle').textContent = p.title;
  document.getElementById('modalConfirm').textContent = p.btn;
  document.getElementById('rebootMsg').textContent = MODE==='cloud' ? p.subCloud : p.subLocal;
  document.getElementById('rebootModal').classList.add('open');
}
function closeModal(){ document.getElementById('rebootModal').classList.remove('open'); }
document.getElementById('rebootModal').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeModal(); });

async function doPower(){
  closeModal();
  const action = pendingAction;
  const btn = document.getElementById(action==='shutdown'?'shutdownBtn':'rebootBtn');
  const orig = btn.innerHTML;
  btn.textContent = '… '+action; btn.disabled = true;
  try {
    if(MODE==='local'){
      await fetch('/api/'+action,{method:'POST'});
    } else {
      let user = auth.currentUser;
      if(!user){
        const cred = await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
        user = cred.user;
      }
      await db.collection('commands').doc(action).set({
        requested_at: firebase.firestore.FieldValue.serverTimestamp(),
        requested_by: user.email||user.uid, handled:false,
      });
    }
  } catch(e){
    alert('สั่ง '+action+' ไม่สำเร็จ: '+(e?.message||e));
    btn.innerHTML = orig; btn.disabled = false;
  }
}

// ─── init ─────────────────────────────────────────────────────────────────────

async function detectMode(){
  try {
    const r = await fetch('/api/ping',{cache:'no-store'});
    if(r.ok){
      const d = await r.json();
      if(d && d.local) return 'local';
    }
  } catch(e){}
  return 'cloud';
}

// ─── login gate (LAN) ──────────────────────────────────────────────────────────

function showLogin(){
  const g = document.getElementById('loginGate');
  g.style.display = 'flex';
  const pw = document.getElementById('loginPw');
  pw.focus();
  pw.onkeydown = e => { if(e.key==='Enter') doLogin(); };
}
function hideLogin(){ document.getElementById('loginGate').style.display='none'; }

async function doLogin(){
  const pw  = document.getElementById('loginPw').value;
  const err = document.getElementById('loginErr');
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; err.textContent = '';
  try {
    const r = await fetch('/api/login',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:pw}),
    });
    if(r.ok){ hideLogin(); startLocal(); }
    else { const d=await r.json().catch(()=>({})); err.textContent=d.error||'เข้าสู่ระบบไม่สำเร็จ'; btn.disabled=false; }
  } catch(e){ err.textContent='เชื่อมต่อไม่ได้'; btn.disabled=false; }
}

async function doLogout(){
  if(MODE==='cloud' && auth){ try{ await auth.signOut(); }catch(e){} location.reload(); return; }
  try { await fetch('/api/logout',{method:'POST'}); } catch(e){}
  location.reload();
}

// ─── login gate (Cloud — Google sign-in) ─────────────────────────────────────────

function showCloudLogin(){ document.getElementById('cloudGate').style.display='flex'; }
function hideCloudLogin(){ document.getElementById('cloudGate').style.display='none'; }
async function doGoogleLogin(){
  try { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
  catch(e){ document.getElementById('cloudErr').textContent = e?.message || 'ลงชื่อเข้าใช้ไม่สำเร็จ'; }
}

// ─── start (per mode) ──────────────────────────────────────────────────────────

function startLocal(){
  document.getElementById('logoutBtn').style.display = 'inline-flex';
  const pollStatus = async () => {
    try {
      const d = await fetch('/api/status').then(r=>r.json());
      updateCards(d);
      updateAdguard(d.adguard);
    } catch(e){}
  };
  pollStatus();
  setInterval(pollStatus, 10000);
  startDashboard();
}

let cloudStarted = false;

function startCloud(){
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  auth = firebase.auth();
  // บังคับ login Google ก่อนใช้งาน cloud
  auth.onAuthStateChanged(user=>{
    if(user){ hideCloudLogin(); startCloudData(); }
    else { showCloudLogin(); }
  });
}

function startCloudData(){
  document.getElementById('logoutBtn').style.display = 'inline-flex';
  if(cloudStarted) return;       // กัน onAuthStateChanged ยิงซ้ำ
  cloudStarted = true;
  db.collection('status').doc('latest').onSnapshot(doc=>{
    if(!doc.exists) return;
    const x=doc.data();
    cloudStatus = x;
    updateCards({
      temp:x.temp_c, cpu:x.cpu_pct, ram:x.ram_pct, disk:x.disk_pct,
      ram_free_mb:x.ram_free_mb, disk_free_gb:x.disk_free_gb, uptime:x.uptime,
      model:x.model, hostname:x.hostname, ip:x.ip,
      down_kbps:x.down_kbps, up_kbps:x.up_kbps,
    });
    updateAdguard(x.adguard);
    if(document.getElementById('panel-device').classList.contains('active') && MODE==='cloud')
      renderDeviceCloud();
  });
  startDashboard();
}

function startDashboard(){
  applyAdguardVisibility();            // โชว์การ์ด AdGuard (skeleton) ทันทีระหว่างรอข้อมูล
  loadCompare();
  loadDatePanel('temp');
  panelLoaded['temp'] = true;
  setInterval(loadCompare, 300000);   // refresh compare ทุก 5 นาที
}

async function init(){
  syncChartColors();
  applyThemeIcon();
  MODE = await detectMode();
  const badge = document.getElementById('modeBadge');
  badge.textContent = MODE==='local'?'🏠 LAN':'☁️ Cloud';
  badge.className = 'mode-badge '+MODE;
  document.getElementById('iMode').textContent = MODE==='local'?'LAN / Flask':'Cloud / Firestore';

  const today = todayStr();
  ['tempDate','sysDate'].forEach(id=>{ const el=document.getElementById(id); el.value=today; el.max=today; });

  if(MODE==='local'){
    let me = {authed:true, auth_required:false};
    try { me = await fetch('/api/me').then(r=>r.json()); } catch(e){}
    if(me.auth_required && !me.authed){ showLogin(); return; }   // รอ login ก่อน
    startLocal();
  } else {
    startCloud();
  }
}

// clock
setInterval(()=>{
  const n=new Date();
  document.getElementById('hTime').textContent =
    `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
},1000);

init();
