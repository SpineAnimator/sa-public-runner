"""Source-only Photoshop effects evidence: NORMAL blend is not appearance parity."""
import sys
import unittest
from PIL import Image
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from verify_clgb71_fidelity import original_blend_profile, measure_style_footprints


class FakeEffect:
    name = "DropShadow"
    enabled = True
    angle = 120
    distance = 8
    size = 14
    opacity = 55.5
    choke = 0
    noise = 0
    blend_mode = b"mul "

class FakeEffects(list):
    enabled = True


class FakeMode:
    def __init__(self, name):
        self.name = name


class FakeLayer:
    def __init__(self, name, *, effects=(), parent=None, mode="NORMAL",
                 group=False, opacity=255, fill=255, mask=False):
        self.name = name
        self.kind = "smartobject" if effects else "pixel"
        self.blend_mode = FakeMode(mode)
        self.effects = FakeEffects(effects)
        self.parent = parent
        self.opacity = opacity
        self.fill_opacity = fill
        self.clipping = False
        self._group = group
        self._mask = mask
        self.left, self.top, self.right, self.bottom = 12, 12, 21, 21

    def is_group(self):
        return self._group

    def has_mask(self):
        return self._mask


class PhotoshopStyleEvidenceTests(unittest.TestCase):
    def test_normal_smartobject_drop_shadow_is_not_spine_normal_equivalent(self):
        card = FakeLayer("card-9", effects=[FakeEffect()])
        data = original_blend_profile([card])
        self.assertEqual(data["unsupported_psd_blend_layers"], [])
        self.assertEqual(data["unsupported_photoshop_compositing_layers"], ["card-9"])
        self.assertEqual(data["layers"][0]["active_effects"], ["DropShadow"])
        self.assertEqual(data["layers"][0]["active_effect_parameters"], [{
            "name": "DropShadow", "angle": 120.0, "distance": 8.0,
            "size": 14.0, "opacity": 55.5, "choke": 0.0, "noise": 0.0,
            "blend_mode": "mul " }])
        self.assertTrue(data["layers"][0]["slot_blend_supported"])
        self.assertTrue(data["source_has_unsupported_visual_effects"])
        self.assertFalse(data["photoshop_compositing_verified_in_spine"])

    def test_plain_normal_layer_has_no_unrepresented_style(self):
        data = original_blend_profile([FakeLayer("body")])
        self.assertEqual(data["unsupported_photoshop_compositing_layers"], [])
        self.assertEqual(data["unsupported_psd_blend_layers"], [])
        self.assertEqual(data["layers"][0]["active_effects"], [])

    def test_disabled_effect_does_not_block_and_fill_opacity_does(self):
        off = FakeEffect()
        off.enabled = False
        a = FakeLayer("off", effects=[off])
        b = FakeLayer("fill", fill=153)
        data = original_blend_profile([a, b])
        self.assertEqual(data["unsupported_photoshop_compositing_layers"], ["fill"])

    def test_ancestor_group_opacity_is_propagated_without_mutating_children(self):
        group = FakeLayer("folder", group=True, opacity=180)
        leaf = FakeLayer("leaf", parent=group)
        data = original_blend_profile([leaf])
        self.assertEqual(data["unsupported_photoshop_compositing_layers"], ["leaf"])
        self.assertEqual(data["layers"][0]["ancestor_groups"][0]["opacity"], 180)
        self.assertEqual(leaf.opacity, 255)

    def test_effect_footprint_locality_does_not_claim_cause(self):
        original = Image.new("RGBA", (40, 40), (40, 70, 110, 255))
        recomposed = original.copy()
        recomposed.putpixel((17, 18), (130, 70, 110, 255))
        recomposed.putpixel((38, 38), (130, 70, 110, 255))
        small_shadow = FakeEffect()
        small_shadow.distance, small_shadow.size = 1, 1
        evidence = measure_style_footprints(
            original, recomposed, [FakeLayer("card-9", effects=[small_shadow])])
        self.assertEqual(len(evidence["effect_regions"]), 1)
        self.assertGreater(evidence["rgb_abs_error_inside"], 0)
        self.assertGreater(evidence["rgb_abs_error_outside"], 0)
        self.assertAlmostEqual(evidence["inside_share_of_total_rgb_error"], .5)
        self.assertAlmostEqual(evidence["outside_share_of_total_rgb_error"], .5)
        self.assertGreater(evidence["outside_fully_opaque_rgb_mae_255"], 0)
        self.assertGreater(len(evidence["top_outside_shadow_hotspots"]), 0)
        self.assertFalse(evidence["shadow_causality_proven"])
        self.assertFalse(evidence["photoshop_parity_proven"])

    def test_truly_unsupported_psd_blend_kept_as_separate_signal(self):
        data = original_blend_profile([FakeLayer("overlay", mode="OVERLAY")])
        self.assertEqual(data["unsupported_psd_blend_layers"], ["overlay"])
        self.assertEqual(data["unsupported_photoshop_compositing_layers"], ["overlay"])


if __name__ == "__main__":
    unittest.main()
