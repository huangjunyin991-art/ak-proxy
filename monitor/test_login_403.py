"""
测试脚本：快速反复登录同一账号，检测是否触发403
直接请求上游API（不经过代理服务器），模拟真实场景

用法: python test_login_403.py [次数] [间隔秒]
默认: 20次, 间隔1秒
"""
import httpx
import time
import sys

AKAPI_URL = "https://www.akapi1.com/RPC/Login"

# 测试账号（随意填写，不需要真实密码，只看是否403）
TEST_ACCOUNT = "hjy574139"
TEST_PASSWORD = "Hjy411334"y


def test_rapid_login(count=20, interval=1.0):
    print(f"=" * 60)
    print(f"403 触发测试")
    print(f"目标: {AKAPI_URL}")
    print(f"次数: {count}, 间隔: {interval}s")
    print(f"=" * 60)
    
    results = {"200": 0, "403": 0, "other": 0, "error": 0}
    
    for i in range(1, count + 1):
        t0 = time.time()
        try:
            with httpx.Client(verify=False, timeout=10) as client:
                resp = client.post(AKAPI_URL, json={
                    "account": TEST_ACCOUNT,
                    "password": TEST_PASSWORD,
                })
            elapsed = (time.time() - t0) * 1000
            status = resp.status_code
            
            if status == 403:
                results["403"] += 1
                print(f"  [{i:>3}/{count}] ❌ 403 BLOCKED  ({elapsed:.0f}ms)")
            elif status == 200:
                results["200"] += 1
                # 尝试解析响应
                try:
                    body = resp.json()
                    error = body.get("Error", "?")
                    print(f"  [{i:>3}/{count}] ✅ 200 OK  Error={error}  ({elapsed:.0f}ms)")
                except:
                    print(f"  [{i:>3}/{count}] ✅ 200 OK  (non-json)  ({elapsed:.0f}ms)")
            else:
                results["other"] += 1
                print(f"  [{i:>3}/{count}] ⚠️  {status}  ({elapsed:.0f}ms)")
                
        except Exception as e:
            results["error"] += 1
            elapsed = (time.time() - t0) * 1000
            print(f"  [{i:>3}/{count}] 💥 ERROR: {e}  ({elapsed:.0f}ms)")
        
        if i < count:
            time.sleep(interval)
    
    print(f"\n{'=' * 60}")
    print(f"结果汇总:")
    print(f"  200 OK:    {results['200']}")
    print(f"  403 封禁:  {results['403']}")
    print(f"  其他状态:  {results['other']}")
    print(f"  连接错误:  {results['error']}")
    print(f"{'=' * 60}")
    
    if results["403"] > 0:
        print(f"\n⚠️  在 {count} 次请求中触发了 {results['403']} 次 403！")
        print(f"   首次403出现在约第 {results['200'] + 1} 次请求")
    else:
        print(f"\n✅ {count} 次请求全部通过，未触发403")


if __name__ == "__main__":
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    interval = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
    
    print(f"\n⚠️  此测试将直接向上游API发送 {count} 次Login请求")
    print(f"   间隔 {interval} 秒，总耗时约 {count * interval:.0f} 秒")
    confirm = input("   确认执行? (y/N): ").strip().lower()
    if confirm != 'y':
        print("已取消")
        sys.exit(0)
    
    print()
    test_rapid_login(count, interval)
