#!/usr/bin/env python3
"""
AJPAO-Monitor — single-file Raspberry Pi monitor.

ทำทุกอย่างในไฟล์เดียว รันเป็น service เดียว (threads):
  • Collector   — อ่าน temp/CPU/RAM/Disk ทุก ~10 นาที → เก็บลง SQLite (local) + push Firestore (cloud)
  • Flask web   — dashboard ใน LAN ที่ http://<ip-pi>:5000 (อ่านจาก SQLite)
  • Telegram bot— รับคำสั่ง /status /temp /system /today /history /monthly /reboot ฯลฯ
  • Daily report— สรุปกราฟอุณหภูมิเมื่อวานทุกเช้า
  • Reboot poll — เช็คคำสั่ง reboot จาก Firestore (cloud dashboard) แล้วสั่ง reboot

ดู dashboard ได้ 2 ที่ ข้อมูล sync กันเสมอ:
  - LAN   : http://<ip-pi>:5000              (Flask + SQLite)
  - Cloud : https://<project>.web.app         (Firebase Hosting + Firestore)

รัน:  python3 monitor.py
"""

import os
import io
import time
import sqlite3
import subprocess
import threading
from datetime import datetime, timedelta

import psutil
import requests
from flask import Flask, jsonify, send_from_directory, request
from dotenv import load_dotenv

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ─── config ────────────────────────────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

DB_PATH            = os.getenv("DB_PATH", os.path.join(BASE_DIR, "temp_data.db"))
WEB_DIR            = os.path.join(BASE_DIR, "web", "public")
SERVICE_ACCOUNT    = os.getenv("SERVICE_ACCOUNT", os.path.join(BASE_DIR, "serviceAccountKey.json"))

BOT_TOKEN          = os.getenv("BOT_TOKEN")
CHAT_ID            = os.getenv("CHAT_ID")
ALLOWED            = set((os.getenv("ALLOWED_IDS") or (CHAT_ID or "")).split(","))

PORT               = int(os.getenv("PORT", "5000"))
TEMP_ALERT         = float(os.getenv("TEMP_ALERT", "55"))
COLLECT_INTERVAL   = int(os.getenv("COLLECT_INTERVAL", "600"))   # วินาที (default 10 นาที)
DAILY_REPORT_HOUR  = int(os.getenv("DAILY_REPORT_HOUR", "8"))
REBOOT_POLL_SEC    = int(os.getenv("REBOOT_POLL_SEC", "15"))

# Firestore client (เปิดใช้เมื่อมี serviceAccountKey.json เท่านั้น)
db_fs = None      # firestore.Client
fs    = None      # firebase_admin.firestore module (สำหรับ SERVER_TIMESTAMP)


def init_firestore():
    """เปิด cloud sync ถ้ามี service account key — ไม่มีก็รันแบบ local-only"""
    global db_fs, fs
    if not os.path.exists(SERVICE_ACCOUNT):
        print("[firestore] ไม่พบ serviceAccountKey.json — รันแบบ local-only (ไม่ sync cloud)")
        return
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
        firebase_admin.initialize_app(credentials.Certificate(SERVICE_ACCOUNT))
        db_fs = firestore.client()
        fs    = firestore
        print("[firestore] เปิด cloud sync แล้ว")
    except Exception as e:
        print(f"[firestore] init ล้มเหลว ({e}) — รันแบบ local-only")
        db_fs = None


# ─── database (SQLite) ──────────────────────────────────────────────────────────

def init_db():
    con = sqlite3.connect(DB_PATH)
    con.execute("""
        CREATE TABLE IF NOT EXISTS temperature (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            temp_c    REAL NOT NULL,
            cpu_pct   REAL,
            ram_pct   REAL,
            disk_pct  REAL,
            synced    INTEGER DEFAULT 0
        )
    """)
    # เผื่อ db เดิมยังไม่มีคอลัมน์ — เพิ่มแบบ idempotent
    for col, decl in [("cpu_pct", "REAL"), ("ram_pct", "REAL"),
                      ("disk_pct", "REAL"), ("synced", "INTEGER DEFAULT 0")]:
        try:
            con.execute(f"ALTER TABLE temperature ADD COLUMN {col} {decl}")
        except sqlite3.OperationalError:
            pass
    con.commit()
    con.close()


def query(sql, params=()):
    con = sqlite3.connect(DB_PATH)
    rows = con.execute(sql, params).fetchall()
    con.close()
    return rows


def save_data(now, temp, cpu, ram_pct, disk_pct):
    con = sqlite3.connect(DB_PATH)
    cur = con.execute(
        "INSERT INTO temperature (timestamp, temp_c, cpu_pct, ram_pct, disk_pct, synced) "
        "VALUES (?, ?, ?, ?, ?, 0)",
        (now.strftime("%Y-%m-%d %H:%M:%S"), temp, cpu, ram_pct, disk_pct),
    )
    rowid = cur.lastrowid
    con.commit()
    con.close()
    return rowid


def mark_synced(rowid):
    con = sqlite3.connect(DB_PATH)
    con.execute("UPDATE temperature SET synced = 1 WHERE id = ?", (rowid,))
    con.commit()
    con.close()


# ─── metrics ────────────────────────────────────────────────────────────────────

def get_cpu_temp():
    """อ่านอุณหภูมิ CPU — vcgencmd (Pi) → /sys/class/thermal → 0.0 (เครื่องอื่น)"""
    try:
        r = subprocess.run(["vcgencmd", "measure_temp"], capture_output=True, text=True)
        return float(r.stdout.strip().replace("temp=", "").replace("'C", ""))
    except Exception:
        pass
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return round(int(f.read().strip()) / 1000.0, 1)
    except Exception:
        return 0.0


def collect_metrics():
    temp = get_cpu_temp()
    cpu  = psutil.cpu_percent(interval=1)
    ram  = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    return temp, cpu, ram, disk


# ─── firestore sync (best-effort) ───────────────────────────────────────────────

def _aware(dt):
    """ทำ datetime ให้เป็น timezone-aware (local tz) — กัน Firestore ตีความเป็น UTC แล้วเวลาเพี้ยน"""
    return dt if dt.tzinfo else dt.astimezone()


def push_reading(now, temp, cpu, ram, disk):
    """เขียน 1 reading + อัปเดต status/latest ขึ้น Firestore. คืน True ถ้าสำเร็จ"""
    if not db_fs:
        return False
    try:
        db_fs.collection("readings").add({
            "ts":       _aware(now),
            "temp_c":   round(temp, 1),
            "cpu_pct":  round(cpu, 1),
            "ram_pct":  round(ram.percent, 1),
            "disk_pct": round(disk.percent, 1),
        })
        db_fs.collection("status").document("latest").set({
            "ts":           _aware(now),
            "temp_c":       round(temp, 1),
            "cpu_pct":      round(cpu, 1),
            "ram_pct":      round(ram.percent, 1),
            "disk_pct":     round(disk.percent, 1),
            "ram_free_mb":  ram.available // 1024 // 1024,
            "disk_free_gb": disk.free // 1024 // 1024 // 1024,
            "uptime":       int(psutil.boot_time()),
            "updated_at":   fs.SERVER_TIMESTAMP,
        })
        return True
    except Exception as e:
        print(f"[firestore] push ล้มเหลว: {e}")
        return False


def backfill_unsynced():
    """ดัน row ที่ยังไม่ขึ้น cloud (synced=0) — ให้ cloud ตามทันหลังเน็ตหลุด"""
    if not db_fs:
        return
    rows = query(
        "SELECT id, timestamp, temp_c, cpu_pct, ram_pct, disk_pct "
        "FROM temperature WHERE synced = 0 ORDER BY id LIMIT 200"
    )
    for rid, ts, temp, cpu, ram_pct, disk_pct in rows:
        try:
            db_fs.collection("readings").add({
                "ts":       _aware(datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")),
                "temp_c":   temp,
                "cpu_pct":  cpu,
                "ram_pct":  ram_pct,
                "disk_pct": disk_pct,
            })
            mark_synced(rid)
        except Exception as e:
            print(f"[firestore] backfill หยุด (row {rid}): {e}")
            break


# ─── telegram ───────────────────────────────────────────────────────────────────

def send_message(chat_id, text):
    if not BOT_TOKEN:
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"}, timeout=10,
        )
    except Exception as e:
        print(f"[telegram] send_message ล้มเหลว: {e}")


def send_photo(chat_id, buf, caption):
    if not BOT_TOKEN:
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendPhoto",
            data={"chat_id": chat_id, "caption": caption, "parse_mode": "HTML"},
            files={"photo": ("graph.png", buf, "image/png")}, timeout=30,
        )
    except Exception as e:
        print(f"[telegram] send_photo ล้มเหลว: {e}")


def broadcast(text):
    for cid in ALLOWED:
        if cid:
            send_message(cid, text)


def temp_status(t):
    if   t < 50: return "✅ ปกติ"
    elif t < 55: return "🟡 เริ่มอุ่น"
    elif t < 70: return "⚠️ อุ่น"
    else:        return "🔥 ร้อนมาก!"


# ─── graphs (matplotlib) ────────────────────────────────────────────────────────

def make_temp_graph(rows, title):
    buckets = {}
    for ts, temp in [(r[0], r[1]) for r in rows]:
        hour = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(minute=0, second=0)
        buckets.setdefault(hour, []).append(temp)
    hours = sorted(buckets)
    avgs  = [sum(buckets[h]) / len(buckets[h]) for h in hours]

    colors = ["#e05252" if t >= 55 else "#e09a3a" if t >= 50 else "#4a9fd4" for t in avgs]
    x = range(len(hours))

    fig, ax = plt.subplots(figsize=(12, 5))
    fig.patch.set_facecolor("#1a1a2e")
    ax.set_facecolor("#16213e")
    bars = ax.bar(x, avgs, color=colors, width=0.6, zorder=2)
    for bar, val in zip(bars, avgs):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.3,
                f"{val:.1f}", ha="center", va="bottom", color="#fff", fontsize=9, fontweight="bold")
    ax.set_title(title, color="white", fontsize=14, pad=12)
    ax.set_ylabel("°C", color="#aaa")
    ax.set_xticks(list(x))
    ax.set_xticklabels([h.strftime("%H:%M") for h in hours], color="#aaa", fontsize=9)
    ax.tick_params(colors="#aaa")
    ax.set_ylim(max(0, min(avgs) - 5), max(avgs) + 6)
    ax.grid(axis="y", color="#333355", linewidth=0.5, zorder=1)
    for sp in ax.spines.values():
        sp.set_edgecolor("#333355")
    all_t = [r[1] for r in rows]
    avg_all = sum(all_t) / len(all_t)
    ax.annotate(f"Min {min(all_t):.1f}°  Avg {avg_all:.1f}°  Max {max(all_t):.1f}°",
                xy=(0.98, 0.95), xycoords="axes fraction", ha="right", va="top",
                color="#ccc", fontsize=9, bbox=dict(boxstyle="round,pad=0.3", fc="#0f3460", alpha=0.8))
    plt.tight_layout()
    buf = io.BytesIO()
    plt.savefig(buf, format="png", dpi=150, facecolor=fig.get_facecolor())
    buf.seek(0)
    plt.close()
    return buf, min(all_t), avg_all, max(all_t)


def _bar_subplot(ax, hours, data, color, label, x_fmt="%H:%M"):
    mn, mx = min(data), max(data)
    avg = sum(data) / len(data)
    pad = max((mx - mn) * 0.5, 1)
    y_min, y_max = max(0, mn - pad), mx + pad
    colors = ["#e05252" if v >= 80 else "#e09a3a" if v >= 50 else color for v in data]
    x = range(len(hours))
    bars = ax.bar(x, data, color=colors, width=0.6, zorder=2)
    for bar, val in zip(bars, data):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + (y_max - y_min) * 0.03,
                f"{val:.1f}", ha="center", va="bottom", color="#ccc", fontsize=7, fontweight="bold")
    ax.set_facecolor("#16213e")
    ax.set_xticks(list(x))
    ax.set_xticklabels([h.strftime(x_fmt) for h in hours], color="#aaa", fontsize=8)
    ax.tick_params(colors="#aaa")
    ax.set_ylim(y_min, y_max + (y_max - y_min) * 0.2)
    ax.grid(axis="y", color="#333355", linewidth=0.5, zorder=1)
    for sp in ax.spines.values():
        sp.set_edgecolor("#333355")
    ax.annotate(f"{label}  Min {mn:.1f}%  Avg {avg:.1f}%  Max {mx:.1f}%",
                xy=(0.98, 0.95), xycoords="axes fraction", ha="right", va="top",
                color="#ccc", fontsize=8, bbox=dict(boxstyle="round,pad=0.3", fc="#0f3460", alpha=0.8))


def make_system_graph(rows, title, x_fmt="%H:%M", by_day=False):
    buckets = {"cpu": {}, "ram": {}, "disk": {}}
    for r in rows:
        dt = datetime.strptime(r[0], "%Y-%m-%d %H:%M:%S")
        key = datetime.combine(dt.date(), datetime.min.time()) if by_day else dt.replace(minute=0, second=0)
        buckets["cpu"].setdefault(key, []).append(r[2])
        buckets["ram"].setdefault(key, []).append(r[3])
        buckets["disk"].setdefault(key, []).append(r[4])
    keys = sorted(buckets["cpu"])
    cpu  = [sum(buckets["cpu"][k])  / len(buckets["cpu"][k])  for k in keys]
    ram  = [sum(buckets["ram"][k])  / len(buckets["ram"][k])  for k in keys]
    disk = [sum(buckets["disk"][k]) / len(buckets["disk"][k]) for k in keys]

    fig, axes = plt.subplots(3, 1, figsize=(max(12, len(keys) * 0.5), 9))
    fig.patch.set_facecolor("#1a1a2e")
    fig.suptitle(title, color="white", fontsize=14, y=0.98)
    _bar_subplot(axes[0], keys, cpu,  "#4a9fd4", "CPU",  x_fmt)
    _bar_subplot(axes[1], keys, ram,  "#5dcaa5", "RAM",  x_fmt)
    _bar_subplot(axes[2], keys, disk, "#f0c040", "Disk", x_fmt)
    for ax, lbl in zip(axes, ["CPU %", "RAM %", "Disk %"]):
        ax.set_ylabel(lbl, color="#aaa", fontsize=9)
    plt.tight_layout(rect=[0, 0, 1, 0.97])
    buf = io.BytesIO()
    plt.savefig(buf, format="png", dpi=150, facecolor=fig.get_facecolor())
    buf.seek(0)
    plt.close()
    return buf


# ─── telegram command handlers ──────────────────────────────────────────────────

def cmd_status(chat_id):
    temp, cpu, ram, disk = collect_metrics()
    now = datetime.now().strftime("%d/%m/%Y %H:%M")
    send_message(chat_id,
        f"🍓 <b>AJPAO's Raspberry Pi — Status Overview</b>\n"
        f"🕐 {now}\n"
        f"🌡️ Temp: <b>{temp:.1f}°C</b>  {temp_status(temp)}\n"
        f"🖥️ CPU: <b>{cpu:.1f}%</b>\n"
        f"🧠 RAM: <b>{ram.percent:.1f}%</b> (ว่าง {ram.available//1024//1024} MB)\n"
        f"💾 Disk: <b>{disk.percent:.1f}%</b> (ว่าง {disk.free//1024//1024//1024} GB)")


def cmd_temp(chat_id):
    temp = get_cpu_temp()
    now = datetime.now().strftime("%d/%m/%Y %H:%M")
    send_message(chat_id,
        f"🍓 <b>AJPAO's Raspberry Pi — Temp</b>\n🕐 {now}\n"
        f"🌡️ Temp: <b>{temp:.1f}°C</b> {temp_status(temp)}")


def cmd_system(chat_id):
    _, cpu, ram, disk = collect_metrics()
    now = datetime.now().strftime("%d/%m/%Y %H:%M")
    send_message(chat_id,
        f"🍓 <b>AJPAO's Raspberry Pi — System</b>\n🕐 {now}\n"
        f"🖥️ CPU: <b>{cpu:.1f}%</b>\n"
        f"🧠 RAM: <b>{ram.percent:.1f}%</b> (ว่าง {ram.available//1024//1024} MB)\n"
        f"💾 Disk: <b>{disk.percent:.1f}%</b> (ว่าง {disk.free//1024//1024//1024} GB)")


def cmd_today(chat_id):
    today = datetime.now().strftime("%Y-%m-%d")
    rows = query("SELECT timestamp, temp_c FROM temperature WHERE timestamp LIKE ? ORDER BY timestamp", (f"{today}%",))
    if not rows:
        return send_message(chat_id, "⚠️ ไม่มีข้อมูลสำหรับวันนี้")
    buf, mn, avg, mx = make_temp_graph(rows, f"AJPAO's Raspberry Pi Today — {datetime.now().strftime('%d %b %Y')}")
    send_photo(chat_id, buf,
        f"📊 <b>กราฟอุณหภูมิวันนี้</b>\n🌡️ Min: {mn:.1f}°C | Avg: {avg:.1f}°C | Max: {mx:.1f}°C\n📈 {len(rows)} จุดข้อมูล")


def cmd_history(chat_id):
    since = (datetime.now() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
    rows = query("SELECT timestamp, temp_c FROM temperature WHERE timestamp >= ? ORDER BY timestamp", (since,))
    if not rows:
        return send_message(chat_id, "⚠️ ไม่มีข้อมูลย้อนหลัง 24 ชั่วโมง")
    buf, mn, avg, mx = make_temp_graph(rows, f"AJPAO's Raspberry Pi Last 24 Hours — {datetime.now().strftime('%d %b %Y')}")
    send_photo(chat_id, buf,
        f"📊 <b>กราฟอุณหภูมิย้อนหลัง 24 ชม.</b>\n🌡️ Min: {mn:.1f}°C | Avg: {avg:.1f}°C | Max: {mx:.1f}°C\n📈 {len(rows)} จุดข้อมูล")


def cmd_monthly(chat_id):
    month = datetime.now().strftime("%Y-%m")
    rows = query("SELECT timestamp, temp_c FROM temperature WHERE timestamp LIKE ? ORDER BY timestamp", (f"{month}%",))
    if not rows:
        return send_message(chat_id, "⚠️ ไม่มีข้อมูลในเดือนนี้")
    buckets = {}
    for ts, temp in rows:
        day = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").date()
        buckets.setdefault(day, []).append(temp)
    days = sorted(buckets)
    day_rows = [(datetime.combine(d, datetime.min.time()).strftime("%Y-%m-%d %H:%M:%S"),
                 sum(buckets[d]) / len(buckets[d])) for d in days]
    buf, mn, avg, mx = make_temp_graph(day_rows, f"AJPAO's Raspberry Pi — {datetime.now().strftime('%B %Y')}")
    send_photo(chat_id, buf,
        f"📊 <b>กราฟอุณหภูมิเดือน {datetime.now().strftime('%B %Y')}</b>\n"
        f"🌡️ Min: {mn:.1f}°C | Avg: {avg:.1f}°C | Max: {mx:.1f}°C\n📅 {len(days)} วัน | 📈 {len(rows)} จุดข้อมูล")


def cmd_system_today(chat_id):
    today = datetime.now().strftime("%Y-%m-%d")
    rows = query("SELECT timestamp, temp_c, cpu_pct, ram_pct, disk_pct FROM temperature "
                 "WHERE timestamp LIKE ? AND cpu_pct IS NOT NULL ORDER BY timestamp", (f"{today}%",))
    if not rows:
        return send_message(chat_id, "⚠️ ไม่มีข้อมูลระบบสำหรับวันนี้")
    buf = make_system_graph(rows, f"AJPAO's Raspberry Pi System Today — {datetime.now().strftime('%d %b %Y')}")
    c, r, d = [x[2] for x in rows], [x[3] for x in rows], [x[4] for x in rows]
    send_photo(chat_id, buf,
        f"📊 <b>System Status Today</b>\n"
        f"🖥️ CPU  Min: {min(c):.1f}%  Avg: {sum(c)/len(c):.1f}%  Max: {max(c):.1f}%\n"
        f"🧠 RAM  Min: {min(r):.1f}%  Avg: {sum(r)/len(r):.1f}%  Max: {max(r):.1f}%\n"
        f"💾 Disk Min: {min(d):.1f}%  Avg: {sum(d)/len(d):.1f}%  Max: {max(d):.1f}%\n📈 {len(rows)} จุดข้อมูล")


def cmd_system_monthly(chat_id):
    month = datetime.now().strftime("%Y-%m")
    rows = query("SELECT timestamp, temp_c, cpu_pct, ram_pct, disk_pct FROM temperature "
                 "WHERE timestamp LIKE ? AND cpu_pct IS NOT NULL ORDER BY timestamp", (f"{month}%",))
    if not rows:
        return send_message(chat_id, "⚠️ ไม่มีข้อมูลระบบในเดือนนี้")
    buf = make_system_graph(rows, f"AJPAO's Raspberry Pi System — {datetime.now().strftime('%B %Y')}", "%d", by_day=True)
    c, r, d = [x[2] for x in rows], [x[3] for x in rows], [x[4] for x in rows]
    send_photo(chat_id, buf,
        f"📊 <b>System เดือน {datetime.now().strftime('%B %Y')}</b>\n"
        f"🖥️ CPU  Min: {min(c):.1f}%  Avg: {sum(c)/len(c):.1f}%  Max: {max(c):.1f}%\n"
        f"🧠 RAM  Min: {min(r):.1f}%  Avg: {sum(r)/len(r):.1f}%  Max: {max(r):.1f}%\n"
        f"💾 Disk Min: {min(d):.1f}%  Avg: {sum(d)/len(d):.1f}%  Max: {max(d):.1f}%\n📈 {len(rows)} จุดข้อมูล")


def cmd_reboot(chat_id):
    send_message(chat_id, "🔄 <b>กำลังสั่ง Reboot เครื่อง...</b>")
    subprocess.run(["sudo", "reboot"])


def cmd_help(chat_id):
    send_message(chat_id,
        "🍓 <b>คำสั่งที่ใช้ได้</b>\n\n"
        "/status — ภาพรวม (Temp + System)\n/temp — อุณหภูมิตอนนี้\n/system — ระบบตอนนี้\n"
        "/today — กราฟวันนี้\n/systemtoday — กราฟระบบวันนี้\n/history — กราฟย้อนหลัง 24 ชม.\n"
        "/monthly — กราฟอุณหภูมิรายวันเดือนนี้\n/systemmonthly — กราฟ System รายวันเดือนนี้\n"
        "/reboot — สั่ง Reboot เครื่อง\n/help — แสดงคำสั่งทั้งหมด")


BOT_COMMANDS = {
    "/status": cmd_status, "/temp": cmd_temp, "/system": cmd_system,
    "/today": cmd_today, "/systemtoday": cmd_system_today, "/history": cmd_history,
    "/monthly": cmd_monthly, "/systemmonthly": cmd_system_monthly, "/reboot": cmd_reboot,
    "/help": cmd_help, "/start": cmd_help,
}


# ─── Flask web (LAN dashboard + /api) ───────────────────────────────────────────

flask_app = Flask(__name__, static_folder=WEB_DIR, static_url_path="")


@flask_app.route("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@flask_app.route("/api/status")
def api_status():
    temp, cpu, ram, disk = collect_metrics()
    return jsonify({
        "temp": temp, "cpu": cpu, "ram": ram.percent,
        "ram_free_mb": ram.available // 1024 // 1024,
        "disk": disk.percent, "disk_free_gb": disk.free // 1024 // 1024 // 1024,
        "time": datetime.now().strftime("%d/%m/%Y %H:%M:%S"),
        "uptime": int(psutil.boot_time()),
    })


def _hourly_temp(rows, label_fmt):
    buckets = {}
    for ts, temp in rows:
        hour = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(minute=0, second=0)
        buckets.setdefault(hour, []).append(temp)
    hours = sorted(buckets)
    return ([h.strftime(label_fmt) for h in hours],
            [round(sum(buckets[h]) / len(buckets[h]), 1) for h in hours])


@flask_app.route("/api/today")
def api_today():
    today = datetime.now().strftime("%Y-%m-%d")
    rows = query("SELECT timestamp, temp_c FROM temperature WHERE timestamp LIKE ? ORDER BY timestamp", (f"{today}%",))
    labels, data = _hourly_temp(rows, "%H:%M")
    return jsonify({"labels": labels, "data": data})


@flask_app.route("/api/history")
def api_history():
    since = (datetime.now() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
    rows = query("SELECT timestamp, temp_c FROM temperature WHERE timestamp >= ? ORDER BY timestamp", (since,))
    labels, data = _hourly_temp(rows, "%d/%m %H:%M")
    return jsonify({"labels": labels, "data": data})


@flask_app.route("/api/monthly")
def api_monthly():
    month = datetime.now().strftime("%Y-%m")
    rows = query("SELECT timestamp, temp_c FROM temperature WHERE timestamp LIKE ? ORDER BY timestamp", (f"{month}%",))
    buckets = {}
    for ts, temp in rows:
        day = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").date()
        buckets.setdefault(day, []).append(temp)
    days = sorted(buckets)
    return jsonify({
        "labels": [str(d.day) for d in days],
        "data":   [round(sum(buckets[d]) / len(buckets[d]), 1) for d in days],
        "month":  datetime.now().strftime("%B %Y"),
    })


def _system_buckets(rows, by_day):
    buckets = {"cpu": {}, "ram": {}, "disk": {}}
    for ts, cpu, ram, disk in rows:
        dt = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
        key = dt.date() if by_day else dt.replace(minute=0, second=0)
        buckets["cpu"].setdefault(key, []).append(cpu)
        buckets["ram"].setdefault(key, []).append(ram)
        buckets["disk"].setdefault(key, []).append(disk)
    keys = sorted(buckets["cpu"])
    avg = lambda b, k: round(sum(b[k]) / len(b[k]), 1)
    return keys, buckets, avg


@flask_app.route("/api/system_today")
def api_system_today():
    today = datetime.now().strftime("%Y-%m-%d")
    rows = query("SELECT timestamp, cpu_pct, ram_pct, disk_pct FROM temperature "
                 "WHERE timestamp LIKE ? AND cpu_pct IS NOT NULL ORDER BY timestamp", (f"{today}%",))
    keys, b, avg = _system_buckets(rows, by_day=False)
    return jsonify({
        "labels": [k.strftime("%H:%M") for k in keys],
        "cpu": [avg(b["cpu"], k) for k in keys],
        "ram": [avg(b["ram"], k) for k in keys],
        "disk": [avg(b["disk"], k) for k in keys],
    })


@flask_app.route("/api/system_monthly")
def api_system_monthly():
    month = datetime.now().strftime("%Y-%m")
    rows = query("SELECT timestamp, cpu_pct, ram_pct, disk_pct FROM temperature "
                 "WHERE timestamp LIKE ? AND cpu_pct IS NOT NULL ORDER BY timestamp", (f"{month}%",))
    keys, b, avg = _system_buckets(rows, by_day=True)
    return jsonify({
        "labels": [str(k.day) for k in keys],
        "cpu": [avg(b["cpu"], k) for k in keys],
        "ram": [avg(b["ram"], k) for k in keys],
        "disk": [avg(b["disk"], k) for k in keys],
        "month": datetime.now().strftime("%B %Y"),
    })


@flask_app.route("/api/date")
def api_date():
    date_str = request.args.get("date", datetime.now().strftime("%Y-%m-%d"))
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return jsonify({"error": "invalid date, use YYYY-MM-DD"}), 400
    next_d = d + timedelta(days=1)
    rows = query(
        "SELECT timestamp, temp_c, cpu_pct, ram_pct, disk_pct FROM temperature "
        "WHERE timestamp >= ? AND timestamp < ? AND cpu_pct IS NOT NULL ORDER BY timestamp",
        (d.strftime("%Y-%m-%d %H:%M:%S"), next_d.strftime("%Y-%m-%d %H:%M:%S")),
    )
    hourly = {}
    for ts, temp, cpu, ram, disk in rows:
        h = int(ts[11:13])
        if h not in hourly:
            hourly[h] = {"t": [], "c": [], "r": [], "d": []}
        hourly[h]["t"].append(temp); hourly[h]["c"].append(cpu)
        hourly[h]["r"].append(ram);  hourly[h]["d"].append(disk)
    avg = lambda lst: round(sum(lst) / len(lst), 1)
    labels, temps, cpus, rams, disks = [], [], [], [], []
    for h in sorted(hourly):
        labels.append(f"{h:02d}:00")
        temps.append(avg(hourly[h]["t"])); cpus.append(avg(hourly[h]["c"]))
        rams.append(avg(hourly[h]["r"])); disks.append(avg(hourly[h]["d"]))
    return jsonify({"date": date_str, "labels": labels, "temp": temps,
                    "cpu": cpus, "ram": rams, "disk": disks, "count": len(rows)})


@flask_app.route("/api/reboot", methods=["POST"])
def api_reboot():
    # LAN ถือว่า trusted — กดได้เลยไม่ต้อง login
    subprocess.Popen(["sudo", "reboot"])
    return jsonify({"ok": True})


# ─── background loops ───────────────────────────────────────────────────────────

def collector_loop():
    last_status_hour = None
    last_daily_date  = None
    while True:
        try:
            temp, cpu, ram, disk = collect_metrics()
            now = datetime.now()

            rowid = save_data(now, temp, cpu, ram.percent, disk.percent)
            if push_reading(now, temp, cpu, ram, disk):
                mark_synced(rowid)
            backfill_unsynced()

            # แจ้งเตือนด่วนเมื่อร้อนเกินกำหนด
            if temp > TEMP_ALERT:
                broadcast(
                    f"🚨 <b>แจ้งเตือน! อุณหภูมิสูงเกิน {TEMP_ALERT:.0f}°C</b>\n"
                    f"🌡️ CPU: <b>{temp:.1f}°C</b>\n🕐 {now.strftime('%d/%m/%Y %H:%M')}\n"
                    f"⚠️ กรุณาตรวจสอบการระบายความร้อน")

            # สถานะรายชั่วโมง (ส่งครั้งเดียวต่อชั่วโมง)
            if last_status_hour != now.hour:
                broadcast(
                    f"🍓 <b>AJPAO's Raspberry Pi — Status</b>\n"
                    f"🕐 {now.strftime('%d/%m/%Y %H:%M')}\n"
                    f"🌡️ Temp: <b>{temp:.1f}°C</b>  {temp_status(temp)}\n"
                    f"🖥️ CPU: <b>{cpu:.1f}%</b>\n"
                    f"🧠 RAM: <b>{ram.percent:.1f}%</b> (ว่าง {ram.available//1024//1024} MB)\n"
                    f"💾 Disk: <b>{disk.percent:.1f}%</b> (ว่าง {disk.free//1024//1024//1024} GB)")
                last_status_hour = now.hour

            # รายงานสรุปประจำวัน (เมื่อวาน) ตอนเช้า
            if now.hour == DAILY_REPORT_HOUR and last_daily_date != now.date():
                send_daily_report()
                last_daily_date = now.date()

        except Exception as e:
            print(f"[collector] error: {e}")
        time.sleep(COLLECT_INTERVAL)


def send_daily_report():
    yesterday = datetime.now() - timedelta(days=1)
    rows = query("SELECT timestamp, temp_c FROM temperature WHERE timestamp LIKE ? ORDER BY timestamp",
                 (f"{yesterday.strftime('%Y-%m-%d')}%",))
    if not rows:
        return
    temps = [r[1] for r in rows]
    buf, mn, avg, mx = make_temp_graph(rows, f"AJPAO's Raspberry Pi — {yesterday.strftime('%d %b %Y')}")
    caption = (f"📊 <b>สรุปอุณหภูมิรายวัน</b> — {yesterday.strftime('%d/%m/%Y')}\n"
               f"🌡️ Min: {mn:.1f}°C | Avg: {avg:.1f}°C | Max: {mx:.1f}°C\n📈 {len(rows)} จุดข้อมูลเมื่อวาน")
    for cid in ALLOWED:
        if cid:
            send_photo(cid, buf, caption)
            buf.seek(0)


def bot_loop():
    if not BOT_TOKEN:
        print("[bot] ไม่มี BOT_TOKEN — ข้าม Telegram bot")
        return
    print("🍓 AJPAO's Raspberry Pi Bot Started...")
    offset = 0
    while True:
        try:
            resp = requests.get(f"https://api.telegram.org/bot{BOT_TOKEN}/getUpdates",
                                params={"offset": offset, "timeout": 30}, timeout=35).json()
            for update in resp.get("result", []):
                offset = update["update_id"] + 1
                msg = update.get("message", {})
                cid = str(msg.get("chat", {}).get("id", ""))
                text = msg.get("text", "").strip().lower()
                if cid not in ALLOWED:
                    continue
                handler = BOT_COMMANDS.get(text)
                if handler:
                    handler(cid)
        except Exception as e:
            print(f"[bot] error: {e}")
            time.sleep(5)


def reboot_poll_loop():
    if not db_fs:
        return
    print("[reboot-poll] เริ่มเฝ้าคำสั่ง reboot จาก cloud")
    while True:
        try:
            ref = db_fs.collection("commands").document("reboot")
            doc = ref.get()
            if doc.exists:
                d = doc.to_dict()
                if not d.get("handled", True):
                    broadcast(f"🔄 <b>มีคำสั่ง Reboot จาก cloud dashboard</b>\n👤 {d.get('requested_by', '?')}")
                    ref.update({"handled": True, "handled_at": fs.SERVER_TIMESTAMP})
                    subprocess.run(["sudo", "reboot"])
        except Exception as e:
            print(f"[reboot-poll] error: {e}")
        time.sleep(REBOOT_POLL_SEC)


# ─── main ───────────────────────────────────────────────────────────────────────

def main():
    init_db()
    init_firestore()
    threading.Thread(target=collector_loop, daemon=True).start()
    threading.Thread(target=bot_loop, daemon=True).start()
    threading.Thread(target=reboot_poll_loop, daemon=True).start()
    print(f"🌐 LAN dashboard: http://0.0.0.0:{PORT}")
    flask_app.run(host="0.0.0.0", port=PORT, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
