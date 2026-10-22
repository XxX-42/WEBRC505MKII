#!/usr/bin/env bash
set -u
repo=/workspace/shared/rc505-recovery-20261018/WEBRC505MKII
out=/workspace/shared/rc505-recovery-20261018/WEBRC505MKII/bench/results/context-recovery-68106c1-20261020T0109Z
cd "$repo" || exit 90
export TMPDIR=/workspace/shared/.tmp-rc505
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/tmp/rc505-cft154-restore/extracted/chrome-headless-shell-linux64/chrome-headless-shell
export NATIVE_BRIDGE_SIMULATION_EXECUTABLE=/workspace/shared/rc505-recovery-20261018/native-e2e-project-race/native_bridge_host_simulation
run_logged() {
  local name="$1"; shift
  set +e
  set -o pipefail
  "$@" 2> >(tee "$out/$name.stderr.log" >&2) | tee "$out/$name.stdout.log"
  local rc=$?
  wait
  printf '%s\n' "$rc" > "$out/$name.exitcode"
  set +o pipefail
  printf 'RESULT %s exit=%s\n' "$name" "$rc"
}
run_logged build npm run build
run_logged unit npm test
run_logged strict-e2e npm run test:e2e:rubberband
