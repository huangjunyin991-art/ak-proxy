#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Nginx 管理器 - 带GUI界面
功能：启动/停止/重载nginx、编辑配置、查看日志
"""

import customtkinter as ctk
from tkinter import messagebox, filedialog
import subprocess
import os
import psutil
import threading
import time

# ===== 配置 =====
NGINX_DIR = r"C:\Users\Administrator\Desktop\nginx-1.24.0"
NGINX_EXE = os.path.join(NGINX_DIR, "nginx.exe")
NGINX_CONF = os.path.join(NGINX_DIR, "conf", "nginx.conf")
NGINX_ACCESS_LOG = os.path.join(NGINX_DIR, "logs", "access.log")
NGINX_ERROR_LOG = os.path.join(NGINX_DIR, "logs", "error.log")

# 设置主题
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")


class NginxManager(ctk.CTk):
    def __init__(self):
        super().__init__()
        
        self.title("Nginx 管理器")
        self.geometry("1000x700")
        self.minsize(900, 600)
        
        # 状态变量
        self.log_thread = None
        self.log_running = False
        
        self.create_widgets()
        self.update_status()
        
    def create_widgets(self):
        # 主框架
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(1, weight=1)
        
        # ===== 顶部控制面板 =====
        control_frame = ctk.CTkFrame(self)
        control_frame.grid(row=0, column=0, padx=10, pady=10, sticky="ew")
        control_frame.grid_columnconfigure(5, weight=1)
        
        # 状态标签
        self.status_label = ctk.CTkLabel(control_frame, text="状态: 检查中...", 
                                         font=ctk.CTkFont(size=14, weight="bold"))
        self.status_label.grid(row=0, column=0, padx=10, pady=10)
        
        # 控制按钮
        self.start_btn = ctk.CTkButton(control_frame, text="▶ 启动", width=100,
                                       fg_color="green", hover_color="darkgreen",
                                       command=self.start_nginx)
        self.start_btn.grid(row=0, column=1, padx=5, pady=10)
        
        self.stop_btn = ctk.CTkButton(control_frame, text="■ 停止", width=100,
                                      fg_color="red", hover_color="darkred",
                                      command=self.stop_nginx)
        self.stop_btn.grid(row=0, column=2, padx=5, pady=10)
        
        self.reload_btn = ctk.CTkButton(control_frame, text="🔄 重载配置", width=100,
                                        fg_color="orange", hover_color="darkorange",
                                        command=self.reload_nginx)
        self.reload_btn.grid(row=0, column=3, padx=5, pady=10)
        
        self.kill_all_btn = ctk.CTkButton(control_frame, text="💀 杀死所有进程", width=120,
                                          fg_color="#8B0000", hover_color="#5C0000",
                                          command=self.kill_all_nginx)
        self.kill_all_btn.grid(row=0, column=4, padx=5, pady=10)
        
        self.refresh_btn = ctk.CTkButton(control_frame, text="🔍 刷新状态", width=100,
                                         command=self.update_status)
        self.refresh_btn.grid(row=0, column=5, padx=5, pady=10, sticky="e")
        
        # ===== 标签页 =====
        self.tabview = ctk.CTkTabview(self)
        self.tabview.grid(row=1, column=0, padx=10, pady=(0, 10), sticky="nsew")
        
        # 配置编辑标签页
        self.tab_config = self.tabview.add("📝 配置编辑")
        self.tab_config.grid_columnconfigure(0, weight=1)
        self.tab_config.grid_rowconfigure(1, weight=1)
        
        # 访问日志标签页
        self.tab_access_log = self.tabview.add("📋 访问日志")
        self.tab_access_log.grid_columnconfigure(0, weight=1)
        self.tab_access_log.grid_rowconfigure(0, weight=1)
        
        # 错误日志标签页
        self.tab_error_log = self.tabview.add("⚠️ 错误日志")
        self.tab_error_log.grid_columnconfigure(0, weight=1)
        self.tab_error_log.grid_rowconfigure(0, weight=1)
        
        # 进程信息标签页
        self.tab_process = self.tabview.add("📊 进程信息")
        self.tab_process.grid_columnconfigure(0, weight=1)
        self.tab_process.grid_rowconfigure(0, weight=1)
        
        # ===== 配置编辑区 =====
        config_toolbar = ctk.CTkFrame(self.tab_config)
        config_toolbar.grid(row=0, column=0, sticky="ew", pady=(0, 5))
        
        self.config_path_label = ctk.CTkLabel(config_toolbar, text=f"配置文件: {NGINX_CONF}")
        self.config_path_label.pack(side="left", padx=5)
        
        save_btn = ctk.CTkButton(config_toolbar, text="💾 保存配置", width=100,
                                 command=self.save_config)
        save_btn.pack(side="right", padx=5)
        
        reload_config_btn = ctk.CTkButton(config_toolbar, text="📂 重新加载", width=100,
                                          command=self.load_config)
        reload_config_btn.pack(side="right", padx=5)
        
        test_config_btn = ctk.CTkButton(config_toolbar, text="✅ 测试配置", width=100,
                                        fg_color="purple", hover_color="darkviolet",
                                        command=self.test_config)
        test_config_btn.pack(side="right", padx=5)
        
        save_apply_btn = ctk.CTkButton(config_toolbar, text="💾 保存并应用", width=120,
                                       fg_color="green", hover_color="darkgreen",
                                       command=self.save_and_apply_config)
        save_apply_btn.pack(side="right", padx=5)
        
        self.config_text = ctk.CTkTextbox(self.tab_config, font=ctk.CTkFont(family="Consolas", size=12))
        self.config_text.grid(row=1, column=0, sticky="nsew")
        
        # ===== 访问日志区 =====
        access_log_toolbar = ctk.CTkFrame(self.tab_access_log)
        access_log_toolbar.grid(row=0, column=0, sticky="ew", pady=(0, 5))
        
        refresh_access_btn = ctk.CTkButton(access_log_toolbar, text="🔄 刷新", width=80,
                                           command=lambda: self.load_log(NGINX_ACCESS_LOG, self.access_log_text))
        refresh_access_btn.pack(side="left", padx=5)
        
        clear_access_btn = ctk.CTkButton(access_log_toolbar, text="🗑️ 清空", width=80,
                                         command=lambda: self.clear_log(NGINX_ACCESS_LOG, self.access_log_text))
        clear_access_btn.pack(side="left", padx=5)
        
        self.auto_refresh_access = ctk.CTkCheckBox(access_log_toolbar, text="自动刷新")
        self.auto_refresh_access.pack(side="left", padx=10)
        
        self.tab_access_log.grid_rowconfigure(1, weight=1)
        self.access_log_text = ctk.CTkTextbox(self.tab_access_log, font=ctk.CTkFont(family="Consolas", size=11))
        self.access_log_text.grid(row=1, column=0, sticky="nsew")
        
        # ===== 错误日志区 =====
        error_log_toolbar = ctk.CTkFrame(self.tab_error_log)
        error_log_toolbar.grid(row=0, column=0, sticky="ew", pady=(0, 5))
        
        refresh_error_btn = ctk.CTkButton(error_log_toolbar, text="🔄 刷新", width=80,
                                          command=lambda: self.load_log(NGINX_ERROR_LOG, self.error_log_text))
        refresh_error_btn.pack(side="left", padx=5)
        
        clear_error_btn = ctk.CTkButton(error_log_toolbar, text="🗑️ 清空", width=80,
                                        command=lambda: self.clear_log(NGINX_ERROR_LOG, self.error_log_text))
        clear_error_btn.pack(side="left", padx=5)
        
        self.auto_refresh_error = ctk.CTkCheckBox(error_log_toolbar, text="自动刷新")
        self.auto_refresh_error.pack(side="left", padx=10)
        
        self.tab_error_log.grid_rowconfigure(1, weight=1)
        self.error_log_text = ctk.CTkTextbox(self.tab_error_log, font=ctk.CTkFont(family="Consolas", size=11))
        self.error_log_text.grid(row=1, column=0, sticky="nsew")
        
        # ===== 进程信息区 =====
        process_toolbar = ctk.CTkFrame(self.tab_process)
        process_toolbar.grid(row=0, column=0, sticky="ew", pady=(0, 5))
        
        refresh_process_btn = ctk.CTkButton(process_toolbar, text="🔄 刷新进程列表", width=120,
                                            command=self.refresh_process_list)
        refresh_process_btn.pack(side="left", padx=5)
        
        self.tab_process.grid_rowconfigure(1, weight=1)
        self.process_text = ctk.CTkTextbox(self.tab_process, font=ctk.CTkFont(family="Consolas", size=11))
        self.process_text.grid(row=1, column=0, sticky="nsew")
        
        # 加载初始数据
        self.load_config()
        self.start_auto_refresh()
        
    def get_nginx_processes(self):
        """获取所有nginx进程"""
        processes = []
        for proc in psutil.process_iter(['pid', 'name', 'cmdline', 'create_time', 'memory_info']):
            try:
                if proc.info['name'] and 'nginx' in proc.info['name'].lower():
                    processes.append(proc)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        return processes
    
    def update_status(self):
        """更新nginx状态"""
        processes = self.get_nginx_processes()
        if processes:
            self.status_label.configure(text=f"状态: ✅ 运行中 ({len(processes)}个进程)", 
                                       text_color="lightgreen")
            self.start_btn.configure(state="disabled")
            self.stop_btn.configure(state="normal")
            self.reload_btn.configure(state="normal")
        else:
            self.status_label.configure(text="状态: ❌ 已停止", text_color="red")
            self.start_btn.configure(state="normal")
            self.stop_btn.configure(state="disabled")
            self.reload_btn.configure(state="disabled")
    
    def start_nginx(self):
        """启动nginx"""
        try:
            if not os.path.exists(NGINX_EXE):
                messagebox.showerror("错误", f"找不到nginx.exe: {NGINX_EXE}")
                return
            
            # 先测试配置
            result = subprocess.run([NGINX_EXE, "-t"], 
                                   capture_output=True, text=True, cwd=NGINX_DIR)
            if result.returncode != 0:
                messagebox.showerror("配置错误", f"配置文件有错误:\n{result.stderr}")
                return
            
            # 启动nginx
            subprocess.Popen([NGINX_EXE], cwd=NGINX_DIR, 
                           creationflags=subprocess.CREATE_NO_WINDOW)
            time.sleep(1)
            self.update_status()
            messagebox.showinfo("成功", "Nginx 已启动")
        except Exception as e:
            messagebox.showerror("错误", f"启动失败: {e}")
    
    def stop_nginx(self):
        """停止nginx"""
        try:
            subprocess.run([NGINX_EXE, "-s", "stop"], cwd=NGINX_DIR,
                          capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            time.sleep(1)
            self.update_status()
            messagebox.showinfo("成功", "Nginx 已停止")
        except Exception as e:
            messagebox.showerror("错误", f"停止失败: {e}")
    
    def reload_nginx(self):
        """重载nginx配置"""
        try:
            # 先测试配置
            result = subprocess.run([NGINX_EXE, "-t"], 
                                   capture_output=True, text=True, cwd=NGINX_DIR)
            if result.returncode != 0:
                messagebox.showerror("配置错误", f"配置文件有错误:\n{result.stderr}")
                return
            
            # 重载配置
            subprocess.run([NGINX_EXE, "-s", "reload"], cwd=NGINX_DIR,
                          capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            messagebox.showinfo("成功", "配置已重新加载")
        except Exception as e:
            messagebox.showerror("错误", f"重载失败: {e}")
    
    def kill_all_nginx(self):
        """杀死所有nginx进程"""
        if not messagebox.askyesno("确认", "确定要杀死所有Nginx进程吗？"):
            return
        
        processes = self.get_nginx_processes()
        killed = 0
        for proc in processes:
            try:
                proc.kill()
                killed += 1
            except (psutil.NoSuchProcess, psutil.AccessDenied) as e:
                pass
        
        time.sleep(1)
        self.update_status()
        messagebox.showinfo("完成", f"已杀死 {killed} 个Nginx进程")
    
    def load_config(self):
        """加载配置文件"""
        try:
            if os.path.exists(NGINX_CONF):
                with open(NGINX_CONF, 'r', encoding='utf-8') as f:
                    content = f.read()
                self.config_text.delete("1.0", "end")
                self.config_text.insert("1.0", content)
            else:
                messagebox.showerror("错误", f"配置文件不存在: {NGINX_CONF}")
        except Exception as e:
            messagebox.showerror("错误", f"加载配置失败: {e}")
    
    def save_config(self):
        """保存配置文件"""
        try:
            content = self.config_text.get("1.0", "end-1c")
            with open(NGINX_CONF, 'w', encoding='utf-8') as f:
                f.write(content)
            messagebox.showinfo("成功", "配置已保存")
        except Exception as e:
            messagebox.showerror("错误", f"保存配置失败: {e}")
    
    def test_config(self):
        """测试配置文件语法"""
        try:
            # 先保存当前编辑的内容到临时位置或直接测试
            result = subprocess.run([NGINX_EXE, "-t"], 
                                   capture_output=True, text=True, cwd=NGINX_DIR)
            if result.returncode == 0:
                messagebox.showinfo("测试通过", f"配置文件语法正确!\n{result.stderr}")
            else:
                messagebox.showerror("测试失败", f"配置文件有错误:\n{result.stderr}")
        except Exception as e:
            messagebox.showerror("错误", f"测试失败: {e}")
    
    def save_and_apply_config(self):
        """保存配置并立即应用"""
        try:
            # 保存配置
            content = self.config_text.get("1.0", "end-1c")
            with open(NGINX_CONF, 'w', encoding='utf-8') as f:
                f.write(content)
            
            # 测试配置
            result = subprocess.run([NGINX_EXE, "-t"], 
                                   capture_output=True, text=True, cwd=NGINX_DIR)
            if result.returncode != 0:
                messagebox.showerror("配置错误", f"配置文件有错误，未应用:\n{result.stderr}")
                return
            
            # 检查nginx是否运行
            processes = self.get_nginx_processes()
            if processes:
                # 重载配置
                subprocess.run([NGINX_EXE, "-s", "reload"], cwd=NGINX_DIR,
                              capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
                messagebox.showinfo("成功", "配置已保存并重新加载")
            else:
                # 启动nginx
                subprocess.Popen([NGINX_EXE], cwd=NGINX_DIR,
                               creationflags=subprocess.CREATE_NO_WINDOW)
                time.sleep(1)
                messagebox.showinfo("成功", "配置已保存，Nginx已启动")
            
            self.update_status()
        except Exception as e:
            messagebox.showerror("错误", f"操作失败: {e}")
    
    def load_log(self, log_path, text_widget, tail_lines=200):
        """加载日志文件"""
        try:
            if os.path.exists(log_path):
                with open(log_path, 'r', encoding='utf-8', errors='ignore') as f:
                    lines = f.readlines()
                    # 只显示最后N行
                    content = ''.join(lines[-tail_lines:])
                text_widget.delete("1.0", "end")
                text_widget.insert("1.0", content)
                text_widget.see("end")
            else:
                text_widget.delete("1.0", "end")
                text_widget.insert("1.0", f"日志文件不存在: {log_path}")
        except Exception as e:
            text_widget.delete("1.0", "end")
            text_widget.insert("1.0", f"加载日志失败: {e}")
    
    def clear_log(self, log_path, text_widget):
        """清空日志文件"""
        if not messagebox.askyesno("确认", f"确定要清空日志文件吗?\n{log_path}"):
            return
        try:
            with open(log_path, 'w', encoding='utf-8') as f:
                f.write('')
            text_widget.delete("1.0", "end")
            messagebox.showinfo("成功", "日志已清空")
        except Exception as e:
            messagebox.showerror("错误", f"清空日志失败: {e}")
    
    def refresh_process_list(self):
        """刷新进程列表"""
        processes = self.get_nginx_processes()
        self.process_text.delete("1.0", "end")
        
        if not processes:
            self.process_text.insert("1.0", "没有运行中的Nginx进程")
            return
        
        info = f"找到 {len(processes)} 个Nginx进程:\n"
        info += "=" * 80 + "\n"
        info += f"{'PID':<10} {'内存(MB)':<12} {'创建时间':<25} {'命令行'}\n"
        info += "-" * 80 + "\n"
        
        for proc in processes:
            try:
                pid = proc.info['pid']
                memory = proc.info['memory_info'].rss / 1024 / 1024 if proc.info['memory_info'] else 0
                create_time = time.strftime('%Y-%m-%d %H:%M:%S', 
                                           time.localtime(proc.info['create_time'])) if proc.info['create_time'] else 'N/A'
                cmdline = ' '.join(proc.info['cmdline']) if proc.info['cmdline'] else 'N/A'
                info += f"{pid:<10} {memory:<12.2f} {create_time:<25} {cmdline}\n"
            except:
                pass
        
        self.process_text.insert("1.0", info)
    
    def start_auto_refresh(self):
        """启动自动刷新线程"""
        def refresh_loop():
            while True:
                time.sleep(3)
                try:
                    # 自动刷新日志
                    if hasattr(self, 'auto_refresh_access') and self.auto_refresh_access.get():
                        self.after(0, lambda: self.load_log(NGINX_ACCESS_LOG, self.access_log_text))
                    if hasattr(self, 'auto_refresh_error') and self.auto_refresh_error.get():
                        self.after(0, lambda: self.load_log(NGINX_ERROR_LOG, self.error_log_text))
                except:
                    pass
        
        thread = threading.Thread(target=refresh_loop, daemon=True)
        thread.start()


def main():
    # 检查customtkinter是否安装
    try:
        import customtkinter
    except ImportError:
        print("正在安装 customtkinter...")
        subprocess.run(["python", "-m", "pip", "install", "customtkinter", 
                       "-i", "https://pypi.tuna.tsinghua.edu.cn/simple"])
        import customtkinter
    
    # 检查psutil是否安装
    try:
        import psutil
    except ImportError:
        print("正在安装 psutil...")
        subprocess.run(["python", "-m", "pip", "install", "psutil",
                       "-i", "https://pypi.tuna.tsinghua.edu.cn/simple"])
        import psutil
    
    app = NginxManager()
    app.mainloop()


if __name__ == "__main__":
    main()
