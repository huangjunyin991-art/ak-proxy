# -*- coding: utf-8 -*-
"""403触发测试: 随机间隔2~8秒连续登录, 观察403触发条件"""
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

import httpx
import time

# ===== 配置 =====
TARGET_URL = "https://www.akapi1.com/RPC/Login"
ACCOUNT = "cyh6699-80"
PASSWORD = "Csq411334"
import random
ACCOUNTS = [f"cyh6699-{i}" for i in range(80, 120)]  # 40个子账号
BURST_COUNT = 15  # 1分钟内发15个(超过10个看反应)


def do_login(client, account):
    """发一次登录请求"""
    resp = client.post(
        TARGET_URL,
        data={"account": account, "password": PASSWORD},
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        timeout=10
    )
    return resp.status_code, resp.text[:100]


def countdown(seconds, label):
    """倒计时显示"""
    for remaining in range(seconds, 0, -1):
        mins, secs = divmod(remaining, 60)
        sys.stdout.write(f"\r  {label} {mins:02d}:{secs:02d} ")
        sys.stdout.flush()
        time.sleep(1)
    sys.stdout.write(f"\r  {label} 00:00 - 完成!\n")
    sys.stdout.flush()




def main():
    print("=" * 60)
    print("  403 触发机制测试 (1分钟内登录15个号)")
    print(f"  目标: {TARGET_URL}")
    print(f"  账号: {len(ACCOUNTS)}个子账号")
    print(f"  策略: 60秒内发{BURST_COUNT}次登录, 随机间隔, 观察哪个触发403")
    print(f"  目的: 判断是硬性速率限制(N次/分) 还是滑动窗口")
    print("=" * 60)

    # 复用TCP连接, 走本地代理
    proxy = "http://127.0.0.1:7897"
    print(f"  代理: {proxy}")
    client = httpx.Client(verify=False, proxy=proxy, timeout=10)

    # 生成15个随机时间点在60秒内
    slots = sorted([random.uniform(0, 55) for _ in range(BURST_COUNT)])
    print(f"\n  计划时间点: {', '.join(f'{s:.1f}s' for s in slots)}")
    print(f"  平均间隔: {55/BURST_COUNT:.1f}s\n")

    logs = []
    start_time = time.time()

    for j, target_sec in enumerate(slots):
        account = ACCOUNTS[j % len(ACCOUNTS)]

        # 等待到目标时间点
        now = time.time() - start_time
        wait = target_sec - now
        if wait > 0:
            for remaining_10th in range(int(wait * 10), 0, -1):
                r_sec = remaining_10th / 10
                sys.stdout.write(f"\r  [{j+1}/{BURST_COUNT}] 等待: {r_sec:.1f}s  ")
                sys.stdout.flush()
                time.sleep(0.1)
            sys.stdout.write(f"\r{' '*40}\r")
            sys.stdout.flush()

        # 发送请求
        elapsed = round(time.time() - start_time, 1)
        try:
            status, body = do_login(client, account)
            short = body[:40].replace('\n', '')
            logs.append((j+1, account, elapsed, status))

            tag = "\u274c 403" if status == 403 else ("\u2705 200" if status == 200 else f"\u2753 {status}")
            print(f"  [{j+1:2d}/{BURST_COUNT}] +{elapsed:5.1f}s | {account:14s} | {tag}")
        except Exception as e:
            logs.append((j+1, account, elapsed, 0))
            print(f"  [{j+1:2d}/{BURST_COUNT}] +{elapsed:5.1f}s | {account:14s} | \U0001f4a5 {str(e)[:30]}")

    # 结果分析
    total_time = round(time.time() - start_time, 1)
    ok_count = sum(1 for l in logs if l[3] == 200)
    err_count = sum(1 for l in logs if l[3] == 403)
    other = len(logs) - ok_count - err_count

    print(f"\n{'='*60}")
    print(f"  结果 (总耗时 {total_time}s)")
    print(f"{'='*60}")
    print(f"  \u2705 成功: {ok_count}")
    print(f"  \u274c 403:  {err_count}")
    if other: print(f"  \U0001f4a5 其他: {other}")

    if err_count > 0:
        first_403 = next(l for l in logs if l[3] == 403)
        print(f"\n  \U0001f4ca 第{first_403[0]}个请求触发403 (+{first_403[2]}s)")
        print(f"  \U0001f4ca 403前成功 {first_403[0]-1} 次")
        # 分析: 403后的请求是否全部403?
        after_403 = [l for l in logs if l[0] > first_403[0]]
        after_ok = sum(1 for l in after_403 if l[3] == 200)
        after_fail = sum(1 for l in after_403 if l[3] == 403)
        if after_403:
            print(f"  \U0001f4ca 403后继续发{len(after_403)}个: {after_ok}成功/{after_fail}失败")
            if after_ok > 0:
                print(f"  >> \U0001f4a1 判断: 滑动窗口限制 (部分后续请求恢复)")
            else:
                print(f"  >> \U0001f4a1 判断: 硬性限制 (403后全部封禁)")
    else:
        print(f"\n  \U0001f389 {BURST_COUNT}次/分钟 全部通过! 阈值 > {BURST_COUNT}")

    client.close()


if __name__ == "__main__":
    main()
