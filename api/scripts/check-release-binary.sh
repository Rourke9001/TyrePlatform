#!/bin/sh
# U103 (ADR-0016): the release binary must not contain the dev header
# resolver. Builds the way api/Dockerfile does, and builds the devheader
# variant as a control, so a grep that could never match cannot pass.
set -eu
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o "$out/release" ./cmd/api
CGO_ENABLED=0 go build -tags devheader -trimpath -ldflags='-s -w' -o "$out/dev" ./cmd/api
for header in X-Tenant-ID X-User-ID; do
  if ! grep -qi "$header" "$out/dev"; then
    echo "control failed: the devheader build does not contain $header, so this check cannot see it" >&2
    exit 1
  fi
  if grep -qi "$header" "$out/release"; then
    echo "the release binary contains $header: the dev header resolver is compiled in (U103)" >&2
    exit 1
  fi
done
echo "the release binary names no dev header"
