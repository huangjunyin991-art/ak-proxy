import time
from collections import Counter, deque
from datetime import datetime
from typing import Any

import httpx

from ..security.upstream_http import resolve_upstream_tls_verify

DEFAULT_BASE_URL = "http://127.0.0.1:8080/RPC/"
DEFAULT_PAGE_SIZE = 15
DEFAULT_MAX_PAGES = 0


def make_v() -> str:
    now = datetime.now()
    return str(now.year + now.month + now.day + now.hour + now.minute)


def normalize_base_url(base_url: str) -> str:
    value = (base_url or DEFAULT_BASE_URL).strip()
    return value if value.endswith("/") else value + "/"


def make_headers() -> dict[str, str]:
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": "https://www.akapi1.com",
        "Referer": "https://www.akapi1.com/",
    }


def safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value or 0))
    except (TypeError, ValueError):
        return default


def node_from_player(player: dict[str, Any], fallback_id: Any = "") -> dict[str, Any]:
    node_id = player.get("Id") or fallback_id
    return {
        "id": node_id,
        "rId": node_id,
        "name": player.get("NickName") or player.get("Name") or "",
        "account": player.get("MemberNo") or player.get("FlowNumber") or player.get("Account") or "",
        "F": safe_int(player.get("F")),
        "L": safe_int(player.get("L")),
        "R": safe_int(player.get("R")),
        "S": safe_int(player.get("S")),
        "children": [],
        "raw": player,
    }


class RecommendTreeProvider:
    def __init__(self, base_url: str = DEFAULT_BASE_URL):
        self.base_url = normalize_base_url(base_url)

    async def post_rpc(self, client: httpx.AsyncClient, endpoint: str, data: dict[str, Any], timeout: float = 20.0) -> dict[str, Any]:
        response = await client.post(self.base_url + endpoint, data=data, timeout=timeout)
        response.raise_for_status()
        payload = response.json()
        if payload.get("Error"):
            message = payload.get("Msg") or payload.get("Message") or "RPC returned Error=true"
            raise RuntimeError(str(message))
        return payload

    async def login(self, client: httpx.AsyncClient, account: str, password: str) -> dict[str, Any]:
        payload = await self.post_rpc(client, "Login", {
            "account": account,
            "password": password,
            "v": make_v(),
            "lang": "cn",
        }, timeout=25.0)
        user_data = payload.get("UserData") or {}
        key = payload.get("Key") or ""
        user_id = user_data.get("Id") or payload.get("UserID") or ""
        if not key or not user_id:
            raise RuntimeError("登录结果缺少Key或UserID")
        return {
            "key": key,
            "user_id": user_id,
            "user_data": user_data,
        }

    async def fetch_recommend_page(self, client: httpx.AsyncClient, auth: dict[str, Any], r_id: Any, page: int, page_size: int) -> dict[str, Any]:
        payload = await self.post_rpc(client, "My_RecommendUserList", {
            "p": str(page),
            "pageSize": str(page_size),
            "rId": str(r_id),
            "key": auth["key"],
            "UserID": str(auth["user_id"]),
            "v": make_v(),
            "lang": "cn",
        }, timeout=25.0)
        data = payload.get("Data") or {}
        if not isinstance(data, dict):
            raise RuntimeError(f"推荐树Data类型异常: {type(data).__name__}")
        return data

    async def fetch_all_children(self, client: httpx.AsyncClient, auth: dict[str, Any], r_id: Any, page_size: int, max_pages: int) -> tuple[dict[str, Any], list[dict[str, Any]], int]:
        current = {}
        players: list[dict[str, Any]] = []
        request_count = 0
        page = 1
        while True:
            if max_pages and page > max_pages:
                break
            data = await self.fetch_recommend_page(client, auth, r_id, page, page_size)
            request_count += 1
            if page == 1:
                current = data.get("Current") or {}
            batch = data.get("List") or []
            if not isinstance(batch, list):
                raise RuntimeError(f"推荐树List类型异常: {type(batch).__name__}")
            players.extend(batch)
            if len(batch) < page_size:
                break
            page += 1
        return current, players, request_count

    async def build_tree(self, auth: dict[str, Any], root_rid: Any = "", page_size: int = DEFAULT_PAGE_SIZE, max_pages: int = DEFAULT_MAX_PAGES, max_depth: int = 0, max_nodes: int = 0) -> dict[str, Any]:
        started_at = time.time()
        root_id = root_rid or auth.get("user_id")
        async with httpx.AsyncClient(
            headers=make_headers(),
            verify=resolve_upstream_tls_verify("recommend_tree"),
            follow_redirects=True,
            trust_env=False,
            timeout=25.0,
        ) as client:
            current, first_children, request_count = await self.fetch_all_children(client, auth, root_id, page_size, max_pages)
            root_source = current or auth.get("user_data") or {"Id": root_id}
            root = node_from_player(root_source, fallback_id=root_id)
            root["id"] = root.get("id") or root_id
            root["rId"] = root.get("rId") or root_id
            visited = {str(root["rId"])}
            queue: deque[tuple[Any, dict[str, Any], int]] = deque()
            errors: list[dict[str, Any]] = []
            nodes_by_depth = Counter({0: 1})
            total_nodes = 1
            for child in first_children:
                child_id = child.get("Id")
                if child_id is None or str(child_id) in visited:
                    continue
                child_node = node_from_player(child)
                root["children"].append(child_node)
                visited.add(str(child_id))
                total_nodes += 1
                nodes_by_depth[1] += 1
                if safe_int(child.get("F")) > 0:
                    queue.append((child_id, child_node, 1))
                if max_nodes and total_nodes >= max_nodes:
                    break
            while queue:
                if max_nodes and total_nodes >= max_nodes:
                    break
                r_id, parent_node, depth = queue.popleft()
                if max_depth and depth >= max_depth:
                    continue
                try:
                    _, children, used_requests = await self.fetch_all_children(client, auth, r_id, page_size, max_pages)
                    request_count += used_requests
                except Exception as exc:
                    errors.append({"rId": r_id, "depth": depth, "message": str(exc)})
                    continue
                next_depth = depth + 1
                for child in children:
                    child_id = child.get("Id")
                    if child_id is None or str(child_id) in visited:
                        continue
                    child_node = node_from_player(child)
                    parent_node["children"].append(child_node)
                    visited.add(str(child_id))
                    total_nodes += 1
                    nodes_by_depth[next_depth] += 1
                    if safe_int(child.get("F")) > 0:
                        queue.append((child_id, child_node, next_depth))
                    if max_nodes and total_nodes >= max_nodes:
                        break
        elapsed_ms = int((time.time() - started_at) * 1000)
        return {
            "success": True,
            "root_rid": root_id,
            "root": root,
            "stats": {
                "total_nodes": total_nodes,
                "max_depth": max(nodes_by_depth.keys()) if nodes_by_depth else 0,
                "requests": request_count,
                "elapsed_ms": elapsed_ms,
                "nodes_by_depth": {str(k): v for k, v in sorted(nodes_by_depth.items())},
                "error_count": len(errors),
                "limited_by_max_nodes": bool(max_nodes and total_nodes >= max_nodes),
            },
            "errors": errors,
        }
