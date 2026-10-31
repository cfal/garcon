#!/usr/bin/env python3
"""Writes exact pixel diffs and a machine-readable summary for paired screenshots."""

import json
import sys
from pathlib import Path
from PIL import Image, ImageChops

directory = Path(sys.argv[1])
results = []
for before in sorted(directory.glob("*-before.png")):
    after = before.with_name(before.name.replace("-before.png", "-after.png"))
    if not after.exists():
        raise FileNotFoundError(after)
    a, b = (Image.open(path).convert("RGB") for path in (before, after))
    dimensions = {"before": list(a.size), "after": list(b.size)}
    if a.size != b.size:
        size = (max(a.width, b.width), max(a.height, b.height))
        padded = []
        for screenshot in (a, b):
            canvas = Image.new("RGB", size, "white")
            canvas.paste(screenshot, (0, 0))
            padded.append(canvas)
        a, b = padded
    diff = ImageChops.difference(a, b)
    changed = sum(pixel != (0, 0, 0) for pixel in diff.get_flattened_data())
    name = before.name.removesuffix("-before.png")
    diff.save(directory / f"{name}-diff.png")
    result = {"sample": name, "dimensions": dimensions, "pixels": a.width * a.height, "changedPixels": changed, "boundingBox": diff.getbbox(), "maxChannelDifference": max(high for low, high in diff.getextrema())}
    control = directory / f"{name}-control.png"
    if control.exists():
        reference = ImageChops.difference(a, Image.open(control).convert("RGB"))
        result["originalControl"] = {"changedPixels": sum(pixel != (0, 0, 0) for pixel in reference.get_flattened_data()), "boundingBox": reference.getbbox(), "maxChannelDifference": max(high for low, high in reference.getextrema())}
        reference.save(directory / f"{name}-control-diff.png")
    results.append(result)
    print(name, changed, "changed pixels")
(directory / "pixel-diffs.json").write_text(json.dumps(results, indent=2) + "\n")
if any(result["changedPixels"] or result["dimensions"]["before"] != result["dimensions"]["after"] for result in results):
    sys.exit(1)
