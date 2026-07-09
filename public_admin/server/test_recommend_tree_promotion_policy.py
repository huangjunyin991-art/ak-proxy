import asyncio

from public_admin.server.recommend_tree.promotion_policy import normalize_promotion_policy
from public_admin.server.recommend_tree.service import RecommendTreeService
from public_admin.server.recommend_tree.tree_builder import (
    apply_policy_to_payload,
    calculate_inferred_level,
)


def test_normalize_promotion_policy_keeps_m1_not_applicable():
    policy = normalize_promotion_policy(
        {
            "levels": {
                "M1": {"require_tripod": True},
                "M4": {"require_tripod": False},
            }
        }
    )

    assert policy["levels"]["M1"]["require_tripod"] is False
    assert policy["levels"]["M2"]["require_tripod"] is True
    assert policy["levels"]["M4"]["require_tripod"] is False


def test_calculate_inferred_level_skips_tripod_when_policy_disabled():
    root = {
        "F": 10,
        "L": 10,
        "R": 10,
        "children": [
            {"F": 5, "L": 2, "R": 2, "children": []},
            {"F": 5, "L": 2, "R": 2, "children": []},
        ],
    }

    default_level = calculate_inferred_level(root, policy=normalize_promotion_policy())
    assert default_level == 1

    relaxed_policy = normalize_promotion_policy({"levels": {"M2": {"require_tripod": False}}})
    relaxed_level = calculate_inferred_level(root, policy=relaxed_policy)
    assert relaxed_level == 2


def test_apply_policy_to_payload_recomputes_flat_honor_levels():
    payload = {
        "nodes": [
            {"id": "root", "parentId": None, "depth": 0, "account": "root", "honorLevel": "M1", "F": 10, "L": 10, "R": 10, "S": 0},
            {"id": "left", "parentId": "root", "depth": 1, "account": "left", "honorLevel": "M1", "F": 5, "L": 2, "R": 2, "S": 0},
            {"id": "right", "parentId": "root", "depth": 1, "account": "right", "honorLevel": "M1", "F": 5, "L": 2, "R": 2, "S": 0},
        ],
        "nodesByHonorLevel": {"M1": 3},
    }

    updated = apply_policy_to_payload(
        payload,
        policy=normalize_promotion_policy({"levels": {"M2": {"require_tripod": False}}}),
    )

    assert updated["nodes"][0]["honorLevel"] == "M2"
    assert updated["nodesByHonorLevel"]["M2"] == 1


def test_calculate_inferred_level_uses_min_side_for_m3_small_area():
    relaxed_policy = normalize_promotion_policy(
        {
            "levels": {
                "M2": {"require_tripod": False},
                "M3": {"require_tripod": False},
            }
        }
    )

    root_below_threshold = {"F": 15, "L": 300, "R": 199, "children": []}
    root_meets_threshold = {"F": 15, "L": 300, "R": 200, "children": []}

    assert calculate_inferred_level(root_below_threshold, policy=relaxed_policy) == 2
    assert calculate_inferred_level(root_meets_threshold, policy=relaxed_policy) == 3


def test_recommend_tree_service_get_cache_applies_current_policy():
    class FakeRepository:
        @staticmethod
        def normalize_account(account):
            return str(account or "").strip().lower()

        async def get_cache(self, account):
            return {
                "meta": {"nodeCount": 3},
                "payload": {
                    "nodes": [
                        {"id": "root", "parentId": None, "depth": 0, "account": "root", "honorLevel": "M1", "F": 10, "L": 10, "R": 10, "S": 0},
                        {"id": "left", "parentId": "root", "depth": 1, "account": "left", "honorLevel": "M1", "F": 5, "L": 2, "R": 2, "S": 0},
                        {"id": "right", "parentId": "root", "depth": 1, "account": "right", "honorLevel": "M1", "F": 5, "L": 2, "R": 2, "S": 0},
                    ],
                    "nodesByHonorLevel": {"M1": 3},
                },
            }

    class FakePolicyService:
        async def get_policy_payload(self):
            return normalize_promotion_policy({"levels": {"M2": {"require_tripod": False}}})

    service = RecommendTreeService(repository=FakeRepository(), policy_service=FakePolicyService())
    result = asyncio.run(service.get_cache("root"))

    assert result["success"] is True
    assert result["payload"]["nodes"][0]["honorLevel"] == "M2"
