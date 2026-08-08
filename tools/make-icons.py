#!/usr/bin/env python3
"""Generate the extension's PNG icons.

Chrome will not accept SVG for toolbar icons, so these have to be raster.
Rather than commit opaque binaries, this regenerates them from the shape
definition below. Run it after changing the colour or the mark:

    python3 tools/make-icons.py

Uses only the standard library (zlib for the deflate stream, struct for the
chunk headers), so there is nothing to install.
"""

import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4  # render this many times larger, then average down: cheap antialiasing

# Registration magenta, the panel's one signal colour. Sits between the light
# and dark theme values so the icon holds up on a light or dark Chrome toolbar.
ACCENT = (198, 24, 118)
MARK = (255, 250, 252)      # near white

CORNER_RADIUS = 0.22        # fraction of the icon edge
BRACKET_MARGIN = 0.20
BRACKET_ARM = 0.28
BRACKET_WEIGHT = 0.095


def inside_rounded_square(x, y, radius):
    """x, y are normalised to 0..1."""
    cx = min(max(x, radius), 1 - radius)
    cy = min(max(y, radius), 1 - radius)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= radius * radius


def inside_brackets(x, y):
    m, arm, w = BRACKET_MARGIN, BRACKET_ARM, BRACKET_WEIGHT
    # Fold the coordinate into the top-left quadrant so one test covers all
    # four corners.
    fx = x if x <= 0.5 else 1 - x
    fy = y if y <= 0.5 else 1 - y
    horizontal = m <= fx <= m + arm and m <= fy <= m + w
    vertical = m <= fx <= m + w and m <= fy <= m + arm
    return horizontal or vertical


def render(size):
    hi = size * SUPERSAMPLE
    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            r = g = b = a = 0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    x = (px * SUPERSAMPLE + sx + 0.5) / hi
                    y = (py * SUPERSAMPLE + sy + 0.5) / hi
                    if not inside_rounded_square(x, y, CORNER_RADIUS):
                        continue
                    colour = MARK if inside_brackets(x, y) else ACCENT
                    r += colour[0]
                    g += colour[1]
                    b += colour[2]
                    a += 255
            n = SUPERSAMPLE * SUPERSAMPLE
            if a == 0:
                row.append((0, 0, 0, 0))
            else:
                covered = a // 255
                row.append((r // covered, g // covered, b // covered, a // n))
        rows.append(row)
    return rows


def write_png(path, rows):
    height = len(rows)
    width = len(rows[0])
    raw = b"".join(
        b"\x00" + bytes(channel for pixel in row for channel in pixel) for row in rows
    )

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")

    with open(path, "wb") as handle:
        handle.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        write_png(path, render(size))
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
