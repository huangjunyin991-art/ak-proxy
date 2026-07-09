from collections import Counter
from typing import Any

from .promotion_policy import (
    PROMOTION_LEVEL_ORDER,
    PROMOTION_REQUIREMENTS,
    policy_requires_tripod,
)


def safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value or 0))
    except (TypeError, ValueError):
        return default


def has_inferred_level_in_tree(node: dict[str, Any], target_level: int) -> bool:
    if safe_int(node.get("_mLevel")) >= target_level:
        return True
    return any(has_inferred_level_in_tree(child, target_level) for child in node.get("children") or [])


def calculate_inferred_level(node: dict[str, Any], policy: dict[str, Any] | None = None) -> int:
    f_value = safe_int(node.get("F"))
    l_value = safe_int(node.get("L"))
    r_value = safe_int(node.get("R"))
    small_area = min(l_value, r_value)
    children = node.get("children") or []
    for child in children:
        calculate_inferred_level(child, policy=policy)
    computed_level = 0
    for level_label in reversed(PROMOTION_LEVEL_ORDER):
        requirement = PROMOTION_REQUIREMENTS[level_label]
        level = int(requirement["level"])
        if f_value < requirement["direct_push"] or small_area < requirement["small_area"]:
            continue
        if not requirement["tripod_applicable"] or not policy_requires_tripod(policy, level_label):
            computed_level = level
            break
        next_level = safe_int(str(requirement["next_level"]).lstrip("M"))
        qualified_branch_count = sum(1 for child in children if has_inferred_level_in_tree(child, next_level))
        if qualified_branch_count >= int(requirement["required_lines"]):
            computed_level = level
            break
    node["_mLevel"] = computed_level
    m5_branch_count = sum(1 for child in children if has_inferred_level_in_tree(child, 5))
    node["_aLevel"] = min(5, m5_branch_count // 3)
    return computed_level


def honor_level_label(node: dict[str, Any]) -> str:
    a_level = safe_int(node.get("_aLevel"))
    if a_level > 0:
        return f"A{a_level}"
    return f"M{safe_int(node.get('_mLevel'))}"


def walk(node: dict[str, Any], depth: int = 0, parent_id: Any = None):
    node_id = node.get("id") or node.get("rId")
    raw = node.get("raw") or {}
    account = node.get("account") or raw.get("MemberNo") or ""
    name = node.get("name") or raw.get("NickName") or ""
    children = node.get("children") or []
    yield {
        "id": node_id,
        "parentId": parent_id,
        "depth": depth,
        "name": name,
        "account": account,
        "flowNumber": raw.get("FlowNumber") or "",
        "honorLevel": honor_level_label(node),
        "F": safe_int(node.get("F")),
        "L": safe_int(node.get("L")),
        "R": safe_int(node.get("R")),
        "S": safe_int(node.get("S")),
        "childrenCount": len(children),
        "createTime": raw.get("CreateTime") or "",
    }
    for child in children:
        yield from walk(child, depth + 1, node_id)


def build_payload(account: str, tree_data: dict[str, Any], policy: dict[str, Any] | None = None) -> dict[str, Any]:
    root = tree_data.get("root") or {}
    calculate_inferred_level(root, policy=policy)
    nodes = list(walk(root))
    depth_counter = Counter(item["depth"] for item in nodes)
    honor_level_counter = Counter(str(item.get("honorLevel")) for item in nodes)
    parent_ids = {str(item.get("parentId")) for item in nodes if item.get("parentId") not in (None, "")}
    umbrella_nodes = [item for item in nodes if safe_int(item.get("depth")) >= 1]
    branch_count = sum(1 for item in umbrella_nodes if str(item.get("id")) in parent_ids)
    max_depth = max(depth_counter.keys()) if depth_counter else 0
    return {
        "success": True,
        "account": account,
        "rootRid": tree_data.get("root_rid") or root.get("rId") or root.get("id") or "",
        "totalNodes": len(nodes),
        "maxDepth": max_depth,
        "branchCount": branch_count,
        "leafCount": max(0, len(umbrella_nodes) - branch_count),
        "nodesByDepth": {str(k): v for k, v in sorted(depth_counter.items())},
        "nodesByHonorLevel": {k: v for k, v in sorted(honor_level_counter.items())},
        "sourceStats": tree_data.get("stats") or {},
        "errors": tree_data.get("errors") or [],
        "nodes": nodes,
    }


def apply_policy_to_payload(payload: dict[str, Any], policy: dict[str, Any] | None = None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    nodes = payload.get("nodes") or []
    if not isinstance(nodes, list) or not nodes:
        return dict(payload)

    copied_nodes = [dict(item) for item in nodes if isinstance(item, dict)]
    runtime_nodes: dict[str, dict[str, Any]] = {}
    runtime_order: list[tuple[str, dict[str, Any]]] = []

    for index, node in enumerate(copied_nodes):
        raw_id = node.get("id")
        node_key = str(raw_id) if raw_id not in (None, "") else f"__node_{index}"
        runtime_nodes[node_key] = {
            "id": node_key,
            "F": node.get("F"),
            "L": node.get("L"),
            "R": node.get("R"),
            "children": [],
        }
        runtime_order.append((node_key, node))

    roots: list[dict[str, Any]] = []
    for node_key, node in runtime_order:
        parent_id = node.get("parentId")
        parent_key = str(parent_id) if parent_id not in (None, "") else ""
        parent = runtime_nodes.get(parent_key)
        if parent is None or parent is runtime_nodes[node_key]:
            roots.append(runtime_nodes[node_key])
            continue
        parent["children"].append(runtime_nodes[node_key])

    for root in roots:
        calculate_inferred_level(root, policy=policy)

    honor_level_counter: Counter[str] = Counter()
    updated_nodes: list[dict[str, Any]] = []
    for node_key, node in runtime_order:
        updated = dict(node)
        updated["honorLevel"] = honor_level_label(runtime_nodes[node_key])
        honor_level_counter[str(updated["honorLevel"])] += 1
        updated_nodes.append(updated)

    updated_payload = dict(payload)
    updated_payload["nodes"] = updated_nodes
    updated_payload["nodesByHonorLevel"] = {k: v for k, v in sorted(honor_level_counter.items())}
    return updated_payload
