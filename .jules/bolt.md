## 2024-08-20 - Unnecessary String Splitting in Hot Paths
**Learning:** Found a performance bottleneck in the Obsidian plugin's `shouldSyncPath` function, which was splitting strings and filtering `this.settings.allowedExtensions` and `this.settings.selectiveSyncPaths` on every single file check (thousands of times). Also found `isBinaryFile` recreating a text extensions array on every call.
**Action:** Next time, look for string manipulation or array allocation in functions that are called repeatedly (like loops or callbacks), and cache them either at the class level or via memoization variables.

## 2023-10-25 - [Directory Traversal Performance]
**Learning:** `Path.rglob("*")` followed by filtering hidden directories in Python is extremely slow because it traverses all hidden directories (like `.git`, `.sync_versions`) before filtering them out. Additionally, calling `Path.resolve()` on every file adds significant I/O overhead.
**Action:** Use `os.walk` with in-place directory list modification (`dirs[:] = ...`) to prune directories before traversal. This yields an order-of-magnitude speedup for large directory trees.
## 2024-10-24 - Stop using Path.rglob() for backend traversals
**Learning:** `Path.rglob()` is slow in Python, and worse, it traverses the entire directory tree (including all hidden directories) *before* filtering its output. This causes severe bottlenecks on startup and syncing when directories like `.git` or `.sync_versions` become large.
**Action:** Use `os.walk()` instead and prune directories in-place (e.g., `dirs[:] = [d for d in dirs if not (d.startswith('.') and d != '.obsidian')]`) to explicitly prevent scanning of hidden directories while preserving essential ones like `.obsidian`.
