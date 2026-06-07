import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any


TopicLoader = Callable[[], Awaitable[dict[str, Any]]]
TopicSender = Callable[[str, dict[str, Any], set[int] | None], Awaitable[int]]


@dataclass(frozen=True)
class AdminRealtimeTopic:
    name: str
    loader: TopicLoader
    interval_seconds: float
    ttl_seconds: float | None = None


class AdminRealtimeHub:
    """Single-flight topic refresh and fanout for authenticated admin WebSockets."""

    def __init__(self, sender: TopicSender, logger=None):
        self._sender = sender
        self._logger = logger
        self._topics: dict[str, AdminRealtimeTopic] = {}
        self._topic_tasks: dict[str, asyncio.Task] = {}
        self._topic_locks: dict[str, asyncio.Lock] = {}
        self._subscriptions: dict[str, set[int]] = {}
        self._connection_topics: dict[int, set[str]] = {}
        self._cache: dict[str, dict[str, Any]] = {}

    def register_topic(self, topic: AdminRealtimeTopic) -> None:
        if not topic.name:
            raise ValueError("topic name is required")
        self._topics[topic.name] = topic
        self._topic_locks.setdefault(topic.name, asyncio.Lock())

    async def subscribe(self, connection_id: int, topic_name: str) -> bool:
        if topic_name not in self._topics:
            return False
        self._subscriptions.setdefault(topic_name, set()).add(connection_id)
        self._connection_topics.setdefault(connection_id, set()).add(topic_name)
        self._ensure_topic_task(topic_name)
        cached = self._cache.get(topic_name)
        if cached:
            await self._sender(topic_name, cached, {connection_id})
        if not cached or self._is_cache_expired(topic_name):
            self.request_refresh(topic_name)
        return True

    async def unsubscribe(self, connection_id: int, topic_name: str) -> None:
        topic_connections = self._subscriptions.get(topic_name)
        if topic_connections is not None:
            topic_connections.discard(connection_id)
            if not topic_connections:
                self._subscriptions.pop(topic_name, None)
        connection_topics = self._connection_topics.get(connection_id)
        if connection_topics is not None:
            connection_topics.discard(topic_name)
            if not connection_topics:
                self._connection_topics.pop(connection_id, None)

    async def disconnect(self, connection_id: int) -> None:
        for topic_name in list(self._connection_topics.get(connection_id, set())):
            await self.unsubscribe(connection_id, topic_name)
        self._connection_topics.pop(connection_id, None)

    def request_refresh(self, topic_name: str) -> bool:
        if topic_name not in self._topics:
            return False
        self._ensure_topic_task(topic_name)
        asyncio.create_task(self.refresh(topic_name), name=f"admin-topic-refresh:{topic_name}")
        return True

    async def refresh(self, topic_name: str) -> bool:
        topic = self._topics.get(topic_name)
        if topic is None:
            return False
        lock = self._topic_locks.setdefault(topic_name, asyncio.Lock())
        if lock.locked():
            return True
        async with lock:
            subscribers = set(self._subscriptions.get(topic_name) or set())
            if not subscribers:
                return True
            started_at = time.perf_counter()
            try:
                data = await topic.loader()
                message = {
                    "type": "admin_topic_data",
                    "topic": topic_name,
                    "data": data or {},
                    "generated_at": time.time(),
                    "refresh_ms": round((time.perf_counter() - started_at) * 1000.0, 2),
                }
                self._cache[topic_name] = message
                await self._sender(topic_name, message, subscribers)
            except Exception as exc:
                if self._logger:
                    self._logger.warning("[AdminRealtime] topic refresh failed topic=%s error=%s", topic_name, exc)
                await self._sender(topic_name, {
                    "type": "admin_topic_error",
                    "topic": topic_name,
                    "message": str(exc)[:300],
                    "generated_at": time.time(),
                }, subscribers)
        return True

    async def stop(self) -> None:
        tasks = list(self._topic_tasks.values())
        self._topic_tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def snapshot(self) -> dict[str, Any]:
        return {
            "topics": {
                name: {
                    "subscribers": len(self._subscriptions.get(name) or set()),
                    "cached": name in self._cache,
                    "task_running": bool(self._topic_tasks.get(name) and not self._topic_tasks[name].done()),
                }
                for name in sorted(self._topics.keys())
            }
        }

    def _ensure_topic_task(self, topic_name: str) -> None:
        current = self._topic_tasks.get(topic_name)
        if current and not current.done():
            return
        self._topic_tasks[topic_name] = asyncio.create_task(
            self._topic_loop(topic_name),
            name=f"admin-topic-loop:{topic_name}",
        )

    async def _topic_loop(self, topic_name: str) -> None:
        try:
            while topic_name in self._topics:
                if not self._subscriptions.get(topic_name):
                    break
                await self.refresh(topic_name)
                topic = self._topics[topic_name]
                await asyncio.sleep(max(1.0, float(topic.interval_seconds or 1.0)))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if self._logger:
                self._logger.warning("[AdminRealtime] topic loop stopped topic=%s error=%s", topic_name, exc)
        finally:
            current = self._topic_tasks.get(topic_name)
            if current is asyncio.current_task():
                self._topic_tasks.pop(topic_name, None)

    def _is_cache_expired(self, topic_name: str) -> bool:
        topic = self._topics.get(topic_name)
        cached = self._cache.get(topic_name)
        if not topic or not cached:
            return True
        ttl = topic.ttl_seconds if topic.ttl_seconds is not None else topic.interval_seconds
        generated_at = float(cached.get("generated_at") or 0)
        return time.time() - generated_at >= max(1.0, float(ttl or 1.0))
