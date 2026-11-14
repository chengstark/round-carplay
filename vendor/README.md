# Current PlayPort CI source

`playport-source.tar.gz` is a source-only snapshot of the current active host
used by the ROUNDSCREENCARPLAY dashboard. `playport-source.json` records the
upstream revision and archive checksum. Its LICENSE is included in the archive.
The snapshot includes local changes rather than substituting an older upstream
release. The original host checkout remains the development source of truth.

Refresh with `node scripts/snapshot-playport.mjs /path/to/current/playport`.
The script accepts an explicit allowlist of build/source paths and excludes
accessory identity, runtime state, TLS keys, credentials and generated binaries.

`playport-linux-pr4/` contains the unmodified Rust Bluetooth bridge from
[PlayPort PR #4](https://github.com/youcci/playport/pull/4), pinned at
`997df2edfa3caf48198231db2ea4c16e21c54876`. Its provenance and GPL license are
included. Both Pi package paths overlay the tested native iAP modules from
`deploy/pi/experiments/native-inbound/` onto this pinned bridge, replacing the
older C helper inside the host snapshot. The JVM recovery patch under
`deploy/pi/playport-patches/` keeps an initial bootstrap alive and retries after
it exits or a completed session ends. The v3 dashboard and protocol additions
remain in the current host snapshot.
