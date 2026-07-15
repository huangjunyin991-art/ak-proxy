#!/usr/bin/env python3
"""Prepare required deployment secrets before starting the AK Proxy process."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path


_AUTO_SELL_PRIVATE_KEY_ENV = "LICENSE_AUTO_SELL_SIGNING_PRIVATE_KEY"
_DEFAULT_ENV_FILE = "/etc/ak-proxy.env"
_ENV_LINE_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")


def read_env_values(path: Path) -> dict[str, str]:
    """Read simple EnvironmentFile values without evaluating their content as shell."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    values: dict[str, str] = {}
    for line in lines:
        match = _ENV_LINE_RE.match(line.strip())
        if not match:
            continue
        value = match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[match.group(1)] = value
    return values


def read_env_value(path: Path, key: str) -> str:
    return read_env_values(path).get(key, "")


def main() -> int:
    repo_dir = Path(__file__).resolve().parents[2]
    env_file = Path(os.environ.get("AK_PROXY_ENV_FILE") or _DEFAULT_ENV_FILE)
    ensure_env = repo_dir / "public_admin" / "deploy" / "env" / "ensure_env.py"

    subprocess.run(
        [sys.executable, "-B", str(ensure_env), "--env-file", str(env_file)],
        check=True,
    )
    generated_values = read_env_values(env_file)
    for key, value in generated_values.items():
        os.environ.setdefault(key, value)
    private_key = generated_values.get(_AUTO_SELL_PRIVATE_KEY_ENV, "")
    if not private_key:
        print(
            f"[ak-proxy-bootstrap] {_AUTO_SELL_PRIVATE_KEY_ENV} is missing or empty after initialization",
            file=sys.stderr,
        )
        return 1

    os.environ[_AUTO_SELL_PRIVATE_KEY_ENV] = private_key
    os.execv(sys.executable, [sys.executable, "-m", "public_admin.server.proxy_server"])
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
