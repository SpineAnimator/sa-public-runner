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
