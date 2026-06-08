# 🍓 AJPAO-Monitor

ระบบ monitor **Raspberry Pi** แบบไฟล์เดียวจบ — เก็บ **อุณหภูมิ / CPU / RAM / Disk**, ควบคุมเครื่อง, ดูสถิติ **AdGuard Home**, และมี **Web Terminal** ในตัว ดู dashboard ได้ทั้งใน **บ้าน (LAN)** และ **บน cloud** ข้อมูล **sync กันตลอด**

| ดูที่ไหน | URL | แหล่งข้อมูล | ต้อง login |
|----------|-----|------------|-----------|
| 🏠 ในบ้าน (LAN) | `http://<ip-ของ-pi>:5000` | Flask + SQLite (ใช้ได้แม้เน็ตหลุด) | รหัสผ่าน (ถ้าตั้ง `WEB_PASSWORD`) |
| ☁️ จากที่ไหนก็ได้ | `https://<project>.web.app` | Firebase Hosting + Firestore | Google sign-in |

`monitor.py` ตัวเดียวรันพร้อมกันหลาย thread: เก็บข้อมูล → SQLite + Firestore, เสิร์ฟ dashboard + API (LAN), Telegram bot, รายงานรายวัน, รับคำสั่ง reboot/shutdown/AdGuard จาก cloud และ Web Terminal (PTY) ผ่าน WebSocket

---

## ✨ ฟีเจอร์

**Dashboard**
- 📊 การ์ดสถานะสด: Temperature / CPU / RAM / Disk
- 🌡️ กราฟ **"วันนี้ vs เมื่อวาน"** + บทวิเคราะห์แนวโน้มอัตโนมัติ
- 📅 **เลือกดูย้อนหลังรายวัน** (date picker) ทั้งอุณหภูมิและ Usage + มุมมองรายเดือน (Monthly)
- 🖥️ การ์ด **ข้อมูล Pi** (model, hostname, IP, network speed, uptime)
- 🌓 **สลับธีม Dark / Light** (จำค่าไว้, default = Dark)
- 📱 Responsive รองรับมือถือ

**System (แท็บ "System")**
- 🌐 Network: IP ทุก interface, สถานะอินเทอร์เน็ต, ความเร็ว ↓↑, ยอดรวมรับ-ส่ง
- 💻 OS & Hardware: รุ่นบอร์ด, OS, kernel, python, uptime
- ⚙️ **Service Manager** — start / stop / restart services (allowlist)
- 📋 **Top Processes** — process ที่กิน CPU/RAM สูงสุด (เหมือน task manager)

**AdGuard Home (แท็บ "อุณหภูมิ" ล่างสุด)**
- 🛡️ Total Queries / Blocked / Block Rate % แบบเรียลไทม์ + Skeleton loader
- 🔘 ควบคุม Protection: เปิด/ปิด + **Pause 5 Mins**
- 🏆 **Top 5** Blocked Domains / Queried Domains / Clients
- ⚠️ แสดง "AdGuard Offline" เมื่อต่อ API ไม่ได้ (ระบบไม่ค้าง)

**ควบคุม / ความปลอดภัย**
- ⟳ **Reboot** / ⏻ **Shutdown** ผ่านเว็บ (มี modal ยืนยัน)
- 💻 **Web Terminal (PTY)** — interactive shell เต็มรูปแบบบนเว็บ (LAN, ต้อง login)
- 🔐 **Login** — LAN ใช้รหัสผ่าน, Cloud ใช้ Google sign-in
- 🤖 **Telegram bot** — เช็คสถานะ/กราฟ/reboot จากมือถือ

---

## โครงสร้าง

```
AJPAO-Monitor/
├── monitor.py              # ⭐ ทุกอย่างฝั่ง Pi (collector + web + api + bot + ws)
├── requirements.txt
├── .env.example            # คัดลอกเป็น .env แล้วใส่ค่าจริง
├── ajpao-monitor.service   # systemd unit
├── web/public/             # dashboard (ใช้ทั้ง LAN + Cloud)
│   ├── index.html
│   └── app.js              # ← กรอก firebaseConfig ตรงนี้
├── import_old.py           # (ครั้งเดียว) นำเข้าข้อมูลย้อนหลังจาก db เก่า
├── import_telegram.py      # (ครั้งเดียว) นำเข้าข้อมูลจาก Telegram chat export
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
└── .firebaserc             # ← ใส่ project id
```

> **ไม่ commit ขึ้น git:** `.env`, `serviceAccountKey.json`, `.flask_secret`, `*.db` (อยู่ใน `.gitignore` แล้ว)

---

## ตั้งค่าครั้งแรก

### 1) ฝั่ง Pi

```bash
git clone <repo-url> ~/AJPAO-Monitor
cd ~/AJPAO-Monitor
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
nano .env          # ใส่ค่าตามตารางด้านล่าง
```

วาง **service account key** ที่ `~/AJPAO-Monitor/serviceAccountKey.json`
(Firebase Console → ⚙️ Project settings → Service accounts → *Generate new private key*)
> ถ้าไม่มีไฟล์นี้ ตัวโปรแกรมจะรันแบบ **local-only** อัตโนมัติ (ไม่ sync cloud)

ทดสอบรัน แล้วเปิด `http://<ip-pi>:5000`:
```bash
python3 monitor.py
```

ติดตั้งเป็น service ให้รันตลอด + auto-start ตอนบูต:
```bash
sudo cp ajpao-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ajpao-monitor
journalctl -u ajpao-monitor -f      # ดู log
```

ปุ่ม Reboot/Shutdown และ Service Manager สั่ง `sudo` โดยไม่ถามรหัส — ต้องตั้ง sudoers:
```bash
# เปิดสิทธิ์เฉพาะคำสั่งที่ใช้ (ปลอดภัยกว่า NOPASSWD: ALL)
echo 'ajpao ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown, /usr/bin/systemctl' \
  | sudo tee /etc/sudoers.d/ajpao-monitor
```

### 2) ฝั่ง Firebase (cloud dashboard)

- ใส่ project id ใน [.firebaserc](.firebaserc)
- กรอก `firebaseConfig` ใน [web/public/app.js](web/public/app.js) (Console → Project settings → Your apps → Web app)
- เปิดใช้ **Firestore** และ **Authentication → Google** ใน Firebase Console
- ตั้ง **Firestore rules** ตาม [firestore.rules](firestore.rules) (อ่านได้เฉพาะผู้ที่ login)
- deploy:
```bash
firebase deploy --only hosting
# rules/indexes: ตั้งผ่าน Console ถ้า service account ไม่มีสิทธิ์ deploy
```

---

## ⚙️ ตัวแปรใน `.env`

| ตัวแปร | ค่าเริ่มต้น | ใช้ทำอะไร |
|--------|-----------|-----------|
| `BOT_TOKEN` | — | Telegram bot token (`@BotFather`) |
| `CHAT_ID` / `ALLOWED_IDS` | — | chat id ที่อนุญาตให้สั่งบอท |
| `WEB_PASSWORD` | *(ว่าง)* | รหัส login dashboard LAN — **ว่าง = ไม่บังคับ login** |
| `MANAGED_SERVICES` | `AdGuardHome,plexmediaserver,transmission-daemon,ssh` | รายชื่อ service ที่สั่ง start/stop/restart ได้ (allowlist) |
| `EXEC_TIMEOUT` | `30` | timeout ของ Web Terminal (วินาที) |
| `ADGUARD_IP` | *(ว่าง)* | IP ของ AdGuard Home — **ว่าง = ปิดฟีเจอร์** |
| `ADGUARD_PORT` | `80` | พอร์ต control API ของ AdGuard |
| `ADGUARD_USER` / `ADGUARD_PASSWORD` | — | Basic Auth ของ AdGuard |
| `PORT` | `5000` | พอร์ต Flask |
| `TEMP_ALERT` | `55` | เกินกี่ °C แจ้งเตือนด่วน |
| `COLLECT_INTERVAL` | `600` | เก็บข้อมูลทุกกี่วินาที |

---

## 🌐 HTTP API (LAN) + WebSocket

| endpoint | ใช้ทำอะไร |
|----------|-----------|
| `GET /api/ping` | ตรวจว่าเป็น LAN + ต้อง login ไหม (เปิด) |
| `POST /api/login` · `POST /api/logout` · `GET /api/me` | ระบบ login (session cookie) |
| `GET /api/status` | สถานะสด + os/network speed + adguard |
| `GET /api/date?date=YYYY-MM-DD` | ข้อมูลรายชั่วโมงของวันที่เลือก |
| `GET /api/monthly` · `/api/system_monthly` | สรุปรายวันของเดือนนี้ |
| `GET /api/sysinfo` | network / OS / top processes (สด) |
| `GET /api/services` · `POST /api/service/<name>/<start\|stop\|restart>` | Service Manager |
| `POST /api/adguard/protection` | เปิด/ปิด AdGuard protection |
| `POST /api/reboot` · `POST /api/shutdown` | ควบคุมเครื่อง |
| `WS /ws/terminal` | Web Terminal (PTY) |

> ทุก endpoint ข้อมูล/ควบคุมต้อง login ก่อน (ถ้าตั้ง `WEB_PASSWORD`)

---

## 🔥 Firestore data model

| path | ใช้ทำอะไร |
|------|-----------|
| `status/latest` | snapshot ล่าสุด (stat cards, os/net info, adguard, top5) — overwrite ทุกรอบ |
| `readings/{id}` | 1 doc/การวัด (`ts, temp_c, cpu_pct, ram_pct, disk_pct`) สำหรับกราฟ |
| `commands/reboot` · `commands/shutdown` · `commands/adguard` | คำสั่งจาก cloud dashboard (Pi คอย poll) |

การ sync: Pi เขียน SQLite ก่อนเสมอ แล้ว push Firestore แบบ best-effort — แถวที่ยังไม่ขึ้น cloud (`synced=0`) จะถูก backfill รอบถัดไป → cloud ตามทันเสมอแม้เคยเน็ตหลุด

---

## 🤖 Telegram bot

`/status` `/temp` `/system` `/today` `/systemtoday` `/history` `/monthly` `/systemmonthly` `/reboot` `/help`

---

## ⚠️ ความปลอดภัย

- ตั้ง **`WEB_PASSWORD`** เสมอ ถ้าเปิดฟีเจอร์ควบคุม (reboot/shutdown/terminal/service) บน LAN
- Web Terminal รันด้วยสิทธิ์เต็มของผู้ใช้ — ป้องกันด้วย login เท่านั้น
- Bot token ของชุดเดิมเคยหลุด — ใช้ **token ใหม่** เท่านั้น (`@BotFather` → revoke)
- `serviceAccountKey.json`, `.env`, `.flask_secret` เป็นความลับ — อย่า commit
- `apiKey` ของ Firebase web **ไม่ใช่ความลับ** (ความปลอดภัยอยู่ที่ Firestore rules)
