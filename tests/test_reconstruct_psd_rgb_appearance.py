"""Color inversion changes only derived RGB, never original Photoshop alpha/geometry."""
import sys
import unittest
from pathlib import Path
import numpy as np
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"tools"))
from reconstruct_psd_rgb_appearance import solve_rgb


class RGBInverseTests(unittest.TestCase):
    def test_opaque_top_layer_can_match_saved_preview_without_altering_source(self):
        back = np.zeros((8, 8, 4), dtype=np.uint8)
        back[:] = (12, 55, 91, 255)
        front = np.zeros_like(back)
        front[2:6, 2:6] = (100, 130, 220, 255)
        original = np.stack([back, front])
        reference = Image.fromarray(front.copy(), "RGBA")
        visible = np.asarray(reference).copy()
        visible[:] = (12, 55, 91, 255)
        visible[2:6, 2:6] = (223, 65, 21, 255)
        reference = Image.fromarray(visible, "RGBA")
        candidate, result = solve_rgb([back, front], [0, 1], reference)
        self.assertTrue(np.array_equal(original[0, ..., 3], candidate[0, ..., 3]))
        self.assertTrue(np.array_equal(original[1, ..., 3], candidate[1, ..., 3]))
        self.assertTrue(np.array_equal(original[..., :], np.stack([back, front])))
        self.assertEqual(candidate[1, 4, 4, :3].tolist(), [223, 65, 21])
        self.assertLess(result["final_float_background_mae"], 0.51)

    def test_half_alpha_correction_and_zero_alpha_preserve_source_alpha(self):
        lower = np.zeros((5, 5, 4), dtype=np.uint8)
        upper = np.zeros_like(lower)
        upper[2, 2] = (100, 100, 100, 128)
        target = Image.fromarray(np.zeros((5, 5, 4), dtype=np.uint8), "RGBA")
        candidate, _ = solve_rgb([lower, upper], [0, 1], target)
        self.assertEqual(candidate[1, 2, 2, 3], 128)
        self.assertEqual(candidate[1, 0, 0].tolist(), upper[0, 0].tolist())


if __name__ == "__main__":
    unittest.main()
