#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"

required=(SOURCE_REPO_TOKEN SPINE_LICENSE SPINE_LINUX_URL)
missing=()
for key in "${required[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    missing+=("$key")
  fi
done

if (("${#missing[@]}" > 0)); then
  printf 'ready=false\n' >> "$GITHUB_OUTPUT"
  {
    echo "## Licensed Editor readiness"
    echo "**BLOCKED** — required repository Actions secrets are missing: ${missing[*]}."
    echo
    echo "Configure the missing names in **Settings → Secrets and variables → Actions** for this repository, then rerun this workflow."
  } >> "$GITHUB_STEP_SUMMARY"
  echo "::error::Licensed Spine Editor gate is blocked because required Actions secrets are missing: ${missing[*]}."
  exit 1
fi

printf 'ready=true\n' >> "$GITHUB_OUTPUT"
{
  echo "## Licensed Editor readiness"
  echo "All required credentials are configured. Starting the licensed native gate on public Ubuntu 24.04."
} >> "$GITHUB_STEP_SUMMARY"
