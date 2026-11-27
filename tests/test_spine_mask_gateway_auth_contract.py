from pathlib import Path
import re
import unittest


WORKFLOW = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "spine-mask-full-project-ubuntu.yml"


class SpineMaskGatewayAuthContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = WORKFLOW.read_text(encoding="utf-8")

    def test_private_queue_token_is_the_cross_repository_source_token(self):
        self.assertRegex(
            self.source,
            r"(?m)^\s*GH_TOKEN:\s*\$\{\{\s*secrets\.SOURCE_REPO_TOKEN\s*\}\}\s*$",
            "The gateway validates the bearer token against the private 3Spine-core repo; "
            "do not send the caller-scoped github.token.",
        )
        self.assertNotRegex(
            self.source,
            r"(?m)^\s*GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}\s*$",
        )

    def test_private_source_token_is_a_required_reusable_workflow_secret(self):
        self.assertRegex(
            self.source,
            r"(?ms)^\s{6}SOURCE_REPO_TOKEN:\s*\n\s{8}required:\s*true\s*$",
            "The workflow checks out private 3Spine-core and authenticates the gateway with this token.",
        )


if __name__ == "__main__":
    unittest.main()
