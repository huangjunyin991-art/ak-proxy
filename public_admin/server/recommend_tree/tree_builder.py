from collections import Counter
from typing import Any


def safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value or 0))
    except (TypeError, ValueError):
        return default


def has_inferred_level_in_tree(node: dict[str, Any], target_level: int) -> bool:
    if safe_int(node.get("_mLevel")) >= target_level:
        return True
    return any(has_inferred_level_in_tree(child, target_level) for child in node.get("children") or [])


def calculate_inferred_level(node: dict[str, Any]) -> int:
    f_value = safe_int(node.get("F"))
    l_value = safe_int(node.get("L"))
    r_value = safe_int(node.get("R"))
    small_area = min(l_value, r_value)
    children = node.get("children") or []
    for child in children:
        calculate_inferred_level(child)
    level_requirements = {
        1: {"F": 5, "small_area": 2, "next_level": 0, "lines": 0},
        2: {"F": 10, "small_area": 10, "next_level": 1, "lines": 3},
        3: {"F": 15, "small_area": 50, "next_level": 2, "lines": 3},
        4: {"F": 20, "small_area": 500, "next_level": 3, "lines": 3},
        5: {"F": 25, "small_area": 5000, "next_level": 4, "lines": 3},
    }
    computed_level = 0
    for level in [5, 4, 3, 2, 1]:
        requirement = level_requirements[level]
        if f_value < requirement["F"] or small_area < requirement["small_area"]:
            continue
        if level == 1:
            computed_level = 1
            break
        qualified_branch_count = sum(1 for child in children if has_inferred_level_in_tree(child, requirement["next_level"]))
        if qualified_branch_count >= requirement["lines"]:
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


def build_payload(account: str, tree_data: dict[str, Any]) -> dict[str, Any]:
    root = tree_data.get("root") or {}
    calculate_inferred_level(root)
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
