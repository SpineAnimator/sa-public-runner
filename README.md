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
