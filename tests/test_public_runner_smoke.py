import unittest

class PublicRunnerSmokeTest(unittest.TestCase):
    def test_runner_smoke(self):
        self.assertEqual("SA", "S" + "A")

if __name__ == "__main__":
    unittest.main()
