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

// ─── UI settings (theme / สี / ฟอนต์ / ขนาด) ─────────────────────────────────────

const NUM_FONTS = {
  jetbrains:"'JetBrains Mono',ui-monospace,monospace",
  plexmono: "'IBM Plex Mono',ui-monospace,monospace",
  sharetech:"'Share Tech Mono',ui-monospace,monospace",
  orbitron: "'Orbitron',ui-monospace,monospace",
  oxanium:  "'Oxanium',ui-monospace,monospace",
  chakra:   "'Chakra Petch','Noto Sans Thai',monospace",
  rajdhani: "'Rajdhani','Noto Sans Thai',sans-serif",
  teko:     "'Teko','Noto Sans Thai',sans-serif",
  space:    "'Space Grotesk','Noto Sans Thai',sans-serif",
  inter:    "'Inter','Noto Sans Thai',sans-serif",
};
const UI_FONTS = {
  inter:   "'Inter','Noto Sans Thai',ui-sans-serif,system-ui,sans-serif",
  plexsans:"'IBM Plex Sans','Noto Sans Thai',ui-sans-serif,sans-serif",
  roboto:  "'Roboto','Noto Sans Thai',ui-sans-serif,sans-serif",
  poppins: "'Poppins','Noto Sans Thai',ui-sans-serif,sans-serif",
  manrope: "'Manrope','Noto Sans Thai',ui-sans-serif,sans-serif",
  outfit:  "'Outfit','Noto Sans Thai',ui-sans-serif,sans-serif",
  system:  "ui-sans-serif,system-ui,'Noto Sans Thai',sans-serif",
};
const ACCENTS = ['#ff6b00','#3399ff','#00c170','#a855f7','#ec4899','#ff3355','#14b8a6','#eab308'];
// ── 10 ธีม (id ตรงกับ [data-theme="…"] ใน CSS) — bg/ac/tx ใช้วาด preview ในหน้า settings ──
const THEMES = [
  { id:'cyber',     name:'Cyber Tech',      bg:'#0b1422', ac:'#00e5ff', tx:'#d8f1ff' },
  { id:'clean',     name:'Clean Modern',    bg:'#ffffff', ac:'#6366f1', tx:'#1f2937' },
  { id:'minimal',   name:'Minimalist',      bg:'#ffffff', ac:'#111111', tx:'#141414' },
  { id:'matrix',    name:'Midnight Matrix', bg:'#040904', ac:'#00ff66', tx:'#5cff8f' },
  { id:'solarized', name:'Solarized',       bg:'#fdf6e3', ac:'#268bd2', tx:'#586e75' },
  { id:'retro',     name:'Retro Arcade',    bg:'#270f45', ac:'#ff2e88', tx:'#ffe600' },
  { id:'nordic',    name:'Nordic Frost',    bg:'#ffffff', ac:'#5e81ac', tx:'#2e3440' },
  { id:'glass',     name:'Glassmorphism',   bg:'#241b46', ac:'#a78bfa', tx:'#f3f0ff' },
  { id:'ocean',     name:'Deep Ocean',      bg:'#0c2840', ac:'#ff7e5f', tx:'#e8f4ff' },
  { id:'obsidian',  name:'Luxury Obsidian', bg:'#181715', ac:'#d4af37', tx:'#ece6d8' },
  { id:'superblack',name:'Super Black OLED', bg:'#000000', ac:'#0a84ff', tx:'#f5f5f7' },
  { id:'liquidglass',name:'Liquid Glass',   bg:'#eaf0fb', ac:'#0a84ff', tx:'#1c1c2e' },
  { id:'liquidglassdark',name:'Liquid Glass Dark', bg:'#0b1020', ac:'#0a84ff', tx:'#f2f5fb' },
  { id:'liquidglassblack',name:'Liquid Glass Black', bg:'#0a0a0c', ac:'#0a84ff', tx:'#f4f4f6' },
];
const THEME_IDS = THEMES.map(t=>t.id);
const LIGHT_THEMES = new Set(['clean','minimal','solarized','nordic','liquidglass']);
const UI_DEFAULT = { theme:'liquidglassblack', scale:23.5, numFont:'oxanium', accent:'#e3c4c4', uiFont:'manrope', bgFx:false, anim:true, gfPage:false, btnStyle:'liquid-glass-dark' };

// 10 สไตล์ปุ่ม/เมนู (+ default = ดีไซน์ปัจจุบัน)
const BTN_STYLES = [
  { id:'default',      name:'Default' },
  { id:'cyber-neon',   name:'Cyber Neon' },
  { id:'rounded-soft', name:'Rounded Soft' },
  { id:'flat-minimal', name:'Flat Minimal' },
  { id:'retro-8bit',   name:'Retro 8-Bit' },
  { id:'glass-frost',  name:'Glass Frost' },
  { id:'industrial',   name:'Industrial' },
  { id:'luxury-gold',  name:'Luxury Gold' },
  { id:'skeuo-3d',     name:'Skeuomorphic 3D' },
  { id:'nordic-split', name:'Nordic Split' },
  { id:'cyber-glitch', name:'Cyberpunk Glitch' },
  { id:'liquid-glass', name:'Liquid Glass' },
  { id:'liquid-glass-dark', name:'Liquid Glass Dark' },
  { id:'liquid-glass-black', name:'Liquid Glass Black' },
];
const BTN_STYLE_IDS = BTN_STYLES.map(s=>s.id);

// แปลงค่าเก่า (dark/light) → ชื่อธีมใหม่
function migrateTheme(s){
  if(!s) return s;
  if(s.theme==='dark'){ s.theme='cyber'; if(s.accent==='#ff6b00') s.accent=''; }
  else if(s.theme==='light'){ s.theme='clean'; if(s.accent==='#ff6b00') s.accent=''; }
  else if(s.theme && !THEME_IDS.includes(s.theme)) s.theme='cyber';
  return s;
}
let UI = loadLocalSettings();

function loadLocalSettings(){
  try{ const s=JSON.parse(localStorage.getItem('ui_settings')||'null'); if(s) return Object.assign({},UI_DEFAULT,migrateTheme(s)); }catch(e){}
  const t=localStorage.getItem('theme'); return Object.assign({},UI_DEFAULT, migrateTheme(t?{theme:t}:{}));
}
function saveLocalSettings(){ try{ localStorage.setItem('ui_settings', JSON.stringify(UI)); }catch(e){} }

function applySettings(){
  const r=document.documentElement;
  r.setAttribute('data-theme', THEME_IDS.includes(UI.theme)?UI.theme:'cyber');
  r.style.fontSize=(UI.scale||23.5)+'px';
  const uiF = UI_FONTS[UI.uiFont]||UI_FONTS.inter;
  r.style.setProperty('--font-display', NUM_FONTS[UI.numFont]||NUM_FONTS.jetbrains);
  r.style.setProperty('--font-sans', uiF);
  r.style.setProperty('--font-mono', uiF);   // ฟอนต์อังกฤษคุมทั้ง label/ค่า (ที่ใช้ --font-mono) ด้วย
  // accent ว่าง = ใช้สี accent ประจำธีม (CSS), ถ้าผู้ใช้เลือกเอง = override
  if(UI.accent) r.style.setProperty('--accent', UI.accent); else r.style.removeProperty('--accent');
  r.classList.toggle('no-bg', UI.bgFx===false);
  r.classList.toggle('no-anim', UI.anim===false);
  const nav=document.getElementById('navGrafana');
  if(nav) nav.style.display = (UI.gfPage===false) ? 'none' : '';
  r.setAttribute('data-btnstyle', BTN_STYLE_IDS.includes(UI.btnStyle)?UI.btnStyle:'default');
  requestAnimationFrame(syncTopbarH);   // ความสูง topbar เปลี่ยนตาม scale → อัปเดต sticky-top ของเมนู
}

// วัดความสูง topbar จริง → ใช้เป็น top ของแถบเมนู sticky (กันขอบทับ topbar)
function syncTopbarH(){
  const tb=document.querySelector('.topbar');
  if(tb) document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight+'px');
}
window.addEventListener('resize', syncTopbarH);
window.addEventListener('load', syncTopbarH);

function syncChartColors(){
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim();
  C.text=g('--text'); C.dim=g('--dim'); C.ok=g('--ok'); C.info=g('--info');
  C.warn=g('--warn'); C.danger=g('--danger'); C.accent=g('--accent'); C.purple=g('--purple');
  C.panel=g('--panel');
  C.grid = LIGHT_THEMES.has(UI.theme) ? 'rgba(120,140,175,.28)' : 'rgba(255,255,255,.06)';
}
function applyThemeIcon(){
  const light = LIGHT_THEMES.has(UI.theme);
  const btn = document.getElementById('themeBtn');
  if(btn){ btn.innerHTML = `<i data-lucide="${light?'sun':'moon'}"></i>`; if(window.lucide) lucide.createIcons(); }
}
function rerenderCharts(){
  syncChartColors();
  if(typeof loadCompare==='function') loadCompare();
  if(typeof loadDash24==='function') loadDash24();
  if(currentPanel==='system'){ loadUsageCompare(); loadDatePanel('system'); }
  else if(currentPanel==='monthly'){ loadMonthlyCompare(); loadMonthly(); }
  else if(currentPanel==='temp') loadDatePanel('temp');
  else if(currentPanel==='history') loadHistory(histRange);
  else if(currentPanel==='grafana') gfRerender();
}

// เรียกเมื่อ settings เปลี่ยน — apply + บันทึก (local + cloud) + วาดกราฟใหม่
function commitSettings(){ applySettings(); applyThemeIcon(); saveLocalSettings(); syncChartColors(); rerenderCharts(); saveCloudSettings(); }

// custom accent (input type=color): ลากแล้ว preview เบา ๆ ไม่ rebuild picker (กัน native picker รีเซ็ต)
function accentLive(val){
  UI.accent = val;
  document.documentElement.style.setProperty('--accent', val);
  syncChartColors();
  const sw=document.getElementById('setAccent');
  if(sw) sw.querySelectorAll('.set-sw').forEach(el=>el.classList.remove('on'));   // ไฮไลต์ swatch โดยไม่แตะ input
}
function accentCommit(val){ setUI('accent', val); }   // ปล่อยแล้วค่อย commit เต็ม (save + render + cloud)

// ปุ่ม sun/moon บน topbar — สลับเร็วระหว่างธีมสว่าง/มืด (เก็บธีมล่าสุดแต่ละโหมด)
let _lastDark = LIGHT_THEMES.has(UI.theme)?'cyber':UI.theme;
let _lastLight = LIGHT_THEMES.has(UI.theme)?UI.theme:'clean';
function toggleTheme(){
  if(LIGHT_THEMES.has(UI.theme)){ _lastLight=UI.theme; UI.theme=_lastDark; }
  else { _lastDark=UI.theme; UI.theme=_lastLight; }
  UI.accent=''; commitSettings(); renderSettingsControls();
}
function setUI(key, val){
  UI[key]=val;
  if(key==='theme'){ UI.accent=''; if(LIGHT_THEMES.has(val)) _lastLight=val; else _lastDark=val; }
  if(key==='scale') document.getElementById('setScaleVal').textContent=val+'px';
  if(key==='gfPage' && val===false && currentPanel==='grafana'){
    const btn=document.querySelector('.sn-btn[onclick*="\'temp\'"]'); if(btn) switchPanel('temp', btn);
  }
  commitSettings(); renderSettingsControls();
}
function resetSettings(){ UI=Object.assign({},UI_DEFAULT); commitSettings(); renderSettingsControls(); }

function openSettings(){ renderSettingsControls(); loadSecurity(); document.getElementById('settingsModal').classList.add('open'); }
function closeSettings(){ document.getElementById('settingsModal').classList.remove('open'); }

function renderSettingsControls(){
  const tg=document.getElementById('setTheme');
  if(tg){ tg.innerHTML = THEMES.map(t=>
    `<div class="theme-sw${t.id===UI.theme?' on':''}" title="${t.name}" onclick="setUI('theme','${t.id}')">
       <div class="theme-prev" style="background:${t.bg}"><i style="background:${t.ac}"></i><i style="background:${t.tx}"></i></div>
       <div class="theme-name">${t.name}</div>
     </div>`).join(''); }
  document.querySelectorAll('#setFont button').forEach(b=>b.classList.toggle('on', b.dataset.v===UI.numFont));
  document.querySelectorAll('#setUiFont button').forEach(b=>b.classList.toggle('on', b.dataset.v===UI.uiFont));
  document.querySelectorAll('#setBgFx button').forEach(b=>b.classList.toggle('on', (b.dataset.v==='on')===(UI.bgFx!==false)));
  document.querySelectorAll('#setAnim button').forEach(b=>b.classList.toggle('on', (b.dataset.v==='on')===(UI.anim!==false)));
  document.querySelectorAll('#setGfPage button').forEach(b=>b.classList.toggle('on', (b.dataset.v==='on')===(UI.gfPage!==false)));
  const bs=document.getElementById('setBtnStyle');
  if(bs){ bs.innerHTML = BTN_STYLES.map(s=>`<button data-v="${s.id}" onclick="setUI('btnStyle','${s.id}')">${s.name}</button>`).join('');
    bs.querySelectorAll('button').forEach(b=>b.classList.toggle('on', b.dataset.v===(UI.btnStyle||'default'))); }
  const sc=document.getElementById('setScale'); if(sc){ sc.value=UI.scale; document.getElementById('setScaleVal').textContent=UI.scale+'px'; }
  const sw=document.getElementById('setAccent');
  if(sw){ sw.innerHTML=
      `<div class="set-sw${!UI.accent?' on':''}" style="background:conic-gradient(#00e5ff,#6366f1,#00ff66,#ff2e88,#ff7e5f,#d4af37,#00e5ff);outline:1px dashed var(--dim);outline-offset:-3px" title="สี accent ของธีม" onclick="setUI('accent','')"></div>`
    + ACCENTS.map(c=>`<div class="set-sw${c===UI.accent?' on':''}" style="background:${c}" onclick="setUI('accent','${c}')"></div>`).join('')
    + `<label class="set-sw" style="background:conic-gradient(red,orange,yellow,lime,cyan,blue,magenta,red);display:inline-flex;align-items:center;justify-content:center" title="เลือกเอง"><input type="color" value="${UI.accent||'#ff6b00'}" style="opacity:0;width:100%;height:100%;cursor:pointer" oninput="accentLive(this.value)" onchange="accentCommit(this.value)"></label>`; }
  const note=document.getElementById('setSyncNote'); if(note) note.textContent = (MODE==='cloud'?'sync: cloud':'sync: LAN→cloud');
}

// cloud sync (เหมือน notes)
async function fetchCloudSettings(){
  try{
    if(MODE==='local') return (await fetch('/api/settings').then(r=>r.json())).settings||null;
    if(db){ const d=await db.collection('settings').doc('ui').get(); return d.exists?d.data():null; }
  }catch(e){}
  return null;
}
async function saveCloudSettings(){
  try{
    if(MODE==='local') await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(UI)});
    else if(db) await db.collection('settings').doc('ui').set(UI,{merge:true});
  }catch(e){}
}
async function syncCloudSettings(){
  const cs=await fetchCloudSettings();
  if(cs && Object.keys(cs).length){
    UI=Object.assign({},UI_DEFAULT,cs);
    applySettings(); applyThemeIcon(); saveLocalSettings(); syncChartColors(); rerenderCharts(); renderSettingsControls();
  }
}

applySettings();   // ใช้ค่าจาก localStorage ทันที (เผื่อ head script พลาด)

// ─── generic modal (confirm / prompt) + toast — แทน confirm()/prompt()/alert() ────

function uiModal({title='ยืนยัน', msg='', icon='⚠️', input=false, value='', confirmText='ยืนยัน', danger=true, buttons=null, wide=false}={}){
  if(!buttons) buttons=[
    {label:confirmText, val:'__ok',     cls:'modal-confirm'+(danger?'':' accent')},
    {label:'ยกเลิก',    val:'__cancel', cls:'modal-cancel'},
  ];
  return new Promise(resolve=>{
    const modal=document.getElementById('uiModal');
    document.getElementById('uiModalIcon').textContent=icon;
    document.getElementById('uiModalTitle').textContent=title;
    document.getElementById('uiModalMsg').innerHTML=msg;
    const inp=document.getElementById('uiModalInput');
    if(input){ inp.style.display=''; inp.value=value; } else inp.style.display='none';
    modal.querySelector('.modal-box').classList.toggle('wide', input||wide);
    const wrap=document.getElementById('uiModalBtns'); wrap.innerHTML='';
    const finish=(val)=>{
      modal.classList.remove('open'); modal.onclick=inp.onkeydown=null; document.removeEventListener('keydown',onKey);
      resolve(val==='__ok' ? (input?inp.value:true) : val==='__cancel' ? (input?null:false) : val);
    };
    buttons.forEach(b=>{ const el=document.createElement('button'); el.className=b.cls||'modal-cancel';
      el.innerHTML=(b.icon?`<i data-lucide="${b.icon}"></i>`:'')+`<span>${b.label}</span>`;
      el.onclick=()=>finish(b.val); wrap.appendChild(el); });
    if(window.lucide) lucide.createIcons();
    const onKey=e=>{ if(e.key==='Escape') finish('__cancel'); };
    modal.classList.add('open');
    if(input) setTimeout(()=>{ inp.focus(); inp.select(); },60);
    modal.onclick=e=>{ if(e.target===modal) finish('__cancel'); };
    inp.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); finish('__ok'); } };
    document.addEventListener('keydown',onKey);
  });
}
function showConfirm(o){ return uiModal({...o, input:false}); }
async function showPrompt(o){ const v=await uiModal({...o, input:true, danger:false}); return v==null?null:String(v).trim(); }
function showChoice(o){ return uiModal(o); }   // o.buttons = [{label,val,cls}]

function toast(msg, type='info', ms=3200){
  const wrap=document.getElementById('toastWrap'); if(!wrap) return;
  const icon = type==='ok'?'circle-check' : type==='error'?'circle-x' : 'info';
  const el=document.createElement('div');
  el.className='toast '+type;
  el.innerHTML=`<i data-lucide="${icon}"></i><span></span>`;
  el.querySelector('span').textContent=msg;
  wrap.appendChild(el);
  if(window.lucide) lucide.createIcons();
  setTimeout(()=>{ el.classList.add('out'); setTimeout(()=>el.remove(),250); }, ms);
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

// จัดแกน Y ให้ min/max หาร step ลงตัว → เส้น grid ห่างเท่ากันทุกช่อง
function niceY(mn, mx, pad){
  let lo=Math.max(0, mn-pad), hi=mx+pad;
  if(hi-lo<1) hi=lo+1;
  const step=[1,2,5,10,20,25,50,100].find(s=> (hi-lo)/s <= 5) || 100;
  lo=Math.floor(lo/step)*step;
  hi=Math.ceil(hi/step)*step;
  if(hi<=lo) hi=lo+step;
  return {min:lo, max:hi, step};
}

const commonOpts = (unit,ny) => ({
  responsive:true, maintainAspectRatio:false,
  interaction:{mode:'index',intersect:false},
  plugins:{
    legend:{display:false},
    tooltip:{callbacks:{label:ctx=>` ${ctx.parsed.y.toFixed(1)}${unit}`},
      backgroundColor:'rgba(12,20,36,.95)',borderColor:'rgba(29,47,80,.8)',borderWidth:1,
      titleColor:C.dim,bodyColor:C.text,padding:10},
    datalabels:{anchor:'end',align:'end',offset:1,color:C.dim,
      font:{size:11,weight:'bold',family:'Inter'},
      formatter:v=>v==null?'':v.toFixed(1)},
  },
  layout:{padding:{top:18}},
  scales:{
    x:{ticks:{color:C.dim,font:{size:13,family:'Inter'},maxRotation:0},
       grid:{color:C.grid}},
    y:{min:ny.min,max:ny.max,
       ticks:{color:C.dim,font:{size:13,family:'Inter'},stepSize:ny.step,callback:v=>Math.round(v)+unit},
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
  const opts = commonOpts(unit, niceY(mn, mx, yPad));
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
        x:{ticks:{color:C.dim,font:{size:15,family:'Inter'},maxRotation:0,maxTicksLimit:12},
           grid:{color:C.grid}},
        y:{...niceY(mn,mx,3),
           ticks:{color:C.dim,font:{size:15,family:'Inter'},stepSize:niceY(mn,mx,3).step,callback:v=>Math.round(v)+'°'},
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
  } else {
    L.push(['minus','', `ข้อมูลวันนี้ยัง<b>มีน้อย</b> รอเก็บเพิ่ม`]);
  }
  // 4) ประเมินภาพรวม (จากจุดสูงสุด)
  if(maxV>=60)      L.push(['alert-triangle','danger', `เคยแตะจุด<b>ร้อนมาก</b> ควรเช็คการระบายความร้อน`]);
  else if(maxV>=52) L.push(['alert-circle','warn',     `เคยขึ้นระดับ<b>อุ่น</b> แต่ยังอยู่ในเกณฑ์รับได้`]);
  else              L.push(['circle-check','ok',        `อุณหภูมิอยู่ใน<b>เกณฑ์ปกติ</b>ดี`]);

  return L.map(([i,c,t])=>`<div class="ci-line ${c}"><i data-lucide="${i}"></i><span>${t}</span></div>`).join('');
}

// ─── generic compare card (ใช้กับ USAGE + MONTHLY) ───────────────────────────────

function buildCompareCard(cfg, todayBy, yestBy){
  destroyChart(cfg.canvas);
  const el=document.getElementById(cfg.canvas); if(!el) return;
  const todayData=cfg.idx.map(i=> todayBy[i] ?? null);
  const yestData =cfg.idx.map(i=> yestBy[i]  ?? null);
  const tv=todayData.filter(v=>v!=null), yv=yestData.filter(v=>v!=null);
  const all=[...tv,...yv];
  const statsEl=document.getElementById(cfg.statsId), insEl=document.getElementById(cfg.insightId), deltaEl=document.getElementById(cfg.deltaId);
  if(!all.length){ if(statsEl)statsEl.innerHTML=''; if(insEl)insEl.innerHTML=''; if(deltaEl)deltaEl.textContent='— vs —'; return; }
  const mn=Math.min(...all), mx=Math.max(...all);
  charts[cfg.canvas]=new Chart(el,{type:'bar',data:{labels:cfg.labels,datasets:[
    {type:'bar',label:cfg.todayLabel,data:todayData,order:2,borderRadius:3,borderSkipped:false,
      backgroundColor:todayData.map(v=>v==null?'transparent':cfg.barColor(v))},
    {type:'line',label:cfg.yestLabel,data:yestData,order:1,borderColor:'rgba(123,140,174,.55)',backgroundColor:'transparent',
      borderWidth:1.5,borderDash:[4,4],pointRadius:2,pointBackgroundColor:'rgba(123,140,174,.55)',spanGaps:true,tension:0.3,fill:false},
  ]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
    plugins:{legend:{display:false},
      tooltip:{backgroundColor:'rgba(12,20,36,.95)',borderColor:'rgba(29,47,80,.8)',borderWidth:1,titleColor:C.dim,bodyColor:C.text,padding:10,
        callbacks:{label:ctx=>` ${ctx.dataset.label}: ${ctx.parsed.y!=null?ctx.parsed.y.toFixed(1)+cfg.unit:'--'}`}},
      datalabels:{display:false}},
    layout:{padding:{top:8}},
    scales:{x:{ticks:{color:C.dim,font:{size:15,family:'Inter'},maxRotation:0,maxTicksLimit:12},grid:{color:C.grid}},
      y:{...niceY(mn,mx,3),ticks:{color:C.dim,font:{size:15,family:'Inter'},stepSize:niceY(mn,mx,3).step,callback:v=>Math.round(v)+cfg.axis},grid:{color:C.grid}}}}});
  if(deltaEl && tv.length && yv.length){
    const tAvg=tv.reduce((a,b)=>a+b,0)/tv.length, yAvg=yv.reduce((a,b)=>a+b,0)/yv.length, diff=tAvg-yAvg;
    deltaEl.textContent=`${tAvg.toFixed(1)}${cfg.axis} vs ${yAvg.toFixed(1)}${cfg.axis} (${diff>=0?'+':''}${diff.toFixed(1)}${cfg.axis})`;
    deltaEl.className='delta-chip '+(diff>0.5?'up':diff<-0.5?'down':'');
  }
  if(statsEl && tv.length){
    const tAvg=tv.reduce((a,b)=>a+b,0)/tv.length, yAvg=yv.length?yv.reduce((a,b)=>a+b,0)/yv.length:null;
    statsEl.innerHTML=`
      <div class="cs-item"><span class="cs-lbl"><i data-lucide="bar-chart-2"></i>${cfg.todayWord} AVG</span><span class="cs-val">${tAvg.toFixed(1)}${cfg.unit}</span></div>
      ${yAvg!=null?`<div class="cs-item"><span class="cs-lbl"><i data-lucide="history"></i>${cfg.yestWord} AVG</span><span class="cs-val">${yAvg.toFixed(1)}${cfg.unit}</span></div>`:''}
      <div class="cs-item"><span class="cs-lbl"><i data-lucide="arrow-down"></i>${cfg.todayWord} MIN</span><span class="cs-val ok">${Math.min(...tv).toFixed(1)}${cfg.unit}</span></div>
      <div class="cs-item"><span class="cs-lbl"><i data-lucide="arrow-up"></i>${cfg.todayWord} MAX</span><span class="cs-val danger">${Math.max(...tv).toFixed(1)}${cfg.unit}</span></div>`;
  }
  if(insEl){ insEl.innerHTML=compareInsight(cfg, todayBy, yestBy); if(window.lucide) lucide.createIcons(); }
}

function compareInsight(cfg, todayBy, yestBy){
  const ci=cfg.ins;
  const tk=Object.keys(todayBy).map(Number).filter(k=>todayBy[k]!=null).sort((a,b)=>a-b);
  if(!tk.length) return '';
  const tVals=tk.map(k=>todayBy[k]); const tAvg=tVals.reduce((a,b)=>a+b,0)/tVals.length;
  const yVals=Object.values(yestBy).filter(v=>v!=null); const yAvg=yVals.length?yVals.reduce((a,b)=>a+b,0)/yVals.length:null;
  let maxK=tk[0],maxV=todayBy[maxK]; tk.forEach(k=>{ if(todayBy[k]>maxV){maxV=todayBy[k];maxK=k;} });
  const lastK=tk[tk.length-1], lastV=todayBy[lastK];
  const refK=tk.find(k=>k>=lastK-3)??tk[0]; const slope=lastV-todayBy[refK]; const span=Math.max(1,lastK-refK);
  const L=[];
  if(yAvg!=null){
    const diff=tAvg-yAvg, a=Math.abs(diff);
    if(a<0.5)       L.push(['minus','',`${cfg.todayWord}เฉลี่ย <b>${tAvg.toFixed(1)}${ci.unit}</b> — พอๆ กับ${cfg.yestWord}`]);
    else if(diff<0) L.push(['trending-down',ci.lowerCls,`${cfg.todayWord}เฉลี่ย <b>${tAvg.toFixed(1)}${ci.unit}</b> ${ci.lowerWord}${cfg.yestWord} <b>${a.toFixed(1)}${ci.unit}</b>`]);
    else            L.push(['trending-up',ci.higherCls,`${cfg.todayWord}เฉลี่ย <b>${tAvg.toFixed(1)}${ci.unit}</b> ${ci.higherWord}${cfg.yestWord} <b>${a.toFixed(1)}${ci.unit}</b>`]);
  } else {
    L.push([ci.avgIcon,'',`${cfg.todayWord}เฉลี่ย <b>${tAvg.toFixed(1)}${ci.unit}</b> (ยังไม่มีข้อมูล${cfg.yestWord}ให้เทียบ)`]);
  }
  L.push([ci.peakIcon,'',`${ci.peakWord} <b>${maxV.toFixed(1)}${ci.unit}</b> ${ci.xFmt(maxK)}`]);
  if(tk.length>=2 && Math.abs(slope)>=0.4){
    if(slope<0) L.push(['arrow-down-right',ci.lowerCls,`ช่วงท้ายกำลัง<b>${ci.downWord}</b> (${slope.toFixed(1)}${ci.unit} ใน ~${span} ${ci.trendUnit})`]);
    else        L.push(['arrow-up-right',ci.higherCls,`ช่วงท้ายกำลัง<b>${ci.upWord}</b> (+${slope.toFixed(1)}${ci.unit} ใน ~${span} ${ci.trendUnit})`]);
  } else if(tk.length>=2){
    L.push(['minus','',`ค่อนข้าง<b>ทรงตัว</b>`]);
  } else {
    L.push(['minus','',`ข้อมูลยัง<b>มีน้อย</b> รอเก็บเพิ่ม`]);
  }
  L.push(ci.assess(maxV));
  return L.map(([i,c,t])=>`<div class="ci-line ${c}"><i data-lucide="${i}"></i><span>${t}</span></div>`).join('');
}

// factory สร้าง config การ์ด compare (hour=วันนี้/เมื่อวาน, day=เดือนนี้/เดือนก่อน)
function mkCmpCfg(prefix, span, metric, colorKey){
  const isHour=span==='hour', isTemp=metric==='temp';
  const today=isHour?'วันนี้':'เดือนนี้', yest=isHour?'เมื่อวาน':'เดือนก่อน';
  const xFmt=isHour?(k=>`ตอน <b>${pad(k)}:00</b>`):(k=>`วันที่ <b>${k}</b>`);
  const trendUnit=isHour?'ชม.':'วัน';
  const ins=isTemp?{
    unit:'°',lowerWord:'เย็นกว่า',higherWord:'ร้อนกว่า',lowerCls:'ok',higherCls:'warn',
    avgIcon:'thermometer',peakWord:'ร้อนสุด',peakIcon:'flame',xFmt,upWord:'ร้อนขึ้น',downWord:'เย็นลง',trendUnit,
    assess:mx=> mx>=60?['alert-triangle','danger','เคยแตะ<b>ร้อนมาก</b> ควรเช็คระบายความร้อน']:mx>=52?['alert-circle','warn','เคยขึ้นระดับ<b>อุ่น</b> แต่ยังรับได้']:['circle-check','ok','อุณหภูมิอยู่ใน<b>เกณฑ์ปกติ</b>'],
  }:{
    unit:'%',lowerWord:'ต่ำกว่า',higherWord:'สูงกว่า',lowerCls:'ok',higherCls:'warn',
    avgIcon:'activity',peakWord:'ใช้งานสูงสุด',peakIcon:'activity',xFmt,upWord:'สูงขึ้น',downWord:'ลดลง',trendUnit,
    assess:mx=> mx>=90?['alert-triangle','danger','เคยพีคเกือบ<b>เต็ม</b> ระวังงานหนัก']:mx>=60?['alert-circle','warn','เคยขึ้นระดับ<b>ใช้งานสูง</b> แต่ยังโอเค']:['circle-check','ok','การใช้งานอยู่ใน<b>เกณฑ์ปกติ</b>'],
  };
  return {
    canvas:prefix+'Chart', deltaId:prefix+'Delta', statsId:prefix+'Stats', insightId:prefix+'Insight',
    idx:isHour?Array.from({length:24},(_,i)=>i):Array.from({length:31},(_,i)=>i+1),
    labels:isHour?Array.from({length:24},(_,i)=>`${pad(i)}:00`):Array.from({length:31},(_,i)=>String(i+1)),
    unit:isTemp?'°C':'%', axis:isTemp?'°':'%',
    barColor:isTemp?(v=>tempColor(v)+'cc'):(v=>(v>=80?C.danger:v>=50?C.accent:C[colorKey])+'cc'),
    todayLabel:today, yestLabel:yest, todayWord:today, yestWord:yest, ins,
  };
}

const U_CPU =mkCmpCfg('uCpu','hour','usage','info'),  U_RAM =mkCmpCfg('uRam','hour','usage','purple'),  U_DISK =mkCmpCfg('uDisk','hour','usage','warn');
const MC_TEMP=mkCmpCfg('mcTemp','day','temp'), MC_CPU=mkCmpCfg('mcCpu','day','usage','info'), MC_RAM=mkCmpCfg('mcRam','day','usage','purple'), MC_DISK=mkCmpCfg('mcDisk','day','usage','warn');

const hourMap = (labels,arr)=>{ const m={}; (labels||[]).forEach((l,i)=>{ const h=parseInt(l); if(!isNaN(h)) m[h]=arr?.[i]; }); return m; };

// month helpers
function ymStr(offset){ const d=new Date(); d.setDate(1); d.setMonth(d.getMonth()+offset); return `${d.getFullYear()}-${pad(d.getMonth()+1)}`; }

async function fetchMonthTemp(m){ return MODE==='local' ? localFetchMonthTemp(m) : cloudFetchMonthTemp(m); }
async function localFetchMonthTemp(m){
  const d=await fetch(`/api/monthly?month=${m}`).then(r=>r.json());
  const by={}; (d.labels||[]).forEach((lbl,i)=>{ by[parseInt(lbl)]=d.data[i]; }); return by;
}
async function cloudFetchMonthTemp(m){
  const start=new Date(m+'-01T00:00:00'); const end=new Date(start); end.setMonth(end.getMonth()+1);
  const snap=await db.collection('readings').where('ts','>=',start).where('ts','<',end).orderBy('ts').get();
  const byDay={};
  snap.forEach(doc=>{ const x=doc.data(); if(x.temp_c!=null){ const day=x.ts.toDate().getDate(); (byDay[day]=byDay[day]||[]).push(x.temp_c); } });
  const by={}; Object.keys(byDay).forEach(day=>{ const a=byDay[day]; by[day]=Math.round(a.reduce((p,q)=>p+q,0)/a.length*10)/10; }); return by;
}

async function fetchMonthSys(m){ return MODE==='local' ? localFetchMonthSys(m) : cloudFetchMonthSys(m); }
async function localFetchMonthSys(m){
  const d=await fetch(`/api/system_monthly?month=${m}`).then(r=>r.json());
  const mk=arr=>{ const by={}; (d.labels||[]).forEach((l,i)=>{ by[parseInt(l)]=arr?.[i]; }); return by; };
  return { cpu:mk(d.cpu), ram:mk(d.ram), disk:mk(d.disk) };
}
async function cloudFetchMonthSys(m){
  const start=new Date(m+'-01T00:00:00'); const end=new Date(start); end.setMonth(end.getMonth()+1);
  const snap=await db.collection('readings').where('ts','>=',start).where('ts','<',end).orderBy('ts').get();
  const b={cpu:{},ram:{},disk:{}};
  snap.forEach(doc=>{ const x=doc.data(); const day=x.ts.toDate().getDate();
    if(x.cpu_pct!=null)(b.cpu[day]=b.cpu[day]||[]).push(x.cpu_pct);
    if(x.ram_pct!=null)(b.ram[day]=b.ram[day]||[]).push(x.ram_pct);
    if(x.disk_pct!=null)(b.disk[day]=b.disk[day]||[]).push(x.disk_pct); });
  const avg=o=>{ const r={}; Object.keys(o).forEach(d=>{ const a=o[d]; r[d]=Math.round(a.reduce((p,q)=>p+q,0)/a.length*10)/10; }); return r; };
  return { cpu:avg(b.cpu), ram:avg(b.ram), disk:avg(b.disk) };
}

async function loadUsageCompare(){
  try{
    const [td,yd]=await Promise.all([fetchDate(todayStr()),fetchDate(yesterdayStr())]);
    buildCompareCard(U_CPU,  hourMap(td.labels,td.cpu),  hourMap(yd.labels,yd.cpu));
    buildCompareCard(U_RAM,  hourMap(td.labels,td.ram),  hourMap(yd.labels,yd.ram));
    buildCompareCard(U_DISK, hourMap(td.labels,td.disk), hourMap(yd.labels,yd.disk));
  }catch(e){ console.error('usage compare',e); }
}
async function loadMonthlyCompare(){
  try{
    const m0=ymStr(0), m1=ymStr(-1);
    const [t0,t1,s0,s1]=await Promise.all([fetchMonthTemp(m0),fetchMonthTemp(m1),fetchMonthSys(m0),fetchMonthSys(m1)]);
    buildCompareCard(MC_TEMP, t0, t1);
    buildCompareCard(MC_CPU,  s0.cpu, s1.cpu);
    buildCompareCard(MC_RAM,  s0.ram, s1.ram);
    buildCompareCard(MC_DISK, s0.disk, s1.disk);
  }catch(e){ console.error('month compare',e); }
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

// การ์ด 24 ชม. บน dashboard — สลับ metric ได้ (ใช้ระบบ History เดิม)
let dash24Metric = 'temp';
const D24 = {
  temp:{ name:'อุณหภูมิ', color:()=>C.accent, unit:'°C' },
  cpu: { name:'CPU',     color:()=>C.info,   unit:'%' },
  ram: { name:'RAM',     color:()=>C.purple, unit:'%' },
  disk:{ name:'Disk',    color:()=>C.warn,   unit:'%' },
};
function setDash24(m){
  dash24Metric=m;
  document.querySelectorAll('#dash24Tabs .d24-tab').forEach(b=>b.classList.toggle('active', b.dataset.m===m));
  loadDash24();
}
async function loadDash24(){
  try{
    const el=document.getElementById('dash24Chart'); if(!el) return;
    const d=await fetchHistory('24h');
    const cfg=D24[dash24Metric]||D24.temp, arr=d[dash24Metric];
    const t=document.getElementById('dash24Title'); if(t) t.textContent=cfg.name;
    const sum=document.getElementById('dash24Sum');
    if(!d.labels||!d.labels.length||!arr){ destroyChart('dash24Chart'); if(sum) sum.innerHTML=''; return; }
    makeHistChart('dash24Chart', d.labels, arr, cfg.color(), cfg.unit);
    if(sum) sum.innerHTML = summaryHtml(arr, cfg.unit);
  }catch(e){ console.error('dash24 error',e); }
}

// Health Score 0–100 จากค่าสด (เย็น/ว่าง = คะแนนสูง)
function healthScore(d){
  if(!d || d.temp==null) return null;
  const sTemp = Math.max(0, Math.min(100, (70-d.temp)/(70-40)*100));  // 40°→100, 70°→0
  const sCpu  = Math.max(0, 100-(d.cpu||0));
  const sRam  = Math.max(0, 100-(d.ram||0));
  const sDisk = Math.max(0, 100-(d.disk||0));
  return Math.round(0.30*sTemp + 0.20*sCpu + 0.20*sRam + 0.30*sDisk);
}

// ─── alerts + event log ─────────────────────────────────────────────────────────
const ALERTS = { cfg:null };
const AL_METRICS = ['temp','cpu','ram','disk'];
const AL_NAMES = { temp:'อุณหภูมิ', cpu:'CPU', ram:'RAM', disk:'Disk' };
const AL_UNITS = { temp:'°C', cpu:'%', ram:'%', disk:'%' };
const AL_INPUT = { temp:'alTemp', cpu:'alCpu', ram:'alRam', disk:'alDisk' };

async function loadAlertCfg(){
  try{
    if(MODE==='local'){ ALERTS.cfg = (await fetch('/api/alert_config').then(r=>r.json())).config; }
    else if(db){ const d=await db.collection('settings').doc('alerts').get(); ALERTS.cfg = d.exists?d.data():null; }
  }catch(e){}
  if(!ALERTS.cfg) ALERTS.cfg = { enabled:true, telegram:true, temp:70, cpu:90, ram:90, disk:90 };
  updateBell();
}
function initAlerts(){ loadAlertCfg(); }

// alert ที่กำลัง active = ค่าสด ≥ เกณฑ์ (คำนวณ client-side → ใช้ได้ทั้ง LAN/Cloud)
function activeAlerts(){
  const c=ALERTS.cfg, d=window.lastData;
  if(!c || c.enabled===false || !d) return [];
  const out=[];
  AL_METRICS.forEach(m=>{
    const v = m==='temp'?d.temp : m==='cpu'?d.cpu : m==='ram'?d.ram : d.disk;
    if(v!=null && c[m]!=null && v>=c[m]) out.push({metric:m, value:v, thr:c[m]});
  });
  return out;
}
function updateBell(){
  const act=activeAlerts();
  const badge=document.getElementById('bellBadge');
  if(badge){ if(act.length){ badge.textContent=act.length; badge.style.display=''; } else badge.style.display='none'; }
  document.getElementById('alertBtn')?.classList.toggle('has-alert', act.length>0);
  if(document.getElementById('alertsModal')?.classList.contains('open')) renderActive();
}
function renderActive(){
  const el=document.getElementById('alActive'); if(!el) return;
  if(ALERTS.cfg && ALERTS.cfg.enabled===false){ el.innerHTML='<span class="al-ok" style="color:var(--dim)">⏸ ระบบแจ้งเตือนปิดอยู่</span>'; return; }
  const act=activeAlerts();
  if(!act.length){ el.innerHTML='<span class="al-ok"><i data-lucide="check-circle"></i> ทุกอย่างปกติ</span>'; if(window.lucide)lucide.createIcons(); return; }
  el.innerHTML=act.map(a=>`<span class="al-chip">${AL_NAMES[a.metric]} ${a.value.toFixed(1)}${AL_UNITS[a.metric]} ≥ ${a.thr}${AL_UNITS[a.metric]}</span>`).join('');
}

function openAlerts(){
  document.getElementById('alertsModal').classList.add('open');
  loadAlertCfg().then(()=>{ renderAlertCfg(); renderActive(); });
  loadEvents();
}
function closeAlerts(){ document.getElementById('alertsModal').classList.remove('open'); }

function renderAlertCfg(){
  const c=ALERTS.cfg||{}, isLocal=MODE==='local';
  AL_METRICS.forEach(m=>{ const inp=document.getElementById(AL_INPUT[m]); if(inp){ inp.value=c[m]??''; inp.disabled=!isLocal; } });
  document.querySelectorAll('#alEnabled button').forEach(b=>{ b.classList.toggle('on',(b.dataset.v==='on')===(c.enabled!==false)); b.disabled=!isLocal; });
  document.querySelectorAll('#alTelegram button').forEach(b=>{ b.classList.toggle('on',(b.dataset.v==='on')===(c.telegram!==false)); b.disabled=!isLocal; });
  const hint=document.getElementById('alLanHint'); if(hint) hint.textContent = isLocal?'':'(แก้ไขได้เฉพาะใน LAN)';
  const btn=document.getElementById('alSaveBtn'); if(btn) btn.style.display = isLocal?'':'none';
}
function alSetToggle(key,val){ if(MODE!=='local') return; if(!ALERTS.cfg) ALERTS.cfg={}; ALERTS.cfg[key]=val; renderAlertCfg(); renderActive(); }

async function alSaveConfig(){
  if(MODE!=='local'){ toast('แก้ไขเกณฑ์ได้เฉพาะตอนเปิดใน LAN','info'); return; }
  const c=Object.assign({}, ALERTS.cfg||{});
  AL_METRICS.forEach(m=>{ const inp=document.getElementById(AL_INPUT[m]); if(inp&&inp.value!=='') c[m]=parseFloat(inp.value); });
  try{
    const r=await fetch('/api/alert_config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)}).then(r=>r.json());
    if(r.config) ALERTS.cfg=r.config;
    const n=document.getElementById('alSaveNote'); if(n){ n.textContent='บันทึกแล้ว ✓'; setTimeout(()=>{n.textContent='';},2000); }
    updateBell(); renderActive(); loadEvents();
  }catch(e){ toast('บันทึกไม่สำเร็จ','error'); }
}

function fmtEvTs(d){ return `${pad2(d.getDate())}/${pad2(d.getMonth()+1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
async function loadEvents(){
  const el=document.getElementById('alEvents'); if(!el) return;
  try{
    let evs=[];
    if(MODE==='local'){ evs=(await fetch('/api/events?limit=60').then(r=>r.json())).events||[]; }
    else if(db){
      const snap=await db.collection('events').orderBy('ts','desc').limit(60).get();
      evs=snap.docs.map(d=>{ const x=d.data(); return {ts:(x.ts&&x.ts.toDate)?fmtEvTs(x.ts.toDate()):x.ts, type:x.type, metric:x.metric, value:x.value, severity:x.severity, message:x.message}; });
    }
    renderEvents(evs);
  }catch(e){ el.innerHTML='<div class="proc-empty">โหลด event ไม่สำเร็จ</div>'; }
}
function renderEvents(evs){
  const el=document.getElementById('alEvents'); if(!el) return;
  if(!evs.length){ el.innerHTML='<div class="proc-empty">ยังไม่มี event</div>'; return; }
  const ICON={alert:'alert-triangle',recovery:'check-circle',info:'info',config:'sliders-horizontal',system:'power'};
  el.innerHTML=evs.map(e=>{
    const sev=e.severity||'info';
    const ts=(typeof e.ts==='string')?e.ts.slice(5,16):(e.ts||'');
    return `<div class="ev-row ev-${sev}"><i data-lucide="${ICON[e.type]||'circle'}"></i><span class="ev-msg">${e.message||e.type}</span><span class="ev-ts">${ts}</span></div>`;
  }).join('');
  if(window.lucide) lucide.createIcons();
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
    makeBarChart('mDiskChart', sys.labels,  sys.disk,  v=>sysColor(v)||C.warn, '%');
    document.getElementById('mTempSum').innerHTML = summaryHtml(temp.data,'°C');
    document.getElementById('mCpuSum').innerHTML  = summaryHtml(sys.cpu,'%');
    document.getElementById('mRamSum').innerHTML  = summaryHtml(sys.ram,'%');
    document.getElementById('mDiskSum').innerHTML = summaryHtml(sys.disk,'%');
  } catch(e){ console.error('monthly error',e); }
}

// ─── history (24h / 7d / 30d) ──────────────────────────────────────────────────

let histRange = '24h';
const HIST_LABELS = { '24h':'24 ชม.', '7d':'7 วัน', '30d':'30 วัน' };

async function fetchHistory(range){
  return MODE==='local' ? localFetchHistory(range) : cloudFetchHistory(range);
}
async function localFetchHistory(range){
  return fetch(`/api/history_range?range=${range}`).then(r=>r.json());
}
async function cloudFetchHistory(range){
  const now = Date.now();
  const spanMs   = { '24h':24*3600e3, '7d':7*864e5, '30d':30*864e5 }[range] || 24*3600e3;
  const bucketMs = range==='24h' ? 3600e3 : range==='7d' ? 3*3600e3 : 864e5;
  const dayMode  = range==='30d';
  const start = new Date(now - spanMs);
  const snap  = await db.collection('readings').where('ts','>=',start).orderBy('ts').get();
  const buckets = {};
  snap.forEach(doc=>{
    const x=doc.data(), dt=x.ts.toDate();
    let key, ord;
    if(dayMode){ key=`${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}`;
                 ord=new Date(dt.getFullYear(),dt.getMonth(),dt.getDate()).getTime(); }
    else { key=Math.floor(dt.getTime()/bucketMs)*bucketMs; ord=key; }
    const b = buckets[key] || (buckets[key]={t:[],c:[],r:[],d:[],ord});
    if(x.temp_c!=null) b.t.push(x.temp_c);
    if(x.cpu_pct!=null) b.c.push(x.cpu_pct);
    if(x.ram_pct!=null) b.r.push(x.ram_pct);
    if(x.disk_pct!=null) b.d.push(x.disk_pct);
  });
  const keys = Object.keys(buckets).sort((a,b)=>buckets[a].ord-buckets[b].ord);
  const avg = a=>a.length?Math.round(a.reduce((p,q)=>p+q,0)/a.length*10)/10:null;
  const lbl = k=>{
    const d=new Date(buckets[k].ord);
    if(dayMode) return `${d.getDate()}/${d.getMonth()+1}`;
    if(range==='24h') return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return `${d.getDate()}/${d.getMonth()+1} ${pad2(d.getHours())}:00`;
  };
  return { range, labels:keys.map(lbl),
           temp:keys.map(k=>avg(buckets[k].t)), cpu:keys.map(k=>avg(buckets[k].c)),
           ram:keys.map(k=>avg(buckets[k].r)), disk:keys.map(k=>avg(buckets[k].d)), count:snap.size };
}

// line chart สำหรับ history (จุดเยอะ — ปิด datalabels, เน้นเส้น + พื้นไล่สี)
function makeHistChart(id, labels, data, color, unit){
  destroyChart(id);
  const el=document.getElementById(id); if(!el) return;
  const vals=(data||[]).filter(v=>v!=null);
  if(!vals.length) return;
  const ny=niceY(Math.min(...vals), Math.max(...vals), unit==='°C'?5:8);
  const ctx=el.getContext('2d');
  const grad=ctx.createLinearGradient(0,0,0,el.clientHeight||220);
  grad.addColorStop(0,color+'55'); grad.addColorStop(1,color+'08');
  charts[id]=new Chart(el,{
    type:'line',
    data:{labels,datasets:[{
      data, borderColor:color, backgroundColor:grad, fill:true,
      borderWidth:2, tension:0.35, pointRadius:0, pointHoverRadius:4,
      pointHoverBackgroundColor:color, spanGaps:true }]},
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{display:false},
        tooltip:{callbacks:{label:ctx=>` ${ctx.parsed.y==null?'-':ctx.parsed.y.toFixed(1)}${unit}`},
          backgroundColor:'rgba(12,20,36,.95)',borderColor:'rgba(29,47,80,.8)',borderWidth:1,
          titleColor:C.dim,bodyColor:C.text,padding:10},
        datalabels:{display:false},
      },
      scales:{
        x:{ticks:{color:C.dim,font:{size:11,family:'Inter'},maxRotation:0,autoSkip:true,maxTicksLimit:8},
           grid:{display:false}},
        y:{min:ny.min,max:ny.max,
           ticks:{color:C.dim,font:{size:12,family:'Inter'},stepSize:ny.step,callback:v=>Math.round(v)+unit},
           grid:{color:C.grid}},
      },
    },
  });
}

async function loadHistory(range){
  histRange=range;
  ['24h','7d','30d'].forEach(r=>document.getElementById('hq-'+r)?.classList.toggle('active', r===range));
  const lblEl=document.getElementById('histRangeLabel'); if(lblEl) lblEl.textContent=HIST_LABELS[range];
  try{
    const d=await fetchHistory(range);
    document.getElementById('histCount').textContent = d.count ? `${d.count} records` : '';
    const noData=document.getElementById('histNoData'), canvas=document.getElementById('histTempChart');
    if(!d.labels||!d.labels.length){
      noData.style.display='flex'; canvas.style.display='none';
      ['histTempSum','histCpuSum','histRamSum','histDiskSum'].forEach(id=>{const e=document.getElementById(id); if(e) e.innerHTML='';});
      destroyChart('histCpuChart'); destroyChart('histRamChart'); destroyChart('histDiskChart');
      return;
    }
    noData.style.display='none'; canvas.style.display='block';
    makeHistChart('histTempChart', d.labels, d.temp, C.accent, '°C');
    makeHistChart('histCpuChart',  d.labels, d.cpu,  C.info,   '%');
    makeHistChart('histRamChart',  d.labels, d.ram,  C.purple, '%');
    makeHistChart('histDiskChart', d.labels, d.disk, C.warn,   '%');
    document.getElementById('histTempSum').innerHTML = summaryHtml(d.temp,'°C');
    document.getElementById('histCpuSum').innerHTML  = summaryHtml(d.cpu,'%');
    document.getElementById('histRamSum').innerHTML  = summaryHtml(d.ram,'%');
    document.getElementById('histDiskSum').innerHTML = summaryHtml(d.disk,'%');
  }catch(e){ console.error('history error',e); }
}
function setupHistory(){ loadHistory(histRange); }

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
    if(!d.ok) toast('สั่ง '+action+' '+name+' ไม่สำเร็จ: '+(d.error||d.output||''),'error');
    else toast(action+' '+name+' สำเร็จ','ok');
  }catch(e){ toast('error: '+(e?.message||e),'error'); }
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
  term=new Terminal({fontFamily:"ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize:15, cursorBlink:true,
    theme:{
      background:'#121212', foreground:'#e0e0e0', cursor:'#2ecc71', cursorAccent:'#121212', selectionBackground:'#0e4a5c',
      black:'#1a1a1a', red:'#ff6b6b', green:'#2ecc71', yellow:'#f1c40f', blue:'#3b8eea',
      magenta:'#c678dd', cyan:'#00d2ff', white:'#e0e0e0',
      brightBlack:'#5c6370', brightRed:'#ff8787', brightGreen:'#43e07f', brightYellow:'#ffd866',
      brightBlue:'#00d2ff', brightMagenta:'#d18bff', brightCyan:'#5fe6ff', brightWhite:'#ffffff'
    }});
  fitAddon=new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('xterm'));
  const fitNow=()=>{ try{ fitAddon.fit(); sendResize(); }catch(e){} };
  setTimeout(fitNow,60); setTimeout(fitNow,320);   // fit + ส่ง cols ให้ PTY ตรงกัน (กันตัวอักษรซ้อน)
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
  termSock.onopen    = ()=>{ try{ fitAddon && fitAddon.fit(); }catch(e){} sendResize(); if(term) term.focus(); };
  termSock.onmessage = e=>{ if(term) term.write(e.data); };
  termSock.onclose   = ()=>{ if(term) term.write('\r\n\x1b[31m[การเชื่อมต่อปิด — กดแท็บอื่นแล้วกลับมาเพื่อเชื่อมใหม่]\x1b[0m\r\n'); };
}

function sendResize(){
  if(termSock && termSock.readyState===1 && term)
    termSock.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
}

// ส่งคีย์ดิบเข้า PTY (เช่น Ctrl+C = \x03)
function termSendKey(data){
  if(MODE!=='local'){ toast('Web Terminal ใช้ได้เฉพาะตอนเปิดใน LAN','info'); return; }
  if(termSock && termSock.readyState===1){ termSock.send(JSON.stringify({type:'input', data})); if(term) term.focus(); }
}

// คำสั่งด่วน — ส่งคำสั่ง + Enter เข้า PTY ทันที
function termSendCmd(cmd){
  if(MODE!=='local'){ toast('Web Terminal ใช้ได้เฉพาะตอนเปิดใน LAN','info'); return; }
  const fire=()=>{
    if(termSock && termSock.readyState===1){
      termSock.send(JSON.stringify({type:'input', data:cmd+'\r'}));   // \r = กด Enter
      if(term) term.focus();
    }
  };
  if(termSock && termSock.readyState===1){ fire(); }
  else { setupTerminal(); setTimeout(fire, 450); }   // ยังไม่เชื่อม → เชื่อมก่อนแล้วค่อยส่ง
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

async function uploadFiles(fileList){
  const files=[...fileList];
  // ชื่อไฟล์ที่มีอยู่แล้ว (ดึงสด)
  let names;
  try{ names=new Set(((await fetch('/api/files').then(r=>r.json())).files||[]).map(f=>f.name)); }
  catch(e){ names=new Set(); }

  const plan=[];   // {file, name}
  for(const f of files){
    let name=f.name;
    if(names.has(name)){
      let c=await showChoice({ title:'ไฟล์ซ้ำ', icon:'⚠️', wide:true,
        msg:`มีไฟล์ชื่อนี้อยู่แล้ว — ต้องการทำอย่างไร?<div class="dup-name">${agEsc(name)}</div>`,
        buttons:[
          {label:'ทับไฟล์เดิม', val:'overwrite', cls:'modal-confirm', icon:'refresh-cw'},
          {label:'เปลี่ยนชื่อ',  val:'rename',    cls:'modal-confirm accent', icon:'pencil'},
          {label:'ข้าม',         val:'skip',      cls:'modal-cancel', icon:'skip-forward'},
        ]});
      if(c==='rename'){
        // วน prompt จนได้ชื่อที่ไม่ซ้ำ หรือผู้ใช้เลือกทับ/ข้าม
        while(true){
          const nn=await showPrompt({title:'เปลี่ยนชื่อก่อนอัปโหลด', icon:'✏️', value:name, confirmText:'ใช้ชื่อนี้'});
          if(!nn){ c='skip'; break; }
          if(!names.has(nn) && !plan.some(p=>p.name===nn)){ name=nn; c='ok'; break; }
          const c2=await showChoice({ title:'ยังซ้ำอยู่', icon:'⚠️', wide:true,
            msg:`ชื่อนี้ก็มีอยู่แล้ว — ต้องการทำอย่างไร?<div class="dup-name">${agEsc(nn)}</div>`,
            buttons:[
              {label:'ทับไฟล์เดิม', val:'overwrite', cls:'modal-confirm', icon:'refresh-cw'},
              {label:'เปลี่ยนชื่อใหม่', val:'rename', cls:'modal-confirm accent', icon:'pencil'},
              {label:'ข้าม',         val:'skip',      cls:'modal-cancel', icon:'skip-forward'},
            ]});
          if(c2==='overwrite'){ name=nn; c='ok'; break; }
          if(c2!=='rename'){ c='skip'; break; }
        }
      }
      if(c==='skip' || c===false || c==null) continue;   // ข้ามไฟล์นี้
      // overwrite หรือ ok → ใช้ name ปัจจุบัน (ทับถ้าซ้ำ)
    }
    plan.push({file:f, name});
    names.add(name);   // กันซ้ำกันเองในชุดเดียว
  }
  if(!plan.length){ toast('ไม่มีไฟล์ที่อัปโหลด','info'); return; }

  const fd=new FormData();
  plan.forEach(p=>fd.append('files', p.file, p.name));   // arg ที่ 3 = ชื่อที่จะเซฟ
  const bar=document.getElementById('upBar'), fill=document.getElementById('upBarFill');
  bar.style.display=''; fill.style.width='0';
  const pct=document.getElementById('upPct'), meta=document.getElementById('upMeta');
  pct.textContent='0%'; meta.textContent='';
  const xhr=new XMLHttpRequest();
  xhr.open('POST','/api/files/upload');
  xhr.upload.onprogress=e=>{ if(e.lengthComputable){
    const p=e.loaded/e.total*100;
    fill.style.width=p+'%';
    pct.textContent=p.toFixed(0)+'%';
    meta.textContent=fmtFileSize(e.loaded)+' / '+fmtFileSize(e.total);
  } };
  xhr.onload=()=>{ fill.style.width='100%'; pct.textContent='100%'; setTimeout(()=>bar.style.display='none',700);
    if(xhr.status===200){ loadFiles(); toast('อัปโหลดสำเร็จ','ok'); } else toast('อัปโหลดไม่สำเร็จ ('+xhr.status+')','error'); };
  xhr.onerror=()=>{ bar.style.display='none'; toast('อัปโหลดไม่สำเร็จ — เชื่อมต่อไม่ได้','error'); };
  xhr.send(fd);
}

async function loadFiles(){
  try{ renderFiles(await fetch('/api/files').then(r=>r.json())); }
  catch(e){ document.getElementById('filesBody').innerHTML='<tr><td colspan="4" class="proc-empty">โหลดรายการไม่สำเร็จ</td></tr>'; }
}

let filesData=[], filesSearch='', filesSort='new';

function renderFiles(data){
  filesData=(data&&data.files)||[];
  const u=document.getElementById('filesUsage');
  if(u){
    if(data && data.used!=null){
      u.style.display='';
      u.innerHTML=`<span><i data-lucide="folder"></i>ใช้ไป <b>${fmtFileSize(data.used)}</b></span>`
        + `<span><i data-lucide="database"></i>เหลือว่างสำหรับอัปโหลด <b>${fmtFileSize(data.free)}</b></span>`;
      if(window.lucide) lucide.createIcons();
    } else u.style.display='none';
  }
  drawFiles();
}

function filesDoSearch(v){ filesSearch=v||''; drawFiles(); }
function filesToggleSort(group){
  if(group==='date')      filesSort = filesSort==='new' ? 'old' : 'new';
  else if(group==='name') filesSort = filesSort==='az'  ? 'za'  : 'az';
  else if(group==='size') filesSort = filesSort==='big' ? 'small': 'big';
  updateFilesSortBtns(); drawFiles();
}
function updateFilesSortBtns(){
  const d=document.getElementById('filesSortDate'), n=document.getElementById('filesSortName'), s=document.getElementById('filesSortSize');
  if(!d) return;
  d.classList.toggle('active', filesSort==='new'||filesSort==='old');
  n.classList.toggle('active', filesSort==='az'||filesSort==='za');
  s.classList.toggle('active', filesSort==='big'||filesSort==='small');
  d.innerHTML = filesSort==='old'  ? '<i data-lucide="arrow-up-wide-narrow"></i>เก่าสุด'  : '<i data-lucide="arrow-down-wide-narrow"></i>ใหม่สุด';
  n.innerHTML = filesSort==='za'   ? '<i data-lucide="arrow-up-z-a"></i>Z→A'             : '<i data-lucide="arrow-down-a-z"></i>A→Z';
  s.innerHTML = filesSort==='small'? '<i data-lucide="arrow-up-narrow-wide"></i>เล็กสุด' : '<i data-lucide="arrow-down-wide-narrow"></i>ใหญ่สุด';
  if(window.lucide) lucide.createIcons();
}

function drawFiles(){
  const q=filesSearch.trim().toLowerCase();
  let arr=filesData.filter(f=> !q || f.name.toLowerCase().includes(q));
  arr.sort((a,b)=>{
    if(filesSort==='old')   return a.mtime-b.mtime;
    if(filesSort==='az')    return a.name.localeCompare(b.name,'th');
    if(filesSort==='za')    return b.name.localeCompare(a.name,'th');
    if(filesSort==='big')   return b.size-a.size;
    if(filesSort==='small') return a.size-b.size;
    return b.mtime-a.mtime;   // new
  });
  setText('filesNote', q ? `${arr.length} / ${filesData.length} files` : `${filesData.length} files`);
  const body=document.getElementById('filesBody');
  if(!filesData.length){ body.innerHTML='<tr><td colspan="4" class="proc-empty">ยังไม่มีไฟล์</td></tr>'; return; }
  if(!arr.length){ body.innerHTML='<tr><td colspan="4" class="proc-empty">ไม่พบไฟล์ที่ค้นหา</td></tr>'; return; }
  body.innerHTML=arr.map(f=>{
    const enc=encodeURIComponent(f.name);
    const isText=/\.(txt|log|md|markdown|csv|tsv|json|conf|cfg|ini|ya?ml|sh|bash|py|js|ts|css|html?|xml|env|service|list|properties)$/i.test(f.name);
    const isImage=FILE_IMG_RE.test(f.name);
    return `<tr>
      <td class="ft-name" title="${agEsc(f.name)}">${agEsc(f.name)}</td>
      <td class="num">${fmtFileSize(f.size)}</td>
      <td class="ft-time hide-sm">${fmtFileTime(f.mtime)}</td>
      <td><div class="ft-act">
        ${(isText||isImage)?`<button class="ft-btn pv" onclick="previewFile('${enc}')" title="พรีวิว"><i data-lucide="eye"></i></button>`:''}
        <button class="ft-btn dl" onclick="downloadFile('${enc}')"><i data-lucide="download"></i>โหลด</button>
        <button class="ft-btn rn" onclick="renameFile('${enc}')" title="เปลี่ยนชื่อ"><i data-lucide="pencil"></i></button>
        <button class="ft-btn del" onclick="deleteFile('${enc}')"><i data-lucide="trash-2"></i></button>
      </div></td></tr>`;
  }).join('');
  if(window.lucide) lucide.createIcons();
}

function downloadFile(enc){ window.location.href='/api/files/download/'+enc; }   // cookie ติดไปเอง

const FILE_IMG_RE=/\.(jpe?g|png|gif|webp|bmp|svg|ico|avif)$/i;
let pvText='', pvImgUrl='';
async function previewFile(enc){
  const name=decodeURIComponent(enc);
  const content=document.getElementById('pvContent');
  const copyBtn=document.getElementById('pvCopyBtn'), openBtn=document.getElementById('pvOpenBtn');
  document.getElementById('pvTitle').textContent=name;
  document.getElementById('pvNote').textContent=''; pvText=''; pvImgUrl='';
  document.getElementById('previewModal').classList.add('open');

  if(FILE_IMG_RE.test(name)){                 // ── รูปภาพ ──
    pvImgUrl='/api/files/download/'+enc;
    content.classList.add('pv-img');
    content.innerHTML=`<img src="${pvImgUrl}" alt="${agEsc(name)}" onerror="pvImgError(this)">`;
    if(copyBtn) copyBtn.style.display='none';
    if(openBtn) openBtn.style.display='';
    const f=(filesData||[]).find(x=>x.name===name);
    if(f) document.getElementById('pvNote').textContent=fmtFileSize(f.size);
    return;
  }

  // ── ข้อความ ──
  content.classList.remove('pv-img');
  if(copyBtn) copyBtn.style.display='';
  if(openBtn) openBtn.style.display='none';
  content.textContent='กำลังโหลด…';
  try{
    const d=await fetch('/api/files/view/'+enc).then(r=>r.json());
    if(d.error){ content.textContent='โหลดไม่สำเร็จ: '+d.error; return; }
    pvText=d.text||'';
    content.textContent=pvText||'(ไฟล์ว่าง)';
    document.getElementById('pvNote').textContent=(d.truncated?'⚠ แสดงบางส่วน (ไฟล์ใหญ่เกิน 1MB) · ':'')+fmtFileSize(d.size);
  }catch(e){ content.textContent='โหลดไม่สำเร็จ'; }
}
function pvOpenImage(){ if(pvImgUrl) window.open(pvImgUrl,'_blank'); }
function pvImgError(img){ const p=img.parentNode; p.innerHTML='<div class="pv-imgerr">โหลดรูปไม่สำเร็จ</div>'; }
function closePreview(){ document.getElementById('previewModal').classList.remove('open'); }
async function copyPreview(){
  try{ await navigator.clipboard.writeText(pvText); toast('คัดลอกแล้ว','ok'); return; }catch(e){}
  // fallback (LAN http ไม่ใช่ secure context — clipboard API ใช้ไม่ได้)
  try{
    const r=document.createRange(); r.selectNodeContents(document.getElementById('pvContent'));
    const s=getSelection(); s.removeAllRanges(); s.addRange(r);
    document.execCommand('copy'); s.removeAllRanges(); toast('คัดลอกแล้ว','ok');
  }catch(e2){ toast('คัดลอกไม่สำเร็จ — ลองเลือกข้อความเองแล้ว Ctrl+C','error'); }
}
document.getElementById('previewModal').addEventListener('click',e=>{ if(e.target===e.currentTarget) closePreview(); });

async function renameFile(enc){
  const oldName=decodeURIComponent(enc);
  const newName=await showPrompt({title:'เปลี่ยนชื่อไฟล์', icon:'✏️', msg:'ตั้งชื่อไฟล์ใหม่:', value:oldName, confirmText:'เปลี่ยนชื่อ'});
  if(!newName || newName===oldName) return;
  try{
    const d=await fetch('/api/files/rename',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({old:oldName, new:newName})}).then(r=>r.json());
    if(d.ok){ loadFiles(); toast('เปลี่ยนชื่อแล้ว','ok'); } else toast('เปลี่ยนชื่อไม่สำเร็จ: '+(d.error||''),'error');
  }catch(e){ toast('เปลี่ยนชื่อไม่สำเร็จ','error'); }
}

async function deleteFile(enc){
  const name=decodeURIComponent(enc);
  if(!(await showConfirm({title:'ลบไฟล์?', icon:'🗑️', wide:true,
    msg:`ต้องการลบไฟล์นี้ถาวร?<div class="dup-name">${agEsc(name)}</div>`,
    confirmText:'ลบไฟล์', danger:true}))) return;
  try{
    const d=await fetch('/api/files/delete',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name})}).then(r=>r.json());
    if(d.ok){ loadFiles(); toast('ลบไฟล์แล้ว','ok'); } else toast('ลบไม่สำเร็จ','error');
  }catch(e){ toast('ลบไม่สำเร็จ','error'); }
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

let notesData=[], notesEditing=null, notesUnsub=null, notesSort='new', notesSearch='';

function notesDoSearch(v){ notesSearch=v||''; drawNotes(); }
const noteCreated = n => n.created || n.updated || 0;

// notesSort: 'new' | 'old' | 'az' | 'za'
function notesToggleDate(){
  notesSort = notesSort==='new' ? 'old' : notesSort==='old' ? 'new' : 'new';
  updateSortBtns(); drawNotes();
}
function notesToggleTitle(){
  notesSort = notesSort==='az' ? 'za' : notesSort==='za' ? 'az' : 'az';
  updateSortBtns(); drawNotes();
}
function updateSortBtns(){
  const db=document.getElementById('notesSortBtn'), tb=document.getElementById('notesSortTitleBtn');
  if(!db||!tb) return;
  const dateMode = (notesSort==='new'||notesSort==='old');
  db.classList.toggle('active', dateMode);
  tb.classList.toggle('active', !dateMode);
  db.innerHTML = notesSort==='old'
    ? '<i data-lucide="arrow-up-wide-narrow"></i>เก่าสุด'
    : '<i data-lucide="arrow-down-wide-narrow"></i>ใหม่สุด';
  tb.innerHTML = notesSort==='za'
    ? '<i data-lucide="arrow-up-z-a"></i>Z→A'
    : '<i data-lucide="arrow-down-a-z"></i>A→Z';
  if(window.lucide) lucide.createIcons();
}

function setupNotes(){
  const ta=document.getElementById('noteNew');
  if(ta && !ta._bound){ ta._bound=true; ta.addEventListener('keydown',e=>{ if((e.ctrlKey||e.metaKey)&&e.key==='Enter') noteAdd(); }); }
  if(MODE==='local'){ loadNotes(); }
  else if(!notesUnsub){                    // cloud: realtime onSnapshot
    notesUnsub = db.collection('notes').onSnapshot(snap=>{
      const arr=[]; snap.forEach(d=>{ const x=d.data();
        arr.push({id:d.id,title:x.title||'',text:x.text||'',updated:x.updated||0,created:x.created||x.updated||0}); });
      renderNotes(arr);
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
  const q=notesSearch.trim().toLowerCase();
  let arr=notesData.filter(n=> !q || (n.title||'').toLowerCase().includes(q) || (n.text||'').toLowerCase().includes(q));
  if(notesSort==='az' || notesSort==='za'){
    arr.sort((a,b)=>{
      const ta=(a.title||'').trim(), tb=(b.title||'').trim();
      if(!ta && !tb) return noteCreated(b)-noteCreated(a);
      if(!ta) return 1;  if(!tb) return -1;            // โน้ตไม่มีหัวข้อ → ไว้ล่างสุด
      const c=ta.localeCompare(tb,'th');
      return notesSort==='za' ? -c : c;
    });
  } else {
    arr.sort((a,b)=> notesSort==='old' ? noteCreated(a)-noteCreated(b) : noteCreated(b)-noteCreated(a));
  }
  setText('notesNote', q ? `${arr.length} / ${notesData.length} notes` : `${notesData.length} notes`);
  if(!notesData.length){ list.innerHTML='<div class="note-empty">ยังไม่มีโน้ต — เขียนหรือแปะลิงก์ด้านบนได้เลย</div>'; return; }
  if(!arr.length){ list.innerHTML='<div class="note-empty">ไม่พบโน้ตที่ค้นหา</div>'; return; }
  list.innerHTML=arr.map(n=>{
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
      <div class="note-foot">
        <span class="note-times">
          <span class="note-time"><i data-lucide="calendar-plus"></i>สร้างเมื่อ ${noteTime(noteCreated(n))}</span>
          ${ (n.updated && n.created && n.updated > n.created+1) ? `<span class="note-edited"><i data-lucide="pencil"></i>แก้ไขล่าสุด ${noteTime(n.updated)}</span>` : '' }
        </span>
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
  if(!(await showConfirm({title:'ลบโน้ต?', msg:'ลบโน้ตนี้ออกถาวร?', confirmText:'ลบ', danger:true}))) return;
  if(MODE==='local'){ await fetch('/api/notes/'+id+'/delete',{method:'POST'}); loadNotes(); }
  else { await db.collection('notes').doc(id).delete(); }
}

// ─── status cards ─────────────────────────────────────────────────────────────

// อัปเดตวงแหวน % การใช้งาน (pathLength=100 → dasharray เป็นเปอร์เซ็นต์ตรง ๆ)
function setRing(id, pct, color){
  const el=document.getElementById(id); if(!el) return;
  const p=Math.max(0,Math.min(100,pct||0));
  el.style.strokeDasharray = `${p.toFixed(1)} 100`;
  if(color) el.style.stroke = color;
}

// ไล่สีต่อเนื่องตามค่า — interpolate ระหว่าง stops [[value,hex],...] (เรียงน้อย→มาก)
function _hx(h){ h=h.replace('#',''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }
function rampColor(v, stops){
  if(v<=stops[0][0]) return stops[0][1];
  const last=stops[stops.length-1];
  if(v>=last[0]) return last[1];
  for(let i=0;i<stops.length-1;i++){
    const [v0,c0]=stops[i], [v1,c1]=stops[i+1];
    if(v>=v0 && v<=v1){
      const t=(v-v0)/(v1-v0), a=_hx(c0), b=_hx(c1);
      const m=k=>Math.round(a[k]+(b[k]-a[k])*t).toString(16).padStart(2,'0');
      return '#'+m(0)+m(1)+m(2);
    }
  }
  return last[1];
}
// คงสีประจำการ์ดตอนค่าต่ำ แล้วเฟด → ส้ม → แดง ตอนค่าสูง (temp ใช้ °C, ที่เหลือใช้ %)
const RING_RAMP = {
  temp: [[50,C.ok],   [57,C.warn], [64,C.accent], [73,C.danger]],
  cpu:  [[0, C.info], [55,C.accent], [80,C.danger]],
  ram:  [[0, C.purple],[60,C.accent], [82,C.danger]],
  disk: [[0, C.warn], [72,C.accent], [92,C.danger]],
};

function updateCards(d){
  if(!d) return;
  const tc = d.temp>=70?C.danger:d.temp>=55?C.accent:d.temp>=50?C.warn:C.ok;
  const tempEl = document.getElementById('sTemp');
  tempEl.textContent = d.temp.toFixed(1)+'°';
  tempEl.style.color = tc;
  document.querySelector('.sc-temp .sc-bar').style.background = tc;
  setRing('sTempRing', d.temp/90*100, rampColor(d.temp, RING_RAMP.temp));   // temp เทียบสเกล 0–90°C
  const st = d.temp>=70?'🔥 ร้อนมาก!':d.temp>=55?'⚠️ อุ่น':d.temp>=50?'🟡 เริ่มอุ่น':'✅ ปกติ';
  document.getElementById('sTempSub').textContent = st;

  const cpuC = d.cpu>=80?C.danger:d.cpu>=50?C.accent:C.info;
  document.getElementById('sCpu').textContent = d.cpu.toFixed(1)+'%';
  document.getElementById('sCpu').style.color = cpuC;
  document.querySelector('.sc-cpu .sc-bar').style.background = cpuC;
  setRing('sCpuRing', d.cpu, rampColor(d.cpu, RING_RAMP.cpu));

  const ramC = d.ram>=80?C.danger:d.ram>=60?C.accent:C.purple;
  document.getElementById('sRam').textContent = d.ram.toFixed(1)+'%';
  document.getElementById('sRam').style.color = ramC;
  document.querySelector('.sc-ram .sc-bar').style.background = ramC;
  document.getElementById('sRamSub').textContent = `ว่าง ${d.ram_free_mb} MB`;
  setRing('sRamRing', d.ram, rampColor(d.ram, RING_RAMP.ram));

  const diskC = d.disk>=90?C.danger:d.disk>=70?C.accent:C.warn;
  document.getElementById('sDisk').textContent = d.disk.toFixed(1)+'%';
  document.getElementById('sDisk').style.color = diskC;
  document.querySelector('.sc-disk .sc-bar').style.background = diskC;
  document.getElementById('sDiskSub').textContent = `ว่าง ${d.disk_free_gb} GB`;
  setRing('sDiskRing', d.disk, rampColor(d.disk, RING_RAMP.disk));

  if(d.uptime) document.getElementById('iUptime').textContent = uptimeFmt(d.uptime);
  if(d.model)    setText('iModel', shortModel(d.model));
  if(d.hostname) setText('iHostname', d.hostname);
  if(d.ip)       setText('iIP', d.ip);
  if(d.down_kbps!=null || d.up_kbps!=null)
    setText('iSpeed', `↓ ${fmtSpeed(d.down_kbps||0)} · ↑ ${fmtSpeed(d.up_kbps||0)}`);
  const now = new Date();
  document.getElementById('iLastSeen').textContent =
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  window.lastData = d;
  if(typeof updateBell==='function') updateBell();
  const hs = healthScore(d);
  if(hs!=null){
    const el=document.getElementById('iHealth');
    if(el){ const lab=hs>=85?'ดีมาก':hs>=70?'ดี':hs>=50?'พอใช้':'ควรเช็ก';
      const col=hs>=85?C.ok:hs>=70?C.info:hs>=50?C.warn:C.danger;
      el.innerHTML=`<b style="color:${col}">${hs}</b><span style="color:var(--dim);font-size:.82em;margin-left:6px">${lab}</span>`; }
  }
  gfPush(d);
  if(gfReady) gfRender(d);
}

// ─── Grafana-style page (page 2) ────────────────────────────────────────────────

const GF = { cpu:[], down:[], up:[], temp:[], t:[], MAX:40, _seen:'' };
let gfReady = false;
function setHtml(id,h){ const e=document.getElementById(id); if(e) e.innerHTML=h; }
function gfColor(m,v){
  if(m==='temp') return v>=70?C.danger:v>=55?C.accent:v>=50?C.warn:C.info;
  if(m==='cpu')  return v>=80?C.danger:v>=50?C.accent:C.info;
  if(m==='ram')  return v>=80?C.danger:v>=60?C.accent:C.purple;
  return v>=90?C.danger:v>=70?C.accent:C.warn;   // disk
}
function gfFade(el,color){
  const ctx=el.getContext('2d'); const h=el.clientHeight||el.height||50;
  const g=ctx.createLinearGradient(0,0,0,h);
  g.addColorStop(0,color+'55'); g.addColorStop(1,color+'08'); return g;
}
function gfGauge(id,value,max,color){
  const el=document.getElementById(id); if(!el) return;
  const track=getComputedStyle(document.documentElement).getPropertyValue('--border').trim()||'rgba(255,255,255,.08)';
  const v=Math.max(0,Math.min(value,max));
  if(charts[id]){ const ds=charts[id].data.datasets[0]; ds.data=[v,max-v]; ds.backgroundColor=[color,track]; charts[id].update('none'); return; }
  charts[id]=new Chart(el,{type:'doughnut',
    data:{datasets:[{data:[v,max-v],backgroundColor:[color,track],borderWidth:0}]},
    options:{responsive:true,maintainAspectRatio:false,rotation:-126,circumference:252,cutout:'73%',
      events:[],animation:{duration:350},
      plugins:{legend:{display:false},tooltip:{enabled:false},datalabels:{display:false}}}});
}
function gfSpark(id,arr,color){
  const el=document.getElementById(id); if(!el) return;
  if(charts[id]){ const c=charts[id]; c.data.labels=arr.map((_,i)=>i);
    c.data.datasets[0].data=arr.slice(); c.data.datasets[0].borderColor=color;
    c.data.datasets[0].backgroundColor=gfFade(el,color); c.update('none'); return; }
  charts[id]=new Chart(el,{type:'line',
    data:{labels:arr.map((_,i)=>i),datasets:[{data:arr.slice(),borderColor:color,borderWidth:1.7,
      fill:true,backgroundColor:gfFade(el,color),tension:.35,pointRadius:0}]},
    options:{responsive:true,maintainAspectRatio:false,events:[],animation:false,
      scales:{x:{display:false},y:{display:false,grace:'10%'}},
      plugins:{legend:{display:false},tooltip:{enabled:false},datalabels:{display:false}}}});
}
function gfTs(){
  const id='gfTempTs', el=document.getElementById(id); if(!el) return;
  const col=C.ok;
  if(charts[id]){ const c=charts[id]; c.data.labels=GF.t.slice(); c.data.datasets[0].data=GF.temp.slice(); c.update('none'); return; }
  charts[id]=new Chart(el,{type:'line',
    data:{labels:GF.t.slice(),datasets:[{data:GF.temp.slice(),borderColor:col,borderWidth:2,
      fill:true,backgroundColor:gfFade(el,col),tension:.3,pointRadius:0}]},
    options:{responsive:true,maintainAspectRatio:false,animation:false,interaction:{intersect:false,mode:'index'},
      scales:{x:{grid:{display:false},ticks:{color:C.dim,font:{size:10},maxTicksLimit:6,maxRotation:0}},
              y:{grid:{color:C.grid},ticks:{color:C.dim,font:{size:10}}}},
      plugins:{legend:{display:false},datalabels:{display:false},tooltip:{enabled:true}}}});
}
function gfPush(d){
  if(!d) return;
  const n=new Date(), lbl=`${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
  GF.cpu.push(d.cpu); GF.temp.push(d.temp); GF.down.push(d.down_kbps||0); GF.up.push(d.up_kbps||0); GF.t.push(lbl);
  ['cpu','temp','down','up','t'].forEach(k=>{ while(GF[k].length>GF.MAX) GF[k].shift(); });
  GF._seen=lbl;
}
function gfRender(d){
  if(!d) return;
  gfGauge('gfgTemp',d.temp,90,gfColor('temp',d.temp));
  gfGauge('gfgCpu', d.cpu, 100,gfColor('cpu', d.cpu));
  gfGauge('gfgRam', d.ram, 100,gfColor('ram', d.ram));
  gfGauge('gfgDisk',d.disk,100,gfColor('disk',d.disk));
  setHtml('gfgTempV',d.temp.toFixed(1)+'<small>°C</small>');
  setHtml('gfgCpuV', d.cpu.toFixed(0)+'<small>%</small>');
  setHtml('gfgRamV', d.ram.toFixed(0)+'<small>%</small>');
  setHtml('gfgDiskV',d.disk.toFixed(0)+'<small>%</small>');
  const down=document.getElementById('gfDown'); if(down) down.textContent=fmtSpeed(d.down_kbps||0);
  const up=document.getElementById('gfUp');     if(up)   up.textContent=fmtSpeed(d.up_kbps||0);
  setHtml('gfCpuBig',d.cpu.toFixed(0)+'<small>%</small>');
  gfSpark('gfSpDown',GF.down,C.info);
  gfSpark('gfSpUp',  GF.up,  C.ok);
  gfSpark('gfSpCpu', GF.cpu, C.accent);
  gfTs();
  setText('gfTsCount',GF.temp.length+' pts');
  if(d.uptime) setText('gfUptime',uptimeFmt(d.uptime));
  setText('gfHost', d.hostname||'--');
  if(d.model) setText('gfModel',shortModel(d.model));
  if(d.ip)    setText('gfIP',d.ip);
  setText('gfMode',MODE==='cloud'?'CLOUD':'LAN');
  setText('gfSeen',GF._seen||'--');
}
function setupGrafana(){
  gfReady=true;
  if(window.lastData) gfRender(window.lastData);
  else { gfGauge('gfgTemp',0,90,C.info); gfGauge('gfgCpu',0,100,C.info);
         gfGauge('gfgRam',0,100,C.purple); gfGauge('gfgDisk',0,100,C.warn); gfTs(); }
  if(window.lucide) lucide.createIcons();
}
function gfRerender(){
  if(!gfReady) return;
  ['gfgTemp','gfgCpu','gfgRam','gfgDisk','gfSpDown','gfSpUp','gfSpCpu','gfTempTs']
    .forEach(id=>{ if(charts[id]){ charts[id].destroy(); delete charts[id]; } });
  gfRender(window.lastData);
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
      if(!d.ok){ toast('AdGuard: '+(d.error||'ทำคำสั่งไม่สำเร็จ'),'error'); return; }
      if(d.adguard){ updateAdguard(d.adguard); toast('อัปเดต AdGuard แล้ว','ok'); }
    }catch(e){ toast('error: '+(e?.message||e),'error'); }
  } else {
    try{
      let user=auth.currentUser;
      if(!user){ const c=await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); user=c.user; }
      await db.collection('commands').doc('adguard').set({
        enabled, duration:duration||0,
        requested_at:firebase.firestore.FieldValue.serverTimestamp(),
        requested_by:user.email||user.uid, handled:false,
      });
      toast('ส่งคำสั่งแล้ว — Pi จะอัปเดตภายใน ~15 วินาที','info');
    }catch(e){ toast('error: '+(e?.message||e),'error'); }
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
  const dh=document.getElementById('dashHead');
  if(dh) dh.style.display = (name==='temp') ? '' : 'none';   // dashboard head โชว์เฉพาะแท็บ "อุณหภูมิ"
  applyAdguardVisibility();   // โชว์ AdGuard เฉพาะแท็บ "อุณหภูมิ"

  if(deviceTimer){ clearInterval(deviceTimer); deviceTimer=null; }

  if(!panelLoaded[name]){
    panelLoaded[name]=true;
    if(name==='temp') loadDatePanel('temp');
    else if(name==='grafana') setupGrafana();
    else if(name==='system'){ loadUsageCompare(); loadDatePanel('system'); }
    else if(name==='monthly'){ loadMonthlyCompare(); loadMonthly(); }
    else if(name==='history') setupHistory();
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
document.getElementById('settingsModal').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeSettings(); });
document.getElementById('alertsModal').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeAlerts(); });

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
    toast('สั่ง '+action+' ไม่สำเร็จ: '+(e?.message||e),'error');
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
  const pw   = document.getElementById('loginPw').value;
  const err  = document.getElementById('loginErr');
  const btn  = document.getElementById('loginBtn');
  btn.disabled = true; err.textContent = '';
  try {
    const r = await fetch('/api/login',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:pw}),
    });
    if(r.ok){ hideLogin(); startLocal(); return; }
    const d=await r.json().catch(()=>({}));
    err.textContent = d.error || 'เข้าสู่ระบบไม่สำเร็จ';
    btn.disabled=false;
  } catch(e){ err.textContent='เชื่อมต่อไม่ได้'; btn.disabled=false; }
}

async function doLogout(){
  if(MODE==='cloud' && auth){ try{ await auth.signOut(); }catch(e){} location.reload(); return; }
  try { await fetch('/api/logout',{method:'POST'}); } catch(e){}
  location.reload();
}

// ─── security: sessions (LAN เท่านั้น) ───────────────────────────────────────────
async function loadSecurity(){
  const row=document.getElementById('secRow'); if(!row) return;
  if(MODE!=='local'){ row.style.display='none'; return; }
  row.style.display='';
  document.getElementById('secHint').textContent='';
  loadSessions();
}
async function loadSessions(){
  const el=document.getElementById('secSessions'); if(!el) return;
  try{
    const ss=(await fetch('/api/sessions').then(r=>r.json())).sessions||[];
    if(!ss.length){ el.innerHTML='<div class="proc-empty">—</div>'; return; }
    el.innerHTML=ss.map(s=>{
      const dev=(s.ua||'').replace(/\(.*?\)/g,'').slice(0,40).trim()||'unknown';
      return `<div class="sess-row ${s.current?'cur':''}">
        <div class="sess-main"><div class="sess-ip">${s.ip||'?'} ${s.current?'<span class="sess-cur-badge">อุปกรณ์นี้</span>':''}</div>
        <div class="sess-meta">${dev} · ล่าสุด ${(s.last_seen||'').slice(5,16)}</div></div>
        ${s.current?'':`<button class="sess-revoke" title="เพิกถอน" onclick="revokeSession('${s.sid}')"><i data-lucide="x"></i></button>`}
      </div>`;
    }).join('');
    if(window.lucide) lucide.createIcons();
  }catch(e){ el.innerHTML='<div class="proc-empty">โหลดไม่สำเร็จ</div>'; }
}
async function revokeSession(sid){
  try{ await fetch('/api/sessions/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sid})}); loadSessions(); }catch(e){}
}
async function revokeOthers(){
  try{ await fetch('/api/sessions/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({all:true})}); loadSessions(); toast('ออกจากระบบอุปกรณ์อื่นแล้ว','ok'); }catch(e){}
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
  syncCloudSettings();
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
  syncCloudSettings();
}

function startDashboard(){
  applyAdguardVisibility();            // โชว์การ์ด AdGuard (skeleton) ทันทีระหว่างรอข้อมูล
  loadCompare();
  loadDash24();
  initAlerts();
  loadDatePanel('temp');
  panelLoaded['temp'] = true;
  setInterval(()=>{ loadCompare(); loadDash24(); loadAlertCfg(); }, 300000);   // refresh ทุก 5 นาที
}

async function init(){
  syncChartColors();
  applyThemeIcon();
  MODE = await detectMode();
  const badge = document.getElementById('modeBadge');
  badge.innerHTML = MODE==='local' ? '<i data-lucide="network"></i>LAN' : '<i data-lucide="cloud"></i>Cloud';
  if(window.lucide) lucide.createIcons();
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
