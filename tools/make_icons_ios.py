"""สร้างไอคอน PWA / หน้าจอ iPhone ของ AJPAO Monitor

สไตล์เดียวกับ AJPAO-Home: สี่เหลี่ยมเต็มกรอบ (iOS ตัดมุมโค้งเอง) ไล่สีแนวทแยง + ลายเส้นสีขาว
ลาย = ชิป CPU (มีขา 3 ข้างละด้าน) กับเส้นชีพจรวิ่งผ่านกลางชิป

รัน:  python tools/make_icons_ios.py   → เขียนทับ web/public/icons/*.png
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "web", "public", "icons")
S = 1024                    # วาดใหญ่แล้วย่อ = ขอบเนียน
TOP, BOT = (52, 211, 120), (13, 148, 74)     # เขียวสดด้านบนซ้าย → เขียวเข้มด้านล่างขวา


def gradient(size):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOT))
    return img


def glyph(draw, cx, cy, scale):
    """ชิป + ชีพจร วาดรอบจุด (cx, cy); scale = ความกว้างตัวชิป"""
    w = scale
    lw = round(w * 0.075)                    # ความหนาเส้น
    half = w / 2
    box = [cx - half, cy - half, cx + half, cy + half]
    draw.rounded_rectangle(box, radius=round(w * 0.16), outline="white", width=lw)

    # ขาชิป 3 ขาต่อด้าน
    pin_len, gap = w * 0.17, w * 0.27
    for i in (-1, 0, 1):
        o = i * gap
        for (x0, y0, x1, y1) in (
            (cx + o, cy - half - pin_len, cx + o, cy - half),      # บน
            (cx + o, cy + half, cx + o, cy + half + pin_len),      # ล่าง
            (cx - half - pin_len, cy + o, cx - half, cy + o),      # ซ้าย
            (cx + half, cy + o, cx + half + pin_len, cy + o),      # ขวา
        ):
            draw.line([(x0, y0), (x1, y1)], fill="white", width=lw)
            for (px_, py_) in ((x0, y0), (x1, y1)):              # ปลายมน
                r = lw / 2
                draw.ellipse([px_ - r, py_ - r, px_ + r, py_ + r], fill="white")

    # ชีพจรวิ่งผ่านกลางชิป
    inner = half * 0.72
    pts = [(cx - inner, cy), (cx - inner * 0.38, cy), (cx - inner * 0.12, cy - inner * 0.62),
           (cx + inner * 0.16, cy + inner * 0.62), (cx + inner * 0.40, cy), (cx + inner, cy)]
    draw.line(pts, fill="white", width=lw, joint="curve")
    for (px_, py_) in (pts[0], pts[-1]):
        r = lw / 2
        draw.ellipse([px_ - r, py_ - r, px_ + r, py_ + r], fill="white")


def render(glyph_frac):
    img = gradient(S)
    glyph(ImageDraw.Draw(img), S / 2, S / 2, S * glyph_frac)
    return img


def save(img, name, size):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name), optimize=True)


if __name__ == "__main__":
    normal = render(0.44)        # iOS / any: ลายกินราว 70% รวมขา
    maskable = render(0.34)      # Android maskable: ต้องอยู่ใน safe zone วงกลม 80%
    save(normal, "apple-touch-icon.png", 180)
    save(normal, "icon-192.png", 192)
    save(normal, "icon-512.png", 512)
    save(maskable, "icon-maskable-512.png", 512)
    save(normal, "favicon.png", 64)
    print("icons written to", os.path.abspath(OUT))
