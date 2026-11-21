#!/usr/bin/env python3
"""PSD raster decode ONLY. NEVER generate animation, rig, motion or ZIP here.

Exact original clgb71.psd → 38 unmodified composited leaf-layer PNGs and
a SHA-256 receipt. Rust/JS owns skeletons, animation keys and ZIP packaging.
"""
from __future__ import annotations
import hashlib
import io
import json
from pathlib import Path
import sys
from PIL import Image
from psd_tools import PSDImage

SOURCE_HASH = "7adee866547a3b3cc9838b655cf70865980c5dba00313373cbf903fed776c7b2"
SOURCE_BYTES = 4_485_543

def leaves(psd):
    for layer in psd:
        if not layer.is_visible():
            continue
        if layer.is_group():
            yield from leaves(layer)
        else:
            yield layer

def extract(psd_path: Path, manifest_path: Path, output: Path):
    payload = psd_path.read_bytes()
    if len(payload) != SOURCE_BYTES or hashlib.sha256(payload).hexdigest() != SOURCE_HASH:
        raise ValueError("Original 38-layer PSD bytes/hash are not approved")
    if payload[:6] != b"8BPS\x00\x01" or payload[6:12] != bytes(6):
        raise ValueError("Malformed standard PSD header")
    manifest = json.loads(manifest_path.read_text(encoding="utf8"))
    if (manifest.get("source_sha256") != SOURCE_HASH or
            manifest.get("source_bytes") != SOURCE_BYTES or
            manifest.get("canvas") != {"width": 918, "height": 657}):
        raise ValueError("Source-derived layer manifest does not match approved PSD")
    psd = PSDImage.open(psd_path)
    if psd.size != (918, 657):
        raise ValueError("Source canvas dimensions changed")
    layers = list(leaves(psd))
    if len(layers) != 38 or len(manifest.get("layers", [])) != 38:
        raise ValueError("Expected exactly 38 visible leaf layers")
    images = output / "images"
    if images.exists() and any(images.iterdir()):
        raise ValueError("PSD image output must be empty")
    images.mkdir(parents=True, exist_ok=True)
    textures = {}
    for n, (layer, record) in enumerate(zip(layers, manifest["layers"], strict=True)):
        name = layer.name
        if (name != record["name"] or record["order"] != n or
                (int(layer.left), int(layer.top), int(layer.width), int(layer.height)) !=
                (record["left"], record["top"], record["width"], record["height"])):
            raise ValueError("Layer name/order/geometry changed at index " + str(n))
        if not name or not all(c.isascii() and (c.isalnum() or c in "-_") for c in name):
            raise ValueError("Unsafe PNG filename")
        image = layer.composite()
        if image is None or image.size != (record["width"], record["height"]):
            raise ValueError("PSD layer has no original raster pixels: " + name)
        rgba = image.convert("RGBA")
        pixel_hash = hashlib.sha256(rgba.tobytes()).hexdigest()
        buffer = io.BytesIO()
        rgba.save(buffer, format="PNG")
        png = buffer.getvalue()
        with Image.open(io.BytesIO(png)) as roundtrip:
            if hashlib.sha256(roundtrip.convert("RGBA").tobytes()).hexdigest() != pixel_hash:
                raise ValueError("PNG pixel fidelity check failed: " + name)
        (images / (name + ".png")).write_bytes(png)
        textures[name] = {
            "sha256": hashlib.sha256(png).hexdigest(),
            "pixel_sha256": pixel_hash,
            "width": rgba.width, "height": rgba.height,
            "source_order": n,
        }
    receipt = {
        "purpose": "PSD raster extraction ONLY — NO rig, keyframes, animation or ZIP",
        "source_sha256": SOURCE_HASH,
        "source_bytes": SOURCE_BYTES,
        "canvas": [918, 657], "visible_source_layers": len(layers),
        "textures": textures,
    }
    (output / "psd-extraction-receipt.json").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf8")
    print("PSD_RASTER_ONLY_VALIDATED", json.dumps({
        "source_sha256": SOURCE_HASH, "layers": len(layers),
        "animation_generated_by_python": False, "zip_created_by_python": False
    }))
    return receipt

if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: extract_clgb71_layers.py original.psd approved-layer-manifest.json output-dir")
    extract(*(Path(s) for s in sys.argv[1:]))
