"""Inspect the new user-provided zombie-with-pistol PSD without publishing its contents.
Full byte download required; protects against HTTP 200 with zero bytes.
"""
import hashlib
import math
import json
import os
import struct
from urllib.request import Request, urlopen
from urllib.parse import quote
from psd_tools import PSDImage
from pathlib import Path

URL = "https://files.catbox.moe/clgb71.psd"
TARGET = Path(os.environ.get("PSD_TEMP_FILE", "/tmp/zombie-pistol.psd"))
LIMIT = 180 * 1024 * 1024
EXPECTED_SHA256 = "7adee866547a3b3cc9838b655cf70865980c5dba00313373cbf903fed776c7b2"
EXPECTED_BYTES = 4_485_543
EXPECTED_DIMENSIONS = (918, 657)
EXPECTED_VISIBLE_LAYERS = 38
REQUIRED_LAYER_NAMES = frozenset(
    ("pistol", "pistol--front", "finger", "hand-right", "torso", "face", "Eyes", "Sombrero")
)


def assert_source_contract(digest, size, width, height, layers):
    """Fail closed when the public URL points at different artwork.

    Metadata checks are additional guards, not substitutes for the full SHA-256.
    """
    if digest != EXPECTED_SHA256:
        raise ValueError("clgb71.psd SHA-256 differs from the approved original")
    if size != EXPECTED_BYTES:
        raise ValueError("clgb71.psd byte size differs from the approved original")
    if (width, height) != EXPECTED_DIMENSIONS:
        raise ValueError("clgb71.psd canvas dimensions differ from approved source")
    visible = [layer for layer in layers if layer["visible"] and not layer["group"]]
    if len(visible) != EXPECTED_VISIBLE_LAYERS:
        raise ValueError("clgb71.psd visible raster layer count differs from approved source")
    names = {layer["name"].rsplit("/", 1)[-1] for layer in visible}
    missing = REQUIRED_LAYER_NAMES - names
    if missing:
        raise ValueError("clgb71.psd required original layers missing: " + ", ".join(sorted(missing)))

def main():
    # Only exact, SHA-pinned clgb71 bytes are accepted. The Cloudflare KV entry
    # was previously populated from the original source via GitHub OIDC; it is
    # not a test fixture, and every byte is independently reverified here.
    cache = ("https://spine-psd-cache.spine-animator-f8692224.workers.dev"
             "/api/psd-source?url=" + quote(URL, safe=""))
    generator = ("https://spine-generator.spine-animator-f8692224.workers.dev"
                 "/api/psd-source?url=" + quote(URL, safe=""))
    routes = (("catbox-origin", URL), ("oidc-verified-kv", cache),
              ("cloudflare-generator", generator))
    if os.environ.get("PSD_FORCE_VERIFIED_CACHE") == "1":
        routes = routes[1:]  # CI fault injection: never use the Catbox origin
    payload = None
    selected = None
    failures = []
    for label, endpoint in routes:
        try:
            request = Request(endpoint, headers={
                "User-Agent": "2Spine-PSD-Verifier/1.4.5",
                "Accept-Encoding": "identity",
                "Accept": "application/octet-stream",
                "Origin": "https://spineanimator.github.io",
            })
            with urlopen(request, timeout=15) as response:
                if response.status != 200 or response.geturl() != endpoint:
                    raise ValueError("Non-200 status or unexpected redirect")
                if any(t in response.headers.get("Content-Type", "").lower()
                       for t in ("text/html", "application/json", "application/xml")):
                    raise ValueError("Response is not PSD bytes")
                declared = response.headers.get("Content-Length")
                if declared is not None and (
                    not declared.isdecimal() or int(declared) != EXPECTED_BYTES
                ):
                    raise ValueError("Wrong Content-Length: " + str(declared))
                if label == "oidc-verified-kv":
                    if (response.headers.get("X-PSD-SHA256") != EXPECTED_SHA256 or
                            response.headers.get("X-PSD-Bytes") != str(EXPECTED_BYTES)):
                        raise ValueError("KV provenance headers mismatch")
                parts = []
                received = 0
                while part := response.read(65536):
                    received += len(part)
                    if received > EXPECTED_BYTES:
                        raise ValueError("PSD body exceeds approved size")
                    parts.append(part)
            candidate = b"".join(parts)
            digest = hashlib.sha256(candidate).hexdigest()
            if len(candidate) != EXPECTED_BYTES or digest != EXPECTED_SHA256:
                raise ValueError("PSD full-body size/SHA-256 mismatch")
            if candidate[:6] != b"8BPS\x00\x01" or candidate[6:12] != bytes(6):
                raise ValueError("PSD magic/version invalid")
            payload, selected = candidate, label
            print("PSD_SOURCE_ROUTE_VERIFIED", label, len(candidate), digest)
            break
        except Exception as error:
            failures.append(label + ": " + str(error)[:160])
            print("PSD_SOURCE_ROUTE_FAILED", label, str(error)[:160])
    if payload is None:
        raise RuntimeError("Full original clgb71 PSD unavailable via all approved routes: " +
                           "; ".join(failures))
    downloaded = len(payload)
    sha = hashlib.sha256(payload)
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    partial = TARGET.with_name(TARGET.name + ".partial")
    try:
        partial.write_bytes(payload)
        os.replace(partial, TARGET)
    finally:
        partial.unlink(missing_ok=True)
    with TARGET.open("rb") as f:
        header = f.read(26)
    channels, height, width, depth, color = struct.unpack(">HIIHH", header[12:])
    if not (0 < channels <= 56 and 0 < height <= 30000 and
            0 < width <= 30000 and depth in (1, 8, 16, 32)):
        raise ValueError("Unsupported PSD geometry")
    psd = PSDImage.open(TARGET)
    layers = []
    def walk(group, parent=""):
        for layer in group:
            label = (parent + "/" + layer.name)[:220]
            layers.append({
                "name":label,"group":bool(layer.is_group()),"visible":bool(layer.is_visible()),
                "box":[int(layer.left),int(layer.top),int(layer.width),int(layer.height)]
            })
            if layer.is_group():
                walk(layer,label)
    walk(psd)
    assert_source_contract(sha.hexdigest(), downloaded, width, height, layers)
    # Derived geometry only. Created AFTER validating the full approved PSD hash;
    # never store or upload the original PSD or its raster pixels as a test fixture.
    manifest_path = os.environ.get("PSD_LAYER_MANIFEST")
    if manifest_path:
        visible = [layer for layer in layers if layer["visible"] and not layer["group"]]
        manifest = {
            "source_url": URL, "source_sha256": sha.hexdigest(),
            "source_bytes": downloaded, "retrieval_route": selected, "canvas": {"width": width, "height": height},
            "layers": [
                {
                    "name": layer["name"].rsplit("/", 1)[-1],
                    "left": layer["box"][0], "top": layer["box"][1],
                    "width": layer["box"][2], "height": layer["box"][3],
                    "order": index
                }
                for index, layer in enumerate(visible)
            ],
            "contains_source_pixels": False,
        }
        output = Path(manifest_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("VERIFIED_LAYER_MANIFEST", output, len(visible))
    # Photoshop layer effects and fill opacity are independent from blendMode.
    # A PSD can contain 38 NORMAL/255-opacity leaves and still render very
    # differently from a plain alpha overlay. Inspect metadata only: no source
    # PSD, pixels, or confidential layer descriptors are uploaded by this step.
    complex_layers = []
    visible_kinds = {}
    def inspect_compositing(group):
        for item in group:
            if not item.is_visible():
                continue
            kind = str(getattr(item, "kind", "unknown"))
            visible_kinds[kind] = visible_kinds.get(kind, 0) + 1
            active = []
            effect_descriptors = []
            effects = getattr(item, "effects", None)
            if effects is not None and getattr(effects, "enabled", False):
                for e in effects:
                    if not getattr(e, "enabled", False):
                        continue
                    name = str(getattr(e, "name", type(e).__name__))
                    active.append(name)
                    details = {"name": name}
                    if name == "DropShadow":
                        for key in ("angle", "distance", "size", "opacity", "choke", "noise"):
                            value = getattr(e, key, None)
                            if isinstance(value, (float, int)) and math.isfinite(value):
                                details[key] = round(float(value), 4)
                        mode = getattr(e, "blend_mode", None)
                        if mode is not None:
                            details["blend_mode"] = (
                                mode.decode("ascii", "replace") if isinstance(mode, bytes)
                                else str(getattr(mode, "name", mode)))
                    effect_descriptors.append(details)
            fill_opacity = getattr(item, "fill_opacity", 255)
            if active or fill_opacity not in (None, 255):
                complex_layers.append({
                    "name": item.name, "kind": kind, "is_group": bool(item.is_group()),
                    "active_effects": active, "active_effect_parameters": effect_descriptors,
                    "fill_opacity": fill_opacity
                })
            if item.is_group():
                inspect_compositing(item)
    inspect_compositing(psd)
    print("PSD_PHOTOSHOP_EFFECTS_PROFILE", json.dumps({
        "visible_kinds": visible_kinds, "complex_layer_count": len(complex_layers),
        "complex_layers": complex_layers, "source_psd_sha256": sha.hexdigest(),
        "artistic_approval": False
    }, ensure_ascii=False, sort_keys=True))
    print("PSD_REPORT", json.dumps({
        "bytes":downloaded,"sha256":sha.hexdigest(),"width":width,"height":height,
        "channels":channels,"depth":depth,"color_mode":color,
        "layer_count":len(layers),"visible_leaf_count":sum(x["visible"] and not x["group"] for x in layers),
        "layers":layers[:100]
    },ensure_ascii=False))
    if not layers:
        raise ValueError("PSD has no layers")
    print("VERIFIED_FULL_ZOMBIE_PSD", downloaded)

if __name__ == "__main__":
    main()
