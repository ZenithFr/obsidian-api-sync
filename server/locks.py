import asyncio

class PathLockManager:
    """Manages asyncio Locks per file path to prevent concurrent read/write races."""
    def __init__(self):
        self._locks = {}
        self._global_lock = asyncio.Lock()

    async def acquire(self, path: str) -> asyncio.Lock:
        async with self._global_lock:
            if path not in self._locks:
                self._locks[path] = asyncio.Lock()
            return self._locks[path]

# Global singleton lock manager for all file operations
file_locks = PathLockManager()
