# 🍓 AJPAO-Monitor

ระบบ monitor **อุณหภูมิ + CPU/RAM/Disk** ของ Raspberry Pi — ไฟล์เดียวทำทุกอย่าง ดู dashboard ได้ทั้งใน **บ้าน (LAN)** และ **บน cloud** ข้อมูล **sync กันตลอด**

| ดูที่ไหน | URL | แหล่งข้อมูล |
|----------|-----|------------|
| 🏠 ในบ้าน (LAN) | `http://<ip-ของ-pi>:5000` | Flask + SQLite (ใช้ได้แม้เน็ตหลุด) |
| ☁️ จากที่ไหนก็ได้ | `https://<project>.web.app` | Firebase Hosting + Firestore |

`monitor.py` ตัวเดียวรันพร้อมกันหลาย thread: เก็บข้อมูล → SQLite + Firestore, เสิร์ฟ dashboard LAN, Telegram bot, รายงานรายวัน, และรับคำสั่ง reboot จาก cloud

---

## โครงสร้าง

```
AJPAO-Monitor/
├── monitor.py              # ⭐ ทุกอย่างฝั่ง Pi
├── requirements.txt
├── .env.example            # คัดลอกเป็น .env แล้วใส่ค่าจริง
├── ajpao-monitor.service   # systemd unit
├── web/public/             # dashboard (ใช้ทั้ง LAN + Cloud)
│   ├── index.html
│   └── app.js              # ← กรอก firebaseConfig ตรงนี้
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
└── .firebaserc             # ← ใส่ project id
```

> **ไม่ commit ขึ้น git:** `.env`, `serviceAccountKey.json`, `*.db` (อยู่ใน `.gitignore` แล้ว)

---

## ตั้งค่าครั้งแรก

### 1) ฝั่ง Pi

```bash
git clone <repo-url> ~/AJPAO-Monitor
cd ~/AJPAO-Monitor
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
nano .env          # ใส่ BOT_TOKEN, CHAT_ID, ALLOWED_IDS
```

วาง **service account key** ที่ `~/AJPAO-Monitor/serviceAccountKey.json`
(Firebase Console → ⚙️ Project settings → Service accounts → *Generate new private key*)
> ถ้าไม่มีไฟล์นี้ ตัวโปรแกรมจะรันแบบ **local-only** อัตโนมัติ (ไม่ sync cloud)

ทดสอบรัน:
```bash
python3 monitor.py
# เปิด http://<ip-pi>:5000
```

ติดตั้งเป็น service ให้รันตลอด:
```bash
sudo cp ajpao-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ajpao-monitor
journalctl -u ajpao-monitor -f
```

ให้สั่ง `reboot` ได้โดยไม่ถามรหัส (ปุ่ม reboot บน dashboard / Telegram):
```bash
echo 'ajpao ALL=(ALL) NOPASSWD: /sbin/reboot' | sudo tee /etc/sudoers.d/ajpao-reboot
```

### 2) ฝั่ง Firebase (cloud dashboard)

```bash
# ในเครื่องที่มี Firebase CLI
firebase login
```
- ใส่ project id ใน [.firebaserc](.firebaserc) แทน `REPLACE_PROJECT`
- กรอก `firebaseConfig` ใน [web/public/app.js](web/public/app.js) (จาก Console → Project settings → Your apps → Web app)
- เปิดใช้ **Firestore** และ **Authentication → Google** ใน Firebase Console
- deploy:
```bash
firebase deploy --only hosting,firestore:rules,firestore:indexes
```

---

## Firestore data model

| path | ใช้ทำอะไร |
|------|-----------|
| `status/latest` | snapshot ล่าสุด (stat cards) — overwrite ทุกรอบ |
| `readings/{id}` | 1 doc/การวัด (`ts, temp_c, cpu_pct, ram_pct, disk_pct`) สำหรับกราฟ |
| `commands/reboot` | คำสั่ง reboot จาก cloud dashboard (Pi คอย poll) |

การ sync: Pi เขียน SQLite ก่อนเสมอ แล้ว push Firestore แบบ best-effort — แถวที่ยังไม่ขึ้น cloud (`synced=0`) จะถูก backfill รอบถัดไป → cloud ตามทันเสมอแม้เคยเน็ตหลุด

---

## Reboot

- **LAN dashboard** — กดได้เลย (เครือข่ายในบ้าน trusted) → `POST /api/reboot`
- **Cloud dashboard** — ต้อง login (Google) ก่อน → เขียน `commands/reboot` → Pi เห็นแล้ว reboot
- **Telegram** — `/reboot` (จำกัดด้วย `ALLOWED_IDS`)

---

## Telegram bot

`/status` `/temp` `/system` `/today` `/systemtoday` `/history` `/monthly` `/systemmonthly` `/reboot` `/help`

---

## ⚠️ ความปลอดภัย

- Bot token ของชุดเดิมเคยหลุด — ใช้ **token ใหม่** เท่านั้น (`@BotFather` → `/revoke`)
- `serviceAccountKey.json` และ `.env` เป็นความลับ — อย่า commit
- `apiKey` ของ Firebase web **ไม่ใช่ความลับ** ใส่ใน `app.js` / commit ได้ปกติ (ความปลอดภัยอยู่ที่ Firestore rules)
