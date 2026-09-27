#!/usr/bin/env bash
# Install or verify a system Chromium browser for headless use.
#
# This script intentionally only manages Chromium. It does not install Node.js, npm packages,
# Vulkan/WebGPU drivers, or project dependencies.
#
# Usage:
#   scripts/setup-deps.sh              # install Chromium if needed
#   scripts/setup-deps.sh --check      # verify only; exit 1 if unavailable
#   scripts/setup-deps.sh --verbose    # print installation commands
#
# PLAYWRIGHT_CHROMIUM=/path/to/chromium can be used to verify a pre-provisioned browser.

set -euo pipefail

MODE=install
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --verbose|-v) VERBOSE=1 ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

run() {
  if [[ $VERBOSE -eq 1 ]]; then printf '  $'; printf ' %q' "$@"; printf '\n'; fi
  "$@"
}

find_chromium() {
  if [[ -n "${PLAYWRIGHT_CHROMIUM:-}" ]]; then
    [[ -x "$PLAYWRIGHT_CHROMIUM" ]] && { printf '%s\n' "$PLAYWRIGHT_CHROMIUM"; return 0; }
    return 1
  fi
  local name
  for name in chromium chromium-browser google-chrome-stable google-chrome; do
    if command -v "$name" >/dev/null 2>&1; then
      command -v "$name"
      return 0
    fi
  done
  return 1
}

verify_chromium() {
  local bin="$1" version
  "$bin" --headless --no-sandbox --disable-gpu --dump-dom about:blank >/dev/null 2>&1 || return 1
  version="$("$bin" --version 2>/dev/null || true)"
  [[ -n "$version" ]] || return 1
  printf '%s\n' "$version"
}

install_chromium() {
  local package=chromium prefix=()
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    if command -v sudo >/dev/null 2>&1; then
      prefix=(sudo)
    else
      echo "Chromium is missing and this install needs root privileges (sudo is unavailable)." >&2
      return 1
    fi
  fi

  if command -v apt-get >/dev/null 2>&1; then
    run "${prefix[@]}" apt-get update
    run "${prefix[@]}" apt-get install -y "$package"
  elif command -v dnf >/dev/null 2>&1; then
    run "${prefix[@]}" dnf install -y "$package"
  elif command -v yum >/dev/null 2>&1; then
    run "${prefix[@]}" yum install -y "$package"
  elif command -v pacman >/dev/null 2>&1; then
    run "${prefix[@]}" pacman -Sy --needed --noconfirm "$package"
  elif command -v apk >/dev/null 2>&1; then
    run "${prefix[@]}" apk add --no-cache "$package"
  else
    echo "No supported package manager found. Install Chromium using your OS package manager." >&2
    return 1
  fi
}

if browser="$(find_chromium)"; then
  if version="$(verify_chromium "$browser")"; then
    printf 'Chromium is ready: %s (%s)\n' "$browser" "$version"
    exit 0
  fi
  echo "Found $browser, but it could not be launched headlessly." >&2
  if [[ $MODE == check ]]; then exit 1; fi
else
  if [[ $MODE == check ]]; then
    echo "Chromium is not installed (checked PLAYWRIGHT_CHROMIUM and PATH)." >&2
    exit 1
  fi
  echo "Chromium is not installed; attempting installation."
fi

if [[ $MODE == check ]]; then exit 1; fi
install_chromium

if ! browser="$(find_chromium)" || ! version="$(verify_chromium "$browser")"; then
  echo "Chromium installation finished, but no working headless browser was found." >&2
  exit 1
fi
printf 'Chromium is ready: %s (%s)\n' "$browser" "$version"
