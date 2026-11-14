#!/usr/bin/env python3
"""Generate WheelGrade icons from the vector logo (no binary sources).

The iOS repo stores no PNGs (the GitHub push tool handles text only), so
the AppIcon set, splash, and the web/ fallback icons are generated at
build time from this script. The logo is the Option B mark: black
background, bright-green W, green underline — drawn with PIL, so the
output is byte-identical to the shipped PWA icons.

Usage: python3 scripts/gen_icons.py   (needs Pillow: pip install Pillow)
Run from the repo root. Safe to re-run; it overwrites the generated PNGs.
"""
import json
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLACK = (10, 10, 10)
GREEN = (34, 197, 94)  # #22c55e bright green
# W polyline in a 64x64 box (same coordinates as the shipped PWA icon).
W_PTS_64 = [(18, 20), (26, 44), (32, 28), (38, 44), (46, 20)]


def draw_mark(draw, size, cx, cy, w_scale, line_w, underline=True):
    """Draw the bright-green W + underline, centred at (cx, cy)."""
    pts = [(cx + (x - 32) * w_scale, cy + (y - 32) * w_scale)
           for x, y in W_PTS_64]
    draw.line(pts, fill=GREEN, width=line_w, joint="curve")
    r = line_w // 2
    for x, y in pts:
        draw.ellipse([x - r, y - r, x + r, y + r], fill=GREEN)
    if underline:
        uw = int(size * 0.414)
        uh = max(4, int(size * 0.023))
        uy = int(cy + size * 0.30)
        draw.rounded_rectangle(
            [cx - uw // 2, uy, cx + uw // 2, uy + uh],
            radius=uh // 2, fill=GREEN)


def icon(size):
    """Full 512-style icon at any square size (W + underline)."""
    img = Image.new("RGB", (size, size), BLACK)
    d = ImageDraw.Draw(img)
    draw_mark(d, size, size // 2, int(size * 0.469),
              w_scale=size / 64.0, line_w=max(2, int(size * 0.078)))
    return img


def maskable(size):
    """Icon with the mark scaled to the central 80% safe zone."""
    img = Image.new("RGB", (size, size), BLACK)
    d = ImageDraw.Draw(img)
    s = size * 0.72
    draw_mark(d, size, size // 2, int(size * 0.469),
              w_scale=s / 64.0, line_w=max(2, int(s * 0.078)))
    return img


def splash(size):
    """Splash: black field with the mark centred (no underline)."""
    img = Image.new("RGB", (size, size), BLACK)
    d = ImageDraw.Draw(img)
    draw_mark(d, size, size // 2, size // 2,
              w_scale=size / 64.0 * 0.6, line_w=max(2, int(size * 0.05)),
              underline=False)
    return img


def main():
    appicon_dir = os.path.join(
        ROOT, "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset")
    with open(os.path.join(appicon_dir, "Contents.json")) as f:
        contents = json.load(f)
    made = []
    # Master 1024 icon (also the App Store listing icon source).
    master = icon(1024)
    master_path = os.path.join(ROOT, "assets", "icon.png")
    os.makedirs(os.path.dirname(master_path), exist_ok=True)
    master.save(master_path, "PNG")
    made.append(master_path)
    # Every AppIcon size listed in Contents.json.
    for entry in contents["images"]:
        fn = entry.get("filename")
        if not fn:
            continue
        px = int(round(float(entry["size"].split("x")[0]) * int(entry["scale"].rstrip("x"))))
        out = os.path.join(appicon_dir, fn)
        master.resize((px, px), Image.LANCZOS).save(out, "PNG")
        made.append(out)
    # Splash (2732).
    splash_path = os.path.join(ROOT, "assets", "splash.png")
    splash(2732).save(splash_path, "PNG")
    made.append(splash_path)
    # web/ fallback icons (copied into the iOS bundle by `cap sync`).
    web = os.path.join(ROOT, "web")
    os.makedirs(web, exist_ok=True)
    for name, size, fn in [
        ("icon-192.png", 192, icon),
        ("icon-512.png", 512, icon),
        ("icon-512-maskable.png", 512, maskable),
        ("apple-touch-icon.png", 180, icon),
    ]:
        out = os.path.join(web, name)
        fn(size).save(out, "PNG")
        made.append(out)
    print(f"generated {len(made)} icons")


if __name__ == "__main__":
    main()
