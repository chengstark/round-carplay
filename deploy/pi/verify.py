#!/usr/bin/env python3
"""Validate a transferred bundle before executing its installer."""
import hashlib
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'manifest.json').read_text())
if manifest['format'] != 1 or manifest['runtime'] != 'playport-browser':
    raise SystemExit('Unsupported bundle format/runtime')
for item in manifest['files']:
    path = (root / item['path']).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise SystemExit('Missing or invalid bundle member: ' + item['path'])
    if hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
        raise SystemExit('Checksum mismatch: ' + item['path'])
print(f"Verified {len(manifest['files'])} files: {manifest['runtime']}, built {manifest['builtAt']}")
