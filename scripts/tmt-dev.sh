#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
executable="$repository/rust/target/debug/tmt"

if [ ! -f "$executable" ] || [ ! -x "$executable" ]; then
  printf '%s\n' \
    "Workspace TMT binary is missing or not executable: $executable" \
    'Build from this checkout first: (cd rust && cargo build --locked -p tmt-cli)' \
    'The globally installed tmt will not be used.' >&2
  exit 127
fi

exec "$executable" "$@"
