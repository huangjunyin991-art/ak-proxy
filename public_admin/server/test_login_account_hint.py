from public_admin.server.login_account_hint import (
    account_similarity,
    find_best_account_match,
    normalize_login_account,
)


def test_normalize_login_account():
    assert normalize_login_account("  LjY574139 ") == "ljy574139"


def test_finds_single_character_typo_above_threshold():
    match = find_best_account_match("ljy574139", ["hjy574139"], threshold=0.90)
    assert match is not None
    assert match.account == "hjy574139"
    assert match.score >= 0.90


def test_ignores_low_similarity_candidates():
    match = find_best_account_match("ljy574139", ["admin0000", "abc12345"], threshold=0.90)
    assert match is None


def test_ignores_exact_match():
    match = find_best_account_match("ljy574139", ["ljy574139", "admin0000"], threshold=0.90)
    assert match is None


def test_exact_match_suppresses_other_similar_suggestions():
    match = find_best_account_match("ljy574139", ["ljy574139", "hjy574139"], threshold=0.90)
    assert match is None


def test_picks_best_match():
    match = find_best_account_match("ljy574139", ["lxy574130", "hjy574139"], threshold=0.90)
    assert match is not None
    assert match.account == "hjy574139"


def test_prefers_same_length_candidate_over_shorter_match():
    match = find_best_account_match("hjj574139", ["hj574139", "hjy574139"], threshold=0.90)
    assert match is not None
    assert match.account == "hjy574139"


def test_similarity_handles_insertions_but_stays_bounded():
    score = account_similarity("ljy574139", "ljy5741399")
    assert 0.90 <= score <= 1.0
