#!/usr/bin/env python3
"""สร้างไอคอน PWA แบบ pure-stdlib (ไม่ง้อ Pillow) — พื้นหลังเข้ม + เส้นกราฟ pulse สีส้ม.

ใช้: python3 make_icons.py <out_dir>
ผลลัพธ์: icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png, favicon.png
"""
import sys, os, zlib, struct, math

# ── palette ────────────────────────────────────────────────────────────────
BG_TOP    = (0x0d, 0x18, 0x30)   # #0d1830
BG_BOT    = (0x06, 0x0a, 0x14)   # #060a14
ACCENT    = (0xff, 0x6b, 0x00)   # #ff6b00
ACCENT_HI = (0xff, 0xa0, 0x4d)   # ไฮไลต์อ่อนของ accent

# เส้น pulse (heartbeat) normalized ใน [0,1] ของกล่อง glyph
PULSE = [(0.00,0.50),(0.20,0.50),(0.32,0.50),(0.42,0.20),
         (0.54,0.84),(0.64,0.40),(0.72,0.50),(0.84,0.50),(1.00,0.50)]


def clamp(v, a, b): return a if v < a else b if v > b else v
def lerp(a, b, t):  return a + (b - a) * t
def mix(c1, c2, t): return tuple(int(round(lerp(c1[i], c2[i], t))) for i in range(3))


def seg_dist(px, py, ax, ay, bx, by):
    """ระยะจากจุด (px,py) ถึงเซกเมนต์ a→b"""
    dx, dy = bx - ax, by - ay
    L2 = dx*dx + dy*dy
    if L2 == 0:
        return math.hypot(px-ax, py-ay)
    t = clamp(((px-ax)*dx + (py-ay)*dy) / L2, 0.0, 1.0)
    return math.hypot(px - (ax+t*dx), py - (ay+t*dy))


def rrect_sdf(x, y, N, r):
    """signed distance ของสี่เหลี่ยมมุมมน (ทั้งภาพ 0..N)"""
    cx = cy = N/2.0
    hw = hh = N/2.0
    qx = abs(x-cx) - (hw - r)
    qy = abs(y-cy) - (hh - r)
    outside = math.hypot(max(qx,0.0), max(qy,0.0))
    inside  = min(max(qx,qy), 0.0)
    return outside + inside - r


def render(N, maskable=False):
    # full-bleed สำหรับ maskable/apple, มุมมนสำหรับ icon ปกติ
    radius = 0.0 if maskable else N*0.22
    # กล่อง glyph อยู่กลาง — เผื่อ safe zone ถ้า maskable
    g = N * (0.56 if maskable else 0.64)
    gx0 = (N - g)/2.0
    gy0 = (N - g)/2.0 + N*0.02
    gh  = g * 0.62                      # บีบแนวตั้งให้เส้นไม่สูงเกิน
    gy0 += (g - gh)/2.0
    stroke = max(2.0, N*0.052)
    half_s = stroke/2.0
    glow_r = stroke*2.2

    # เตรียมเซกเมนต์ pulse เป็นพิกัดจริง
    pts = [(gx0 + px*g, gy0 + py*gh) for (px,py) in PULSE]

    # bounding box ของ glyph (+glow) เพื่อข้ามพิกเซลที่ไกล
    bx0 = min(p[0] for p in pts) - glow_r - 2
    bx1 = max(p[0] for p in pts) + glow_r + 2
    by0 = min(p[1] for p in pts) - glow_r - 2
    by1 = max(p[1] for p in pts) + glow_r + 2

    raw = bytearray()
    for y in range(N):
        raw.append(0)  # PNG filter byte (None)
        yt = y / (N-1)
        bg = mix(BG_TOP, BG_BOT, yt)
        row_inside_glyph = (by0 <= y+0.5 <= by1)
        for x in range(N):
            fx, fy = x+0.5, y+0.5
            # พื้นหลังมุมมน
            d = rrect_sdf(fx, fy, N, radius)
            bg_cov = clamp(0.5 - d, 0.0, 1.0)
            r, g_, b = bg
            a = bg_cov
            # glyph (เฉพาะใน bbox)
            if row_inside_glyph and bx0 <= fx <= bx1:
                dist = min(seg_dist(fx, fy, pts[i][0], pts[i][1],
                                    pts[i+1][0], pts[i+1][1]) for i in range(len(pts)-1))
                # glow รอบเส้น (เติมแบบ additive ลงบน bg)
                if dist < glow_r:
                    gi = (1.0 - dist/glow_r)
                    gi = gi*gi*0.55
                    r = clamp(r + ACCENT[0]*gi, 0, 255)
                    g_ = clamp(g_ + ACCENT[1]*gi, 0, 255)
                    b = clamp(b + ACCENT[2]*gi, 0, 255)
                # ตัวเส้น (วาดทับ)
                s_cov = clamp(half_s + 0.5 - dist, 0.0, 1.0)
                if s_cov > 0:
                    ec = mix(ACCENT, ACCENT_HI, clamp((fy-gy0)/gh, 0, 1)*0.4)
                    r = lerp(r, ec[0], s_cov)
                    g_ = lerp(g_, ec[1], s_cov)
                    b = lerp(b, ec[2], s_cov)
                    a = max(a, s_cov)
            raw += bytes((int(r) & 255, int(g_) & 255, int(b) & 255, int(round(a*255)) & 255))
    return _png(N, N, bytes(raw))


def _png(w, h, raw):
    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)   # 8-bit RGBA
    idat = zlib.compress(raw, 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    jobs = [
        ("icon-192.png",          192, False),
        ("icon-512.png",          512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png",  180, True),
        ("favicon.png",            48, False),
    ]
    for name, n, mask in jobs:
        data = render(n, mask)
        with open(os.path.join(out, name), "wb") as f:
            f.write(data)
        print(f"  ✓ {name} ({n}px, {len(data)} bytes)")


if __name__ == "__main__":
    main()
