#!/usr/bin/env python3
"""BlueZ RFCOMM bridge for first-time and returning wireless CarPlay.

An iPhone initiates the first iAP2 connection to the accessory-side service.
After that session, the accessory may reconnect to the iPhone-side service.
The original Linux helper implemented only the latter, leaving a newly paired
phone bonded as generic Bluetooth audio but unable to start CarPlay.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import select
import signal
import socket
import subprocess
import sys
import threading
import time

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib


BLUEZ = "org.bluez"
PROFILE_MANAGER = "org.bluez.ProfileManager1"
PROFILE_INTERFACE = "org.bluez.Profile1"
AGENT_MANAGER = "org.bluez.AgentManager1"
AGENT_INTERFACE = "org.bluez.Agent1"
OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager"
PROPERTIES = "org.freedesktop.DBus.Properties"
IAP_ACCESSORY_UUID = "00000000-deca-fade-deca-deafdecacaff"
IAP_IPHONE_UUID = "00000000-deca-fade-deca-deafdecacafe"
CARPLAY_DISCOVERY_UUID = "ec884348-cd41-40a2-9727-575d50bf1fd3"
IAP_PATH = "/org/round_carplay/iap_accessory"
CARPLAY_PATH = "/org/round_carplay/carplay_discovery"
AGENT_PATH = "/org/round_carplay/pairing_agent"
IAP_CHANNEL = 23
CARPLAY_CHANNEL = 24
ADDRESS_PATTERN = re.compile(r"^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")
CARPLAY_READY = Path.home() / ".local/share/round-carplay-pi/state/carplay-bluetooth-ready"


def log(message: str) -> None:
    print(f"bt-bridge: {message}", file=sys.stderr, flush=True)


def run(command: list[str], timeout: float = 10) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)


def local_address() -> str:
    result = run(["bluetoothctl", "show"])
    match = re.search(r"^Controller\s+([0-9A-Fa-f:]{17})\b", result.stdout, re.MULTILINE)
    if not match:
        raise RuntimeError("local Bluetooth address unavailable")
    return match.group(1).upper()


def list_paired() -> None:
    result = run(["bluetoothctl", "devices", "Paired"])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "paired-device query failed")
    for line in result.stdout.splitlines():
        print(line.removeprefix("Device "))


def service_record(uuid: str, channel: int, name: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8" ?>
<record>
  <attribute id="0x0001"><sequence><uuid value="{uuid}" /></sequence></attribute>
  <attribute id="0x0004"><sequence>
    <sequence><uuid value="0x0100" /></sequence>
    <sequence><uuid value="0x0003" /><uint8 value="0x{channel:02x}" /></sequence>
  </sequence></attribute>
  <attribute id="0x0005"><sequence><uuid value="0x1002" /></sequence></attribute>
  <attribute id="0x0006"><sequence>
    <uint16 value="0x656e" /><uint16 value="0x006a" /><uint16 value="0x0100" />
  </sequence></attribute>
  <attribute id="0x0009"><sequence><sequence>
    <uuid value="0x1101" /><uint16 value="0x0100" />
  </sequence></sequence></attribute>
  <attribute id="0x0100"><text value="{name}" /></attribute>
</record>"""


class Rejected(dbus.DBusException):
    _dbus_error_name = "org.bluez.Error.Rejected"


class PairingAgent(dbus.service.Object):
    def __init__(self, bus: dbus.SystemBus, allowed_address: str) -> None:
        super().__init__(bus, AGENT_PATH)
        self.bus = bus
        self.allowed_address = allowed_address.upper()
        self.pending_checks: dict[str, int] = {}

    def _authorize(self, device_path: dbus.ObjectPath) -> None:
        properties = dbus.Interface(self.bus.get_object(BLUEZ, device_path), PROPERTIES)
        address = str(properties.Get("org.bluez.Device1", "Address")).upper()
        if address != self.allowed_address:
            log(f"rejected pairing request from {address}")
            raise Rejected("This device is not the configured CarPlay phone")

    def _adapter_path(self) -> str:
        objects = dbus.Interface(self.bus.get_object(BLUEZ, "/"), OBJECT_MANAGER).GetManagedObjects()
        for path, interfaces in objects.items():
            if "org.bluez.Adapter1" in interfaces:
                return str(path)
        raise RuntimeError("no Bluetooth adapter is available")

    def _configured_device(self) -> tuple[str, dict] | None:
        objects = dbus.Interface(self.bus.get_object(BLUEZ, "/"), OBJECT_MANAGER).GetManagedObjects()
        for path, interfaces in objects.items():
            device = interfaces.get("org.bluez.Device1")
            if device and str(device.get("Address", "")).upper() == self.allowed_address:
                return str(path), device
        return None

    def configure_setup_window(self) -> None:
        adapter = dbus.Interface(self.bus.get_object(BLUEZ, self._adapter_path()), PROPERTIES)
        adapter.Set("org.bluez.Adapter1", "Alias", dbus.String("PlayPort", variant_level=1))
        configured = self._configured_device()
        paired = bool(configured and configured[1].get("Paired", False))
        adapter.Set("org.bluez.Adapter1", "Pairable", dbus.Boolean(not paired, variant_level=1))
        adapter.Set("org.bluez.Adapter1", "DiscoverableTimeout", dbus.UInt32(300, variant_level=1))
        ready = CARPLAY_READY.exists()
        adapter.Set("org.bluez.Adapter1", "Discoverable", dbus.Boolean(not ready, variant_level=1))
        if paired and ready:
            log("configured iPhone is already bonded; automatic reconnect enabled")
        elif paired:
            log("configured iPhone is bonded; waiting for first CarPlay approval")
        else:
            log("pairing window open for configured iPhone")

    def mark_carplay_ready(self) -> None:
        CARPLAY_READY.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        CARPLAY_READY.write_text("iAP RFCOMM established\n")
        CARPLAY_READY.chmod(0o600)
        adapter = dbus.Interface(self.bus.get_object(BLUEZ, self._adapter_path()), PROPERTIES)
        adapter.Set("org.bluez.Adapter1", "Pairable", dbus.Boolean(False, variant_level=1))
        adapter.Set("org.bluez.Adapter1", "Discoverable", dbus.Boolean(False, variant_level=1))

    def _finish_bond(self, device_path: str) -> bool:
        checks = self.pending_checks.get(device_path, 0) + 1
        self.pending_checks[device_path] = checks
        try:
            device = dbus.Interface(self.bus.get_object(BLUEZ, device_path), PROPERTIES)
            if bool(device.Get("org.bluez.Device1", "Paired")):
                device.Set("org.bluez.Device1", "Trusted", dbus.Boolean(True, variant_level=1))
                adapter = dbus.Interface(self.bus.get_object(BLUEZ, self._adapter_path()), PROPERTIES)
                adapter.Set("org.bluez.Adapter1", "Pairable", dbus.Boolean(False, variant_level=1))
                adapter.Set("org.bluez.Adapter1", "Discoverable", dbus.Boolean(False, variant_level=1))
                self.pending_checks.pop(device_path, None)
                log(f"bonded and trusted configured iPhone {self.allowed_address}")
                return False
        except dbus.DBusException:
            pass
        if checks >= 120:
            self.pending_checks.pop(device_path, None)
            log("pairing confirmation timed out before the bond completed")
            return False
        return True

    def _schedule_finish(self, device: dbus.ObjectPath) -> None:
        path = str(device)
        if path not in self.pending_checks:
            self.pending_checks[path] = 0
            GLib.timeout_add(250, self._finish_bond, path)

    @dbus.service.method(AGENT_INTERFACE, in_signature="", out_signature="")
    def Release(self) -> None:
        log("pairing agent released")

    @dbus.service.method(AGENT_INTERFACE, in_signature="o", out_signature="s")
    def RequestPinCode(self, device: dbus.ObjectPath) -> str:
        self._authorize(device)
        self._schedule_finish(device)
        return "0000"

    @dbus.service.method(AGENT_INTERFACE, in_signature="ouq", out_signature="")
    def DisplayPinCode(self, device: dbus.ObjectPath, _pincode: str, _entered: int) -> None:
        self._authorize(device)

    @dbus.service.method(AGENT_INTERFACE, in_signature="o", out_signature="u")
    def RequestPasskey(self, device: dbus.ObjectPath) -> dbus.UInt32:
        self._authorize(device)
        self._schedule_finish(device)
        return dbus.UInt32(0)

    @dbus.service.method(AGENT_INTERFACE, in_signature="ouq", out_signature="")
    def DisplayPasskey(self, device: dbus.ObjectPath, _passkey: int, _entered: int) -> None:
        self._authorize(device)

    @dbus.service.method(AGENT_INTERFACE, in_signature="ou", out_signature="")
    def RequestConfirmation(self, device: dbus.ObjectPath, passkey: int) -> None:
        self._authorize(device)
        self._schedule_finish(device)
        log(f"automatically confirmed passkey {passkey:06d}")

    @dbus.service.method(AGENT_INTERFACE, in_signature="o", out_signature="")
    def RequestAuthorization(self, device: dbus.ObjectPath) -> None:
        self._authorize(device)
        self._schedule_finish(device)

    @dbus.service.method(AGENT_INTERFACE, in_signature="os", out_signature="")
    def AuthorizeService(self, device: dbus.ObjectPath, _uuid: str) -> None:
        self._authorize(device)
        self._schedule_finish(device)

    @dbus.service.method(AGENT_INTERFACE, in_signature="", out_signature="")
    def Cancel(self) -> None:
        log("pairing request cancelled")


class Profile(dbus.service.Object):
    def __init__(
        self,
        bus: dbus.SystemBus,
        path: str,
        allowed_address: str,
        connection_ready: threading.Event,
        accept_connection: bool,
    ) -> None:
        super().__init__(bus, path)
        self.bus = bus
        self.allowed_address = allowed_address.upper()
        self.connection_ready = connection_ready
        self.accept_connection = accept_connection
        self.connection_fd: int | None = None

    def _device_address(self, device_path: dbus.ObjectPath) -> str:
        properties = dbus.Interface(self.bus.get_object(BLUEZ, device_path), PROPERTIES)
        return str(properties.Get("org.bluez.Device1", "Address")).upper()

    @dbus.service.method(PROFILE_INTERFACE, in_signature="", out_signature="")
    def Release(self) -> None:
        log("profile released")

    @dbus.service.method(PROFILE_INTERFACE, in_signature="oha{sv}", out_signature="")
    def NewConnection(
        self, device: dbus.ObjectPath, descriptor: dbus.types.UnixFd, _properties: dict
    ) -> None:
        fd = descriptor.take()
        address = self._device_address(device)
        if address != self.allowed_address or not self.accept_connection:
            os.close(fd)
            log(f"rejected RFCOMM connection from {address}")
            return
        if self.connection_fd is not None:
            os.close(fd)
            return
        self.connection_fd = fd
        self.connection_ready.set()
        log(f"accepted accessory-side RFCOMM connection from {address}")

    @dbus.service.method(PROFILE_INTERFACE, in_signature="o", out_signature="")
    def RequestDisconnection(self, _device: dbus.ObjectPath) -> None:
        if self.connection_fd is not None:
            os.close(self.connection_fd)
            self.connection_fd = None

    @dbus.service.method(PROFILE_INTERFACE, in_signature="", out_signature="")
    def Cancel(self) -> None:
        pass


class ProfileServer:
    def __init__(self, address: str) -> None:
        dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
        self.bus = dbus.SystemBus()
        self.manager = dbus.Interface(self.bus.get_object(BLUEZ, "/org/bluez"), PROFILE_MANAGER)
        self.agent_manager = dbus.Interface(self.bus.get_object(BLUEZ, "/org/bluez"), AGENT_MANAGER)
        self.connection_ready = threading.Event()
        self.agent = PairingAgent(self.bus, address)
        self.iap = Profile(self.bus, IAP_PATH, address, self.connection_ready, True)
        self.carplay = Profile(self.bus, CARPLAY_PATH, address, self.connection_ready, False)
        self.loop = GLib.MainLoop()
        self.thread = threading.Thread(target=self.loop.run, name="bluez-profile", daemon=True)

    def start(self) -> None:
        self.agent_manager.RegisterAgent(AGENT_PATH, "DisplayYesNo")
        self.agent_manager.RequestDefaultAgent(AGENT_PATH)
        self.manager.RegisterProfile(
            IAP_PATH,
            IAP_ACCESSORY_UUID,
            {
                "Name": "Wireless iAP",
                "Role": "server",
                "Channel": dbus.UInt16(IAP_CHANNEL),
                "RequireAuthentication": dbus.Boolean(True),
                "RequireAuthorization": dbus.Boolean(False),
                "ServiceRecord": service_record(IAP_ACCESSORY_UUID, IAP_CHANNEL, "Wireless iAP"),
            },
        )
        self.manager.RegisterProfile(
            CARPLAY_PATH,
            CARPLAY_DISCOVERY_UUID,
            {
                "Name": "Wireless CarPlay",
                "Role": "server",
                "Channel": dbus.UInt16(CARPLAY_CHANNEL),
                "RequireAuthentication": dbus.Boolean(True),
                "RequireAuthorization": dbus.Boolean(False),
                "ServiceRecord": service_record(
                    CARPLAY_DISCOVERY_UUID, CARPLAY_CHANNEL, "Wireless CarPlay"
                ),
            },
        )
        self.thread.start()
        self.agent.configure_setup_window()
        log("accessory-side iAP and CarPlay discovery profiles registered")

    def take_connection(self) -> int | None:
        if not self.connection_ready.is_set():
            return None
        fd = self.iap.connection_fd
        self.iap.connection_fd = None
        return fd

    def close(self) -> None:
        for path in (CARPLAY_PATH, IAP_PATH):
            try:
                self.manager.UnregisterProfile(path)
            except dbus.DBusException:
                pass
        try:
            self.agent_manager.UnregisterAgent(AGENT_PATH)
        except dbus.DBusException:
            pass
        self.loop.quit()
        self.thread.join(timeout=2)


def remote_channel(address: str) -> int | None:
    try:
        result = run(["sdptool", "search", "--bdaddr", address, IAP_IPHONE_UUID], timeout=8)
    except subprocess.TimeoutExpired:
        return None
    match = re.search(r"\bChannel:\s*(\d+)\b", result.stdout)
    return int(match.group(1)) if match else None


def connect_remote(address: str) -> socket.socket | None:
    channel = remote_channel(address)
    if not channel:
        return None
    candidate = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
    candidate.settimeout(8)
    try:
        candidate.connect((address, channel))
    except OSError as error:
        log(f"outbound RFCOMM channel {channel} unavailable: {error}")
        candidate.close()
        return None
    candidate.settimeout(None)
    log(f"opened iPhone-side RFCOMM channel {channel} to {address}")
    return candidate


def write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        count = os.write(fd, view)
        view = view[count:]


def bridge(address: str) -> None:
    if not ADDRESS_PATTERN.fullmatch(address):
        raise RuntimeError("invalid Bluetooth address")
    address = address.upper()
    server = ProfileServer(address)
    server.start()
    pending = bytearray()
    connection_fd: int | None = None
    next_outbound_attempt = time.monotonic() + 2
    try:
        while connection_fd is None:
            connection_fd = server.take_connection()
            if connection_fd is not None:
                break
            now = time.monotonic()
            if now >= next_outbound_attempt:
                outbound = connect_remote(address)
                if outbound is not None:
                    connection_fd = outbound.detach()
                    break
                next_outbound_attempt = time.monotonic() + 12
            readable, _, _ = select.select([sys.stdin.buffer], [], [], 0.5)
            if readable:
                chunk = os.read(sys.stdin.fileno(), 8192)
                if not chunk:
                    return
                pending.extend(chunk)

        os.set_blocking(connection_fd, True)
        server.agent.mark_carplay_ready()
        if pending:
            write_all(connection_fd, pending)
        log("RFCOMM channel open")
        poller = select.poll()
        poller.register(sys.stdin.fileno(), select.POLLIN | select.POLLHUP | select.POLLERR)
        poller.register(connection_fd, select.POLLIN | select.POLLHUP | select.POLLERR)
        while True:
            for fd, events in poller.poll():
                if events & (select.POLLHUP | select.POLLERR):
                    return
                data = os.read(fd, 8192)
                if not data:
                    return
                write_all(connection_fd if fd == sys.stdin.fileno() else sys.stdout.fileno(), data)
    finally:
        if connection_fd is not None:
            try:
                os.close(connection_fd)
            except OSError:
                pass
        server.close()
        log("RFCOMM channel closed")


def main() -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--print-address", action="store_true")
    group.add_argument("--list", action="store_true")
    group.add_argument("--address")
    args = parser.parse_args()
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    try:
        if args.print_address:
            print(local_address())
        elif args.list:
            list_paired()
        else:
            bridge(args.address)
        return 0
    except (OSError, RuntimeError, dbus.DBusException) as error:
        log(str(error))
        return 1


if __name__ == "__main__":
    sys.exit(main())
