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
        x:{ticks:{color:C.dim,font:{size:12,family:'Share Tech Mono'},maxRotation:0,maxTicksLimit:12},
           grid:{color:C.grid}},
        y:{min:Math.max(0,mn-5), max:mx+6,
           ticks:{color:C.dim,font:{size:12,family:'Share Tech Mono'},callback:v=>v+'°'},
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
      <div class="cs-item"><span class="cs-lbl">วันนี้ AVG</span><span class="cs-val">${tAvg.toFixed(1)}°C</span></div>
      ${yAvg!=null?`<div class="cs-item"><span class="cs-lbl">เมื่อวาน AVG</span><span class="cs-val">${yAvg.toFixed(1)}°C</span></div>`:''}
      <div class="cs-item"><span class="cs-lbl">วันนี้ MAX</span><span class="cs-val danger">${Math.max(...todayVals).toFixed(1)}°C</span></div>
      <div class="cs-item"><span class="cs-lbl">วันนี้ MIN</span><span class="cs-val ok">${Math.min(...todayVals).toFixed(1)}°C</span></div>`;
  }
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
  const now = new Date();
  document.getElementById('iLastSeen').textContent =
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// ─── panel switcher ───────────────────────────────────────────────────────────

const panelLoaded = {};

function switchPanel(name, btn){
  document.querySelectorAll('.sn-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.s-panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('panel-'+name).classList.add('active');
  if(!panelLoaded[name]){
    panelLoaded[name]=true;
    if(name==='temp') loadDatePanel('temp');
    else if(name==='system') loadDatePanel('system');
    else if(name==='monthly') loadMonthly();
  }
}

// ─── reboot ────────────────────────────────────────────────────────────────────

function confirmReboot(){
  document.getElementById('rebootMsg').textContent = MODE==='cloud'
    ? 'ต้อง login ก่อนถึงจะสั่ง Reboot ได้ — Pi จะ Restart และใช้เวลา 1-2 นาที'
    : 'Raspberry Pi จะ Restart และใช้เวลาประมาณ 1-2 นาทีกว่าจะกลับมา';
  document.getElementById('rebootModal').classList.add('open');
}
function closeModal(){ document.getElementById('rebootModal').classList.remove('open'); }
document.getElementById('rebootModal').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeModal(); });

async function doReboot(){
  closeModal();
  const btn = document.getElementById('rebootBtn');
  btn.textContent='↺ ...'; btn.disabled=true;
  try {
    if(MODE==='local'){
      await fetch('/api/reboot',{method:'POST'});
    } else {
      let user = auth.currentUser;
      if(!user){
        const cred = await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
        user = cred.user;
      }
      await db.collection('commands').doc('reboot').set({
        requested_at: firebase.firestore.FieldValue.serverTimestamp(),
        requested_by: user.email||user.uid, handled:false,
      });
    }
  } catch(e){
    alert('สั่ง Reboot ไม่สำเร็จ: '+(e?.message||e));
    btn.textContent='↺ REBOOT'; btn.disabled=false;
  }
}

// ─── init ─────────────────────────────────────────────────────────────────────

async function detectMode(){
  try {
    const r = await fetch('/api/status',{cache:'no-store'});
    if(r.ok && (r.headers.get('content-type')||'').includes('application/json')){
      const d = await r.json();
      if(typeof d.temp==='number') return 'local';
    }
  } catch(e){}
  return 'cloud';
}

async function init(){
  MODE = await detectMode();
  const badge = document.getElementById('modeBadge');
  badge.textContent = MODE==='local'?'🏠 LAN':'☁️ Cloud';
  badge.className = 'mode-badge '+MODE;
  document.getElementById('iMode').textContent = MODE==='local'?'LAN / Flask':'Cloud / Firestore';

  // max date for pickers
  const today = todayStr();
  ['tempDate','sysDate'].forEach(id=>{
    const el=document.getElementById(id);
    el.value=today; el.max=today;
  });

  if(MODE==='local'){
    const pollStatus = async () => {
      try { updateCards(await fetch('/api/status').then(r=>r.json())); } catch(e){}
    };
    await pollStatus();
    setInterval(pollStatus, 10000);
  } else {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    auth = firebase.auth();
    db.collection('status').doc('latest').onSnapshot(doc=>{
      if(!doc.exists) return;
      const x=doc.data();
      updateCards({
        temp:x.temp_c, cpu:x.cpu_pct, ram:x.ram_pct, disk:x.disk_pct,
        ram_free_mb:x.ram_free_mb, disk_free_gb:x.disk_free_gb, uptime:x.uptime,
      });
    });
  }

  loadCompare();
  loadDatePanel('temp');
  panelLoaded['temp'] = true;

  // refresh compare every 5 min
  setInterval(loadCompare, 300000);
}

// clock
setInterval(()=>{
  const n=new Date();
  document.getElementById('hTime').textContent =
    `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
},1000);

init();
