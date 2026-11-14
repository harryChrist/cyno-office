#!/usr/bin/env python3
"""Pack PNG files into a .ico (PNG-compressed entries). Usage: make_ico.py out.ico a.png b.png ..."""
import struct
import sys

out, pngs = sys.argv[1], sys.argv[2:]
blobs = []
for p in pngs:
    data = open(p, "rb").read()
    w, h = struct.unpack(">II", data[16:24])
    blobs.append((w, h, data))
header = struct.pack("<HHH", 0, 1, len(blobs))
offset = 6 + 16 * len(blobs)
dirs = b""
for w, h, data in blobs:
    dirs += struct.pack("<BBBBHHII", w if w < 256 else 0, h if h < 256 else 0, 0, 0, 1, 32, len(data), offset)
    offset += len(data)
with open(out, "wb") as fh:
    fh.write(header + dirs + b"".join(d for _, _, d in blobs))
print("wrote", out, [f"{w}x{h}" for w, h, _ in blobs])
