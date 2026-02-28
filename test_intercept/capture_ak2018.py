"""
截流 ak2018.vip 首页及所有引用的资源文件
保存到 test_intercept/files/ 目录
"""
import os
import re
import httpx
from urllib.parse import urljoin, urlparse

BASE_URL = "https://ak2018.vip"
SAVE_DIR = os.path.join(os.path.dirname(__file__), "files")
os.makedirs(SAVE_DIR, exist_ok=True)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

downloaded = set()

def safe_filename(url):
    parsed = urlparse(url)
    path = parsed.path.strip("/").replace("/", "_")
    if parsed.query:
        path += "_" + parsed.query.replace("&", "_").replace("=", "-")
    if not path:
        path = "index.html"
    return path

def download(url, label=""):
    if url in downloaded:
        return None
    downloaded.add(url)
    
    try:
        with httpx.Client(verify=False, timeout=15, follow_redirects=True, headers=HEADERS) as client:
            resp = client.get(url)
            filename = safe_filename(url)
            filepath = os.path.join(SAVE_DIR, filename)
            
            content_type = resp.headers.get("content-type", "")
            is_text = any(t in content_type for t in ["text", "javascript", "json", "xml", "css"])
            
            if is_text:
                with open(filepath, "w", encoding="utf-8") as f:
                    f.write(resp.text)
            else:
                with open(filepath, "wb") as f:
                    f.write(resp.content)
            
            size = len(resp.content)
            print(f"  [{label}] {resp.status_code} {size:>8}B  {filename}")
            return resp.text if is_text else None
    except Exception as e:
        print(f"  [{label}] ERROR: {url} -> {e}")
        return None

def extract_resources(html, base_url):
    """从HTML中提取所有引用的资源URL"""
    urls = []
    # CSS: href="xxx.css"
    for m in re.finditer(r'href=["\']([^"\']+\.css[^"\']*)["\']', html):
        urls.append(("CSS", urljoin(base_url, m.group(1))))
    # JS: src="xxx.js"
    for m in re.finditer(r'src=["\']([^"\']+\.js[^"\']*)["\']', html):
        urls.append(("JS", urljoin(base_url, m.group(1))))
    # Images
    for m in re.finditer(r'(?:src|href)=["\']([^"\']+\.(?:png|jpg|jpeg|gif|svg|ico)[^"\']*)["\']', html):
        urls.append(("IMG", urljoin(base_url, m.group(1))))
    # JSON
    for m in re.finditer(r'(?:src|href)=["\']([^"\']+\.json[^"\']*)["\']', html):
        urls.append(("JSON", urljoin(base_url, m.group(1))))
    return urls

print("=" * 60)
print(f"截流 {BASE_URL}")
print("=" * 60)

# 1. 下载首页
print("\n[1] 下载首页...")
html = download(BASE_URL, "HTML")

if html:
    # 2. 提取并下载所有资源
    resources = extract_resources(html, BASE_URL + "/")
    print(f"\n[2] 发现 {len(resources)} 个资源，开始下载...")
    
    for label, url in resources:
        content = download(url, label)
        # 递归提取JS中引用的其他资源
        if content and label == "JS":
            # 查找JS中的API地址和域名引用
            for domain in re.findall(r'(?:https?://)?(?:www\.)?ak(?:api[13]|2018)\.(?:com|vip)[^\s"\'<>]*', content):
                print(f"    -> JS中发现域名引用: {domain}")

print(f"\n{'=' * 60}")
print(f"完成！共下载 {len(downloaded)} 个文件到 {SAVE_DIR}")
print(f"{'=' * 60}")
