#!/bin/sh

real_cargo=${TMT_NATIVE_REAL_CARGO:-}
if [ -z "$real_cargo" ]; then
  printf '%s\n' 'TMT_NATIVE_REAL_CARGO must be an absolute executable path.' >&2
  exit 2
fi

case "$real_cargo" in
  /*) ;;
  *)
    printf '%s\n' 'TMT_NATIVE_REAL_CARGO must be an absolute executable path.' >&2
    exit 2
    ;;
esac

if [ ! -x "$real_cargo" ]; then
  printf '%s\n' "TMT_NATIVE_REAL_CARGO is not executable: $real_cargo" >&2
  exit 2
fi

for argument in "$@"; do
  if [ "$argument" = '--locked' ] || [ "$argument" = '--frozen' ]; then
    exec "$real_cargo" "$@"
  fi
done

case "${1:-}" in
  build|metadata)
    exec "$real_cargo" "$@" --locked
    ;;
  *)
    exec "$real_cargo" "$@"
    ;;
esac
