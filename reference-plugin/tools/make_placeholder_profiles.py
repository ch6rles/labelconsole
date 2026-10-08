#!/usr/bin/env python3
"""Writes the placeholder MM-500 / MM-520 profiles and rig-01 targets.

These are NOT measurements. They reproduce the illustrative curves from the
UI design handoff (ref-graph.js) so the plugin has something to show and
process until real data exists. Spec Section 4: every shipped profile must
come from owned or licensed measurements; replace these files before any
release (see profiles/README.md and tools/reference_profile_tool).

Usage: python3 tools/make_placeholder_profiles.py   (from reference-plugin/)
"""

import hashlib
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROFILES = os.path.join(ROOT, "profiles", "headphones")
TARGETS = os.path.join(ROOT, "profiles", "targets", "rig-01")

# 1/24-octave points, 20 Hz .. 20 kHz inclusive.
N = 241
FREQS = [20.0 * 1000.0 ** (i / (N - 1)) for i in range(N)]


def g(f, fc, w):
    o = math.log2(f / fc) / w
    return math.exp(-0.5 * o * o)


def sig(f, fc, k):
    return 1.0 / (1.0 + math.exp(-math.log2(f / fc) * k))


# Placeholder diffuse-field response of the rig (ear-simulator resonance and
# the usual high-frequency fall-off), and the two targets built on it.
def diffuse_field(f):
    return 7.2 * g(f, 2900, 0.75) - 2.6 * sig(f, 12500, 2.2)


def studio_reference(f):  # == ref-graph.js target()
    return diffuse_field(f) + 3.2 * (1 - sig(f, 110, 2.6)) - 2.0 * sig(f, 12500, 2.2) - 1.2


def neutral(f):
    return diffuse_field(f)


def treble(f):
    return 3.2 * g(f, 7200, 0.1) - 3.6 * g(f, 9600, 0.09) + 2.8 * g(f, 12400, 0.1) - 2.2 * g(f, 15600, 0.12)


def dev_mm520(f):  # ref-graph.js DEV.main, with a shallower 4.3 kHz dip so the
    # placeholder stays inside the +6 dB boost limit like the design's main state
    return 2.6 * g(f, 42, 0.9) - 2.4 * g(f, 190, 0.6) + 1.8 * g(f, 1000, 0.45) - 4.6 * g(f, 4300, 0.3) + treble(f)


def dev_mm500(f):
    # The MM-520 carries more sub-bass than the MM-500; otherwise similar.
    return dev_mm520(f) - 2.2 * (1 - sig(f, 70, 3.0))


def spread(f):  # == ref-graph.js spread()
    return 0.3 + 2.6 * sig(f, 7000, 3) + 0.7 * g(f, 30, 0.6)


def fmt(values):
    return "[" + ", ".join(f"{v:.3f}" for v in values) + "]"


def write_profile(pid, display, revision, dev):
    mean = [studio_reference(f) + dev(f) for f in FREQS]
    spr = [spread(f) for f in FREQS]
    text = (
        "{\n"
        '  "schema_version": 2,\n'
        f'  "id": "{pid}",\n'
        f'  "display_name": "{display}",\n'
        '  "manufacturer": "Audeze",\n'
        f'  "model_revision": "{revision}",\n'
        '  "placeholder": true,\n'
        '  "measurement": {\n'
        '    "rig_id": "rig-01",\n'
        '    "ear_simulator": "IEC 60318-4",\n'
        '    "source": "placeholder",\n'
        '    "license": "placeholder: illustrative curve from the UI design handoff, not a measurement",\n'
        '    "units": 0,\n'
        '    "reseats_per_unit": 0,\n'
        '    "date": "2026-10-08"\n'
        "  },\n"
        '  "targets": ["studio_reference@1", "neutral@1"],\n'
        '  "limits": { "max_boost_db": 6, "max_cut_db": -12, "treble_average_above_hz": 9000 },\n'
        '  "curve": {\n'
        f'    "freq_hz": {fmt(FREQS)},\n'
        f'    "mean_db": {fmt(mean)},\n'
        f'    "spread_db": {fmt(spr)}\n'
        "  },\n"
        '  "generator_version": "1.0.0",\n'
        '  "sha256": ""\n'
        "}\n"
    )
    # Checksum: SHA-256 of the file with the sha256 value left empty.
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    text = text.replace('"sha256": ""', f'"sha256": "{digest}"')
    with open(os.path.join(PROFILES, pid + ".json"), "w", newline="\n") as fh:
        fh.write(text)


def write_target(tid, version, display, description, fn):
    lines = [
        "# REFERENCE target curve",
        f"# id: {tid}",
        f"# version: {version}",
        "# rig_id: rig-01",
        f"# display_name: {display}",
        f"# description: {description}",
        "# source: placeholder (illustrative curve from the UI design handoff; not a listening-panel target)",
        "freq_hz,db",
    ]
    lines += [f"{f:.3f},{fn(f):.3f}" for f in FREQS]
    with open(os.path.join(TARGETS, f"{tid}@{version}.csv"), "w", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    os.makedirs(PROFILES, exist_ok=True)
    os.makedirs(TARGETS, exist_ok=True)
    write_profile("audeze_mm520", "Audeze MM-520", "MM-520", dev_mm520)
    write_profile("audeze_mm500", "Audeze MM-500", "MM-500", dev_mm500)
    write_target("studio_reference", 1, "Studio Reference",
                 "Diffuse-field response plus a gentle bass shelf and treble tilt", studio_reference)
    write_target("neutral", 1, "Neutral", "Diffuse-field response, no tilt", neutral)
    print("wrote placeholder profiles and targets")
