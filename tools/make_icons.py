"""Draws the WakaWise app icons into public/icons/ (run: py tools/make_icons.py).

The logo: a road that fades from yellow to green (like the route line in the app) winding up
into a green map pin, on the app's dark background.
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'public' / 'icons'
BG = (18, 20, 23, 255)
YELLOW = (223, 232, 58)
GREEN = (31, 174, 75)
PIN = (47, 191, 91, 255)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def bezier(p0, p1, p2, p3, t):
    u = 1 - t
    return tuple(u**3 * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t**3 * p3[i] for i in range(2))


def logo(size, pad, rounded, bg=BG):
    """pad: empty margin (fraction of the size) around the artwork; maskable icons need more."""
    S = size * 4  # draw big, then shrink for smooth edges
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if rounded:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.23), fill=bg)
    else:
        d.rectangle([0, 0, S, S], fill=bg)
    art = S * (1 - 2 * pad)
    X = lambda f: S * pad + art * f  # noqa: E731
    # pin head and tip
    cx, cy, r = X(0.5), X(0.34), art * 0.2
    tip = (cx, cy + r * 1.75)
    # road: thick S-curve from the bottom left up to the pin's tip, yellow -> green
    p0, p1, p2, p3 = (X(0.12), X(1.04)), (X(0.10), X(0.70)), (X(0.50), X(1.00)), tip
    width = art * 0.13
    steps = 160
    for k in range(steps + 1):
        t = k / steps
        x, y = bezier(p0, p1, p2, p3, t)
        col = lerp(YELLOW, GREEN, min(1, t * 1.15))
        w = width * (1 - 0.35 * t)  # narrows into the distance
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=col + (255,))
    # pin: circle + triangle down to the tip
    d.polygon([(cx - r * 0.83, cy + r * 0.56), (cx + r * 0.83, cy + r * 0.56), tip], fill=PIN)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=PIN)
    d.ellipse([cx - r * 0.42, cy - r * 0.42, cx + r * 0.42, cy + r * 0.42], fill=(255, 255, 255, 255))
    # keep the road inside the tile
    if rounded:
        mask = Image.new('L', (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.23), fill=255)
        im.putalpha(Image.composite(im.getchannel('A'), Image.new('L', (S, S), 0), mask))
    return im.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
logo(192, 0.1, True).save(OUT / 'icon-192.png')
logo(512, 0.1, True).save(OUT / 'icon-512.png')
logo(512, 0.2, False).save(OUT / 'maskable-512.png')  # Android crops these into circles etc.
logo(180, 0.12, False).save(OUT / 'apple-touch-icon.png')  # iPhone rounds the corners itself
logo(64, 0.06, True).save(OUT / 'favicon.png')
print('icons written to', OUT)
