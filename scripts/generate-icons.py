#!/usr/bin/env python3
"""Generate the extension icons (pure stdlib — no Pillow required).

Draws a person silhouette with a "minus" badge on an Instagram-style
gradient rounded square, supersampled for antialiasing.

Usage: python3 scripts/generate-icons.py [output-dir]
"""
import os
import struct
import sys
import zlib

OUT = sys.argv[1] if len(sys.argv) > 1 else 'icons'
SIZES = [16, 32, 48, 128]
SS = 8  # supersampling factor per axis

PURPLE = (131, 58, 180)
PINK = (225, 48, 108)
ORANGE = (247, 119, 55)
WHITE = (255, 255, 255)

BADGE = (0.74, 0.74)
R_BADGE = 0.17
R_GAP = 0.225


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def gradient(t):
    if t < 0.5:
        return lerp(PURPLE, PINK, t * 2)
    return lerp(PINK, ORANGE, (t - 0.5) * 2)


def in_rounded_square(x, y, r):
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_person(x, y):
    if (x - 0.46) ** 2 + (y - 0.40) ** 2 <= 0.15 ** 2:  # head
        return True
    if 0.58 <= y <= 0.88:  # shoulders
        return ((x - 0.46) / 0.25) ** 2 + ((y - 0.88) / 0.30) ** 2 <= 1
    return False


def sample(x, y):
    """Color of one sample point in [0,1]^2, or None if transparent."""
    if not in_rounded_square(x, y, 0.22):
        return None
    bg = gradient((x + y) / 2)
    d2 = (x - BADGE[0]) ** 2 + (y - BADGE[1]) ** 2
    if d2 <= R_BADGE ** 2:
        if abs(y - BADGE[1]) <= 0.032 and abs(x - BADGE[0]) <= 0.085:
            return PINK  # the minus bar
        return WHITE  # badge disc
    if d2 <= R_GAP ** 2:
        return bg  # gap ring separating badge from silhouette
    if in_person(x, y):
        return WHITE
    return bg


def render(size):
    rows = []
    total = SS * SS
    for py in range(size):
        row = []
        for px in range(size):
            rs = gs = bs = 0.0
            covered = 0
            for sy in range(SS):
                for sx in range(SS):
                    c = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)
                    if c is None:
                        continue
                    covered += 1
                    rs += c[0]
                    gs += c[1]
                    bs += c[2]
            if covered == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((
                    round(rs / covered),
                    round(gs / covered),
                    round(bs / covered),
                    round(255 * covered / total),
                ))
        rows.append(row)
    return rows


def write_png(path, size, rows):
    raw = b''.join(b'\x00' + b''.join(struct.pack('4B', *px) for px in row) for row in rows)

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', zlib.compress(raw, 9)))
        f.write(chunk(b'IEND', b''))


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT, f'icon{size}.png')
        write_png(path, size, render(size))
        print(f'wrote {path}')


if __name__ == '__main__':
    main()
