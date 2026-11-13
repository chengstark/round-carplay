# Current PlayPort CI source

`playport-source.tar.gz` is a source-only snapshot of the current active host
used by the ROUNDSCREENCARPLAY dashboard. `playport-source.json` records the
upstream revision and archive checksum. Its LICENSE is included in the archive.
The snapshot includes local changes rather than substituting an older upstream
release. The original host checkout remains the development source of truth.

Refresh with `node scripts/snapshot-playport.mjs /path/to/current/playport`.
The script accepts an explicit allowlist of build/source paths and excludes
accessory identity, runtime state, TLS keys, credentials and generated binaries.
