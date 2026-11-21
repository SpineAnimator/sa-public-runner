import platform
import unittest


class UbuntuCISmokeTest(unittest.TestCase):
    def test_runs_on_linux(self):
        self.assertEqual(platform.system(), "Linux")

    def test_python_is_available(self):
        self.assertGreaterEqual(platform.python_version_tuple()[0], "3")


if __name__ == "__main__":
    unittest.main()
