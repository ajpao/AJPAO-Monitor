/* AJPAO-Monitor dashboard — โค้ดเดียวใช้ได้ทั้ง LAN และ Cloud
 *
 *   LOCAL mode : เปิดจาก Pi (Flask) → ดึงข้อมูลผ่าน /api/*  (SQLite)
 *   CLOUD mode : เปิดจาก Firebase Hosting → ดึงข้อมูลจาก Firestore
 *
 * ตรวจโหมดอัตโนมัติ: ลอง fetch('/api/status') ถ้าได้ JSON ที่มี field temp → LOCAL ไม่งั้น → CLOUD
 */

// ─── Firebase config (ใช้เฉพาะ CLOUD mode — กรอกจาก Firebase Console > Project settings > Web app) ───
const firebaseConfig = {
  apiKey:            "REPLACE_API_KEY",
  authDomain:        "REPLACE_PROJECT.firebaseapp.com",
  projectId:         "REPLACE_PROJECT",
  storageBucket:     "REPLACE_PROJECT.appspot.com",
  messagingSenderId: "REPLACE_SENDER_ID",
  appId:             "REPLACE_APP_ID",
};

Chart.register(ChartDataLabels);

const C = {
  blue: '#4a9fd4', green: '#5dcaa5', yellow: '#f0c040',
  red: '#e05252', orange: '#e09a3a', muted: '#8b949e',
  text: '#e6edf3', grid: 'rgba(48,54,61,0.8)', bg2: '#161b22'
};
const charts = {};

let MODE = null;        // 'local' | 'cloud'
let db = null;          // firestore (cloud)
let auth = null;        // firebase auth (cloud)
let latestStatus = null;

// ─── chart helpers (ใช้ร่วมทั้งสองโหมด) ─────────────────────────────────────────

function summaryHtml(data, unit = '°C') {
  if (!data.length) return '';
  const mn = Math.min(...data), mx = Math.max(...data);
  const avg = data.reduce((a, b) => a + b, 0) / data.length;
  return `
    <div class="summary-item"><span class="s-label">MIN</span><span class="s-val s-min">${mn.toFixed(1)}${unit}</span></div>
    <div class="summary-item"><span class="s-label">AVG</span><span class="s-val s-avg">${avg.toFixed(1)}${unit}</span></div>
    <div class="summary-item"><span class="s-label">MAX</span><span class="s-val s-max">${mx.toFixed(1)}${unit}</span></div>`;
}

function autoRange(data, minPad = 1) {
  const mn = Math.min(...data), mx = Math.max(...data);
  const pad = Math.max((mx - mn) * 0.5, minPad);
  return { min: Math.max(0, mn - pad), max: mx + pad + (mx - mn) * 0.2 };
}

function makeBar(id, labels, data, color, unit = '%') {
  if (charts[id]) charts[id].destroy();
  if (!data.length) return;
  const range = autoRange(data);
  charts[id] = new Chart(document.getElementById(id), {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: data.map(v => v >= 80 ? C.red : v >= 50 ? C.orange : color), borderRadius: 4, borderSkipped: false }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y.toFixed(1)}${unit}` } },
        datalabels: { anchor: 'end', align: 'end', offset: 2, color: C.muted, font: { size: 9, weight: 'bold' }, formatter: v => v.toFixed(1) }
      },
      layout: { padding: { top: 20 } },
      scales: {
        x: { ticks: { color: C.muted, font: { size: 10 } }, grid: { color: C.grid } },
        y: { ...range, ticks: { color: C.muted, font: { size: 10 }, callback: v => v.toFixed(0) + unit }, grid: { color: C.grid } }
      }
    }
  });
}

function makeTempBar(id, labels, data) {
  if (charts[id]) charts[id].destroy();
  if (!data.length) return;
  const mn = Math.min(...data), mx = Math.max(...data);
  charts[id] = new Chart(document.getElementById(id), {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: data.map(v => v >= 55 ? C.red : v >= 50 ? C.orange : C.blue), borderRadius: 4, borderSkipped: false }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y.toFixed(1)}°C` } },
        datalabels: { anchor: 'end', align: 'end', offset: 2, color: C.muted, font: { size: 9, weight: 'bold' }, formatter: v => v.toFixed(1) }
      },
      layout: { padding: { top: 20 } },
      scales: {
        x: { ticks: { color: C.muted, font: { size: 10 } }, grid: { color: C.grid } },
        y: { min: Math.max(0, mn - 5), max: mx + 8, ticks: { color: C.muted, font: { size: 10 }, callback: v => v + '°' }, grid: { color: C.grid } }
      }
    }
  });
}

function updateCards(d) {
  if (!d) return;
  document.getElementById('sTemp').textContent = d.temp.toFixed(1) + '°';
  document.getElementById('sCpu').textContent  = d.cpu.toFixed(1) + '%';
  document.getElementById('sRam').textContent  = d.ram.toFixed(1) + '%';
  document.getElementById('sDisk').textContent = d.disk.toFixed(1) + '%';
  document.getElementById('sRamFree').textContent  = `ว่าง ${d.ram_free_mb} MB`;
  document.getElementById('sDiskFree').textContent = `ว่าง ${d.disk_free_gb} GB`;
  const st = d.temp >= 70 ? '🔥 ร้อนมาก!' : d.temp >= 55 ? '⚠️ อุ่น' : d.temp >= 50 ? '🟡 เริ่มอุ่น' : '✅ ปกติ';
  const tc = d.temp >= 70 ? C.red : d.temp >= 55 ? C.orange : d.temp >= 50 ? C.yellow : C.blue;
  document.getElementById('sTemp').style.color = tc;
  document.getElementById('tempTopBar').style.background = tc;
  document.getElementById('sTempStatus').textContent = st;
}

// ─── date / bucket helpers (CLOUD mode) ─────────────────────────────────────────

const pad = n => String(n).padStart(2, '0');
const fmtHM   = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDMHM = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:00`;
const round1  = a => Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10;

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function startOfMonth() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); }
function hoursAgo(n) { return new Date(Date.now() - n * 3600 * 1000); }

async function fsReadings(start) {
  const snap = await db.collection('readings').where('ts', '>=', start).orderBy('ts').get();
  return snap.docs.map(doc => {
    const x = doc.data();
    return { ts: x.ts.toDate(), temp: x.temp_c, cpu: x.cpu_pct, ram: x.ram_pct, disk: x.disk_pct };
  });
}

function bucket(rows, field, byDay) {
  const map = new Map();
  for (const r of rows) {
    const d = new Date(r.ts);
    if (byDay) d.setHours(0, 0, 0, 0); else d.setMinutes(0, 0, 0);
    const k = d.getTime();
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r[field]);
  }
  const keys = [...map.keys()].sort((a, b) => a - b);
  return { dates: keys.map(k => new Date(k)), vals: keys.map(k => round1(map.get(k))) };
}

// ─── data sources (สลับตามโหมด) ─────────────────────────────────────────────────

const local = {
  today:      () => fetch('/api/today').then(r => r.json()),
  history:    () => fetch('/api/history').then(r => r.json()),
  monthly:    () => fetch('/api/monthly').then(r => r.json()),
  sysToday:   () => fetch('/api/system_today').then(r => r.json()),
  sysMonthly: () => fetch('/api/system_monthly').then(r => r.json()),
};

const cloud = {
  today: async () => {
    const b = bucket(await fsReadings(startOfToday()), 'temp', false);
    return { labels: b.dates.map(fmtHM), data: b.vals };
  },
  history: async () => {
    const b = bucket(await fsReadings(hoursAgo(24)), 'temp', false);
    return { labels: b.dates.map(fmtDMHM), data: b.vals };
  },
  monthly: async () => {
    const b = bucket(await fsReadings(startOfMonth()), 'temp', true);
    return { labels: b.dates.map(d => String(d.getDate())), data: b.vals, month: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) };
  },
  sysToday: async () => {
    const rows = await fsReadings(startOfToday());
    const c = bucket(rows, 'cpu', false), r = bucket(rows, 'ram', false), dk = bucket(rows, 'disk', false);
    return { labels: c.dates.map(fmtHM), cpu: c.vals, ram: r.vals, disk: dk.vals };
  },
  sysMonthly: async () => {
    const rows = await fsReadings(startOfMonth());
    const c = bucket(rows, 'cpu', true), r = bucket(rows, 'ram', true), dk = bucket(rows, 'disk', true);
    return { labels: c.dates.map(d => String(d.getDate())), cpu: c.vals, ram: r.vals, disk: dk.vals,
             month: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) };
  },
};

let SRC = local;   // ตั้งค่าจริงตอน init

// ─── chart loaders ──────────────────────────────────────────────────────────────

async function loadToday() {
  const d = await SRC.today();
  makeTempBar('todayChart', d.labels, d.data);
  document.getElementById('todaySummary').innerHTML = summaryHtml(d.data, '°C');
}
async function loadHistory() {
  const d = await SRC.history();
  makeTempBar('historyChart', d.labels, d.data);
  document.getElementById('historySummary').innerHTML = summaryHtml(d.data, '°C');
}
async function loadMonthly() {
  const d = await SRC.monthly();
  if (d.month) document.getElementById('monthlyTitle').textContent = `อุณหภูมิรายวัน — ${d.month}`;
  makeTempBar('monthlyChart', d.labels, d.data);
  document.getElementById('monthlySummary').innerHTML = summaryHtml(d.data, '°C');
}
async function loadSysToday() {
  const d = await SRC.sysToday();
  makeBar('sysTodayCpu', d.labels, d.cpu, C.blue, '%');
  makeBar('sysTodayRam', d.labels, d.ram, C.green, '%');
  makeBar('sysTodayDisk', d.labels, d.disk, C.yellow, '%');
  document.getElementById('sysTodayCpuSum').innerHTML  = summaryHtml(d.cpu, '%');
  document.getElementById('sysTodayRamSum').innerHTML  = summaryHtml(d.ram, '%');
  document.getElementById('sysTodayDiskSum').innerHTML = summaryHtml(d.disk, '%');
}
async function loadSysMonthly() {
  const d = await SRC.sysMonthly();
  if (d.month) document.getElementById('sysMonthlyTitle').textContent = `CPU % — ${d.month}`;
  makeBar('sysMonthlyCpu', d.labels, d.cpu, C.blue, '%');
  makeBar('sysMonthlyRam', d.labels, d.ram, C.green, '%');
  makeBar('sysMonthlyDisk', d.labels, d.disk, C.yellow, '%');
  document.getElementById('sysMonthlyCpuSum').innerHTML  = summaryHtml(d.cpu, '%');
  document.getElementById('sysMonthlyRamSum').innerHTML  = summaryHtml(d.ram, '%');
  document.getElementById('sysMonthlyDiskSum').innerHTML = summaryHtml(d.disk, '%');
}

const tabLoaders = { today: loadToday, history: loadHistory, monthly: loadMonthly, sysToday: loadSysToday, sysMonthly: loadSysMonthly };
const loaded = {};

function switchTab(name, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  if (!loaded[name]) { tabLoaders[name](); loaded[name] = true; }
}

// ─── status (live) ──────────────────────────────────────────────────────────────

async function pollStatusLocal() {
  try { updateCards(await fetch('/api/status').then(r => r.json())); } catch (e) {}
}

function watchStatusCloud() {
  db.collection('status').doc('latest').onSnapshot(doc => {
    if (!doc.exists) return;
    const x = doc.data();
    latestStatus = { temp: x.temp_c, cpu: x.cpu_pct, ram: x.ram_pct, disk: x.disk_pct,
                     ram_free_mb: x.ram_free_mb, disk_free_gb: x.disk_free_gb };
    updateCards(latestStatus);
  });
}

// ─── reboot ──────────────────────────────────────────────────────────────────────

function confirmReboot() {
  document.getElementById('rebootMsg').textContent = (MODE === 'cloud')
    ? 'ต้อง login ก่อนถึงจะสั่ง Reboot ได้ — Pi จะ Restart และใช้เวลา 1-2 นาที'
    : 'Raspberry Pi จะ Restart และใช้เวลาประมาณ 1-2 นาทีกว่าจะกลับมา';
  document.getElementById('rebootModal').style.display = 'flex';
}
function closeReboot() { document.getElementById('rebootModal').style.display = 'none'; }

async function doReboot() {
  closeReboot();
  const btn = document.getElementById('rebootBtn');
  btn.textContent = '⟳ Rebooting...'; btn.disabled = true; btn.style.opacity = '0.5';
  try {
    if (MODE === 'local') {
      await fetch('/api/reboot', { method: 'POST' });
    } else {
      let user = auth.currentUser;
      if (!user) {
        const cred = await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
        user = cred.user;
      }
      await db.collection('commands').doc('reboot').set({
        requested_at: firebase.firestore.FieldValue.serverTimestamp(),
        requested_by: user.email || user.uid,
        handled: false,
      });
    }
  } catch (e) {
    alert('สั่ง Reboot ไม่สำเร็จ: ' + (e && e.message ? e.message : e));
    btn.textContent = '⟳ REBOOT'; btn.disabled = false; btn.style.opacity = '1';
  }
}

document.getElementById('rebootModal').addEventListener('click', function (e) { if (e.target === this) closeReboot(); });

// ─── init ─────────────────────────────────────────────────────────────────────

async function detectMode() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (r.ok && (r.headers.get('content-type') || '').includes('application/json')) {
      const d = await r.json();
      if (typeof d.temp === 'number') return 'local';
    }
  } catch (e) {}
  return 'cloud';
}

async function init() {
  MODE = await detectMode();
  const badge = document.getElementById('modeBadge');
  badge.textContent = MODE === 'local' ? '🏠 LAN' : '☁️ Cloud';
  badge.classList.add(MODE);

  if (MODE === 'local') {
    SRC = local;
    pollStatusLocal();
    setInterval(pollStatusLocal, 10000);
  } else {
    SRC = cloud;
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    auth = firebase.auth();
    watchStatusCloud();
  }

  loadToday();
  loaded['today'] = true;
}

// clock
setInterval(() => {
  const now = new Date();
  document.getElementById('hTime').textContent =
    now.toLocaleDateString('th-TH') + ' ' + now.toLocaleTimeString('th-TH');
}, 1000);

init();
