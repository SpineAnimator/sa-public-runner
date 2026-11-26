from pathlib import Path
import re
import sys

REPOSITORIES = [
    Path("."),
    Path("repos/sa-psd-tool-runner"),
    Path("repos/2Spine-visual-audit"),
    Path("repos/spine-scripts"),
    Path("repos/Spine-Link-project-export"),
    Path("repos/spine-link-computer"),
    Path("repos/Spine-Resize"),
    Path("repos/spine-web-source"),
]
ALLOWED_UBUNTU = {"ubuntu-latest", "ubuntu-22.04", "ubuntu-24.04", "ubuntu-slim"}
BRIDGE_MATRIX = {"ubuntu-24.04", "windows-latest", "macos-latest"}


def runner_is_allowed(path: Path, value: str, workflow_text: str) -> bool:
    value = value.strip().strip('"').strip("'")
    if value in ALLOWED_UBUNTU:
        return True
    normalized = path.as_posix()
    if normalized == ".github/workflows/build-mask-bridge.yml":
        return value in {"windows-latest", "macos-latest"}
    if normalized == ".github/workflows/spine-mask-bridge-platform-tests.yml":
        if value != "${{ matrix.os }}":
            return False
        match = re.search(r"(?m)^\s*os:\s*\[([^]]+)\]\s*$", workflow_text)
        if not match:
            return False
        matrix = {item.strip().strip('"').strip("'") for item in match.group(1).split(",")}
        return matrix == BRIDGE_MATRIX
    if value == "macos-latest" and path.name == "2spine-private-ci.yml" and "  macos-app:" in workflow_text:
        return True
    return False


def audit(root: Path = Path(".")) -> int:
    failures = []
    total = 0
    for relative in REPOSITORIES:
        repository = root / relative
        workflow_dir = repository / ".github" / "workflows"
        if not workflow_dir.is_dir():
            if relative.name == "spine-scripts":
                print(f"{relative}: no workflow directory; no Action jobs to audit")
                continue
            failures.append(f"{relative}: missing .github/workflows")
            continue
        for path in sorted(workflow_dir.rglob("*")):
            if path.suffix not in {".yml", ".yaml"}:
                continue
            source = path.read_text(encoding="utf-8")
            for number, line in enumerate(source.splitlines(), 1):
                match = re.match(r"^\s*runs-on:\s*(.*?)\s*$", line)
                if not match:
                    continue
                total += 1
                value = match.group(1).strip()
                if not runner_is_allowed(path.relative_to(root), value, source):
                    failures.append(
                        f"{path}:{number}: runs-on={value!r}; expected public Ubuntu, "
                        "or the explicitly approved public Bridge platform jobs"
                    )
    print(f"WORKFLOW_RUNNER_JOBS_SCANNED={total}")
    print("APPROVED_EXECUTION_REPOSITORIES=" + ",".join(path.as_posix() for path in REPOSITORIES))
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    if total == 0:
        print("No workflow jobs with explicit runs-on were found", file=sys.stderr)
        return 1
    print("PUBLIC_UBUNTU_RUNNER_POLICY_PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(audit())
