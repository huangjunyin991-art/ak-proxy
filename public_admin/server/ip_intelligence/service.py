import asyncio
import ipaddress
import json
import time
from typing import Any
from urllib.parse import quote

import httpx

from .models import IpIntelligenceRecord, IpLocationPoint


DEFAULT_SERVER_LOCATION = IpLocationPoint(
    label="Server",
    country="Hong Kong",
    region="Hong Kong",
    city="Hong Kong",
    latitude=22.3193,
    longitude=114.1694,
)


class IpIntelligenceService:
    def __init__(self, pool_supplier, system_config=None, logger=None):
        self._pool_supplier = pool_supplier
        self._system_config = system_config
        self._logger = logger
        self._cache_lock = asyncio.Lock()
        self._memo: dict[str, dict[str, Any]] = {}
        self._config_key = "ip_intelligence_policy"
        self._schema_ready = False

    async def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS ip_intelligence_cache (
                    ip VARCHAR(64) PRIMARY KEY,
                    payload JSONB NOT NULL,
                    cached_at TIMESTAMP NOT NULL DEFAULT NOW(),
                    expires_at TIMESTAMP NOT NULL
                )
                """
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_ip_intelligence_cache_expires_at ON ip_intelligence_cache(expires_at)"
            )
        self._schema_ready = True

    async def get_policy(self) -> dict[str, Any]:
        default = {
            "enabled": True,
            "cache_ttl_seconds": 2592000,
            "api_key": "",
            "base_url": "https://iplocate.io/api/lookup",
            "request_timeout_seconds": 8,
            "connect_timeout_seconds": 4,
            "heatmap_range_hours": 24,
            "auto_enrich_missing": True,
            "auto_enrich_limit": 20,
            "server_location": DEFAULT_SERVER_LOCATION.to_dict(),
        }
        if self._system_config is None:
            return default
        try:
            saved = await self._system_config.get(self._config_key, None)
            if isinstance(saved, dict):
                default.update(saved)
        except Exception as exc:
            if self._logger:
                self._logger.warning(f"[IpIntelligence] load policy failed: {exc}")
        server_location = default.get("server_location")
        if not isinstance(server_location, dict):
            default["server_location"] = DEFAULT_SERVER_LOCATION.to_dict()
        return default

    async def set_policy(self, payload: dict[str, Any]) -> dict[str, Any]:
        policy = await self._normalize_policy(payload or {})
        if self._system_config is None:
            return policy
        ok = await self._system_config.set(self._config_key, policy, "IP intelligence policy")
        if not ok:
            raise RuntimeError("save ip intelligence policy failed")
        return policy

    async def snapshot(self) -> dict[str, Any]:
        policy = await self.get_policy()
        return {"policy": policy, "available": True}

    async def get_attack_map(self, range_hours: int | None = None) -> dict[str, Any]:
        await self.ensure_schema()
        policy = await self.get_policy()
        hours = self._normalize_range_hours(range_hours or policy.get("heatmap_range_hours"))
        if bool(policy.get("auto_enrich_missing", True)):
            await self._enrich_missing_ban_ips(policy, hours)

        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                WITH ip_bans AS (
                    SELECT ban_value AS ip, COUNT(*)::int AS count, MAX(banned_at) AS last_banned_at
                    FROM ban_list
                    WHERE ban_type = 'ip'
                      AND banned_at >= NOW() - ($1::int * INTERVAL '1 hour')
                    GROUP BY ban_value
                    UNION ALL
                    SELECT ip_address AS ip, COUNT(*)::int AS count, MAX(banned_at) AS last_banned_at
                    FROM ip_stats
                    WHERE is_banned = TRUE
                      AND banned_at >= NOW() - ($1::int * INTERVAL '1 hour')
                      AND NOT EXISTS (
                          SELECT 1 FROM ban_list bl WHERE bl.ban_type = 'ip' AND bl.ban_value = ip_stats.ip_address
                      )
                    GROUP BY ip_address
                ),
                merged AS (
                    SELECT ip, SUM(count)::int AS count, MAX(last_banned_at) AS last_banned_at
                    FROM ip_bans
                    GROUP BY ip
                )
                SELECT m.ip, m.count, m.last_banned_at,
                       c.payload,
                       extract(epoch from c.cached_at) AS cached_at_ts,
                       extract(epoch from c.expires_at) AS expires_at_ts
                FROM merged m
                LEFT JOIN ip_intelligence_cache c ON c.ip = m.ip
                ORDER BY m.count DESC, m.last_banned_at DESC NULLS LAST
                LIMIT 500
                """,
                hours,
            )

        points: list[dict[str, Any]] = []
        missing_count = 0
        total = 0
        region_stats: dict[str, dict[str, Any]] = {}
        for row in rows:
            total += 1
            payload = self._decode_payload(row["payload"])
            lat = self._to_float(payload.get("latitude"))
            lng = self._to_float(payload.get("longitude"))
            count = int(row["count"] or 0)
            if lat is None or lng is None:
                missing_count += 1
                continue
            source = payload.get("source_point") if isinstance(payload.get("source_point"), dict) else {}
            country = str(source.get("country") or payload.get("country") or "未知")
            city = str(source.get("city") or payload.get("city") or "")
            region_key = f"{country}/{city}" if city else country
            points.append({
                "ip": row["ip"],
                "name": region_key,
                "country": country,
                "city": city,
                "count": count,
                "value": [lng, lat, count],
                "last_banned_at": row["last_banned_at"].isoformat() if row["last_banned_at"] else None,
            })
            stat = region_stats.setdefault(region_key, {
                "name": region_key,
                "country": country,
                "city": city,
                "count": 0,
                "ips": 0,
            })
            stat["count"] += count
            stat["ips"] += 1

        top_regions = sorted(region_stats.values(), key=lambda item: (-int(item["count"]), -int(item["ips"])))[:12]
        server = self._normalize_location(policy.get("server_location") or DEFAULT_SERVER_LOCATION.to_dict())
        return {
            "range_hours": hours,
            "server_point": server,
            "points": points,
            "top_regions": top_regions,
            "total_ip_count": total,
            "mapped_ip_count": len(points),
            "missing_ip_count": missing_count,
            "cache_coverage": round((len(points) / total) if total else 1, 4),
        }

    async def get_ip_info(self, ip: str, *, force_refresh: bool = False) -> dict[str, Any]:
        normalized_ip = str(ip or "").strip()
        if not normalized_ip:
            raise ValueError("ip is empty")
        try:
            ipaddress.ip_address(normalized_ip)
        except ValueError:
            raise ValueError("IP 格式无效")
        await self.ensure_schema()
        policy = await self.get_policy()
        ttl_seconds = max(60, int(policy.get("cache_ttl_seconds") or 2592000))
        cached = None if force_refresh else await self._read_cache(normalized_ip)
        now = time.time()
        if cached and float(cached.get("expires_at") or 0) > now:
            return cached
        record = await self._fetch_remote(normalized_ip, policy) if bool(policy.get("enabled", True)) else {}
        result = self._normalize_result(normalized_ip, record, policy, ttl_seconds)
        await self._write_cache(normalized_ip, result, ttl_seconds)
        return result

    async def _fetch_remote(self, ip: str, policy: dict[str, Any]) -> dict[str, Any]:
        api_key = str(policy.get("api_key") or "").strip()
        base_url = str(policy.get("base_url") or "").strip().rstrip("/")
        if not base_url:
            return {}
        url = f"{base_url}/{quote(ip, safe='')}"
        timeout = httpx.Timeout(8.0, connect=4.0)
        timeout_seconds = max(1.0, min(30.0, float(policy.get("request_timeout_seconds") or 8)))
        connect_seconds = max(1.0, min(timeout_seconds, float(policy.get("connect_timeout_seconds") or 4)))
        timeout = httpx.Timeout(timeout_seconds, connect=connect_seconds)
        try:
            async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
                headers = {"X-API-Key": api_key} if api_key else {}
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                return data if isinstance(data, dict) else {}
        except Exception as exc:
            if self._logger:
                self._logger.warning(f"[IpIntelligence] fetch failed ip={ip}: {exc}")
            return {}

    def _normalize_result(self, ip: str, data: dict[str, Any], policy: dict[str, Any], ttl_seconds: int) -> dict[str, Any]:
        now = time.time()
        location = policy.get("server_location") if isinstance(policy.get("server_location"), dict) else DEFAULT_SERVER_LOCATION.to_dict()
        source = self._extract_point(ip, data)
        record = IpIntelligenceRecord(
            ip=ip,
            country_code=str(data.get("country_code") or data.get("countryCode") or ""),
            country=str(data.get("country") or ""),
            subdivision=str(data.get("subdivision") or data.get("region") or ""),
            city=str(data.get("city") or ""),
            latitude=self._to_float(data.get("latitude")),
            longitude=self._to_float(data.get("longitude")),
            time_zone=str(data.get("time_zone") or data.get("timezone") or ""),
            is_eu=bool(data.get("is_eu") or False),
            is_anycast=bool(data.get("is_anycast") or False),
            is_satellite=bool(data.get("is_satellite") or False),
            asn=self._extract_asn(data),
            organization=self._extract_org(data),
            carrier=str(data.get("carrier") or ""),
            vpn=self._extract_bool(data, "vpn"),
            proxy=self._extract_bool(data, "proxy"),
            tor=self._extract_bool(data, "tor"),
            hosting=self._extract_bool(data, "hosting"),
            source="remote" if data else "config-only",
            cached_at=now,
            expires_at=now + ttl_seconds,
            raw=data,
        ).to_dict()
        record["source_point"] = source.to_dict()
        record["server_point"] = IpLocationPoint(
            label="Server",
            country=str(location.get("country") or ""),
            region=str(location.get("region") or ""),
            city=str(location.get("city") or ""),
            latitude=self._to_float(location.get("latitude")),
            longitude=self._to_float(location.get("longitude")),
        ).to_dict()
        record["has_coordinates"] = record["latitude"] is not None and record["longitude"] is not None
        record["has_server_coordinates"] = record["server_point"]["latitude"] is not None and record["server_point"]["longitude"] is not None
        return record

    def _extract_point(self, ip: str, data: dict[str, Any]) -> IpLocationPoint:
        return IpLocationPoint(
            label=ip,
            country=str(data.get("country") or ""),
            region=str(data.get("subdivision") or data.get("region") or ""),
            city=str(data.get("city") or ""),
            latitude=self._to_float(data.get("latitude")),
            longitude=self._to_float(data.get("longitude")),
        )

    async def _read_cache(self, ip: str) -> dict[str, Any] | None:
        async with self._cache_lock:
            if ip in self._memo:
                item = self._memo[ip]
                if float(item.get("expires_at") or 0) > time.time():
                    return dict(item)
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT payload, extract(epoch from cached_at) AS cached_at_ts, extract(epoch from expires_at) AS expires_at_ts FROM ip_intelligence_cache WHERE ip = $1",
                ip,
            )
        if not row:
            return None
        payload = row["payload"]
        payload = self._decode_payload(payload)
        payload["cached_at"] = float(row["cached_at_ts"] or 0)
        payload["expires_at"] = float(row["expires_at_ts"] or 0)
        async with self._cache_lock:
            self._memo[ip] = dict(payload)
        return payload

    async def _write_cache(self, ip: str, payload: dict[str, Any], ttl_seconds: int) -> None:
        expires_at = time.time() + ttl_seconds
        cached = dict(payload)
        cached["expires_at"] = expires_at
        cached["cached_at"] = payload.get("cached_at") or time.time()
        async with self._cache_lock:
            self._memo[ip] = dict(cached)
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO ip_intelligence_cache (ip, payload, cached_at, expires_at)
                VALUES ($1, $2::jsonb, NOW(), to_timestamp($3))
                ON CONFLICT (ip) DO UPDATE SET payload = EXCLUDED.payload, cached_at = NOW(), expires_at = EXCLUDED.expires_at
                """,
                ip,
                json.dumps(cached, ensure_ascii=False, default=str),
                expires_at,
            )

    async def _normalize_policy(self, payload: dict[str, Any]) -> dict[str, Any]:
        policy = await self.get_policy()
        policy.update({
            "enabled": bool(payload.get("enabled", policy.get("enabled", True))),
            "cache_ttl_seconds": max(60, int(payload.get("cache_ttl_seconds") or policy.get("cache_ttl_seconds") or 2592000)),
            "api_key": str(payload.get("api_key") if payload.get("api_key") is not None else policy.get("api_key") or "").strip(),
            "base_url": str(payload.get("base_url") if payload.get("base_url") is not None else policy.get("base_url") or "").strip() or "https://iplocate.io/api/lookup",
            "request_timeout_seconds": max(1, min(30, int(payload.get("request_timeout_seconds") or policy.get("request_timeout_seconds") or 8))),
            "connect_timeout_seconds": max(1, min(30, int(payload.get("connect_timeout_seconds") or policy.get("connect_timeout_seconds") or 4))),
            "heatmap_range_hours": self._normalize_range_hours(payload.get("heatmap_range_hours") or policy.get("heatmap_range_hours")),
            "auto_enrich_missing": bool(payload.get("auto_enrich_missing", policy.get("auto_enrich_missing", True))),
            "auto_enrich_limit": max(0, min(100, int(payload.get("auto_enrich_limit") or policy.get("auto_enrich_limit") or 20))),
            "server_location": self._normalize_location(payload.get("server_location") or policy.get("server_location") or DEFAULT_SERVER_LOCATION.to_dict()),
        })
        return policy

    async def _enrich_missing_ban_ips(self, policy: dict[str, Any], range_hours: int) -> None:
        limit = max(0, min(100, int(policy.get("auto_enrich_limit") or 20)))
        if limit <= 0:
            return
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                WITH candidate AS (
                    SELECT ban_value AS ip, MAX(banned_at) AS last_banned_at
                    FROM ban_list
                    WHERE ban_type = 'ip'
                      AND banned_at >= NOW() - ($1::int * INTERVAL '1 hour')
                    GROUP BY ban_value
                    UNION ALL
                    SELECT ip_address AS ip, MAX(banned_at) AS last_banned_at
                    FROM ip_stats
                    WHERE is_banned = TRUE
                      AND banned_at >= NOW() - ($1::int * INTERVAL '1 hour')
                    GROUP BY ip_address
                )
                SELECT c.ip
                FROM candidate c
                LEFT JOIN ip_intelligence_cache cache ON cache.ip = c.ip
                WHERE cache.ip IS NULL
                   OR cache.expires_at <= NOW()
                   OR (cache.payload->>'has_coordinates')::boolean IS DISTINCT FROM TRUE
                ORDER BY c.last_banned_at DESC NULLS LAST
                LIMIT $2
                """,
                range_hours,
                limit,
            )
        for row in rows:
            try:
                await self.get_ip_info(str(row["ip"] or ""))
            except Exception as exc:
                if self._logger:
                    self._logger.debug(f"[IpIntelligence] enrich skipped ip={row['ip']}: {exc}")

    def _decode_payload(self, payload: Any) -> dict[str, Any]:
        if isinstance(payload, dict):
            return dict(payload)
        try:
            if isinstance(payload, str):
                value = json.loads(payload)
                return value if isinstance(value, dict) else {}
            return dict(payload or {})
        except Exception:
            return {}

    def _normalize_range_hours(self, value: Any) -> int:
        try:
            hours = int(value or 24)
        except Exception:
            hours = 24
        allowed = (1, 24, 168, 720)
        return min(allowed, key=lambda item: abs(item - hours))

    def _extract_asn(self, data: dict[str, Any]) -> str:
        asn = data.get("asn")
        if isinstance(asn, dict):
            return str(asn.get("asn") or asn.get("number") or asn.get("id") or "")
        return str(asn or data.get("autonomous_system_number") or "")

    def _extract_org(self, data: dict[str, Any]) -> str:
        for key in ("company", "asn", "hosting"):
            item = data.get(key)
            if isinstance(item, dict):
                value = item.get("name") or item.get("organization") or item.get("org")
                if value:
                    return str(value)
        return str(data.get("organization") or data.get("org") or data.get("isp") or "")

    def _extract_bool(self, data: dict[str, Any], key: str) -> bool:
        value = data.get(key)
        if isinstance(value, bool):
            return value
        privacy = data.get("privacy")
        if isinstance(privacy, dict) and isinstance(privacy.get(key), bool):
            return bool(privacy.get(key))
        hosting = data.get("hosting")
        if key == "hosting" and isinstance(hosting, dict):
            if isinstance(hosting.get("provider"), bool):
                return bool(hosting.get("provider"))
            if hosting.get("name"):
                return True
        if key == "hosting" and isinstance(data.get("is_hosting"), bool):
            return bool(data.get("is_hosting"))
        return bool(value)

    def _normalize_location(self, value: Any) -> dict[str, Any]:
        base = DEFAULT_SERVER_LOCATION.to_dict()
        if isinstance(value, dict):
            base.update({
                "label": str(value.get("label") or base["label"]),
                "country": str(value.get("country") or base["country"]),
                "region": str(value.get("region") or base["region"]),
                "city": str(value.get("city") or base["city"]),
                "latitude": self._to_float(value.get("latitude")) if value.get("latitude") is not None else base["latitude"],
                "longitude": self._to_float(value.get("longitude")) if value.get("longitude") is not None else base["longitude"],
            })
        return base

    @staticmethod
    def _to_float(value: Any) -> float | None:
        try:
            if value is None or value == "":
                return None
            return float(value)
        except Exception:
            return None
