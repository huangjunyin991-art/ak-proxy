@echo off
chcp 65001 >nul
title 监控服务器管理器
cd /d "%~dp0monitor"
python monitor_manager.py
pause
