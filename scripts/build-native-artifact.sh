#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Usage: scripts/build-native-artifact.sh <cargo-dist target>' >&2
  exit 2
fi
target=$1
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$repo/rust"
# Resolve the repository toolchain before cargo-dist discovers the generic root
# workspace. Source archives/containers need not contain Git metadata.
selected_toolchain=$(rustup show active-toolchain)
RUSTUP_TOOLCHAIN=${selected_toolchain%% *}
export RUSTUP_TOOLCHAIN

# Developer tools only; do not silently install tools or change release settings.
test "$(cargo-about --version)" = 'cargo-about 0.9.2' || {
  printf '%s\n' 'Native packaging requires cargo-about 0.9.2.' >&2
  exit 2
}
TMT_NATIVE_REAL_CARGO=${TMT_NATIVE_REAL_CARGO:-$(command -v cargo)}
export TMT_NATIVE_REAL_CARGO
CARGO="$repo/scripts/native-cargo.sh"
export CARGO
# cargo-dist checks its own version against dist-workspace.toml.
cd "$repo"
dist generate --check --target "$target"
cd "$repo/rust"
mkdir -p target/native-notices
cargo-about generate --manifest-path crates/tmt-cli/Cargo.toml \
  --config about.toml --target "$target" --locked --offline --fail about.hbs \
  --output-file target/native-notices/THIRD-PARTY-NOTICES.txt

# Keep diagnostics on stderr and cargo-dist's authoritative manifest on stdout.
# Callers save stdout alongside the archives, then run the independent verifier.
cd "$repo"
dist build --artifacts local --target "$target" --output-format=json --no-local-paths
