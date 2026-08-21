# Wi-Fi backup camera viewer

Low-latency native diagnostic viewer for the JieLi AC792x/CC31 Wi-Fi backup
camera used by Round CarPlay. The Electron application includes its own
integrated receiver; this SDL program remains useful for protocol and latency
testing outside the round-display UI. The camera control connection uses TCP
port 3333 and the JPEG video stream uses UDP port 2224.

The camera currently delivers 1280x720 even when 640x480 is requested. The
viewer always presents the latest complete frame to minimize reversing-camera
latency.

## Raspberry Pi setup

Connect the Pi to the camera's Wi-Fi network, then install the build and runtime
dependencies:

```bash
cd wifi_cam
./install_pi_dependencies.sh
```

Build and run:

```bash
./build_pi.sh
./run_pi.sh
```

`run_pi.sh` temporarily disables Wi-Fi power saving when supported and restores
it when the viewer exits. It writes runtime diagnostics to
`wifi_backup_viewer_pi.log`.

## Viewer options

```text
--host 192.168.1.1   Camera address
--width 640          Requested stream width
--height 480         Requested stream height
--fps 25             Requested camera frame rate
--smooth             Three-frame buffer paced at 15 fps
--buffer-frames 1    Completed-frame queue depth
--display-fps 0      Presentation rate; 0 displays immediately
--no-vsync           Disable display synchronization
```

The default one-frame/latest-frame mode has the lowest latency. `--smooth`
looks steadier but intentionally adds buffering, so it is not the recommended
backup-camera mode.

## macOS diagnostic build

With CMake, SDL2, pkg-config, and libjpeg installed:

```bash
./build_pi.sh
./build/wifi_backup_viewer
```

`run_mac_awdl_test.sh` is an optional macOS diagnostic. It temporarily disables
Apple AWDL/LLW interfaces to reduce 2.4 GHz contention and restores them on
exit; it requires `sudo`.
