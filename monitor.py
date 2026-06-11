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
import re
import csv
import time
import socket
import platform
import sqlite3
import subprocess
import threading
from datetime import datetime, timedelta

import psutil
import requests
import json
import pty
import select
import struct
import fcntl
import termios
from functools import wraps
from flask import Flask, jsonify, send_from_directory, request, session, Response
from flask_sock import Sock
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
                       or "AdGuardHome,plexmediaserver,transmission-daemon,ssh").split(",") if s.strip()]
EXEC_TIMEOUT       = int(os.getenv("EXEC_TIMEOUT", "30"))         # web terminal: timeout ต่อคำสั่ง (วินาที)

# ─── File Transfer / DropZone ───
FILES_DIR          = os.getenv("FILES_DIR", os.path.join(BASE_DIR, "files"))   # โฟลเดอร์ปลายทาง
FILES_MAX_MB       = int(os.getenv("FILES_MAX_MB", "51200"))      # ขนาดอัปโหลดสูงสุดต่อ request (MB) — default 50GB
os.makedirs(FILES_DIR, exist_ok=True)

NOTES_FILE         = os.path.join(BASE_DIR, "notes.json")         # fallback ถ้าไม่มี Firestore

# ─── AdGuard Home (ดึงสถิติ DNS) — ปล่อย ADGUARD_IP ว่าง = ปิดฟีเจอร์นี้ ───
ADGUARD_IP         = (os.getenv("ADGUARD_IP") or "").strip()       # เช่น 127.0.0.1 (เครื่องเดียวกัน) หรือ IP ในวง LAN
ADGUARD_PORT       = (os.getenv("ADGUARD_PORT") or "80").strip()   # พอร์ต web UI / control API ของ AdGuard
ADGUARD_USER       = (os.getenv("ADGUARD_USER") or "").strip()     # username สำหรับ Basic Auth
ADGUARD_PASSWORD   = (os.getenv("ADGUARD_PASSWORD") or "").strip() # password สำหรับ Basic Auth

PORT               = int(os.getenv("PORT", "5000"))
HTTPS_PORT         = int(os.getenv("HTTPS_PORT", "5443"))            # HTTPS ขนาน (สำหรับ port-forward/เข้าจากนอกบ้าน)
SSL_CERT           = os.getenv("SSL_CERT", os.path.join(BASE_DIR, "cert.pem"))
SSL_KEY            = os.getenv("SSL_KEY",  os.path.join(BASE_DIR, "key.pem"))
TEMP_ALERT         = float(os.getenv("TEMP_ALERT", "55"))
COLLECT_INTERVAL   = int(os.getenv("COLLECT_INTERVAL", "600"))   # วินาที (default 10 นาที)
DAILY_REPORT_HOUR  = int(os.getenv("DAILY_REPORT_HOUR", "8"))
REBOOT_POLL_SEC    = int(os.getenv("REBOOT_POLL_SEC", "15"))

# ─── Alerts (แจ้งเตือนตาม threshold + Event Log) ───
ALERT_FILE     = os.path.join(BASE_DIR, "alert_config.json")
ALERT_DEFAULT  = {"enabled": True, "telegram": True,
                  "temp": float(os.getenv("TEMP_ALERT", "70")), "cpu": 90.0, "ram": 90.0, "disk": 90.0}
RETAIN_DAYS    = int(os.getenv("RETAIN_DAYS", "120"))   # auto-cleanup: เก็บข้อมูลย้อนหลังกี่วัน (0 = ไม่ลบ)

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
    # event log (แจ้งเตือน / กลับสู่ปกติ / ระบบเริ่มทำงาน ฯลฯ)
    con.execute("""
        CREATE TABLE IF NOT EXISTS events (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            ts        TEXT NOT NULL,
            type      TEXT NOT NULL,
            metric    TEXT,
            value     REAL,
            severity  TEXT,
            message   TEXT
        )
    """)
    # active sessions (รองรับ list/revoke จากหน้า Security)
    con.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            sid        TEXT PRIMARY KEY,
            ip         TEXT,
            ua         TEXT,
            created    TEXT,
            last_seen  TEXT
        )
    """)
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


# ─── alerts + event log ──────────────────────────────────────────────────────────

def load_alert_config():
    cfg = dict(ALERT_DEFAULT)
    try:
        with open(ALERT_FILE) as f:
            cfg.update(json.load(f))
    except Exception:
        pass
    return cfg


def save_alert_config(raw):
    cfg = dict(ALERT_DEFAULT)
    cfg["enabled"]  = bool(raw.get("enabled", True))
    cfg["telegram"] = bool(raw.get("telegram", True))
    for m in ("temp", "cpu", "ram", "disk"):
        try:
            cfg[m] = max(0.0, min(100.0 if m != "temp" else 120.0, float(raw.get(m, ALERT_DEFAULT[m]))))
        except Exception:
            pass
    with open(ALERT_FILE, "w") as f:
        json.dump(cfg, f)
    push_alert_config(cfg)
    return cfg


def push_alert_config(cfg):
    if db_fs:
        try:
            db_fs.collection("settings").document("alerts").set(cfg)
        except Exception as e:
            print(f"[alerts] push config ล้มเหลว: {e}")


def log_event(etype, metric, value, severity, message):
    now = datetime.now()
    try:
        con = sqlite3.connect(DB_PATH)
        con.execute("INSERT INTO events (ts,type,metric,value,severity,message) VALUES (?,?,?,?,?,?)",
                    (now.strftime("%Y-%m-%d %H:%M:%S"), etype, metric,
                     (None if value is None else round(value, 1)), severity, message))
        con.commit()
        con.close()
    except Exception as e:
        print(f"[events] log ล้มเหลว: {e}")
    if db_fs:
        try:
            db_fs.collection("events").add({
                "ts": _aware(now), "type": etype, "metric": metric,
                "value": (None if value is None else round(value, 1)),
                "severity": severity, "message": message})
        except Exception as e:
            print(f"[events] push ล้มเหลว: {e}")


_alert_state = {"temp": False, "cpu": False, "ram": False, "disk": False, "throttle": False}
_ALERT_NAMES = {"temp": "อุณหภูมิ", "cpu": "CPU", "ram": "RAM", "disk": "Disk"}
_ALERT_UNITS = {"temp": "°C", "cpu": "%", "ram": "%", "disk": "%"}

def check_alerts(now, temp, cpu, ram_pct, disk_pct):
    """ตรวจ threshold ทุก metric — แจ้งครั้งเดียวตอนเกิน และครั้งเดียวตอนกลับปกติ (กันสแปม)"""
    cfg = load_alert_config()
    if not cfg.get("enabled", True):
        return
    vals = {"temp": temp, "cpu": cpu, "ram": ram_pct, "disk": disk_pct}
    for m, val in vals.items():
        thr = cfg.get(m)
        if thr is None:
            continue
        u, name = _ALERT_UNITS[m], _ALERT_NAMES[m]
        if val >= thr and not _alert_state[m]:
            _alert_state[m] = True
            log_event("alert", m, val, "danger", f"{name} {val:.1f}{u} เกินเกณฑ์ {thr:.0f}{u}")
            if cfg.get("telegram", True):
                broadcast(f"🚨 <b>แจ้งเตือน: {name}สูง</b>\n{name}: <b>{val:.1f}{u}</b> (เกณฑ์ {thr:.0f}{u})\n🕐 {now.strftime('%d/%m/%Y %H:%M')}")
        elif val < thr and _alert_state[m]:
            _alert_state[m] = False
            log_event("recovery", m, val, "ok", f"{name} กลับสู่ปกติ {val:.1f}{u}")
            if cfg.get("telegram", True):
                broadcast(f"✅ <b>{name}กลับสู่ปกติ</b>\n{name}: <b>{val:.1f}{u}</b>\n🕐 {now.strftime('%d/%m/%Y %H:%M')}")

    # throttle / undervoltage — สถานะ boolean (ไม่ใช่ threshold) แต่สำคัญสุด: ไฟไม่พอทำ SD พังได้
    th = get_throttle_status()
    if th is not None:
        n_ = th["now"]
        bad = []
        if n_["undervoltage"]:               bad.append("ไฟไม่พอ (undervoltage)")
        if n_["throttled"] or n_["freq_capped"]: bad.append("ลดสปีด (throttled)")
        if n_["soft_temp"]:                  bad.append("ร้อนเกิน (soft temp limit)")
        if bad and not _alert_state["throttle"]:
            _alert_state["throttle"] = True
            msg = " · ".join(bad)
            log_event("alert", "throttle", None, "danger", f"⚡ ฮาร์ดแวร์: {msg}")
            if cfg.get("telegram", True):
                broadcast(f"⚡ <b>แจ้งเตือน: ปัญหาไฟ/ฮาร์ดแวร์</b>\nสถานะ: <b>{msg}</b>\n"
                          f"🕐 {now.strftime('%d/%m/%Y %H:%M')}\n⚠️ ตรวจอะแดปเตอร์/สายไฟ — ไฟไม่พอเสี่ยง SD card พัง")
        elif not bad and _alert_state["throttle"]:
            _alert_state["throttle"] = False
            log_event("recovery", "throttle", None, "ok", "⚡ ไฟ/ฮาร์ดแวร์กลับสู่ปกติ")
            if cfg.get("telegram", True):
                broadcast(f"✅ <b>ไฟ/ฮาร์ดแวร์กลับสู่ปกติ</b>\n🕐 {now.strftime('%d/%m/%Y %H:%M')}")


def cleanup_old_data():
    """ลบข้อมูล/event เก่ากว่า RETAIN_DAYS — คุมขนาด DB (เรียกวันละครั้ง)"""
    if RETAIN_DAYS <= 0:
        return
    cutoff = (datetime.now() - timedelta(days=RETAIN_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    try:
        con = sqlite3.connect(DB_PATH)
        n1 = con.execute("DELETE FROM temperature WHERE timestamp < ?", (cutoff,)).rowcount
        n2 = con.execute("DELETE FROM events WHERE ts < ? AND type != 'system'", (cutoff,)).rowcount
        con.commit()
        con.execute("VACUUM")
        con.close()
        if n1 or n2:
            print(f"[cleanup] ลบ readings {n1} แถว, events {n2} แถว (เก่ากว่า {RETAIN_DAYS} วัน)")
    except Exception as e:
        print(f"[cleanup] error: {e}")


# ─── sessions (security) ─────────────────────────────────────────────────────────
import hmac, secrets as _secrets

def _now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def session_create(ip, ua):
    sid = _secrets.token_hex(16)
    n = _now_str()
    con = sqlite3.connect(DB_PATH)
    con.execute("INSERT INTO sessions (sid,ip,ua,created,last_seen) VALUES (?,?,?,?,?)", (sid, ip, ua, n, n))
    con.commit(); con.close()
    return sid

def session_check(sid):
    """sid ยัง valid ไหม (อยู่ใน registry) — ใช้รองรับการ revoke"""
    if not sid:
        return False
    rows = query("SELECT last_seen FROM sessions WHERE sid = ?", (sid,))
    if not rows:
        return False
    try:
        last = datetime.strptime(rows[0][0], "%Y-%m-%d %H:%M:%S")
        if (datetime.now() - last).total_seconds() > 60:   # touch แบบประหยัด
            con = sqlite3.connect(DB_PATH)
            con.execute("UPDATE sessions SET last_seen = ? WHERE sid = ?", (_now_str(), sid))
            con.commit(); con.close()
    except Exception:
        pass
    return True

def session_delete(sid):
    if not sid:
        return
    con = sqlite3.connect(DB_PATH); con.execute("DELETE FROM sessions WHERE sid = ?", (sid,)); con.commit(); con.close()


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


def _vcgencmd(*args):
    """เรียก vcgencmd แล้วคืน stdout (str) — คืน None ถ้าไม่ใช่ Pi / สั่งไม่ได้"""
    try:
        r = subprocess.run(["vcgencmd", *args], capture_output=True, text=True, timeout=4)
        return r.stdout.strip()
    except Exception:
        return None


def get_throttle_status():
    """อ่านสถานะ throttle / undervoltage จาก vcgencmd get_throttled (เฉพาะ Pi)

    bit map ของ get_throttled:
        0x1     under-voltage ตอนนี้        0x10000  under-voltage เคยเกิดตั้งแต่บูต
        0x2     ARM freq ถูกจำกัดตอนนี้      0x20000  freq capping เคยเกิด
        0x4     throttled ตอนนี้            0x40000  throttling เคยเกิด
        0x8     soft temp limit ตอนนี้      0x80000  soft temp limit เคยเกิด

    คืน None ถ้าไม่ใช่ Pi/อ่านไม่ได้ — ตัวเรียกจะข้ามไป (ส่ง throttle=None)
    """
    raw = _vcgencmd("get_throttled")                 # เช่น "throttled=0x0"
    if not raw or "=" not in raw:
        return None
    try:
        val = int(raw.split("=")[1], 16)
    except Exception:
        return None

    now  = {"undervoltage": bool(val & 0x1),     "freq_capped": bool(val & 0x2),
            "throttled":    bool(val & 0x4),     "soft_temp":   bool(val & 0x8)}
    past = {"undervoltage": bool(val & 0x10000), "freq_capped": bool(val & 0x20000),
            "throttled":    bool(val & 0x40000), "soft_temp":   bool(val & 0x80000)}

    volts = None                                     # แรงดันไฟ core (V)
    vraw = _vcgencmd("measure_volts")                # "volt=0.8625V"
    if vraw and "=" in vraw:
        try: volts = round(float(vraw.split("=")[1].replace("V", "")), 3)
        except Exception: pass

    clock = None                                     # ความเร็ว CPU จริง (MHz)
    craw = _vcgencmd("measure_clock", "arm")         # "frequency(48)=1500398464"
    if craw and "=" in craw:
        try: clock = int(craw.split("=")[1]) // 1000000
        except Exception: pass

    return {"raw": val, "healthy": (val == 0), "now": now, "past": past,
            "volts": volts, "clock_mhz": clock}


def collect_metrics():
    temp = get_cpu_temp()
    cpu  = psutil.cpu_percent(interval=1)
    ram  = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    return temp, cpu, ram, disk


# ─── AdGuard Home stats ──────────────────────────────────────────────────────────

def get_adguard_stats():
    """ดึงสถิติจาก AdGuard Home (/control/stats + /control/status) ผ่าน HTTP Basic Auth

    ออกแบบให้ "ไม่ทำให้ระบบพัง" — ถ้า AdGuard ปิดอยู่/ต่อไม่ได้/ข้อมูลผิดรูปแบบ
    จะคืน None เฉยๆ เพื่อให้ตัวเรียกข้ามไป แล้วส่งเฉพาะค่า hardware ต่อได้ตามปกติ

    คืน dict เช่น:
        {"dns_queries": 15200, "blocked_filtering": 4500,
         "replaced_safebrowsing": 12, "replaced_parental": 0,
         "protection_enabled": True, "running": True}
    """
    if not ADGUARD_IP:                       # ไม่ได้ตั้งค่า = ปิดฟีเจอร์ ไม่ต้องยิง request
        return None

    base = f"http://{ADGUARD_IP}:{ADGUARD_PORT}"
    auth = (ADGUARD_USER, ADGUARD_PASSWORD) if ADGUARD_USER else None
    try:
        # /control/stats — สถิติการ query/บล็อก   |   /control/status — สถานะระบบ
        stats  = requests.get(f"{base}/control/stats",  auth=auth, timeout=4).json()
        status = requests.get(f"{base}/control/status", auth=auth, timeout=4).json()
    except Exception as e:
        print(f"[adguard] ดึงข้อมูลไม่ได้ (ข้าม ส่งเฉพาะ hardware): {e}")
        return None

    try:
        return {
            "dns_queries":           int(stats.get("num_dns_queries", 0)),
            "blocked_filtering":     int(stats.get("num_blocked_filtering", 0)),
            "replaced_safebrowsing": int(stats.get("num_replaced_safebrowsing", 0)),
            "replaced_parental":     int(stats.get("num_replaced_parental", 0)),
            "protection_enabled":    bool(status.get("protection_enabled", False)),
            "running":               bool(status.get("running", True)),
            # Top 5 — แปลง [{name:count}] → [{key:name, count:count}] เอาแค่ 5 อันดับแรก
            "top_blocked": _ag_top(stats.get("top_blocked_domains"), "domain"),
            "top_queries": _ag_top(stats.get("top_queried_domains"), "domain"),
            "top_clients": _ag_top(stats.get("top_clients"),         "client"),
        }
    except Exception as e:
        print(f"[adguard] ข้อมูลผิดรูปแบบ (ข้าม): {e}")
        return None


def _ag_top(arr, key, n=5):
    """แปลง array ของ AdGuard ([{name:count}, ...]) → [{key:name, count:count}] เอา n อันดับแรก"""
    out = []
    for item in (arr or [])[:n]:
        if isinstance(item, dict) and item:
            name, count = next(iter(item.items()))
            out.append({key: name, "count": int(count)})
    return out


def set_adguard_protection(enabled, duration_ms=0):
    """เปิด/ปิดการป้องกันของ AdGuard ผ่าน POST /control/protection
       - enabled=False + duration_ms>0 = ปิดชั่วคราว (เช่น 300000 = 5 นาที)
       - enabled=True = เปิดทำงานปกติ
       คืน (ok: bool, msg: str)"""
    if not ADGUARD_IP:
        return False, "AdGuard ไม่ได้ตั้งค่า"
    base = f"http://{ADGUARD_IP}:{ADGUARD_PORT}"
    auth = (ADGUARD_USER, ADGUARD_PASSWORD) if ADGUARD_USER else None
    payload = {"enabled": bool(enabled)}
    if not enabled and duration_ms:
        payload["duration"] = int(duration_ms)
    try:
        r = requests.post(f"{base}/control/protection", json=payload, auth=auth, timeout=5)
        if r.status_code in (200, 204):
            return True, "ok"
        return False, f"AdGuard ตอบกลับ {r.status_code}"
    except Exception as e:
        return False, str(e)


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


# net speed แบบ delta ระหว่างการเรียกสองครั้ง (ไม่ต้อง sleep — ใช้กับ /api/status ที่ถูก poll เป็นช่วง)
_NET_LAST = {"t": None, "recv": 0, "sent": 0}


def get_net_speed():
    io  = psutil.net_io_counters()
    now = time.time()
    last = _NET_LAST
    if last["t"] is None:
        _NET_LAST.update(t=now, recv=io.bytes_recv, sent=io.bytes_sent)
        return {"down_kbps": 0.0, "up_kbps": 0.0}
    dt = max(now - last["t"], 0.5)
    down = (io.bytes_recv - last["recv"]) / dt / 1024
    up   = (io.bytes_sent - last["sent"]) / dt / 1024
    _NET_LAST.update(t=now, recv=io.bytes_recv, sent=io.bytes_sent)
    return {"down_kbps": round(max(0.0, down), 1), "up_kbps": round(max(0.0, up), 1)}


def get_disk_partitions():
    """รายการ partition จริง + การใช้งาน (ข้าม pseudo/loop/overlay) — เรียงตาม % มาก→น้อย"""
    out = []
    for p in psutil.disk_partitions(all=False):
        if p.fstype in ("", "squashfs", "overlay", "tmpfs", "devtmpfs"):
            continue
        try:
            u = psutil.disk_usage(p.mountpoint)
        except Exception:
            continue
        out.append({
            "mount":    p.mountpoint,
            "device":   p.device,
            "fstype":   p.fstype,
            "pct":      round(u.percent, 1),
            "used_gb":  round(u.used  / 1073741824, 1),
            "total_gb": round(u.total / 1073741824, 1),
            "free_gb":  round(u.free  / 1073741824, 1),
        })
    out.sort(key=lambda x: x["pct"], reverse=True)
    return out


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
        "disks": get_disk_partitions(),
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
        status_doc = {
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
            **get_net_speed(),               # down_kbps, up_kbps
        }
        thr = get_throttle_status()          # throttle/undervoltage (เฉพาะ Pi) — ข้ามถ้าไม่ใช่ Pi
        if thr is not None:
            status_doc["throttle"] = thr
        ag = get_adguard_stats()             # เพิ่มข้อมูล AdGuard ถ้าดึงได้ (ไม่ได้ก็ข้าม)
        if ag is not None:
            status_doc["adguard"] = ag
        db_fs.collection("status").document("latest").set(status_doc)
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
flask_app.config["MAX_CONTENT_LENGTH"] = FILES_MAX_MB * 1024 * 1024   # จำกัดขนาดอัปโหลด


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
sock = Sock(flask_app)


def require_auth(f):
    """endpoint ที่ต้อง login ก่อน (เฉพาะเมื่อมีตั้ง WEB_PASSWORD)"""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if WEB_PASSWORD and not (session.get("authed") and session_check(session.get("sid"))):
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
    authed = (not WEB_PASSWORD) or (bool(session.get("authed")) and session_check(session.get("sid")))
    return jsonify({
        "authed": authed,
        "auth_required": bool(WEB_PASSWORD),
    })


def _client_ip():
    return (request.headers.get("X-Forwarded-For") or request.remote_addr or "?").split(",")[0].strip()


# ─── rate-limit login (กัน brute-force รหัส LAN) ──────────────────────────────────
_login_attempts = {}        # ip -> {"fails": int, "until": epoch}
_LOGIN_MAX  = 5             # ผิดได้กี่ครั้งก่อนเริ่มล็อก
_LOGIN_LOCK = 300          # วินาทีต่อรอบล็อก (escalate ทุกครั้งที่ผิดเพิ่ม)

def _login_locked(ip):
    rec = _login_attempts.get(ip)
    return int(rec["until"] - time.time()) if rec and rec["until"] > time.time() else 0

def _login_fail(ip):
    rec = _login_attempts.setdefault(ip, {"fails": 0, "until": 0})
    rec["fails"] += 1
    if rec["fails"] >= _LOGIN_MAX:                          # 5 นาที → 10 → 15 … สูงสุด 1 ชม.
        rec["until"] = time.time() + min(3600, _LOGIN_LOCK * (rec["fails"] - _LOGIN_MAX + 1))
    return rec["fails"]

def _login_ok(ip):
    _login_attempts.pop(ip, None)


@flask_app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(silent=True) or {}
    pw = data.get("password") or ""
    ip = _client_ip()
    ua = (request.headers.get("User-Agent") or "")[:140]

    locked = _login_locked(ip)
    if locked:
        log_event("login", "auth", None, "danger", f"ถูกล็อก (ลองผิดเกินกำหนด) — {ip} เหลือ {locked}s")
        return jsonify({"ok": False, "locked": True, "retry": locked,
                        "error": f"ลองผิดเกินกำหนด — รอ {locked} วินาทีแล้วลองใหม่"}), 429

    if not (WEB_PASSWORD and hmac.compare_digest(pw, WEB_PASSWORD)):
        fails = _login_fail(ip)
        left = max(0, _LOGIN_MAX - fails)
        wait = _login_locked(ip)
        msg = (f"รหัสผ่านไม่ถูกต้อง — เหลืออีก {left} ครั้งก่อนถูกล็อก" if left
               else f"ลองผิดเกินกำหนด — รอ {wait} วินาที")
        log_event("login", "auth", None, "danger", f"เข้าสู่ระบบล้มเหลว (รหัสผิด ครั้งที่ {fails}) — {ip}")
        return jsonify({"ok": False, "error": msg, "left": left, "retry": wait}), 401

    _login_ok(ip)                              # สำเร็จ — รีเซ็ตตัวนับของ IP นี้
    sid = session_create(ip, ua)
    session["authed"] = True
    session["sid"] = sid
    session.permanent = True
    log_event("login", "auth", None, "ok", f"เข้าสู่ระบบสำเร็จ — {ip}")
    return jsonify({"ok": True})


@flask_app.route("/api/logout", methods=["POST"])
def api_logout():
    session_delete(session.get("sid"))
    session.clear()
    return jsonify({"ok": True})


# ─── security: sessions ────────────────────────────────────────────────────────────

@flask_app.route("/api/sessions")
@require_auth
def api_sessions():
    cur = session.get("sid")
    rows = query("SELECT sid,ip,ua,created,last_seen FROM sessions ORDER BY last_seen DESC")
    return jsonify({"sessions": [
        {"sid": r[0], "ip": r[1], "ua": r[2], "created": r[3], "last_seen": r[4], "current": (r[0] == cur)}
        for r in rows]})


@flask_app.route("/api/sessions/revoke", methods=["POST"])
@require_auth
def api_sessions_revoke():
    data = request.get_json(silent=True) or {}
    cur = session.get("sid")
    if data.get("all"):
        con = sqlite3.connect(DB_PATH)
        con.execute("DELETE FROM sessions WHERE sid != ?", (cur,))
        con.commit(); con.close()
        log_event("info", "auth", None, "warn", "ออกจากระบบทุกอุปกรณ์อื่น")
    elif data.get("sid"):
        session_delete(data["sid"])
        log_event("info", "auth", None, "warn", f"เพิกถอน session {str(data['sid'])[:8]}…")
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
        **get_net_speed(),                  # down_kbps, up_kbps (เน็ตเวิร์ก speed)
        "throttle": get_throttle_status(),  # None ถ้าไม่ใช่ Pi/อ่านไม่ได้
        "adguard": get_adguard_stats(),     # None ถ้า AdGuard ปิด/ต่อไม่ได้
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


@flask_app.route("/api/history_range")
@require_auth
def api_history_range():
    """กราฟย้อนหลัง temp/cpu/ram ตามช่วงที่เลือก — bucket อัตโนมัติ
       24h → ราย 1 ชม. | 7d → ราย 3 ชม. | 30d → รายวัน"""
    rng = request.args.get("range", "24h")
    cfg = {
        "24h": (timedelta(hours=24), 3600),       # bucket 1 ชม.
        "7d":  (timedelta(days=7),   3 * 3600),   # bucket 3 ชม.
        "30d": (timedelta(days=30),  86400),      # bucket 1 วัน
    }.get(rng)
    if not cfg:
        rng, cfg = "24h", (timedelta(hours=24), 3600)
    span, bucket = cfg
    day_mode = (bucket >= 86400)
    since = (datetime.now() - span).strftime("%Y-%m-%d %H:%M:%S")
    rows = query("SELECT timestamp, temp_c, cpu_pct, ram_pct, disk_pct FROM temperature "
                 "WHERE timestamp >= ? ORDER BY timestamp", (since,))

    buckets = {}   # key → {"t":[], "c":[], "r":[], "d":[], "ord":epoch}
    for ts, temp, cpu, ram, disk in rows:
        dt = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
        if day_mode:
            key = dt.strftime("%Y-%m-%d")
            ordv = dt.replace(hour=0, minute=0, second=0).timestamp()
        else:
            epoch = int(dt.timestamp())
            key = epoch - (epoch % bucket)
            ordv = key
        b = buckets.get(key)
        if b is None:
            b = buckets[key] = {"t": [], "c": [], "r": [], "d": [], "ord": ordv}
        if temp is not None: b["t"].append(temp)
        if cpu  is not None: b["c"].append(cpu)
        if ram  is not None: b["r"].append(ram)
        if disk is not None: b["d"].append(disk)

    keys = sorted(buckets, key=lambda k: buckets[k]["ord"])
    avg = lambda a: round(sum(a) / len(a), 1) if a else None

    def label(k):
        b = buckets[k]
        d = datetime.fromtimestamp(b["ord"])
        if day_mode:
            return f"{d.day}/{d.month}"
        if rng == "24h":
            return f"{d.hour:02d}:{d.minute:02d}"
        return f"{d.day}/{d.month} {d.hour:02d}:00"

    return jsonify({
        "range":  rng,
        "labels": [label(k) for k in keys],
        "temp":   [avg(buckets[k]["t"]) for k in keys],
        "cpu":    [avg(buckets[k]["c"]) for k in keys],
        "ram":    [avg(buckets[k]["r"]) for k in keys],
        "disk":   [avg(buckets[k]["d"]) for k in keys],
        "count":  len(rows),
    })


@flask_app.route("/api/events")
@require_auth
def api_events():
    limit = max(1, min(int(request.args.get("limit", 60)), 200))
    rows = query("SELECT ts,type,metric,value,severity,message FROM events ORDER BY id DESC LIMIT ?", (limit,))
    return jsonify({"events": [
        {"ts": r[0], "type": r[1], "metric": r[2], "value": r[3], "severity": r[4], "message": r[5]}
        for r in rows]})


@flask_app.route("/api/alert_config", methods=["GET", "POST"])
@require_auth
def api_alert_config():
    if request.method == "POST":
        cfg = save_alert_config(request.get_json(silent=True) or {})
        log_event("info", "config", None, "info", "ปรับตั้งค่าการแจ้งเตือน")
        return jsonify({"ok": True, "config": cfg})
    return jsonify({"config": load_alert_config()})


@flask_app.route("/api/monthly")
@require_auth
def api_monthly():
    month = request.args.get("month") or datetime.now().strftime("%Y-%m")   # รับ ?month=YYYY-MM ได้
    rows = query("SELECT timestamp, temp_c FROM temperature WHERE timestamp LIKE ? ORDER BY timestamp", (f"{month}%",))
    buckets = {}
    for ts, temp in rows:
        day = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").date()
        buckets.setdefault(day, []).append(temp)
    days = sorted(buckets)
    try:
        month_name = datetime.strptime(month + "-01", "%Y-%m-%d").strftime("%B %Y")
    except Exception:
        month_name = month
    return jsonify({
        "labels": [str(d.day) for d in days],
        "data":   [round(sum(buckets[d]) / len(buckets[d]), 1) for d in days],
        "month":  month_name,
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
    month = request.args.get("month") or datetime.now().strftime("%Y-%m")   # รับ ?month=YYYY-MM ได้
    rows = query("SELECT timestamp, cpu_pct, ram_pct, disk_pct FROM temperature "
                 "WHERE timestamp LIKE ? AND cpu_pct IS NOT NULL ORDER BY timestamp", (f"{month}%",))
    keys, b, avg = _system_buckets(rows, by_day=True)
    try:
        month_name = datetime.strptime(month + "-01", "%Y-%m-%d").strftime("%B %Y")
    except Exception:
        month_name = month
    return jsonify({
        "labels": [str(k.day) for k in keys],
        "cpu": [avg(b["cpu"], k) for k in keys],
        "ram": [avg(b["ram"], k) for k in keys],
        "disk": [avg(b["disk"], k) for k in keys],
        "month": month_name,
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


# ─── file transfer / dropzone (HTTP ล้วน — ต้อง login) ───────────────────────────

def _files_safe(name):
    """กัน path traversal — คืน absolute path ที่อยู่ใน FILES_DIR เท่านั้น (ไม่งั้น None)"""
    name = os.path.basename(name or "").strip()
    if not name or name in (".", ".."):
        return None
    p = os.path.realpath(os.path.join(FILES_DIR, name))
    if os.path.dirname(p) != os.path.realpath(FILES_DIR):
        return None
    return p


@flask_app.route("/api/files")
@require_auth
def api_files_list():
    out, used = [], 0
    for n in sorted(os.listdir(FILES_DIR)):
        fp = os.path.join(FILES_DIR, n)
        if os.path.isfile(fp):
            st = os.stat(fp)
            used += st.st_size
            out.append({"name": n, "size": st.st_size, "mtime": int(st.st_mtime)})
    du = psutil.disk_usage(FILES_DIR)
    return jsonify({"files": out, "used": used, "free": du.free, "disk_total": du.total})


@flask_app.route("/api/files/upload", methods=["POST"])
@require_auth
def api_files_upload():
    saved, skipped = [], []
    for f in request.files.getlist("files"):          # รองรับหลายไฟล์
        if not f or not f.filename:
            continue
        p = _files_safe(f.filename)                   # เก็บชื่อเดิม (แค่ตัด path ทิ้ง)
        if not p:
            skipped.append(f.filename)
            continue
        f.save(p)
        saved.append(os.path.basename(p))
    return jsonify({"ok": True, "saved": saved, "skipped": skipped})


@flask_app.route("/api/files/download/<path:name>")
@require_auth
def api_files_download(name):
    p = _files_safe(name)
    if not p or not os.path.isfile(p):
        return jsonify({"error": "not found"}), 404
    return send_from_directory(FILES_DIR, os.path.basename(p), as_attachment=True)


@flask_app.route("/api/files/delete", methods=["POST"])
@require_auth
def api_files_delete():
    data = request.get_json(silent=True) or {}
    p = _files_safe(data.get("name"))
    if not p or not os.path.isfile(p):
        return jsonify({"ok": False, "error": "not found"}), 404
    os.remove(p)
    return jsonify({"ok": True})


@flask_app.route("/api/files/view/<path:name>")
@require_auth
def api_files_view(name):
    p = _files_safe(name)
    if not p or not os.path.isfile(p):
        return jsonify({"error": "not found"}), 404
    MAX = 1024 * 1024   # อ่านมากสุด 1MB
    size = os.path.getsize(p)
    try:
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            text = f.read(MAX)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"text": text, "truncated": size > MAX, "size": size})


@flask_app.route("/api/files/rename", methods=["POST"])
@require_auth
def api_files_rename():
    data = request.get_json(silent=True) or {}
    src = _files_safe(data.get("old"))
    dst = _files_safe(data.get("new"))
    if not src or not os.path.isfile(src):
        return jsonify({"ok": False, "error": "ไม่พบไฟล์ต้นทาง"}), 404
    if not dst:
        return jsonify({"ok": False, "error": "ชื่อใหม่ไม่ถูกต้อง"}), 400
    if os.path.exists(dst):
        return jsonify({"ok": False, "error": "มีไฟล์ชื่อนี้อยู่แล้ว"}), 409
    os.rename(src, dst)
    return jsonify({"ok": True})


# ─── notes (เขียนโน้ต / แปะลิงก์) — sync ผ่าน Firestore, fallback ไฟล์ ───────────────

def _notes_local_load():
    try:
        return json.load(open(NOTES_FILE, encoding="utf-8"))
    except Exception:
        return []


def _notes_local_save(notes):
    try:
        json.dump(notes, open(NOTES_FILE, "w", encoding="utf-8"), ensure_ascii=False)
    except Exception as e:
        print(f"[notes] save error: {e}")


@flask_app.route("/api/notes")
@require_auth
def api_notes_list():
    if db_fs:
        try:
            out = []
            for d in db_fs.collection("notes").stream():
                x = d.to_dict()
                out.append({"id": d.id, "title": x.get("title", ""),
                            "text": x.get("text", ""), "updated": int(x.get("updated", 0)),
                            "created": int(x.get("created", x.get("updated", 0)))})
            out.sort(key=lambda n: n["updated"], reverse=True)
            return jsonify({"notes": out})
        except Exception as e:
            print(f"[notes] fs list error: {e}")
    return jsonify({"notes": _notes_local_load()})


@flask_app.route("/api/notes", methods=["POST"])
@require_auth
def api_notes_add():
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    text  = (data.get("text") or "").strip()
    now = int(time.time())
    if db_fs:
        ref = db_fs.collection("notes").document()
        ref.set({"title": title, "text": text, "updated": now, "created": now})
        return jsonify({"ok": True, "id": ref.id})
    notes = _notes_local_load()
    nid = str(now * 1000)
    notes.insert(0, {"id": nid, "title": title, "text": text, "updated": now})
    _notes_local_save(notes)
    return jsonify({"ok": True, "id": nid})


@flask_app.route("/api/notes/<nid>", methods=["POST"])
@require_auth
def api_notes_update(nid):
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    text  = (data.get("text") or "").strip()
    now = int(time.time())
    if db_fs:
        db_fs.collection("notes").document(nid).set({"title": title, "text": text, "updated": now}, merge=True)
        return jsonify({"ok": True})
    notes = _notes_local_load()
    for n in notes:
        if n["id"] == nid:
            n["title"], n["text"], n["updated"] = title, text, now
    _notes_local_save(notes)
    return jsonify({"ok": True})


@flask_app.route("/api/notes/<nid>/delete", methods=["POST"])
@require_auth
def api_notes_delete(nid):
    if db_fs:
        db_fs.collection("notes").document(nid).delete()
        return jsonify({"ok": True})
    _notes_local_save([n for n in _notes_local_load() if n["id"] != nid])
    return jsonify({"ok": True})


# ─── UI settings (theme/สี/ฟอนต์) — sync ผ่าน Firestore, fallback ไฟล์ ───────────────

SETTINGS_FILE = os.path.join(BASE_DIR, "ui_settings.json")


@flask_app.route("/api/settings")
@require_auth
def api_settings_get():
    if db_fs:
        try:
            doc = db_fs.collection("settings").document("ui").get()
            return jsonify({"settings": doc.to_dict() if doc.exists else None})
        except Exception as e:
            print(f"[settings] fs read error: {e}")
    try:
        return jsonify({"settings": json.load(open(SETTINGS_FILE, encoding="utf-8"))})
    except Exception:
        return jsonify({"settings": None})


@flask_app.route("/api/settings", methods=["POST"])
@require_auth
def api_settings_save():
    data = request.get_json(silent=True) or {}
    if db_fs:
        try:
            db_fs.collection("settings").document("ui").set(data, merge=True)
            return jsonify({"ok": True})
        except Exception as e:
            print(f"[settings] fs save error: {e}")
    try:
        json.dump(data, open(SETTINGS_FILE, "w", encoding="utf-8"), ensure_ascii=False)
    except Exception as e:
        print(f"[settings] file save error: {e}")
    return jsonify({"ok": True})


@sock.route("/ws/terminal")
def ws_terminal(ws):
    """Full PTY terminal ผ่าน WebSocket (ไม่มี timeout) — ต้อง login ก่อน
       client→server: JSON {"type":"input","data":...} หรือ {"type":"resize","cols":..,"rows":..}
       server→client: ข้อความ output ดิบจาก bash"""
    if WEB_PASSWORD and not session.get("authed"):
        try:
            ws.send("\x1b[31m[unauthorized — กรุณา login ก่อน]\x1b[0m\r\n")
        except Exception:
            pass
        return

    master, slave = pty.openpty()
    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    proc = subprocess.Popen(
        ["bash"], preexec_fn=os.setsid,
        stdin=slave, stdout=slave, stderr=slave,
        cwd=os.path.expanduser("~"), env=env,
    )
    os.close(slave)
    stop = threading.Event()

    def reader():
        while not stop.is_set():
            try:
                r, _, _ = select.select([master], [], [], 0.2)
                if master in r:
                    data = os.read(master, 4096)
                    if not data:
                        break
                    ws.send(data.decode(errors="ignore"))
            except Exception:
                break
        stop.set()

    th = threading.Thread(target=reader, daemon=True)
    th.start()

    try:
        while not stop.is_set():
            msg = ws.receive(timeout=1)
            if msg is None:
                if proc.poll() is not None:
                    break
                continue
            try:
                obj = json.loads(msg)
            except Exception:
                obj = {"type": "input", "data": msg}
            if obj.get("type") == "resize":
                cols = int(obj.get("cols", 80)); rows = int(obj.get("rows", 24))
                try:
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                except Exception:
                    pass
            else:
                os.write(master, (obj.get("data", "")).encode())
    except Exception:
        pass
    finally:
        stop.set()
        try:
            proc.kill()
        except Exception:
            pass
        try:
            os.close(master)
        except Exception:
            pass


@flask_app.route("/api/adguard/protection", methods=["POST"])
@require_auth
def api_adguard_protection():
    data = request.get_json(silent=True) or {}
    enabled  = bool(data.get("enabled"))
    duration = int(data.get("duration") or 0)
    ok, msg = set_adguard_protection(enabled, duration)
    return jsonify({"ok": ok, "error": None if ok else msg, "adguard": get_adguard_stats()})


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


# ─── export CSV / reboot history / speedtest ─────────────────────────────────────

@flask_app.route("/api/export.csv")
@require_auth
def api_export_csv():
    """ดาวน์โหลดข้อมูล temp/cpu/ram/disk เป็น CSV (ค่าเริ่มต้น 30 วันล่าสุด)"""
    try:
        days = max(1, min(int(request.args.get("days", "30")), 3650))
    except Exception:
        days = 30
    since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    rows = query("SELECT timestamp, temp_c, cpu_pct, ram_pct, disk_pct FROM temperature "
                 "WHERE timestamp >= ? ORDER BY timestamp", (since,))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["timestamp", "temp_c", "cpu_pct", "ram_pct", "disk_pct"])
    for r in rows:
        w.writerow(["" if v is None else v for v in r])
    fname = f"ajpao-monitor_{datetime.now():%Y%m%d_%H%M}.csv"
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


def get_reboot_history(limit=15):
    """ประวัติการบูตจาก `last -F reboot` (/var/log/wtmp) — คำนวณช่วง uptime ของแต่ละบูตเอง"""
    try:
        r = subprocess.run(["last", "-F", "reboot"], capture_output=True, text=True, timeout=5)
    except Exception:
        return []
    pat = re.compile(r"([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})")  # Mon DD HH:MM:SS YYYY
    boots = []
    for ln in r.stdout.splitlines():
        if not ln.startswith("reboot"):
            continue
        m = pat.search(ln)
        if not m:
            continue
        try:
            boots.append(datetime.strptime(f"{m.group(1)} {m.group(2)} {m.group(3)} {m.group(4)}",
                                           "%b %d %H:%M:%S %Y"))
        except Exception:
            pass
    boots = sorted(set(boots), reverse=True)
    now = datetime.now()
    out = []
    for i, b in enumerate(boots[:limit]):
        end = now if i == 0 else boots[i - 1]
        out.append({
            "boot": b.strftime("%Y-%m-%d %H:%M:%S"),
            "end":  None if i == 0 else end.strftime("%Y-%m-%d %H:%M:%S"),
            "duration_sec": max(0, int((end - b).total_seconds())),
            "current": i == 0,
        })
    return out


@flask_app.route("/api/reboots")
@require_auth
def api_reboots():
    return jsonify({"reboots": get_reboot_history(), "uptime": int(psutil.boot_time())})


@flask_app.route("/api/logs")
@require_auth
def api_logs():
    """log ของ service จาก journalctl (ajpao อยู่ group adm → อ่านได้ไม่ต้อง sudo)"""
    try:
        n = max(20, min(int(request.args.get("lines", "200")), 1000))
    except Exception:
        n = 200
    try:
        r = subprocess.run(["journalctl", "-u", "ajpao-monitor", "-n", str(n),
                            "--no-pager", "--output", "short-iso"],
                           capture_output=True, text=True, timeout=8)
        return jsonify({"ok": True, "log": (r.stdout or r.stderr or "").strip()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


_speedtest_lock = threading.Lock()   # กัน speedtest ซ้อนกัน (เปลืองแบนด์วิดท์ + ผลเพี้ยน)

@flask_app.route("/api/speedtest", methods=["POST"])
@require_auth
def api_speedtest():
    """วัดความเร็วเน็ตด้วย speedtest-cli (~30 วิ) — รันได้ทีละ 1 ครั้ง"""
    if not _speedtest_lock.acquire(blocking=False):
        return jsonify({"ok": False, "error": "กำลังวัดความเร็วอยู่ รอสักครู่"}), 409
    try:
        import speedtest
        st = speedtest.Speedtest(secure=True)
        st.get_best_server()
        down = st.download()
        up = st.upload(pre_allocate=False)
        res = st.results.dict()
        return jsonify({
            "ok": True,
            "down_mbps": round(down / 1e6, 2),
            "up_mbps":   round(up / 1e6, 2),
            "ping_ms":   round(res.get("ping", 0), 1),
            "server": (res.get("server") or {}).get("sponsor", ""),
            "isp":    (res.get("client") or {}).get("isp", ""),
            "ts": datetime.now().strftime("%H:%M:%S"),
        })
    except ImportError:
        return jsonify({"ok": False, "error": "ยังไม่ได้ติดตั้ง speedtest-cli บน Pi"}), 500
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        _speedtest_lock.release()


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

            # แจ้งเตือนตาม threshold ทุก metric (temp/cpu/ram/disk) + บันทึก event
            check_alerts(now, temp, cpu, ram.percent, disk.percent)

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

            # รายงานสรุปประจำวัน (เมื่อวาน) + auto-cleanup DB ตอนเช้า (วันละครั้ง)
            if now.hour == DAILY_REPORT_HOUR and last_daily_date != now.date():
                send_daily_report()
                cleanup_old_data()
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
    print("[power-poll] เริ่มเฝ้าคำสั่ง reboot/shutdown/adguard จาก cloud")
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

            # คำสั่งควบคุม AdGuard protection จาก cloud
            ag_ref = db_fs.collection("commands").document("adguard")
            ag_doc = ag_ref.get()
            if ag_doc.exists:
                d = ag_doc.to_dict()
                if not d.get("handled", True):
                    set_adguard_protection(bool(d.get("enabled", True)), int(d.get("duration") or 0))
                    ag_ref.update({"handled": True, "handled_at": fs.SERVER_TIMESTAMP})
        except Exception as e:
            print(f"[power-poll] error: {e}")
        time.sleep(REBOOT_POLL_SEC)


# ─── main ───────────────────────────────────────────────────────────────────────

def main():
    init_db()
    init_firestore()
    push_alert_config(load_alert_config())                      # sync เกณฑ์แจ้งเตือนขึ้น cloud
    log_event("info", "system", None, "info", "ระบบเริ่มทำงาน")  # โผล่ใน Event Log = proxy ของการรีบูต
    threading.Thread(target=collector_loop, daemon=True).start()
    threading.Thread(target=bot_loop, daemon=True).start()
    threading.Thread(target=reboot_poll_loop, daemon=True).start()
    print(f"🌐 LAN dashboard: http://0.0.0.0:{PORT}")
    # HTTPS ขนาน — เปิดเฉพาะเมื่อมี cert/key (สำหรับเข้าจากนอกบ้านผ่าน port-forward, รหัสผ่านไม่วิ่ง cleartext)
    if os.path.exists(SSL_CERT) and os.path.exists(SSL_KEY):
        print(f"🔒 HTTPS dashboard: https://0.0.0.0:{HTTPS_PORT}")
        threading.Thread(
            target=lambda: flask_app.run(host="0.0.0.0", port=HTTPS_PORT,
                ssl_context=(SSL_CERT, SSL_KEY), debug=False, use_reloader=False, threaded=True),
            daemon=True).start()
    else:
        print(f"ℹ️  HTTPS ปิดอยู่ (ไม่พบ {os.path.basename(SSL_CERT)}/{os.path.basename(SSL_KEY)})")
    flask_app.run(host="0.0.0.0", port=PORT, debug=False, use_reloader=False, threaded=True)


if __name__ == "__main__":
    main()
