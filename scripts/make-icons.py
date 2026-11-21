#!/usr/bin/env python3
"""Generate the x-manager app icons from the design system.

Design: charcoal #0A0C0E rounded square, signal amber #F5A623 "X"
letterform — the same palette as the web app's ops-ledger theme.
Outputs build/icons/icon.png (1024), resized PNGs and a multi-size
icon.ico for electron-builder. Requires Pillow (pip install pillow).
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "build", "icons")
SIZE = 1024
CHARCOAL = (10, 12, 14, 255)
AMBER = (245, 166, 35, 255)


def draw_icon(size: int) -> Image.Image:
    """Draw the X mark at the given pixel size."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Rounded-square background, full bleed with a soft corner radius.
    d.rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * 0.20), fill=CHARCOAL
    )
    # The X: two thick diagonal bars with rounded ends.
    # Arms run from ~22% to ~78% of the canvas.
    margin = int(size * 0.225)
    width = int(size * 0.145)
    cap_r = width // 2
    for (x1, y1), (x2, y2) in [
        ((margin, margin), (size - margin, size - margin)),
        ((size - margin, margin), (margin, size - margin)),
    ]:
        d.line([(x1, y1), (x2, y2)], fill=AMBER, width=width)
        for cx, cy in ((x1, y1), (x2, y2)):
            d.ellipse(
                [cx - cap_r, cy - cap_r, cx + cap_r, cy + cap_r], fill=AMBER
            )
    return img


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    base = draw_icon(SIZE)
    base.save(os.path.join(OUT, "icon.png"))
    png_sizes = [512, 256, 128, 64, 48, 32, 16]
    for s in png_sizes:
        base.resize((s, s), Image.LANCZOS).save(
            os.path.join(OUT, f"icon-{s}.png")
        )
    # Multi-resolution .ico (16..256). Pillow downscales from the 1024 source.
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    base.save(os.path.join(OUT, "icon.ico"), format="ICO", sizes=ico_sizes)
    print(f"wrote icons to {OUT}:")
    for name in sorted(os.listdir(OUT)):
        print("  ", name, os.path.getsize(os.path.join(OUT, name)), "bytes")


if __name__ == "__main__":
    main()
