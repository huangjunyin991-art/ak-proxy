import httpx

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
}

URL = "https://ak928.vip/pages/account/login.html"

with httpx.Client(verify=False, follow_redirects=True, timeout=15) as c:
    r = c.get(URL, headers=HEADERS)
    print(f"Status: {r.status_code}")
    print(f"Final URL: {r.url}")
    print(f"Content-Type: {r.headers.get('content-type', '')}")
    print(f"Content length: {len(r.content)}")
    print(f"First 800 chars:\n{r.content[:800]}")
