#!/usr/bin/env python3
"""
import_telegram.py — นำเข้าข้อมูลย้อนหลังจาก Telegram chat export (result.json)

ใช้เติมช่วงที่ db ขาดหาย โดยอ่านข้อความ status ที่บอทเคยส่ง (มี Temp/CPU/RAM/Disk)

    .venv/bin/python3 import_telegram.py /tmp/tg.json

กลยุทธ์กันซ้ำ: dedup ระดับ "ชั่วโมง" — ชั่วโมงไหนที่ db มีข้อมูลอยู่แล้ว (เช่น ช่วง
ที่ import จาก db เก่าแบบ 10 นาที) จะข้าม เก็บเฉพาะชั่วโมงที่ยังว่าง → เติมช่วงที่หาย
"""
import os
import re
import sys
import json
import sqlite3
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
NEW_DB   = os.path.join(BASE_DIR, "temp_data.db")
SERVICE  = os.path.join(BASE_DIR, "serviceAccountKey.json")

src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/tg.json"

RE_TIME = re.compile(r"🕐 (\d{2})/(\d{2})/(\d{4}) (\d{2}):(\d{2})")
RE_TEMP = re.compile(r"Temp:\s*([\d.]+)°C")
RE_CPU  = re.compile(r"CPU:\s*([\d.]+)%")
RE_RAM  = re.compile(r"RAM:\s*([\d.]+)%")
RE_DISK = re.compile(r"Disk:\s*([\d.]+)%")


def flat(t):
    if isinstance(t, str):
        return t
    return "".join(p if isinstance(p, str) else p.get("text", "") for p in t)


def num(rx, s):
    m = rx.search(s)
    return float(m.group(1)) if m else None


# ── อ่าน export ──
data = json.load(open(src, encoding="utf-8"))
msgs = data.get("messages", [])
print(f"[tg] อ่าน {len(msgs)} ข้อความ จาก {src}")

parsed = []
for m in msgs:
    if m.get("from") != "ajpao_bot":
        continue
    txt = flat(m.get("text", ""))
    tm = RE_TIME.search(txt)
    temp = num(RE_TEMP, txt)
    if not tm or temp is None:          # ต้องมีเวลา + อุณหภูมิอย่างน้อย
        continue
    dd, mo, yy, hh, mi = tm.groups()
    ts = f"{yy}-{mo}-{dd} {hh}:{mi}:00"
    parsed.append({
        "ts": ts, "temp": temp,
        "cpu": num(RE_CPU, txt), "ram": num(RE_RAM, txt), "disk": num(RE_DISK, txt),
    })
print(f"[tg] แยกข้อความ status ได้ {len(parsed)} แถว")

# ── ชั่วโมงที่ db มีอยู่แล้ว (กันซ้ำระดับชั่วโมง) ──
con = sqlite3.connect(NEW_DB)
existing_hours = set()
for (t,) in con.execute("SELECT timestamp FROM temperature").fetchall():
    existing_hours.add(t[:13])          # 'YYYY-MM-DD HH'

to_insert, seen_hours = [], set()
for r in sorted(parsed, key=lambda x: x["ts"]):
    hk = r["ts"][:13]
    if hk in existing_hours or hk in seen_hours:
        continue
    seen_hours.add(hk)
    to_insert.append(r)
print(f"[merge] ชั่วโมงใหม่ที่จะเติม {len(to_insert)} แถว (ข้ามที่มีอยู่/ซ้ำ {len(parsed) - len(to_insert)})")

if not to_insert:
    print("ไม่มีอะไรต้องเติม — db ครบแล้ว")
    con.close(); sys.exit(0)

inserted = []
for r in to_insert:
    cur = con.execute(
        "INSERT INTO temperature (timestamp, temp_c, cpu_pct, ram_pct, disk_pct, synced) "
        "VALUES (?,?,?,?,?,0)",
        (r["ts"], r["temp"], r["cpu"], r["ram"], r["disk"]),
    )
    inserted.append((cur.lastrowid, r))
con.commit()
print(f"[sqlite] insert เสร็จ {len(inserted)} แถว")

# แสดงช่วงที่เติม
dates = sorted({r["ts"][:10] for _, r in inserted})
print(f"[range] เติมวันที่: {dates[0]} → {dates[-1]} ({len(dates)} วัน)")

# ── push Firestore ──
if not os.path.exists(SERVICE):
    print("[firestore] ไม่พบ serviceAccountKey.json — ข้าม cloud (backfill loop จะดันเอง)")
    con.close(); sys.exit(0)

import firebase_admin
from firebase_admin import credentials, firestore
firebase_admin.initialize_app(credentials.Certificate(SERVICE))
db_fs = firestore.client()


def aware(dt):
    return dt if dt.tzinfo else dt.astimezone()


batch = db_fs.batch()
n = 0
for rid, r in inserted:
    doc = db_fs.collection("readings").document()
    payload = {"ts": aware(datetime.strptime(r["ts"], "%Y-%m-%d %H:%M:%S")), "temp_c": r["temp"]}
    if r["cpu"]  is not None: payload["cpu_pct"]  = r["cpu"]
    if r["ram"]  is not None: payload["ram_pct"]  = r["ram"]
    if r["disk"] is not None: payload["disk_pct"] = r["disk"]
    batch.set(doc, payload)
    n += 1
    if n >= 400:
        batch.commit(); batch = db_fs.batch(); n = 0
if n:
    batch.commit()

for rid, _ in inserted:
    con.execute("UPDATE temperature SET synced=1 WHERE id=?", (rid,))
con.commit()
con.close()
print(f"[firestore] push + mark synced เสร็จ {len(inserted)} แถว")
print("✅ เสร็จสมบูรณ์")
