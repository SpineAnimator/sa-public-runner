# SA Public Runner

Free, ephemeral Ubuntu Linux CI workspace for **non-sensitive** task-specific validation.

## Operating model

- Keep `main` limited to this runner contract.
- Put one task in a short-lived `task/<task-id>` branch.
- Push only tests and fixtures explicitly safe to publish.
- A push to `task/**` starts the Ubuntu 24.04 GitHub-hosted CI workflow.
- Collect the `sa-ubuntu-linux-ci-results` artifact, then remove the task branch when possible.

## Ubuntu CI profile

- GitHub-hosted `ubuntu-24.04` runner (Linux x86_64 image).
- Python 3.12: bytecode compilation and unittest discovery.
- Node.js 22: syntax validation and built-in test runner.
- Rust stable: rustfmt, Clippy with warnings denied, and locked Cargo tests.
- ShellCheck is installed only when shell scripts are present.
- Runner diagnostics and test logs are retained in a 7-day artifact.
- Toolchains are skipped when their source files are absent; Rust requires a committed `Cargo.lock`.

## Safety boundary

Never push private SA source code, credentials, access tokens, private PSDs, customer data,
licensed Spine Editor binaries/assets, or confidential build outputs here. This is a public
repository. Workflows receive no repository secrets, use read-only repository permissions,
and checkout without persisting credentials. Treat task-branch contents as untrusted executable code.

This runner validates public fixtures and isolated components. It does not by itself prove
private-repository integration, PSD extraction fidelity, Spine ZIP correctness, or licensed
Spine Editor import/runtime behavior.
