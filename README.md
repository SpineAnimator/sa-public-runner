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
