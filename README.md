# SA Public Runner

Free, ephemeral Ubuntu Linux CI workspace for task-scoped SA code and test validation. This repository is public: every committed task branch and file is publicly readable.

## Operating model

- Keep `main` limited to this runner contract.
- Put one SA task in its own `task/<task-id>` branch.
- Transfer the task's required source modules and tests from the private SA repository into that branch; task code committed here becomes public.
- Keep account uploads, original customer PSDs, generated ZIPs and videos in the private `spine-animation-library` task vault, not in this public runner.
- A push to `task/**` starts the Ubuntu 24.04 GitHub-hosted CI workflow.
- Collect the `sa-ubuntu-linux-ci-results` artifact (7-day retention); persist approved deliverables separately in the private task vault.

## Ubuntu CI profile

- GitHub-hosted `ubuntu-24.04` runner (Linux x86_64 image).
- Python 3.12: bytecode compilation and unittest discovery.
- Node.js 22: syntax validation and built-in test runner.
- Rust stable: rustfmt, Clippy with warnings denied, and locked Cargo tests.
- ShellCheck is installed only when shell scripts are present.
- Runner diagnostics and test logs are retained in a 7-day artifact.
- Toolchains are skipped when their source files are absent; Rust requires a committed `Cargo.lock`.

## Safety boundary

Do not commit credentials, access tokens, passwords, customer account data, original user uploads,
licensed Spine Editor binaries/assets, or confidential task deliverables here. Task source modules
and tests deliberately transferred from the private SA repository are visible to everyone because
this repository is public. Workflows receive no repository secrets, use read-only repository
permissions, and checkout without persisting credentials. Treat task-branch contents as untrusted executable code.

This runner validates public fixtures and isolated components. It does not by itself prove
private-repository integration, PSD extraction fidelity, Spine ZIP correctness, or licensed
Spine Editor import/runtime behavior.
