from public_admin.server.account_identity import ACCOUNT_ID_PHASES
from public_admin.server.account_identity.migration_service import _safe_index_name


def test_account_id_migration_phases_have_unique_keys_and_specs():
    seen_phase_keys = set()
    seen_specs = set()

    assert ACCOUNT_ID_PHASES

    for phase in ACCOUNT_ID_PHASES:
        assert phase.key
        assert phase.key not in seen_phase_keys
        seen_phase_keys.add(phase.key)
        assert phase.specs
        for spec in phase.specs:
            key = (spec.table_name, spec.username_column, spec.account_id_column)
            assert key not in seen_specs
            seen_specs.add(key)


def test_safe_index_name_is_stable_and_within_postgres_limit():
    name = _safe_index_name(
        "im_user_blacklist_with_extremely_long_table_name_for_testing",
        "target_account_id_with_extra_long_column_name",
    )
    assert name
    assert len(name) <= 63
    assert name == _safe_index_name(
        "im_user_blacklist_with_extremely_long_table_name_for_testing",
        "target_account_id_with_extra_long_column_name",
    )
