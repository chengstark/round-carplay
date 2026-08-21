#!/usr/bin/env bash
set -u
set -o pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
viewer="$script_dir/build/wifi_backup_viewer"
log_file="$script_dir/wifi_backup_viewer_pi.log"
camera_ip="192.168.1.1"

if [[ ! -x "$viewer" ]]; then
  echo "Viewer not found: $viewer" >&2
  echo "Build it first with: $script_dir/build_pi.sh" >&2
  exit 1
fi

wifi_interface=""
if command -v ip >/dev/null 2>&1; then
  wifi_interface="$(ip -o route get "$camera_ip" 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i == "dev") {print $(i+1); exit}}')"
fi

power_save_was_on=0
restore_power_save() {
  if (( power_save_was_on )) && [[ -n "$wifi_interface" ]]; then
    echo "Restoring Wi-Fi power saving on $wifi_interface..."
    sudo iw dev "$wifi_interface" set power_save on
  fi
}
trap restore_power_save EXIT
trap 'exit 130' HUP INT TERM

if [[ -n "$wifi_interface" ]] && command -v iw >/dev/null 2>&1; then
  if iw dev "$wifi_interface" get power_save 2>/dev/null | grep -q 'on'; then
    power_save_was_on=1
    echo "Disabling Wi-Fi power saving on $wifi_interface for low-latency video..."
    sudo iw dev "$wifi_interface" set power_save off
  else
    echo "Wi-Fi power saving is already off on $wifi_interface."
  fi
else
  echo "Could not identify/tune the Wi-Fi interface; continuing without power-save tuning."
fi

"$viewer" "$@" 2>&1 | tee "$log_file"
