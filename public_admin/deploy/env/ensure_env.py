#!/usr/bin/env python3
"""
AK-Proxy 环境变量自动生成与补齐脚本

功能：读取现有 /etc/ak-proxy/ak-proxy.env（如不存在则创建），自动生成缺失的密钥与配置项，
      以追加方式写回，绝不覆盖已有值。可重复执行。

用法（推荐 - 自动找默认路径）：
    cd /path/to/ak-proxy
    python public_admin/deploy/env/ensure_env.py

显式指定路径：
    python public_admin/deploy/env/ensure_env.py --env-file /etc/ak-proxy/ak-proxy.env

Dry-run（只打印缺项，不写入）：
    python public_admin/deploy/env/ensure_env.py --dry-run

与 systemd 集成（systemd ExecStartPre）：
    ExecStartPre=/path/to/venv/bin/python /path/to/ak-proxy/public_admin/deploy/env/ensure_env.py
"""

from __future__ import annotations

import argparse
import base64
import os
import re
import secrets
import stat
import sys


# ---------------------------------------------------------------------------
# Env file management
# ---------------------------------------------------------------------------

class EnvFile:
    """读写并原子写回 env 文件（不覆盖已有值，只追加缺失项）。"""

    def __init__(self, path: str):
        self.path = path
        self.vars: dict[str, str] = {}  # key -> value (unquoted)
        self._load()

    def _load(self) -> None:
        if not os.path.isfile(self.path):
            return
        for line in open(self.path, encoding="utf-8"):
            line = line.rstrip("\n\r")
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
            if m:
                self.vars[m.group(1)] = m.group(2).strip()

    def get(self, key: str, default: str = "") -> str:
        return self.vars.get(key, default)

    def has(self, key: str) -> bool:
        """Return True if key exists (even if value is empty)."""
        return key in self.vars

    def upsert(self, key: str, value: str) -> bool:
        """Set value only if key is missing. Returns True if was set."""
        if key in self.vars:
            return False
        self.vars[key] = value
        return True

    def save(self, quiet: bool = False) -> list[str]:
        """
        Write back to file atomically.
        Returns list of keys that were added/updated.
        """
        if not self.vars and not os.path.exists(self.path):
            return []

        lines: list[str] = []
        changed: list[str] = []

        # Preserve existing content order and comments
        if os.path.isfile(self.path):
            for line in open(self.path, encoding="utf-8"):
                stripped = line.rstrip("\n\r")
                m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", stripped)
                if m and m.group(1) in self.vars:
                    # Preserve existing key/value as-is (never overwrite)
                    lines.append(stripped)
                    del self.vars[m.group(1)]
                else:
                    lines.append(stripped)

        # Append newly added vars (sorted for readability)
        for key in sorted(self.vars):
            val = self.vars[key]
            # Quote value if it contains special chars or is empty
            needs_quotes = not val or " " in val or '"' in val or "'" in val or "\n" in val
            if needs_quotes:
                val_quoted = '"' + val.replace("\\", "\\\\").replace('"', '\\"') + '"'
            else:
                val_quoted = val
            lines.append(f'{key}={val_quoted}')
            changed.append(key)

        if changed:
            content = "\n".join(lines) + "\n"
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(content)
            os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
            os.replace(tmp, self.path)

        if not quiet and changed:
            print(f"[ensure_env] Written to {self.path}: {', '.join(changed)}")
        return changed


# ---------------------------------------------------------------------------
# Secret generators
# ---------------------------------------------------------------------------

def generate_secret(length: int = 48) -> str:
    """Generate a cryptographically random hex string."""
    return secrets.token_hex(length)


def _generate_vapid_keypair() -> tuple[str, str]:
    """
    Generate a VAPID key pair using the cryptography library (P-256 ECDSA).
    Returns (public_key_b64url, private_key_b64url).
    Raises ImportError if cryptography is unavailable.
    """
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization

    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()

    # private: base64url, no headers
    private_bytes = private_key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    private_b64url = base64.urlsafe_b64encode(
        base64.b64decode(base64.b64encode(private_bytes))
    ).rstrip(b"=").decode("ascii")

    # public: base64url, no headers
    public_bytes = public_key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    public_b64url = base64.urlsafe_b64encode(
        base64.b64decode(base64.b64encode(public_bytes))
    ).rstrip(b"=").decode("ascii")

    return public_b64url, private_b64url


# ---------------------------------------------------------------------------
# Variable definitions
# ---------------------------------------------------------------------------

# Each entry: (key, generator_func_or_value, category)
# generator_func_or_value: callable() or a string
CATEGORY_NOTIFY = "notify_center"
CATEGORY_SECRET = "secret"
CATEGORY_SWITCH = "switch"
CATEGORY_OPTIONAL = "optional"


def _gen_nothing() -> str:
    return ""


VARS: list[tuple[str, callable, str]] = [
    # Notify Center
    (
        "NOTIFY_CENTER_ENABLED",
        lambda: "1",
        CATEGORY_SWITCH,
    ),
    (
        "NOTIFY_CENTER_INTERNAL_SECRET",
        lambda: generate_secret(32),
        CATEGORY_SECRET,
    ),
    (
        "WEB_PUSH_VAPID_PUBLIC_KEY",
        lambda: _generate_vapid_keypair()[0],
        CATEGORY_NOTIFY,
    ),
    (
        "WEB_PUSH_VAPID_PRIVATE_KEY",
        lambda: _generate_vapid_keypair()[1],
        CATEGORY_NOTIFY,
    ),
    (
        "WEB_PUSH_VAPID_SUBJECT",
        lambda: "mailto:admin@ak2025.vip",
        CATEGORY_NOTIFY,
    ),
    # These use sensible defaults - only generate if the whole notify block is missing
    (
        "NOTIFY_CENTER_PUBLIC_BASE_URL",
        lambda: os.environ.get("NOTIFY_CENTER_PUBLIC_BASE_URL", ""),
        CATEGORY_OPTIONAL,
    ),
    (
        "NOTIFY_CENTER_WORKER_INTERVAL_SECONDS",
        lambda: "5",
        CATEGORY_OPTIONAL,
    ),
    (
        "NOTIFY_CENTER_NTFY_DEFAULT_SERVER_URL",
        lambda: "https://ntfy.ak2025.vip",
        CATEGORY_OPTIONAL,
    ),
    (
        "NOTIFY_CENTER_SHOW_MESSAGE_PREVIEW",
        lambda: "0",
        CATEGORY_OPTIONAL,
    ),
]


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def ensure_env(env_path: str, dry_run: bool = False) -> None:
    env = EnvFile(env_path)

    os.makedirs(os.path.dirname(env_path), exist_ok=True)

    # Ensure file exists (empty is fine, we only append)
    if not os.path.exists(env_path):
        open(env_path, "a", encoding="utf-8").close()
        os.chmod(env_path, stat.S_IRUSR | stat.S_IWUSR)

    added: list[tuple[str, str, str]] = []

    for key, gen, category in VARS:
        if env.has(key):
            continue

        value = gen()
        if not value:
            # Generator returned empty - skip
            continue

        if dry_run:
            print(f"[dry-run] would add   {key}  ({category})")
        else:
            env.upsert(key, value)
            added.append((key, value, category))

    if dry_run:
        if not added:
            print("[dry-run] no missing variables found (file is complete)")
        return

    if not added:
        print(f"[ensure_env] {env_path} is already complete, nothing to generate")
        return

    changed = env.save()

    # Print summary (never print secret values, only categories)
    by_category: dict[str, list[str]] = {}
    for key, _, category in added:
        by_category.setdefault(category, []).append(key)

    for cat in sorted(by_category):
        print(f"[ensure_env] added ({cat}): {', '.join(sorted(by_category[cat]))}")

    print("[ensure_env] Done. Restart ak-proxy.service to load new variables:")
    print(f"            sudo systemctl restart ak-proxy")


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Auto-generate missing environment variables for ak-proxy.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--env-file",
        default="/etc/ak-proxy/ak-proxy.env",
        help="Path to env file (default: /etc/ak-proxy/ak-proxy.env)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be generated without writing to disk",
    )
    args = parser.parse_args()

    try:
        ensure_env(args.env_file, dry_run=args.dry_run)
    except Exception as e:
        print(f"[ensure_env] ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
