## 2023-10-25 - [Directory Traversal Performance]
**Learning:** `Path.rglob("*")` followed by filtering hidden directories in Python is extremely slow because it traverses all hidden directories (like `.git`, `.sync_versions`) before filtering them out. Additionally, calling `Path.resolve()` on every file adds significant I/O overhead.
**Action:** Use `os.walk` with in-place directory list modification (`dirs[:] = ...`) to prune directories before traversal. This yields an order-of-magnitude speedup for large directory trees.
