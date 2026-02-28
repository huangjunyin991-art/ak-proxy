"""
截流 ak2018.vip 助记词页面及所有引用的资源
"""
import os
import re
import httpx
from urllib.parse import urljoin, urlparse

BASE = "https://ak2018.vip"
PAGES = [
    "/pages/center/security/mnemonic.cn.html?from=first&url=https%3A%2F%2Fak2018.vip%2F",
    "/pages/account/login.html",
]
SAVE_DIR = os.path.join(os.path.dirname(__file__), "files")
os.makedirs(SAVE_DIR, exist_ok=True)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
}

downloaded = set()

def safe_fn(url):
    p = urlparse(url)
    path = p.path.strip("/").replace("/", "_")
    if p.query:
        q = p.query.replace("&", "_").replace("=", "-").replace("%", "")
        path += "__" + q[:80]
    return path or "index.html"

def dl(url, label=""):
    if url in downloaded:
        return None
    downloaded.add(url)
    try:
        with httpx.Client(verify=False, timeout=15, follow_redirects=True, headers=HEADERS) as c:
            r = c.get(url)
            fn = safe_fn(url)
            fp = os.path.join(SAVE_DIR, fn)
            ct = r.headers.get("content-type", "")
            is_text = any(t in ct for t in ["text", "javascript", "json", "xml", "css"])
            with open(fp, "w" if is_text else "wb", encoding="utf-8" if is_text else None) as f:
                f.write(r.text if is_text else r.content)
            print(f"  [{label:>5}] {r.status_code} {len(r.content):>8}B  {fn}")
            return r.text if is_text else None
    except Exception as e:
        print(f"  [{label:>5}] ERR  {url} -> {e}")
        return None

def extract(html, base_url):
    urls = []
    for m in re.finditer(r'(?:href|src)=["\']([^"\']+\.(?:css|js|json|png|jpg|svg|ico)[^"\']*)["\']', html):
        urls.append(urljoin(base_url, m.group(1)))
    return urls

print("=" * 70)
for page_path in PAGES:
    page_url = BASE + page_path
    print(f"\n>>> {page_url[:80]}...")
    html = dl(page_url, "HTML")
    if html:
        refs = extract(html, BASE + "/".join(page_path.split("/")[:-1]) + "/")
        print(f"    发现 {len(refs)} 个资源引用")
        for ref_url in refs:
            content = dl(ref_url, "RES")
            if content:
                # 搜索域名引用
                for d in set(re.findall(r'(?:https?://)?(?:www\.)?ak(?:api[13]|2018|2025|2026)\.(?:com|vip)', content)):
                    print(f"      -> 域名: {d}")
                # 搜索 window.location 跳转
                for m in re.finditer(r'window\.location\s*=\s*["\']([^"\']+)["\']', content):
                    print(f"      -> 跳转: {m.group(1)}")

print(f"\n{'=' * 70}")
print(f"共下载 {len(downloaded)} 个文件")
print(f"{'=' * 70}")

# 汇总所有文件中的域名引用
print("\n>>> 所有文件域名引用汇总:")
for fn in os.listdir(SAVE_DIR):
    fp = os.path.join(SAVE_DIR, fn)
    try:
        with open(fp, "r", encoding="utf-8") as f:
            text = f.read()
        domains = set(re.findall(r'(?:https?://)?(?:www\.)?ak(?:api[13]|2018|2025|2026)\.(?:com|vip)[^\s"\'<>]*', text))
        if domains:
            print(f"  {fn}:")
            for d in sorted(domains):
                print(f"    {d}")
    except:
        pass
