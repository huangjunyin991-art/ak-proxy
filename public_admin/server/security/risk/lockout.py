import time
from typing import Tuple


class LockoutStore:
    def __init__(self, max_fails: int, lockout_seconds: int):
        self.max_fails = max_fails
        self.lockout_seconds = lockout_seconds
        self.records = {}

    def check(self, key: str) -> Tuple[bool, int]:
        record = self.records.get(key, [0, 0])
        if record[0] >= self.max_fails:
            elapsed = time.time() - record[1]
            if elapsed < self.lockout_seconds:
                return True, int(self.lockout_seconds - elapsed)
            self.records.pop(key, None)
        return False, 0

    def record_fail(self, key: str) -> int:
        record = self.records.get(key, [0, 0])
        record[0] += 1
        record[1] = time.time()
        self.records[key] = record
        return record[0]

    def clear(self, key: str):
        self.records.pop(key, None)

    def get_record(self, key: str):
        return self.records.get(key, [0, 0])
