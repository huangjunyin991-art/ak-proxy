# -*- coding: utf-8 -*-
"""High-confidence account typo suggestions for the public login page."""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Iterable, Optional


DEFAULT_ACCOUNT_HINT_THRESHOLD = 0.90
MIN_ACCOUNT_HINT_LENGTH = 4
MAX_ACCOUNT_HINT_LENGTH = 64


@dataclass(frozen=True)
class AccountHintMatch:
    account: str
    score: float


def _account_match_rank(typed: str, candidate: str, score: float) -> tuple[int, int, float]:
    length_gap = abs(len(candidate) - len(typed))
    return (
        0 if length_gap == 0 else 1,
        length_gap,
        -score,
    )


def normalize_login_account(value: object) -> str:
    return str(value or "").strip().lower()


def jaro_similarity(left: str, right: str) -> float:
    left = normalize_login_account(left)
    right = normalize_login_account(right)
    if left == right:
        return 1.0
    if not left or not right:
        return 0.0

    left_len = len(left)
    right_len = len(right)
    match_distance = max(left_len, right_len) // 2 - 1
    match_distance = max(0, match_distance)
    left_matches = [False] * left_len
    right_matches = [False] * right_len

    matches = 0
    for left_index, left_char in enumerate(left):
        start = max(0, left_index - match_distance)
        end = min(left_index + match_distance + 1, right_len)
        for right_index in range(start, end):
            if right_matches[right_index] or left_char != right[right_index]:
                continue
            left_matches[left_index] = True
            right_matches[right_index] = True
            matches += 1
            break

    if matches == 0:
        return 0.0

    transpositions = 0
    right_index = 0
    for left_index, left_matched in enumerate(left_matches):
        if not left_matched:
            continue
        while right_index < right_len and not right_matches[right_index]:
            right_index += 1
        if right_index < right_len and left[left_index] != right[right_index]:
            transpositions += 1
        right_index += 1

    return (
        matches / left_len
        + matches / right_len
        + (matches - transpositions / 2) / matches
    ) / 3


def account_similarity(left: str, right: str) -> float:
    left = normalize_login_account(left)
    right = normalize_login_account(right)
    if left == right:
        return 1.0
    if not left or not right:
        return 0.0
    return max(
        SequenceMatcher(None, left, right).ratio(),
        jaro_similarity(left, right),
    )


def find_best_account_match(
    typed_account: str,
    candidate_accounts: Iterable[object],
    threshold: float = DEFAULT_ACCOUNT_HINT_THRESHOLD,
) -> Optional[AccountHintMatch]:
    typed = normalize_login_account(typed_account)
    if len(typed) < MIN_ACCOUNT_HINT_LENGTH or len(typed) > MAX_ACCOUNT_HINT_LENGTH:
        return None

    best: Optional[AccountHintMatch] = None
    best_rank: Optional[tuple[int, int, float]] = None
    seen: set[str] = set()
    candidates: list[str] = []
    for candidate_value in candidate_accounts:
        candidate = normalize_login_account(candidate_value)
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        candidates.append(candidate)

    if typed in seen:
        return None

    for candidate in candidates:
        score = account_similarity(typed, candidate)
        if score < threshold:
            continue
        rank = _account_match_rank(typed, candidate, score)
        if best is None or best_rank is None or rank < best_rank:
            best = AccountHintMatch(account=candidate, score=score)
            best_rank = rank
    return best
