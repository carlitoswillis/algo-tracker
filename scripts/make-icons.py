#!/usr/bin/env python3
"""Render extension icons as PNGs with no third-party deps.

Rasterise the artwork at 512x512 as a binary mask, then box-downsample to each
target size. The averaging over 4x..32x blocks is what produces the anti-aliasing,
so no per-pixel coverage maths is needed.
"""
import zlib, struct, os

R = 512  # master resolution


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


# ---------- shape predicates, in master-resolution pixel space ----------
def rounded_rect(x0, y0, x1, y1, rad):
    def f(x, y):
        if not (x0 <= x <= x1 and y0 <= y <= y1):
            return False
        # Only the four corner boxes need the radius test.
        cx = x0 + rad if x < x0 + rad else (x1 - rad if x > x1 - rad else x)
        cy = y0 + rad if y < y0 + rad else (y1 - rad if y > y1 - rad else y)
        return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad
    return f


def tri(p0, p1, p2):
    def sign(a, b, c):
        return (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1])
    def f(x, y):
        p = (x, y)
        d1, d2, d3 = sign(p, p0, p1), sign(p, p1, p2), sign(p, p2, p0)
        neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
        pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
        return not (neg and pos)
    return f


def render(bg_hex, layers):
    """layers: list of (predicate, hex). Painted in order, clipped to the bg shape."""
    bg_shape = rounded_rect(0, 0, R - 1, R - 1, int(R * 0.22))
    bg = hex_rgb(bg_hex)
    px = [[(0, 0, 0, 0)] * R for _ in range(R)]
    for y in range(R):
        row = px[y]
        for x in range(R):
            if not bg_shape(x, y):
                continue
            c = bg
            for pred, col in layers:
                if pred(x, y):
                    c = hex_rgb(col)
            row[x] = (c[0], c[1], c[2], 255)
    return px


def downsample(px, size):
    k = R // size
    out = []
    for y in range(size):
        row = []
        for x in range(size):
            r = g = b = a = 0
            for j in range(k):
                for i in range(k):
                    p = px[y * k + j][x * k + i]
                    # Premultiply so transparent pixels don't drag colour in.
                    r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3]
            if a:
                row.append((round(r / a), round(g / a), round(b / a), round(a / (k * k))))
            else:
                row.append((0, 0, 0, 0))
        out.append(row)
    return out


def write_png(path, rows):
    size = len(rows)
    raw = b"".join(b"\x00" + bytes(v for p in row for v in p) for row in rows)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    open(path, "wb").write(png)


def emit(outdir, master, name):
    os.makedirs(outdir, exist_ok=True)
    for s in (16, 32, 48, 128):
        write_png(os.path.join(outdir, f"icon{s}.png"), downsample(master, s))
    print(f"  {name}: icon16/32/48/128.png -> {outdir}")


# ---------- Algo Tracker: three ascending bars = the expanding interval ladder ----------
def algo_tracker():
    ink, teal, amber = "#0E1116", "#4FB8A8", "#E8A33D"
    base, top = int(R * 0.78), int(R * 0.20)
    w = int(R * 0.155)
    gap = int(R * 0.075)
    total = 3 * w + 2 * gap
    x = (R - total) // 2
    heights = [0.34, 0.60, 1.00]  # 2d -> 7d -> 60d, growth is the whole idea
    layers = []
    for i, hfrac in enumerate(heights):
        x0 = x + i * (w + gap)
        y0 = base - int((base - top) * hfrac)
        col = amber if i == 2 else teal
        layers.append((rounded_rect(x0, y0, x0 + w, base, w // 2), col))
    return render(ink, layers)


# ---------- AutoJob: an arrow dropping into a tray = send to queue ----------
def autojob():
    ink, iris = "#15191F", "#7B74F2"
    cx = R // 2
    stem_w = int(R * 0.105)
    stem_top, stem_bot = int(R * 0.20), int(R * 0.50)
    head_half = int(R * 0.20)
    head_tip = int(R * 0.685)
    tray_y0, tray_y1 = int(R * 0.755), int(R * 0.815)
    tray_x0, tray_x1 = int(R * 0.235), int(R * 0.765)
    layers = [
        (rounded_rect(cx - stem_w // 2, stem_top, cx + stem_w // 2, stem_bot, stem_w // 4), iris),
        (tri((cx - head_half, stem_bot - 1), (cx + head_half, stem_bot - 1), (cx, head_tip)), iris),
        (rounded_rect(tray_x0, tray_y0, tray_x1, tray_y1, (tray_y1 - tray_y0) // 2), iris),
    ]
    return render(ink, layers)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    print("rendering…")
    emit(os.path.join(here, "..", "extension", "icons"), algo_tracker(), "algo-tracker")
    if os.environ.get("AUTOJOB_DIR"):
        emit(os.environ["AUTOJOB_DIR"], autojob(), "autojob")
