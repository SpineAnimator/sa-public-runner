#!/usr/bin/env python3
"""Fail-closed native Spine 4.3.26 Linux CLI import, roundtrip and rendered-frame gate.

A successful runtime parser is not an Editor import. This script requires Spine.sh.
Artistic approval remains a separate human decision; render evidence is mandatory.
"""
import argparse
from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile

from PIL import Image

APPROVED_SOURCE_SHA256 = "7adee866547a3b3cc9838b655cf70865980c5dba00313373cbf903fed776c7b2"
REQUIRED_CLIPS = {"shoot_up_01", "shoot_up_02"}
VERSION = "4.3.26"


def fail(message):
    raise RuntimeError(message)


class SpineExitError(RuntimeError):
    """Real licensed CLI returned a nonzero status; retain proof of the cause."""

    def __init__(self, returncode, output):
        super().__init__("Official Spine Editor command failed (exit " +
                         str(returncode) + ")")
        self.returncode = returncode
        self.output = output


def completed_png_export_with_exit145(error):
    """Only a post-completion launcher exit can be frame-validated later.

    Never accept a generic nonzero, an import/export JSON failure, an
    interrupted PNG export, or a mesh warning as a successful native render.
    """
    if not isinstance(error, SpineExitError) or error.returncode != 145:
        return False
    log = error.output
    return (bool(re.search(r"(?m)^PNG export:\s*.+$", log)) and
            bool(re.search(r"(?m)^Complete\.$", log)) and
            "You have stopped jobs." in log and
            not re.search(r"invalid mesh edge|mesh internal edges lost|"
                          r"data version mismatch|exception|failed", log, re.I))


def invoke(executable, args, *, license_code="", timeout=600):
    cmd = [str(executable), "-u", VERSION, *map(str, args)]
    result = subprocess.run(
        cmd, input=(license_code + "\n" if license_code else ""),
        text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout,
        check=False
    )
    # A license is never printed, including by the launcher.
    output = result.stdout.replace(license_code, "[REDACTED]") if license_code else result.stdout
    # The launcher reports licensed-to personal details; never publish them in CI logs.
    output = re.sub(r"(?im)^Licensed to:.*$", "Licensed to: [REDACTED]", output)
    print("SPINE_COMMAND", " ".join([str(executable), "-u", VERSION, *map(str, args)]))
    print("SPINE_EXIT", result.returncode)
    print("SPINE_LOG_TAIL", output[-4000:])
    if result.returncode != 0:
        raise SpineExitError(result.returncode, output)
    if re.search(r"invalid mesh edge|mesh internal edges lost|data version mismatch", output, re.I):
        fail("Official Spine Editor reported a mesh or version problem")
    return output


def unpack_verified(archive, target, package_report):
    """Bind a trusted-main build artifact to its full SHA-256 package receipt."""
    provenance = json.loads(package_report.read_text(encoding="utf-8"))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if provenance.get("source_sha256") != APPROVED_SOURCE_SHA256:
        fail("Receipt is not for the pinned original PSD")
    if provenance.get("export_version") != VERSION:
        fail("Wrong Spine version in trusted main build receipt")
    if provenance.get("zip_sha256") != digest or not re.fullmatch(r"[a-f0-9]{64}", digest):
        fail("Source ZIP differs from trusted GitHub main build receipt")
    if (provenance.get("visible_source_layers") != 38 or
        provenance.get("png_count") != 38 or
        provenance.get("actual_ik_constraints") != 2 or
        set(provenance.get("animations", [])) != REQUIRED_CLIPS):
        fail("Original PSD, layer, IK or clip receipt mismatch")
    with zipfile.ZipFile(archive) as z:
        if z.testzip() is not None:
            fail("Bad ZIP CRC")
        infos = z.infolist()
        if len(infos) != 40 or sum(i.file_size for i in infos) > 100_000_000:
            fail("Unexpected ZIP member count or uncompressed size")
        names = [i.filename for i in infos]
        if len(set(names)) != 40:
            fail("Duplicate ZIP members")
        for name in names:
            if not re.fullmatch(r"(skeleton\.json|skeleton\.atlas|images/[A-Za-z0-9_-]+\.png)", name):
                fail("Unsafe or unexpected archive path: " + name)
        z.extractall(target)
    skeleton = json.loads((target / "skeleton.json").read_text(encoding="utf-8"))
    if skeleton.get("skeleton", {}).get("spine") != VERSION:
        fail("Input skeleton version is not 4.3.26")
    slots = [slot["name"] for slot in skeleton.get("slots", [])]
    if len(slots) != 38 or len(set(slots)) != 38:
        fail("Expected 38 unique source slots")
    if set(skeleton.get("animations", {})) != REQUIRED_CLIPS:
        fail("Input is missing the two named animations")
    constraints = skeleton.get("constraints", skeleton.get("ik", []))
    if len(constraints) != 2:
        fail("Expected two IK chains in original JSON")
    if not (target / "images").is_dir() or len(list((target / "images").glob("*.png"))) != 38:
        fail("Expected 38 source PNGs")
    return slots



def restore_nonessential_mesh_edges(stage, source_archive, output):
    """Create an explicit repaired ZIP; do not mislabel the approved original as repaired.

    Spine serializes manual mesh edges as indexes into the flat UV/XY stream:
    the values must be even (2 * vertex_index). Recreate *interior* edges
    already supported by two triangles; do not alter triangulation or weights.
    """
    source_path = stage / "skeleton.json"
    skeleton = json.loads(source_path.read_text(encoding="utf-8"))
    fixed = []
    repairs_applied = 0
    for skin in skeleton.get("skins", []):
        for slot, attachments in skin.get("attachments", {}).items():
            for name, attachment in attachments.items():
                if attachment.get("type") != "mesh":
                    continue
                uvs = attachment.get("uvs", [])
                triangles = attachment.get("triangles", [])
                nverts = len(uvs) // 2
                if nverts < 3 or len(uvs) != 2*nverts or not triangles or len(triangles)%3:
                    fail("Malformed mesh UVs or triangles: " + name)
                occurrences = Counter()
                for p in range(0, len(triangles), 3):
                    a, b, c = triangles[p:p+3]
                    if any(not isinstance(v, int) or isinstance(v, bool) or v < 0 or v >= nverts for v in (a,b,c)):
                        fail("Invalid mesh triangle vertex: " + name)
                    if len({a,b,c}) != 3:
                        fail("Degenerate mesh triangle: " + name)
                    for pair in ((a,b),(b,c),(c,a)):
                        occurrences[tuple(sorted(pair))] += 1
                if any(n > 2 for n in occurrences.values()):
                    fail("Non-manifold mesh triangle edge: " + name)
                interior = sorted(pair for pair, count in occurrences.items() if count == 2)
                if not interior:
                    fail("No triangle-supported internal edges to restore: " + name)
                existing = attachment.get("edges")
                if existing is None:
                    attachment["edges"] = [2*vertex for pair in interior for vertex in pair]
                    repairs_applied += 1
                    mode = "reconstructed_missing_interior_edges"
                else:
                    if not isinstance(existing, list) or len(existing)%2 or not existing:
                        fail("Original Spine mesh edges missing valid index pairs: " + name)
                    if not all(isinstance(v,int) and not isinstance(v,bool)
                               and v%2 == 0 and 0<=v<2*nverts for v in existing):
                        fail("Original Spine mesh edge index not valid: " + name)
                    actual_pairs = {tuple(sorted((existing[i]//2, existing[i+1]//2)))
                                    for i in range(0,len(existing),2)}
                    if not set(interior).issubset(actual_pairs):
                        fail("Original mesh edges omit triangulation interior edges: " + name)
                    mode = "validated_existing_nonessential_edges"
                fixed.append({"slot": slot, "attachment": name, "internal_edges": len(interior),
                              "encoded_indices": attachment["edges"], "mode": mode})
    if not fixed:
        fail("No mesh attachments found for the explicit corrective pass")
    corrected_zip = output / "corrected-original-ik-spine-4.3.26.zip"
    if repairs_applied:
        repaired_bytes = (json.dumps(skeleton, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        source_path.write_bytes(repaired_bytes)
        with zipfile.ZipFile(source_archive, "r") as original, zipfile.ZipFile(corrected_zip, "w") as corrected:
            for entry in original.infolist():
                data = repaired_bytes if entry.filename == "skeleton.json" else original.read(entry.filename)
                corrected.writestr(entry, data)
    else:
        # New upstream artifact already has full nonessential mesh edges.
        # Preserve its exact approved SHA and never reserialize any source data.
        shutil.copyfile(source_archive, corrected_zip)
    with zipfile.ZipFile(source_archive) as original, zipfile.ZipFile(corrected_zip) as check:
        if check.testzip() is not None or len(check.namelist()) != 40:
            fail("Editor-ready ZIP failed CRC/member validation")
        for entry in original.namelist():
            if entry != "skeleton.json" and check.read(entry) != original.read(entry):
                fail("Non-skeleton member changed during ZIP repair: " + entry)
    report = {"approved_original_archive_sha256": hashlib.sha256(source_archive.read_bytes()).hexdigest(),
              "repaired_archive_sha256": hashlib.sha256(corrected_zip.read_bytes()).hexdigest(),
              "original_nonessential_mesh_edges_missing": bool(repairs_applied),
              "repaired_only_nonessential_mesh_edges": bool(repairs_applied),
              "meshes": fixed,
              "original_archive_is_not_editor_roundtrip_safe": bool(repairs_applied)}
    (output / "mesh-repair-report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("SPINE_MESH_NONESSENTIAL_REPAIRED", json.dumps(report))
    return report


def animation_duration(animation):
    """Longest keyed time across all track families (including events and draw order).

    Never infer the animation duration from a fixed number of screenshot frames.
    Reject malformed, non-finite, or excessive timelines instead of sampling a
    misleading first second and reporting it as a complete review.
    """
    times = []
    def walk(node):
        if isinstance(node, dict):
            if "time" in node:
                t = node["time"]
                if not isinstance(t, (int, float)) or isinstance(t, bool) or not math.isfinite(t) or t < 0:
                    fail("Invalid animation key time")
                times.append(float(t))
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)
    walk(animation)
    duration = max(times, default=0.0)
    if not (0 < duration <= 30):
        fail("Missing or unsafe animation duration: " + str(duration))
    return duration


def render_frames(spine, native, output, clip, license_code, duration):
    target = output / "screenshots" / clip
    target.mkdir(parents=True, exist_ok=True)
    # 4.3 PNG export settings, based on Spine 4.3 official export-png schema.
    fps = 24
    last_index = math.ceil(duration * fps)
    settings = {
        "class": "export-png", "exportType": "animation",
        "skeletonType": "single", "skeleton": "clgb71_ik",
        "animationType": "single", "animation": clip,
        "skinType": "current", "scale": 100,
        "renderImages": True, "renderBones": False, "renderOthers": False,
        "background": None, "fps": fps, "lastFrame": True,
        "rangeStart": 0, "rangeEnd": last_index,
        "compression": 6, "pad": False, "msaa": 4,
        "renderSelection": False, "open": False
    }
    settings_path = output / ("render-" + clip + ".export.json")
    settings_path.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    special_exit = False
    try:
        invoke(spine, ["-i", native, "-o", target, "-e", settings_path],
               license_code=license_code, timeout=300)
    except SpineExitError as error:
        if not completed_png_export_with_exit145(error):
            raise
        # Spine's launcher may exit 145 after declaring PNG export complete.
        # Do not trust this message alone: validate every actual output frame
        # below and let subsequent strict visual audits decide validity.
        special_exit = True
        print("SPINE_PNG_POST_COMPLETE_EXIT145_REQUIRES_FRAME_VALIDATION", clip)
    images = sorted(target.rglob("*.png"))
    if len(images) < last_index + 1:
        fail("Incomplete official Spine render for " + clip + ": " +
             str(len(images)) + " frames, expected at least " + str(last_index + 1))
    for frame in images:
        with Image.open(frame) as im:
            im.load()
            if im.width < 2 or im.height < 2:
                fail("Empty frame geometry: " + str(frame))
            if im.convert("RGBA").getchannel("A").getbbox() is None:
                fail("Transparent/blank Spine rendered frame: " + str(frame))
    if special_exit:
        print("SPINE_PNG_POST_COMPLETE_EXIT145_FRAMES_VERIFIED",
              clip, "frames", len(images), "expected_at_least", last_index + 1)
    return [str(p.relative_to(output)) for p in images]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--spine", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--package-report", required=True, type=Path)
    args = parser.parse_args()
    archive = args.archive.resolve()
    spine = args.spine.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if not spine.is_file() or not os.access(spine, os.X_OK):
        fail("Licensed Spine Linux CLI launcher not installed")
    license_code = os.environ.get("SPINE_LICENSE", "").strip()
    if not license_code:
        fail("SPINE_LICENSE is absent; cannot claim licensed Editor validation")

    stage = output / "source"
    stage.mkdir(exist_ok=True)
    before_slots = unpack_verified(archive, stage, args.package_report.resolve())
    repair = restore_nonessential_mesh_edges(stage, archive, output)
    native = output / "clgb71-editor-4.3.26.spine"
    shutil.copytree(stage / "images", output / "images", dirs_exist_ok=True)

    invoke(spine, ["-i", stage / "skeleton.json", "-o", native, "-r", "clgb71_ik"],
           license_code=license_code)
    if not native.exists() or native.stat().st_size < 100:
        fail("Editor failed to produce a native .spine project")

    exported = output / "roundtrip"
    exported.mkdir(exist_ok=True)
    # The CLI "json" shortcut uses runtime defaults and omits editor-only edges.
    # Re-export with Nonessential enabled so the mesh remains safely editable.
    export_settings = output / "roundtrip-nonessential.export.json"
    export_settings.write_text(json.dumps({
        "class": "export-json", "extension": ".json",
        "format": "JSON", "prettyPrint": True, "nonessential": True,
        "cleanUp": False, "packAtlas": None, "warnings": True,
        "all": True, "output": "", "open": False
    }, indent=2) + "\n", encoding="utf-8")
    invoke(spine, ["-i", native, "-o", exported, "-e", export_settings],
           license_code=license_code)
    candidates = list(exported.rglob("*.json"))
    if len(candidates) != 1:
        fail("Expected exactly one round-tripped Editor JSON")
    back = json.loads(candidates[0].read_text(encoding="utf-8"))
    if back.get("skeleton", {}).get("spine") != VERSION:
        fail("Spine Editor did not export requested 4.3.26 data")
    after_slots = [s["name"] for s in back.get("slots", [])]
    if before_slots != after_slots:
        fail("Slot order changed in native Editor roundtrip")
    constraints = back.get("constraints", back.get("ik", []))
    if len(constraints) != 2:
        fail("IK constraints lost during native Editor roundtrip")
    if set(back.get("animations", {})) != REQUIRED_CLIPS:
        fail("Animations missing after native Editor roundtrip")
    # A roundtrip that omits internal edges would merely hide the original loss.
    imported_meshes = {}
    for skin in back.get("skins", []):
        for attachments in skin.get("attachments", {}).values():
            for name, attachment in attachments.items():
                if attachment.get("type") == "mesh":
                    imported_meshes[name] = attachment
    for fixed in repair["meshes"]:
        name = fixed["attachment"]
        attachment = imported_meshes.get(name)
        edges = attachment.get("edges") if attachment else None
        if not isinstance(edges, list) or len(edges) < 2*fixed["internal_edges"] or len(edges)%2:
            fail("Native Editor roundtrip discarded mesh internal edges: " + name)
        uv_count = len(attachment.get("uvs", []))
        if not all(isinstance(v,int) and v%2==0 and 0<=v<uv_count for v in edges):
            fail("Native Editor roundtrip exported malformed internal edges: " + name)
    # Verify the Editor retained the full source clip timing before rendering.
    source_anims = json.loads((stage / "skeleton.json").read_text(encoding="utf-8"))["animations"]
    screenshot_paths = []
    full_frame_coverage = {}
    for clip in sorted(REQUIRED_CLIPS):
        source_duration = animation_duration(source_anims[clip])
        editor_duration = animation_duration(back["animations"][clip])
        if abs(source_duration - editor_duration) > 1 / 240:
            fail("Native Editor changed animation end time: " + clip)
        frames = render_frames(spine, native, output, clip, license_code, editor_duration)
        screenshot_paths.extend(frames)
        full_frame_coverage[clip] = {
            "duration_seconds": editor_duration,
            "fps": 24,
            "expected_min_frames": math.ceil(editor_duration * 24) + 1,
            "rendered_frames": len(frames),
            "start_frame": frames[0],
            "mid_frame": frames[len(frames) // 2],
            "end_frame": frames[-1],
        }

    report = {
        "source_archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "repaired_archive_sha256": repair["repaired_archive_sha256"],
        "nonessential_mesh_edges_restored_and_roundtripped": True,
        "original_archive_has_known_nonessential_defect": repair["original_nonessential_mesh_edges_missing"],
        "spine_editor_requested": VERSION,
        "roundtrip_spine_version": back["skeleton"]["spine"],
        "editor_import_verified": True,
        "native_spine_project_verified": True,
        "native_project_sha256": hashlib.sha256(native.read_bytes()).hexdigest(),
        "slots": len(after_slots), "slot_order_unchanged": True,
        "ik_constraints": len(constraints),
        "animations": sorted(REQUIRED_CLIPS),
        "spine_render_nonblank_frames_verified": True,
        "official_rendered_frames": screenshot_paths,
        "full_animation_frame_coverage": full_frame_coverage,
        "source_psd_fidelity_check": "independent workflow step required",
        "source_psd_visual_correspondence_approved": False,
        "artistic_quality_approved": False,
        "note": "Entire source-verified clip ranges exported at 24 FPS. Human artistic acceptance remains pending."
    }
    (output / "editor-roundtrip-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("SPINE_NATIVE_IMPORT_AND_RENDER_PASS", json.dumps(report))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("SPINE_NATIVE_IMPORT_AND_RENDER_FAIL", type(exc).__name__, str(exc), file=sys.stderr)
        sys.exit(1)
