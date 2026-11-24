"""Reads two calibrated root-window columns. All timestamps are CLOCK_MONOTONIC us."""
import sys
import time
from Xlib import X, display


d = display.Display()
root = d.screen().root
assert root.get_geometry().depth == 24 and sys.byteorder == "little"
clock = lambda: time.monotonic_ns() // 1000
if sys.argv[1] == "locate":
    w, h = root.get_geometry().width, root.get_geometry().height
    data = root.get_image(0, 0, w, h, X.ZPixmap, 0xFFFFFF).data
    for color in (0xD123F7, 0xE84712):
        offset = data.index(color.to_bytes(4, "little"))
        assert offset % 4 == 0
        print((offset // 4) % w, (offset // 4) // w)
    sys.exit(0)

x1, x2, y, h, count = map(int, sys.argv[1:])


def pixels(x):
    return memoryview(root.get_image(x, y, 1, h, X.ZPixmap, 0xFFFFFF).data).cast("I")


print("ready", clock(), flush=True)
start = time.monotonic()
for n in range(count):
    time.sleep(max(0, start + n * 0.0125 - time.monotonic()))
    a = clock()
    left = pixels(x1)
    right = pixels(x2)
    b = clock()
    l = r = common = longest = ol = oright = 0
    first, last = h, -1
    for i, (p, q) in enumerate(zip(left, right)):
        lp, rq = p & 0xFFFFFF, q & 0xFFFFFF
        l += lp == 0xFF00FF
        r += rq == 0xFF7900
        common = common + 1 if lp == 0xFF00FF and rq == 0xFF7900 else 0
        longest = max(longest, common)
        ol += lp not in (0xFF00FF, 0x00FF00, 0x00FFFF)
        oright += rq not in (0xFF7900, 0x00FF00, 0x00FFFF)
        if lp not in (0x00FF00, 0x00FFFF) or rq not in (0x00FF00, 0x00FFFF):
            first, last = min(first, i), i
    print(a, b, l, r, longest, ol, oright, first, last)
