#!/usr/bin/env python3
"""
THROWAWAY PROBE — is our excess `edge` amplitude, or frequency?

`edge` = mean |horizontal luminance step| on the 320x180 buffer, i.e. mean total
variation per row. TV = (number of light/dark alternations) x (their amplitude),
and the two want opposite fixes: too much amplitude is a palette/ramp problem,
too many alternations is a blade-count/width problem. Softening an edge does
NOT help either way — a monotone ramp has the same total variation as the step
it replaced.

    python3 tools/_edgeband.py captures/r16/creature_portrait.png reference/palworld/pw_15.jpg

Reports, on the bottom third of the 320x180 buffer (the near-field carpet):
  std    luminance spread     -> amplitude
  edge   mean |dx|            -> total variation
  ratio  edge/std             -> alternations per row; a smooth gradient is ~0.1,
                                 a per-pixel checkerboard is ~2
  p5/p95 the luminance floor and ceiling the carpet actually occupies
"""
import sys
import numpy as np
from PIL import Image


def band(path, y0=120, y1=180):
    im = np.asarray(Image.open(path).convert('RGB').resize((320, 180))).astype(float)
    lum = 0.2126 * im[:, :, 0] + 0.7152 * im[:, :, 1] + 0.0722 * im[:, :, 2]
    b = lum[y0:y1]
    d = np.abs(np.diff(b, axis=1))
    return dict(mean=b.mean(), std=b.std(), edge=d.mean(),
                ratio=d.mean() / max(b.std(), 1e-6),
                p5=np.percentile(b, 5), p50=np.percentile(b, 50), p95=np.percentile(b, 95),
                big=(d > 20).mean() * 100)


def main():
    print(f"{'image':44}{'mean':>7}{'std':>7}{'edge':>7}{'e/std':>7}{'p5':>7}{'p50':>7}{'p95':>7}{'>20%':>7}")
    for p in sys.argv[1:]:
        s = band(p)
        print(f"{p:44}{s['mean']:7.1f}{s['std']:7.1f}{s['edge']:7.2f}{s['ratio']:7.2f}"
              f"{s['p5']:7.1f}{s['p50']:7.1f}{s['p95']:7.1f}{s['big']:7.1f}")


if __name__ == '__main__':
    main()
