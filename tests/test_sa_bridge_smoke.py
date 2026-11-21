import unittest

class SABridgeSmoke(unittest.TestCase):
    def test_public_runner_task_contract(self):
        from pathlib import Path
        self.assertTrue((Path(__file__).resolve().parents[1] / "task.json").is_file())

if __name__ == "__main__":
    unittest.main()
