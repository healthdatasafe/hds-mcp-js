#!/usr/bin/env bash
# Build the Claude Desktop extension (.mcpb) of the stdio server, with the local import tools on
# (HDS_MCP_IMPORT=true in mcpb/manifest.json). Plan 130 (site-agents#36 A4/A5).
#
# Stages dist/ + package.json + production dependencies (no dev, no optional: no telemetry from a
# person's machine), stamps the package version into the manifest, validates it, packs build/hds-mcp-<v>.mcpb.
#
# Usage: scripts/build-mcpb.sh
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(pwd)
mcpb="$root/node_modules/.bin/mcpb"
[ -x "$mcpb" ] || { echo "build-mcpb: run npm ci first (@anthropic-ai/mcpb is a devDependency)" >&2; exit 1; }

npm run build
version=$(node -p "require('./package.json').version")
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp -R dist package.json package-lock.json LICENSE "$stage/"
node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('mcpb/manifest.json', 'utf8'));
m.version = '$version';
fs.writeFileSync('$stage/manifest.json', JSON.stringify(m, null, 2) + '\n');
"
(cd "$stage" && npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund >/dev/null)
"$mcpb" validate "$stage/manifest.json"
mkdir -p build
out="$root/build/hds-mcp-$version.mcpb"
rm -f "$out"
"$mcpb" pack "$stage" "$out"
echo "build-mcpb: $out"
