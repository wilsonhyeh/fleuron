#!/bin/bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s\n' 'fleuron-install: run with /bin/bash' >&2
  exit 3
fi

set -euo pipefail
PATH="${FLEURON_INSTALL_TEST_SYSROOT:-/usr/bin:/bin:/usr/sbin:/sbin:/usr/libexec}"; export PATH  # PATH-RESET

FLEURON_VERSION="__FLEURON_VERSION__"
FLEURON_DMG_SHA256="__FLEURON_DMG_SHA256__"

BUNDLE_ID=study.fleuron.desktop
REPO_URL=https://github.com/wilsonhyeh/fleuron
DMG_NAME="Fleuron_${FLEURON_VERSION}_universal.dmg"
BASE="$REPO_URL/releases/download/v${FLEURON_VERSION}"
DMG_URL="$BASE/$DMG_NAME"
SUMS_URL="$BASE/SHA256SUMS.txt"

WORK=""
MNT=""
MOUNTED=0
STAGE=""
PREV=""
DEST=""
ARCH=""

log() {
  printf 'fleuron-install: %s\n' "$*" >&2
}

die() {
  local code="$1"
  shift
  log "$*"
  exit "$code"
}

security_stop() {
  local code="$1"
  shift
  printf 'fleuron-install: SECURITY STOP: %s\n' "$*" >&2
  exit "$code"
}

usage() {
  printf '%s\n' \
    'Usage: /bin/bash install-mac.sh [OPTIONS]' \
    '' \
    'Install or uninstall Fleuron for macOS from the pinned GitHub release.' \
    '' \
    'Options:' \
    '  (none)         Install Fleuron (or verify/upgrade an existing install)' \
    '  --reinstall    Reinstall even if the pinned version is already installed' \
    '  --uninstall    Remove Fleuron.app from /Applications or ~/Applications' \
    '  -h, --help     Show this help message and exit' >&2
}

cleanup() {
  set +e
  if [ "${MOUNTED:-0}" -eq 1 ] && [ -n "${MNT:-}" ]; then
    hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || hdiutil detach "$MNT" -force -quiet >/dev/null 2>&1 || true
    MOUNTED=0
  fi
  if [ -n "${PREV:-}" ] && [ -n "${DEST:-}" ] && [ ! -e "$DEST" ] && [ ! -L "$DEST" ] && [ -e "$PREV" ]; then
    mv "$PREV" "$DEST" >/dev/null 2>&1 || true
  fi
  if [ -n "${STAGE:-}" ] && { [ -e "$STAGE" ] || [ -L "$STAGE" ]; }; then
    rm -rf "$STAGE" >/dev/null 2>&1 || true
  fi
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then
    rm -rf "$WORK" >/dev/null 2>&1 || true
  fi
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

# Echoes -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2.
compare_versions() {
  local v1="$1" v2="$2"
  local a1="" b1="" c1="" a2="" b2="" c2=""
  IFS=. read -r a1 b1 c1 <<EOF || true
$v1
EOF
  IFS=. read -r a2 b2 c2 <<EOF || true
$v2
EOF
  a1=$((10#$a1)); b1=$((10#$b1)); c1=$((10#$c1))
  a2=$((10#$a2)); b2=$((10#$b2)); c2=$((10#$c2))
  if [ "$a1" -lt "$a2" ]; then printf '%s' "-1"; return 0; fi
  if [ "$a1" -gt "$a2" ]; then printf '%s' "1"; return 0; fi
  if [ "$b1" -lt "$b2" ]; then printf '%s' "-1"; return 0; fi
  if [ "$b1" -gt "$b2" ]; then printf '%s' "1"; return 0; fi
  if [ "$c1" -lt "$c2" ]; then printf '%s' "-1"; return 0; fi
  if [ "$c1" -gt "$c2" ]; then printf '%s' "1"; return 0; fi
  printf '%s' "0"
}

check_template() {
  local marker="__FLEURON""_"
  case "$FLEURON_VERSION" in
    *"$marker"*) die 2 "unrendered installer template; download install-mac.sh from the release page" ;;
  esac
  case "$FLEURON_DMG_SHA256" in
    *"$marker"*) die 2 "unrendered installer template; download install-mac.sh from the release page" ;;
  esac
  if ! is_semver "$FLEURON_VERSION" || ! is_sha256 "$FLEURON_DMG_SHA256"; then
    die 2 "unrendered installer template; download install-mac.sh from the release page"
  fi
}

preflight() {
  local os_name uid os_ver ver_major ver_rest ver_minor

  os_name="$(uname -s)"
  if [ "$os_name" != "Darwin" ]; then
    die 3 "unsupported OS '$os_name'; this installer is for macOS only"
  fi

  uid="$(id -u)"
  if [ "$uid" = "0" ]; then
    die 3 "Do not run this installer with sudo or as root. It never needs administrator rights."
  fi

  os_ver="$(sw_vers -productVersion)"
  ver_major="${os_ver%%.*}"
  ver_rest="${os_ver#*.}"
  if [ "$ver_rest" = "$os_ver" ]; then
    ver_minor=0
  else
    ver_minor="${ver_rest%%.*}"
  fi
  if [ -z "$ver_major" ] || [ -z "$ver_minor" ]; then
    die 3 "could not determine macOS version from '$os_ver'"
  fi
  case "${ver_major}${ver_minor}" in
    *[!0-9]*) die 3 "could not determine macOS version from '$os_ver'" ;;
  esac
  if [ "$((10#$ver_major))" -lt 10 ] || { [ "$((10#$ver_major))" -eq 10 ] && [ "$((10#$ver_minor))" -lt 15 ]; }; then
    die 3 "unsupported macOS version '$os_ver'; macOS 10.15 or newer is required"
  fi

  case "${HOME:-}" in
    /*) ;;
    *) die 3 "HOME must be set to an absolute path" ;;
  esac

  ARCH="$(uname -m)"
}

check_not_running() {
  if pgrep -f '/Fleuron.app/Contents/MacOS/' >/dev/null 2>&1; then
    die 4 "Fleuron is running. Quit Fleuron, then run this again."
  fi
}

check_existing_bundle_safe() {
  local parent="$1"
  local app_path="$2"
  local existing_id=""

  if [ -L "$app_path" ]; then
    die 5 "$app_path is a symlink; refusing to modify it (another account or IT may manage it)"
  fi
  if [ ! -d "$app_path" ]; then
    die 5 "$app_path exists and is not an application bundle; refusing to modify it"
  fi
  if [ ! -w "$parent" ] || [ ! -w "$app_path" ]; then
    die 5 "$app_path is not writable; another account or IT installed it"
  fi
  if [ -L "$app_path/Contents/Info.plist" ] || [ ! -f "$app_path/Contents/Info.plist" ]; then
    die 5 "$app_path appears to be a different app named Fleuron.app (missing Info.plist)"
  fi
  existing_id="$(PlistBuddy -c "Print :CFBundleIdentifier" "$app_path/Contents/Info.plist" 2>/dev/null || true)"
  if [ "$existing_id" != "$BUNDLE_ID" ]; then
    die 5 "$app_path is a different app named Fleuron.app (bundle id: ${existing_id:-unknown})"
  fi
}

do_uninstall() {
  local sys="$1"
  local usr="$2"
  local sys_app="$sys/Fleuron.app"
  local usr_app="$usr/Fleuron.app"
  local has_sys=0 has_usr=0
  local trash_path=""

  if [ -e "$sys_app" ] || [ -L "$sys_app" ]; then
    has_sys=1
    check_existing_bundle_safe "$sys" "$sys_app"
  fi
  if [ -e "$usr_app" ] || [ -L "$usr_app" ]; then
    has_usr=1
    check_existing_bundle_safe "$usr" "$usr_app"
  fi

  if [ "$has_sys" -eq 0 ] && [ "$has_usr" -eq 0 ]; then
    log "Fleuron is not installed in /Applications or ~/Applications."
    return 0
  fi

  check_not_running

  if [ "$has_sys" -eq 1 ]; then
    trash_path="$sys/.Fleuron.app.removing.$$"
    rm -rf "$trash_path" >/dev/null 2>&1 || true
    if ! mv "$sys_app" "$trash_path"; then
      die 5 "could not remove $sys_app; another account or IT may have installed it"
    fi
    rm -rf "$trash_path"
    log "removed $sys_app"
  fi

  if [ "$has_usr" -eq 1 ]; then
    trash_path="$usr/.Fleuron.app.removing.$$"
    rm -rf "$trash_path" >/dev/null 2>&1 || true
    if ! mv "$usr_app" "$trash_path"; then
      die 5 "could not remove $usr_app; another account or IT may have installed it"
    fi
    rm -rf "$trash_path"
    log "removed $usr_app"
  fi

  log "Your studies (~/Fleuron by default) and settings (~/Library/Application Support/study.fleuron.desktop) were not touched."
}

verify_sums_file() {
  local sums_file="$1"
  local h="" n=""
  local match_name=0
  local match_exact=0

  while read -r h n || [ -n "${h:-}" ]; do
    [ -z "${h:-}" ] && continue
    n="${n:-}"
    n="${n%$'\r'}"
    n="${n#\*}"
    if [ "$n" = "$DMG_NAME" ]; then
      match_name=$((match_name + 1))
      if [ "$h" = "$FLEURON_DMG_SHA256" ]; then
        match_exact=$((match_exact + 1))
      fi
    fi
  done < "$sums_file"

  if [ "$match_name" -ne 1 ] || [ "$match_exact" -ne 1 ]; then
    security_stop 20 "SHA256SUMS.txt does not match the pinned hash for $DMG_NAME. Nothing was installed."
  fi
}

inspect_dmg_app() {
  local app_in_dmg="$1"
  local app_id="" app_ver="" dv_out="" nl="" dv_padded=""

  if [ -L "$app_in_dmg" ] || [ ! -d "$app_in_dmg" ]; then
    security_stop 40 "disk image does not contain a valid Fleuron.app directory"
  fi
  if [ -L "$app_in_dmg/Contents/Info.plist" ] || [ ! -f "$app_in_dmg/Contents/Info.plist" ]; then
    security_stop 40 "Fleuron.app inside disk image is missing Info.plist"
  fi

  app_id="$(PlistBuddy -c "Print :CFBundleIdentifier" "$app_in_dmg/Contents/Info.plist" 2>/dev/null || true)"
  if [ "$app_id" != "$BUNDLE_ID" ]; then
    security_stop 40 "unexpected bundle identifier '${app_id:-missing}' in disk image (expected $BUNDLE_ID)"
  fi

  app_ver="$(PlistBuddy -c "Print :CFBundleShortVersionString" "$app_in_dmg/Contents/Info.plist" 2>/dev/null || true)"
  if [ "$app_ver" != "$FLEURON_VERSION" ]; then
    security_stop 40 "unexpected app version '${app_ver:-missing}' in disk image (expected $FLEURON_VERSION)"
  fi

  if ! codesign --verify --deep --strict "$app_in_dmg" >/dev/null 2>&1; then
    security_stop 40 "codesign verification failed on app inside disk image"
  fi

  dv_out="$(codesign -dv "$app_in_dmg" 2>&1 || true)"
  nl='
'
  dv_padded="${nl}${dv_out}${nl}"
  case "$dv_padded" in
    *"${nl}Identifier=${BUNDLE_ID}${nl}"*) ;;
    *) security_stop 40 "codesign identifier check failed (expected Identifier=$BUNDLE_ID)" ;;
  esac
  case "$dv_padded" in
    *"${nl}Signature=adhoc${nl}"*) ;;
    *) security_stop 40 "codesign signature check failed (expected Signature=adhoc)" ;;
  esac
  case "$dv_padded" in
    *"${nl}TeamIdentifier=not set${nl}"*) ;;
    *) security_stop 40 "codesign TeamIdentifier check failed (expected TeamIdentifier=not set)" ;;
  esac
}

do_install() {
  local sys="$1"
  local usr="$2"
  local reinstall="$3"
  local target=""
  local existing_ver="" cmp=""
  local tmp_base="" out="" h=""
  local stage_id="" stage_ver=""

  check_not_running

  if [ -e "$sys/Fleuron.app" ] || [ -L "$sys/Fleuron.app" ]; then
    target="$sys"
    if [ -e "$usr/Fleuron.app" ] || [ -L "$usr/Fleuron.app" ]; then
      log "warning: a second copy exists at $usr/Fleuron.app"
    fi
  elif [ -e "$usr/Fleuron.app" ] || [ -L "$usr/Fleuron.app" ]; then
    target="$usr"
  elif [ -w "$sys" ]; then
    target="$sys"
  else
    target="$usr"
  fi

  DEST="$target/Fleuron.app"

  if [ -e "$DEST" ] || [ -L "$DEST" ]; then
    check_existing_bundle_safe "$target" "$DEST"
    existing_ver="$(PlistBuddy -c "Print :CFBundleShortVersionString" "$DEST/Contents/Info.plist" 2>/dev/null || true)"
    if is_semver "$existing_ver"; then
      cmp="$(compare_versions "$existing_ver" "$FLEURON_VERSION")"
      if [ "$cmp" = "1" ]; then
        log "newer version $existing_ver already installed at $DEST; nothing to do."
        return 0
      elif [ "$cmp" = "0" ] && [ "$reinstall" -eq 0 ]; then
        if codesign --verify --deep --strict "$DEST" >/dev/null 2>&1; then
          log "Fleuron $FLEURON_VERSION is already installed at $DEST and verifies; nothing to do."
          return 0
        else
          log "existing Fleuron $FLEURON_VERSION at $DEST failed verification; repairing."
        fi
      fi
    fi
  elif [ -e "$target" ] && [ ! -w "$target" ]; then
    die 5 "$target is not writable; another account or IT may manage it"
  fi

  log "Fleuron $FLEURON_VERSION installer for macOS ($ARCH)"
  log "install location: $DEST"

  tmp_base="${TMPDIR:-/tmp}"
  tmp_base="${tmp_base%/}"
  if [ -z "$tmp_base" ]; then
    tmp_base="/tmp"
  fi
  WORK="$(mktemp -d "${tmp_base}/fleuron-install.XXXXXX")"
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP

  if ! curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 900 --show-error --silent --output "$WORK/SHA256SUMS.txt" "$SUMS_URL"; then
    die 10 "could not download the release checksum list; nothing was installed"
  fi
  verify_sums_file "$WORK/SHA256SUMS.txt"
  log "checking the release checksum list ... ok"

  log "downloading $DMG_NAME ..."
  if ! curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 900 --show-error --progress-bar --output "$WORK/$DMG_NAME" "$DMG_URL"; then
    die 10 "download failed or was cut off; nothing was installed"
  fi

  out="$(shasum -a 256 "$WORK/$DMG_NAME")" || die 20 "could not compute SHA-256 of downloaded disk image"
  h="${out%% *}"
  [ "$h" = "$FLEURON_DMG_SHA256" ] || security_stop 20 "downloaded disk image hash ($h) does not match pinned release value ($FLEURON_DMG_SHA256). Do not open this file. Nothing was installed. Report it: https://github.com/wilsonhyeh/fleuron/issues/new?template=install-help.yml"  # CHECKSUM-GATE
  log "SHA-256 matches the pinned release value ... ok"

  MNT="$WORK/mnt"
  mkdir -p "$MNT"
  if ! hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$MNT" "$WORK/$DMG_NAME" >/dev/null; then
    die 30 "disk image could not be opened (on a managed Mac, policy may block disk images; contact IT)"
  fi
  MOUNTED=1

  inspect_dmg_app "$MNT/Fleuron.app"
  log "checking the app inside the disk image ... ok ($BUNDLE_ID $FLEURON_VERSION, ad-hoc signed)"

  if ! mkdir -p "$target"; then
    die 50 "could not create target directory $target"
  fi
  STAGE="$target/.Fleuron.app.installing.$$"
  rm -rf "$STAGE" >/dev/null 2>&1 || true
  if ! ditto "$MNT/Fleuron.app" "$STAGE"; then
    die 50 "failed to copy Fleuron.app to $STAGE"
  fi
  if ! codesign --verify --deep --strict "$STAGE" >/dev/null 2>&1; then
    die 50 "staged app signature verification failed"
  fi
  stage_id="$(PlistBuddy -c "Print :CFBundleIdentifier" "$STAGE/Contents/Info.plist" 2>/dev/null || true)"
  stage_ver="$(PlistBuddy -c "Print :CFBundleShortVersionString" "$STAGE/Contents/Info.plist" 2>/dev/null || true)"
  if [ "$stage_id" != "$BUNDLE_ID" ] || [ "$stage_ver" != "$FLEURON_VERSION" ]; then
    die 50 "staged app metadata check failed"
  fi

  if [ -e "$DEST" ] || [ -L "$DEST" ]; then
    PREV="$target/.Fleuron.app.previous.$$"
    rm -rf "$PREV" >/dev/null 2>&1 || true
    if ! mv "$DEST" "$PREV"; then
      PREV=""
      die 50 "failed to move existing $DEST aside"
    fi
    if ! mv "$STAGE" "$DEST"; then
      mv "$PREV" "$DEST" >/dev/null 2>&1 || true
      PREV=""
      die 50 "failed to move new Fleuron.app into $DEST; previous version restored"
    fi
    STAGE=""
    if ! rm -rf "$PREV" >/dev/null 2>&1; then
      log "warning: could not remove previous bundle backup at $PREV"
    fi
    PREV=""
  else
    if ! mv "$STAGE" "$DEST"; then
      die 50 "failed to move staged Fleuron.app to $DEST; nothing was installed"
    fi
    STAGE=""
  fi

  hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || hdiutil detach "$MNT" -force -quiet >/dev/null 2>&1 || true
  MOUNTED=0

  log "installed Fleuron $FLEURON_VERSION to $DEST"
  log "done. Open Fleuron from Applications. Later updates arrive through Fleuron's built-in updater."
}

main() {
  local mode="install"
  local reinstall=0
  local arg=""
  local sys="" usr=""

  if [ -n "${FLEURON_INSTALL_TEST_SYSROOT:-}" ] || [ -n "${FLEURON_INSTALL_TEST_SYSTEM_APPS:-}" ]; then
    log "TEST MODE (sysroot=${FLEURON_INSTALL_TEST_SYSROOT:-unset}, system_apps=${FLEURON_INSTALL_TEST_SYSTEM_APPS:-unset})"
  fi

  if [ "$#" -gt 0 ]; then
    for arg in "$@"; do
      case "$arg" in
        *.dmg|*.DMG|*/*|~*)
          die 2 "This installer never uses a disk image you already have; it downloads and verifies its own copy."
          ;;
      esac
    done
    if [ "$#" -gt 1 ]; then
      die 2 "too many arguments (run with --help for usage)"
    fi
    case "$1" in
      --help|-h)
        usage
        exit 0
        ;;
      --uninstall)
        mode="uninstall"
        ;;
      --reinstall)
        mode="install"
        reinstall=1
        ;;
      *)
        die 2 "unknown option '$1' (run with --help for usage)"
        ;;
    esac
  fi

  if [ "$mode" = "install" ]; then
    check_template
  fi

  preflight

  sys="${FLEURON_INSTALL_TEST_SYSTEM_APPS:-/Applications}"
  usr="$HOME/Applications"

  if [ "$mode" = "uninstall" ]; then
    do_uninstall "$sys" "$usr"
  else
    do_install "$sys" "$usr" "$reinstall"
  fi
}

main "$@"
