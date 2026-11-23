#!/usr/bin/env python3
"""Compare real licensed Spine Editor rest frames with the original PSD composite.

Artistic evidence only: never change raster source, synthesize animation,
or certify a ZIP as artistically approved based on technical correctness.
Pillow-only alpha registration neutralizes Editor canvas padding.
"""
import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image, ImageChops, ImageStat

CLIPS = ('shoot_up_01', 'shoot_up_02')
RGB_MAE_LIMIT = 3.0
VISIBLE_PIXEL_DIFFERENCE_LIMIT = .05
ALPHA_MAE_LIMIT = 2.0


def alpha_distance(reference, rendered, x, y):
    part = rendered.crop((x, y, x + reference.width, y + reference.height))
    if part.size != reference.size:
        raise ValueError('registration crop is outside the Editor image')
    return ImageStat.Stat(ImageChops.difference(reference, part)).mean[0]


def find_alignment(source, rendered):
    if rendered.width < source.width or rendered.height < source.height:
        raise ValueError('Editor frame smaller than original PSD composite')
    src = source.getchannel('A')
    dst = rendered.getchannel('A')
    best_x = best_y = 0
    for scale, radius in ((8, None), (2, 6), (1, 3)):
        src_small = src.resize((max(1, (src.width + scale - 1) // scale),
                                max(1, (src.height + scale - 1) // scale)), Image.Resampling.BOX)
        dst_small = dst.resize((max(1, (dst.width + scale - 1) // scale),
                                max(1, (dst.height + scale - 1) // scale)), Image.Resampling.BOX)
        max_x = dst_small.width - src_small.width
        max_y = dst_small.height - src_small.height
        if max_x < 0 or max_y < 0:
            raise ValueError('scaled Editor frame smaller than original PSD')
        if radius is None:
            xs, ys = range(max_x + 1), range(max_y + 1)
        else:
            center_x, center_y = round(best_x / scale), round(best_y / scale)
            xs = range(max(0, center_x - radius), min(max_x, center_x + radius) + 1)
            ys = range(max(0, center_y - radius), min(max_y, center_y + radius) + 1)
        candidates = ((alpha_distance(src_small, dst_small, x, y), x, y)
                      for y in ys for x in xs)
        _, x, y = min(candidates, key=lambda item: (item[0], item[2], item[1]))
        best_x, best_y = x * scale, y * scale
    return best_x, best_y


def compare(source, rendered):
    source = source.convert('RGBA')
    rendered = rendered.convert('RGBA')
    x, y = find_alignment(source, rendered)
    target = rendered.crop((x, y, x + source.width, y + source.height))
    # Exact pixel parity also requires the padded native Editor export to
    # contain NO extra visible artwork beyond the original PSD canvas.
    # Previously the registration crop silently discarded such fragments,
    # potentially turning an incorrect native render into a false green.
    in_canvas = Image.new('L', rendered.size, 0)
    in_canvas.paste(255, (x, y, x + source.width, y + source.height))
    exterior_alpha = ImageChops.multiply(rendered.getchannel('A'),
                                         ImageChops.invert(in_canvas))
    exterior_visible_pixels = sum(exterior_alpha.histogram()[1:])
    source_alpha, target_alpha = source.getchannel('A'), target.getchannel('A')
    alpha_delta = ImageChops.difference(source_alpha, target_alpha)
    alpha_mae = ImageStat.Stat(alpha_delta).mean[0]
    mask = ImageChops.darker(source_alpha, target_alpha).point(lambda v: 255 if v > 127 else 0)
    count = ImageStat.Stat(mask).sum[0] / 255
    if count < 100:
        raise ValueError('Not enough mutually opaque PSD and Editor pixels for color comparison')
    diff = ImageChops.difference(source.convert('RGB'), target.convert('RGB'))
    per_channel = ImageStat.Stat(diff, mask=mask).mean
    channels = diff.split()
    max_diff = ImageChops.lighter(channels[0], ImageChops.lighter(channels[1], channels[2]))
    significant = max_diff.point(lambda v: 255 if v > 20 else 0)
    exceeding = ImageChops.darker(significant, mask)
    noticeable_fraction = (ImageStat.Stat(exceeding).sum[0] / 255) / count
    # Keep exact-opaque interiors separate from semi-transparent edges. A
    # renderer's alpha filtering can affect edge RGB without explaining a
    # mismatch in fully opaque artwork. Do not use either statistic to relax
    # the source-preview parity gate.
    opaque_mask = ImageChops.darker(
        source_alpha.point(lambda a: 255 if a == 255 else 0),
        target_alpha.point(lambda a: 255 if a == 255 else 0))
    edge_mask = ImageChops.subtract(mask, opaque_mask)
    def measure_stratum(region):
        pixels = int(ImageStat.Stat(region).sum[0] / 255)
        if pixels == 0:
            return {'pixels': 0, 'rgb_mae_255': None,
                    'visible_fraction_any_channel_diff_gt20': None}
        rgb = ImageStat.Stat(diff, mask=region).mean
        over20 = ImageChops.darker(significant, region)
        return {'pixels': pixels,
                'rgb_mae_255': round(sum(rgb) / 3, 4),
                'visible_fraction_any_channel_diff_gt20': round(
                    ImageStat.Stat(over20).sum[0] / (255 * pixels), 6)}
    opacity_strata = {'fully_opaque': measure_stratum(opaque_mask),
                      'partly_transparent': measure_stratum(edge_mask)}
    # The existing tolerance gate is NOT pixel-perfect evidence. Measure all
    # four channels at every aligned PSD canvas pixel (including transparent
    # texels), without thresholding, resampling or ignoring alpha edges.
    canvas_pixels = source.width * source.height
    exact_mismatched = canvas_pixels - ImageChops.lighter(max_diff, alpha_delta).histogram()[0]
    rgb_mismatched = canvas_pixels - max_diff.histogram()[0]
    alpha_mismatched = canvas_pixels - alpha_delta.histogram()[0]
    transparent_in_both = ImageChops.lighter(source_alpha, target_alpha).point(
        lambda alpha: 0 if alpha else 255)
    transparent_with_rgb_difference = ImageChops.darker(max_diff, transparent_in_both)
    exact_breakdown = {
        'rgb_only': exact_mismatched - alpha_mismatched,
        'alpha_only': exact_mismatched - rgb_mismatched,
        'rgb_and_alpha': rgb_mismatched + alpha_mismatched - exact_mismatched,
        'rgb_only_where_both_fully_transparent': canvas_pixels - transparent_with_rgb_difference.histogram()[0],
    }
    return {'offset_xy': [x, y],
            'outside_psd_canvas_nontransparent_pixels': exterior_visible_pixels,
            'native_artwork_confined_to_psd_canvas': exterior_visible_pixels == 0,
            'exact_rgba_mismatched_pixels': exact_mismatched,
            'exact_rgba_pixel_parity': exact_mismatched == 0 and exterior_visible_pixels == 0,
            'exact_rgba_compared_pixels': canvas_pixels,
            'exact_rgba_mismatch_breakdown': exact_breakdown,
            'alpha_mae_255': round(alpha_mae, 4),
            'rgb_mae_255': round(sum(per_channel) / 3, 4),
            'rgb_channel_mae_255': [round(v, 4) for v in per_channel],
            'visible_pixel_count': int(count),
            'visible_fraction_any_channel_diff_gt20': round(noticeable_fraction, 6),
            'opacity_strata': opacity_strata}


def audit(source, frames_by_clip, layer_composite=None, forced_recomposite=None):
    if set(frames_by_clip) != set(CLIPS):
        raise ValueError('Both approved original clips required')
    clips = {}
    for clip in CLIPS:
        frames = frames_by_clip[clip]
        if len(frames) < 49:
            raise ValueError(f'{clip}: requires at least 49 actual Editor frames')
        clips[clip] = {'start': compare(source, frames[0]), 'end': compare(source, frames[-1]),
                       'editor_frames': len(frames)}
    checks = [v[k] for v in clips.values() for k in ('start', 'end')]
    exact_parity = all(c['exact_rgba_pixel_parity'] for c in checks)
    passes = all(c['native_artwork_confined_to_psd_canvas'] and
                 c['alpha_mae_255'] <= ALPHA_MAE_LIMIT and
                 c['rgb_mae_255'] <= RGB_MAE_LIMIT and
                 c['visible_fraction_any_channel_diff_gt20'] <= VISIBLE_PIXEL_DIFFERENCE_LIMIT
                 for c in checks)
    # Source preview vs raw extracted-layer overlay is independently measured.
    # A large difference *at this stage* cannot be blamed on Spine's renderer.
    # This is diagnostic stage attribution, NOT proof of Photoshop ICC/blending
    # implementation details and NEVER an automatic art approval.
    triage = None
    if layer_composite is not None:
        layer_composite = layer_composite.convert('RGBA')
        if layer_composite.size != source.size:
            raise ValueError('Extracted-layer composite size differs from PSD preview')
        preview_vs_layers = compare(source, layer_composite)
        layers_vs_editor = {
            clip: {'start': compare(layer_composite, frames_by_clip[clip][0]),
                   'end': compare(layer_composite, frames_by_clip[clip][-1])}
            for clip in CLIPS
        }
        pre_error = preview_vs_layers['rgb_mae_255']
        renderer_error = max(v[edge]['rgb_mae_255']
                             for v in layers_vs_editor.values() for edge in ('start', 'end'))
        stage = ('PSD_PREVIEW_VS_EXTRACTED_LAYER_OVERLAY'
                 if pre_error > max(3.0, renderer_error * 1.20) else
                 'EXTRACTED_LAYER_OVERLAY_VS_NATIVE_SPINE'
                 if renderer_error > max(3.0, pre_error * 1.20) else
                 'MIXED_OR_INDETERMINATE')
        triage = {
            'measured_first_stage': 'original PSD merged-preview vs independent extracted-layer alpha overlay',
            'measured_second_stage': 'extracted-layer alpha overlay vs genuine Spine Editor rest frames',
            'preview_vs_layer_overlay': preview_vs_layers,
            'layer_overlay_vs_editor': layers_vs_editor,
            'largest_layer_overlay_vs_editor_rgb_mae_255': round(renderer_error, 4),
            'dominant_measured_mismatch_stage': stage,
            'visual_release_approved': False,
            'root_cause_proven': False,
            'note': ('Measured stage discrepancy, not proof of blend mode, ICC profile '
                     'conversion, premultiplication or a Photoshop cache defect.')
        }
    # The archived Photoshop merged preview and a fresh layer recomposition
    # are two *different* pieces of source evidence. Never quietly substitute
    # one for the other or claim that a mismatched cached preview is proven.
    if forced_recomposite is not None:
        if layer_composite is None:
            raise ValueError('Forced PSD recomposition requires the extracted-layer overlay')
        forced_recomposite = forced_recomposite.convert('RGBA')
        if forced_recomposite.size != source.size:
            raise ValueError('Forced PSD recomposition size differs from PSD preview')
        saved_vs_forced = compare(source, forced_recomposite)
        forced_vs_overlay = compare(forced_recomposite, layer_composite)
        forced_vs_editor = {
            clip: {'start': compare(forced_recomposite, frames_by_clip[clip][0]),
                   'end': compare(forced_recomposite, frames_by_clip[clip][-1])}
            for clip in CLIPS
        }
        match_layers = (forced_vs_overlay['rgb_mae_255'] <= 1.0 and
                        forced_vs_overlay['alpha_mae_255'] <= ALPHA_MAE_LIMIT and
                        forced_vs_overlay['visible_fraction_any_channel_diff_gt20'] <= .01)
        disagreement = (saved_vs_forced['rgb_mae_255'] > RGB_MAE_LIMIT or
                        saved_vs_forced['visible_fraction_any_channel_diff_gt20'] >
                        VISIBLE_PIXEL_DIFFERENCE_LIMIT)
        triage['source_reference_split'] = {
            'saved_psd_preview_vs_forced_layer_recomposition': saved_vs_forced,
            'forced_layer_recomposition_vs_extracted_png_overlay': forced_vs_overlay,
            'forced_layer_recomposition_vs_editor': forced_vs_editor,
            'forced_recomposition_matches_source_layer_overlay': match_layers,
            'saved_preview_differs_from_forced_recomposition': disagreement,
            'source_reference_conflict_unresolved': bool(match_layers and disagreement),
            'reference_policy': ('Do not select the easier reference to make RGB pass; '
                                 'independent Photoshop color truth and native output '
                                 'must be established before artistic approval.'),
            'root_cause_proven': False
        }
    return {'schema': '2spine.native-editor-psd-color-evidence.v1',
            'status': 'PASS_COLOR_COMPOSITE_PARITY' if passes else 'BLOCK_ARTISTIC_COLOR_FIDELITY',
            'absolute_pixel_parity_proven': exact_parity,
            'exact_rgba_all_four_rest_frames': exact_parity,
            'thresholds': {'alpha_mae_255': ALPHA_MAE_LIMIT,
                           'rgb_mae_255': RGB_MAE_LIMIT,
                           'fraction_any_channel_diff_gt20': VISIBLE_PIXEL_DIFFERENCE_LIMIT},
            'clip_evidence': clips, 'color_divergence_triage': triage,
            'artistic_quality_approved': False,
            'release_ready': False,
            'notes': 'Source PNG pixel identity is distinct from rendered PSD color parity; this comparison cannot isolate blending, color profiles, or premultiplication as the cause.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--psd-composite', type=Path, required=True)
    parser.add_argument('--editor-screenshots', type=Path, required=True)
    parser.add_argument('--layer-composite', type=Path,
                        help='Optional independent layer alpha-overlay PNG for upstream/renderer split')
    parser.add_argument('--forced-recomposite', type=Path,
                        help='Fresh PSD layer recomposition, separately from its saved merged preview')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--fail-on-color-mismatch', action='store_true')
    args = parser.parse_args()
    with Image.open(args.psd_composite) as original:
        source = original.convert('RGBA')
    clips = {}
    for clip in CLIPS:
        paths = sorted((args.editor_screenshots / clip).glob('*.png'))
        if len(paths) < 49:
            raise ValueError(f'{clip}: expected full actual 49-frame Editor export, found {len(paths)}')
        frames = [None] * len(paths)
        with Image.open(paths[0]) as first, Image.open(paths[-1]) as last:
            frames[0] = first.copy()
            frames[-1] = last.copy()
        clips[clip] = frames
    layer_composite = None
    if args.layer_composite is not None:
        with Image.open(args.layer_composite) as layer_image:
            layer_composite = layer_image.convert('RGBA')
    forced_recomposite = None
    if args.forced_recomposite is not None:
        with Image.open(args.forced_recomposite) as recomposite_image:
            forced_recomposite = recomposite_image.convert('RGBA')
    result = audit(source, clips, layer_composite=layer_composite,
                   forced_recomposite=forced_recomposite)
    if args.forced_recomposite is not None:
        result['forced_recomposite_sha256'] = hashlib.sha256(
            args.forced_recomposite.read_bytes()).hexdigest()
    result['source_composite_sha256'] = hashlib.sha256(args.psd_composite.read_bytes()).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('PSD_EDITOR_COLOR_EVIDENCE', result['status'], args.output)
    print('PSD_EDITOR_EXACT_RGBA', json.dumps({
        clip: {
            pos: entry[pos]['exact_rgba_mismatch_breakdown']
            for pos in ('start', 'end')
        }
        for clip, entry in result['clip_evidence'].items()
    }, sort_keys=True))
    if result['color_divergence_triage']:
        triage = result['color_divergence_triage']
        print('PSD_COLOR_STAGE_TRIAGE', triage['dominant_measured_mismatch_stage'],
              'preview-vs-layers', triage['preview_vs_layer_overlay']['rgb_mae_255'],
              'layers-vs-editor', triage['largest_layer_overlay_vs_editor_rgb_mae_255'])
    if result['color_divergence_triage'] and 'source_reference_split' in result['color_divergence_triage']:
        split = result['color_divergence_triage']['source_reference_split']
        print('COLOR_OPAQUE_INTERIOR_TRIAGE', json.dumps({
            'saved_preview_vs_forced':
                split['saved_psd_preview_vs_forced_layer_recomposition']['opacity_strata'],
            'forced_vs_png':
                split['forced_layer_recomposition_vs_extracted_png_overlay']['opacity_strata'],
            'forced_vs_editor': {
                clip: entry['start']['opacity_strata']
                for clip, entry in split['forced_layer_recomposition_vs_editor'].items()
            },
        }, sort_keys=True))
        print('SOURCE_REFERENCE_CONFLICT',
              split['source_reference_conflict_unresolved'],
              'preview-vs-forced',
              split['saved_psd_preview_vs_forced_layer_recomposition']['rgb_mae_255'],
              'forced-vs-PNG',
              split['forced_layer_recomposition_vs_extracted_png_overlay']['rgb_mae_255'])
    if args.fail_on_color_mismatch and result['status'] != 'PASS_COLOR_COMPOSITE_PARITY':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
