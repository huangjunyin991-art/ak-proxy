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
    "requirements.txt": "依赖配置"
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
        
        # 全局快捷键
        self.bind("<Control-s>", lambda e: self.save_file())
        self.bind("<Control-S>", lambda e: self.save_file())
        
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
        if proc or self.server_process:
            port = self.port_entry.get()
            self.status_label.configure(text=f"状态: ✅ 运行中 (端口 {port})", text_color="lightgreen")
            self.start_btn.configure(state="disabled")
            self.stop_btn.configure(state="normal")
        else:
            self.status_label.configure(text="状态: ❌ 已停止", text_color="red")
            self.start_btn.configure(state="normal")
            self.stop_btn.configure(state="disabled")
    
    def start_server(self):
        """启动服务器"""
        port = self.port_entry.get()
        
        try:
            # 检查依赖
            self.log_text.insert("end", f"[INFO] 检查并安装依赖...\n")
            subprocess.run([sys.executable, "-m", "pip", "install", "-r", "requirements.txt",
                          "-i", "https://pypi.tuna.tsinghua.edu.cn/simple", "-q"],
                         capture_output=True)
            
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
        """停止服务器"""
        self.log_running = False
        
        # 停止进程
        if self.server_process:
            self.server_process.terminate()
            self.server_process = None
        
        # 查找并终止其他服务器进程
        proc = self.find_server_process()
        if proc:
            try:
                proc.terminate()
            except:
                pass
        
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
    
    def on_closing(self):
        """关闭窗口时的处理"""
        if self.server_process:
            if messagebox.askyesno("确认", "服务器正在运行，是否停止并退出？"):
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
