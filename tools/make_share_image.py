"""Builds the link-preview image (public/og-image.jpg, 1200x630) shown when the site is shared on
WhatsApp, X, Facebook, etc. Uses the screenshots from `node tools/screenshots.mjs`.
Run: py tools/make_share_image.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / 'tools' / 'shots'
OUT = ROOT / 'public' / 'og-image.jpg'
TAGLINE = ['Find your way, even when', 'the internet goes dark.']
W, H = 1200, 630
BG = (15, 16, 18)
GREEN = (47, 191, 91)
MUTED = (158, 163, 170)
FONTS = Path('C:/Windows/Fonts')


def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)


def phone(shot_path, height):
    """A screenshot inside a simple dark phone frame, with rounded corners."""
    shot = Image.open(shot_path).convert('RGB')
    sw = round(shot.width * height / shot.height)
    shot = shot.resize((sw, height), Image.LANCZOS)
    bezel = 12
    w, h = sw + bezel * 2, height + bezel * 2
    frame = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(frame)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=44, fill=(6, 6, 7, 255), outline=(52, 55, 60, 255), width=2)
    mask = Image.new('L', (sw, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, sw - 1, height - 1], radius=34, fill=255)
    frame.paste(shot, (bezel, bezel), mask)
    return frame


def shadow(img, blur=22, alpha=150):
    s = Image.new('RGBA', (img.width + blur * 4, img.height + blur * 4), (0, 0, 0, 0))
    a = img.getchannel('A').point(lambda v: alpha if v else 0)
    s.paste(Image.new('RGBA', img.size, (0, 0, 0, 255)), (blur * 2, blur * 2), a)
    return s.filter(ImageFilter.GaussianBlur(blur))


canvas = Image.new('RGBA', (W, H), BG + (255,))

# soft green glow behind the phones
glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse([700, 80, 1260, 640], fill=(31, 174, 75, 70))
canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(120)))

# phones: directions behind, navigation in front
back = phone(SHOTS / 'directions.png', 520).rotate(6, resample=Image.BICUBIC, expand=True)
front = phone(SHOTS / 'nav.png', 560).rotate(-4, resample=Image.BICUBIC, expand=True)
for img, x, y in ((back, 655, 70), (front, 880, 30)):
    sh = shadow(img)
    canvas.alpha_composite(sh, (x - 44, y - 30))
    canvas.alpha_composite(img, (x, y))

# left: logo, name, tagline
d = ImageDraw.Draw(canvas)
icon = Image.open(ROOT / 'public' / 'icons' / 'icon-512.png').convert('RGBA').resize((112, 112), Image.LANCZOS)
canvas.alpha_composite(icon, (64, 92))
d.text((196, 104), 'WakaWise', font=font('segoeuib.ttf', 70), fill=(242, 243, 245))
y = 250
for line in TAGLINE:
    d.text((64, y), line, font=font('seguisb.ttf', 44), fill=(242, 243, 245))
    y += 58
d.text((64, y + 22), 'Maps, search, directions and voice navigation', font=font('segoeui.ttf', 26), fill=MUTED)
d.text((64, y + 56), 'for all 36 states and the FCT', font=font('segoeui.ttf', 26), fill=MUTED)

# "works with no data" pill
pill_font = font('seguisb.ttf', 24)
label = 'Works with no data'
tw = d.textlength(label, font=pill_font)
px, py = 64, 520
d.rounded_rectangle([px, py, px + tw + 64, py + 50], radius=25, fill=(31, 174, 75, 255))
d.ellipse([px + 18, py + 19, px + 30, py + 31], fill=(6, 21, 11))
d.text((px + 42, py + 9), label, font=pill_font, fill=(6, 21, 11))

canvas.convert('RGB').save(OUT, quality=86, optimize=True, progressive=True)
print(f'{OUT} ({OUT.stat().st_size // 1024} KB)')


# ---------------------------------------------------------------- square version (WhatsApp's small card)
# WhatsApp shows a small square picture beside the title, so this one is mostly big, bold text.
SQ = 600
OUT_SQ = ROOT / 'public' / 'og-square.jpg'
sq = Image.new('RGBA', (SQ, SQ), BG + (255,))
glow = Image.new('RGBA', (SQ, SQ), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse([260, 300, 760, 800], fill=(31, 174, 75, 90))
sq.alpha_composite(glow.filter(ImageFilter.GaussianBlur(110)))
d = ImageDraw.Draw(sq)
mark = Image.open(ROOT / 'public' / 'icons' / 'icon-512.png').convert('RGBA').resize((96, 96), Image.LANCZOS)
sq.alpha_composite(mark, (52, 52))
d.text((166, 70), 'WakaWise', font=font('segoeuib.ttf', 50), fill=(242, 243, 245))
big = font('segoeuib.ttf', 68)
y = 200
for text, colour in (('Find your way,', (242, 243, 245)), ('even when the', (242, 243, 245)), ('internet goes', (242, 243, 245)), ('dark.', GREEN)):
    d.text((52, y), text, font=big, fill=colour)
    y += 84
sq.convert('RGB').save(OUT_SQ, quality=88, optimize=True, progressive=True)
print(f'{OUT_SQ} ({OUT_SQ.stat().st_size // 1024} KB)')
