"""Offline negative tests: never accept substituted artwork as original clgb71.psd."""
import unittest
from tools.verify_zombie_psd import (
    assert_source_contract, EXPECTED_SHA256, EXPECTED_BYTES,
    EXPECTED_DIMENSIONS, EXPECTED_VISIBLE_LAYERS, REQUIRED_LAYER_NAMES,
)


def approved_layers():
    names = sorted(REQUIRED_LAYER_NAMES)
    names += [f"card-{i}" for i in range(EXPECTED_VISIBLE_LAYERS - len(names))]
    return [
        {"name": "/" + name, "group": False, "visible": True,
         "box": [i, i, 10, 10]} for i, name in enumerate(names)
    ]


class SourceContractTests(unittest.TestCase):
    def call(self, **changes):
        kw = dict(digest=EXPECTED_SHA256, size=EXPECTED_BYTES,
                  width=EXPECTED_DIMENSIONS[0], height=EXPECTED_DIMENSIONS[1],
                  layers=approved_layers())
        kw.update(changes)
        assert_source_contract(**kw)

    def test_approved_source_metadata(self):
        self.call()

    def test_200_with_different_valid_psd_hash_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.call(digest="a" * 64)

    def test_truncated_or_zero_body_is_rejected(self):
        for count in (0, EXPECTED_BYTES - 1):
            with self.subTest(count=count), self.assertRaisesRegex(ValueError, "byte size"):
                self.call(size=count)

    def test_wrong_canvas_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "dimensions"):
            self.call(width=EXPECTED_DIMENSIONS[0] + 1)

    def test_missing_visible_layer_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "layer count"):
            self.call(layers=approved_layers()[:-1])

    def test_required_layer_replaced_is_rejected(self):
        layers = approved_layers()
        layers[0]["name"] = "/unrelated-new-art"
        with self.assertRaisesRegex(ValueError, "original layers"):
            self.call(layers=layers)


class BlendProfileTests(unittest.TestCase):
    def test_nonspine_blends_are_flagged_without_touching_source(self):
        from tools.verify_clgb71_fidelity import original_blend_profile
        class Blend:
            def __init__(self, name): self.name = name
        class Layer:
            def __init__(self, name, mode):
                self.name=name; self.blend_mode=Blend(mode); self.opacity=255
                self.clipping=False; self.parent=None
            def has_mask(self): return False
        layers=[Layer("pistol","NORMAL"),Layer("glow","SOFT_LIGHT"),Layer("shadow","MULTIPLY")]
        before=[(l.name,l.blend_mode.name) for l in layers]
        result=original_blend_profile(layers)
        self.assertEqual(result["unsupported_psd_blend_layers"],["glow"])
        self.assertTrue(result["source_has_unsupported_slot_blends"])
        self.assertFalse(result["photoshop_compositing_verified_in_spine"])
        self.assertEqual(before,[(l.name,l.blend_mode.name) for l in layers])

    def test_psd_icc_metadata_is_sha_bound_and_never_a_color_approval(self):
        from tools.verify_clgb71_fidelity import source_color_profile_evidence
        from psd_tools.constants import Resource
        class Resources:
            def __init__(self, payload): self.payload = payload
            def get_data(self, key):
                self_key = Resource.ICC_PROFILE
                assert key == self_key
                return self.payload
        class Source:
            def __init__(self, payload):
                self.image_resources = Resources(payload)
                self.depth = 8
                self.color_mode = type('Color', (), {'name': 'RGB'})()
            def has_preview(self): return True
        payload = b'fixture-only-color-profile-not-user-artwork'
        evidence = source_color_profile_evidence(Source(payload))
        self.assertTrue(evidence['has_embedded_icc_profile'])
        self.assertTrue(evidence['has_saved_merged_preview'])
        self.assertEqual(evidence['icc_profile_sha256'], __import__('hashlib').sha256(payload).hexdigest())
        self.assertEqual(evidence['icc_profile_bytes'], len(payload))
        self.assertFalse(evidence['icc_transform_causality_proven'])
        self.assertFalse(evidence['saved_preview_color_truth_approved'])
        self.assertNotIn(payload.decode(), str(evidence))
        without = source_color_profile_evidence(Source(None))
        self.assertFalse(without['has_embedded_icc_profile'])
        self.assertIsNone(without['icc_profile_sha256'])
        with self.assertRaisesRegex(ValueError, 'ICC'):
            source_color_profile_evidence(Source({'not': 'bytes'}))


if __name__ == "__main__":
    unittest.main()
