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

    def test_remaining_bridge_workflows_delegate_all_jobs_to_public_executors(self):
        expected = {
            "mask-native-bridge.yml": "mask-native-bridge.yml",
            "sa-agent-api-contract.yml": "sa-agent-api-contract.yml",
            "spine-mask-bridge-platform-tests.yml": "spine-mask-bridge-platform-tests.yml",
        }
        for caller_name, executor_name in expected.items():
            caller = ROOT / "repos" / "spine-resize" / ".github" / "workflows" / caller_name
            source = caller.read_text(encoding="utf-8")
            self.assertIn(
                f"uses: SpineAnimator/sa-public-runner/.github/workflows/{executor_name}@",
                source,
            )
            self.assertNotIn("runs-on:", source)
            self.assertNotIn("steps:", source)

    def test_workflow_matrix_literals_are_not_interpolated_by_github(self):
        audit = (ROOT / ".github" / "workflows" / "public-runner-placement-audit.yml").read_text(encoding="utf-8")
        contract = (ROOT / ".github" / "workflows" / "spine-mask-workflow-contract.yml").read_text(encoding="utf-8")
        self.assertNotIn('"${{matrix.os}}"', audit)
        self.assertNotIn("'runs-on: ${{ matrix.os }}'", contract)

    def test_platform_contracts_use_only_the_explicit_public_os_matrix(self):
        source = (ROOT / ".github" / "workflows" / "spine-mask-bridge-platform-tests.yml").read_text(encoding="utf-8")
        self.assertIn("workflow_call:", source)
        self.assertIn("os: [ubuntu-24.04, windows-latest, macos-latest]", source)
        self.assertIn("runs-on: ${{ matrix.os }}", source)
        self.assertNotIn("self-hosted", source.lower())


if __name__ == "__main__":
    unittest.main()
