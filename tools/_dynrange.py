#!/usr/bin/env python3
"""
GROUND-BAND DYNAMIC RANGE — a probe for "nothing casts a shadow onto anything".

measure.py's `edge` counts local contrast anywhere in the frame; a busy grass texture
scores on it just as well as a tree shadow does. This probe asks the narrower question
the r19 blind critic actually asked: within the ground half of the frame, how far apart
are the darkest and brightest pixels, and what fraction of the ground is meaningfully
darker than the lit level?

Definitions, fixed here so rounds are comparable:
  - ground band  = the bottom half of the frame, the same split measure.py uses
                   (lum[90:] on its 320x180 resample). Measured at FULL resolution here:
                   the 320x180 resample averages a cast-shadow edge away and costs ~15
                   units of span on every shot.
  - span         = p98 - p02 of ground-band luminance.
  - shadow%      = fraction of ground pixels below 0.35 * p90(ground). p90 stands in for
                   "the lit level" and is robust to a few blown highlights. 0.35 is 1.5
                   stops down: deliberately strict, so grass self-shading and the baked
                   contact bands do NOT score and only something that removes most of
                   the key does. At 0.5 the threshold catches the grass ramp and both
                   sets converge; at 0.35 the r18 build reads 0.3-6.1% against the real
                   plates' 15.7-38.3%, which is the gap the r19 critic described.

This is a PROBE, not a guardrail. It has no bands and it is never graded. Its only job
is to give a shadow change a number, because `edge` moves for six other reasons.

    python3 tools/_dynrange.py captures/<round> [more dirs...]

With no argument it also prints the real Palworld plates for scale.
"""
import sys
import pathlib
import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
SHOTS = ['vista_golden', 'overshoulder_meadow', 'creature_portrait',
         'creature_group', 'interaction_feed', 'dusk_mood']
PLATES = ['pw_11', 'pw_15', 'pw_07', 'pw_16', 'pw_02']


def dyn(path):
    im = np.asarray(Image.open(path).convert('RGB')).astype(float)
    lum = 0.2126 * im[:, :, 0] + 0.7152 * im[:, :, 1] + 0.0722 * im[:, :, 2]
    g = lum[lum.shape[0] // 2:].ravel()
    p02, p50, p90, p98 = np.percentile(g, [2, 50, 90, 98])
    shadow = float((g < 0.35 * p90).mean()) * 100.0
    return dict(p02=p02, p50=p50, p98=p98, span=p98 - p02, shadow=shadow)


def table(title, rows):
    print(f'--- {title} ' + '-' * max(0, 62 - len(title)))
    print(f"{'IMAGE':26}{'p02':>7}{'p50':>7}{'p98':>7}{'span':>8}{'shadow%':>9}")
    for name, s in rows:
        print(f"{name:26}{s['p02']:7.1f}{s['p50']:7.1f}{s['p98']:7.1f}"
              f"{s['span']:8.1f}{s['shadow']:9.2f}")
    if rows:
        sp = [s['span'] for _, s in rows]
        sh = [s['shadow'] for _, s in rows]
        print(f"{'  range':26}{'':7}{'':7}{'':7}"
              f"{min(sp):4.0f}-{max(sp):<3.0f}{min(sh):5.1f}-{max(sh):<4.1f}")
    print()


def main():
    dirs = [pathlib.Path(a) for a in sys.argv[1:]]
    for d in dirs:
        if not d.is_absolute():
            d = ROOT / d
        rows = []
        for s in SHOTS:
            p = d / f'{s}.png'
            if p.exists():
                rows.append((s, dyn(p)))
        table(d.name, rows)

    ref = ROOT / 'reference' / 'palworld'
    rows = []
    for s in PLATES:
        p = ref / f'{s}.jpg'
        if p.exists():
            rows.append((s, dyn(p)))
    table('REAL PALWORLD', rows)


if __name__ == '__main__':
    main()
