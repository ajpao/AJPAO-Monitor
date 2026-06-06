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
import socket
import platform
import sqlite3
import subprocess
import threading
from datetime import datetime, timedelta

import psutil
import requests
from functools import wraps
from flask import Flask, jsonify, send_from_directory, request, session
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

WEB_PASSWORD       = (os.getenv("WEB_PASSWORD") or "").strip()   # ถ้าว่าง = ไม่บังคับ login (LAN เปิด)
MANAGED_SERVICES   = [s.strip() for s in (os.getenv("MANAGED_SERVICES")
                       or "apache2,transmission-daemon,ssh").split(",") if s.strip()]
EXEC_TIMEOUT       = int(os.getenv("EXEC_TIMEOUT", "30"))         # web terminal: timeout ต่อคำสั่ง (วินาที)
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


# ─── system info (network / OS / processes) ─────────────────────────────────────

_OS_INFO = None


def get_os_info():
    """ข้อมูลเครื่อง/OS (cache ส่วนที่ไม่เปลี่ยน) + uptime สดทุกครั้ง"""
    global _OS_INFO
    if _OS_INFO is None:
        model = ""
        try:
            with open("/proc/device-tree/model") as f:
                model = f.read().strip("\x00").strip()
        except Exception:
            pass
        osname = ""
        try:
            with open("/etc/os-release") as f:
                for line in f:
                    if line.startswith("PRETTY_NAME="):
                        osname = line.split("=", 1)[1].strip().strip('"')
                        break
        except Exception:
            pass
        u = os.uname()
        _OS_INFO = {
            "model":    model or platform.machine() or "Unknown",
            "os":       osname or "Unknown",
            "kernel":   f"{u.sysname} {u.release} {u.machine}",
            "hostname": socket.gethostname(),
            "python":   platform.python_version(),
        }
    d = dict(_OS_INFO)
    d["boot_time"]  = int(psutil.boot_time())
    d["uptime_sec"] = int(time.time() - psutil.boot_time())
    return d


def get_primary_ip():
    """IP ที่ใช้ออกเน็ตจริง (ไม่ต้องต่อเน็ตก็ได้ — แค่เลือก route)"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return ""


def _has_internet(host="1.1.1.1", port=53, timeout=1.5):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect((host, port))
        s.close()
        return True
    except Exception:
        return False


def get_sysinfo(n_proc=8, sample=0.8):
    """รวมข้อมูลสด: network (IP/speed/internet) + OS + top processes (อ่านอย่างเดียว)"""
    # prime per-process cpu (ครั้งแรก cpu_percent คืน 0 — ต้องวัดเป็นช่วง)
    procs = []
    for p in psutil.process_iter(["pid", "name"]):
        try:
            p.cpu_percent(None)
        except Exception:
            pass
        procs.append(p)
    io1 = psutil.net_io_counters()
    time.sleep(sample)                       # ช่วงเดียว ใช้ทั้งวัด speed + cpu ต่อ process
    io2 = psutil.net_io_counters()

    rows = []
    ncpu = psutil.cpu_count() or 1
    for p in procs:
        try:
            rows.append({
                "pid":  p.pid,
                "name": (p.info.get("name") or "?")[:24],
                "cpu":  round(p.cpu_percent(None) / ncpu, 1),   # normalize เป็น % ของทั้งระบบ
                "mem":  round(p.memory_percent(), 1),
            })
        except Exception:
            pass
    rows.sort(key=lambda x: (x["cpu"], x["mem"]), reverse=True)

    down = (io2.bytes_recv - io1.bytes_recv) / sample
    up   = (io2.bytes_sent - io1.bytes_sent) / sample

    addrs = psutil.net_if_addrs()
    stats = psutil.net_if_stats()
    ifaces = []
    for name, alist in addrs.items():
        if name == "lo":
            continue
        ip = mac = None
        for a in alist:
            if a.family == socket.AF_INET:
                ip = a.address
            elif a.family == psutil.AF_LINK:
                mac = a.address
        ifaces.append({"name": name, "ip": ip, "mac": mac,
                       "up": stats[name].isup if name in stats else False})
    ifaces.sort(key=lambda x: (not x["up"], x["name"]))

    return {
        "os": get_os_info(),
        "net": {
            "internet":      _has_internet(),
            "ip":            get_primary_ip(),
            "interfaces":    ifaces,
            "down_kbps":     round(down / 1024, 1),
            "up_kbps":       round(up / 1024, 1),
            "total_recv_mb": round(io2.bytes_recv / 1048576, 1),
            "total_sent_mb": round(io2.bytes_sent / 1048576, 1),
        },
        "procs": rows[:n_proc],
    }


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
        oi = get_os_info()
        db_fs.collection("status").document("latest").set({
            "ts":           _aware(now),
            "temp_c":       round(temp, 1),
            "cpu_pct":      round(cpu, 1),
            "ram_pct":      round(ram.percent, 1),
            "disk_pct":     round(disk.percent, 1),
            "ram_free_mb":  ram.available // 1024 // 1024,
            "disk_free_gb": disk.free // 1024 // 1024 // 1024,
            "uptime":       int(psutil.boot_time()),
            "model":        oi["model"],
            "os":           oi["os"],
            "kernel":       oi["kernel"],
            "hostname":     oi["hostname"],
            "ip":           get_primary_ip(),
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


def _load_secret():
    """secret key ที่คงที่ข้าม restart (ไม่งั้น session หลุดทุกครั้งที่ restart)"""
    s = os.getenv("SECRET_KEY")
    if s:
        return s
    p = os.path.join(BASE_DIR, ".flask_secret")
    if os.path.exists(p):
        return open(p).read().strip()
    import secrets
    s = secrets.token_hex(32)
    try:
        open(p, "w").write(s)
        os.chmod(p, 0o600)
    except Exception:
        pass
    return s


flask_app.secret_key = _load_secret()
flask_app.permanent_session_lifetime = timedelta(days=30)


def require_auth(f):
    """endpoint ที่ต้อง login ก่อน (เฉพาะเมื่อมีตั้ง WEB_PASSWORD)"""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if WEB_PASSWORD and not session.get("authed"):
            return jsonify({"error": "unauthorized"}), 401
        return f(*args, **kwargs)
    return wrapper


@flask_app.route("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


# ─── auth (LAN) ──────────────────────────────────────────────────────────────────

@flask_app.route("/api/ping")
def api_ping():
    # endpoint เปิด — ใช้ detect ว่าเป็น LAN + บอกว่าต้อง login ไหม
    return jsonify({"ok": True, "local": True, "auth_required": bool(WEB_PASSWORD)})


@flask_app.route("/api/me")
def api_me():
    return jsonify({
        "authed": (not WEB_PASSWORD) or bool(session.get("authed")),
        "auth_required": bool(WEB_PASSWORD),
    })


@flask_app.route("/api/login", methods=["POST"])
def api_login():
    import hmac
    data = request.get_json(silent=True) or {}
    pw = data.get("password") or ""
    if WEB_PASSWORD and hmac.compare_digest(pw, WEB_PASSWORD):
        session["authed"] = True
        session.permanent = True
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "รหัสผ่านไม่ถูกต้อง"}), 401


@flask_app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})


@flask_app.route("/api/status")
@require_auth
def api_status():
    temp, cpu, ram, disk = collect_metrics()
    oi = get_os_info()
    return jsonify({
        "temp": temp, "cpu": cpu, "ram": ram.percent,
        "ram_free_mb": ram.available // 1024 // 1024,
        "disk": disk.percent, "disk_free_gb": disk.free // 1024 // 1024 // 1024,
        "time": datetime.now().strftime("%d/%m/%Y %H:%M:%S"),
        "uptime": int(psutil.boot_time()),
        "model": oi["model"], "os": oi["os"], "kernel": oi["kernel"],
        "hostname": oi["hostname"], "ip": get_primary_ip(),
    })


@flask_app.route("/api/sysinfo")
@require_auth
def api_sysinfo():
    return jsonify(get_sysinfo())


def _hourly_temp(rows, label_fmt):
    buckets = {}
    for ts, temp in rows:
        hour = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(minute=0, second=0)
        buckets.setdefault(hour, []).append(temp)
    hours = sorted(buckets)
    return ([h.strftime(label_fmt) for h in hours],
            [round(sum(buckets[h]) / len(buckets[h]), 1) for h in hours])


@flask_app.route("/api/today")
@require_auth
def api_today():
    today = datetime.now().strftime("%Y-%m-%d")
    rows = query("SELECT timestamp, temp_c FROM temperature WHERE timestamp LIKE ? ORDER BY timestamp", (f"{today}%",))
    labels, data = _hourly_temp(rows, "%H:%M")
    return jsonify({"labels": labels, "data": data})


@flask_app.route("/api/history")
@require_auth
def api_history():
    since = (datetime.now() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
    rows = query("SELECT timestamp, temp_c FROM temperature WHERE timestamp >= ? ORDER BY timestamp", (since,))
    labels, data = _hourly_temp(rows, "%d/%m %H:%M")
    return jsonify({"labels": labels, "data": data})


@flask_app.route("/api/monthly")
@require_auth
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
@require_auth
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
@require_auth
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
@require_auth
def api_date():
    date_str = request.args.get("date", datetime.now().strftime("%Y-%m-%d"))
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return jsonify({"error": "invalid date, use YYYY-MM-DD"}), 400
    next_d = d + timedelta(days=1)
    rows = query(
        "SELECT timestamp, temp_c, cpu_pct, ram_pct, disk_pct FROM temperature "
        "WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp",
        (d.strftime("%Y-%m-%d %H:%M:%S"), next_d.strftime("%Y-%m-%d %H:%M:%S")),
    )
    hourly = {}
    for ts, temp, cpu, ram, disk in rows:
        h = int(ts[11:13])
        if h not in hourly:
            hourly[h] = {"t": [], "c": [], "r": [], "d": []}
        if temp is not None: hourly[h]["t"].append(temp)
        if cpu  is not None: hourly[h]["c"].append(cpu)
        if ram  is not None: hourly[h]["r"].append(ram)
        if disk is not None: hourly[h]["d"].append(disk)
    # เฉลี่ยเฉพาะค่าที่มี — ชั่วโมงไหนไม่มีค่าเลยคืน null (ข้อมูลเก่าบางช่วงมีแต่ temp)
    avg = lambda lst: round(sum(lst) / len(lst), 1) if lst else None
    labels, temps, cpus, rams, disks = [], [], [], [], []
    for h in sorted(hourly):
        labels.append(f"{h:02d}:00")
        temps.append(avg(hourly[h]["t"])); cpus.append(avg(hourly[h]["c"]))
        rams.append(avg(hourly[h]["r"])); disks.append(avg(hourly[h]["d"]))
    return jsonify({"date": date_str, "labels": labels, "temp": temps,
                    "cpu": cpus, "ram": rams, "disk": disks, "count": len(rows)})


# ─── service manager ─────────────────────────────────────────────────────────────

def _service_status(name):
    """อ่านสถานะ service ผ่าน systemctl show — คืน None ถ้าไม่มี unit นี้"""
    try:
        r = subprocess.run(
            ["systemctl", "show", name, "--no-pager",
             "--property=LoadState,ActiveState,SubState,UnitFileState,Description"],
            capture_output=True, text=True, timeout=5,
        )
        d = {}
        for line in r.stdout.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                d[k] = v
        if d.get("LoadState") == "not-found":
            return None
        return {
            "name":    name,
            "active":  d.get("ActiveState", ""),      # active / inactive / failed / activating
            "sub":     d.get("SubState", ""),
            "enabled": d.get("UnitFileState", ""),     # enabled / disabled / static / masked
            "desc":    d.get("Description", name),
        }
    except Exception:
        return None


@flask_app.route("/api/services")
@require_auth
def api_services():
    out = [s for s in (_service_status(n) for n in MANAGED_SERVICES) if s]
    return jsonify({"services": out})


@flask_app.route("/api/service/<name>/<action>", methods=["POST"])
@require_auth
def api_service_action(name, action):
    if name not in MANAGED_SERVICES:                   # allowlist — กันสั่ง service มั่ว/inject
        return jsonify({"ok": False, "error": "service ไม่อยู่ในรายการที่จัดการได้"}), 400
    if action not in ("start", "stop", "restart"):
        return jsonify({"ok": False, "error": "action ไม่ถูกต้อง"}), 400
    if name == "ajpao-monitor" and action == "stop":   # กันหยุดตัวเอง
        return jsonify({"ok": False, "error": "ห้ามหยุดตัว monitor เอง"}), 400
    try:
        r = subprocess.run(["sudo", "systemctl", action, name],
                           capture_output=True, text=True, timeout=30)
        return jsonify({"ok": r.returncode == 0,
                        "output": (r.stdout + r.stderr).strip(),
                        "status": _service_status(name)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ─── web terminal (รันคำสั่งสั้นๆ — ต้อง login) ───────────────────────────────────

@flask_app.route("/api/exec", methods=["POST"])
@require_auth
def api_exec():
    data = request.get_json(silent=True) or {}
    cmd = (data.get("cmd") or "").strip()
    if not cmd:
        return jsonify({"ok": False, "error": "คำสั่งว่าง"}), 400
    try:
        r = subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True,
                           timeout=EXEC_TIMEOUT, cwd=os.path.expanduser("~"))
        return jsonify({"ok": True, "code": r.returncode,
                        "stdout": r.stdout, "stderr": r.stderr})
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": f"⏱ timeout ({EXEC_TIMEOUT}s) — คำสั่งใช้เวลานานเกินไป"})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@flask_app.route("/api/reboot", methods=["POST"])
@require_auth
def api_reboot():
    # LAN ถือว่า trusted — กดได้เลยไม่ต้อง login
    subprocess.Popen(["sudo", "reboot"])
    return jsonify({"ok": True})


@flask_app.route("/api/shutdown", methods=["POST"])
@require_auth
def api_shutdown():
    # LAN ถือว่า trusted — สั่งปิดเครื่อง (ต้องเปิดเองที่เครื่องถึงจะกลับมา)
    subprocess.Popen(["sudo", "shutdown", "-h", "now"])
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


POWER_CMDS = {
    "reboot":   (["sudo", "reboot"],               "Reboot"),
    "shutdown": (["sudo", "shutdown", "-h", "now"], "Shutdown"),
}


def reboot_poll_loop():
    if not db_fs:
        return
    print("[power-poll] เริ่มเฝ้าคำสั่ง reboot/shutdown จาก cloud")
    while True:
        try:
            for name, (cmd, label) in POWER_CMDS.items():
                ref = db_fs.collection("commands").document(name)
                doc = ref.get()
                if doc.exists:
                    d = doc.to_dict()
                    if not d.get("handled", True):
                        broadcast(f"🔄 <b>มีคำสั่ง {label} จาก cloud dashboard</b>\n👤 {d.get('requested_by', '?')}")
                        ref.update({"handled": True, "handled_at": fs.SERVER_TIMESTAMP})
                        subprocess.run(cmd)
        except Exception as e:
            print(f"[power-poll] error: {e}")
        time.sleep(REBOOT_POLL_SEC)


# ─── main ───────────────────────────────────────────────────────────────────────

def main():
    init_db()
    init_firestore()
    threading.Thread(target=collector_loop, daemon=True).start()
    threading.Thread(target=bot_loop, daemon=True).start()
    threading.Thread(target=reboot_poll_loop, daemon=True).start()
    print(f"🌐 LAN dashboard: http://0.0.0.0:{PORT}")
    flask_app.run(host="0.0.0.0", port=PORT, debug=False, use_reloader=False, threaded=True)


if __name__ == "__main__":
    main()
