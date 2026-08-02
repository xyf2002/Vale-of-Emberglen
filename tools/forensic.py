#!/usr/bin/env python3
"""
FORENSIC IMAGE COMPARISON — the critic's objective "eye".

Because the gauntlet must run without a vision model, every critic round uses this
tool: it computes a battery of pixel-level statistics on our frame vs the matched
Palworld reference and prints a side-by-side table. A critic reads the table AND
the images to form its verdict.

  python3 tools/forensic.py --round r01 --out /tmp/forensic_r01.txt
  python3 tools/forensic.py --round r02 --vs r01   # did we actually improve?

Metrics (all on the same 1280x720 normalized pair):
  luma_mean/std          tonal range, exposure
  p1 / p99.9             deepest darks / brightest highlights present
  blown%                 pixels clipped > 235 (overexposure tell)
  sat_mean               global saturation (Palworld ~0.26-0.61, flat builds < 0.21)
  colors4                unique colors at 4 bits/channel (Palworld 850-1600, flat < 710)
  edge_*                 mean gradient magnitude per vertical band (detail density)
  varlap                 variance-of-Laplacian sharpness
  green_bot              G-R in bottom band (meadow greenness)
  sky_d2max              sky gradient banding roughness
"""
import argparse, json, subprocess, sys
from pathlib import Path

SIZE = (1280, 720)

def load_norm(path):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    return im.resize(SIZE, Image.LANCZOS)

def metrics(im):
    import numpy as np
    a = np.asarray(im).astype(np.float32)
    l = 0.2126*a[...,0] + 0.7152*a[...,1] + 0.0722*a[...,2]
    r, g, b = a[...,0], a[...,1], a[...,2]
    mx = a.max(axis=2); mn = a.min(axis=2)
    sat = (mx - mn) / np.maximum(mx, 1e-5)
    p = np.percentile(l, [1, 50, 99, 99.9])
    gy = np.abs(np.diff(l, axis=0)); gx = np.abs(np.diff(l, axis=1))
    gy = np.pad(gy, ((0,1),(0,0))); gx = np.pad(gx, ((0,0),(0,1)))
    edge = np.sqrt(gx**2 + gy**2)
    H = l.shape[0]
    bands = [l[:H//3], l[H//3:2*H//3], l[2*H//3:]]
    band_edges = [float(np.sqrt((np.diff(b,axis=0)**2).mean() + (np.diff(b,axis=1)**2).mean())) for b in bands]
    # sky gradient banding: roughness of the top-band row-mean second difference
    top_rows = l[:int(H*0.22)].mean(axis=1)
    d2 = np.diff(top_rows, 2)
    sky_d2max = float(np.abs(d2).max()) if len(d2) > 2 else 0.0
    q = (a/16).astype(np.uint8)
    colors4 = len(np.unique(q[...,0]*(16*16) + q[...,1]*16 + q[...,2]))
    return {
        "luma_mean": round(float(l.mean()),1),
        "luma_std": round(float(l.std()),1),
        "p1": round(float(p[0]),1),
        "p99.9": round(float(p[3]),1),
        "blown%": round(float((l > 235).mean()*100),1),
        "sat": round(float(sat.mean()),3),
        "colors4": colors4,
        "edge_T/M/B": [round(e,1) for e in band_edges],
        "varlap": round(float((4*l - (np.roll(l,1,0)+np.roll(l,-1,0)+np.roll(l,1,1)+np.roll(l,-1,1))).var()),0),
        "green_bot": round(float((g[2*H//3:]-r[2*H//3:]).mean()),1),
        "sky_d2max": round(sky_d2max,2),
    }

def row(m, key, fmt=None):
    v = m[key]
    if isinstance(v, list):
        return "/".join(str(x) for x in v)
    return str(v)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--round", required=True)
    ap.add_argument("--vs", default=None)
    ap.add_argument("--comps", default="reference/comps.json")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    ours_dir = Path("captures") / args.round
    if not ours_dir.exists():
        sys.exit(f"no captures for {args.round}")

    keys = ["luma_mean","luma_std","p1","p99.9","blown%","sat","colors4","edge_T/M/B","varlap","green_bot","sky_d2max"]
    comps = json.loads(Path(args.comps).read_text()) if Path(args.comps).exists() else {}

    lines = []
    lines.append(f"FORENSIC — round {args.round}" + (f" vs {args.vs}" if args.vs else " vs Palworld reference"))
    lines.append("=" * 96)
    hdr = f"{'shot':<22} " + " ".join(f"{k:>10}" for k in keys)
    lines.append(hdr)
    lines.append("-" * 96)

    shots = sorted(p.stem for p in ours_dir.glob("*.png") if not p.name.endswith((".png_01",)) and not "_0" in p.name[-5:])
    for png in sorted(ours_dir.glob("*.png")):
        if png.stem.endswith("_00") or png.stem.endswith("_01") or png.stem.endswith("_02") or png.stem.endswith("_03") or png.stem.endswith("_04") or png.stem.endswith("_05"):
            continue
        shot = png.stem
        m = metrics(load_norm(png))
        if args.vs:
            twin = Path("captures") / args.vs / png.name
            ref = metrics(load_norm(twin)) if twin.exists() else None
        else:
            refs = comps.get(shot) or []
            ref = metrics(load_norm(Path(refs[0]))) if refs else None
        lines.append(f"{shot:<22} " + " ".join(f"{row(m,k):>10}" for k in keys))
        if ref:
            lines.append(f"{'  reference':<22} " + " ".join(f"{row(ref,k):>10}" for k in keys))
            deltas = {k: (m[k]-ref[k]) for k in keys if isinstance(m[k], (int,float))}
            worst = sorted(deltas.items(), key=lambda kv: -abs(kv[1]))[:4]
            lines.append(f"{'  Δ':<22} " + "  ".join(f"{k}={v:+.1f}" for k,v in worst))
        lines.append("-" * 96)

    out = "\n".join(lines)
    print(out)
    if args.out:
        Path(args.out).write_text(out + "\n")

if __name__ == "__main__":
    main()
