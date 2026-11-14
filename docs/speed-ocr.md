# Local CarPlay speed OCR

The browser reads a small upper-right crop of the **main** Google Maps CarPlay
stream, while the separate map stream remains the round background. It locates
the sign/readout using neutral light/dark connected regions, removes the sign
border, and builds three grayscale tiles: limit, current speed, unit. Tesseract
reads a 480 × 120 image once per second, using one CPU thread. Only one request
per viewer is in flight. No images are saved or sent outside localhost.

On Raspberry Pi OS install the native engine and English data:

```sh
sudo apt-get install --no-install-recommends tesseract-ocr tesseract-ocr-eng
```

The backend uses `/usr/bin/tesseract` on Linux and
`/opt/homebrew/bin/tesseract` for local Mac tests. `ROUND_CARPLAY_OCR_BIN` can
override the executable path. No Swift, Python, ImageMagick or browser WASM is
required at runtime.

Words need 80% confidence; units, position and numeric ranges are checked.
Two matching reads are required. Missing/changed reads clear the old value;
values expire after three seconds without a read. A `--` stays unavailable.
Current speed supplies the top HUD from OCR only; GPS is not used for this check.
The map's speed box stays visible with `--` placeholders when readings are unavailable.
`/health` reports engine availability, completed reads and last OCR duration.

This initial detector targets Google Maps' light rectangular speed-limit sign
and adjacent dark speed readout, with the currently negotiated round-safe main
screen. Other sign styles/layouts need validation. Music/Phone replace Maps on
the shared main stream, so the OCR values disappear until Maps is visible in
that stream again. The reader does not switch apps or change routes.

Run parser and detector checks with `node --test scripts/test-speed-ocr.cjs`.
Real Pi CPU cost and moving-speed accuracy still require testing on the Pi.
