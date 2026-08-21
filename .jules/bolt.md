## 2023-10-27 - [Pathlib rglob Performance in Sync]
**Learning:** `Path.rglob("*")` is a significant performance bottleneck when scanning large file trees because it unconditionally scans all subdirectories (including hidden ones like `.git` or large virtual environments) before yielding files to be filtered in Python.
**Action:** Use `os.walk` with in-place directory pruning (e.g., `dirs[:] = [d for d in dirs if not d.startswith('.')]`) instead of `rglob` when traversing directories where large branches can be ignored. This improves traversal speed significantly (O(N) reduction).
