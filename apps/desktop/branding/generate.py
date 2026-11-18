#!/usr/bin/env python3
"""Regenerates every icon / logo asset from the two originals in this folder.

    python3 apps/desktop/branding/generate.py        (needs Pillow >= 10, nothing else)

Originals (never edited, supplied by the owner):
  app-icon.webp         glossy black bars on a white rounded square (the app icon)
  hanan-trade-logo.webp the "HANAN TRADE" bull-head brand logo (light studio background)

Outputs:
  src-tauri/icons/*          Tauri / Windows icon set (png sizes, multi-size icon.ico, Square*Logo, StoreLogo)
  src-tauri/icons/installer  NSIS header + sidebar and WiX banner + dialog bitmaps
  ui/public/favicon.png, ui/public/brand/*   web favicon, in-app icon, logo (webp, plus a transparent-background webp)
  branding/*.png             master files (icon-1024.png, hanan-trade-logo-transparent.png)
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
DESK = HERE.parent
ICONS = DESK / 'src-tauri' / 'icons'
INST = ICONS / 'installer'
PUB = DESK / 'ui' / 'public'
BRAND = PUB / 'brand'
for d in (ICONS, INST, BRAND):
    d.mkdir(parents=True, exist_ok=True)


def lanczos(im: Image.Image, size) -> Image.Image:
    if isinstance(size, int):
        size = (size, size)
    return im.resize(size, Image.LANCZOS)


# ---------------------------------------------------------------- app icon
def tile_with_alpha(src: Image.Image) -> Image.Image:
    """The source has a black square around the white tile: cut it out with a smooth edge."""
    rgb = src.convert('RGB')
    lum = np.asarray(rgb).astype(float).mean(2)
    bright = lum > 128  # the white tile (the glossy bars are inside it, not touching the outside)
    mask = Image.fromarray((bright * 255).astype('uint8'))
    # keep only what is connected to the centre-top margin of the tile, drop stray specks
    w, h = mask.size
    pad = Image.new('L', (w + 2, h + 2), 0)
    pad.paste(mask, (1, 1))
    ImageDraw.floodfill(pad, (0, 0), 90)  # outside
    outside = np.asarray(pad)[1:-1, 1:-1] == 90
    solid = ~outside  # tile incl. its black bars (holes filled)
    alpha = Image.fromarray((solid * 255).astype('uint8'))
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.2))
    out = rgb.convert('RGBA')
    out.putalpha(alpha)
    bbox = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
    out = out.crop(bbox)
    side = max(out.size)
    sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    sq.paste(out, ((side - out.width) // 2, (side - out.height) // 2))
    return sq


icon = tile_with_alpha(Image.open(HERE / 'app-icon.webp'))
icon1024 = lanczos(icon, 1024)
icon1024.save(HERE / 'icon-1024.png', optimize=True)

for name, px in {
    '32x32.png': 32,
    '128x128.png': 128,
    '128x128@2x.png': 256,
    'icon.png': 512,
    'StoreLogo.png': 50,
    'Square30x30Logo.png': 30,
    'Square44x44Logo.png': 44,
    'Square71x71Logo.png': 71,
    'Square89x89Logo.png': 89,
    'Square107x107Logo.png': 107,
    'Square142x142Logo.png': 142,
    'Square150x150Logo.png': 150,
    'Square284x284Logo.png': 284,
    'Square310x310Logo.png': 310,
}.items():
    lanczos(icon1024, px).save(ICONS / name, optimize=True)

ico_sizes = [16, 24, 32, 48, 64, 128, 256]
icon1024.save(ICONS / 'icon.ico', format='ICO', sizes=[(s, s) for s in ico_sizes])

# web favicon + in-app icon
lanczos(icon1024, 64).save(PUB / 'favicon.png', optimize=True)
lanczos(icon1024, 32).save(BRAND / 'icon-32.png', optimize=True)
lanczos(icon1024, 128).save(BRAND / 'icon-128.png', optimize=True)
lanczos(icon1024, 256).save(BRAND / 'icon-256.webp', quality=92, method=6)


# ---------------------------------------------------------------- HANAN TRADE logo
def logo_cutout(src: Image.Image) -> Image.Image | None:
    """Black chrome on a light studio floor: keep the dark subject (closing + hole fill),
    drop the floor reflection under the lettering, feather the edge."""
    rgb = src.convert('RGB')
    lum = np.asarray(rgb).astype(float).mean(2)
    h, w = lum.shape
    cut = int(h * 0.803)  # the reflection starts right under the letters
    m = lum < 185
    m[cut:, :] = False
    mi = Image.fromarray((m * 255).astype('uint8'))
    mi = mi.filter(ImageFilter.MaxFilter(13)).filter(ImageFilter.MinFilter(13))
    pad = Image.new('L', (w + 2, h + 2), 0)
    pad.paste(mi, (1, 1))
    ImageDraw.floodfill(pad, (0, 0), 128)
    solid = np.asarray(pad)[1:-1, 1:-1] != 128
    solid[cut:, :] = False
    alpha = Image.fromarray((solid * 255).astype('uint8')).filter(ImageFilter.MinFilter(3))
    alpha = alpha.filter(ImageFilter.GaussianBlur(1.0))
    out = rgb.convert('RGBA')
    out.putalpha(alpha)
    return out.crop(alpha.point(lambda v: 255 if v > 10 else 0).getbbox())


logo_src = Image.open(HERE / 'hanan-trade-logo.webp')
cut = logo_cutout(logo_src)
cut.save(HERE / 'hanan-trade-logo-transparent.png', optimize=True)
# optimised copies served by the app
lanczos(logo_src.convert('RGB'), 512).save(BRAND / 'hanan-trade-logo.webp', quality=88, method=6)
cut_small = cut.resize((round(cut.width * 520 / cut.height), 520), Image.LANCZOS)
cut_small.save(BRAND / 'hanan-trade-logo-transparent.webp', quality=90, method=6)


# ---------------------------------------------------------------- installer bitmaps
def bmp(path: Path, size, draw_fn):
    im = Image.new('RGB', size, (0, 0, 0))
    draw_fn(im)
    im.save(path, format='BMP')


def centred(im: Image.Image, art: Image.Image, cx: int, cy: int):
    im.paste(art, (cx - art.width // 2, cy - art.height // 2), art if art.mode == 'RGBA' else None)


def nsis_header(im):  # 150x57: icon on the right
    centred(im, lanczos(icon1024, 45), 150 - 32, 28)


def nsis_sidebar(im):  # 164x314: logo on top, icon + name below
    logo = cut.resize((120, round(cut.height * 120 / cut.width)), Image.LANCZOS)
    centred(im, logo, 82, 120)
    centred(im, lanczos(icon1024, 40), 82, 262)


def wix_banner(im):  # 493x58
    centred(im, lanczos(icon1024, 44), 493 - 36, 29)


def wix_dialog(im):  # 493x312, left 164 px is the visible side panel
    logo = cut.resize((120, round(cut.height * 120 / cut.width)), Image.LANCZOS)
    centred(im, logo, 82, 120)
    centred(im, lanczos(icon1024, 40), 82, 262)


bmp(INST / 'nsis-header.bmp', (150, 57), nsis_header)
bmp(INST / 'nsis-sidebar.bmp', (164, 314), nsis_sidebar)
bmp(INST / 'wix-banner.bmp', (493, 58), wix_banner)
bmp(INST / 'wix-dialog.bmp', (493, 312), wix_dialog)
print('done')
