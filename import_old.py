#!/usr/bin/env python3
"""
import_old.py — นำเข้าข้อมูลย้อนหลังจาก db เก่า เข้า AJPAO-Monitor (SQLite + Firestore)

ใช้ครั้งเดียว:
    .venv/bin/python3 import_old.py /tmp/old_win.db

- อ่านทุกแถวจาก db เก่า (ตาราง temperature)
- insert เข้า ~/AJPAO-Monitor/temp_data.db โดยข้าม timestamp ที่มีอยู่แล้ว (กันซ้ำ)
- push ขึ้น Firestore (readings) แล้ว mark synced=1 ทันที
"""
import os
import sys
import sqlite3
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
NEW_DB   = os.path.join(BASE_DIR, "temp_data.db")
SERVICE  = os.path.join(BASE_DIR, "serviceAccountKey.json")

old_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/old_win.db"

# ── อ่าน db เก่า ──
old = sqlite3.connect(old_path)
rows = old.execute(
    "SELECT timestamp, temp_c, cpu_pct, ram_pct, disk_pct FROM temperature ORDER BY timestamp"
).fetchall()
old.close()
print(f"[old] อ่านได้ {len(rows)} แถว จาก {old_path}")

# ── timestamp ที่มีอยู่แล้วใน db ใหม่ (กันซ้ำ) ──
new = sqlite3.connect(NEW_DB)
existing = {r[0] for r in new.execute("SELECT timestamp FROM temperature").fetchall()}
print(f"[new] มีอยู่แล้ว {len(existing)} แถว")

to_insert = [r for r in rows if r[0] not in existing]
print(f"[merge] จะเพิ่มใหม่ {len(to_insert)} แถว (ข้ามซ้ำ {len(rows) - len(to_insert)})")

inserted_ids = []
for ts, temp, cpu, ram, disk in to_insert:
    cur = new.execute(
        "INSERT INTO temperature (timestamp, temp_c, cpu_pct, ram_pct, disk_pct, synced) "
        "VALUES (?,?,?,?,?,0)",
        (ts, temp, cpu, ram, disk),
    )
    inserted_ids.append((cur.lastrowid, ts, temp, cpu, ram, disk))
new.commit()
print(f"[sqlite] insert เสร็จ {len(inserted_ids)} แถว")

# ── push Firestore ──
if not os.path.exists(SERVICE):
    print("[firestore] ไม่พบ serviceAccountKey.json — ข้าม cloud (ปล่อยให้ backfill loop ดันเอง)")
    new.close()
    sys.exit(0)

import firebase_admin
from firebase_admin import credentials, firestore
firebase_admin.initialize_app(credentials.Certificate(SERVICE))
db_fs = firestore.client()

def aware(dt):
    return dt if dt.tzinfo else dt.astimezone()

ok = 0
batch = db_fs.batch()
n_in_batch = 0
for rid, ts, temp, cpu, ram, disk in inserted_ids:
    doc = db_fs.collection("readings").document()
    payload = {"ts": aware(datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")), "temp_c": temp}
    if cpu  is not None: payload["cpu_pct"]  = cpu
    if ram  is not None: payload["ram_pct"]  = ram
    if disk is not None: payload["disk_pct"] = disk
    batch.set(doc, payload)
    n_in_batch += 1
    if n_in_batch >= 400:           # Firestore batch limit = 500
        batch.commit()
        batch = db_fs.batch()
        n_in_batch = 0
if n_in_batch:
    batch.commit()

# mark synced
for rid, *_ in inserted_ids:
    new.execute("UPDATE temperature SET synced=1 WHERE id=?", (rid,))
    ok += 1
new.commit()
new.close()
print(f"[firestore] push + mark synced เสร็จ {ok} แถว")
print("✅ เสร็จสมบูรณ์")
