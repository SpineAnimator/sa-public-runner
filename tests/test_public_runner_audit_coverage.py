from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from audit_public_runners import REPOSITORIES, runner_is_allowed


class PublicRunnerAuditCoverageTests(unittest.TestCase):
    def test_core_product_repositories_are_in_the_audit_scope(self):
        names = {path.as_posix() for path in REPOSITORIES}
        self.assertIn("repos/Spine-Resize", names)
        self.assertIn("repos/spine-web-source", names)

    def test_ubuntu_hosted_runners_are_allowed(self):
        self.assertTrue(runner_is_allowed(Path("repo/.github/workflows/ci.yml"), "ubuntu-24.04", ""))

    def test_only_explicit_bridge_platform_matrix_is_allowed(self):
        workflow = "strategy:\n  matrix:\n    os: [ubuntu-24.04, windows-latest, macos-latest]\njobs:\n  test:\n    runs-on: ${{ matrix.os }}\n"
        path = Path(".github/workflows/spine-mask-bridge-platform-tests.yml")
        self.assertTrue(runner_is_allowed(path, "${{ matrix.os }}", workflow))
        self.assertTrue(runner_is_allowed(path, "windows-latest", workflow))
        self.assertTrue(runner_is_allowed(path, "macos-latest", workflow))
        self.assertFalse(runner_is_allowed(Path("repo/.github/workflows/ci.yml"), "${{ matrix.os }}", workflow))
        self.assertFalse(runner_is_allowed(path, "self-hosted", workflow))

    def test_windows_and_macos_are_limited_to_bridge_builders(self):
        path = Path(".github/workflows/build-mask-bridge.yml")
        self.assertTrue(runner_is_allowed(path, "windows-latest", ""))
        self.assertTrue(runner_is_allowed(path, "macos-latest", ""))
        self.assertFalse(runner_is_allowed(Path("repo/.github/workflows/ci.yml"), "windows-latest", ""))


if __name__ == "__main__":
    unittest.main()
