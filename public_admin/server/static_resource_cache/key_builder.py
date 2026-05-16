import hashlib


class StaticResourceCacheKeyBuilder:
    def build(self, namespace: str, url: str) -> str:
        raw = f'{namespace}|{url}'
        return hashlib.sha256(raw.encode('utf-8')).hexdigest()

    def shard(self, cache_key: str) -> str:
        return cache_key[:2]
