# SA Core Vision / Animation Planner — public CI task

This branch is a task-scoped, publicly readable validation snapshot from `SpineAnimator/spine-animator-private` at commit `2f19c316eb7a540c4da38ce858853772d16673ce`.

## Scope
- Semantic contour rendering and reconstruction QA
- Semantic anatomy plan and layer-budget optimization
- Scene IR, vision adapter and animation planner
- SA tool registry / orchestration adapter
- Job handoff HTTP contract

The Ubuntu 24.04 task workflow validates these modules with Node.js 22. This is isolated component validation, not proof of full private-repository integration or artistic correctness.

## Public-data boundary
This branch intentionally publishes only the listed task-specific source modules and tests for CI. It contains no original PSD/customer uploads, credentials, tokens, private keys, licensed Spine Editor binaries/assets, or production build outputs. The source and tests in this branch are publicly readable.

## Execution
A push to this `task/**` branch starts `SA Ubuntu Linux CI`. The job checks JavaScript syntax and runs Node's test discovery, then uploads the result artifact with seven-day retention.


## Live PSD → PNG → Spine runtime gate

The follow-on workflow `clgb71-live-psd-spine-runtime.yml` downloads the exact approved `clgb71.psd` only at job runtime through the SHA-verified Cloudflare KV route, derives the 38-layer manifest, extracts original PNGs into ephemeral workspace storage, builds and validates a Spine 4.3 runtime package, and runs contact/fidelity gates. The original PSD, extracted PNGs, and generated ZIP are never committed or uploaded as artifacts; only non-pixel integrity and diagnostic JSON reports are retained. Native licensed Spine Editor 4.3.26 import remains a separate gate and is not claimed by the runtime test.

## Verified live-source runtime result

- Public PSD/runtime workflow: [run #45136347191](https://github.com/SpineAnimator/sa-public-runner/actions/runs/45136347191)
- Report-only artifact: [artifact #14799483935](https://github.com/SpineAnimator/sa-public-runner/actions/runs/45136347191/artifacts/14799483935)
- Exact source SHA-256: `7adee866547a3b3cc9838b655cf70865980c5dba00313373cbf903fed776c7b2`
- All 38 exported PNG layers are pixel-identical to their PSD source layers; draw order is preserved.
- Spine runtime geometry passed: 2 IK constraints, 1 weighted mesh, 122 frames, two animation clips; 60 Hz hand/weapon contact guard passed.
- The generated ZIP was validated in the ephemeral runner workspace and then deleted; it is not part of the public artifact.
- **Not release-ready:** Photoshop composite parity is not proven (81.1% of measured RGB error lies outside the modeled shadow footprints; outside opaque RGB MAE 10.4568/255). The runtime report explicitly sets `artistApproved=false`, `spine_editor_import_verified=false`, and `visual_quality_verified=false`.
- Native licensed Spine Editor 4.3.26 import/round-trip has not been run. The existing licensed workflow is in a private repository and requires secrets; it was not triggered. The connected iMac was offline.
- No production deployment was performed.

## Remaining release gates

1. Explain and correct the PSD-to-Spine composite mismatch without altering original layer pixels or order.
2. Obtain an actual licensed Spine Editor 4.3.26 import, reopen, rerender and round-trip verification.
3. Obtain independent artistic/anatomy approval before treating the ZIP as release-ready.

## Latest source-compositing diagnostic

The latest report-only artifact is [#14800162126](https://github.com/SpineAnimator/sa-public-runner/actions/runs/45136754842/artifacts/14800162126), from [public Ubuntu run #45136754842](https://github.com/SpineAnimator/sa-public-runner/actions/runs/45136754842).

The PSD profile identifies four SmartObject layers (`card-9`, `card-7`, `card-5`, `card-2`) with Photoshop `DropShadow` styles (4° angle, 3 px distance, 2 px size, 65% opacity). Those effects are not represented by the current Spine slot data. The measured effect footprint covers 6.79% of the canvas, while 81.10% of the saved-preview/recomposition RGB error is outside that modeled footprint; outside opaque RGB MAE is 10.4568/255. The PSD has no embedded ICC profile. The cause of the broad mismatch is not proven, and neither saved preview nor recomposition has been approved as visual truth.

Therefore, the runtime pipeline is technically green, but the asset is **not release-ready**: `artistApproved=false`, `photoshop_parity_proven=false`, and `spine_editor_import_verified=false`. Do not deploy or label the Spine 4.3.26 Editor E2E as passed.

## Native Spine Editor 4.3.26 gate — prepared, currently blocked

The public workflow now contains the licensed Editor import/reopen/round-trip/render path and the PSD-vs-Editor color audit. It checks the public runner's secret store without printing values. Latest run [#45137717984](https://github.com/SpineAnimator/sa-public-runner/actions/runs/45137717984) recorded `blocked_missing_public_runner_secrets`: `SPINE_LICENSE` and `SPINE_LINUX_URL` are not available to this public repository, so the licensed Editor steps were skipped. No private GitHub Actions were triggered. The connected iMac remains offline.

To unblock without exposing a license in chat: add `SPINE_LICENSE` and `SPINE_LINUX_URL` under **SpineAnimator/sa-public-runner → Settings → Secrets and variables → Actions**, then rerun `clgb71-live-psd-spine-runtime.yml` on this task branch. The workflow will import, reopen and round-trip the ZIP in actual Spine Editor 4.3.26, render both clips, and compare native frames with the PSD references. A failed color-parity audit will remain a release blocker.

No production deployment has been performed.

## Latest native Editor gate result

The public workflow now checks the secret store without printing values. Latest run [#45138071384](https://github.com/SpineAnimator/sa-public-runner/actions/runs/45138071384) confirms that **both** `SPINE_LICENSE` and `SPINE_LINUX_URL` are absent from `SpineAnimator/sa-public-runner`. Therefore the native Editor install/import/render steps were skipped and the report records `blocked_missing_public_runner_secrets`. The runtime/PSD pipeline still passed; this is not a native Editor pass. No private GitHub Actions were used.

To unblock on the public runner, add those two values as repository secrets under **Settings → Secrets and variables → Actions** in `SpineAnimator/sa-public-runner`, then rerun `clgb71-live-psd-spine-runtime.yml` on this task branch. Do not send either license value in chat. If the secrets should not be stored in the public runner, the alternative is to bring the licensed iMac online for the native import; it is currently offline.

## Latest public Ubuntu CI confirmation

Latest generic public CI: [run #94](https://github.com/SpineAnimator/sa-public-runner/actions/runs/45214842822), on the current branch head `2e92520877e9b061772110a50541568c3d9de550`. Ubuntu 24.04 completed successfully: Python 21 passed; Node 92 tests (91 passed, 0 failed, 1 skipped); Rust 4 passed; Clippy passed; ShellCheck passed. The single Node skip is the live PSD-specific test, which is exercised in the dedicated PSD/runtime workflow.

Latest live PSD/runtime gate remains [run #5](https://github.com/SpineAnimator/sa-public-runner/actions/runs/45138071384), with report-only [artifact #14799954723](https://github.com/SpineAnimator/sa-public-runner/actions/runs/45138071384/artifacts/14799954723). Its technical source extraction, 38-layer pixel identity, IK/runtime, and contact checks passed. The licensed native Spine Editor steps were skipped because both `SPINE_LICENSE` and `SPINE_LINUX_URL` are absent from the public repository's Actions secrets. The connected iMac is currently offline.

Photoshop composite parity and native Editor import/reopen/render remain unverified. Artistic approval remains false, release readiness remains false, and no production deployment has been performed.
