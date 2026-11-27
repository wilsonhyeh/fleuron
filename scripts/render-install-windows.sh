#!/bin/bash
set -euo pipefail

die() {
  printf 'render-install-windows: error: %s\n' "$*" >&2
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
  die "usage: render-install-windows.sh <version> <path-to-Fleuron_<version>_x64-setup.exe> <out-path>"
fi

VERSION="$1"
SETUP_PATH="$2"
OUT_PATH="$3"

if ! is_semver "$VERSION"; then
  die "invalid version '$VERSION' (expected X.Y.Z)"
fi

if [ ! -f "$SETUP_PATH" ]; then
  die "setup file not found: $SETUP_PATH"
fi

if [ ! -s "$SETUP_PATH" ]; then
  die "setup file is empty: $SETUP_PATH"
fi

EXPECTED_BASENAME="Fleuron_${VERSION}_x64-setup.exe"
ACTUAL_BASENAME="${SETUP_PATH##*/}"
if [ "$ACTUAL_BASENAME" != "$EXPECTED_BASENAME" ]; then
  die "setup file basename '$ACTUAL_BASENAME' does not match expected '$EXPECTED_BASENAME'"
fi

if [ -z "$OUT_PATH" ]; then
  die "output path must not be empty"
fi

if command -v shasum >/dev/null 2>&1; then
  HASH_OUT="$(shasum -a 256 "$SETUP_PATH")"
elif command -v sha256sum >/dev/null 2>&1; then
  HASH_OUT="$(sha256sum "$SETUP_PATH")"
else
  die "neither shasum nor sha256sum is available"
fi

SETUP_SHA256="${HASH_OUT%% *}"
if ! is_sha256 "$SETUP_SHA256"; then
  die "computed invalid SHA-256 hash: '$SETUP_SHA256'"
fi

TEMPLATE="$(dirname "$0")/install-windows.ps1"
if [ ! -f "$TEMPLATE" ]; then
  die "template not found: $TEMPLATE"
fi

VER_LINE="\$FleuronVersion = '__FLEURON_VERSION__'"
SHA_LINE="\$FleuronSetupSha256 = '__FLEURON_SETUP_SHA256__'"
ver_count=0
sha_count=0
marker_lines=0
while IFS= read -r line || [ -n "$line" ]; do
  if [ "$line" = "$VER_LINE" ]; then
    ver_count=$((ver_count + 1))
  fi
  if [ "$line" = "$SHA_LINE" ]; then
    sha_count=$((sha_count + 1))
  fi
  case "$line" in
    *__FLEURON_*)
      marker_lines=$((marker_lines + 1))
      ;;
  esac
done < "$TEMPLATE"

if [ "$ver_count" -ne 1 ] || [ "$sha_count" -ne 1 ] || [ "$marker_lines" -ne 2 ]; then
  die "expected 1 version placeholder ($ver_count), 1 sha256 placeholder ($sha_count), and 2 marker lines ($marker_lines) in $TEMPLATE"
fi

OUT_DIR="$(dirname "$OUT_PATH")"
mkdir -p "$OUT_DIR"

TMP_OUT="${OUT_PATH}.tmp"
cleanup() {
  rm -f "$TMP_OUT"
}
trap cleanup EXIT

sed "s|__FLEURON_VERSION__|${VERSION}|; s|__FLEURON_SETUP_SHA256__|${SETUP_SHA256}|" "$TEMPLATE" > "$TMP_OUT"

EXPECTED_VER_LINE="\$FleuronVersion = '${VERSION}'"
EXPECTED_SHA_LINE="\$FleuronSetupSha256 = '${SETUP_SHA256}'"
rendered_ver_count=0
rendered_sha_count=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    *__FLEURON_*)
      die "unreplaced placeholder remains in rendered output: $line"
      ;;
  esac
  if [ "$line" = "$EXPECTED_VER_LINE" ]; then
    rendered_ver_count=$((rendered_ver_count + 1))
  fi
  if [ "$line" = "$EXPECTED_SHA_LINE" ]; then
    rendered_sha_count=$((rendered_sha_count + 1))
  fi
done < "$TMP_OUT"

if [ "$rendered_ver_count" -ne 1 ]; then
  die "expected exactly 1 rendered version line in $TMP_OUT, found $rendered_ver_count"
fi
if [ "$rendered_sha_count" -ne 1 ]; then
  die "expected exactly 1 rendered sha256 line in $TMP_OUT, found $rendered_sha_count"
fi

if LC_ALL=C grep -q '[^[:cntrl:][:print:]]' "$TMP_OUT"; then
  die "rendered output contains non-ASCII bytes"
fi

PS_PARSE='$tokens = $null; $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:FLEURON_PS_PARSE_TARGET, [ref]$tokens, [ref]$errors); if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }'
case "$TMP_OUT" in
  /*) abs="$TMP_OUT" ;;
  *) abs="$PWD/$TMP_OUT" ;;
esac
if command -v pwsh >/dev/null 2>&1; then
  FLEURON_PS_PARSE_TARGET="$abs" pwsh -NoProfile -NonInteractive -Command "$PS_PARSE" >/dev/null || die "PowerShell parse check failed on rendered script"
else
  printf 'render-install-windows: note: pwsh not found; PowerShell parse check skipped here (release.yml runs it and fails closed)\n' >&2
fi

chmod 644 "$TMP_OUT"
mv "$TMP_OUT" "$OUT_PATH"
trap - EXIT

printf 'rendered %s: version %s, setup sha256 %s\n' "$OUT_PATH" "$VERSION" "$SETUP_SHA256"
