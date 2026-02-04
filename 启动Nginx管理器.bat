@echo off
chcp 65001 >nul
title Nginx管理器
cd /d "%~dp0"
python nginx_manager.py
pause
