#!/usr/bin/env python3
"""Assemble docs/media/demo.gif from the frames tools/make-media.mjs recorded.

    python3 tools/make-gif.py                      # docs/media/frames -> docs/media/demo.gif
    python3 tools/make-gif.py frames out.gif 900   # explicit paths and output width

Needs Pillow (python3 -m pip install Pillow), which macOS ships with. One
palette is computed from a spread of frames and applied to all of them, so the
interface does not flicker between frames the way per-frame palettes make it.
No dithering: the panel is flat colour and dithering would only add noise and
bytes.
"""

import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
frames_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "docs", "media", "frames")
out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "docs", "media", "demo.gif")
width = int(sys.argv[3]) if len(sys.argv) > 3 else 960

with open(os.path.join(frames_dir, "durations.json")) as handle:
    durations = json.load(handle)

names = sorted(name for name in os.listdir(frames_dir) if name.endswith(".png"))
if len(names) != len(durations):
    sys.exit(f"{len(names)} frames but {len(durations)} durations; rerun make-media.mjs")

frames = []
for name in names:
    image = Image.open(os.path.join(frames_dir, name)).convert("RGB")
    height = round(image.height * width / image.width)
    frames.append(image.resize((width, height), Image.LANCZOS))

# A shared palette, learned from the first, last and two middle frames.
picks = sorted({0, len(frames) // 3, (2 * len(frames)) // 3, len(frames) - 1})
sample = Image.new("RGB", (width, frames[0].height * len(picks)))
for row, index in enumerate(picks):
    sample.paste(frames[index], (0, row * frames[0].height))
palette = sample.quantize(colors=256, method=Image.Quantize.MEDIANCUT)

quantized = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
quantized[0].save(
    out_path,
    save_all=True,
    append_images=quantized[1:],
    duration=durations,
    loop=0,
    optimize=True,
    disposal=1,
)

size_kb = os.path.getsize(out_path) / 1024
print(f"{out_path}: {len(frames)} frames, {width}x{frames[0].height}, {size_kb:.0f} kB")
