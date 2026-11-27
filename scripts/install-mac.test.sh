#!/bin/bash
# Mocked offline test suite for scripts/install-mac.sh and scripts/render-install-mac.sh.
# Bash 3.2 compatible (runs on Linux CI/host and macOS /bin/bash).
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$ROOT/scripts/install-mac.sh"
RENDERER="$ROOT/scripts/render-install-mac.sh"

PASS=0
FAIL=0

T="$(mktemp -d)"
trap 'chmod -R u+rwx "$T" >/dev/null 2>&1 || true; rm -rf "$T"' EXIT

pass() {
  printf '  ✓ %s\n' "$1"
  PASS=$((PASS + 1))
}

fail() {
  printf '  ✗ %s: %s\n' "$1" "$2"
  FAIL=$((FAIL + 1))
}

skip() {
  printf '  · %s (skipped: %s)\n' "$1" "$2"
}

# Build a fake Fleuron.app bundle.
# Usage: make_app <parent_dir> <version> [bundle_id] [dv_text]
make_app() {
  local parent="$1"
  local ver="$2"
  local bid="${3:-study.fleuron.desktop}"
  local dv="${4:-}"
  local app="$parent/Fleuron.app"

  mkdir -p "$app/Contents/MacOS"
  cat > "$app/Contents/Info.plist" <<EOF
CFBundleIdentifier=$bid
CFBundleShortVersionString=$ver
EOF
  if [ -n "$dv" ]; then
    printf '%s\n' "$dv" > "$app/Contents/_codesign_dv.txt"
  else
    cat > "$app/Contents/_codesign_dv.txt" <<EOF
Identifier=$bid
Signature=adhoc
TeamIdentifier=not set
EOF
  fi
  printf '#!/bin/sh\nexit 0\n' > "$app/Contents/MacOS/Fleuron"
  chmod +x "$app/Contents/MacOS/Fleuron"
}

compute_sha256() {
  local f="$1"
  local out=""
  if command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 "$f")"
  else
    out="$(sha256sum "$f")"
  fi
  printf '%s' "${out%% *}"
}

# ── Build sysroot with real core tools + mocked macOS/network tools ──────────
SYSROOT="$T/sysroot"
mkdir -p "$SYSROOT"

for real_cmd in mktemp rm mv mkdir; do
  real_path="$(command -v "$real_cmd")"
  ln -s "$real_path" "$SYSROOT/$real_cmd"
done

REAL_SHASUM="$(command -v shasum || true)"
REAL_SHA256SUM="$(command -v sha256sum || true)"

cat > "$SYSROOT/uname" <<'EOF'
#!/bin/bash
PATH=/usr/bin:/bin
[ -n "${MOCK_LOG:-}" ] && printf 'uname %s\n' "$*" >> "$MOCK_LOG"
case "${1:-}" in
  -s) printf '%s\n' "${MOCK_UNAME_S:-Darwin}" ;;
  -m) printf '%s\n' "arm64" ;;
  *)  printf '%s\n' "${MOCK_UNAME_S:-Darwin}" ;;
esac
EOF

cat > "$SYSROOT/id" <<'EOF'
#!/bin/bash
PATH=/usr/bin:/bin
[ -n "${MOCK_LOG:-}" ] && printf 'id %s\n' "$*" >> "$MOCK_LOG"
case "${1:-}" in
  -u) printf '%s\n' "${MOCK_UID:-501}" ;;
  *)  printf '%s\n' "${MOCK_UID:-501}" ;;
esac
EOF

cat > "$SYSROOT/sw_vers" <<'EOF'
#!/bin/bash
PATH=/usr/bin:/bin
[ -n "${MOCK_LOG:-}" ] && printf 'sw_vers %s\n' "$*" >> "$MOCK_LOG"
printf '%s\n' "${MOCK_SWVERS:-15.1}"
EOF

cat > "$SYSROOT/pgrep" <<'EOF'
#!/bin/bash
PATH=/usr/bin:/bin
[ -n "${MOCK_LOG:-}" ] && printf 'pgrep %s\n' "$*" >> "$MOCK_LOG"
exit "${MOCK_PGREP_EXIT:-1}"
EOF

cat > "$SYSROOT/shasum" <<EOF
#!/bin/bash
PATH=/usr/bin:/bin
[ -n "\${MOCK_LOG:-}" ] && printf 'shasum %s\n' "\$*" >> "\$MOCK_LOG"
last=""
for arg in "\$@"; do
  last="\$arg"
done
if [ -n "$REAL_SHASUM" ]; then
  exec "$REAL_SHASUM" "\$@"
elif [ -n "$REAL_SHA256SUM" ]; then
  exec "$REAL_SHA256SUM" "\$last"
else
  exit 1
fi
EOF

cat > "$SYSROOT/curl" <<'EOF'
#!/bin/bash
PATH=/usr/bin:/bin
[ -n "${MOCK_LOG:-}" ] && printf 'curl %s\n' "$*" >> "$MOCK_LOG"
has_proto_https=0
has_proto_redir_https=0
has_fail=0
out_file=""
url=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output" ]; then
    out_file="$arg"
    prev=""
    continue
  fi
  if [ "$prev" = "--proto" ]; then
    [ "$arg" = "=https" ] && has_proto_https=1
    prev=""
    continue
  fi
  if [ "$prev" = "--proto-redir" ]; then
    [ "$arg" = "=https" ] && has_proto_redir_https=1
    prev=""
    continue
  fi
  case "$arg" in
    --output|--proto|--proto-redir) prev="$arg" ;;
    --fail) has_fail=1 ;;
  esac
  url="$arg"
done

# Refuse to serve anything unless the caller pinned the protocol AND forbade a
# redirect downgrade to plain http (--proto-redir '=https').
if [ "$has_proto_https" -ne 1 ] || [ "$has_proto_redir_https" -ne 1 ] || [ "$has_fail" -ne 1 ]; then
  exit 99
fi

case "$url" in
  https://github.com/wilsonhyeh/fleuron/releases/download/v2.11.0/*) ;;
  *) exit 98 ;;
esac

base="${url##*/}"

if [ "${MOCK_CURL_404:-}" = "$base" ]; then
  exit 22
fi

src="${MOCK_SERVER}/${base}"
if [ ! -f "$src" ]; then
  exit 22
fi

if [ -n "${MOCK_CURL_TRUNC:-}" ]; then
  tname="${MOCK_CURL_TRUNC%%:*}"
  tcode="${MOCK_CURL_TRUNC#*:}"
  if [ "$base" = "$tname" ]; then
    sz="$(wc -c < "$src")"
    sz=$((sz + 0))
    half=$((sz / 2))
    head -c "$half" "$src" > "$out_file"
    exit "$tcode"
  fi
fi

cp "$src" "$out_file"
EOF

cat > "$SYSROOT/hdiutil" <<'EOF'
#!/bin/bash
PATH=/usr/bin:/bin
[ -n "${MOCK_LOG:-}" ] && printf 'hdiutil %s\n' "$*" >> "$MOCK_LOG"
sub="${1:-}"
shift || true
case "$sub" in
  attach)
    if [ "${MOCK_HDIUTIL_FAIL:-0}" = "1" ]; then
      exit 1
    fi
    mnt=""
    img=""
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "-mountpoint" ]; then
        mnt="$arg"
        prev=""
        continue
      fi
      case "$arg" in
        -mountpoint) prev="$arg" ;;
      esac
      img="$arg"
    done
    [ -n "$mnt" ] && [ -n "$img" ] || exit 1
    mkdir -p "$mnt"
    tar -xf "$img" -C "$mnt"
    ;;
  detach)
    target="${1:-}"
    [ -n "$target" ] && rm -rf "$target"
    ;;
  *)
    exit 1
    ;;
esac
EOF

cat > "$SYSROOT/codesign" <<'EOF'
#!/bin/bash
PATH=/usr/bin:/bin
[ -n "${MOCK_LOG:-}" ] && printf 'codesign %s\n' "$*" >> "$MOCK_LOG"
mode=""
target=""
for arg in "$@"; do
  case "$arg" in
    --verify) mode="verify" ;;
    -dv)      mode="dv" ;;
  esac
  target="$arg"
done
case "$mode" in
  verify)
    if [ ! -d "$target" ]; then
      exit 1
    fi
    found="$(find "$target" -name CORRUPT 2>/dev/null || true)"
    if [ -n "$found" ]; then
      exit 1
    fi
    exit 0
    ;;
  dv)
    if [ -f "$target/Contents/_codesign_dv.txt" ]; then
      cat "$target/Contents/_codesign_dv.txt" >&2
      exit 0
    fi
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
EOF

cat > "$SYSROOT/PlistBuddy" <<'EOF'
#!/bin/bash
PATH=/usr/bin:/bin
[ -n "${MOCK_LOG:-}" ] && printf 'PlistBuddy %s\n' "$*" >> "$MOCK_LOG"
cmd=""
file=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-c" ]; then
    cmd="$arg"
    prev=""
    continue
  fi
  case "$arg" in
    -c) prev="$arg" ;;
  esac
  file="$arg"
done
[ -f "$file" ] || exit 1
key="${cmd#Print :}"
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    "${key}="*)
      printf '%s\n' "${line#*=}"
      exit 0
      ;;
  esac
done < "$file"
exit 1
EOF

cat > "$SYSROOT/ditto" <<'EOF'
#!/bin/bash
PATH=/usr/bin:/bin
[ -n "${MOCK_LOG:-}" ] && printf 'ditto %s\n' "$*" >> "$MOCK_LOG"
src="${1:-}"
dst="${2:-}"
if [ "${MOCK_DITTO_FAIL:-0}" = "1" ]; then
  mkdir -p "$dst"
  exit 1
fi
cp -R "$src" "$dst"
EOF

for f in "$SYSROOT"/*; do
  [ ! -L "$f" ] && chmod +x "$f"
done

# ── Build clean server fixture & rendered script ─────────────────────────────
SERVER_CLEAN="$T/server_clean"
mkdir -p "$SERVER_CLEAN" "$T/dmg_src"
make_app "$T/dmg_src" "2.11.0"
tar -cf "$SERVER_CLEAN/Fleuron_2.11.0_universal.dmg" -C "$T/dmg_src" Fleuron.app
CLEAN_DMG_SHA="$(compute_sha256 "$SERVER_CLEAN/Fleuron_2.11.0_universal.dmg")"
printf '%s  Fleuron_2.11.0_universal.dmg\n' "$CLEAN_DMG_SHA" > "$SERVER_CLEAN/SHA256SUMS.txt"

RENDERED="$T/install-mac.sh"
"$BASH" "$RENDERER" "2.11.0" "$SERVER_CLEAN/Fleuron_2.11.0_universal.dmg" "$RENDERED" >/dev/null

# ── Per-case harness helpers ─────────────────────────────────────────────────
CASE_HOME=""
CASE_TMP=""
CASE_APPS=""
CASE_SERVER=""
CASE_LOG=""
LAST_RC=0
LAST_OUT=""

setup_case() {
  chmod -R u+rwx "$T/case" >/dev/null 2>&1 || true
  rm -rf "$T/case"
  mkdir -p "$T/case/home" "$T/case/tmp" "$T/case/Applications" "$T/case/server"
  cp "$SERVER_CLEAN/"* "$T/case/server/"
  : > "$T/case/mock.log"
  CASE_HOME="$T/case/home"
  CASE_TMP="$T/case/tmp"
  CASE_APPS="$T/case/Applications"
  CASE_SERVER="$T/case/server"
  CASE_LOG="$T/case/mock.log"
}

assert_no_leftovers() {
  local name="$1"
  local f=""
  for f in "$CASE_TMP"/fleuron-install.*; do
    if [ -e "$f" ] || [ -L "$f" ]; then
      fail "$name (cleanup)" "leftover temp dir in TMPDIR: $f"
      return 1
    fi
  done
  for f in "$CASE_APPS"/.Fleuron.app.*; do
    if [ -e "$f" ] || [ -L "$f" ]; then
      fail "$name (cleanup)" "leftover staging/backup in system Applications: $f"
      return 1
    fi
  done
  for f in "$CASE_HOME/Applications"/.Fleuron.app.*; do
    if [ -e "$f" ] || [ -L "$f" ]; then
      fail "$name (cleanup)" "leftover staging/backup in user Applications: $f"
      return 1
    fi
  done
  return 0
}

run_installer() {
  local script="$1"
  shift || true
  set +e
  LAST_OUT="$(
    HOME="$CASE_HOME" \
    TMPDIR="$CASE_TMP" \
    FLEURON_INSTALL_TEST_SYSTEM_APPS="$CASE_APPS" \
    FLEURON_INSTALL_TEST_SYSROOT="$SYSROOT" \
    MOCK_SERVER="$CASE_SERVER" \
    MOCK_LOG="$CASE_LOG" \
    "$BASH" "$script" "$@" 2>&1
  )"
  LAST_RC=$?
  set -e
}

plist_get() {
  local plist="$1"
  local key="$2"
  "$SYSROOT/PlistBuddy" -c "Print :$key" "$plist" 2>/dev/null || true
}

log_has() {
  local pattern="$1"
  grep -qE "$pattern" "$CASE_LOG" 2>/dev/null
}

# ── Static checks S1-S4 ──────────────────────────────────────────────────────
echo "── Static checks (S1-S4) …"

# S1: bash -n
if "$BASH" -n "$TEMPLATE" && "$BASH" -n "$RENDERER" && "$BASH" -n "$RENDERED"; then
  pass "S1: bash -n passes on template, renderer, and rendered script"
else
  fail "S1: bash -n" "syntax check failed"
fi

# S2: bash-3.2 lint + mutation test
lint_bash32() {
  local file="$1"
  local hits=""
  hits="$(grep -nE '=\(|declare -[An]|local -n|mapfile|readarray|\$\{[^}]*(,,|\^\^)|\|&|&>>|coproc|\[\[ -v' "$file" || true)"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
    return 1
  fi
  return 0
}

s2_ok=1
if ! lint_bash32 "$TEMPLATE" >/dev/null; then
  fail "S2: bash-3.2 lint on template" "found forbidden bash-4+ construct"
  s2_ok=0
fi
if ! lint_bash32 "$RENDERER" >/dev/null; then
  fail "S2: bash-3.2 lint on renderer" "found forbidden bash-4+ construct"
  s2_ok=0
fi
cp "$TEMPLATE" "$T/mut_s2.sh"
printf '\ndeclare -A x\n' >> "$T/mut_s2.sh"
if lint_bash32 "$T/mut_s2.sh" >/dev/null; then
  fail "S2: bash-3.2 lint mutation" "lint failed to flag injected 'declare -A x'"
  s2_ok=0
fi
if [ "$s2_ok" -eq 1 ]; then
  pass "S2: bash-3.2 lint passes on template & renderer, and flags injected declare -A"
fi

# S3: renderer validation
s3_ok=1
if "$BASH" "$RENDERER" "2.11" "$SERVER_CLEAN/Fleuron_2.11.0_universal.dmg" "$T/bad1.sh" >/dev/null 2>&1; then
  fail "S3: renderer bad version" "accepted invalid version 2.11"
  s3_ok=0
fi
cp "$SERVER_CLEAN/Fleuron_2.11.0_universal.dmg" "$T/Fleuron_2.11.0_arm64.dmg"
if "$BASH" "$RENDERER" "2.11.0" "$T/Fleuron_2.11.0_arm64.dmg" "$T/bad2.sh" >/dev/null 2>&1; then
  fail "S3: renderer wrong basename" "accepted Fleuron_2.11.0_arm64.dmg"
  s3_ok=0
fi
if "$BASH" "$RENDERER" "2.11.0" "$T/does-not-exist/Fleuron_2.11.0_universal.dmg" "$T/bad3.sh" >/dev/null 2>&1; then
  fail "S3: renderer missing DMG" "accepted nonexistent DMG"
  s3_ok=0
fi
if [ "$s3_ok" -eq 1 ]; then
  pass "S3: renderer rejects bad version, wrong DMG basename, and missing DMG"
fi

# S4: unrendered template exits 2 with "unrendered"
setup_case
run_installer "$TEMPLATE"
if [ "$LAST_RC" -eq 2 ] && printf '%s' "$LAST_OUT" | grep -qi 'unrendered'; then
  assert_no_leftovers "S4" && pass "S4: unrendered template exits 2 with 'unrendered'"
else
  fail "S4: unrendered template" "expected rc=2 and 'unrendered', got rc=$LAST_RC out='$LAST_OUT'"
fi

# ── Runtime cases C1-C26 ─────────────────────────────────────────────────────
echo "── Runtime cases (C1-C27) …"

# C1: fresh install
setup_case
run_installer "$RENDERED"
if [ "$LAST_RC" -eq 0 ] \
   && [ "$(plist_get "$CASE_APPS/Fleuron.app/Contents/Info.plist" CFBundleShortVersionString)" = "2.11.0" ] \
   && log_has '^hdiutil attach .*-readonly' \
   && log_has '^hdiutil attach .*-nobrowse' \
   && log_has '^hdiutil detach ' \
   && log_has '^curl .*https://github\.com/wilsonhyeh/fleuron/releases/download/v2\.11\.0/SHA256SUMS\.txt' \
   && log_has '^curl .*https://github\.com/wilsonhyeh/fleuron/releases/download/v2\.11\.0/Fleuron_2\.11\.0_universal\.dmg'; then
  assert_no_leftovers "C1" && pass "C1: fresh install to system Applications (2.11.0, readonly/nobrowse attach+detach, tag-pinned URLs)"
else
  fail "C1: fresh install" "rc=$LAST_RC ver=$(plist_get "$CASE_APPS/Fleuron.app/Contents/Info.plist" CFBundleShortVersionString)"
fi

# C2: second run (already current, zero curl lines)
: > "$CASE_LOG"
run_installer "$RENDERED"
if [ "$LAST_RC" -eq 0 ] \
   && printf '%s' "$LAST_OUT" | grep -q 'already installed' \
   && ! log_has '^curl '; then
  assert_no_leftovers "C2" && pass "C2: already current exits 0 without network calls"
else
  fail "C2: already current" "rc=$LAST_RC out='$LAST_OUT'"
fi

# C3: upgrade from 2.10.0 -> 2.11.0
setup_case
make_app "$CASE_APPS" "2.10.0"
run_installer "$RENDERED"
if [ "$LAST_RC" -eq 0 ] \
   && [ "$(plist_get "$CASE_APPS/Fleuron.app/Contents/Info.plist" CFBundleShortVersionString)" = "2.11.0" ]; then
  assert_no_leftovers "C3" && pass "C3: upgrade from 2.10.0 installs 2.11.0"
else
  fail "C3: upgrade" "rc=$LAST_RC ver=$(plist_get "$CASE_APPS/Fleuron.app/Contents/Info.plist" CFBundleShortVersionString)"
fi

# C4: newer 2.12.0 already installed -> 0, unchanged, no curl
setup_case
make_app "$CASE_APPS" "2.12.0"
run_installer "$RENDERED"
if [ "$LAST_RC" -eq 0 ] \
   && [ "$(plist_get "$CASE_APPS/Fleuron.app/Contents/Info.plist" CFBundleShortVersionString)" = "2.12.0" ] \
   && ! log_has '^curl '; then
  assert_no_leftovers "C4" && pass "C4: newer version 2.12.0 preserved with exit 0 and no curl"
else
  fail "C4: newer installed" "rc=$LAST_RC ver=$(plist_get "$CASE_APPS/Fleuron.app/Contents/Info.plist" CFBundleShortVersionString)"
fi

# C5: system Applications chmod 555 and empty -> installs to ~/Applications
if [ "$(id -u)" -eq 0 ]; then
  skip "C5: read-only system Applications fallback" "running as root ignores chmod 555"
else
  setup_case
  chmod 555 "$CASE_APPS"
  run_installer "$RENDERED"
  if [ "$LAST_RC" -eq 0 ] \
     && [ "$(plist_get "$CASE_HOME/Applications/Fleuron.app/Contents/Info.plist" CFBundleShortVersionString)" = "2.11.0" ] \
     && [ ! -e "$CASE_APPS/Fleuron.app" ]; then
    assert_no_leftovers "C5" && pass "C5: chmod 555 empty system Applications falls back to ~/Applications"
  else
    fail "C5: fallback to ~/Applications" "rc=$LAST_RC out='$LAST_OUT'"
  fi
fi

# C6: Fleuron.app in chmod 555 system Applications -> exit 5, unchanged
if [ "$(id -u)" -eq 0 ]; then
  skip "C6: non-writable existing install" "running as root ignores chmod 555"
else
  setup_case
  make_app "$CASE_APPS" "2.10.0"
  chmod 555 "$CASE_APPS"
  run_installer "$RENDERED"
  if [ "$LAST_RC" -eq 5 ] \
     && [ "$(plist_get "$CASE_APPS/Fleuron.app/Contents/Info.plist" CFBundleShortVersionString)" = "2.10.0" ] \
     && ! log_has '^curl '; then
    assert_no_leftovers "C6" && pass "C6: Fleuron.app in chmod 555 system Applications exits 5 unchanged"
  else
    fail "C6: chmod 555 existing" "rc=$LAST_RC out='$LAST_OUT'"
  fi
fi

# C7: served DMG altered by one byte (SUMS still lists baked hash) -> 20, no hdiutil, nothing installed
setup_case
printf 'X' >> "$CASE_SERVER/Fleuron_2.11.0_universal.dmg"
run_installer "$RENDERED"
if [ "$LAST_RC" -eq 20 ] \
   && ! log_has '^hdiutil ' \
   && [ ! -e "$CASE_APPS/Fleuron.app" ] \
   && [ ! -e "$CASE_HOME/Applications/Fleuron.app" ]; then
  assert_no_leftovers "C7" && pass "C7: altered DMG exits 20 before hdiutil with nothing installed"
else
  fail "C7: altered DMG" "rc=$LAST_RC out='$LAST_OUT'"
fi

# C8: SUMS lists a different hash -> 20, no DMG curl line
setup_case
printf '%s  Fleuron_2.11.0_universal.dmg\n' "0000000000000000000000000000000000000000000000000000000000000000" > "$CASE_SERVER/SHA256SUMS.txt"
run_installer "$RENDERED"
if [ "$LAST_RC" -eq 20 ] \
   && ! log_has 'Fleuron_2\.11\.0_universal\.dmg'; then
  assert_no_leftovers "C8" && pass "C8: SHA256SUMS mismatch exits 20 without curling DMG"
else
  fail "C8: SUMS mismatch" "rc=$LAST_RC"
fi

# C9: SUMS 404 -> 10
setup_case
MOCK_CURL_404="SHA256SUMS.txt" run_installer "$RENDERED"
if [ "$LAST_RC" -eq 10 ] && [ ! -e "$CASE_APPS/Fleuron.app" ]; then
  assert_no_leftovers "C9" && pass "C9: SHA256SUMS 404 exits 10"
else
  fail "C9: SUMS 404" "rc=$LAST_RC"
fi

# C10: truncated DMG with curl exit 18 -> 10
setup_case
MOCK_CURL_TRUNC="Fleuron_2.11.0_universal.dmg:18" run_installer "$RENDERED"
if [ "$LAST_RC" -eq 10 ] && [ ! -e "$CASE_APPS/Fleuron.app" ]; then
  assert_no_leftovers "C10" && pass "C10: truncated DMG with curl exit 18 exits 10"
else
  fail "C10: truncated DMG exit 18" "rc=$LAST_RC"
fi

# C11: truncated DMG with curl exit 0 -> 20
setup_case
MOCK_CURL_TRUNC="Fleuron_2.11.0_universal.dmg:0" run_installer "$RENDERED"
if [ "$LAST_RC" -eq 20 ] && ! log_has '^hdiutil ' && [ ! -e "$CASE_APPS/Fleuron.app" ]; then
  assert_no_leftovers "C11" && pass "C11: truncated DMG with curl exit 0 exits 20"
else
  fail "C11: truncated DMG exit 0" "rc=$LAST_RC"
fi

# C12: wrong bundle id inside DMG -> 40
setup_case
mkdir -p "$T/case/bad_src"
make_app "$T/case/bad_src" "2.11.0" "com.evil.other"
tar -cf "$CASE_SERVER/Fleuron_2.11.0_universal.dmg" -C "$T/case/bad_src" Fleuron.app
bad_sha="$(compute_sha256 "$CASE_SERVER/Fleuron_2.11.0_universal.dmg")"
printf '%s  Fleuron_2.11.0_universal.dmg\n' "$bad_sha" > "$CASE_SERVER/SHA256SUMS.txt"
"$BASH" "$RENDERER" "2.11.0" "$CASE_SERVER/Fleuron_2.11.0_universal.dmg" "$T/case/inst.sh" >/dev/null
run_installer "$T/case/inst.sh"
if [ "$LAST_RC" -eq 40 ] && [ ! -e "$CASE_APPS/Fleuron.app" ]; then
  assert_no_leftovers "C12" && pass "C12: wrong bundle id inside DMG exits 40"
else
  fail "C12: wrong bundle id" "rc=$LAST_RC out='$LAST_OUT'"
fi

# C13: wrong version inside DMG -> 40
setup_case
mkdir -p "$T/case/bad_src"
make_app "$T/case/bad_src" "2.9.0" "study.fleuron.desktop"
tar -cf "$CASE_SERVER/Fleuron_2.11.0_universal.dmg" -C "$T/case/bad_src" Fleuron.app
bad_sha="$(compute_sha256 "$CASE_SERVER/Fleuron_2.11.0_universal.dmg")"
printf '%s  Fleuron_2.11.0_universal.dmg\n' "$bad_sha" > "$CASE_SERVER/SHA256SUMS.txt"
"$BASH" "$RENDERER" "2.11.0" "$CASE_SERVER/Fleuron_2.11.0_universal.dmg" "$T/case/inst.sh" >/dev/null
run_installer "$T/case/inst.sh"
if [ "$LAST_RC" -eq 40 ] && [ ! -e "$CASE_APPS/Fleuron.app" ]; then
  assert_no_leftovers "C13" && pass "C13: wrong version inside DMG exits 40"
else
  fail "C13: wrong version" "rc=$LAST_RC out='$LAST_OUT'"
fi

# C14: non-adhoc Signature=Developer ID / TeamIdentifier=ABCDE12345 -> 40
setup_case
mkdir -p "$T/case/bad_src"
make_app "$T/case/bad_src" "2.11.0" "study.fleuron.desktop" "Identifier=study.fleuron.desktop
Signature=Developer ID
TeamIdentifier=ABCDE12345"
tar -cf "$CASE_SERVER/Fleuron_2.11.0_universal.dmg" -C "$T/case/bad_src" Fleuron.app
bad_sha="$(compute_sha256 "$CASE_SERVER/Fleuron_2.11.0_universal.dmg")"
printf '%s  Fleuron_2.11.0_universal.dmg\n' "$bad_sha" > "$CASE_SERVER/SHA256SUMS.txt"
"$BASH" "$RENDERER" "2.11.0" "$CASE_SERVER/Fleuron_2.11.0_universal.dmg" "$T/case/inst.sh" >/dev/null
run_installer "$T/case/inst.sh"
if [ "$LAST_RC" -eq 40 ] && [ ! -e "$CASE_APPS/Fleuron.app" ]; then
  assert_no_leftovers "C14" && pass "C14: Developer ID / TeamIdentifier signature inside DMG exits 40"
else
  fail "C14: bad signature" "rc=$LAST_RC out='$LAST_OUT'"
fi

# C15: CORRUPT file in DMG app -> 40
setup_case
mkdir -p "$T/case/bad_src"
make_app "$T/case/bad_src" "2.11.0"
: > "$T/case/bad_src/Fleuron.app/Contents/MacOS/CORRUPT"
tar -cf "$CASE_SERVER/Fleuron_2.11.0_universal.dmg" -C "$T/case/bad_src" Fleuron.app
bad_sha="$(compute_sha256 "$CASE_SERVER/Fleuron_2.11.0_universal.dmg")"
printf '%s  Fleuron_2.11.0_universal.dmg\n' "$bad_sha" > "$CASE_SERVER/SHA256SUMS.txt"
"$BASH" "$RENDERER" "2.11.0" "$CASE_SERVER/Fleuron_2.11.0_universal.dmg" "$T/case/inst.sh" >/dev/null
run_installer "$T/case/inst.sh"
if [ "$LAST_RC" -eq 40 ] && [ ! -e "$CASE_APPS/Fleuron.app" ]; then
  assert_no_leftovers "C15" && pass "C15: CORRUPT bundle inside DMG exits 40"
else
  fail "C15: corrupt bundle" "rc=$LAST_RC out='$LAST_OUT'"
fi

# C16: upgrade with MOCK_DITTO_FAIL=1 -> 50, 2.10.0 still intact
setup_case
make_app "$CASE_APPS" "2.10.0"
MOCK_DITTO_FAIL=1 run_installer "$RENDERED"
if [ "$LAST_RC" -eq 50 ] \
   && [ "$(plist_get "$CASE_APPS/Fleuron.app/Contents/Info.plist" CFBundleShortVersionString)" = "2.10.0" ]; then
  assert_no_leftovers "C16" && pass "C16: ditto failure exits 50 and leaves 2.10.0 intact"
else
  fail "C16: ditto fail" "rc=$LAST_RC ver=$(plist_get "$CASE_APPS/Fleuron.app/Contents/Info.plist" CFBundleShortVersionString)"
fi

# C17: MOCK_PGREP_EXIT=0 -> 4, no curl
setup_case
MOCK_PGREP_EXIT=0 run_installer "$RENDERED"
if [ "$LAST_RC" -eq 4 ] && ! log_has '^curl '; then
  assert_no_leftovers "C17" && pass "C17: running Fleuron exits 4 with no curl"
else
  fail "C17: running check" "rc=$LAST_RC"
fi

# C18: MOCK_UID=0 -> 3
setup_case
MOCK_UID=0 run_installer "$RENDERED"
if [ "$LAST_RC" -eq 3 ]; then
  assert_no_leftovers "C18" && pass "C18: root uid exits 3"
else
  fail "C18: root check" "rc=$LAST_RC"
fi

# C19: MOCK_UNAME_S=Linux -> 3; MOCK_SWVERS=10.14 -> 3
setup_case
MOCK_UNAME_S=Linux run_installer "$RENDERED"
rc_linux="$LAST_RC"
assert_no_leftovers "C19a" || true

setup_case
MOCK_SWVERS=10.14 run_installer "$RENDERED"
rc_1014="$LAST_RC"
if [ "$rc_linux" -eq 3 ] && [ "$rc_1014" -eq 3 ]; then
  assert_no_leftovers "C19b" && pass "C19: non-Darwin (Linux) and macOS 10.14 both exit 3"
else
  fail "C19: OS/version preflight" "rc_linux=$rc_linux rc_1014=$rc_1014"
fi

# C20: DMG path arg -> 2, message mentions "never uses a disk image", no curl
setup_case
run_installer "$RENDERED" "~/Downloads/Fleuron_2.11.0_universal.dmg"
if [ "$LAST_RC" -eq 2 ] \
   && printf '%s' "$LAST_OUT" | grep -q 'never uses a disk image' \
   && ! log_has '^curl '; then
  assert_no_leftovers "C20" && pass "C20: DMG argument rejected with exit 2 and no curl"
else
  fail "C20: DMG arg" "rc=$LAST_RC out='$LAST_OUT'"
fi

# C21: shadowed curl in PATH -> install succeeds and EVIL_RAN absent
EVIL_DIR="$T/evil"
mkdir -p "$EVIL_DIR"
cat > "$EVIL_DIR/curl" <<EOF
#!/bin/bash
PATH=/usr/bin:/bin
: > "$T/EVIL_RAN"
exit 1
EOF
chmod +x "$EVIL_DIR/curl"

setup_case
rm -f "$T/EVIL_RAN"
set +e
LAST_OUT="$(
  PATH="$EVIL_DIR:$SYSROOT" \
  HOME="$CASE_HOME" \
  TMPDIR="$CASE_TMP" \
  FLEURON_INSTALL_TEST_SYSTEM_APPS="$CASE_APPS" \
  FLEURON_INSTALL_TEST_SYSROOT="$SYSROOT" \
  MOCK_SERVER="$CASE_SERVER" \
  MOCK_LOG="$CASE_LOG" \
  "$BASH" "$RENDERED" 2>&1
)"
LAST_RC=$?
set -e
if [ "$LAST_RC" -eq 0 ] && [ ! -e "$T/EVIL_RAN" ]; then
  assert_no_leftovers "C21" && pass "C21: PATH reset defeats shadowed curl"
else
  fail "C21: shadowed curl" "rc=$LAST_RC evil_ran=$([ -e "$T/EVIL_RAN" ] && echo yes || echo no)"
fi

# C21-MUT: delete # PATH-RESET line -> EVIL_RAN must appear (proves C21 can fail)
setup_case
rm -f "$T/EVIL_RAN"
if ! grep -q '# PATH-RESET$' "$RENDERED"; then
  fail "C21-MUT" "missing # PATH-RESET marker in rendered script"
else
  grep -v '# PATH-RESET$' "$RENDERED" > "$T/case/nopath.sh"
  set +e
  LAST_OUT="$(
    PATH="$EVIL_DIR:$SYSROOT" \
    HOME="$CASE_HOME" \
    TMPDIR="$CASE_TMP" \
    FLEURON_INSTALL_TEST_SYSTEM_APPS="$CASE_APPS" \
    FLEURON_INSTALL_TEST_SYSROOT="$SYSROOT" \
    MOCK_SERVER="$CASE_SERVER" \
    MOCK_LOG="$CASE_LOG" \
    "$BASH" "$T/case/nopath.sh" 2>&1
  )"
  LAST_RC=$?
  set -e
  if [ -e "$T/EVIL_RAN" ]; then
    rm -f "$T/EVIL_RAN"
    assert_no_leftovers "C21-MUT" && pass "C21-MUT: deleting # PATH-RESET allows shadowed curl to run"
  else
    fail "C21-MUT" "EVIL_RAN was not created when # PATH-RESET was deleted"
  fi
fi

# C22: checksum-gate mutation -> replacing # CHECKSUM-GATE line with true on C7 must NOT exit 20
setup_case
if ! grep -q '# CHECKSUM-GATE$' "$RENDERED"; then
  fail "C22" "missing # CHECKSUM-GATE marker in rendered script"
else
  sed 's/.*# CHECKSUM-GATE$/true/' "$RENDERED" > "$T/case/nogate.sh"
  printf 'X' >> "$CASE_SERVER/Fleuron_2.11.0_universal.dmg"
  run_installer "$T/case/nogate.sh"
  if [ "$LAST_RC" -ne 20 ]; then
    assert_no_leftovers "C22" && pass "C22: mutating # CHECKSUM-GATE to true skips C7 exit 20 (rc=$LAST_RC)"
  else
    fail "C22" "mutated script still exited 20"
  fi
fi

# C23: truncated pipe -> zero curl/hdiutil lines
setup_case
sz="$(wc -c < "$RENDERED")"
sz=$((sz + 0))
half=$((sz / 2))
set +e
LAST_OUT="$(
  head -c "$half" "$RENDERED" | \
  env \
    HOME="$CASE_HOME" \
    TMPDIR="$CASE_TMP" \
    FLEURON_INSTALL_TEST_SYSTEM_APPS="$CASE_APPS" \
    FLEURON_INSTALL_TEST_SYSROOT="$SYSROOT" \
    MOCK_SERVER="$CASE_SERVER" \
    MOCK_LOG="$CASE_LOG" \
    "$BASH" -s 2>&1
)"
LAST_RC=$?
set -e
if ! log_has '^curl ' && ! log_has '^hdiutil '; then
  assert_no_leftovers "C23" && pass "C23: truncated pipe executes zero curl/hdiutil commands"
else
  fail "C23: truncated pipe" "curl or hdiutil ran on truncated input"
fi

# C24: hdiutil attach fails -> 30
setup_case
MOCK_HDIUTIL_FAIL=1 run_installer "$RENDERED"
if [ "$LAST_RC" -eq 30 ] && [ ! -e "$CASE_APPS/Fleuron.app" ]; then
  assert_no_leftovers "C24" && pass "C24: hdiutil attach failure exits 30"
else
  fail "C24: hdiutil fail" "rc=$LAST_RC"
fi

# C25: --uninstall
setup_case
make_app "$CASE_APPS" "2.11.0"
mkdir -p "$CASE_HOME/Fleuron"
printf 'keep me\n' > "$CASE_HOME/Fleuron/study.txt"

run_installer "$RENDERED" --uninstall
c25_a=0
if [ "$LAST_RC" -eq 0 ] \
   && [ ! -e "$CASE_APPS/Fleuron.app" ] \
   && [ -f "$CASE_HOME/Fleuron/study.txt" ] \
   && [ "$(cat "$CASE_HOME/Fleuron/study.txt")" = "keep me" ]; then
  c25_a=1
fi

run_installer "$RENDERED" --uninstall
c25_b=0
if [ "$LAST_RC" -eq 0 ] && printf '%s' "$LAST_OUT" | grep -q 'not installed'; then
  c25_b=1
fi

make_app "$CASE_APPS" "2.11.0" "com.other.app"
run_installer "$RENDERED" --uninstall
c25_c=0
if [ "$LAST_RC" -eq 5 ] && [ -d "$CASE_APPS/Fleuron.app" ]; then
  c25_c=1
fi

if [ "$c25_a" -eq 1 ] && [ "$c25_b" -eq 1 ] && [ "$c25_c" -eq 1 ]; then
  assert_no_leftovers "C25" && pass "C25: --uninstall removes Fleuron preserving studies, no-ops when absent, refuses foreign bundle (exit 5)"
else
  fail "C25: --uninstall" "a=$c25_a b=$c25_b c=$c25_c rc=$LAST_RC out='$LAST_OUT'"
fi

# C26: --reinstall on current -> 0 and curl called
setup_case
make_app "$CASE_APPS" "2.11.0"
run_installer "$RENDERED" --reinstall
if [ "$LAST_RC" -eq 0 ] \
   && log_has '^curl .*Fleuron_2\.11\.0_universal\.dmg' \
   && [ "$(plist_get "$CASE_APPS/Fleuron.app/Contents/Info.plist" CFBundleShortVersionString)" = "2.11.0" ]; then
  assert_no_leftovers "C26" && pass "C26: --reinstall on current 2.11.0 exits 0 and downloads/reinstalls via curl"
else
  fail "C26: --reinstall" "rc=$LAST_RC out='$LAST_OUT'"
fi

# C27: both curl calls pin --proto-redir '=https' so a redirect cannot downgrade to plain http
setup_case
run_installer "$RENDERED"
curl_total=0
curl_redir=0
if [ "$LAST_RC" -eq 0 ]; then
  curl_total="$(grep -c '^curl ' "$CASE_LOG" || true)"
  curl_redir="$(grep -c -- '^curl .*--proto-redir =https' "$CASE_LOG" || true)"
fi
if [ "$LAST_RC" -eq 0 ] && [ "$curl_total" -eq 2 ] && [ "$curl_redir" -eq 2 ]; then
  assert_no_leftovers "C27" && pass "C27: both curl calls pass --proto-redir '=https' (a redirect cannot downgrade to http)"
else
  fail "C27: curl redirect downgrade" "rc=$LAST_RC curl_lines=$curl_total with_redir=$curl_redir"
fi

# C27-MUT: deleting --proto-redir '=https' from the installer must fail the install
setup_case
sed "s/--proto-redir '=https' //g" "$RENDERED" > "$T/case/noredir.sh"
run_installer "$T/case/noredir.sh"
if [ "$LAST_RC" -eq 10 ] && [ ! -e "$CASE_APPS/Fleuron.app" ]; then
  assert_no_leftovers "C27-MUT" && pass "C27-MUT: dropping --proto-redir fails the download (exit 10, nothing installed)"
else
  fail "C27-MUT" "rc=$LAST_RC out='$LAST_OUT'"
fi

echo
if [ "$FAIL" -gt 0 ]; then
  printf '✗ install-mac test suite: %d failed, %d passed\n' "$FAIL" "$PASS"
  exit 1
fi
printf '✓ install-mac test suite: all %d checks passed\n' "$PASS"
