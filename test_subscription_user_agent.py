import argparse
import base64
import json
import ssl
import sys
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "public_admin"))

from sub_parser import parse_subscription_text

UA_CASES = [
    ("none", None),
    ("chrome", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"),
    ("clash", "ClashForWindows/0.20.39 (Windows NT 10.0; Win64; x64)"),
    ("sing-box", "sing-box/1.10.0"),
]


def try_base64_decode(text: str) -> str:
    raw = text.strip()
    if not raw:
        return ""
    padding = (-len(raw)) % 4
    padded = raw + ("=" * padding)
    decoders = [base64.b64decode, base64.urlsafe_b64decode]
    for decoder in decoders:
        try:
            decoded = decoder(padded).decode("utf-8")
        except Exception:
            continue
        if "://" in decoded or "proxies:" in decoded or "outbounds" in decoded:
            return decoded
    return ""


def classify_response(raw: str) -> str:
    stripped = raw.lstrip()
    if not stripped:
        return "empty"
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            json.loads(stripped)
            return "json"
        except Exception:
            return "text"
    if stripped.startswith("mixed-port:") or "\nproxies:" in stripped or stripped.startswith("proxies:"):
        return "clash_yaml"
    decoded = try_base64_decode(raw)
    if decoded:
        if decoded.lstrip().startswith("{") or decoded.lstrip().startswith("["):
            return "base64_json"
        if "://" in decoded:
            return "base64_proxy_links"
        if "proxies:" in decoded:
            return "base64_clash_yaml"
        return "base64_text"
    return "text"


def fetch_text(url: str, user_agent: str | None, timeout: int) -> str:
    ctx = ssl._create_unverified_context()
    headers = {"Accept": "*/*"}
    if user_agent:
        headers["User-Agent"] = user_agent
    req = Request(url, headers=headers)
    with urlopen(req, context=ctx, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace").strip()


def run_case(url: str, label: str, user_agent: str | None, timeout: int) -> dict:
    raw = fetch_text(url, user_agent, timeout)
    parsed = parse_subscription_text(raw)
    nodes = parsed.get("nodes") or []
    first_node = nodes[0] if nodes else {}
    return {
        "label": label,
        "user_agent": user_agent or "<none>",
        "raw_length": len(raw),
        "response_kind": classify_response(raw),
        "parse_format": parsed.get("format"),
        "total_nodes": parsed.get("total_nodes", 0),
        "unique_servers": parsed.get("unique_servers", 0),
        "prefix": raw[:120],
        "first_node": {
            "name": first_node.get("name", "") if isinstance(first_node, dict) else "",
            "type": first_node.get("type", "") if isinstance(first_node, dict) else "",
            "server": first_node.get("server", "") if isinstance(first_node, dict) else "",
            "port": first_node.get("port", "") if isinstance(first_node, dict) else "",
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--timeout", type=int, default=15)
    args = parser.parse_args()

    results = []
    for label, user_agent in UA_CASES:
        try:
            results.append(run_case(args.url, label, user_agent, args.timeout))
        except Exception as exc:
            results.append({
                "label": label,
                "user_agent": user_agent or "<none>",
                "error": str(exc),
            })

    for item in results:
        print("=" * 72)
        print(f"label: {item['label']}")
        print(f"user_agent: {item['user_agent']}")
        if item.get("error"):
            print(f"error: {item['error']}")
            continue
        print(f"raw_length: {item['raw_length']}")
        print(f"response_kind: {item['response_kind']}")
        print(f"parse_format: {item['parse_format']}")
        print(f"total_nodes: {item['total_nodes']}")
        print(f"unique_servers: {item['unique_servers']}")
        print(f"prefix: {item['prefix']!r}")
        first_node = item.get("first_node") or {}
        print(f"first_node: {json.dumps(first_node, ensure_ascii=True)}")

    usable = [item for item in results if not item.get("error") and int(item.get("total_nodes", 0)) > 0]
    print("=" * 72)
    if usable:
        usable.sort(key=lambda item: (int(item.get("total_nodes", 0)), int(item.get("unique_servers", 0))), reverse=True)
        best = usable[0]
        print(f"recommended_label: {best['label']}")
        print(f"recommended_user_agent: {best['user_agent']}")
        print(f"recommended_total_nodes: {best['total_nodes']}")
        print(f"recommended_unique_servers: {best['unique_servers']}")
    else:
        print("recommended_label: <none>")
        print("recommended_user_agent: <none>")
        print("recommended_total_nodes: 0")
        print("recommended_unique_servers: 0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
