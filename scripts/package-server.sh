#!/usr/bin/env bash
#
# Bundles the API Lambda (packages/server/src/lambda.ts, export `handler`)
# into a content-hashed zip for `make deploy-backend`.
#
# esbuild produces one ESM file, index.mjs, for Node 22 on arm64 (the
# template's `Runtime: nodejs22.x`, `Handler: index.handler`). Everything is
# bundled, the AWS SDK included, so the deployed code runs exactly the
# dependency versions the lockfile pins rather than whatever SDK the runtime
# happens to ship.
#
# The S3 key is content-hashed (server/<sha>.zip): CloudFormation only rolls a
# Lambda when a property it can see changes, and for an S3-sourced function
# that property is the key.
#
# Usage:
#   scripts/package-server.sh                  # build into .build/server
#   SERVER_BUILD_DIR=/tmp/x scripts/...        # build somewhere else
#
# Writes <build-dir>/artifact.env with ARTIFACT_ZIP / ARTIFACT_SHA /
# ARTIFACT_KEY for `make deploy-backend` to source. Makes no AWS calls.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="${SERVER_ENTRY:-${ROOT}/packages/server/src/lambda.ts}"
BUILD_DIR="${SERVER_BUILD_DIR:-${ROOT}/.build/server}"
STAGING="${BUILD_DIR}/staging"

log() { printf '\033[1m==>\033[0m %s\n' "$*" >&2; }

if [ ! -f "${ENTRY}" ]; then
  echo "package-server: the API entrypoint ${ENTRY#"${ROOT}"/} does not exist." >&2
  echo "                It must export \`handler\` (the Lambda handler the template names as index.handler)." >&2
  exit 1
fi
command -v zip >/dev/null || { echo "package-server: zip is required" >&2; exit 1; }
[ -x "${ROOT}/node_modules/.bin/esbuild" ] || {
  echo "package-server: esbuild is missing; run npm ci at the repo root" >&2
  exit 1
}

rm -rf "${STAGING}"
mkdir -p "${STAGING}" "${BUILD_DIR}"

# Workspace packages (@fantasy/core, ...) resolve to their compiled dist/ for
# `import`, so compile them first. The SPA (app/) is not part of the bundle.
if [ "${SERVER_SKIP_WORKSPACE_BUILD:-0}" != "1" ]; then
  for pkg in "${ROOT}"/packages/*/; do
    [ -f "${pkg}package.json" ] || continue
    log "Building workspace ${pkg#"${ROOT}"/}"
    ( cd "${ROOT}" && npm run build --if-present --workspace="${pkg#"${ROOT}"/}" >/dev/null )
  done
fi

log "Bundling ${ENTRY#"${ROOT}"/} with esbuild"
# The banner gives bundled CommonJS dependencies a `require` inside ESM.
"${ROOT}/node_modules/.bin/esbuild" "${ENTRY}" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --minify \
  --sourcemap \
  --legal-comments=none \
  --main-fields=module,main \
  --banner:js="import { createRequire as __fantasyCreateRequire } from 'node:module'; const require = __fantasyCreateRequire(import.meta.url);" \
  --outfile="${STAGING}/index.mjs" \
  --log-level=warning

UNZIPPED_KB="$(du -sk "${STAGING}" | cut -f1)"

# Zip deterministically enough that an unchanged bundle hashes the same:
# sorted entries, no extra attributes, normalised timestamps.
log "Zipping"
STAGED_ZIP="${BUILD_DIR}/server.zip"
rm -f "${STAGED_ZIP}"
find "${STAGING}" -exec touch -t 198001010000 {} + 2>/dev/null || true
( cd "${STAGING}" && find . -type f | LC_ALL=C sort | zip -qX "${STAGED_ZIP}" -@ )

ARTIFACT_SHA="$(sha256sum "${STAGED_ZIP}" | cut -c1-16)"
ARTIFACT_KEY="server/${ARTIFACT_SHA}.zip"
ARTIFACT_ZIP="${BUILD_DIR}/${ARTIFACT_SHA}.zip"
mv -f "${STAGED_ZIP}" "${ARTIFACT_ZIP}"

cat > "${BUILD_DIR}/artifact.env" <<ENV
ARTIFACT_ZIP=${ARTIFACT_ZIP}
ARTIFACT_SHA=${ARTIFACT_SHA}
ARTIFACT_KEY=${ARTIFACT_KEY}
ENV

log "Artifact: ${ARTIFACT_ZIP} ($(du -h "${ARTIFACT_ZIP}" | cut -f1) zipped, $((UNZIPPED_KB / 1024)) MB unzipped)"
log "S3 key:   ${ARTIFACT_KEY}"

if [ "${UNZIPPED_KB}" -gt 245760 ]; then
  echo "package-server: unzipped size $((UNZIPPED_KB / 1024)) MB is at/over Lambda's 250 MB limit." >&2
  exit 1
fi
