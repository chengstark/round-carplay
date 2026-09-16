#!/usr/bin/env node

// Minimal valid Xcursor file containing one fully transparent 1x1 ARGB image.
// Writing the binary to stdout lets the root installer place it without
// requiring xcursorgen, ImageMagick, or another package on the Pi.
const IMAGE_TYPE = 0xfffd0002
const SUBTYPE = 1
const TOC_POSITION = 28

const header = Buffer.alloc(16)
header.write('Xcur', 0, 'ascii')
header.writeUInt32LE(16, 4)
header.writeUInt32LE(0x00010000, 8)
header.writeUInt32LE(1, 12)

const toc = Buffer.alloc(12)
toc.writeUInt32LE(IMAGE_TYPE, 0)
toc.writeUInt32LE(SUBTYPE, 4)
toc.writeUInt32LE(TOC_POSITION, 8)

const image = Buffer.alloc(40)
image.writeUInt32LE(36, 0)
image.writeUInt32LE(IMAGE_TYPE, 4)
image.writeUInt32LE(SUBTYPE, 8)
image.writeUInt32LE(1, 12)
image.writeUInt32LE(1, 16)
image.writeUInt32LE(1, 20)
image.writeUInt32LE(0, 24)
image.writeUInt32LE(0, 28)
image.writeUInt32LE(0, 32)
image.writeUInt32LE(0x00000000, 36)

process.stdout.write(Buffer.concat([header, toc, image]))
