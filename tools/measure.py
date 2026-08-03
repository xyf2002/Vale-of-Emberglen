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
import argparse, glob, json, os, sys
import numpy as np
from PIL import Image

# Guardrail bands are measured FROM the reference set, not invented. Two were wrong in
# the first version and are corrected here — an instrument that reports a false failure
# wastes a round just as surely as one that reports a false pass:
#   colours: the real frames span 422 (pw_16, night) to 1056 (pw_11), not 800-1700.
#   ratio:   0.63-0.96 is a DAYLIGHT number. pw_16, the reference night frame, measures
#            1.27 — ground brighter than sky is correct after dark, so night shots are
#            exempt rather than permanently flagged.
TARGETS = {
    'ratio': (0.63, 0.96, 'ground/sky luminance ratio (daylight only)'),
    'sat':   (0.26, 0.32, 'mean saturation'),
    'clip':  (0.00, 0.50, '% pixels blown to white'),
    'colors': (420, 1100, 'distinct quantised colours'),
    'edge':  (5.0, 10.0, 'local contrast / fine detail'),
}
# shots whose reference comp is a night/dusk frame, where the daylight ratio does not apply
NIGHT_SHOTS = {'dusk_mood'}

# Shots where a creature fills most of the frame. The `sat` band was measured off WIDE
# reference plates (landscapes at 0.26-0.32); a close-up of a saturated character is
# legitimately far above that and flagging it would be a false failure. Reported without
# a pass/fail claim instead of silently judged against the wrong band.
CLOSEUP_SHOTS = {'creature_portrait'}


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


def dead(s):
    """
    Is this frame evidence of anything at all?

    The capture harness dies with "Execution context was destroyed" on roughly half of
    runs while several agents are editing files (vite HMR reloads the page mid-shot). It
    WRITES THE FRAME BEFORE IT FAILS, so the round directory is left holding a black PNG.
    This script then measured that black PNG and reported `mean 7.6 / colors 72 / edge
    0.72` in the same table and the same format as a real result — which reads exactly
    like a catastrophic regression, and cost a builder most of a round chasing one.

    A measurement of a dead frame is not a bad score, it is an absence of data, and the
    two must never be printed as though they were the same kind of thing.
    """
    return s['mean'] < 12 or s['colors'] < 100 or s['edge'] < 0.9


def row(name, s, flag=''):
    return (f"{name:26}{s['mean']:7.1f}{s['sky']:7.1f}{s['ground']:7.1f}"
            f"{s['ratio']:8.2f}{s['sat']:8.3f}{s['clip']:7.2f}{s['colors']:8d}{s['edge']:7.2f}  {flag}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--round', required=True)
    args = ap.parse_args()

    hdr = f"{'IMAGE':26}{'mean':>7}{'sky':>7}{'grnd':>7}{'g/s':>8}{'sat':>8}{'clip%':>7}{'colors':>8}{'edge':>7}"
    print(hdr)

    # If the harness said the round failed, say so BEFORE the table. A round can contain
    # a mix of good frames and black ones, and the table alone cannot tell you which.
    suspect = set()
    try:
        with open(f'captures/{args.round}/report.json') as f:
            rep = json.load(f)
        if not rep.get('ok', True):
            print(f"\n!!  captures/{args.round}/report.json says ok=false — this round is NOT trustworthy.")
            for b in rep.get('blankFrames', []) or []:
                print(f"!!    suspect frame: {b}")
                suspect.add(str(b).split(':')[0].strip())
            if rep.get('error'):
                print(f"!!    harness error: {str(rep['error']).splitlines()[0][:160]}")
            print("!!  Re-capture before drawing any conclusion from the numbers below.\n")
    except FileNotFoundError:
        print(f"\n!!  no report.json in captures/{args.round} — cannot confirm the harness "
              f"finished. Numbers below may be from a partial round.\n")

    print(f"--- OURS ({args.round}) " + '-' * (len(hdr) - 14))
    ours = {}
    n_dead = 0
    for p in sorted(glob.glob(f'captures/{args.round}/*.png')):
        n = os.path.basename(p)[:-4]
        if n[-3:-2] == '_' and n[-2:].isdigit():
            continue  # skip strip frames
        s = stats(p)
        ours[n] = s
        if dead(s) or n in suspect:
            n_dead += 1
            print(row(n, s, '  <== DEAD FRAME — NOT A MEASUREMENT. Re-capture this shot.'))
            continue
        bad = []
        lo, hi = TARGETS['ratio'][:2]
        if n not in NIGHT_SHOTS and not (lo <= s['ratio'] <= hi):
            bad.append(f"ratio {s['ratio']:.2f} (want {lo}-{hi})")
        # `sat` was measured off WIDE daylight plates. Night and close-up shots are judged
        # against the wrong band by construction, so they are reported, not graded.
        if n not in NIGHT_SHOTS and n not in CLOSEUP_SHOTS:
            lo, hi = TARGETS['sat'][:2]
            if s['sat'] < lo:
                bad.append("undersaturated")
            elif s['sat'] > hi:
                bad.append(f"oversaturated ({s['sat']:.3f} vs reference {lo}-{hi})")
        if s['clip'] > TARGETS['clip'][1]:
            bad.append("clipping")
        lo, hi = TARGETS['colors'][:2]
        if s['colors'] < lo:
            bad.append("flat palette")
        elif s['colors'] > hi:
            bad.append(f"palette noise ({s['colors']} vs reference {lo}-{hi})")
        # BOTH SIDES. This was low-side-only, so creature_portrait sat at edge 13.56
        # against a reference band topping out at 9.87 and passed silently for rounds —
        # which is precisely the "uniformly, mercilessly sharp, no aerial perspective,
        # every plane equally crisp" complaint the blind critics kept writing out in
        # prose while the instrument underneath them reported ok.
        lo, hi = TARGETS['edge'][:2]
        if s['edge'] < lo:
            bad.append(f"low detail (edge {s['edge']:.1f} vs reference 5.2-9.9)")
        elif s['edge'] > hi:
            bad.append(f"over-sharp / no depth cue (edge {s['edge']:.1f} vs reference 5.2-9.9)")
        print(row(n, s, '  <-- ' + '; '.join(bad) if bad else '  ok'))

    print(f"--- REAL PALWORLD " + '-' * (len(hdr) - 18))
    for p in sorted(glob.glob('reference/palworld/pw_*.jpg'))[:0] or \
            ['reference/palworld/pw_11.jpg', 'reference/palworld/pw_15.jpg',
             'reference/palworld/pw_07.jpg', 'reference/palworld/pw_16.jpg',
             'reference/palworld/pw_02.jpg']:
        print(row(os.path.basename(p)[:-4], stats(p)))

    print("\nTargets: " + ', '.join(f"{k} {v[0]}-{v[1]}" for k, v in TARGETS.items()))
    print("Bands are two-sided: exceeding one is as much a finding as falling short of it.")
    print(f"`sat` is graded on wide daylight shots only (night: {sorted(NIGHT_SHOTS)}, "
          f"close-up: {sorted(CLOSEUP_SHOTS)} are reported, not graded).")
    print("These are guardrails, not the bar. The bar is a critic picking our frame as the real game.")
    if n_dead:
        print(f"\n!!  {n_dead} frame(s) in this round are dead and were not measured. "
              f"The round is incomplete.")
        sys.exit(2)


if __name__ == '__main__':
    main()
