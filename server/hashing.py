"""Shared FNV-1a hash for conflict detection.

Both routers/files.py and routers/ws.py need this function. Keeping it in a
standalone module breaks the former circular import (files -> ws -> files).
Matches the TypeScript client's fnv1a implementation exactly.
"""


def fnv1a(content: str) -> str:
    """FNV-1a 32-bit hash — matches the TypeScript client exactly.
    Used for conflict detection only; not a security primitive."""
    h = 0x811C9DC5
    for ch in content.encode("utf-8", errors="replace"):
        h ^= ch
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, "08x")