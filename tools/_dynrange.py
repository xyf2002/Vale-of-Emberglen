#!/usr/bin/env python3
"""
Luminance dynamic range of the GROUND band, ours vs the real plates.

Every critic since r08 has said some version of "there is no sun — nothing has a dark
side". That is an opinion until it is a number. measure.py already grades the ground/sky
MEAN ratio, and we pass it: the ground is at the right average brightness. This probe
asks the question the mean cannot answer — how far apart are the lit and unlit pixels
inside that band.

A frame can sit dead centre of every ratio band and still be flat, because a flat frame
and a contrasty one with the same average are the same number to a mean. The percentile
span is what separates "lit by a sun" from "lit by a lightbox".

    python3 tools/_dynrange.py captures/r18nohud

Reported per image, over the lower 55% of the frame (the ground band measure.py uses):
    p02 / p50 / p98    luminance percentiles, 0-255
    span               p98 - p02
    shadowfrac         fraction of ground pixels below 0.55 x the band median, which is
                       roughly "in shadow" for a diffuse surface under a key/fill rig
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

GROUND_FROM = 0.45  # measure.py splits sky/ground at 45% of frame height


def lum(path):
    im = np.asarray(Image.open(path).convert("RGB").resize((320, 180))).astype(float)
    y = 0.2126 * im[:, :, 0] + 0.7152 * im[:, :, 1] + 0.0722 * im[:, :, 2]
    return y[int(y.shape[0] * GROUND_FROM):]


def row(name, y):
    p02, p50, p98 = np.percentile(y, [2, 50, 98])
    shadow = float((y < 0.55 * p50).mean())
    return f"{name:<28} {p02:6.1f} {p50:6.1f} {p98:6.1f}   {p98 - p02:6.1f}   {shadow * 100:5.1f}%"


def main():
    rounds = sys.argv[1:] or ["captures/r18nohud"]
    print(f"{'IMAGE':<28} {'p02':>6} {'p50':>6} {'p98':>6}   {'span':>6}   {'shadow':>6}")
    for r in rounds:
        print(f"--- {r} " + "-" * 40)
        for f in sorted(Path(r).glob("*.png")):
            if f.stem[-3:-2] == "_" and f.stem[-2:].isdigit():
                continue  # motion strip frame
            print(row(f.stem, lum(f)))
    ref = Path("reference/palworld")
    if ref.exists():
        print("--- real palworld " + "-" * 40)
        for f in sorted(ref.glob("*.jpg")):
            print(row(f.stem, lum(f)))


if __name__ == "__main__":
    main()
