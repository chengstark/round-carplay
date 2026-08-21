#!/usr/bin/env bash
set -u
set -o pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
viewer="$script_dir/build/wifi_backup_viewer"
log_file="$script_dir/wifi_backup_viewer_awdl_off.log"

if [[ ! -x "$viewer" ]]; then
  echo "Viewer not found: $viewer" >&2
  exit 1
fi

awdl_was_up=0
llw_was_up=0
if ifconfig awdl0 2>/dev/null | head -n 1 | grep -q '<[^>]*UP'; then
  awdl_was_up=1
fi
if ifconfig llw0 2>/dev/null | head -n 1 | grep -q '<[^>]*UP'; then
  llw_was_up=1
fi

restore_interfaces() {
  if (( restored )); then
    return
  fi
  restored=1
  echo "Restoring Apple wireless-direct interfaces..."
  if (( awdl_was_up )); then
    sudo ifconfig awdl0 up
  fi
  if (( llw_was_up )); then
    sudo ifconfig llw0 up
  fi
}
restored=0
trap restore_interfaces EXIT
trap 'exit 130' HUP INT TERM

echo "Temporarily disabling AWDL/LLW (AirDrop/AirPlay) for this test."
echo "They will be restored automatically when the viewer exits."
sudo -v
sudo ifconfig awdl0 down
sudo ifconfig llw0 down

"$viewer" "$@" 2>&1 | tee "$log_file"
