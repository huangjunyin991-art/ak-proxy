import base64

# Generate server command for admin_panel.py
data = open(r'd:\PycharmProjects\ak-proxy\transparent_proxy\admin_panel.py', 'rb').read()
enc = base64.b64encode(data).decode()
cmd = "python3 -c \"import base64;open('/home/ubuntu/ak-proxy/transparent_proxy/admin_panel.py','wb').write(base64.b64decode('" + enc + "'));print('OK')\""

with open(r'd:\PycharmProjects\ak-proxy\admin_cmd.txt', 'w') as f:
    f.write(cmd)

print(f"admin_panel.py command saved ({len(cmd)} chars)")

# Generate server command for nginx config
data2 = open(r'd:\PycharmProjects\ak-proxy\transparent_proxy\nginx_ak2026.conf', 'rb').read()
enc2 = base64.b64encode(data2).decode()
cmd2 = "sudo python3 -c \"import base64;open('/etc/nginx/sites-available/ak-proxy','wb').write(base64.b64decode('" + enc2 + "'));print('OK')\""

with open(r'd:\PycharmProjects\ak-proxy\nginx_fix_cmd.txt', 'w') as f:
    f.write(cmd2)

print(f"nginx config command saved ({len(cmd2)} chars)")
