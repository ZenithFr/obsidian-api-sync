import asyncio

class PathLockWrapper:
    def __init__(self, manager, path, is_global):
        self.manager = manager
        self.path = path
        self.is_global = is_global
        self.inner_lock = None

    async def __aenter__(self):
        if self.is_global:
            async with self.manager._state_lock:
                self.manager._waiting_writers += 1
                while self.manager._active_readers > 0 or self.manager._active_writers > 0:
                    await self.manager._write_cond.wait()
                self.manager._waiting_writers -= 1
                self.manager._active_writers += 1
        else:
            async with self.manager._state_lock:
                while self.manager._active_writers > 0 or self.manager._waiting_writers > 0:
                    await self.manager._read_cond.wait()
                self.manager._active_readers += 1
            
            async with self.manager._dict_lock:
                if self.path not in self.manager._locks:
                    self.manager._locks[self.path] = asyncio.Lock()
                self.inner_lock = self.manager._locks[self.path]
            await self.inner_lock.acquire()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.is_global:
            async with self.manager._state_lock:
                self.manager._active_writers -= 1
                if self.manager._waiting_writers > 0:
                    self.manager._write_cond.notify()
                else:
                    self.manager._read_cond.notify_all()
        else:
            self.inner_lock.release()
            async with self.manager._state_lock:
                self.manager._active_readers -= 1
                if self.manager._active_readers == 0:
                    self.manager._write_cond.notify()

class PathLockManager:
    """Manages asyncio Locks per file path with global exclusion for snapshots."""
    def __init__(self):
        self._locks = {}
        self._dict_lock = asyncio.Lock()
        
        self._state_lock = asyncio.Lock()
        self._active_readers = 0
        self._waiting_writers = 0
        self._active_writers = 0
        self._read_cond = asyncio.Condition(self._state_lock)
        self._write_cond = asyncio.Condition(self._state_lock)

    async def acquire(self, path: str):
        is_global = (path == "__GLOBAL_VAULT_LOCK__")
        return PathLockWrapper(self, path, is_global)

# Global singleton lock manager for all file operations
file_locks = PathLockManager()
