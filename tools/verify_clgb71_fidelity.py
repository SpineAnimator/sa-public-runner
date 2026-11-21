"""Independently compare every exported PNG with its approved PSD raster layer.
This is NOT a Spine Editor import or a screenshot of a Spine-rendered frame.
"""
import hashlib
import io
import json
import math
import sys
from pathlib import Path
from zipfile import ZipFile

from PIL import Image, ImageChops, ImageDraw, ImageStat
from psd_tools import PSDImage
from psd_tools.constants import Resource

SOURCE_SHA = "7adee866547a3b3cc9838b655cf70865980c5dba00313373cbf903fed776c7b2"

def leaves(group):
    for layer in group:
        if not layer.is_visible():
            continue
        if layer.is_group():
            yield from leaves(layer)
        else:
            yield layer

def _psd_style_metadata(layer):
    """Describe effects omitted by Spine's four slot blend modes.

    A NORMAL layer can still require Photoshop-only layer styles. This is
    read-only evidence, never a request to rewrite original raster PNGs.
    """
    effects = getattr(layer, "effects", None)
    enabled = bool(getattr(effects, "enabled", False))
    active = []
    effects_parameters = []
    if enabled:
        for effect in effects:
            if not getattr(effect, "enabled", False):
                continue
            name = str(getattr(effect, "name", type(effect).__name__))
            active.append(name)
            parameters = {"name": name}
            # Read real Photoshop style values, not a guessed shadow preset.
            # No color raster, proprietary descriptor bytes, or PSD is emitted.
            if name == "DropShadow":
                for key in ("angle", "distance", "size", "opacity", "choke", "noise"):
                    value = getattr(effect, key, None)
                    if isinstance(value, (int, float)) and math.isfinite(value):
                        parameters[key] = round(float(value), 4)
                mode = getattr(effect, "blend_mode", None)
                if mode is not None:
                    parameters["blend_mode"] = (
                        mode.decode("ascii", errors="replace")
                        if isinstance(mode, bytes) else str(getattr(mode, "name", mode)))
            effects_parameters.append(parameters)
    fill = getattr(layer, "fill_opacity", None)
    return {"active_effects": active, "active_effect_parameters": effects_parameters,
            "fill_opacity": fill,
            "has_unrepresented_style": bool(active) or fill not in (None, 255)}


def original_blend_profile(layers):
    """Report Photoshop effects separately from Spine's supported slot blends.

    RGB-preserving original textures do NOT imply Photoshop composite parity,
    especially for smart-object drop shadows and group opacity.
    """
    supported = {"NORMAL", "LINEAR_DODGE", "MULTIPLY", "SCREEN"}
    records = []
    for layer in layers:
        mode = getattr(getattr(layer, "blend_mode", None), "name", "UNKNOWN")
        parent = getattr(layer, "parent", None)
        groups = []
        seen = set()
        while parent is not None and id(parent) not in seen:
            seen.add(id(parent))
            # PSDImage is the document root, not a Photoshop layer group.
            # Counting its UNKNOWN mode as an active group effect falsely
            # labels every leaf as needing baking.
            if (getattr(parent, "is_group", lambda: False)()
                    and not isinstance(parent, PSDImage)):
                group_style = _psd_style_metadata(parent)
                groups.append({"name": getattr(parent, "name", ""),
                               "blend_mode": getattr(getattr(parent, "blend_mode", None), "name", "UNKNOWN"),
                               "opacity": getattr(parent, "opacity", None),
                               **group_style})
            parent = getattr(parent, "parent", None)
        mask = getattr(layer, "has_mask", None)
        has_mask = bool(mask() if callable(mask) else mask)
        style = _psd_style_metadata(layer)
        group_effect = any(g["has_unrepresented_style"] or
                           g["opacity"] not in (None, 255) or
                           g["blend_mode"] not in ("NORMAL", "PASS_THROUGH")
                           for g in groups)
        unsupported = (mode not in supported or style["has_unrepresented_style"]
                       or group_effect or bool(getattr(layer, "clipping", False))
                       or has_mask)
        records.append({"name": layer.name, "blend_mode": mode,
                        "kind": str(getattr(layer, "kind", "unknown")),
                        "opacity": getattr(layer, "opacity", None),
                        "clipping": bool(getattr(layer, "clipping", False)),
                        "has_mask": has_mask, "ancestor_groups": groups,
                        **style,
                        "slot_blend_supported": mode in supported,
                        "photoshop_appearance_requires_baking": unsupported})
    unsupported_blend = [r["name"] for r in records
                         if not r["slot_blend_supported"]]
    unsupported_appearance = [r["name"] for r in records
                              if r["photoshop_appearance_requires_baking"]]
    return {"schema": "clgb71.source-psd-compositing.v1", "layers": records,
            "unsupported_psd_blend_layers": unsupported_blend,
            "source_has_unsupported_slot_blends": bool(unsupported_blend),
            "unsupported_photoshop_compositing_layers": unsupported_appearance,
            "source_has_unsupported_visual_effects": bool(unsupported_appearance),
            "photoshop_compositing_verified_in_spine": False,
            "note": ("A NORMAL/255-opacity leaf may still contain smart-object "
                     "effects such as DropShadow not represented by Spine slots. "
                     "Report them even when every raw PNG is pixel-identical. "
                     "Never claim these effects reproduce Photoshop without "
                     "independent PSD-preview vs licensed Editor pixel parity.")}


def source_color_profile_evidence(psd):
    """Read PSD image-resource metadata without exposing ICC bytes or claiming a cause.

    A saved merged preview may diverge from a fresh layer composite; recording
    its source profile is a diagnostic constraint, never a correction or approval.
    """
    resources = getattr(psd, "image_resources", None)
    profile = resources.get_data(Resource.ICC_PROFILE) if resources is not None else None
    if profile is not None and not isinstance(profile, (bytes, bytearray, memoryview)):
        raise ValueError("Unsupported PSD ICC resource type")
    raw = bytes(profile) if profile is not None else None
    mode = getattr(psd, "color_mode", None)
    return {
        "schema": "clgb71.source-psd-color-resources.v1",
        "color_mode": str(getattr(mode, "name", mode)),
        "bit_depth": getattr(psd, "depth", None),
        "has_saved_merged_preview": bool(getattr(psd, "has_preview", lambda: False)()),
        "has_embedded_icc_profile": raw is not None,
        "icc_profile_bytes": len(raw) if raw is not None else 0,
        "icc_profile_sha256": hashlib.sha256(raw).hexdigest() if raw is not None else None,
        "icc_transform_causality_proven": False,
        "saved_preview_color_truth_approved": False,
        "note": ("Profile presence or absence is diagnostic only; Photoshop preview, "
                 "layer recomposition and native Spine render must be compared.")
    }

def measure_style_footprints(original, recomposed, layers):
    """Measure whether Photoshop's differences actually fall near styled layers.

    Regions are only bounded suspects, NOT a recreation of the effects.
    RGB differences are measured against a common backing, and original
    rasters / silhouettes / source hashes are never edited.
    """
    if original.size != recomposed.size:
        raise ValueError("Cannot compare two differently sized Photoshop references")
    mask = Image.new("L", original.size, 0)
    draw = ImageDraw.Draw(mask)
    candidates = []
    for layer in layers:
        style = _psd_style_metadata(layer)
        shadows = [e for e in style["active_effect_parameters"]
                   if e["name"] == "DropShadow"]
        if not shadows:
            continue
        # Approximate the effect's MAX footprint, not its pixel alpha/color.
        # Photoshop's contour and global-light handling remain independent.
        reach = max(math.ceil(e.get("distance", 0) + e.get("size", 0) + 3)
                    for e in shadows)
        box = (max(0, int(layer.left) - reach),
               max(0, int(layer.top) - reach),
               min(original.width, int(layer.right) + reach),
               min(original.height, int(layer.bottom) + reach))
        if box[2] <= box[0] or box[3] <= box[1]:
            continue
        draw.rectangle((box[0], box[1], box[2]-1, box[3]-1), fill=255)
        candidates.append({"name": layer.name, "expanded_xyxy": list(box),
                           "shadow_reach_estimate_px": reach,
                           "shadow_parameters": shadows})
    background = Image.new("RGBA", original.size, "#242735")
    a = Image.alpha_composite(background, original.convert("RGBA")).convert("RGB")
    b = Image.alpha_composite(background, recomposed.convert("RGBA")).convert("RGB")
    diff = ImageChops.difference(a, b)
    inv = ImageChops.invert(mask)
    total = sum(ImageStat.Stat(diff).sum)
    inside = sum(ImageStat.Stat(diff, mask).sum)
    outside = sum(ImageStat.Stat(diff, inv).sum)
    if abs(total - inside - outside) > 0.01:
        raise ValueError("Effect mismatch totals are not conserved")
    covered = mask.histogram()[255]
    total_pixels = original.width * original.height
    outside_pixels = inv.histogram()[255]
    fully_opaque = ImageChops.darker(
        original.getchannel("A").point(lambda v: 255 if v == 255 else 0),
        recomposed.getchannel("A").point(lambda v: 255 if v == 255 else 0))
    opaque_outside = ImageChops.darker(fully_opaque, inv)
    opaque_pixels = opaque_outside.histogram()[255]
    opaque_error = sum(ImageStat.Stat(diff, opaque_outside).sum)
    # Diagnose broad opaque RGB changes separately from alpha filtering.
    # Hotspot tiles guide source investigation; they are not effect repairs.
    hotspots = []
    for gy in range(6):
        y0 = original.height * gy // 6
        y1 = original.height * (gy + 1) // 6
        for gx in range(6):
            x0 = original.width * gx // 6
            x1 = original.width * (gx + 1) // 6
            roi = (x0, y0, x1, y1)
            region = inv.crop(roi)
            count = region.histogram()[255]
            # Scale the minimum sample to small unit-test canvases instead
            # of requiring 64 pixels in a six-by-six tile of <64 pixels.
            minimum = min(64, max(1, ((x1 - x0) * (y1 - y0)) // 4))
            if count < minimum:
                continue
            err = sum(ImageStat.Stat(diff.crop(roi), region).sum)
            hotspots.append({"grid_xy": [gx, gy],
                             "pixel_bounds_xyxy": list(roi),
                             "outside_shadow_pixels": count,
                             "rgb_mae_255": round(err / (3 * count), 4),
                             "fraction_of_outside_rgb_error":
                                 round(err / outside, 6) if outside else 0.0})
    hotspots.sort(key=lambda item: (-item["rgb_mae_255"],
                                   item["grid_xy"][1], item["grid_xy"][0]))
    return {"schema": "clgb71.photoshop-effect-locality.v1",
            "effect_regions": candidates,
            "covered_pixels": covered,
            "covered_fraction": round(covered / total_pixels, 6),
            "rgb_abs_error_inside": round(inside, 2),
            "rgb_abs_error_outside": round(outside, 2),
            "inside_share_of_total_rgb_error":
                round(inside / total, 6) if total else 0.0,
            "outside_share_of_total_rgb_error":
                round(outside / total, 6) if total else 0.0,
            "outside_rgb_mae_255":
                round(outside / (3 * outside_pixels), 4)
                if outside_pixels else None,
            "outside_fully_opaque_pixels": opaque_pixels,
            "outside_fully_opaque_rgb_mae_255":
                round(opaque_error / (3 * opaque_pixels), 4)
                if opaque_pixels else None,
            "top_outside_shadow_hotspots": hotspots[:8],
            "out_of_effect_footprint_error_present": outside > 0,
            "shadow_causality_proven": False,
            "photoshop_parity_proven": False}


def run(psd_path: Path, zip_path: Path, output_dir: Path):
    output_dir.mkdir(parents=True, exist_ok=True)
    raw = psd_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCE_SHA:
        raise ValueError("Wrong PSD hash; cannot approve artwork")
    psd = PSDImage.open(psd_path)
    if (psd.width, psd.height) != (918, 657):
        raise ValueError("Wrong PSD dimensions")
    layers = list(leaves(psd))
    if len(layers) != 38:
        raise ValueError("Expected exactly 38 visible leaves")

    records = []
    with ZipFile(zip_path) as archive:
        if archive.testzip() is not None:
            raise ValueError("ZIP CRC failed")
        skel = json.loads(archive.read("skeleton.json"))
        if skel["skeleton"]["spine"] != "4.3.26":
            raise ValueError("Wrong Spine data version")
        if [s["name"] for s in skel["slots"]] != [l.name for l in layers]:
            raise ValueError("PSD draw order was changed")
        if set(skel.get("animations", {})) != {"shoot_up_01", "shoot_up_02"}:
            raise ValueError("Animation inventory changed")
        if len(skel.get("constraints", [])) != 2:
            raise ValueError("Two IK constraints are missing")
        composite = Image.new("RGBA", (psd.width, psd.height))
        for idx, layer in enumerate(layers):
            source = layer.composite()
            if source is None or source.size != (layer.width, layer.height):
                raise ValueError("Missing or cropped PSD layer: " + layer.name)
            reference = source.convert("RGBA")
            filename = "images/" + layer.name + ".png"
            with Image.open(io.BytesIO(archive.read(filename))) as png:
                png.load()
                exported = png.convert("RGBA")
            if reference.size != exported.size or reference.tobytes() != exported.tobytes():
                raise ValueError("PSD pixel mismatch in layer " + layer.name)
            positioned = Image.new("RGBA", composite.size)
            positioned.paste(exported, (int(layer.left), int(layer.top)))
            composite = Image.alpha_composite(composite, positioned)
            records.append({
                "index": idx, "name": layer.name,
                "bounds": [int(layer.left), int(layer.top), int(layer.width), int(layer.height)],
                "pixel_identical": True,
                "png_sha256": hashlib.sha256(archive.read(filename)).hexdigest()
            })
    blend_profile = original_blend_profile(layers)
    color_profile = source_color_profile_evidence(psd)
    (output_dir / "source-psd-compositing-profile.json").write_text(
        json.dumps(blend_profile, indent=2) + "\n", encoding="utf-8")
    (output_dir / "source-psd-color-resources.json").write_text(
        json.dumps(color_profile, indent=2) + "\n", encoding="utf-8")
    # PSDImage.composite() may use the saved Photoshop merged preview.
    # Re-rendering the layers ourselves distinguishes a stale/differently
    # color-managed PSD projection from an error in the source PNG or Spine.
    # Both are read-only reference evidence; neither alters original artwork.
    original_composite = psd.composite().convert("RGBA")
    try:
        recomposited = psd.composite(ignore_preview=True).convert("RGBA")
    except TypeError:  # Legacy psd-tools versions still support forced render.
        recomposited = psd.composite(force=True).convert("RGBA")
    if recomposited.size != original_composite.size:
        raise ValueError("PSD saved-preview vs recomposition canvas mismatch")
    original_composite.save(output_dir / "source-psd-composite.png")
    recomposited.save(output_dir / "source-psd-recomputed-from-layers.png")
    composite.save(output_dir / "exported-layer-composite-approx.png")
    # Compare visibly, without pretending that naive alpha compositing reproduces
    # Photoshop layer blend modes, masks or the native Spine Editor renderer.
    flat=lambda im: Image.alpha_composite(Image.new("RGBA", im.size, "#242735"), im).convert("RGB")
    diff=ImageChops.difference(flat(original_composite), flat(composite))
    diff.save(output_dir / "source-vs-alpha-overlay-diff.png")
    stats=ImageStat.Stat(diff)
    # Differences are measured over an identical dark background; this is
    # explicitly not a native Editor pixel comparison or artistic approval.
    preview_vs_recomposed = ImageStat.Stat(
        ImageChops.difference(flat(original_composite), flat(recomposited)))
    recomposed_vs_alpha = ImageStat.Stat(
        ImageChops.difference(flat(recomposited), flat(composite)))
    style_footprints = measure_style_footprints(original_composite, recomposited, layers)
    (output_dir / "psd-effect-footprints.json").write_text(
        json.dumps(style_footprints, indent=2) + "\n", encoding="utf-8")
    print("PSD_EFFECT_MISMATCH_LOCALITY", json.dumps({
        "region_count": len(style_footprints["effect_regions"]),
        "inside_share": style_footprints["inside_share_of_total_rgb_error"],
        "outside_abs_error": style_footprints["rgb_abs_error_outside"],
        "outside_share": style_footprints["outside_share_of_total_rgb_error"],
        "outside_opaque_rgb_mae": style_footprints["outside_fully_opaque_rgb_mae_255"],
        "top_nonshadow_hotspots": style_footprints["top_outside_shadow_hotspots"][:3],
        "parity_proven": False
    }, sort_keys=True))
    # A loose visual-regression guard for this exact, hash-pinned PSD.
    # The remaining difference is expected from Photoshop blend modes/effects.
    if max(stats.mean) > 25:
        raise ValueError("Source composite diverges from ordered source PNG overlays")
    report={
        "source_sha256": SOURCE_SHA,
        "source_canvas": [psd.width, psd.height],
        "raster_layer_pixels_identical": len(records) == 38,
        "verified_layer_count": len(records),
        "draw_order_identical": True,
        "layer_details": sorted(records, key=lambda r:r["index"]),
        "source_vs_simple_alpha_composite_rgb_mae": [round(n,3) for n in stats.mean],
        "simple_alpha_composite_is_approximate": True,
        "source_composite_alpha_proxy_guard_passed": True,
        "source_composite_proxy_rgb_threshold": 25,
        "source_psd_compositing_profile": "source-psd-compositing-profile.json",
        "source_effect_footprint_report": "psd-effect-footprints.json",
        "source_psd_color_resources": "source-psd-color-resources.json",
        "has_embedded_icc_profile": color_profile["has_embedded_icc_profile"],
        "icc_transform_causality_proven": False,
        "source_has_embedded_merged_preview": bool(getattr(psd, "has_preview", lambda: False)()),
        "psd_saved_preview_vs_forced_recomposite_rgb_mae":
            [round(v, 3) for v in preview_vs_recomposed.mean],
        "forced_recomposite_vs_plain_alpha_overlay_rgb_mae":
            [round(v, 3) for v in recomposed_vs_alpha.mean],
        "forced_recomposite_png": "source-psd-recomputed-from-layers.png",
        "forced_recomposite_is_original_photoshop_approved": False,
        "unsupported_source_psd_slot_blends": blend_profile["unsupported_psd_blend_layers"],
        "photoshop_blend_verified_in_native_editor": False,
        "editor_4_3_26_import_verified": False,
        "spine_render_approved": False,
        "artistic_quality_approved": False
    }
    (output_dir / "fidelity-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print("PSD_LAYER_PIXEL_FIDELITY", json.dumps({
        "layers": len(records), "pixels_identical": True,
        "editor_import_verified": False, "spine_render_approved": False
    }))

if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: verify_clgb71_fidelity.py source.psd import.zip output-dir")
    run(*(Path(v) for v in sys.argv[1:]))
