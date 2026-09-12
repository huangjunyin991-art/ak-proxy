from .account_group import normalize_account_group_key
from .runtime_store import ActiveDefenseRuntimeStore


def test_numeric_subaccount_suffixes_share_main_account_key():
    assert normalize_account_group_key("cyh6699") == "cyh6699"
    assert normalize_account_group_key("CYH6699-1") == "cyh6699"
    assert normalize_account_group_key(" cyh6699-55 ") == "cyh6699"


def test_only_numeric_suffix_is_grouped():
    assert normalize_account_group_key("cyh6699-prod") == "cyh6699-prod"
    assert normalize_account_group_key("cyh-6699") == "cyh-6699"
    assert normalize_account_group_key("cyh6699-1-a") == "cyh6699-1-a"


def test_distinct_account_counter_does_not_double_count_subaccounts():
    store = ActiveDefenseRuntimeStore()

    assert store.record_login_403_account("198.51.100.1", "cyh6699", 60) == 1
    assert store.record_login_403_account("198.51.100.1", "cyh6699-1", 60) == 1
    assert store.record_login_403_account("198.51.100.1", "cyh6699-55", 60) == 1
    assert store.record_login_403_account("198.51.100.1", "other6699", 60) == 2
