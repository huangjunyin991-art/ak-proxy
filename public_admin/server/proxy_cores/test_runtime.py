import gzip
import tarfile

from public_admin.server.proxy_cores import runtime


def test_install_downloaded_handles_gzip_download_suffix(tmp_path):
    archive = tmp_path / "mihomo.gz.download"
    target = tmp_path / "mihomo"
    payload = b"#!/bin/sh\nexit 0\n"
    with gzip.open(archive, "wb") as f:
        f.write(payload)

    runtime._install_downloaded("mihomo", archive, target)

    assert target.read_bytes() == payload


def test_install_downloaded_handles_tar_gz_download_suffix(tmp_path):
    archive = tmp_path / "sing-box.tar.gz.download"
    source = tmp_path / "sing-box"
    target = tmp_path / "installed-sing-box"
    payload = b"#!/bin/sh\nexit 0\n"
    source.write_bytes(payload)
    with tarfile.open(archive, "w:gz") as tf:
        tf.add(source, arcname="sing-box")

    runtime._install_downloaded("singbox", archive, target)

    assert target.read_bytes() == payload


def test_resolve_binary_ignores_gzip_managed_file(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime, "RUNTIME_ROOT", tmp_path)
    runtime.ensure_core_dirs("mihomo")
    target = runtime.managed_binary_path("mihomo")
    with gzip.open(target, "wb") as f:
        f.write(b"not an executable")

    assert runtime.resolve_binary("mihomo", "ak-test-missing-mihomo") is None


def test_resolve_binary_ignores_archived_singbox_managed_file(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime, "RUNTIME_ROOT", tmp_path)
    runtime.ensure_core_dirs("singbox")
    target = runtime.managed_binary_path("singbox")
    with gzip.open(target, "wb") as f:
        f.write(b"not an executable")

    assert runtime.resolve_binary("singbox", "ak-test-missing-sing-box") is None
