# SA Public Runner

Ephemeral, public CI workspace for **non-sensitive** task-specific validation.

## Operating model

- Keep `main` limited to this runner contract.
- Put one task in a short-lived `task/<task-id>` branch.
- Push tests and fixtures that are explicitly safe to publish.
- A push to `task/**` starts the public GitHub-hosted runner workflow.
- Collect the `sa-task-results` artifact, then delete the task branch.

## Safety boundary

Never push private SA source code, credentials, access tokens, private PSDs, customer data,
licensed Spine Editor binaries/assets, or confidential build outputs here. This is a public
repository. Workflows receive no repository secrets and have read-only repository permissions.
Treat task-branch contents as untrusted executable code.

This runner can validate public fixtures and isolated components. It does not by itself prove
private-repository integration or licensed Spine Editor import/runtime behavior.

## Supported automatic test discovery

The workflow runs available checks without installing project dependencies:
- Python: `python -m unittest discover -s tests -p 'test*.py'` when matching tests exist.
- Node.js: `node --test` when matching `*.test.js`, `*.test.cjs`, or `*.test.mjs` files exist.
- Rust: `cargo test --locked` when a `Cargo.toml` exists (requires a committed lockfile).

Add only self-contained tests that run with tools preinstalled on the runner. Extend the
workflow deliberately if a task needs another toolchain.
