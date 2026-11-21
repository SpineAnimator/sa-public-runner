#!/usr/bin/env python3
"""Derive Photoshop-preview-matched RGB textures without changing original PSD/PNG assets.

Only SOURCE RGB is optimized: alpha, geometry, 38-slot order and IK stay intact.
The derived PNGs are an *optional candidate*, NEVER automatically approved as
Photoshop-accurate in licensed Spine Editor. Original raster ZIP remains immutable.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageStat
from psd_tools import PSDImage

EXPECTED_PSD_SHA = "7adee866547a3b3cc9838b655cf70865980c5dba00313373cbf903fed776c7b2"
CANVAS = (918, 657)
BACKGROUND = (36, 39, 53)


def compose(images, order):
    """Reference-normal alpha-over with the exact PSD layer rectangles."""
    result = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    for i in order:  # painter order, back to front
        result = Image.alpha_composite(result, Image.fromarray(images[i], "RGBA"))
    return result


def with_background(im):
    bg = Image.new("RGBA", im.size, (*BACKGROUND, 255))
    return Image.alpha_composite(bg, im.convert("RGBA")).convert("RGB")


def rgb_score(a, b):
    d = ImageChops.difference(with_background(a), with_background(b))
    return sum(ImageStat.Stat(d).mean) / 3


def original_layers(psd, source_folder):
    """Only verified leaf PNGs, including out-of-canvas bounds; never use an invented fixture."""
    layers = []
    def walk(container):
        for item in container:
            if not item.is_visible():
                continue
            if item.is_group():
                walk(item)
            else:
                layers.append(item)
    walk(psd)
    if len(layers) != 38:
        raise ValueError("Not the 38-layer original PSD")
    result = []
    hashes = {}
    w, h = CANVAS
    for layer in layers:
        name = layer.name
        file = source_folder / (name + ".png")
        if not file.is_file():
            raise ValueError("Original layer PNG is missing: " + name)
        raw = file.read_bytes()
        hashes[name] = hashlib.sha256(raw).hexdigest()
        with Image.open(file) as image:
            im = image.convert("RGBA")
        if im.size != (layer.width, layer.height):
            raise ValueError("Layer geometry differs from original: " + name)
        # PSD coordinates may extend beyond the canvas (for example /glow).
        array = np.zeros((h, w, 4), dtype=np.uint8)
        x0, y0 = max(0, layer.left), max(0, layer.top)
        x1, y1 = min(w, layer.right), min(h, layer.bottom)
        if x1 > x0 and y1 > y0:
            arr = np.asarray(im)
            array[y0:y1, x0:x1] = arr[y0-layer.top:y1-layer.top,
                                      x0-layer.left:x1-layer.left]
        result.append(array)
    return layers, result, hashes


def metrics(reference, candidate):
    ref, out = reference.convert("RGBA"), candidate.convert("RGBA")
    if ref.size != out.size:
        raise ValueError("Different composite canvas dimensions")
    visible = np.minimum(np.asarray(ref.getchannel("A")),
                         np.asarray(out.getchannel("A"))) > 127
    if visible.sum() < 100:
        raise ValueError("Not enough visible source pixels")
    delta = np.abs(np.asarray(ref.convert("RGB")).astype(np.int16) -
                   np.asarray(out.convert("RGB")).astype(np.int16))
    return {
        "rgb_mae_255": round(float(delta[visible].mean()), 4),
        "visible_fraction_any_channel_diff_gt20":
            round(float((delta[visible].max(axis=-1) > 20).mean()), 6),
        "alpha_mae_255": round(float(np.abs(
            np.asarray(ref.getchannel("A")).astype(np.int16) -
            np.asarray(out.getchannel("A")).astype(np.int16)).mean()), 4),
        "visibly_compared_pixels": int(visible.sum()),
        "rgb_on_fixed_background_mae_255": round(rgb_score(ref, out), 4)
    }


def solve_rgb(layers_u8, order, preview, *, iterations=12):
    """Constrained least-change inverse of normal alpha compositing.

    For each canvas pixel, a composited RGB channel is a linear combination
    sum_i effective_alpha_i * source_rgb_i + uncovered * background.
    Solve for modified source RGB with the SAME per-layer alpha. When clipping
    or alpha divergence makes exact parity impossible, explicitly report it.
    """
    layers = np.stack(layers_u8, axis=0)
    colors = layers[..., :3].astype(np.float32)
    alphas = layers[..., 3].astype(np.float32) / 255
    h, w = alphas.shape[1:]
    weights = np.empty_like(alphas)
    remainder = np.ones((h, w), dtype=np.float32)
    for i in reversed(order):
        weights[i] = alphas[i] * remainder
        remainder *= 1 - alphas[i]
    # Match a known common opaque backing so semi-transparent source pixels
    # cannot be mistaken for the same RGB on a transparent background.
    bg = np.asarray(BACKGROUND, dtype=np.float32)
    target = np.asarray(with_background(preview), dtype=np.float32)
    current = np.einsum("nhw,nhwc->hwc", weights, colors) + remainder[..., None] * bg
    start = float(np.mean(np.abs(target-current)))
    for _ in range(iterations):
        residual = target - current
        if float(np.max(np.abs(residual))) < 0.45:
            break
        for channel in range(3):
            d = residual[..., channel]
            # A clipped channel cannot be pushed further in that direction.
            available = ((d >= 0)[None, ...] & (colors[..., channel] < 254.999) |
                         (d < 0)[None, ...] & (colors[..., channel] > 0.001))
            direction = weights * available
            denom = np.sum(direction * direction, axis=0)
            step = np.divide(d, denom, out=np.zeros_like(d), where=denom > 1e-8)
            colors[..., channel] = np.clip(
                colors[..., channel] + direction * step[None, ...], 0, 255)
        current = np.einsum("nhw,nhwc->hwc", weights, colors) + remainder[..., None] * bg
    finished = layers.copy()
    finished[..., :3] = np.rint(colors).astype(np.uint8)
    # Keep untouched pixels / zero-alpha data binary-identical to source.
    finished[..., :3] = np.where(layers[..., 3:4] == 0,
                                 layers[..., :3], finished[..., :3])
    return finished, {"initial_float_background_mae": round(start, 4),
                      "final_float_background_mae":
                          round(float(np.mean(np.abs(target-current))), 4),
                      "iteration_limit": iterations}


def run(psd_file: Path, original_images: Path, output: Path):
    if hashlib.sha256(psd_file.read_bytes()).hexdigest() != EXPECTED_PSD_SHA:
        raise ValueError("PSD hash differs from original clgb71 source")
    psd = PSDImage.open(psd_file)
    if psd.size != CANVAS:
        raise ValueError("Original PSD canvas size differs")
    original = psd.composite().convert("RGBA")
    try:
        forced = psd.composite(ignore_preview=True).convert("RGBA")
    except TypeError:
        forced = psd.composite(force=True).convert("RGBA")
    original_records, raster, source_hashes = original_layers(psd, original_images)
    forward = list(range(len(raster)))
    backward = list(reversed(forward))
    score_forward = rgb_score(compose(raster, forward), forced)
    score_backward = rgb_score(compose(raster, backward), forced)
    if min(score_forward, score_backward) > 2.0:
        raise ValueError("Extracted PNG overlays do not reproduce forced PSD layer composite")
    painter = forward if score_forward < score_backward else backward
    baseline = compose(raster, painter)
    before = metrics(original, baseline)
    output.mkdir(parents=True, exist_ok=True)
    corrected, optimization = solve_rgb(raster, painter, original)
    after_composite = compose(corrected, painter)
    after = metrics(original, after_composite)
    # The original source layer pixel identity is a hard invariant, even when
    # the derived appearance candidate cannot reach Photoshop parity.
    if any(hashlib.sha256((original_images/(name+".png")).read_bytes()).hexdigest() != digest
           for name, digest in source_hashes.items()):
        raise ValueError("Original Photoshop source PNGs were changed")
    # Avoid claiming an improved candidate if the target cannot be reached.
    improved = (after["rgb_mae_255"] < before["rgb_mae_255"] and
                after["rgb_on_fixed_background_mae_255"] <
                before["rgb_on_fixed_background_mae_255"])
    if not improved:
        raise ValueError("Color inversion did not improve source preview parity")
    candidate = output / "derived-images"
    candidate.mkdir(exist_ok=True)
    # Preserve original PNG boundaries and original alpha; only RGB changes.
    for i, layer in enumerate(original_records):
        with Image.open(original_images/(layer.name+".png")) as im:
            src = np.asarray(im.convert("RGBA")).copy()
        x0, y0 = max(0, layer.left), max(0, layer.top)
        x1, y1 = min(CANVAS[0], layer.right), min(CANVAS[1], layer.bottom)
        if x1 > x0 and y1 > y0:
            src[y0-layer.top:y1-layer.top, x0-layer.left:x1-layer.left, :3] = (
                corrected[i, y0:y1, x0:x1, :3])
        Image.fromarray(src, "RGBA").save(candidate/(layer.name+".png"))
    report = {
        "schema": "2spine.psd-source-rgb-inverse-candidate.v1",
        "source_sha256": EXPECTED_PSD_SHA,
        "unmodified_original_layers": 38,
        "painter_order": "PSD_listing" if painter == forward else "reversed_PSD_listing",
        "order_check_rgb_mae": {"forward": round(score_forward, 4),
                                "reverse": round(score_backward, 4)},
        "baseline": before, "candidate": after, "optimizer": optimization,
        "original_png_sha256": source_hashes,
        "derived_png_directory": "derived-images",
        "source_original_pngs_unchanged": True,
        "derived_raster_rgb_only": True,
        "candidate_source_gate_pass": (
            after["rgb_mae_255"] <= 3.0 and after["alpha_mae_255"] <= 2.0 and
            after["visible_fraction_any_channel_diff_gt20"] <= 0.05),
        "native_editor_parity_proven": False,
        "artistic_quality_approved": False,
        "release_ready": False
    }
    (output/"color-inversion-report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True)+"\n", encoding="utf-8")
    print("PSD_RGB_INVERSION_CANDIDATE", json.dumps({
        "painter_order": report["painter_order"], "baseline": before,
        "candidate": after, "source_gate_pass": report["candidate_source_gate_pass"],
        "native_editor_parity_proven": False, "artistic_quality_approved": False
    }, sort_keys=True))
    return report


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("source_psd", type=Path)
    p.add_argument("original_image_folder", type=Path)
    p.add_argument("output_folder", type=Path)
    args = p.parse_args()
    run(args.source_psd, args.original_image_folder, args.output_folder)
