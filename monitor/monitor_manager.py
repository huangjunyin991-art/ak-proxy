#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
监控服务器 GUI 管理器
功能：启动/停止服务、编辑配置文件、查看数据库、查看日志
"""

import customtkinter as ctk
from tkinter import messagebox, ttk
import subprocess
import os
import sys
import threading
import time
import sqlite3
import signal
import json
import urllib.request
import urllib.error

# 配置路径 (使用相对路径，文件与管理器在同一目录)
MONITOR_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = "monitor.db"

# 切换工作目录到脚本所在目录
os.chdir(MONITOR_DIR)

# 可编辑的文件
EDITABLE_FILES = {
    "server.py": "后端服务器",
    "database.py": "数据库操作",
    "chat_widget.js": "聊天组件",
    "admin.html": "管理后台页面",
    "proxy_pool.py": "代理池模块",
    "subscription_parser.py": "订阅解析",
    "subscription_cache.json": "节点缓存"
}

# 设置主题
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")


class MonitorManager(ctk.CTk):
    def __init__(self):
        super().__init__()
        
        self.title("监控服务器管理器")
        self.geometry("1100x750")
        self.minsize(1000, 650)
        
        # 服务进程
        self.server_process = None
        self.log_thread = None
        self.log_running = False
        
        self.create_widgets()
        self.update_status()
        self._schedule_status_refresh()
        
        # Ctrl+S 快捷键在 editor_text 上绑定（避免重复触发）
        
    def create_widgets(self):
        # 主框架
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(1, weight=1)
        
        # ===== 顶部控制面板 =====
        control_frame = ctk.CTkFrame(self)
        control_frame.grid(row=0, column=0, padx=10, pady=10, sticky="ew")
        control_frame.grid_columnconfigure(6, weight=1)
        
        # 状态标签
        self.status_label = ctk.CTkLabel(control_frame, text="状态: 检查中...", 
                                         font=ctk.CTkFont(size=14, weight="bold"))
        self.status_label.grid(row=0, column=0, padx=10, pady=10)
        
        # 端口设置
        ctk.CTkLabel(control_frame, text="端口:").grid(row=0, column=1, padx=(20, 5), pady=10)
        self.port_entry = ctk.CTkEntry(control_frame, width=70)
        self.port_entry.insert(0, "8080")
        self.port_entry.grid(row=0, column=2, padx=5, pady=10)
        
        # 控制按钮
        self.start_btn = ctk.CTkButton(control_frame, text="▶ 启动服务", width=100,
                                       fg_color="green", hover_color="darkgreen",
                                       command=self.start_server)
        self.start_btn.grid(row=0, column=3, padx=5, pady=10)
        
        self.stop_btn = ctk.CTkButton(control_frame, text="■ 停止服务", width=100,
                                      fg_color="red", hover_color="darkred",
                                      command=self.stop_server)
        self.stop_btn.grid(row=0, column=4, padx=5, pady=10)
        
        self.restart_btn = ctk.CTkButton(control_frame, text="🔄 重启", width=80,
                                         fg_color="orange", hover_color="darkorange",
                                         command=self.restart_server)
        self.restart_btn.grid(row=0, column=5, padx=5, pady=10)
        
        # 打开管理后台按钮
        self.open_admin_btn = ctk.CTkButton(control_frame, text="🌐 打开管理后台", width=120,
                                            command=self.open_admin)
        self.open_admin_btn.grid(row=0, column=6, padx=5, pady=10, sticky="e")
        
        # ===== 标签页 =====
        self.tabview = ctk.CTkTabview(self)
        self.tabview.grid(row=1, column=0, padx=10, pady=(0, 10), sticky="nsew")
        
        # 日志标签页
        self.tab_log = self.tabview.add("📋 服务日志")
        self.tab_log.grid_columnconfigure(0, weight=1)
        self.tab_log.grid_rowconfigure(0, weight=1)
        
        # 文件编辑标签页
        self.tab_files = self.tabview.add("📝 文件编辑")
        self.tab_files.grid_columnconfigure(1, weight=1)
        self.tab_files.grid_rowconfigure(0, weight=1)
        
        # 数据库标签页
        self.tab_db = self.tabview.add("🗄️ 数据库")
        self.tab_db.grid_columnconfigure(0, weight=1)
        self.tab_db.grid_rowconfigure(1, weight=1)
        
        # 配置标签页
        self.tab_config = self.tabview.add("⚙️ 配置")
        self.tab_config.grid_columnconfigure(0, weight=1)
        
        # 代理池标签页
        self.tab_proxy = self.tabview.add("🌐 代理池")
        self.tab_proxy.grid_columnconfigure(0, weight=1)
        self.tab_proxy.grid_rowconfigure(1, weight=1)
        
        # ===== 日志区域 =====
        self.log_text = ctk.CTkTextbox(self.tab_log, font=ctk.CTkFont(family="Consolas", size=12))
        self.log_text.grid(row=0, column=0, sticky="nsew", padx=5, pady=5)
        
        log_btn_frame = ctk.CTkFrame(self.tab_log)
        log_btn_frame.grid(row=1, column=0, sticky="ew", padx=5, pady=5)
        
        ctk.CTkButton(log_btn_frame, text="清空日志", width=80,
                     command=lambda: self.log_text.delete("1.0", "end")).pack(side="left", padx=5)
        
        # ===== 文件编辑区域 =====
        # 文件列表
        file_list_frame = ctk.CTkFrame(self.tab_files, width=200)
        file_list_frame.grid(row=0, column=0, sticky="ns", padx=5, pady=5)
        file_list_frame.grid_propagate(False)
        
        ctk.CTkLabel(file_list_frame, text="选择文件", font=ctk.CTkFont(weight="bold")).pack(pady=10)
        
        self.file_buttons = {}
        for filename, desc in EDITABLE_FILES.items():
            btn = ctk.CTkButton(file_list_frame, text=f"{filename}\n{desc}", 
                               width=180, height=50,
                               command=lambda f=filename: self.load_file(f))
            btn.pack(pady=3, padx=5)
            self.file_buttons[filename] = btn
        
        # 编辑器区域
        editor_frame = ctk.CTkFrame(self.tab_files)
        editor_frame.grid(row=0, column=1, sticky="nsew", padx=5, pady=5)
        editor_frame.grid_columnconfigure(0, weight=1)
        editor_frame.grid_rowconfigure(1, weight=1)
        
        # 编辑器工具栏
        editor_toolbar = ctk.CTkFrame(editor_frame)
        editor_toolbar.grid(row=0, column=0, sticky="ew", pady=(0, 5))
        
        self.current_file_label = ctk.CTkLabel(editor_toolbar, text="未选择文件", 
                                               font=ctk.CTkFont(size=13))
        self.current_file_label.pack(side="left", padx=10)
        
        ctk.CTkButton(editor_toolbar, text="💾 保存", width=80,
                     command=self.save_file).pack(side="right", padx=5)
        
        ctk.CTkButton(editor_toolbar, text="💾 保存并重启", width=100,
                     fg_color="green", hover_color="darkgreen",
                     command=self.save_and_restart).pack(side="right", padx=5)
        
        ctk.CTkButton(editor_toolbar, text="🔄 重新加载", width=80,
                     command=lambda: self.load_file(self.current_file)).pack(side="right", padx=5)
        
        # 编辑器
        self.editor_text = ctk.CTkTextbox(editor_frame, font=ctk.CTkFont(family="Consolas", size=12))
        self.editor_text.grid(row=1, column=0, sticky="nsew")
        
        # 绑定 Ctrl+S 快捷键保存
        self.editor_text.bind("<Control-s>", lambda e: self.save_file())
        self.editor_text.bind("<Control-S>", lambda e: self.save_file())
        
        self.current_file = None
        
        # ===== 数据库区域 =====
        db_toolbar = ctk.CTkFrame(self.tab_db)
        db_toolbar.grid(row=0, column=0, sticky="ew", padx=5, pady=5)
        
        ctk.CTkLabel(db_toolbar, text="选择表:").pack(side="left", padx=5)
        
        self.table_var = ctk.StringVar(value="user_stats")
        self.table_combo = ctk.CTkComboBox(db_toolbar, values=[
            "user_stats", "user_assets", "login_records", 
            "ip_stats", "ban_list", "asset_history"
        ], variable=self.table_var, width=150, command=self.load_table)
        self.table_combo.pack(side="left", padx=5)
        
        ctk.CTkButton(db_toolbar, text="🔄 刷新", width=80,
                     command=lambda: self.load_table(self.table_var.get())).pack(side="left", padx=10)
        
        ctk.CTkButton(db_toolbar, text="📊 统计信息", width=100,
                     command=self.show_db_stats).pack(side="left", padx=5)
        
        ctk.CTkButton(db_toolbar, text="🗑️ 清空表", width=80, fg_color="red",
                     command=self.clear_table).pack(side="right", padx=5)
        
        # 数据库表格 (使用ttk.Treeview)
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("Treeview", 
                       background="#1a1a2e", 
                       foreground="#e4e4e4",
                       fieldbackground="#1a1a2e",
                       rowheight=25)
        style.configure("Treeview.Heading",
                       background="#2d2d44",
                       foreground="#00d4ff",
                       font=('Segoe UI', 10, 'bold'))
        style.map("Treeview", background=[("selected", "#3d3d5c")])
        
        tree_frame = ctk.CTkFrame(self.tab_db)
        tree_frame.grid(row=1, column=0, sticky="nsew", padx=5, pady=5)
        tree_frame.grid_columnconfigure(0, weight=1)
        tree_frame.grid_rowconfigure(0, weight=1)
        
        self.db_tree = ttk.Treeview(tree_frame, show="headings")
        self.db_tree.grid(row=0, column=0, sticky="nsew")
        
        # 滚动条
        scrollbar_y = ttk.Scrollbar(tree_frame, orient="vertical", command=self.db_tree.yview)
        scrollbar_y.grid(row=0, column=1, sticky="ns")
        scrollbar_x = ttk.Scrollbar(tree_frame, orient="horizontal", command=self.db_tree.xview)
        scrollbar_x.grid(row=1, column=0, sticky="ew")
        self.db_tree.configure(yscrollcommand=scrollbar_y.set, xscrollcommand=scrollbar_x.set)
        
        # ===== 配置区域 =====
        config_frame = ctk.CTkFrame(self.tab_config)
        config_frame.grid(row=0, column=0, sticky="ew", padx=20, pady=20)
        
        ctk.CTkLabel(config_frame, text="服务器配置", font=ctk.CTkFont(size=16, weight="bold")).grid(
            row=0, column=0, columnspan=2, pady=10)
        
        # API URL
        ctk.CTkLabel(config_frame, text="原始API地址:").grid(row=1, column=0, sticky="e", padx=10, pady=5)
        self.api_url_entry = ctk.CTkEntry(config_frame, width=400)
        self.api_url_entry.insert(0, "https://www.akapi1.com/RPC/")
        self.api_url_entry.grid(row=1, column=1, sticky="w", padx=10, pady=5)
        
        # 管理员密码
        ctk.CTkLabel(config_frame, text="管理员密码:").grid(row=2, column=0, sticky="e", padx=10, pady=5)
        self.admin_pwd_entry = ctk.CTkEntry(config_frame, width=200, show="*")
        self.admin_pwd_entry.insert(0, "ak-lovejjy1314")
        self.admin_pwd_entry.grid(row=2, column=1, sticky="w", padx=10, pady=5)
        
        ctk.CTkButton(config_frame, text="保存配置到server.py", 
                     command=self.save_config).grid(row=3, column=1, sticky="w", padx=10, pady=20)
        
        # ===== 代理池区域 =====
        self.pp_admin_token = ""
        self.pp_refresh_timer = None
        
        # 上半部分：配置
        pp_config_frame = ctk.CTkFrame(self.tab_proxy)
        pp_config_frame.grid(row=0, column=0, sticky="ew", padx=10, pady=10)
        pp_config_frame.grid_columnconfigure(1, weight=1)
        
        ctk.CTkLabel(pp_config_frame, text="代理池管理", 
                     font=ctk.CTkFont(size=16, weight="bold")).grid(row=0, column=0, columnspan=4, pady=10)
        
        # 状态指示
        self.pp_status_label = ctk.CTkLabel(pp_config_frame, text="状态: 未知", 
                                            font=ctk.CTkFont(size=13, weight="bold"))
        self.pp_status_label.grid(row=1, column=0, columnspan=4, pady=(0, 10))
        
        # sing-box 路径
        ctk.CTkLabel(pp_config_frame, text="sing-box路径:").grid(row=2, column=0, sticky="e", padx=10, pady=5)
        self.pp_singbox_entry = ctk.CTkEntry(pp_config_frame, width=400, 
                                             placeholder_text=r"如: C:\sing-box\sing-box.exe")
        self.pp_singbox_entry.grid(row=2, column=1, columnspan=3, sticky="ew", padx=10, pady=5)
        
        # 订阅链接
        ctk.CTkLabel(pp_config_frame, text="订阅链接:").grid(row=3, column=0, sticky="e", padx=10, pady=5)
        sub_frame = ctk.CTkFrame(pp_config_frame, fg_color="transparent")
        sub_frame.grid(row=3, column=1, columnspan=3, sticky="ew", padx=10, pady=5)
        self.pp_sub_entry = ctk.CTkEntry(sub_frame, width=350,
                                         placeholder_text="输入订阅链接获取代理节点")
        self.pp_sub_entry.pack(side="left", fill="x", expand=True)
        ctk.CTkButton(sub_frame, text="🔄 刷新订阅", width=100,
                     fg_color="#6c5ce7", hover_color="#5a4bd1",
                     command=self.pp_refresh_subscription).pack(side="left", padx=(8, 0))
        
        # 数值参数行
        param_frame = ctk.CTkFrame(pp_config_frame, fg_color="transparent")
        param_frame.grid(row=4, column=0, columnspan=4, pady=5)
        
        ctk.CTkLabel(param_frame, text="槽位数:").pack(side="left", padx=(10, 2))
        self.pp_slots_entry = ctk.CTkEntry(param_frame, width=50)
        self.pp_slots_entry.insert(0, "5")
        self.pp_slots_entry.pack(side="left", padx=(0, 15))
        
        ctk.CTkLabel(param_frame, text="起始端口:").pack(side="left", padx=(0, 2))
        self.pp_port_entry = ctk.CTkEntry(param_frame, width=70)
        self.pp_port_entry.insert(0, "21000")
        self.pp_port_entry.pack(side="left", padx=(0, 15))
        
        ctk.CTkLabel(param_frame, text="速率限制/min:").pack(side="left", padx=(0, 2))
        self.pp_rate_entry = ctk.CTkEntry(param_frame, width=50)
        self.pp_rate_entry.insert(0, "8")
        self.pp_rate_entry.pack(side="left", padx=(0, 10))
        
        # 优先直连选项
        direct_frame = ctk.CTkFrame(pp_config_frame, fg_color="transparent")
        direct_frame.grid(row=5, column=0, columnspan=4, pady=5)
        
        self.pp_prefer_direct_var = ctk.BooleanVar(value=False)
        self.pp_prefer_direct_cb = ctk.CTkCheckBox(direct_frame, text="优先直连（冷却后自动切回直连）",
                                                     variable=self.pp_prefer_direct_var)
        self.pp_prefer_direct_cb.pack(side="left", padx=(10, 15))
        
        ctk.CTkLabel(direct_frame, text="冷却时间(秒):").pack(side="left", padx=(0, 2))
        self.pp_direct_cd_entry = ctk.CTkEntry(direct_frame, width=50)
        self.pp_direct_cd_entry.insert(0, "60")
        self.pp_direct_cd_entry.pack(side="left", padx=(0, 10))
        
        ctk.CTkLabel(direct_frame, text="直连限速/min:").pack(side="left", padx=(0, 2))
        self.pp_direct_rate_entry = ctk.CTkEntry(direct_frame, width=50)
        self.pp_direct_rate_entry.insert(0, "4")
        self.pp_direct_rate_entry.pack(side="left", padx=(0, 10))
        
        self.pp_direct_status_label = ctk.CTkLabel(direct_frame, text="", 
                                                     font=ctk.CTkFont(size=12))
        self.pp_direct_status_label.pack(side="left", padx=(10, 0))
        
        # 按钮行
        btn_frame = ctk.CTkFrame(pp_config_frame, fg_color="transparent")
        btn_frame.grid(row=6, column=0, columnspan=4, pady=10)
        
        ctk.CTkButton(btn_frame, text="💾 保存配置", width=100,
                     command=self.pp_save_config).pack(side="left", padx=5)
        ctk.CTkButton(btn_frame, text="📦 加载/重载模块", width=120,
                     fg_color="orange", hover_color="darkorange",
                     command=self.pp_load_module).pack(side="left", padx=5)
        self.pp_start_btn = ctk.CTkButton(btn_frame, text="▶ 启动", width=80,
                     fg_color="green", hover_color="darkgreen",
                     command=self.pp_start)
        self.pp_start_btn.pack(side="left", padx=5)
        self.pp_stop_btn = ctk.CTkButton(btn_frame, text="■ 停止", width=80,
                     fg_color="red", hover_color="darkred",
                     command=self.pp_stop)
        self.pp_stop_btn.pack(side="left", padx=5)
        ctk.CTkButton(btn_frame, text="🔄 刷新状态", width=100,
                     command=self.pp_refresh_status).pack(side="left", padx=5)
        
        # 下半部分：状态展示
        self.pp_status_text = ctk.CTkTextbox(self.tab_proxy, font=ctk.CTkFont(family="Consolas", size=12))
        self.pp_status_text.grid(row=1, column=0, sticky="nsew", padx=10, pady=(0, 10))
        self.pp_status_text.insert("1.0", "点击「刷新状态」查看代理池信息\n（需要先输入管理Token并确保服务器已启动）")
        
        # 初始化
        self.load_table("user_stats")
    
    def find_server_process(self):
        """查找服务器进程"""
        import psutil
        for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
            try:
                cmdline = proc.info['cmdline']
                if cmdline and 'server.py' in ' '.join(cmdline) and 'python' in proc.info['name'].lower():
                    return proc
            except:
                pass
        return None
    
    def update_status(self):
        """更新服务状态"""
        proc = self.find_server_process()
        # 检查 self.server_process 是否已退出
        if self.server_process and self.server_process.poll() is not None:
            self.server_process = None
        if proc or self.server_process:
            port = self.port_entry.get()
            self.status_label.configure(text=f"状态: ✅ 运行中 (端口 {port})", text_color="lightgreen")
            self.start_btn.configure(state="disabled")
            self.stop_btn.configure(state="normal")
        else:
            self.status_label.configure(text="状态: ❌ 已停止", text_color="red")
            self.start_btn.configure(state="normal")
            self.stop_btn.configure(state="disabled")
    
    def _schedule_status_refresh(self):
        """每5秒自动刷新服务状态"""
        self.update_status()
        self.after(5000, self._schedule_status_refresh)
    
    def _kill_port(self, port):
        """强制杀死占用指定端口的进程（Windows）"""
        if os.name != 'nt':
            return
        try:
            result = subprocess.run(
                f'netstat -ano | findstr ":{port}" | findstr "LISTENING"',
                capture_output=True, text=True, shell=True
            )
            for line in result.stdout.strip().split('\n'):
                if line.strip():
                    pid = line.strip().split()[-1]
                    if pid.isdigit() and int(pid) != os.getpid():
                        subprocess.run(f'taskkill /F /PID {pid}', shell=True, capture_output=True)
                        self.log_text.insert("end", f"[INFO] 已清理端口 {port} 占用进程 PID={pid}\n")
        except Exception:
            pass
    
    def start_server(self):
        """启动服务器"""
        port = self.port_entry.get()
        
        # 启动前清理端口占用
        self._kill_port(port)
        time.sleep(0.5)
        
        try:
            # 检查依赖
            self.log_text.insert("end", f"[INFO] 检查并安装依赖...\n")
            subprocess.run([sys.executable, "-m", "pip", "install", "-r", "requirements.txt",
                          "-i", "https://pypi.tuna.tsinghua.edu.cn/simple", "-q"],
                         capture_output=True)
            
            # 清理 __pycache__ 确保加载最新代码
            cache_dir = os.path.join(MONITOR_DIR, "__pycache__")
            if os.path.isdir(cache_dir):
                import shutil
                try:
                    shutil.rmtree(cache_dir)
                    self.log_text.insert("end", "[INFO] 已清理 __pycache__\n")
                except Exception:
                    pass
            
            # 启动服务器
            self.log_text.insert("end", f"[INFO] 启动服务器在端口 {port}...\n")
            
            self.server_process = subprocess.Popen(
                [sys.executable, "-c", f"""
from server import app
import uvicorn
uvicorn.run(app, host='0.0.0.0', port={port})
"""],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            )
            
            # 启动日志读取线程
            self.log_running = True
            self.log_thread = threading.Thread(target=self.read_log, daemon=True)
            self.log_thread.start()
            
            time.sleep(2)
            self.update_status()
            self.log_text.insert("end", f"[INFO] 服务器已启动: http://127.0.0.1:{port}/admin\n")
            
        except Exception as e:
            self.log_text.insert("end", f"[ERROR] 启动失败: {e}\n")
            messagebox.showerror("错误", f"启动失败: {e}")
    
    def read_log(self):
        """读取服务器日志"""
        while self.log_running and self.server_process:
            try:
                line = self.server_process.stdout.readline()
                if line:
                    self.log_text.insert("end", line.decode('utf-8', errors='ignore'))
                    self.log_text.see("end")
                elif self.server_process.poll() is not None:
                    break
            except:
                break
    
    def stop_server(self):
        """停止服务器（强制杀死进程树+端口占用进程）"""
        self.log_running = False
        
        # 强制杀死进程树
        if self.server_process:
            try:
                import psutil
                parent = psutil.Process(self.server_process.pid)
                for child in parent.children(recursive=True):
                    child.kill()
                parent.kill()
            except Exception:
                try:
                    self.server_process.kill()
                except Exception:
                    pass
            self.server_process = None
        
        # 查找并终止其他服务器进程
        proc = self.find_server_process()
        if proc:
            try:
                proc.kill()
            except:
                pass
        
        # 强制杀死端口占用
        self._kill_port(self.port_entry.get())
        
        time.sleep(1)
        self.update_status()
        self.log_text.insert("end", "[INFO] 服务器已停止\n")
    
    def restart_server(self):
        """重启服务器"""
        self.stop_server()
        time.sleep(1)
        self.start_server()
    
    def open_admin(self):
        """打开管理后台"""
        port = self.port_entry.get()
        import webbrowser
        webbrowser.open(f"http://127.0.0.1:{port}/admin")
    
    def load_file(self, filename):
        """加载文件"""
        self.current_file = filename
        filepath = filename  # 相对路径
        
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()
            
            self.editor_text.delete("1.0", "end")
            self.editor_text.insert("1.0", content)
            self.current_file_label.configure(text=f"编辑: {filename}")
            
            # 更新按钮状态
            for fn, btn in self.file_buttons.items():
                if fn == filename:
                    btn.configure(fg_color="#1f6aa5")
                else:
                    btn.configure(fg_color=["#3B8ED0", "#1F6AA5"])
                    
        except Exception as e:
            messagebox.showerror("错误", f"加载文件失败: {e}")
    
    def save_file(self):
        """保存文件"""
        if not self.current_file:
            messagebox.showwarning("警告", "请先选择文件")
            return
        
        filepath = self.current_file  # 相对路径
        content = self.editor_text.get("1.0", "end-1c")
        
        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(content)
            messagebox.showinfo("成功", f"文件 {self.current_file} 已保存")
        except Exception as e:
            messagebox.showerror("错误", f"保存失败: {e}")
    
    def save_and_restart(self):
        """保存文件并重启服务器"""
        self.save_file()
        if self.find_server_process() or self.server_process:
            self.restart_server()
    
    def load_table(self, table_name):
        """加载数据库表"""
        # 清空现有数据
        for item in self.db_tree.get_children():
            self.db_tree.delete(item)
        
        if not os.path.exists(DB_PATH):
            return
        
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            
            # 获取表结构
            cursor.execute(f"PRAGMA table_info({table_name})")
            columns = [col[1] for col in cursor.fetchall()]
            
            if not columns:
                return
            
            # 配置列
            self.db_tree["columns"] = columns
            for col in columns:
                self.db_tree.heading(col, text=col)
                self.db_tree.column(col, width=100, minwidth=50)
            
            # 获取数据
            cursor.execute(f"SELECT * FROM {table_name} ORDER BY 1 DESC LIMIT 500")
            rows = cursor.fetchall()
            
            for row in rows:
                self.db_tree.insert("", "end", values=row)
            
            conn.close()
            
        except Exception as e:
            messagebox.showerror("错误", f"加载表失败: {e}")
    
    def show_db_stats(self):
        """显示数据库统计"""
        if not os.path.exists(DB_PATH):
            messagebox.showinfo("统计", "数据库不存在")
            return
        
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            
            stats = []
            tables = ["user_stats", "user_assets", "login_records", "ip_stats", "ban_list"]
            
            for table in tables:
                try:
                    cursor.execute(f"SELECT COUNT(*) FROM {table}")
                    count = cursor.fetchone()[0]
                    stats.append(f"{table}: {count} 条记录")
                except:
                    stats.append(f"{table}: 表不存在")
            
            conn.close()
            
            messagebox.showinfo("数据库统计", "\n".join(stats))
            
        except Exception as e:
            messagebox.showerror("错误", f"获取统计失败: {e}")
    
    def clear_table(self):
        """清空表"""
        table = self.table_var.get()
        if not messagebox.askyesno("确认", f"确定要清空表 {table} 吗？此操作不可恢复！"):
            return
        
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute(f"DELETE FROM {table}")
            conn.commit()
            conn.close()
            
            self.load_table(table)
            messagebox.showinfo("成功", f"表 {table} 已清空")
            
        except Exception as e:
            messagebox.showerror("错误", f"清空表失败: {e}")
    
    def save_config(self):
        """保存配置到server.py"""
        api_url = self.api_url_entry.get()
        admin_pwd = self.admin_pwd_entry.get()
        
        server_path = "server.py"  # 相对路径
        
        try:
            with open(server_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # 替换配置
            import re
            content = re.sub(
                r'ADMIN_PASSWORD\s*=\s*"[^"]*"',
                f'ADMIN_PASSWORD = "{admin_pwd}"',
                content
            )
            content = re.sub(
                r'AKAPI_URL\s*=\s*"[^"]*"',
                f'AKAPI_URL = "{api_url}"',
                content
            )
            
            with open(server_path, 'w', encoding='utf-8') as f:
                f.write(content)
            
            messagebox.showinfo("成功", "配置已保存，重启服务器生效")
            
        except Exception as e:
            messagebox.showerror("错误", f"保存配置失败: {e}")
    
    # ===== 代理池管理方法 =====
    
    _pp_token = None  # 缓存的管理员Token
    
    def _pp_api(self, method, path, data=None):
        """调用代理池API，返回 (success, result_dict)。401时自动登录重试"""
        port = self.port_entry.get()
        url = f"http://127.0.0.1:{port}{path}"
        
        def _do_request(token=None):
            body = json.dumps(data).encode('utf-8') if data else None
            req = urllib.request.Request(url, data=body, method=method)
            req.add_header('Content-Type', 'application/json')
            if token:
                req.add_header('Authorization', f'Bearer {token}')
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode('utf-8'))
        
        try:
            result = _do_request(self._pp_token)
            return True, result
        except urllib.error.HTTPError as e:
            if e.code == 401:
                # 自动登录获取Token后重试
                token = self._pp_auto_login(port)
                if token:
                    try:
                        result = _do_request(token)
                        return True, result
                    except urllib.error.HTTPError as e2:
                        try:
                            return False, json.loads(e2.read().decode('utf-8'))
                        except Exception:
                            return False, {"message": f"HTTP {e2.code}: {e2.reason}"}
            try:
                err_body = json.loads(e.read().decode('utf-8'))
                return False, err_body
            except Exception:
                return False, {"message": f"HTTP {e.code}: {e.reason}"}
        except urllib.error.URLError as e:
            return False, {"message": f"连接失败: {e.reason}\n请确认服务器已启动"}
        except Exception as e:
            return False, {"message": f"请求异常: {e}"}
    
    def _pp_auto_login(self, port):
        """自动登录获取管理员Token"""
        try:
            login_url = f"http://127.0.0.1:{port}/admin/api/login"
            body = json.dumps({"password": "ak-lovejjy1314"}).encode('utf-8')
            req = urllib.request.Request(login_url, data=body, method="POST")
            req.add_header('Content-Type', 'application/json')
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode('utf-8'))
                if result.get("success") and result.get("token"):
                    MonitorManager._pp_token = result["token"]
                    return result["token"]
        except Exception:
            pass
        return None
    
    def pp_save_config(self):
        """保存代理池配置到服务器"""
        data = {
            "singbox_path": self.pp_singbox_entry.get().strip(),
            "subscription_url": self.pp_sub_entry.get().strip(),
            "prefer_direct": self.pp_prefer_direct_var.get(),
            "direct_cooldown": int(self.pp_direct_cd_entry.get() or 60),
            "direct_rate_limit": int(self.pp_direct_rate_entry.get() or 4),
            "num_slots": int(self.pp_slots_entry.get() or 5),
            "base_port": int(self.pp_port_entry.get() or 21000),
            "rate_limit": int(self.pp_rate_entry.get() or 8),
        }
        ok, result = self._pp_api("POST", "/admin/api/proxy_pool/config", data)
        if ok and result.get("success"):
            messagebox.showinfo("成功", result.get("message", "配置已保存"))
        else:
            messagebox.showerror("错误", result.get("message", "保存失败"))
    
    def pp_refresh_subscription(self):
        """本地刷新订阅节点"""
        sub_url = self.pp_sub_entry.get().strip()
        if not sub_url:
            messagebox.showwarning("提示", "请先输入订阅链接")
            return
        
        def do_fetch():
            try:
                from subscription_parser import SubscriptionParser
                
                raw_nodes, err = SubscriptionParser.fetch_and_parse(sub_url)
                if err:
                    self.after(0, lambda: messagebox.showerror("错误", f"订阅获取失败:\n{err}"))
                    return
                
                node_dicts = [n.to_dict() for n in raw_nodes]
                info_keywords = ["剩余流量", "套餐到期", "官网", "到期时间", "过期", "流量"]
                nodes = []
                for n in node_dicts:
                    host = n.get("host", "")
                    name = n.get("name", "")
                    if host in ("127.0.0.1", "localhost", "0.0.0.0", "") or not n.get("port", 0):
                        continue
                    if any(kw in name for kw in info_keywords):
                        continue
                    nodes.append(n)
                
                if not nodes:
                    self.after(0, lambda: messagebox.showwarning("提示", "订阅中没有可用节点"))
                    return
                
                cache_path = os.path.join(MONITOR_DIR, "subscription_cache.json")
                with open(cache_path, 'w', encoding='utf-8') as f:
                    json.dump({
                        "cached_nodes": nodes, 
                        "updated": time.strftime("%Y-%m-%d %H:%M:%S")
                    }, f, ensure_ascii=False, indent=2)
                
                count = len(nodes)
                self.after(0, lambda: messagebox.showinfo("成功", f"获取到 {count} 个可用节点\n已缓存到 subscription_cache.json"))
                
                self._pp_api("POST", "/admin/api/proxy_pool/config", {"subscription_url": sub_url})
                
            except ImportError as e:
                err_msg = str(e)
                self.after(0, lambda: messagebox.showerror("错误", f"导入订阅解析器失败:\n{err_msg}\n\n请安装: pip install requests pyyaml"))
            except Exception as e:
                err_msg = str(e)
                self.after(0, lambda: messagebox.showerror("错误", f"订阅获取异常:\n{err_msg}"))
        
        threading.Thread(target=do_fetch, daemon=True).start()
    
    def pp_load_module(self):
        """动态加载/重载代理池模块"""
        ok, result = self._pp_api("POST", "/admin/api/proxy_pool/load_module")
        if ok and result.get("success"):
            messagebox.showinfo("成功", result.get("message", "模块已加载"))
            self.pp_refresh_status()
        else:
            msg = result.get("message", "") if isinstance(result, dict) else str(result)
            messagebox.showerror("错误", msg or f"加载失败\n\n响应: {result}")
    
    def pp_start(self):
        """启动代理池"""
        self.pp_start_btn.configure(text="⏳ 启动中...", state="disabled")
        self.update()
        
        ok, result = self._pp_api("POST", "/admin/api/proxy_pool/start")
        
        self.pp_start_btn.configure(text="▶ 启动", state="normal")
        if ok and result.get("success"):
            messagebox.showinfo("成功", result.get("message", "已启动"))
            self.pp_refresh_status()
        else:
            messagebox.showerror("错误", result.get("message", "启动失败"))
    
    def pp_stop(self):
        """停止代理池"""
        if not messagebox.askyesno("确认", "确定停止代理池？停止后所有请求将直连上游。"):
            return
        ok, result = self._pp_api("POST", "/admin/api/proxy_pool/stop")
        if ok and result.get("success"):
            messagebox.showinfo("成功", result.get("message", "已停止"))
            self.pp_refresh_status()
        else:
            messagebox.showerror("错误", result.get("message", "停止失败"))
    
    def pp_refresh_status(self):
        """刷新代理池状态"""
        ok, result = self._pp_api("GET", "/admin/api/proxy_pool/status")
        
        self.pp_status_text.delete("1.0", "end")
        
        if not ok:
            self.pp_status_label.configure(text="状态: ❌ 获取失败", text_color="red")
            self.pp_status_text.insert("1.0", f"获取状态失败:\n{result.get('message', '未知错误')}")
            return
        
        # 模块未加载
        if result.get("available") is False:
            self.pp_status_label.configure(text="状态: ⚠ 模块未加载", text_color="orange")
            self.pp_status_text.insert("1.0", "代理池模块未加载\n\n请先：\n1. 部署 proxy_pool.py 到 monitor 目录\n2. 安装依赖: pip install httpx[socks]\n3. 点击「加载/重载模块」按钮")
            return
        
        config = result.get("config", {})
        pool = result.get("pool")
        
        # 填充配置到输入框
        if config.get("singbox_path"):
            self.pp_singbox_entry.delete(0, "end")
            self.pp_singbox_entry.insert(0, config["singbox_path"])
        if config.get("subscription_url"):
            self.pp_sub_entry.delete(0, "end")
            self.pp_sub_entry.insert(0, config["subscription_url"])
        if config.get("num_slots"):
            self.pp_slots_entry.delete(0, "end")
            self.pp_slots_entry.insert(0, str(config["num_slots"]))
        if config.get("base_port"):
            self.pp_port_entry.delete(0, "end")
            self.pp_port_entry.insert(0, str(config["base_port"]))
        if config.get("rate_limit"):
            self.pp_rate_entry.delete(0, "end")
            self.pp_rate_entry.insert(0, str(config["rate_limit"]))
        self.pp_prefer_direct_var.set(config.get("prefer_direct", False))
        if config.get("direct_cooldown"):
            self.pp_direct_cd_entry.delete(0, "end")
            self.pp_direct_cd_entry.insert(0, str(config["direct_cooldown"]))
        if config.get("direct_rate_limit"):
            self.pp_direct_rate_entry.delete(0, "end")
            self.pp_direct_rate_entry.insert(0, str(config["direct_rate_limit"]))
        
        # 更新直连状态显示
        direct = result.get("direct", {})
        if direct.get("prefer_direct"):
            req_1min = direct.get("direct_req_1min", 0)
            rate_lim = direct.get("direct_rate_limit", 4)
            if direct.get("is_cooling"):
                remaining = direct.get("cooldown_remaining", 0)
                self.pp_direct_status_label.configure(
                    text=f"🟡 冷却中 ({remaining:.0f}s)，走代理", text_color="orange")
            else:
                self.pp_direct_status_label.configure(
                    text=f"🟢 直连中 ({req_1min}/{rate_lim}/min)", text_color="lightgreen")
        else:
            self.pp_direct_status_label.configure(text="", text_color="gray")
        
        if pool and pool.get("running"):
            alive = pool.get("alive_slots", 0)
            total = pool.get("total_slots", 0)
            last_route = result.get("last_route", "")
            route_text = f"  路由: {last_route}" if last_route else ""
            self.pp_status_label.configure(
                text=f"状态: ✅ 运行中 ({alive}/{total} 槽位在线){route_text}", text_color="lightgreen")
            
            lines = []
            lines.append(f"{'='*60}")
            lines.append(f"  总请求: {pool.get('total_requests', 0)}  |  "
                        f"成功: {pool.get('total_success', 0)}  |  "
                        f"失败: {pool.get('total_fail', 0)}  |  "
                        f"成功率: {pool.get('success_rate', 'N/A')}")
            tiers = pool.get('node_tiers', {})
            lines.append(f"  当前速率限制: {pool.get('current_rate_limit', '-')}/min  |  "
                        f"总节点: {pool.get('total_nodes', 0)}")
            lines.append(f"  节点分级: T1(优) {tiers.get('good', 0)}  |  "
                        f"T2(中) {tiers.get('ok', 0)}  |  "
                        f"T3(差) {tiers.get('bad', 0)}  |  "
                        f"热备池: {tiers.get('ready_pool', 0)}")
            lines.append(f"{'='*60}")
            lines.append("")
            
            for s in pool.get("slots", []):
                alive_mark = "🟢" if s.get("alive") else "🔴"
                status = s.get("status", "unknown")
                if status == "blocked":
                    alive_mark = "🟡"
                    status = f"冷却中 ({s.get('cooldown_left', 0)}s)"
                elif status == "available":
                    status = "在线"
                elif status == "dead":
                    status = "离线"
                
                tier_tag = s.get('node_tier', '?')
                line = (f"  {alive_mark} Slot {s.get('slot_id', '?'):>2}  "
                       f"[{status:<12}]  [{tier_tag}] {s.get('node', '-'):<20}  "
                       f":{s.get('port', '-')}")
                lines.append(line)
                
                detail = (f"           "
                         f"请求/min: {s.get('requests_1min', 0)}  |  "
                         f"总计: {s.get('total_requests', 0)}  |  "
                         f"✓{s.get('success', 0)} ✗{s.get('fail', 0)}  |  "
                         f"成功率: {s.get('success_rate', 'N/A')}")
                lines.append(detail)
                
                extras = []
                if s.get("blocked_count", 0) > 0:
                    extras.append(f"被封: {s['blocked_count']}次")
                if s.get("consecutive_fails", 0) > 0:
                    extras.append(f"连续失败: {s['consecutive_fails']}")
                if s.get("last_error"):
                    extras.append(f"最近错误: {s['last_error']}")
                if extras:
                    lines.append(f"           {'  |  '.join(extras)}")
                lines.append("")
            
            self.pp_status_text.insert("1.0", "\n".join(lines))
        else:
            self.pp_status_label.configure(text="状态: ⏸ 已加载·未启用", text_color="yellow")
            self.pp_status_text.insert("1.0", "代理池模块已加载，但未启动\n\n请先配置 sing-box 路径和节点配置路径，然后点击「启动」")
    
    def on_closing(self):
        """关闭窗口时的处理"""
        if self.server_process:
            # 检查在线用户
            online_count = 0
            online_names = []
            try:
                port = self.port_entry.get()
                url = f"http://127.0.0.1:{port}/admin/api/online"
                req = urllib.request.Request(url, method="GET")
                with urllib.request.urlopen(req, timeout=3) as resp:
                    users = json.loads(resp.read().decode('utf-8'))
                    if isinstance(users, list):
                        online_count = len(users)
                        online_names = [u.get('username', '?') for u in users[:10]]
            except Exception:
                pass
            
            if online_count > 0:
                names_str = ", ".join(online_names)
                if online_count > 10:
                    names_str += f" 等{online_count}人"
                if not messagebox.askyesno("警告", 
                    f"当前有 {online_count} 个在线用户:\n{names_str}\n\n"
                    f"关闭服务器将断开所有用户连接！\n确定要停止服务器并退出吗？"):
                    return
            elif not messagebox.askyesno("确认", "服务器正在运行，是否停止并退出？"):
                return
            
            self.stop_server()
            self.destroy()
        else:
            self.destroy()


def main():
    # 检查依赖
    try:
        import customtkinter
        import psutil
    except ImportError:
        print("正在安装依赖...")
        subprocess.run([sys.executable, "-m", "pip", "install", 
                       "customtkinter", "psutil",
                       "-i", "https://pypi.tuna.tsinghua.edu.cn/simple", "-q"])
    
    app = MonitorManager()
    app.protocol("WM_DELETE_WINDOW", app.on_closing)
    app.mainloop()


if __name__ == "__main__":
    main()
