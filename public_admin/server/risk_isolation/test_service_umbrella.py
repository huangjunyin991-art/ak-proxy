import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from public_admin.server.risk_isolation.service import RiskIsolationService


class FakeRiskIsolationRepository:
    def __init__(self, allowed):
        self.allowed = {item.lower() for item in allowed}
        self.isolated = []

    async def filter_allowed_usernames(self, usernames, added_by=None):
        result = []
        for username in usernames or []:
            value = str(username or "").strip().lower()
            if value and value in self.allowed and value not in result:
                result.append(value)
        return result

    async def isolate_usernames(self, usernames, operator, operator_role, reason=""):
        self.isolated = list(usernames or [])
        return {"updated": len(self.isolated), "usernames": self.isolated}


def run(coro):
    return asyncio.run(coro)


def make_service(repository, resolver):
    return RiskIsolationService(
        repository,
        super_admin_role="super_admin",
        sub_admin_role="sub_admin",
        sub_admin_exists=lambda name: bool(name),
        umbrella_resolver=resolver,
    )


def test_isolate_umbrella_filters_members_to_current_scope():
    async def resolver(account):
        return {
            "usernames": [account, "child1", "child2", "outside"],
            "cached": True,
            "refreshed": False,
            "node_count": 4,
        }

    repository = FakeRiskIsolationRepository({"root", "child1", "child2"})
    service = make_service(repository, resolver)
    scope = service.resolve_scope("super_admin")

    result = run(service.isolate_umbrella(scope, "root", "admin", "super_admin", "test"))

    assert result["usernames"] == ["root", "child1", "child2"]
    assert result["updated"] == 3
    assert result["umbrella_total"] == 4
    assert result["skipped_total"] == 1


def test_isolate_umbrella_rejects_target_outside_scope_before_resolving_tree():
    called = False

    async def resolver(account):
        nonlocal called
        called = True
        return {"usernames": [account]}

    repository = FakeRiskIsolationRepository({"other"})
    service = make_service(repository, resolver)
    scope = service.resolve_scope("super_admin")

    try:
        run(service.isolate_umbrella(scope, "root", "admin", "super_admin", "test"))
    except PermissionError:
        pass
    else:
        raise AssertionError("expected PermissionError")
    assert called is False


def main():
    test_isolate_umbrella_filters_members_to_current_scope()
    test_isolate_umbrella_rejects_target_outside_scope_before_resolving_tree()


if __name__ == "__main__":
    main()
