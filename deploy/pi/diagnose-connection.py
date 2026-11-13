#!/usr/bin/env python3
"""Report the first failing stage of the Round CarPlay connection path."""

from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys


CONFIG = Path.home() / ".config/round-carplay-deploy/settings.json"
IAP_ACCESSORY = "00000000-deca-fade-deca-deafdecacaff"
CARPLAY_DISCOVERY = "ec884348-cd41-40a2-9727-575d50bf1fd3"


def command(args: list[str], timeout: int = 10) -> str:
    try:
        return subprocess.run(
            args, capture_output=True, text=True, timeout=timeout, check=False
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def flag(text: str, label: str) -> bool:
    return bool(re.search(rf"^\s*{re.escape(label)}:\s*yes\s*$", text, re.MULTILINE))


def main() -> int:
    try:
        settings = json.loads(CONFIG.read_text())
        phone = str(settings["phone"]).upper()
        configured_ssid = str(settings["ssid"])
    except (OSError, ValueError, KeyError):
        print("FAIL configuration: private Pi settings are missing or invalid")
        return 2

    controller = command(["bluetoothctl", "show"])
    phone_info = command(["bluetoothctl", "info", phone])
    journal = command(
        [
            "journalctl", "-u", "round-carplay-playport.service", "-b",
            "--since", "15 minutes ago", "--no-pager",
        ],
        timeout=15,
    )
    active_ssid = command(["iwgetid", "-r"]).strip()
    address = command(["hostname", "-I"]).strip()
    throttled = command(["vcgencmd", "get_throttled"]).strip()
    services = {
        name: command(["systemctl", "is-active", name]).strip()
        for name in (
            "round-carplay-playport.service",
            "round-carplay-backend.service",
            "round-carplay-browser-kiosk.service",
        )
    }

    checks = [
        ("core services", services["round-carplay-playport.service"] == "active" and services["round-carplay-backend.service"] == "active", f"playport={services['round-carplay-playport.service'] or 'unknown'} backend={services['round-carplay-backend.service'] or 'unknown'}"),
        ("bluetooth", "Powered: yes" in controller, "controller powered" if "Powered: yes" in controller else "controller unavailable or off"),
        ("head-unit advertisement", IAP_ACCESSORY in controller and CARPLAY_DISCOVERY in controller, "iAP + CarPlay UUIDs advertised" if IAP_ACCESSORY in controller and CARPLAY_DISCOVERY in controller else "required local UUIDs missing"),
        ("phone bond", flag(phone_info, "Paired") and flag(phone_info, "Bonded") and flag(phone_info, "Trusted"), f"paired={flag(phone_info, 'Paired')} bonded={flag(phone_info, 'Bonded')} trusted={flag(phone_info, 'Trusted')}"),
        ("Wi-Fi", bool(active_ssid and address), f"ssid={active_ssid or 'none'} address={address or 'none'} configured={configured_ssid}"),
        ("iAP transport", "RFCOMM channel open" in journal, "RFCOMM opened" if "RFCOMM channel open" in journal else "waiting for the iPhone's CarPlay connection"),
        ("Wi-Fi handoff", "wireless bootstrap accepted by the iPhone" in journal, "iPhone accepted bootstrap" if "wireless bootstrap accepted by the iPhone" in journal else "not completed"),
        ("CarPlay", "CarPlay session active" in journal, "session active" if "CarPlay session active" in journal else "no active session in the last 15 minutes"),
        ("display service", services["round-carplay-browser-kiosk.service"] == "active", f"kiosk={services['round-carplay-browser-kiosk.service'] or 'unknown'}"),
    ]
    first_failure = next((name for name, ok, _detail in checks if not ok), None)
    for name, ok, detail in checks:
        print(f"{'PASS' if ok else 'WAIT' if name in ('iAP transport', 'Wi-Fi handoff', 'CarPlay') else 'FAIL'} {name}: {detail}")
    if throttled:
        print(f"INFO power: {throttled}")
    print(f"RESULT {'ready' if first_failure is None else 'stopped at ' + first_failure}")
    return 0 if first_failure is None else 1


if __name__ == "__main__":
    sys.exit(main())
