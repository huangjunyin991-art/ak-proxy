import os
import platform
import time
from datetime import datetime, timezone

_STARTED_AT = time.time()

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
