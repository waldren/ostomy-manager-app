#!/usr/bin/env bash
# Copyright (C) 2026 Steven E. Waldren
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

# P4.S5 slice 3 (#158): drives a perf-flagged RELEASE build of apps/mobile on
# the Android emulator and collects SRS §5.1's phone numbers.
#
#   scripts/perf/phone-baseline.sh cold-start [runs]     # am start -W, then unlock
#   scripts/perf/phone-baseline.sh saves [runs]          # Add Output, end to end
#   scripts/perf/phone-baseline.sh quick-add [runs]      # the first Quick-Add widget
#   scripts/perf/phone-baseline.sh collect               # every perf: line so far
#
# Preconditions, all checked by a person rather than this script:
#   - a release build made with EXPO_PUBLIC_PERF_MARKS=1 and a plain-http
#     EXPO_PUBLIC_API_URL is installed (apps/mobile/src/perf/perfMarks.ts);
#   - the emulator is signed in as the development patient, at the default text
#     and display size, with a fingerprint enrolled (android-emulator.sh
#     fingerprint) so `emu finger touch 1` unlocks;
#   - `adb reverse` forwards 3000 and 8090 to the local dev stack.
#
# The device holds synthetic data only. Never run a flagged build anywhere else
# (docs/security-hipaa.md).
#
# Taps are by uiautomator text lookup, so they survive a layout change but not
# a copy change. The marks themselves are what is measured; adb only drives.

# No `pipefail`: the label lookup ends in `head -1`, which closes the pipe early,
# and the SIGPIPE upstream would fail the lookup and, with `-e`, end the run
# silently.
set -eu

# Git Bash rewrites an argument like /sdcard/ui.xml into a Windows path before
# adb sees it. Harmless anywhere else.
export MSYS_NO_PATHCONV=1

ADB="${ADB:-adb}"
PACKAGE="org.ostomy.diary"
ACTIVITY="${PACKAGE}/.MainActivity"
OUT_DIR="${PERF_OUT_DIR:-./perf-out}"
mkdir -p "${OUT_DIR}"
# The default ring buffer is small enough that the emulator's own chatter
# pushes perf lines out before they are collected (it lost 5 of 30 once).
"${ADB}" logcat -G 16M >/dev/null

log() { printf '%s\n' "$*" >&2; }

# Centre of the first on-screen node whose text or content description
# matches. `attribute` narrows it to one of the two: an input field and its
# visible label share the same words, and only the field takes focus.
centre_of() {
  local label="$1" attribute="${2:-text|content-desc}"
  "${ADB}" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  "${ADB}" shell cat /sdcard/ui.xml |
    tr '>' '\n' |
    grep -E "(${attribute})=\"${label}\"" |
    head -1 |
    sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p' |
    awk '{ printf "%d %d\n", ($1 + $3) / 2, ($2 + $4) / 2 }'
}

tap_label() {
  local label="$1" xy
  xy="$(centre_of "${label}" "${2:-text|content-desc}")"
  if [[ -z "${xy}" ]]; then
    log "no on-screen element labelled '${label}'"
    return 1
  fi
  # shellcheck disable=SC2086
  "${ADB}" shell input tap ${xy}
}

wait_for_label() {
  local label="$1" tries="${2:-30}"
  for ((i = 0; i < tries; i++)); do
    [[ -n "$(centre_of "${label}")" ]] && return 0
    sleep 1
  done
  log "timed out waiting for '${label}'"
  return 1
}

unlock() {
  wait_for_label 'Unlock my diary'
  tap_label 'Unlock my diary'
  sleep 2
  "${ADB}" -e emu finger touch 1 >/dev/null
  sleep 1
  "${ADB}" -e emu finger remove 1 >/dev/null
}

# Every perf: line logcat holds, with logcat's own timestamps.
collect() {
  "${ADB}" logcat -d -v time -s ReactNativeJS:I | grep ' perf:' || true
}

cold_start() {
  local runs="${1:-10}" out="${OUT_DIR}/cold-start.txt"
  : >"${out}"
  for ((run = 1; run <= runs; run++)); do
    "${ADB}" shell am force-stop "${PACKAGE}"
    sleep 2
    "${ADB}" logcat -c
    # TotalTime: process start to the first frame of the activity, Android's own measure.
    "${ADB}" shell am start -W -n "${ACTIVITY}" | tr -d '\r' | grep -E 'TotalTime|WaitTime' | sed "s/^/run ${run} /" >>"${out}"
    unlock
    wait_for_label 'Add a stoma entry' 30 || true
    sleep 3
    collect | sed "s/^/run ${run} /" >>"${out}"
    log "cold start ${run}/${runs} done"
  done
}

saves() {
  local runs="${1:-20}" out="${OUT_DIR}/saves.txt"
  : >"${out}"
  "${ADB}" logcat -c
  for ((run = 1; run <= runs; run++)); do
    # Through Home's button, as a patient does. (A deep link reaches the running
    # release build but does not navigate it.)
    wait_for_label 'Add a stoma entry'
    tap_label 'Add a stoma entry'
    wait_for_label 'Save entry'
    # Measured first, while the keyboard cannot cover it; then the field itself.
    tap_label 'Measured' 'content-desc'
    tap_label 'How much came out\?' 'content-desc'
    sleep 1
    # The same amount every time, so the saves themselves become a Quick-Add
    # routine for the quick-add run (a widget needs two identical entries).
    "${ADB}" shell input text 150
    # Back with the keyboard up closes the keyboard, not the screen.
    "${ADB}" shell input keyevent KEYCODE_BACK
    sleep 1
    tap_label 'Save entry' 'content-desc'
    wait_for_label 'Add a stoma entry' 15 || true
    sleep 1
    log "save ${run}/${runs} done"
  done
  collect >"${out}"
}

quick_add() {
  local runs="${1:-20}" out="${OUT_DIR}/quick-add.txt"
  : >"${out}"
  "${ADB}" logcat -c
  for ((run = 1; run <= runs; run++)); do
    wait_for_label 'Log again'
    tap_label 'Stoma output: [^"]*'
    sleep 2
    log "quick-add ${run}/${runs} done"
  done
  collect >"${out}"
}

case "${1:-}" in
  cold-start) cold_start "${2:-10}" ;;
  saves) saves "${2:-20}" ;;
  quick-add) quick_add "${2:-20}" ;;
  collect) collect ;;
  *)
    log "usage: $0 {cold-start|saves|quick-add|collect} [runs]"
    exit 2
    ;;
esac
