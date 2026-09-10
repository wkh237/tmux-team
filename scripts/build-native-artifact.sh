#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  printf '%s\n' 'Usage: scripts/build-native-artifact.sh <cargo-dist target> [cli|office]' >&2
  exit 2
fi
target=$1
product=${2:-cli}
case "$product" in cli|office) ;; *) printf '%s\n' 'Unknown native product.' >&2; exit 2 ;; esac
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
package_id=$(cargo pkgid --locked -p "tmt-$product")
# Cargo emits either #version or #name@version for a resolved package ID.
version=${package_id##*#}
version=${version##*@}
tag="v$version"
if [ "$product" = office ]; then tag="tmt-office-v$version"; fi
# cargo-dist checks its own version against dist-workspace.toml.
cd "$repo"
dist generate --check --target "$target" --tag "$tag"
cd "$repo/rust"
mkdir -p target/native-notices
cargo-about generate --manifest-path "crates/tmt-$product/Cargo.toml" \
  --config about.toml --target "$target" --locked --offline --fail about.hbs \
  --output-file target/native-notices/THIRD-PARTY-NOTICES.txt

# Keep diagnostics on stderr and cargo-dist's authoritative manifest on stdout.
# Callers save stdout alongside the archives, then run the independent verifier.
cd "$repo"
dist build --artifacts local --target "$target" --tag "$tag" --output-format=json --no-local-paths
