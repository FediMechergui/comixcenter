"""Draws the ComixCenter registration-mark icon at any size (PWA + Android launcher)."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

PAPER, INK, CYAN, MAGENTA, YELLOW = "#f3f5f7", "#15171c", "#00a0d2", "#e2007a", "#ffd400"


def draw_icon(size: int, inset: float = 0.16, background: str = PAPER, round_corners: bool = False) -> Image.Image:
    s = size * 4  # supersample for smooth edges
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if round_corners:
        d.rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.22), fill=background)
    else:
        d.rectangle((0, 0, s, s), fill=background)
    c = s / 2
    r = s * (0.5 - inset) * 0.62
    w = max(4, int(s * 0.045))
    off = s * 0.035
    for color, dx, dy in ((CYAN, off, -off), (MAGENTA, -off, off), (INK, 0, 0)):
        d.ellipse((c - r + dx, c - r + dy, c + r + dx, c + r + dy), outline=color, width=w)
    arm = s * (0.5 - inset)
    d.line((c, c - arm, c, c + arm), fill=INK, width=w)
    d.line((c - arm, c, c + arm, c), fill=INK, width=w)
    dot = s * 0.085
    d.ellipse((c - dot, c - dot, c + dot, c + dot), fill=YELLOW, outline=INK, width=max(3, int(w * 0.7)))
    return img.resize((size, size), Image.LANCZOS)


def circle(img: Image.Image) -> Image.Image:
    mask = Image.new("L", (img.width * 4, img.height * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, mask.width - 1, mask.height - 1), fill=255)
    out = img.copy()
    out.putalpha(mask.resize(img.size, Image.LANCZOS))
    return out


def android(res: Path) -> None:
    """Launcher icons (legacy, round, adaptive foreground) and splash screens for every density."""
    sizes = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    for density, px in sizes.items():
        d = res / f"mipmap-{density}"
        draw_icon(px, inset=0.12, round_corners=True).save(d / "ic_launcher.png")
        circle(draw_icon(px, inset=0.14)).save(d / "ic_launcher_round.png")
        fg = int(px * 108 / 48)   # adaptive icons are 108dp with a 66dp safe zone
        draw_icon(fg, inset=0.3, background=(0, 0, 0, 0)).save(d / "ic_launcher_foreground.png")
    (res / "values" / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        '    <color name="ic_launcher_background">#F3F5F7</color>\n</resources>\n',
        encoding="utf-8")
    for splash in res.glob("drawable*/splash.png"):
        w, h = Image.open(splash).size
        canvas = Image.new("RGB", (w, h), PAPER)
        mark = draw_icon(int(min(w, h) * 0.32), inset=0.04, background=(0, 0, 0, 0))
        canvas.paste(mark, ((w - mark.width) // 2, (h - mark.height) // 2), mark)
        canvas.save(splash)


if __name__ == "__main__":
    out = Path(sys.argv[1])
    if len(sys.argv) > 2 and sys.argv[2] == "--android":
        android(out)
        sys.exit(0)
    draw_icon(192, round_corners=False).save(out / "icon-192.png")
    draw_icon(512).save(out / "icon-512.png")
    draw_icon(512, inset=0.26).save(out / "icon-maskable-512.png")
    draw_icon(64, inset=0.08).save(out / "favicon.png")
