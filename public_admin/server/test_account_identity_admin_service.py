from datetime import datetime

from public_admin.server.account_identity.admin.service import (
    build_default_sync_policy,
    compute_next_auto_run_at,
    normalize_account_identity_sync_policy,
)


def test_normalize_account_identity_sync_policy_falls_back_to_safe_defaults():
    normalized = normalize_account_identity_sync_policy({"enabled": True, "daily_time": "99:88", "phases": ["oops"], "limit_per_spec": -4})
    assert normalized["enabled"] is True
    assert normalized["daily_time"] == build_default_sync_policy()["daily_time"]
    assert normalized["phases"] == build_default_sync_policy()["phases"]
    assert normalized["limit_per_spec"] == 0


def test_compute_next_auto_run_at_rolls_to_next_day_after_target_time():
    policy = normalize_account_identity_sync_policy({"enabled": True, "daily_time": "03:30"})
    now = datetime(2026, 7, 10, 4, 15, 0)
    next_run = compute_next_auto_run_at(policy, now=now)
    assert next_run is not None
    assert next_run.strftime("%Y-%m-%d %H:%M:%S") == "2026-07-11 03:30:00"
