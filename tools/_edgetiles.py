#!/usr/bin/env python3
"""
THROWAWAY PROBE — where in the frame does `edge` live?

measure.py grades one number: mean |horizontal luminance step| on a 320x180
downsample. That number says a frame is over-sharp but not WHERE, and the two
answers ("the whole frame is crunchy" vs "one plane is crunchy and the rest is
mush") want opposite fixes.

    python3 tools/_edgetiles.py captures/r16/creature_portrait.png reference/palworld/pw_15.jpg

Splits the same 320x180 buffer measure.py uses into a 6-row x 8-column grid and
prints per-tile edge for each image plus the difference. Rows are top-to-bottom.
"""
import sys
import numpy as np
from PIL import Image

ROWS, COLS = 6, 8


def tiles(path):
    im = np.asarray(Image.open(path).convert('RGB').resize((320, 180))).astype(float)
    lum = 0.2126 * im[:, :, 0] + 0.7152 * im[:, :, 1] + 0.0722 * im[:, :, 2]
    d = np.abs(np.diff(lum, axis=1))          # 180 x 319
    out = np.zeros((ROWS, COLS))
    for r in range(ROWS):
        y0, y1 = r * 180 // ROWS, (r + 1) * 180 // ROWS
        for c in range(COLS):
            x0, x1 = c * 319 // COLS, (c + 1) * 319 // COLS
            out[r, c] = d[y0:y1, x0:x1].mean()
    return out, d.mean()


def show(title, g, total):
    print(f"--- {title}   whole-frame edge {total:.2f}")
    for r in range(ROWS):
        print('   ' + ' '.join(f"{v:6.2f}" for v in g[r]))


def main():
    a, at = tiles(sys.argv[1])
    show(sys.argv[1], a, at)
    if len(sys.argv) > 2:
        b, bt = tiles(sys.argv[2])
        show(sys.argv[2], b, bt)
        show('OURS MINUS REF (positive = we are harsher)', a - b, at - bt)


if __name__ == '__main__':
    main()
