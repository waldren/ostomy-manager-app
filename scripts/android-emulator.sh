#!/usr/bin/env bash
#
# Creates, boots and wires an Android emulator for testing `apps/mobile`.
#
# The mobile app cannot run in Expo Go: `app.json` enables SQLCipher through
# the `expo-sqlite` config plugin (ADR-0014), which is a native change, so
# every on-device test needs a development build. This script manages the
# device half of that loop — the AVD, its boot, and the port forwarding that
# lets it reach the Compose stack.
#
# ## Why `adb reverse` and never 10.0.2.2
#
# The emulator's classic alias for the host loopback is `10.0.2.2`, and using
# it here breaks sign-in in a way that looks like an app bug. The dev stack's
# `mock-oidc` derives its advertised `issuer` from the request's Host header:
#
#   Host: localhost:8090  ->  "issuer": "http://localhost:8090/patient-issuer"
#   Host: 10.0.2.2:8090   ->  "issuer": "http://10.0.2.2:8090/patient-issuer"
#
# apps/api validates `iss` against its own `OIDC_ISSUER`, by EXACT STRING
# EQUALITY. So a device reaching the IdP as 10.0.2.2 gets tokens the API
# rejects with a bare 401, after a sign-in that appeared to succeed. `adb
# reverse` keeps the hostname identical on both sides, which is what makes
# apps/mobile/.env work unmodified.
#
# `OIDC_ISSUER` is NOT fixed at localhost: infra/docker-compose.yml derives it
# from ${DEV_HOST_ADDRESS}. For this emulator path that value must be exactly
# `localhost`, because that is the host the device presents. R.S1 hit this with
# `DEV_HOST_ADDRESS=127.0.0.1` — which looks interchangeable and is not, since
# the comparison is string equality, so `/thresholds`, `/sync/delta` and
# `/value-sets` all returned 401 on a valid signature. Note .env.example warns
# against `localhost` for any LAN client; the emulator is the exception, not
# the rule.
#
# ## Usage
#
#   scripts/android-emulator.sh doctor    # what's installed, what's missing
#   scripts/android-emulator.sh create    # create the Pixel 8 AVD if absent
#   scripts/android-emulator.sh start     # boot it and wait for boot_completed
#   scripts/android-emulator.sh wire      # adb reverse for the dev stack
#   scripts/android-emulator.sh up        # create + start + wire
#   scripts/android-emulator.sh status    # device state and forwarded ports
#   scripts/android-emulator.sh logcat    # this app's logs only
#   scripts/android-emulator.sh fingerprint  # PIN + fingerprint enrolment (ADR-0015)
#   scripts/android-emulator.sh stop      # shut the emulator down
#   scripts/android-emulator.sh wipe      # cold-boot with factory-reset data
#
# `create`, `start` and `wire` are each idempotent — running `up` twice is a
# no-op the second time, which is what lets a session call it without first
# checking whether it already ran.

set -euo pipefail

# The repo root from this script's OWN location, not from `git rev-parse`.
#
# `git` is not always on PATH when this runs. `pnpm --filter @ostomy/mobile
# emulator:*` from PowerShell resolves the bare word `bash` to
# C:\Windows\System32\bash.exe — WSL — which has neither git nor the Windows
# environment. The old line then failed in the worst possible way: command
# substitution produced an empty string, `cd ""` is a silent no-op that
# SUCCEEDS even under `set -e`, and the script carried on from whatever
# directory it happened to be in to fail later with an unrelated message
# about the Android SDK.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd -- "${REPO_ROOT}"

# Running under WSL against a Windows checkout cannot work, and saying so here
# is far kinder than the symptom. The emulator, adb and the AVD definitions
# are Windows-side: WSL would need its own Linux SDK, would run a second adb
# server that does not see the Windows one's devices, and reads the AVD home
# through /mnt with different path semantics. Better to name the cause.
if [[ -r /proc/version ]] && grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
  if [[ "${REPO_ROOT}" == /mnt/* ]] || [[ -n "${WSL_DISTRO_NAME:-}" && ! -d "${HOME}/Android/Sdk" ]]; then
    cat >&2 <<'EOF'
ERROR: this is running under WSL, against a Windows checkout.

The emulator, adb and the AVD definitions live on the Windows side. WSL would
start a second adb server that cannot see the Windows one's devices.

This usually means `bash` resolved to C:\Windows\System32\bash.exe. Run the
command from Git Bash instead of PowerShell or cmd:

  "C:\Program Files\Git\bin\bash.exe" scripts/android-emulator.sh <command>

Or, from PowerShell, point npm at Git Bash for the session:

  npm config set script-shell "C:\Program Files\Git\bin\bash.exe"
EOF
    exit 1
  fi
fi

# --- Configuration ------------------------------------------------------------

AVD_NAME="${ANDROID_AVD_NAME:-Pixel_8}"
AVD_DEVICE="pixel_8"
EMULATOR_SERIAL="${ANDROID_EMULATOR_SERIAL:-emulator-5554}"
EMULATOR_PORT="${ANDROID_EMULATOR_PORT:-5554}"
APP_PACKAGE="org.ostomy.diary"

# The system image to build the AVD from. `google_apis` — NOT `default`, and
# NOT `google_apis_playstore`.
#
# This was `default`, on the reasoning that nothing in this app talks to a
# Google service (push delivery sits behind an adapter that is log-only in
# development, docs/deployment-development.md) and that the Play image forbids
# `adb root`, which is the only way to inspect app-private storage when
# debugging. Both halves of that are still true and are why the Play image is
# still wrong here.
#
# What it missed, found by the Gate B walkthrough (R.S1): the `default` image
# ships **no browser that provides Custom Tabs**. It carries
# `com.android.webview` and the Chromium shell and nothing else. OIDC sign-in
# goes through `WebBrowser.openAuthSessionAsync`, which needs a Custom Tabs
# provider to intercept the redirect back to `ostomydiary://redirect`. Without
# one, Android delivers the redirect to the app as an ordinary deep link,
# Expo Router has no route for it and renders "Unmatched Route", and
# `promptAsync()` never resolves — so the token exchange never happens and
# **no signed-in session is reachable on this AVD at all**. Every clinical
# screen sits behind that sign-in, so the emulator could not exercise any of
# them.
#
# `google_apis` includes Chrome, which supplies Custom Tabs, and still permits
# `adb root`. It satisfies both of the original constraints rather than
# trading one away.
SYSTEM_IMAGE_API="${ANDROID_SYSTEM_IMAGE_API:-36}"
SYSTEM_IMAGE_TAG="google_apis"
SYSTEM_IMAGE_ABI="x86_64"

# Host ports the emulator must reach as its own `localhost`. Keep this list in
# step with infra/docker-compose.yml's published ports. Deliberately NOT the
# whole stack: MinIO's console (9001) and the admin SPA (8081) are not things
# a patient device may reach, and forwarding them would let a device bug
# reach a surface the real topology denies it.
REVERSE_PORTS=(
  "3000" # apps/api
  "8090" # mock-oidc (patient issuer)
)

# --- SDK discovery ------------------------------------------------------------

# Resolved once, here, rather than depending on ANDROID_HOME being exported:
# Android Studio does not set it, and a developer who has never opened a
# terminal for Android work will not have it. An explicit ANDROID_HOME still
# wins when one is set.
detect_sdk() {
  # `LOCALAPPDATA` is not always exported into the shell that runs this — a
  # bare `${LOCALAPPDATA:-}/Android/Sdk` then probes the literal `/Android/Sdk`
  # and reports "no SDK found" on a machine that plainly has one. Derived from
  # the Windows profile directory when absent.
  local local_appdata="${LOCALAPPDATA:-}"
  if [[ -z "${local_appdata}" && -n "${USERPROFILE:-}" ]]; then
    local_appdata="${USERPROFILE}/AppData/Local"
  fi
  if [[ -z "${local_appdata}" && -d "${HOME}/AppData/Local" ]]; then
    local_appdata="${HOME}/AppData/Local"
  fi

  local candidates=(
    "${ANDROID_HOME:-}"
    "${ANDROID_SDK_ROOT:-}"
    "${local_appdata:-/nonexistent}/Android/Sdk"
    "${HOME}/Android/Sdk"
    "${HOME}/Library/Android/sdk"
  )
  for candidate in "${candidates[@]}"; do
    if [[ -n "${candidate}" && -d "${candidate}/platform-tools" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

SDK="$(detect_sdk || true)"
if [[ -z "${SDK}" ]]; then
  cat >&2 <<'EOF'
ERROR: no Android SDK found.

Looked at $ANDROID_HOME, $ANDROID_SDK_ROOT, %LOCALAPPDATA%\Android\Sdk,
~/Android/Sdk and ~/Library/Android/sdk.

Install Android Studio, open it once so it provisions the SDK, then re-run.
EOF
  exit 1
fi

# `.exe` on Git Bash, bare elsewhere. Resolved rather than assumed so the same
# script runs on a Linux CI host and on a Windows workstation.
exe() {
  local base="$1"
  if [[ -x "${base}.exe" ]]; then printf '%s\n' "${base}.exe"; else printf '%s\n' "${base}"; fi
}

ADB="$(exe "${SDK}/platform-tools/adb")"
EMULATOR="$(exe "${SDK}/emulator/emulator")"
# `.bat` on Windows, extensionless elsewhere — checking only the latter is how
# the first version of this reported cmdline-tools absent on a machine that had
# just installed them.
AVDMANAGER=""
SDKMANAGER=""
for candidate in "${SDK}"/cmdline-tools/*/bin/avdmanager{,.bat}; do
  if [[ -f "${candidate}" ]]; then AVDMANAGER="${candidate}"; break; fi
done
for candidate in "${SDK}"/cmdline-tools/*/bin/sdkmanager{,.bat}; do
  if [[ -f "${candidate}" ]]; then SDKMANAGER="${candidate}"; break; fi
done
ANDROID_CLI=""
for candidate in "${SDK}"/cmdline-tools/*/bin/android{,.exe}; do
  if [[ -f "${candidate}" ]]; then ANDROID_CLI="${candidate}"; break; fi
done

# The versions the build actually demands, read from React Native's own pin
# file rather than copied here. Copying them means this check keeps passing
# against last year's numbers after an Expo upgrade moves them — and the
# failure that produces is a Gradle error about a hash string, pointing at
# nothing.
# Both layouts, because `.npmrc` sets `node-linker=hoisted` (which puts
# react-native in the ROOT node_modules) while a checkout installed with
# pnpm's default still nests it under the workspace. Hardcoding either one
# makes this silently skip its own version checks on the other.
RN_VERSIONS=""
for candidate in \
  "node_modules/react-native/gradle/libs.versions.toml" \
  "apps/mobile/node_modules/react-native/gradle/libs.versions.toml"
do
  if [[ -f "${candidate}" ]]; then RN_VERSIONS="${candidate}"; break; fi
done

required_pin() {
  local key="$1"
  [[ -n "${RN_VERSIONS}" && -f "${RN_VERSIONS}" ]] || return 1
  sed -n "s/^${key}[[:space:]]*=[[:space:]]*\"\([^\"]*\)\".*/\1/p" "${RN_VERSIONS}" | head -1
}

AVD_HOME="${ANDROID_AVD_HOME:-${HOME}/.android/avd}"

# --- Output helpers -----------------------------------------------------------

# A copy-pasteable install line when sdkmanager is available, and the GUI path
# when it is not. Never runs the install itself: these are multi-hundred-
# megabyte downloads with a licence to accept, and that is the developer's
# call, not this script's.
install_hint() {
  # `package` arrives in the classic `platforms;android-36` spelling.
  local package="$1"
  if [[ -n "${ANDROID_CLI}" ]]; then
    # Recent cmdline-tools deprecate sdkmanager in favour of an `android sdk`
    # CLI whose package separator is `/`, not `;` — and whose sdkmanager shim
    # REJECTS the `;` form outright ("Package platforms not found"). So the
    # separator is translated rather than passed through: a hint that does not
    # run is worse than no hint, because it reads as a tooling bug.
    printf '"%s" sdk install "%s"' "${ANDROID_CLI}" "${package//;//}"
  elif [[ -n "${SDKMANAGER}" ]]; then
    printf '"%s" "%s"' "${SDKMANAGER}" "${package}"
  else
    printf 'Android Studio > SDK Manager (check "Show Package Details") > %s' "${package}"
  fi
}

ok()   { printf '  ok      %s\n' "$*"; }
warn() { printf '  WARN    %s\n' "$*"; }
bad()  { printf '  MISSING %s\n' "$*"; }
step() { printf '==> %s\n' "$*"; }

# The bundle is the one thing `adb reverse` cannot redirect.
#
# Everything else this script forwards — the API on 3000, mock-oidc on 8090 —
# the app requests as `localhost`, so the device-side listener `adb reverse`
# installs picks it up. The React Native dev client does not: on an emulator
# `AndroidInfoHelpers.getServerHost()` returns **10.0.2.2**, the QEMU alias for
# the host's loopback, which the emulator's own network stack resolves. adb is
# not in that path at all, so `reverse tcp:8081 tcp:8082` has no effect on it.
#
# This script used to advise exactly that, and it cannot work: the device asks
# 10.0.2.2:8081, reaches host 8081, and gets whatever is published there — the
# admin SPA, which answers 200 with HTML that is not a bundle. Verified by
# logcat (`A connection to http://10.0.2.2:8081/ was leaked`) and by the bundle
# only loading once Metro held host 8081.
#
# So Metro needs host 8081 itself, which means stopping the admin container.
# The alternative is setting the dev client's `debug_http_host` preference to
# `localhost:8081` per install, which is per-device state no script should be
# silently writing.

# --- doctor -------------------------------------------------------------------

cmd_doctor() {
  local failures=0

  step "Android SDK"
  ok "SDK at ${SDK}"
  # This script finds the SDK for itself, so every emulator command works
  # without it — but Gradle does not, and it fails at CONFIGURE time with
  # "SDK location not found", naming a `local.properties` that does not exist
  # rather than the variable it actually wants. `android/` is generated build
  # output, so writing that file is not a durable fix; exporting is.
  #
  # Reported the same way as the JDK below, because the failure looks identical
  # to a broken checkout and cost a session's build cycle to diagnose.
  if [[ -z "${ANDROID_HOME:-}" && -z "${ANDROID_SDK_ROOT:-}" ]]; then
    warn "neither ANDROID_HOME nor ANDROID_SDK_ROOT is set. Gradle needs one. Export this before building:"
    warn "           export ANDROID_HOME=\"${SDK}\""
  fi
  [[ -x "${ADB}" ]] && ok "adb" || { bad "platform-tools/adb"; failures=$((failures + 1)); }
  [[ -x "${EMULATOR}" ]] && ok "emulator" || { bad "emulator"; failures=$((failures + 1)); }

  if [[ -n "${AVDMANAGER}" ]]; then
    ok "avdmanager (${AVDMANAGER})"
  else
    # Not fatal: `create` writes the AVD definition directly. It IS fatal for
    # installing anything new, which is why the message names that use.
    warn "cmdline-tools/avdmanager absent — 'create' falls back to writing the AVD"
    warn "         definition directly. You still need cmdline-tools to install an SDK"
    warn "         platform or a system image:"
    warn "         Android Studio > Settings > Languages & Frameworks > Android SDK"
    warn "         > SDK Tools > check 'Android SDK Command-line Tools (latest)'"
  fi

  step "System image (the AVD is built from this)"
  local image_dir="${SDK}/system-images/android-${SYSTEM_IMAGE_API}/${SYSTEM_IMAGE_TAG}/${SYSTEM_IMAGE_ABI}"
  if [[ -d "${image_dir}" ]]; then
    ok "android-${SYSTEM_IMAGE_API}/${SYSTEM_IMAGE_TAG}/${SYSTEM_IMAGE_ABI}"
  else
    bad "android-${SYSTEM_IMAGE_API}/${SYSTEM_IMAGE_TAG}/${SYSTEM_IMAGE_ABI}"
    printf '          Install via Android Studio > SDK Manager > SDK Platforms\n'
    printf '          > (check "Show Package Details") > Android %s > "Intel x86_64 Atom System Image"\n' "${SYSTEM_IMAGE_API}"
    failures=$((failures + 1))
  fi

  step "Hardware acceleration"
  if "${EMULATOR}" -accel-check >/dev/null 2>&1; then
    ok "$("${EMULATOR}" -accel-check 2>&1 | grep -iE 'is installed and usable' | head -1 | sed 's/^ *//')"
  else
    warn "no hypervisor detected — the emulator will run, very slowly, in software"
  fi

  step "Toolchain for building the development build"
  # Reported, never auto-installed: each of these is a large download, and a
  # script that silently pulls hundreds of megabytes is not one a developer
  # can reason about.
  # The VERSION matters, not merely that a JDK exists. Android Studio 2026
  # bundles JDK 25, and AGP 8.12 (what React Native 0.86 pins) cannot drive
  # CMake on it: JEP 472's restricted-method enforcement turns every native
  # module's configure step into
  #   "Execution failed for task ':expo-sqlite:configureCMakeDebug[x86_64]'.
  #    > WARNING: A restricted method in java.lang.System has been called"
  # which names neither the JDK nor the real cause. Checking only for presence
  # let that through and cost a full build cycle to diagnose, so the range is
  # checked here.
  local jdk="" jdk_major=""
  for candidate in \
    "${JAVA_HOME:-}/bin/java" \
    "${JAVA_HOME:-}/bin/java.exe" \
    "${HOME}/.gradle/jdks"/*/bin/java.exe \
    "${HOME}/.gradle/jdks"/*/bin/java \
    "/c/Program Files/Android/Android Studio/jbr/bin/java.exe" \
    "$(command -v java || true)"
  do
    [[ -n "${candidate}" && -x "${candidate}" ]] || continue
    jdk_major="$("${candidate}" -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)"
    # First one in a supported range wins, so a usable JDK sitting beside an
    # unusable one is found rather than shadowed by it.
    if [[ -n "${jdk_major}" ]] && (( jdk_major >= 17 && jdk_major <= 21 )); then
      jdk="${candidate}"
      break
    fi
  done

  if [[ -n "${jdk}" ]]; then
    ok "JDK ${jdk_major} (${jdk})"
    if [[ "$("${JAVA_HOME:-}/bin/java" -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)" != "${jdk_major}" ]]; then
      warn "JAVA_HOME does not point at it. Export this before building:"
      warn "           export JAVA_HOME=\"$(dirname "$(dirname "${jdk}")")\""
    fi
  else
    bad "no JDK in the range AGP 8.12 supports (17-21)"
    printf '          Android Studio bundles JDK 25, which fails every native module at\n'
    printf '          configure time with a misleading "restricted method" error.\n'
    printf '          Gradle often has a usable one already: ~/.gradle/jdks/\n'
    failures=$((failures + 1))
  fi

  # Expo SDK 57 / React Native 0.86 compiles against platform android-36. A
  # Gradle build asks the SDK to fetch a missing platform itself, and that
  # fetch needs cmdline-tools — so an absent platform plus absent
  # cmdline-tools fails the build with a message about neither.
  local want_sdk want_ndk
  want_sdk="$(required_pin compileSdk || true)"
  want_ndk="$(required_pin ndkVersion || true)"

  if [[ -z "${want_sdk}" || -z "${want_ndk}" ]]; then
    warn "cannot read ${RN_VERSIONS} — run pnpm install; skipping the version checks"
  else
    # Exact directory, not a prefix match. `platforms/android-36.1` is the
    # Android 16 QPR1 platform and does NOT satisfy `compileSdk 36`: AGP
    # resolves that to the hash string `android-36` and fails when only the
    # minor-versioned one is present. Android Studio's SDK Manager offers
    # 36.1 by default, so having "Android 16" checked is not the same as
    # having what the build wants.
    if [[ -d "${SDK}/platforms/android-${want_sdk}" ]]; then
      ok "platform android-${want_sdk}"
    else
      bad "platform android-${want_sdk} (React Native pins compileSdk=${want_sdk})"
      printf '          present: %s\n' "$(ls "${SDK}/platforms" 2>/dev/null | tr '\n' ' ')"
      printf '          install: %s\n' "$(install_hint "platforms;android-${want_sdk}")"
      failures=$((failures + 1))
    fi

    # An exact version too, for the same reason: `ndkVersion` in Gradle is an
    # equality test, not a floor. A newer NDK does not satisfy it.
    if [[ -d "${SDK}/ndk/${want_ndk}" ]]; then
      ok "NDK ${want_ndk}"
    else
      bad "NDK ${want_ndk} (React Native pins it exactly; a newer one does not satisfy Gradle)"
      printf '          present: %s\n' "$(ls "${SDK}/ndk" 2>/dev/null | tr '\n' ' ')"
      printf '          install: %s\n' "$(install_hint "ndk;${want_ndk}")"
      failures=$((failures + 1))
    fi
  fi

  step "AVD"
  if avd_exists; then
    ok "${AVD_NAME} exists"
  else
    warn "${AVD_NAME} absent — run: scripts/android-emulator.sh create"
  fi

  step "Development stack (the emulator is pointless without it)"
  if docker compose --env-file .env -f infra/docker-compose.yml ps --status running --format '{{.Service}}' 2>/dev/null | grep -q '^api$'; then
    ok "api is running"
  else
    warn "api is not running — start it with:"
    warn "         docker compose --env-file .env -f infra/docker-compose.yml up -d"
  fi

  printf '\n'
  if (( failures > 0 )); then
    printf 'doctor: %d item(s) missing — see which section failed above. The emulator\n' "${failures}"
    printf '        itself may still run. This exits non-zero on purpose so it is usable\n'
    printf '        as a gate; a pnpm "recursive run failed" line after this is that exit,\n'
    printf '        not a crash.\n'
    return 1
  fi
  printf 'doctor: everything needed is present.\n'
}

# --- create -------------------------------------------------------------------

avd_exists() {
  [[ -f "${AVD_HOME}/${AVD_NAME}.ini" ]]
}

cmd_create() {
  if avd_exists; then
    step "AVD ${AVD_NAME} already exists — nothing to do"
    return 0
  fi

  local image_dir="${SDK}/system-images/android-${SYSTEM_IMAGE_API}/${SYSTEM_IMAGE_TAG}/${SYSTEM_IMAGE_ABI}"
  if [[ ! -d "${image_dir}" ]]; then
    printf 'ERROR: system image android-%s/%s/%s is not installed.\n' \
      "${SYSTEM_IMAGE_API}" "${SYSTEM_IMAGE_TAG}" "${SYSTEM_IMAGE_ABI}" >&2
    printf 'Run: scripts/android-emulator.sh doctor\n' >&2
    exit 1
  fi

  if [[ -n "${AVDMANAGER}" ]]; then
    step "Creating ${AVD_NAME} with avdmanager"
    echo "no" | "${AVDMANAGER}" create avd \
      --name "${AVD_NAME}" \
      --device "${AVD_DEVICE}" \
      --package "system-images;android-${SYSTEM_IMAGE_API};${SYSTEM_IMAGE_TAG};${SYSTEM_IMAGE_ABI}" \
      --force
  else
    step "Creating ${AVD_NAME} by writing its definition (no cmdline-tools present)"
    write_avd_definition
  fi

  tune_avd
  step "Created ${AVD_NAME}"
}

# Writes the AVD by hand, for the common case where Android Studio installed
# the SDK but not the command-line tools. The values are the Pixel 8 hardware
# profile as Studio itself emits it; `hw.device.hash2` is how the emulator
# detects that a stored AVD has drifted from the device definition it names,
# and a wrong one costs a warning, not a failure.
write_avd_definition() {
  local avd_dir="${AVD_HOME}/${AVD_NAME}.avd"
  mkdir -p "${avd_dir}"

  # The pointer file. `path.rel` keeps the AVD relocatable with the home
  # directory; `path` is absolute because the emulator reads it first.
  cat > "${AVD_HOME}/${AVD_NAME}.ini" <<EOF
avd.ini.encoding=UTF-8
path=$(to_native_path "${avd_dir}")
path.rel=avd/${AVD_NAME}.avd
target=android-${SYSTEM_IMAGE_API}
EOF

  cat > "${avd_dir}/config.ini" <<EOF
AvdId=${AVD_NAME}
PlayStore.enabled=false
abi.type=${SYSTEM_IMAGE_ABI}
avd.ini.displayname=Pixel 8
avd.ini.encoding=UTF-8
disk.dataPartition.size=10G
fastboot.forceColdBoot=no
fastboot.forceFastBoot=yes
hw.accelerometer=yes
hw.arc=false
hw.audioInput=yes
hw.battery=yes
hw.camera.back=virtualscene
hw.camera.front=emulated
hw.cpu.arch=${SYSTEM_IMAGE_ABI}
hw.cpu.ncore=4
hw.dPad=no
hw.device.hash2=MD5:fbe1eac454dad6439d972cce5eda9e57
hw.device.manufacturer=Google
hw.device.name=${AVD_DEVICE}
hw.gps=yes
hw.gpu.enabled=yes
hw.gpu.mode=auto
hw.gyroscope=yes
hw.initialOrientation=portrait
hw.keyboard=yes
hw.lcd.density=420
hw.lcd.height=2400
hw.lcd.width=1080
hw.mainKeys=no
hw.ramSize=4096
hw.sdCard=yes
hw.sensors.light=yes
hw.sensors.magnetic_field=yes
hw.sensors.orientation=yes
hw.sensors.pressure=yes
hw.sensors.proximity=yes
hw.trackBall=no
image.sysdir.1=system-images/android-${SYSTEM_IMAGE_API}/${SYSTEM_IMAGE_TAG}/${SYSTEM_IMAGE_ABI}/
runtime.network.latency=none
runtime.network.speed=full
sdcard.size=512M
showDeviceFrame=yes
skin.dynamic=yes
skin.name=${AVD_DEVICE}
skin.path=$(to_native_path "${SDK}/skins/${AVD_DEVICE}")
tag.display=Default Android System Image
tag.id=${SYSTEM_IMAGE_TAG}
target=android-${SYSTEM_IMAGE_API}
vm.heapSize=512
EOF
}

# Applies the settings this project needs on top of whatever produced the AVD,
# so an AVD made in Studio's GUI gets them too. Idempotent by rewriting each
# key rather than appending.
tune_avd() {
  local config="${AVD_HOME}/${AVD_NAME}.avd/config.ini"
  [[ -f "${config}" ]] || return 0

  # 2 GB is Studio's default and is not enough for a React Native development
  # build with Metro attached — the app is killed mid-session under memory
  # pressure, which reads as a crash in the app rather than as a starved VM.
  set_config_key "${config}" "hw.ramSize" "4096"
  set_config_key "${config}" "vm.heapSize" "512"
  # Needed to enrol a fingerprint, which ADR-0015's behaviour depends on.
  set_config_key "${config}" "hw.keyboard" "yes"
}

set_config_key() {
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "${file}"; then
    # A temp file rather than `sed -i`: BSD and GNU sed disagree about -i's
    # argument, and this script runs on both.
    sed "s|^${key}=.*|${key}=${value}|" "${file}" > "${file}.tmp" && mv "${file}.tmp" "${file}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${file}"
  fi
}

# Git Bash hands out /c/... paths; the emulator is a native Windows binary and
# needs C:\... Everywhere else this is the identity function.
to_native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s\n' "$1"; fi
}

# --- start --------------------------------------------------------------------

emulator_is_running() {
  "${ADB}" devices | grep -q "^${EMULATOR_SERIAL}[[:space:]]*device$"
}

cmd_start() {
  if emulator_is_running; then
    step "${EMULATOR_SERIAL} is already booted"
    return 0
  fi

  if ! avd_exists; then
    printf 'ERROR: AVD %s does not exist. Run: scripts/android-emulator.sh create\n' "${AVD_NAME}" >&2
    exit 1
  fi

  step "Booting ${AVD_NAME} on port ${EMULATOR_PORT}"
  # Detached, with output kept: a failed boot says why in this log, and the
  # emulator holds the terminal otherwise.
  local log="${TMPDIR:-/tmp}/ostomy-emulator-${AVD_NAME}.log"
  (
    cd "${SDK}/emulator"
    ANDROID_HOME="${SDK}" ANDROID_SDK_ROOT="${SDK}" \
      "${EMULATOR}" -avd "${AVD_NAME}" \
      -port "${EMULATOR_PORT}" \
      -no-boot-anim \
      -no-snapshot-save \
      >"${log}" 2>&1 &
  )
  printf '    log: %s\n' "${log}"

  step "Waiting for boot to complete"
  local waited=0
  local timeout="${ANDROID_BOOT_TIMEOUT:-300}"
  while true; do
    if [[ "$("${ADB}" -s "${EMULATOR_SERIAL}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; then
      break
    fi
    if (( waited >= timeout )); then
      printf 'ERROR: emulator did not finish booting in %ds. See %s\n' "${timeout}" "${log}" >&2
      exit 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
  ok "booted in ~${waited}s"
}

# --- wire ---------------------------------------------------------------------

cmd_wire() {
  if ! emulator_is_running; then
    printf 'ERROR: %s is not running. Run: scripts/android-emulator.sh start\n' "${EMULATOR_SERIAL}" >&2
    exit 1
  fi

  step "Forwarding host ports into the emulator (see this file's header for why)"
  for port in "${REVERSE_PORTS[@]}"; do
    "${ADB}" -s "${EMULATOR_SERIAL}" reverse "tcp:${port}" "tcp:${port}" >/dev/null
    ok "localhost:${port} -> host localhost:${port}"
  done

  # Metro's default is 8081, which infra/docker-compose.yml already publishes
  # for the admin SPA. Expo then quietly picks another port and the device
  # cannot find the bundler.
  if lsof -i ":8081" >/dev/null 2>&1 || netstat -an 2>/dev/null | grep -qE '[.:]8081[[:space:]]+.*LISTEN'; then
    warn "host port 8081 is in use (the admin SPA publishes it)."
    warn "         Metro MUST have host 8081. Stop the admin container first:"
    warn "           docker stop ostomy-dev-admin"
    warn "           pnpm --filter @ostomy/mobile start --port 8081"
    warn "         (restart it afterwards: docker start ostomy-dev-admin)"
  fi
}

# --- status -------------------------------------------------------------------

cmd_status() {
  step "Devices"
  "${ADB}" devices -l | sed '1d;/^$/d' | sed 's/^/  /'

  if ! emulator_is_running; then
    printf '\n  %s is not running.\n' "${EMULATOR_SERIAL}"
    return 0
  fi

  step "Build"
  printf '  API level %s (Android %s), %s\n' \
    "$("${ADB}" -s "${EMULATOR_SERIAL}" shell getprop ro.build.version.sdk | tr -d '\r')" \
    "$("${ADB}" -s "${EMULATOR_SERIAL}" shell getprop ro.build.version.release | tr -d '\r')" \
    "$("${ADB}" -s "${EMULATOR_SERIAL}" shell getprop ro.product.cpu.abi | tr -d '\r')"

  step "Forwarded ports"
  local reversed
  reversed="$("${ADB}" -s "${EMULATOR_SERIAL}" reverse --list 2>/dev/null || true)"
  if [[ -z "${reversed}" ]]; then
    printf '  none — run: scripts/android-emulator.sh wire\n'
  else
    printf '%s\n' "${reversed}" | sed 's/^/  /'
  fi

  step "App"
  if "${ADB}" -s "${EMULATOR_SERIAL}" shell pm list packages 2>/dev/null | grep -q "package:${APP_PACKAGE}$"; then
    printf '  %s is installed\n' "${APP_PACKAGE}"
  else
    printf '  %s is NOT installed — build it with:\n' "${APP_PACKAGE}"
    printf '    pnpm --filter @ostomy/mobile android:build\n'
  fi
}

# --- logcat -------------------------------------------------------------------

cmd_logcat() {
  if ! emulator_is_running; then
    printf 'ERROR: %s is not running.\n' "${EMULATOR_SERIAL}" >&2
    exit 1
  fi

  local pid
  pid="$("${ADB}" -s "${EMULATOR_SERIAL}" shell pidof "${APP_PACKAGE}" 2>/dev/null | tr -d '\r' || true)"

  # Scoped to this app's process rather than the whole device ring buffer.
  # The narrow filter is the point: a full logcat is a large blob of someone
  # else's output to page through, and this app's rule is that no clinical
  # value is ever logged in the first place (CLAUDE.md) — so if a value shows
  # up here, that is the finding, not noise to scroll past.
  if [[ -n "${pid}" ]]; then
    step "logcat for ${APP_PACKAGE} (pid ${pid}) — Ctrl-C to stop"
    "${ADB}" -s "${EMULATOR_SERIAL}" logcat --pid="${pid}"
  else
    step "${APP_PACKAGE} is not running; showing ReactNative/Expo tags — Ctrl-C to stop"
    "${ADB}" -s "${EMULATOR_SERIAL}" logcat -s ReactNative:V ReactNativeJS:V ExpoModulesCore:V AndroidRuntime:E
  fi
}

# --- fingerprint --------------------------------------------------------------

cmd_fingerprint() {
  if ! emulator_is_running; then
    printf 'ERROR: %s is not running.\n' "${EMULATOR_SERIAL}" >&2
    exit 1
  fi

  local pin="${ANDROID_DEVICE_PIN:-1234}"

  # A device credential first, and not merely because the enrolment flow asks
  # for one: a key created with setUserAuthenticationRequired cannot exist on
  # a device with no secure lock screen. Without this the app's biometric path
  # does not fail — it reports biometrics unavailable and falls through, which
  # looks like a passing test of a code path that never ran (ADR-0015).
  step "Setting a device PIN (${pin})"
  "${ADB}" -s "${EMULATOR_SERIAL}" shell "locksettings set-pin ${pin}" 2>&1 | sed 's/^/  /'

  step "Opening fingerprint enrolment"
  "${ADB}" -s "${EMULATOR_SERIAL}" shell am start -a android.settings.FINGERPRINT_ENROLL >/dev/null 2>&1 || \
    "${ADB}" -s "${EMULATOR_SERIAL}" shell am start -a android.settings.SECURITY_SETTINGS >/dev/null 2>&1

  cat <<EOF

  The enrolment wizard is now on the emulator screen. It asks for the touch
  several times; each touch is this command, run from here:

    ${ADB} -s ${EMULATOR_SERIAL} emu finger touch 1

  Repeat until the wizard reports success. Afterwards:

    unlock with the enrolled finger   ${ADB} -s ${EMULATOR_SERIAL} emu finger touch 1
    present an unknown finger         ${ADB} -s ${EMULATOR_SERIAL} emu finger touch 2
    invalidate enrolment (ADR-0015)   remove the fingerprint in Settings, or
                                      ${ADB} -s ${EMULATOR_SERIAL} shell locksettings clear --old ${pin}

  What this does and does not prove: the emulator reports
  android.hardware.fingerprint and a hardware_keystore, so enrolment,
  unlock, rejection and enrolment-invalidation all execute for real. It
  reports no android.hardware.strongbox_keystore, so this is KeyMint in
  software — it exercises the LOGIC of ADR-0014/ADR-0015, not the hardware
  guarantee behind them. "Verified on hardware" still needs hardware.
EOF
}

# --- stop / wipe --------------------------------------------------------------

cmd_stop() {
  if ! emulator_is_running; then
    step "${EMULATOR_SERIAL} is not running"
    return 0
  fi
  step "Stopping ${EMULATOR_SERIAL}"
  "${ADB}" -s "${EMULATOR_SERIAL}" emu kill >/dev/null 2>&1 || true
  local waited=0
  while emulator_is_running && (( waited < 30 )); do
    sleep 2
    waited=$((waited + 2))
  done
  ok "stopped"
}

cmd_wipe() {
  # A factory reset is how you get back to "this app has never run on this
  # device". That state is not cosmetic here: ADR-0014 binds the encrypted
  # store to one OIDC subject and destroys it when a different subject signs
  # in, and the only honest test of that is a device with no prior store.
  cmd_stop

  if ! avd_exists; then
    printf 'ERROR: AVD %s does not exist.\n' "${AVD_NAME}" >&2
    exit 1
  fi

  step "Cold-booting ${AVD_NAME} with wiped user data"
  local log="${TMPDIR:-/tmp}/ostomy-emulator-${AVD_NAME}.log"
  (
    cd "${SDK}/emulator"
    ANDROID_HOME="${SDK}" ANDROID_SDK_ROOT="${SDK}" \
      "${EMULATOR}" -avd "${AVD_NAME}" \
      -port "${EMULATOR_PORT}" \
      -wipe-data \
      -no-boot-anim \
      -no-snapshot-save \
      >"${log}" 2>&1 &
  )

  step "Waiting for boot to complete"
  local waited=0
  while [[ "$("${ADB}" -s "${EMULATOR_SERIAL}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]]; do
    if (( waited >= 300 )); then
      printf 'ERROR: emulator did not finish booting. See %s\n' "${log}" >&2
      exit 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
  ok "wiped and booted"
  cmd_wire
}

# --- up -----------------------------------------------------------------------

cmd_up() {
  cmd_create
  cmd_start
  cmd_wire
  printf '\n'
  cmd_status
}

# --- Dispatch -----------------------------------------------------------------

case "${1:-}" in
  doctor) cmd_doctor ;;
  create) cmd_create ;;
  start)  cmd_start ;;
  wire)   cmd_wire ;;
  up)     cmd_up ;;
  status) cmd_status ;;
  logcat) cmd_logcat ;;
  fingerprint) cmd_fingerprint ;;
  stop)   cmd_stop ;;
  wipe)   cmd_wipe ;;
  *)
    sed -n '/^# ## Usage/,/^# `create`/p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
