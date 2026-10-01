#!/bin/sh
# U103 (ADR-0016): the release binary must not contain the dev header
# resolver. api/Dockerfile's build stage runs this on the binary the image
# ships, beside a devheader control built the same way, so a grep that could
# never match cannot pass.
set -eu
[ "$#" -eq 2 ] || { echo "usage: $0 RELEASE CONTROL" >&2; exit 2; }
release=$1
control=$2
for bin in "$release" "$control"; do
  [ -s "$bin" ] || { echo "$bin is missing or empty" >&2; exit 1; }
done

# grep exits 2 on a file it cannot read, which an if would take as no match.
found() {
  st=0
  grep -qiF "$1" "$2" || st=$?
  case $st in
    0) return 0 ;;
    1) return 1 ;;
    *) echo "grep could not read $2 (exit $st)" >&2; exit 1 ;;
  esac
}

for header in X-Tenant-ID X-User-ID; do
  if ! found "$header" "$control"; then
    echo "control failed: the devheader build does not contain $header, so this check cannot see it" >&2
    exit 1
  fi
  if found "$header" "$release"; then
    echo "the release binary contains $header: the dev header resolver is compiled in (U103)" >&2
    exit 1
  fi
done
echo "the release binary names no dev header"
