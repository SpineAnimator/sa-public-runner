from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "3spine-saver-selftest.yml"


class SaverPublicExecutorContractTests(unittest.TestCase):
    def test_saver_suite_is_a_reusable_public_ubuntu_workflow(self):
        source = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("workflow_call:", source)
        self.assertIn("SOURCE_REPO_TOKEN:", source)
        self.assertIn("required: true", source)
        self.assertGreaterEqual(source.count("runs-on: ubuntu-24.04"), 2)
        self.assertNotIn("self-hosted", source.lower())

    def test_private_source_is_checked_out_with_explicit_token_and_no_persisted_auth(self):
        source = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("repository: vladleopold/3Spine-core", source)
        self.assertIn("token: ${{ secrets.SOURCE_REPO_TOKEN }}", source)
        self.assertGreaterEqual(source.count("persist-credentials: false"), 2)

    def test_unit_gate_precedes_the_seven_site_capture_matrix(self):
        source = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("run: npm test", source)
        self.assertIn("needs: unit-tests", source)
        self.assertIn("scripts/download-resources.mjs", source)
        self.assertIn('run: node scripts/spine-pack.mjs "$OUTPUT_DIR" "$OUTPUT_DIR"', source)
        self.assertIn("if files <= 0:", source)
        self.assertIn("empty_sites.append(name)", source)
        self.assertIn("fail-fast: false", source)
        self.assertIn("upload-artifact@v4", source)
        self.assertIn("retention-days: 7", source)


if __name__ == "__main__":
    unittest.main()
