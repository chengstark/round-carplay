#!/usr/bin/env python3
"""Keep pointer capability on a touch-only Cage seat so client cursor rules apply."""
import fcntl
import os
import struct
import time
from pathlib import Path


def main():
    fd = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
    created = False
    try:
        for kind in (1, 2):  # EV_KEY, EV_REL
            fcntl.ioctl(fd, 0x40045564, kind)  # UI_SET_EVBIT
        fcntl.ioctl(fd, 0x40045565, 272)  # BTN_LEFT classifies the device as a mouse; never emitted.
        for axis in (0, 1):
            fcntl.ioctl(fd, 0x40045566, axis)  # REL_X, REL_Y
        device = struct.pack('80sHHHHI', b'Round CarPlay cursor seat', 3, 0x1234, 0x5678, 1, 0)
        os.write(fd, device + bytes(1024))  # uinput_user_dev: four 64-element int arrays.
        fcntl.ioctl(fd, 0x5501)  # UI_DEV_CREATE
        created = True
        marker = Path('/run/round-carplay-cursor/refresh')
        marker.write_text('')
        marker.chmod(0o666)  # A local client may request motion only; content is never executed.
        previous = marker.stat().st_mtime_ns
        time.sleep(1)
        while True:
            current = marker.stat().st_mtime_ns
            if current != previous:
                previous = current
                for kind, code, value in ((2, 0, 1), (0, 0, 0), (2, 0, -1), (0, 0, 0)):
                    os.write(fd, struct.pack('llHHi', 0, 0, kind, code, value))
            time.sleep(0.1)
    finally:
        if created:
            fcntl.ioctl(fd, 0x5502)  # UI_DEV_DESTROY
        os.close(fd)


if __name__ == '__main__':
    main()
