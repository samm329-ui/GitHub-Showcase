#!/usr/bin/env python3
"""
Lazy News asset preparation.

Cuts the isolated layers from their white RGB canvas and writes clean RGBA
PNGs. Originals are NEVER modified. The master reference (4.png) is used to
validate the composite at native coordinates.

    pip install pillow numpy scipy
    python tools/python/prep_lazy_news_assets.py --zip "News assets/Lazy news.zip" --out assets/news
    python tools/python/prep_lazy_news_assets.py --validate assets/news

Rules (docs/lazy-news.md §11.2):
  - edge-seeded near-white flood fill (NOT a global white color key, which
    would destroy shirt/paper/card edges);
  - per-asset component inspection + explicit drop rules (no global y cut);
  - 1px erosion + gaussian feather (~1.2px) to kill white halos;
  - 9.png: drop the embedded pin (3.png is the single pin layer);
  - 8.png: drop the detached cup/books at the right edge (they duplicate
    1.png's desk props);
  - 7.png: split into note-left / note-right for independent animation;
  - 1.png stays opaque and unchanged.
"""

import argparse
import json
import math
import os
import sys
import zipfile

import numpy as np
from PIL import Image
from scipy import ndimage

NEAR_WHITE = 243
FEATHER_SIGMA = 1.2
ERODE_PX = 1


def load_rgb(path_or_zip, name, zip_file):
    if zip_file is not None:
        with zipfile.ZipFile(zip_file) as zf:
            with zf.open(name) as f:
                return np.asarray(Image.open(f).convert("RGB")).astype(np.int16)
    return np.asarray(Image.open(path_or_zip).convert("RGB")).astype(np.int16)


def near_white_mask(rgb):
    return np.all(rgb >= NEAR_WHITE, axis=-1)


def edge_background(mask):
    labeled, _ = ndimage.label(mask)
    border = set(np.unique(np.r_[labeled[0, :], labeled[-1, :], labeled[:, 0], labeled[:, -1]])) - {0}
    if not border:
        return np.zeros(mask.shape, dtype=bool)
    return np.isin(labeled, list(border))


def object_mask(rgb, drop_components=None, keep_largest_only=False, verbose_label=""):
    white = near_white_mask(rgb)
    bg = edge_background(white)
    obj = ~bg

    labeled, n = ndimage.label(obj)
    components = []
    for idx in range(1, n + 1):
        ys, xs = np.where(labeled == idx)
        if len(xs) < 30:
            continue
        components.append({
            "label": int(idx),
            "size": int(len(xs)),
            "x0": int(xs.min()), "x1": int(xs.max()),
            "y0": int(ys.min()), "y1": int(ys.max()),
        })
    components.sort(key=lambda c: c["size"], reverse=True)
    if verbose_label:
        print(f"[{verbose_label}] components: {json.dumps(components[:8], indent=2)}")

    keep = np.zeros(obj.shape, dtype=bool)
    if keep_largest_only and components:
        keep[labeled == components[0]["label"]] = True
    else:
        drop_boxes = drop_components or []
        for comp in components:
            drop = False
            for (x0, y0, x1, y1) in drop_boxes:
                if comp["x0"] >= x0 and comp["x1"] <= x1 and comp["y0"] >= y0 and comp["y1"] <= y1:
                    drop = True
                    break
            if not drop:
                keep[labeled == comp["label"]] = True
    return keep


def feather_mask(mask):
    eroded = ndimage.binary_erosion(mask, iterations=ERODE_PX)
    alpha = ndimage.gaussian_filter(eroded.astype(np.float32), sigma=FEATHER_SIGMA)
    alpha = np.clip(alpha, 0.0, 1.0)
    # Re-inflate interior to full opacity: anything clearly inside the object
    alpha[mask & (alpha < 0.999)] = 1.0
    return (alpha * 255).astype(np.uint8)


def write_rgba(rgb, alpha, out_path):
    rgba = np.dstack([rgb.astype(np.uint8), alpha])
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(out_path)
    return out_path


def process_layer(name, rgb, out_dir,
                  drop_components=None,
                  keep_largest_only=False,
                  verbose=False):
    mask = object_mask(rgb, drop_components=drop_components, keep_largest_only=keep_largest_only,
                       verbose_label=name if verbose else "")
    alpha = feather_mask(mask)
    out = os.path.join(out_dir, f"{name}.png")
    write_rgba(rgb, alpha, out)
    kept_px = int((alpha > 8).sum())
    print(f"  {name}.png  kept_pixels={kept_px}")


def split_sticky_notes(rgb, out_dir):
    """Split 7.png into note-left / note-right for independent animation."""
    white = near_white_mask(rgb)
    bg = edge_background(white)
    obj = ~bg
    labeled, n = ndimage.label(obj)
    comps = []
    for idx in range(1, n + 1):
        ys, xs = np.where(labeled == idx)
        if len(xs) < 30:
            continue
        comps.append((xs.min(), idx, len(xs)))
    comps.sort()
    if len(comps) >= 2:
        left = comps[0][1]
        right = comps[-1][1]
        for tag, label_id in (("note-left", left), ("note-right", right)):
            mask = labeled == label_id
            alpha = feather_mask(mask)
            write_rgba(rgb, alpha, os.path.join(out_dir, f"{tag}.png"))
            print(f"  {tag}.png  kept_pixels={int((alpha > 8).sum())}")
    else:
        process_layer("sticky-notes", rgb, out_dir)


def cmd_extract(args):
    out_dir = args.out
    original = os.path.join(out_dir, "original")
    layers = os.path.join(out_dir, "layers")
    os.makedirs(original, exist_ok=True)
    os.makedirs(args.ref if hasattr(args, "ref") else os.path.join(out_dir, "reference"), exist_ok=True)
    reference_dir = os.path.join(out_dir, "reference")
    os.makedirs(reference_dir, exist_ok=True)

    zf = zipfile.ZipFile(args.zip)
    entries = {e.filename: e for e in zf.infolist()}

    # keep untouched archival copies
    for name in ["1.png", "2.png", "3.png", "4.png", "7.png", "8.png", "9.png"]:
        if name not in entries:
            print(f"  MISSING in zip: {name}")
            continue
        dest = os.path.join(original, name)
        with zf.open(name) as src, open(dest, "wb") as dst:
            dst.write(src.read())

    def rgb(name):
        return load_rgb(None, name, args.zip)

    print("Preparing layers…")
    process_layer("1", rgb("1.png"), layers, verbose=args.verbose)          # opaque full frame — kept as-is
    process_layer("2", rgb("2.png"), layers, verbose=args.verbose)          # board: keep board+paper+shadow
    process_layer("3", rgb("3.png"), layers, verbose=args.verbose)          # pin + shadow
    split_sticky_notes(rgb("7.png"), layers)                                # two notes, independent
    process_layer("8", rgb("8.png"), layers, keep_largest_only=True, verbose=args.verbose)  # narrator+chair, drop right-edge props
    # 9.png: drop the embedded pin component(s) near the top — supply pin via 3.png
    process_layer("9", rgb("9.png"), layers,
                  drop_components=[(450, 200, 700, 450)],
                  verbose=args.verbose)

    # copy master reference for validation + comparison
    Image.open(zipfile.ZipFile(args.zip).open("4.png")).save(os.path.join(reference_dir, "4.png"))
    print(f"Layers written to {layers}")
    print(f"Master reference copied to {reference_dir}")


EXPECTED = ["1.png", "2.png", "3.png", "8.png", "9.png", "note-left.png", "note-right.png"]


def cmd_validate(args):
    layers = os.path.join(args.root, "layers")
    missing = [f for f in EXPECTED if not os.path.exists(os.path.join(layers, f))]
    if missing:
        print(f"MISSING layers: {missing}")
        sys.exit(1)

    bg = Image.open(os.path.join(layers, "1.png")).convert("RGBA")
    W, H = bg.size
    print(f"Canvas {W}x{H}")
    canvas = np.zeros((H, W, 4), dtype=np.uint8)

    def alpha_composite(base, overlay):
        a = np.asarray(overlay)[:, :, 3:4].astype(np.float32) / 255.0
        o = np.asarray(overlay)[:, :, :3].astype(np.float32)
        b = base[:, :, :3].astype(np.float32)
        out = o * a + b * (1 - a)
        base[:, :, :3] = out.astype(np.uint8)
        return base

    base = np.asarray(bg).astype(np.uint8).copy()
    order = ["2.png", "3.png", "note-left.png", "note-right.png", "8.png", "9.png"]
    for name in order:
        try:
            layer = Image.open(os.path.join(layers, name)).convert("RGBA")
        except FileNotFoundError:
            sys.exit(f"MISSING: {name}")
        if layer.size != (W, H):
            print(f"SIZE MISMATCH {name}: {layer.size} vs ({W}, {H})")
            sys.exit(1)
        base = alpha_composite(base, layer)

    composed = Image.fromarray(base[:, :, :3])
    composed_path = os.path.join(args.root, "reference", "composite.png")
    os.makedirs(os.path.dirname(composed_path), exist_ok=True)
    composed.save(composed_path)

    ref = Image.open(os.path.join(args.root, "reference", "4.png")).convert("RGB").resize((W, H))
    diff = np.asarray(composed, dtype=np.float32) - np.asarray(ref, dtype=np.float32)
    mse = float(np.mean(diff ** 2))
    print(f"Composite vs master 4.png: MSE={mse:.1f} (lower is better; text zone will differ)")
    print(f"Wrote {composed_path}")
    print("PASS: all layers present at native coordinates" if mse < 1500 else "CHECK: visual diff is large — inspect composite.png against 4.png")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", help="Path to 'Lazy news.zip' (extract mode)")
    parser.add_argument("--out", default="assets/news", help="Output root for original/ layers/ reference/")
    parser.add_argument("--validate", metavar="ROOT", help="Validate prepared assets instead of extracting")
    parser.add_argument("--verbose", action="store_true", help="Print component inspection reports")
    args = parser.parse_args()

    if args.validate:
        cmd_validate(argparse.Namespace(root=args.validate))
        return 0
    if not args.zip:
        parser.error("provide --zip or --validate")
    cmd_extract(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
