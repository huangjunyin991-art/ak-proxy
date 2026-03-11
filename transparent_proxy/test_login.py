# -*- coding: utf-8 -*-
"""并发登录压测脚本 - 测试负载均衡是否正常"""
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

import asyncio
import httpx
import time
import json

# ===== 配置 =====
BASE_URL = "https://ak2026.vip"
ACCOUNTS = [f"cyh6699-{i}" for i in range(80, 116)]  # cyh6699-80 ~ cyh6699-115
PASSWORD = "Csq411334"
CONCURRENCY = 5  # 并发线程数

# ===== 统计 =====
results = {"success": 0, "auth_fail": 0, "error_403": 0, "other_error": 0, "details": []}


async def login(client: httpx.AsyncClient, account: str, sem: asyncio.Semaphore):
    """单个登录请求"""
    async with sem:
        start = time.time()
        try:
            resp = await client.post(
                f"{BASE_URL}/RPC/Login",
                data={"account": account, "password": PASSWORD},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=15
            )
            elapsed = round(time.time() - start, 2)
            status = resp.status_code
            try:
                data = resp.json()
            except Exception:
                data = {"raw": resp.text[:200]}

            detail = {
                "account": account,
                "status": status,
                "time": elapsed,
                "result": "?" 
            }

            if status == 403:
                results["error_403"] += 1
                detail["result"] = "❌ 403 Forbidden"
                print(f"  ❌ {account}: 403 Forbidden ({elapsed}s)")
            elif status == 200:
                error = data.get("Error", True)
                msg = data.get("Msg", "")
                if "未获得访问权限" in str(msg) or "已到期" in str(msg):
                    results["auth_fail"] += 1
                    detail["result"] = f"🚫 白名单拦截: {msg}"
                    print(f"  🚫 {account}: {msg} ({elapsed}s)")
                elif not error:
                    results["success"] += 1
                    detail["result"] = "✅ 登录成功"
                    print(f"  ✅ {account}: 登录成功 ({elapsed}s)")
                else:
                    results["other_error"] += 1
                    detail["result"] = f"⚠️ {msg or data}"
                    print(f"  ⚠️ {account}: {msg or data} ({elapsed}s)")
            else:
                results["other_error"] += 1
                detail["result"] = f"HTTP {status}"
                print(f"  ❓ {account}: HTTP {status} ({elapsed}s)")

            results["details"].append(detail)

        except Exception as e:
            elapsed = round(time.time() - start, 2)
            results["other_error"] += 1
            results["details"].append({
                "account": account, "status": 0, "time": elapsed,
                "result": f"💥 异常: {e}"
            })
            print(f"  💥 {account}: {e} ({elapsed}s)")


async def check_dispatcher_status(client: httpx.AsyncClient):
    """查看dispatcher状态"""
    try:
        resp = await client.get(f"{BASE_URL}/api/dispatcher", timeout=10)
        data = resp.json()
        print("\n📊 Dispatcher 状态:")
        for ex in data.get("exits", []):
            limit_str = f"{ex.get('rate_limit', 0)}/min" if ex.get('rate_limit', 0) > 0 else "不限速"
            print(f"  [{ex['index']}] {ex['name']:20s} | "
                  f"健康={'✅' if ex['healthy'] else '❌'} | "
                  f"IP={ex.get('exit_ip', '?'):15s} | "
                  f"并发={ex['active']:2d} | "
                  f"请求={ex['total_requests']:4d} | "
                  f"RPM={ex.get('rpm', 0):3d} | "
                  f"限速={limit_str} | "
                  f"403={ex['warn_403']}")
    except Exception as e:
        print(f"  获取状态失败: {e}")


async def main():
    print(f"🚀 并发登录压测")
    print(f"   目标: {BASE_URL}")
    print(f"   账号: cyh6699-80 ~ cyh6699-100 ({len(ACCOUNTS)}个)")
    print(f"   并发: {CONCURRENCY}")
    print(f"{'='*60}")

    async with httpx.AsyncClient(verify=False) as client:
        # 测试前状态
        await check_dispatcher_status(client)

        print(f"\n🔄 开始登录测试...")
        start_all = time.time()
        sem = asyncio.Semaphore(CONCURRENCY)
        tasks = [login(client, acc, sem) for acc in ACCOUNTS]
        await asyncio.gather(*tasks)
        total_time = round(time.time() - start_all, 2)

        # 结果汇总
        print(f"\n{'='*60}")
        print(f"📋 测试结果 (耗时 {total_time}s):")
        print(f"   ✅ 成功: {results['success']}")
        print(f"   🚫 白名单拦截: {results['auth_fail']}")
        print(f"   ❌ 403错误: {results['error_403']}")
        print(f"   ⚠️ 其他错误: {results['other_error']}")

        if results['error_403'] > 0:
            print(f"\n   ⚠️ 出现了 {results['error_403']} 次403, 负载均衡可能不够分散!")
        else:
            print(f"\n   🎉 没有403! 负载均衡正常工作!")

        # 测试后状态
        await check_dispatcher_status(client)


if __name__ == "__main__":
    asyncio.run(main())
