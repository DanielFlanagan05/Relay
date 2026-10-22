"""Render Relay's code-native mark to an antialiased PNG with no imaging dependencies."""
from pathlib import Path
import math
import struct
import zlib

root = Path(__file__).resolve().parents[1] / 'build'
root.mkdir(exist_ok=True)
size, scale = 256, 3


def rounded(x, y, cx, cy, width, height, radius):
    dx = abs(x-cx)-width/2+radius
    dy = abs(y-cy)-height/2+radius
    return max(dx, 0)**2 + max(dy, 0)**2 <= radius**2 and max(dx, dy) <= radius


pixels = bytearray()
angle = math.radians(-25)
marks = [(-36, 0, 19, 84, (199, 180, 255)), (0, 0, 19, 120, (173, 145, 238)), (36, 0, 19, 57, (226, 215, 255))]
for py in range(size):
    pixels.append(0)
    for px in range(size):
        channels = [0, 0, 0, 0]
        for sy in range(scale):
            for sx in range(scale):
                x = px + (sx+.5)/scale
                y = py + (sy+.5)/scale
                rgba = [0, 0, 0, 0]
                if rounded(x, y, 128, 128, 244, 244, 58):
                    rgba = [30, 26, 39, 255]
                    ux = math.cos(angle)*(x-128)+math.sin(angle)*(y-128)
                    uy = -math.sin(angle)*(x-128)+math.cos(angle)*(y-128)
                    for cx, cy, width, height, color in marks:
                        if rounded(ux, uy, cx, cy, width, height, width/2):
                            rgba = [*color, 255]
                for i, channel in enumerate(rgba):
                    channels[i] += channel
        pixels.extend(round(channel/(scale*scale)) for channel in channels)


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind+data) & 0xffffffff)


png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(pixels, 9)) + chunk(b'IEND', b'')
(root / 'icon.png').write_bytes(png)
