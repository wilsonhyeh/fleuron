#!/bin/bash
set -euo pipefail

die() {
  printf 'render-install-mac: error: %s\n' "$*" >&2
  exit 1
}

is_semver() {
  local v="$1"
  local a="" b="" c="" rest=""
  IFS=. read -r a b c rest <<EOF || true
$v
EOF
  [ -n "$a" ] && [ -n "$b" ] && [ -n "$c" ] && [ -z "$rest" ] || return 1
  [ "${a}.${b}.${c}" = "$v" ] || return 1
  case "${a}${b}${c}" in
    *[!0-9]*) return 1 ;;
  esac
  return 0
}

is_sha256() {
  local h="$1"
  [ "${#h}" -eq 64 ] || return 1
  case "$h" in
    *[!0-9a-f]*) return 1 ;;
  esac
  return 0
}

if [ "$#" -ne 3 ]; then
  die "usage: render-install-mac.sh <version> <path-to-Fleuron_<version>_universal.dmg> <out-path>"
fi

VERSION="$1"
DMG_PATH="$2"
OUT_PATH="$3"

if ! is_semver "$VERSION"; then
  die "invalid version '$VERSION' (expected X.Y.Z)"
fi

if [ ! -f "$DMG_PATH" ]; then
  die "DMG file not found: $DMG_PATH"
fi

if [ ! -s "$DMG_PATH" ]; then
  die "DMG file is empty: $DMG_PATH"
fi

EXPECTED_BASENAME="Fleuron_${VERSION}_universal.dmg"
ACTUAL_BASENAME="${DMG_PATH##*/}"
if [ "$ACTUAL_BASENAME" != "$EXPECTED_BASENAME" ]; then
  die "DMG basename '$ACTUAL_BASENAME' does not match expected '$EXPECTED_BASENAME'"
fi

if [ -z "$OUT_PATH" ]; then
  die "output path must not be empty"
fi

if command -v shasum >/dev/null 2>&1; then
  HASH_OUT="$(shasum -a 256 "$DMG_PATH")"
elif command -v sha256sum >/dev/null 2>&1; then
  HASH_OUT="$(sha256sum "$DMG_PATH")"
else
  die "neither shasum nor sha256sum is available"
fi

DMG_SHA256="${HASH_OUT%% *}"
if ! is_sha256 "$DMG_SHA256"; then
  die "computed invalid SHA-256 hash: '$DMG_SHA256'"
fi

TEMPLATE="$(dirname "$0")/install-mac.sh"
if [ ! -f "$TEMPLATE" ]; then
  die "template not found: $TEMPLATE"
fi

ver_count=0
sha_count=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    'FLEURON_VERSION="__FLEURON_VERSION__"'*)
      if [ "$line" = 'FLEURON_VERSION="__FLEURON_VERSION__"' ]; then
        ver_count=$((ver_count + 1))
      fi
      ;;
    'FLEURON_DMG_SHA256="__FLEURON_DMG_SHA256__"'*)
      if [ "$line" = 'FLEURON_DMG_SHA256="__FLEURON_DMG_SHA256__"' ]; then
        sha_count=$((sha_count + 1))
      fi
      ;;
  esac
done < "$TEMPLATE"

if [ "$ver_count" -ne 1 ]; then
  die "expected exactly 1 FLEURON_VERSION placeholder line in $TEMPLATE, found $ver_count"
fi
if [ "$sha_count" -ne 1 ]; then
  die "expected exactly 1 FLEURON_DMG_SHA256 placeholder line in $TEMPLATE, found $sha_count"
fi

OUT_DIR="$(dirname "$OUT_PATH")"
mkdir -p "$OUT_DIR"

TMP_OUT="${OUT_PATH}.tmp"
cleanup() {
  rm -f "$TMP_OUT"
}
trap cleanup EXIT

sed "s|__FLEURON_VERSION__|${VERSION}|; s|__FLEURON_DMG_SHA256__|${DMG_SHA256}|" "$TEMPLATE" > "$TMP_OUT"

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    *__FLEURON_*)
      die "unreplaced placeholder remains in rendered output: $line"
      ;;
  esac
done < "$TMP_OUT"

if ! "${BASH:-bash}" -n "$TMP_OUT"; then
  die "syntax check failed on rendered script"
fi

chmod 755 "$TMP_OUT"
mv "$TMP_OUT" "$OUT_PATH"
trap - EXIT

printf 'rendered %s: version %s, dmg sha256 %s\n' "$OUT_PATH" "$VERSION" "$DMG_SHA256"
