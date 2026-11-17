"""生成插件用的羊皮纸世界地图底图（离线、无外链）。"""
import math
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 2000, 1150
OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'map-parchment.jpg')
os.makedirs(os.path.dirname(OUT), exist_ok=True)

rng = random.Random(20261118)
np_rng = np.random.default_rng(20261118)


def font(size):
    for path in (
        r'C:\Windows\Fonts\simsun.ttc',
        r'C:\Windows\Fonts\msyh.ttc',
        r'C:\Windows\Fonts\simhei.ttf',
        r'C:\Windows\Fonts\STSONG.TTF',
    ):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def lerp(a, b, t):
    return int(a + (b - a) * t)


def smooth_polygon(cx, cy, rx, ry, n=160, rough=1.0, seed=0):
    r = random.Random(seed)
    pts = []
    for i in range(n):
        ang = 2 * math.pi * i / n
        wobble = (
            1.0
            + 0.10 * math.sin(ang * 3 + seed)
            + 0.07 * math.sin(ang * 7 + seed * 2)
            + 0.045 * math.sin(ang * 13 + seed * 3)
        )
        wobble += r.uniform(-0.018, 0.018) * rough
        # 一两个半岛/海湾
        wobble += 0.14 * math.exp(-((ang - 1.05) ** 2) / 0.02)
        wobble -= 0.10 * math.exp(-((ang - 3.7) ** 2) / 0.015)
        pts.append((cx + math.cos(ang) * rx * wobble, cy + math.sin(ang) * ry * wobble))
    return pts


def make_parchment():
    # 低频色斑
    small = np_rng.normal(0, 1, (40, 64)).astype(np.float32)
    small = (small - small.min()) / (small.max() - small.min())
    low = Image.fromarray((small * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC)
    low = low.filter(ImageFilter.GaussianBlur(26))
    low_arr = np.asarray(low).astype(np.float32) / 255.0
    base = np.zeros((H, W, 3), np.float32)
    for y in range(H):
        t = y / H
        base[y, :, 0] = lerp(238, 214, t)
        base[y, :, 1] = lerp(221, 196, t)
        base[y, :, 2] = lerp(186, 154, t)
    stain = (low_arr - 0.5)[..., None] * np.array([22, 20, 15], np.float32)
    base = np.clip(base + stain, 0, 255)

    # 纸纤维 + 颗粒
    fine = np_rng.normal(0, 5.5, (H, W, 1))
    base = np.clip(base + fine, 0, 255)
    img = Image.fromarray(base.astype(np.uint8))
    img = img.filter(ImageFilter.GaussianBlur(0.5))

    # 大水渍
    stains = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stains)
    for _ in range(26):
        x = rng.randint(-100, W + 100)
        y = rng.randint(-80, H + 80)
        r = rng.randint(80, 320)
        sd.ellipse((x - r, y - r * 0.7, x + r, y + r * 0.7),
                   fill=(120, 84, 45, rng.randint(3, 8)))
    stains = stains.filter(ImageFilter.GaussianBlur(55))
    img = Image.alpha_composite(img.convert('RGBA'), stains).convert('RGB')

    # 暗角
    yy, xx = np.mgrid[0:H, 0:W]
    nx = (xx - W / 2) / (W / 2)
    ny = (yy - H / 2) / (H / 2)
    vig = np.clip(1.0 - 0.30 * (nx ** 2 + ny ** 2) ** 1.2, 0.55, 1.0)
    arr = np.asarray(img).astype(np.float32) * vig[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def draw_land(img):
    land_mask = Image.new('L', (W, H), 0)
    md = ImageDraw.Draw(land_mask)
    main = smooth_polygon(1020, 690, 720, 430, rough=1.0, seed=11)
    island = smooth_polygon(360, 330, 190, 125, rough=1.2, seed=27)
    md.polygon(main, fill=255)
    md.polygon(island, fill=255)
    # 小岛
    for cx, cy, rx, ry in ((1600, 300, 90, 60), (1500, 1030, 60, 38), (520, 1040, 45, 30)):
        pts = smooth_polygon(cx, cy, rx, ry, n=80, rough=1.4, seed=cx)
        md.polygon(pts, fill=255)
    land_mask = land_mask.filter(ImageFilter.GaussianBlur(1.2))

    # 陆地阴影
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    shadow.paste((45, 28, 12, 120), (0, 0), land_mask)
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    img = Image.alpha_composite(img.convert('RGBA'), shadow.filter(ImageFilter.GaussianBlur(4))).convert('RGB')

    # 陆地填色（比纸略深）
    land_rgba = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(land_rgba)
    ld.bitmap((0, 0), land_mask, fill=(210, 185, 138, 235))
    # 内陆浅色
    inner = Image.new('L', (W, H), 0)
    ImageDraw.Draw(inner).polygon(smooth_polygon(1000, 650, 600, 340, n=140, rough=0.9, seed=11), fill=110)
    inner = inner.filter(ImageFilter.GaussianBlur(60))
    light = Image.new('RGBA', (W, H), (238, 221, 186, 0))
    light.putalpha(inner)
    land_rgba = Image.alpha_composite(land_rgba, light)
    img = Image.alpha_composite(img.convert('RGBA'), land_rgba).convert('RGB')

    # 海岸线：多层
    overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for scale, width, alpha in ((1.0, 5, 210), (1.012, 2, 130), (1.024, 1, 80)):
        pts = [(1020 + (x - 1020) * scale, 690 + (y - 690) * scale) for x, y in main]
        od.line(pts + [pts[0]], fill=(102, 72, 38, alpha), width=width, joint='curve')
        ip = [(360 + (x - 360) * scale, 330 + (y - 330) * scale) for x, y in island]
        od.line(ip + [ip[0]], fill=(102, 72, 38, alpha), width=width, joint='curve')
    # 海岸短线
    for pts in (main, island):
        for i in range(0, len(pts) - 2, 3):
            x1, y1 = pts[i]
            x2, y2 = pts[i + 1]
            dx, dy = x2 - x1, y2 - y1
            length = math.hypot(dx, dy) or 1
            nx, ny = -dy / length, dx / length
            if (x1 - 1020) * nx + (y1 - 690) * ny < 0:
                nx, ny = -nx, -ny
            ln = rng.randint(5, 13)
            od.line((x1, y1, x1 + nx * ln, y1 + ny * ln), fill=(108, 78, 44, 100), width=1)
    img = Image.alpha_composite(img.convert('RGBA'), overlay).convert('RGB')
    return img, land_mask, main


def inside(mask, x, y):
    x, y = int(x), int(y)
    return 0 <= x < W and 0 <= y < H and mask.getpixel((x, y)) > 128


def add_terrain(img, mask):
    overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    ink = (96, 68, 36, 190)
    fill = (172, 143, 96, 200)
    light = (206, 186, 148, 170)

    def mountain(x, y, s):
        if not inside(mask, x, y):
            return
        tip = (x, y - s)
        left = (x - s * 0.95, y + s * 0.62)
        right = (x + s * 0.95, y + s * 0.62)
        d.polygon([tip, left, right], fill=fill, outline=ink)
        d.line([tip, (x, y + s * 0.62)], fill=(112, 82, 48, 150), width=2)
        d.polygon([tip, (x - s * 0.45, y + s * 0.1), (x, y - s * 0.03)], fill=light)
        if s > 26:
            d.line([(x - s * 0.22, y - s * 0.6), (x + s * 0.2, y - s * 0.6)], fill=(235, 222, 195, 180), width=2)

    ranges = [
        (520, 610, 34, 7), (700, 560, 28, 5), (1260, 610, 34, 7),
        (1460, 720, 30, 6), (760, 860, 30, 6), (1080, 500, 24, 5),
        (1320, 900, 26, 5),
    ]
    for cx, cy, base, count in ranges:
        for i in range(count):
            x = cx + (i - count / 2) * base * 2.0 + rng.randint(-8, 8)
            y = cy + rng.randint(-18, 18) + abs(i - count / 2) * 6
            mountain(x, y, base + rng.randint(-5, 5))

    # 森林
    def tree(x, y, s):
        if not inside(mask, x, y):
            return
        d.line((x, y, x, y + s * 0.5), fill=(92, 66, 36, 170), width=2)
        for dx, dy, r in ((0, 0, s * 0.55), (-s * 0.45, s * 0.2, s * 0.4), (s * 0.45, s * 0.2, s * 0.4)):
            d.ellipse((x + dx - r, y + dy - r, x + dx + r, y + dy + r),
                      fill=(100, 120, 78, 150), outline=(74, 88, 54, 160), width=1)

    forests = [
        (410, 520, 26, 34), (590, 930, 24, 30), (1220, 840, 26, 36),
        (1540, 500, 22, 24), (900, 460, 20, 22), (1390, 420, 18, 18),
    ]
    for cx, cy, s, count in forests:
        for _ in range(count):
            x = cx + rng.randint(-120, 120)
            y = cy + rng.randint(-70, 70)
            tree(x, y, s + rng.randint(-5, 5))

    # 沙漠点阵
    for _ in range(260):
        x = 1520 + rng.randint(-130, 130)
        y = 760 + rng.randint(-80, 80)
        if inside(mask, x, y):
            d.point((x, y), fill=(130, 98, 55, 110))

    # 河流
    river = (96, 122, 128, 140)
    for pts in (
        [(760, 560), (700, 640), (720, 730), (650, 820), (610, 900), (640, 980)],
        [(1290, 610), (1330, 690), (1300, 770), (1370, 840), (1420, 930), (1430, 1000)],
        [(1040, 520), (1000, 600), (1030, 680), (980, 760), (960, 820)],
    ):
        d.line(pts, fill=river, width=7, joint='curve')
        d.line(pts, fill=(150, 175, 175, 80), width=2, joint='curve')

    # 道路虚线
    roads = [
        [(520, 700), (760, 660), (1020, 700), (1280, 680), (1480, 730)],
        [(1020, 700), (1000, 540), (900, 470)],
        [(1020, 700), (1080, 860), (1220, 900)],
    ]
    for pts in roads:
        for i in range(len(pts) - 1):
            (x1, y1), (x2, y2) = pts[i], pts[i + 1]
            steps = int(math.hypot(x2 - x1, y2 - y1) // 12)
            for s in range(steps):
                t1, t2 = s / steps, (s + 0.45) / steps
                d.line((x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1,
                        x1 + (x2 - x1) * t2, y1 + (y2 - y1) * t2),
                       fill=(108, 78, 44, 120), width=2)

    img = Image.alpha_composite(img.convert('RGBA'), overlay).convert('RGB')
    return img


def add_decor(img):
    overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    ink = (98, 70, 40, 210)
    faint = (98, 70, 40, 55)

    # 海浪
    for _ in range(90):
        x = rng.randint(40, W - 40)
        y = rng.randint(40, H - 40)
        if inside(mask, x, y):
            continue
        r = rng.randint(10, 24)
        d.arc((x - r, y - r // 2, x + r, y + r // 2), 200, 340, fill=(100, 76, 46, 60), width=1)
        d.arc((x - r // 2, y + 4 - r // 3, x + r // 2, y + 4 + r // 3), 200, 340, fill=(100, 76, 46, 48), width=1)

    # 罗盘
    cx, cy, r = 150, 150, 74
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=ink, width=3)
    d.ellipse((cx - r + 12, cy - r + 12, cx + r - 12, cy + r - 12), outline=faint, width=1)
    for ang in range(0, 360, 45):
        a = math.radians(ang)
        x2, y2 = cx + math.cos(a) * (r - 6), cy + math.sin(a) * (r - 6)
        d.line((cx, cy, x2, y2), fill=ink, width=2)
    for ang in (0, 90, 180, 270):
        a = math.radians(ang)
        tip = (cx + math.cos(a) * (r + 16), cy + math.sin(a) * (r + 16))
        left = (cx + math.cos(a + 2.5) * 18, cy + math.sin(a + 2.5) * 18)
        right = (cx + math.cos(a - 2.5) * 18, cy + math.sin(a - 2.5) * 18)
        d.polygon([tip, left, right], fill=(98, 70, 40, 200))
    fnt = font(18)
    d.text((cx - 8, cy - r - 26), 'N', font=fnt, fill=ink)
    d.text((cx - 7, cy + r + 8), 'S', font=fnt, fill=(98, 70, 40, 140))
    d.text((cx + r + 8, cy - 9), 'E', font=fnt, fill=(98, 70, 40, 140))
    d.text((cx - r - 22, cy - 9), 'W', font=fnt, fill=(98, 70, 40, 140))

    # 淡淡罗盘航线
    for ang in range(0, 360, 30):
        a = math.radians(ang)
        d.line((cx, cy, cx + math.cos(a) * 1600, cy + math.sin(a) * 1000), fill=(110, 80, 45, 22), width=1)

    # 经纬网
    for gx in (500, 1000, 1500):
        d.line((gx, 80, gx, H - 80), fill=(110, 80, 45, 16), width=1)
    for gy in (400, 780):
        d.line((90, gy, W - 90, gy), fill=(110, 80, 45, 14), width=1)

    # 标题
    title_font = font(46)
    title = '寰 宇 全 图'
    tw = d.textlength(title, font=title_font)
    d.text(((W - tw) / 2, 58), title, font=title_font, fill=(88, 60, 32, 220))
    d.line((W / 2 - 190, 118, W / 2 - 70, 118), fill=(110, 80, 45, 150), width=2)
    d.line((W / 2 + 70, 118, W / 2 + 190, 118), fill=(110, 80, 45, 150), width=2)
    d.ellipse((W / 2 - 8, 110, W / 2 + 8, 126), outline=(110, 80, 45, 180), width=2)

    # 海域文字
    sea_font = font(36)
    d.text((112, 620), '西  海', font=sea_font, fill=(94, 66, 36, 165))
    d.text((1688, 600), '东  海', font=sea_font, fill=(94, 66, 36, 165))
    d.text((920, 190), '北  境', font=sea_font, fill=(94, 66, 36, 145))
    d.text((905, 1065), '南  海', font=sea_font, fill=(94, 66, 36, 145))

    # 帆船
    sx, sy = 1760, 360
    d.line((sx, sy - 42, sx, sy + 8), fill=(96, 68, 38, 150), width=2)
    d.polygon([(sx, sy - 38), (sx + 34, sy - 8), (sx, sy - 8)], fill=(236, 224, 196, 120), outline=(96, 68, 38, 150))
    d.line((sx - 30, sy + 8, sx + 32, sy + 8), fill=(96, 68, 38, 160), width=3)
    d.arc((sx - 26, sy + 6, sx + 26, sy + 18), 20, 160, fill=(96, 68, 38, 130), width=2)

    # 外框
    for x0, y0, x1, y1, w, alpha in (
        (26, 26, W - 26, H - 26, 6, 210),
        (46, 46, W - 46, H - 46, 2, 150),
        (62, 62, W - 62, H - 62, 1, 90),
    ):
        d.rectangle((x0, y0, x1, y1), outline=(96, 68, 38, alpha), width=w)
    # 角饰
    for x, y in ((46, 46), (W - 46, 46), (46, H - 46), (W - 46, H - 46)):
        d.ellipse((x - 12, y - 12, x + 12, y + 12), outline=ink, width=2)
        d.ellipse((x - 4, y - 4, x + 4, y + 4), fill=ink)

    # 纸面划痕
    for _ in range(18):
        x1, y1 = rng.randint(70, W - 70), rng.randint(70, H - 70)
        x2, y2 = x1 + rng.randint(-180, 180), y1 + rng.randint(-60, 60)
        d.line((x1, y1, x2, y2), fill=(120, 88, 50, 18), width=1)

    return Image.alpha_composite(img.convert('RGBA'), overlay).convert('RGB')


img = make_parchment()
img, mask, _ = draw_land(img)
img = add_terrain(img, mask)
img = add_decor(img)
img = img.filter(ImageFilter.GaussianBlur(0.35))
img.save(OUT, 'JPEG', quality=90, optimize=True, progressive=True)
print('saved', OUT, img.size)
