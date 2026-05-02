import os
import platform
import shutil
import time
from datetime import datetime, timezone

_STARTED_AT = time.time()
_LAST_CPU_SAMPLE = None

try:
    import psutil
except Exception:
    psutil = None


def _bytes_to_int(value) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def _get_load_average() -> dict:
    if not hasattr(os, "getloadavg"):
        return {"available": False, "load1": None, "load5": None, "load15": None}
    try:
        load1, load5, load15 = os.getloadavg()
        return {"available": True, "load1": load1, "load5": load5, "load15": load15}
    except Exception:
        return {"available": False, "load1": None, "load5": None, "load15": None}


def _read_proc_cpu_sample():
    try:
        with open("/proc/stat", "r", encoding="utf-8") as f:
            first = f.readline().strip().split()
        if not first or first[0] != "cpu":
            return None
        values = [int(float(item)) for item in first[1:]]
        idle = values[3] + (values[4] if len(values) > 4 else 0)
        total = sum(values)
        return total, idle
    except Exception:
        return None


def _fallback_cpu_percent():
    global _LAST_CPU_SAMPLE
    sample = _read_proc_cpu_sample()
    if sample is None:
        return None
    previous = _LAST_CPU_SAMPLE
    _LAST_CPU_SAMPLE = sample
    if previous is None:
        return None
    total_delta = sample[0] - previous[0]
    idle_delta = sample[1] - previous[1]
    if total_delta <= 0:
        return None
    return max(0.0, min(100.0, (1.0 - idle_delta / total_delta) * 100.0))


def _fallback_memory_snapshot() -> dict:
    try:
        values = {}
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    values[parts[0].rstrip(":")] = int(parts[1]) * 1024
        total = values.get("MemTotal", 0)
        available = values.get("MemAvailable", 0)
        if total <= 0:
            return {"available": False}
        used = max(0, total - available)
        return {
            "available": True,
            "total_bytes": total,
            "used_bytes": used,
            "available_bytes": available,
            "percent": used / total * 100.0,
        }
    except Exception:
        return {"available": False}


def _fallback_disk_snapshot() -> dict:
    try:
        disk = shutil.disk_usage(os.getcwd())
        total = _bytes_to_int(disk.total)
        used = _bytes_to_int(disk.used)
        free = _bytes_to_int(disk.free)
        percent = used / total * 100.0 if total > 0 else 0.0
        return {
            "available": True,
            "total_bytes": total,
            "used_bytes": used,
            "free_bytes": free,
            "percent": percent,
        }
    except Exception:
        return {"available": False}


def _fallback_process_snapshot() -> dict:
    try:
        page_size = os.sysconf("SC_PAGE_SIZE")
        with open("/proc/self/statm", "r", encoding="utf-8") as f:
            parts = f.readline().strip().split()
        rss = int(parts[1]) * page_size if len(parts) > 1 else 0
        vms = int(parts[0]) * page_size if parts else 0
        thread_count = 0
        with open("/proc/self/status", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("Threads:"):
                    thread_count = int(line.split()[1])
                    break
        return {
            "available": True,
            "pid": os.getpid(),
            "rss_bytes": rss,
            "vms_bytes": vms,
            "threads": thread_count,
        }
    except Exception:
        return {"available": False}


def collect_system_snapshot() -> dict:
    cpu_count = os.cpu_count() or 1
    load_average = _get_load_average()
    data = {
        "available": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "platform": platform.platform(),
        "python_version": platform.python_version(),
        "cpu_count": cpu_count,
        "load_average": load_average,
        "process_uptime_seconds": max(0, int(time.time() - _STARTED_AT)),
        "cpu_percent": None,
        "memory": {"available": False},
        "disk": {"available": False},
        "process": {"available": False},
        "high_load": False,
        "high_load_reasons": [],
    }
    if psutil is not None:
        try:
            data["cpu_percent"] = float(psutil.cpu_percent(interval=0.0))
        except Exception:
            data["cpu_percent"] = None
        try:
            memory = psutil.virtual_memory()
            data["memory"] = {
                "available": True,
                "total_bytes": _bytes_to_int(memory.total),
                "used_bytes": _bytes_to_int(memory.used),
                "available_bytes": _bytes_to_int(memory.available),
                "percent": float(memory.percent),
            }
        except Exception:
            data["memory"] = {"available": False}
        try:
            disk = psutil.disk_usage(os.getcwd())
            data["disk"] = {
                "available": True,
                "total_bytes": _bytes_to_int(disk.total),
                "used_bytes": _bytes_to_int(disk.used),
                "free_bytes": _bytes_to_int(disk.free),
                "percent": float(disk.percent),
            }
        except Exception:
            data["disk"] = {"available": False}
        try:
            proc = psutil.Process(os.getpid())
            mem = proc.memory_info()
            data["process"] = {
                "available": True,
                "pid": os.getpid(),
                "rss_bytes": _bytes_to_int(getattr(mem, "rss", 0)),
                "vms_bytes": _bytes_to_int(getattr(mem, "vms", 0)),
                "threads": int(proc.num_threads()),
            }
        except Exception:
            data["process"] = {"available": False}
    if data["cpu_percent"] is None:
        data["cpu_percent"] = _fallback_cpu_percent()
    if not data.get("memory", {}).get("available"):
        data["memory"] = _fallback_memory_snapshot()
    if not data.get("disk", {}).get("available"):
        data["disk"] = _fallback_disk_snapshot()
    if not data.get("process", {}).get("available"):
        data["process"] = _fallback_process_snapshot()
    reasons = []
    cpu_percent = data.get("cpu_percent")
    if isinstance(cpu_percent, (int, float)) and cpu_percent >= 85:
        reasons.append("CPU 使用率较高")
    memory = data.get("memory") if isinstance(data.get("memory"), dict) else {}
    memory_percent = memory.get("percent")
    if isinstance(memory_percent, (int, float)) and memory_percent >= 90:
        reasons.append("内存使用率较高")
    if load_average.get("available"):
        load1 = load_average.get("load1")
        if isinstance(load1, (int, float)) and cpu_count > 0 and load1 / cpu_count >= 0.9:
            reasons.append("系统负载较高")
    data["high_load"] = bool(reasons)
    data["high_load_reasons"] = reasons
    return data
