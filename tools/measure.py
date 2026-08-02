#!/usr/bin/env python3
"""
Objective image statistics for our captures against the real Palworld reference.

    python3 tools/measure.py --round r07

These are not the quality bar -- a critic's eye is. They are a fast, honest way to
tell whether a change moved the image toward the reference or away from it, and to
stop arguments about whether something "looks brighter".

The one that matters most right now is ground/sky luminance ratio: real Palworld
frames sit at 0.63-0.96. Anything near 0.3 means the ground is being rendered far
too dark and every gameplay-framed shot will lose on sight.
"""
import argparse, glob, os
import numpy as np
from PIL import Image

TARGETS = {
    'ratio': (0.63, 0.96, 'ground/sky luminance ratio'),
    'sat':   (0.26, 0.32, 'mean saturation'),
    'clip':  (0.00, 0.50, '% pixels blown to white'),
    'colors': (800, 1700, 'distinct quantised colours'),
}


def stats(path):
    im = np.asarray(Image.open(path).convert('RGB').resize((320, 180))).astype(float)
    lum = 0.2126 * im[:, :, 0] + 0.7152 * im[:, :, 1] + 0.0722 * im[:, :, 2]
    top, bot = lum[:90].mean(), lum[90:].mean()
    mx, mn = im.max(axis=2), im.min(axis=2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0).mean()
    q = (im // 16).astype(int)
    colors = len(np.unique(q[:, :, 0] * 400 + q[:, :, 1] * 20 + q[:, :, 2]))
    # local contrast: how much fine detail survives
    gx = np.abs(np.diff(lum, axis=1)).mean()
    return dict(mean=lum.mean(), sky=top, ground=bot, ratio=bot / max(top, 1.0),
                sat=sat, clip=(lum > 250).mean() * 100, crush=(lum < 12).mean() * 100,
                colors=colors, edge=gx)


def row(name, s, flag=''):
    return (f"{name:26}{s['mean']:7.1f}{s['sky']:7.1f}{s['ground']:7.1f}"
            f"{s['ratio']:8.2f}{s['sat']:8.3f}{s['clip']:7.2f}{s['colors']:8d}{s['edge']:7.2f}  {flag}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--round', required=True)
    args = ap.parse_args()

    hdr = f"{'IMAGE':26}{'mean':>7}{'sky':>7}{'grnd':>7}{'g/s':>8}{'sat':>8}{'clip%':>7}{'colors':>8}{'edge':>7}"
    print(hdr)
    print(f"--- OURS ({args.round}) " + '-' * (len(hdr) - 14))
    ours = {}
    for p in sorted(glob.glob(f'captures/{args.round}/*.png')):
        n = os.path.basename(p)[:-4]
        if n[-3:-2] == '_' and n[-2:].isdigit():
            continue  # skip strip frames
        s = stats(p)
        ours[n] = s
        bad = []
        if not (TARGETS['ratio'][0] <= s['ratio'] <= TARGETS['ratio'][1]):
            bad.append(f"ratio {s['ratio']:.2f} (want 0.63-0.96)")
        if s['sat'] < TARGETS['sat'][0]:
            bad.append(f"undersaturated")
        if s['clip'] > TARGETS['clip'][1]:
            bad.append(f"clipping")
        if s['colors'] < TARGETS['colors'][0]:
            bad.append(f"flat palette")
        print(row(n, s, '  <-- ' + '; '.join(bad) if bad else '  ok'))

    print(f"--- REAL PALWORLD " + '-' * (len(hdr) - 18))
    for p in sorted(glob.glob('reference/palworld/pw_*.jpg'))[:0] or \
            ['reference/palworld/pw_11.jpg', 'reference/palworld/pw_15.jpg',
             'reference/palworld/pw_07.jpg', 'reference/palworld/pw_16.jpg',
             'reference/palworld/pw_02.jpg']:
        print(row(os.path.basename(p)[:-4], stats(p)))

    print("\nTargets: " + ', '.join(f"{k} {v[0]}-{v[1]}" for k, v in TARGETS.items()))
    print("These are guardrails, not the bar. The bar is a critic picking our frame as the real game.")


if __name__ == '__main__':
    main()
