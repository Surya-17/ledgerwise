"""In-process sliding-window rate limiting.

Correct for a single API instance (the deployed setup). With several instances the
counters would live in Redis instead (e.g. a sorted set per key, ZREMRANGEBYSCORE +
ZCARD in one MULTI), with the same interface.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request, status


def client_ip(request: Request) -> str:
    # Behind one trusted proxy (Render, Fly), the proxy appends the address it saw, so the
    # *last* hop is real. Earlier hops are client-supplied and trivially spoofable.
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: float, message: str) -> None:
        self.limit = limit
        self.window = window_seconds
        self.message = message
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> deque[float]:
        hits = self._hits[key]
        while hits and now - hits[0] > self.window:
            hits.popleft()
        return hits

    def _raise_if_full(self, hits: deque[float], now: float) -> None:
        if len(hits) >= self.limit:
            retry = max(1, int(self.window - (now - hits[0])))
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=self.message,
                headers={"Retry-After": str(retry)},
            )

    def check(self, key: str) -> None:
        """Raise 429 if `key` is already at its limit, without recording a hit."""
        with self._lock:
            now = time.monotonic()
            hits = self._prune(key, now)
            if not hits:
                del self._hits[key]  # keep memory bounded by *active* keys
                return
            self._raise_if_full(hits, now)

    def hit(self, key: str) -> None:
        with self._lock:
            now = time.monotonic()
            self._prune(key, now).append(now)

    def check_and_hit(self, key: str) -> None:
        """Atomically enforce the limit and count this attempt."""
        with self._lock:
            now = time.monotonic()
            hits = self._prune(key, now)
            self._raise_if_full(hits, now)
            hits.append(now)

    def reset(self, key: str | None = None) -> None:
        with self._lock:
            if key is None:
                self._hits.clear()
            else:
                self._hits.pop(key, None)
