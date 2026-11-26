from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
EXECUTOR = ROOT / ".github" / "workflows" / "build-mask-bridge.yml"
CALLER = ROOT / "repos" / "spine-resize" / ".github" / "workflows" / "build-mask-bridge.yml"


class BridgePublicExecutorContractTests(unittest.TestCase):
    def test_platform_build_is_a_reusable_public_executor_workflow(self):
        source = EXECUTOR.read_text(encoding="utf-8")
        self.assertIn("workflow_call:", source)
        self.assertIn("windows-host:", source)
        self.assertIn("macos-host:", source)
        self.assertIn("linux-host:", source)
        self.assertIn("publish:", source)
        self.assertIn("runs-on: windows-latest", source)
        self.assertIn("runs-on: macos-latest", source)
        self.assertGreaterEqual(source.count("runs-on: ubuntu-24.04"), 2)
        self.assertNotIn("self-hosted", source.lower())
        self.assertIn("permissions:", source)
        self.assertIn("contents: write", source)
        self.assertIn("GITHUB_REPOSITORY", source)

    def test_source_repository_delegates_all_bridge_jobs_to_public_executor(self):
        source = CALLER.read_text(encoding="utf-8")
        self.assertIn("uses: SpineAnimator/sa-public-runner/.github/workflows/build-mask-bridge.yml@", source)
        self.assertNotIn("runs-on:", source)
        self.assertNotIn("steps:", source)


if __name__ == "__main__":
    unittest.main()
