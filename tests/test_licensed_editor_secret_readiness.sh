#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$ROOT/scripts/check-licensed-editor-secrets.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

assert_contains() {
  grep -Fq -- "$2" "$1" || {
    echo "Expected '$2' in $1" >&2
    exit 1
  }
}
assert_not_contains() {
  if grep -Fq -- "$2" "$1"; then
    echo "Sensitive fixture value leaked into $1" >&2
    exit 1
  fi
}

# No credentials: block the gate, enumerate only the missing secret names,
# and never turn an unconfigured runner into a green workflow.
set +e
env -i PATH="$PATH" \
  GITHUB_OUTPUT="$TMP/missing.out" \
  GITHUB_STEP_SUMMARY="$TMP/missing.md" \
  bash "$CHECK" >"$TMP/missing.stdout" 2>"$TMP/missing.stderr"
status=$?
set -e
test "$status" -ne 0
assert_contains "$TMP/missing.out" "ready=false"
for key in SOURCE_REPO_TOKEN SPINE_LICENSE SPINE_LINUX_URL; do
  assert_contains "$TMP/missing.md" "$key"
done

# All credentials set: readiness can pass, but values must not be echoed.
env -i PATH="$PATH" \
  GITHUB_OUTPUT="$TMP/ready.out" \
  GITHUB_STEP_SUMMARY="$TMP/ready.md" \
  SOURCE_REPO_TOKEN="test-only-github-token" \
  SPINE_LICENSE="test-only-spine-activation-code" \
  SPINE_LINUX_URL="https://example.invalid/spine-4.3.26.tar.gz" \
  bash "$CHECK" >"$TMP/ready.stdout" 2>"$TMP/ready.stderr"
assert_contains "$TMP/ready.out" "ready=true"
for value in test-only-github-token test-only-spine-activation-code https://example.invalid/spine-4.3.26.tar.gz; do
  for file in "$TMP/ready.out" "$TMP/ready.md" "$TMP/ready.stdout" "$TMP/ready.stderr"; do
    assert_not_contains "$file" "$value"
  done
done

# Partial configuration: the summary should identify only what is absent.
set +e
env -i PATH="$PATH" \
  GITHUB_OUTPUT="$TMP/partial.out" \
  GITHUB_STEP_SUMMARY="$TMP/partial.md" \
  SOURCE_REPO_TOKEN="test-only-github-token" \
  SPINE_LICENSE="test-only-spine-activation-code" \
  bash "$CHECK" >"$TMP/partial.stdout" 2>"$TMP/partial.stderr"
status=$?
set -e
test "$status" -ne 0
assert_contains "$TMP/partial.out" "ready=false"
assert_contains "$TMP/partial.md" "SPINE_LINUX_URL"
if grep -Fq "SOURCE_REPO_TOKEN" "$TMP/partial.md" || grep -Fq "SPINE_LICENSE" "$TMP/partial.md"; then
  echo "Readiness summary reported a configured secret as missing" >&2
  exit 1
fi

echo "PASS: missing, complete, and partial licensed-editor secret readiness"
