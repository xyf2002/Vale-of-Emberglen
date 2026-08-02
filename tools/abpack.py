#!/usr/bin/env python3
"""
Build a BLIND A/B comparison pack.

For each matched shot we emit a folder containing exactly two images, A.jpg and B.jpg:
one is our build, one is a real Palworld screenshot. Both are re-encoded to identical
dimensions, format and JPEG quality, and stripped of metadata, so a critic cannot win
by spotting a technical tell (resolution, file size, PNG-vs-JPG) instead of actually
looking at the picture.

Which of A/B is ours is decided by a hash of (round, shot, salt) — deterministic for
reproducibility, but not guessable from the pack itself. The answer key is written
OUTSIDE the pack directory so a critic reading only its assigned folder stays blind.

  python3 tools/abpack.py --round r01 --out captures/ab/r01 --key /path/outside/key.json

Also supports round-vs-round self comparison (did we actually improve?):
  python3 tools/abpack.py --round r02 --vs r01 --out captures/ab/r02_vs_r01 --key ...
"""
import argparse, hashlib, json, os, shutil, sys
from pathlib import Path
from PIL import Image

SIZE = (1280, 720)
QUALITY = 88


def load_norm(path: Path) -> Image.Image:
    im = Image.open(path).convert("RGB")
    # letterbox-free: both sources are 16:9, so a straight resize is a fair normalisation
    return im.resize(SIZE, Image.LANCZOS)


def save_clean(im: Image.Image, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest, "JPEG", quality=QUALITY, optimize=True)  # PIL writes no EXIF by default


def side_for(round_name: str, shot: str, salt: str) -> str:
    h = hashlib.sha256(f"{round_name}|{shot}|{salt}".encode()).hexdigest()
    return "A" if int(h[:8], 16) % 2 == 0 else "B"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--round", required=True)
    ap.add_argument("--vs", default=None, help="compare against another round instead of the reference set")
    ap.add_argument("--index", default="reference/INDEX.md")
    ap.add_argument("--comps", default="reference/comps.json",
                    help='{"shot_id": ["reference/palworld/pw_03.jpg", ...]}')
    ap.add_argument("--out", required=True)
    ap.add_argument("--key", required=True, help="answer key path — keep OUTSIDE --out")
    ap.add_argument("--salt", default="emberglen")
    args = ap.parse_args()

    ours_dir = Path("captures") / args.round
    if not ours_dir.exists():
        sys.exit(f"no captures for round {args.round} at {ours_dir}")

    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    if args.vs:
        pairs = []
        other = Path("captures") / args.vs
        for png in sorted(ours_dir.glob("*.png")):
            twin = other / png.name
            if twin.exists():
                pairs.append((png.stem, png, twin, f"{args.round} vs {args.vs}"))
        mode = "round-vs-round"
    else:
        comps = json.loads(Path(args.comps).read_text()) if Path(args.comps).exists() else {}
        if not comps:
            sys.exit(f"{args.comps} missing — the reference curator must produce it first")
        pairs = []
        for shot, refs in comps.items():
            ours = ours_dir / f"{shot}.png"
            if not ours.exists() or not refs:
                continue
            pairs.append((shot, ours, Path(refs[0]), "ours vs real Palworld"))
        mode = "ours-vs-real"

    if not pairs:
        sys.exit("no comparable pairs found")

    key = {"round": args.round, "mode": mode, "pairs": {}}
    for shot, ours, theirs, label in pairs:
        our_side = side_for(args.round, shot, args.salt)
        their_side = "B" if our_side == "A" else "A"
        d = out / shot
        save_clean(load_norm(ours), d / f"{our_side}.jpg")
        save_clean(load_norm(theirs), d / f"{their_side}.jpg")
        key["pairs"][shot] = {"ours": our_side, "other": their_side,
                              "ourFile": str(ours), "otherFile": str(theirs), "label": label}

    Path(args.key).parent.mkdir(parents=True, exist_ok=True)
    Path(args.key).write_text(json.dumps(key, indent=2))

    (out / "README.txt").write_text(
        "BLIND COMPARISON PACK\n"
        "=====================\n"
        "Each subfolder is one matched shot and contains exactly two images: A.jpg and B.jpg.\n"
        "One was produced by the build under test; the other was not. They have been\n"
        "normalised to the same resolution, format and quality so that only the PICTURE differs.\n\n"
        "Judge them on what you see. Do not attempt to locate the answer key, inspect file\n"
        "metadata, or search the repository for the originals — doing so invalidates the trial\n"
        "and makes the whole gauntlet useless. Your value here is your eye, not your shell.\n")

    print(f"{mode}: {len(pairs)} pairs -> {out}")
    for shot in key["pairs"]:
        print(f"  {shot}")


if __name__ == "__main__":
    main()
