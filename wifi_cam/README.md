# Wi-Fi backup camera viewer

Low-latency native diagnostic viewer for the XIAO ESP32-S3 Wi-Fi backup camera
used by Round CarPlay. The Electron application includes its own integrated
receiver; this SDL program remains useful for stream and latency testing outside
the round-display UI. It configures the camera through HTTP port 80 and receives
multipart MJPEG from `http://192.168.4.1:81/stream`.

The default resolution is 1280×720, matching the previous JieLi camera. The
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
--host 192.168.4.1   Camera address
--frame-size 11      11=1280×720, 10=1024×768, 9=800×600,
                     8=640×480, 5=320×240
--quality 20         JPEG compression from 4–63; higher is smaller/faster
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
