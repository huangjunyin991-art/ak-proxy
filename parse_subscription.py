#!/usr/bin/env python3
import base64
import json
import urllib.parse
import sys

def parse_vless(url):
    """解析VLESS链接"""
    try:
        parts = url.replace('vless://', '').split('@')
        if len(parts) != 2:
            return None
        
        uuid = parts[0]
        rest = parts[1]
        
        if '?' in rest:
            server_port, params_and_name = rest.split('?', 1)
        else:
            return None
            
        server, port = server_port.rsplit(':', 1)
        
        if '#' in params_and_name:
            params_str, name = params_and_name.split('#', 1)
            name = urllib.parse.unquote(name)
        else:
            params_str = params_and_name
            name = server
        
        params = dict(urllib.parse.parse_qsl(params_str))
        
        outbound = {
            "type": "vless",
            "tag": name,
            "server": server,
            "server_port": int(port),
            "uuid": uuid,
            "flow": params.get('flow', ''),
            "tls": {
                "enabled": params.get('security') in ['tls', 'reality'],
                "server_name": params.get('sni', server),
                "insecure": False
            }
        }
        
        if params.get('security') == 'reality':
            outbound["tls"]["reality"] = {
                "enabled": True,
                "public_key": params.get('pbk', ''),
                "short_id": params.get('sid', '')
            }
            outbound["tls"]["utls"] = {
                "enabled": True,
                "fingerprint": params.get('fp', 'chrome')
            }
        
        transport_type = params.get('type', 'tcp')
        if transport_type == 'ws':
            outbound["transport"] = {
                "type": "ws",
                "path": params.get('path', '/'),
                "headers": {"Host": params.get('host', server)}
            }
        
        return outbound
    except Exception as e:
        print(f"Error parsing VLESS: {e}", file=sys.stderr)
        return None

def parse_hysteria2(url):
    """解析Hysteria2链接"""
    try:
        parts = url.replace('hysteria2://', '').split('@')
        if len(parts) != 2:
            return None
        
        uuid = parts[0]
        rest = parts[1]
        
        if '?' in rest or '/' in rest:
            server_port = rest.split('?')[0].split('/')[0]
        else:
            server_port = rest.split('#')[0]
            
        if '#' in rest:
            name = urllib.parse.unquote(rest.split('#')[1])
        else:
            name = server_port
        
        server, port = server_port.rsplit(':', 1)
        
        outbound = {
            "type": "hysteria2",
            "tag": name,
            "server": server,
            "server_port": int(port),
            "password": uuid,
            "tls": {
                "enabled": True,
                "insecure": True
            }
        }
        
        return outbound
    except Exception as e:
        print(f"Error parsing Hysteria2: {e}", file=sys.stderr)
        return None

# 读取订阅内容（Base64编码）
sub_content = """
dmxlc3M6Ly81MzA0ZWNjYy03ZDc4LTQ3NDEtYWI3MS0yN2ZkNmYwYzBmOGVAYXdzLWxpbmsxLmxpYW5neGluMS54eXo6MzUyNDg/dHlwZT10Y3AmZW5jcnlwdGlvbj1ub25lJmhvc3Q9JnBhdGg9JmhlYWRlclR5cGU9bm9uZSZxdWljU2VjdXJpdHk9bm9uZSZzZXJ2aWNlTmFtZT0mc2VjdXJpdHk9cmVhbGl0eSZmbG93PXh0bHMtcnByeC12aXNpb24mZnA9Y2hyb21lJnNuaT13d3cubGFtZXIuY29tLmhrJnBiaz1JR3NTeEMwd2duN3dMeTBOTTBRTl95T1JFREtUXzgxNFlfM19yYmdEb1RjJnNpZD1jOGMwZjk1MSMlRTUlODklQTklRTQlQkQlOTklRTYlQjUlODElRTklODclOEYlRUYlQkMlOUE5OTkuOTklMjBHQg0Kdmxlc3M6Ly81MzA0ZWNjYy03ZDc4LTQ3NDEtYWI3MS0yN2ZkNmYwYzBmOGVAYXdzLWxpbmsxLmxpYW5neGluMS54eXo6MzUyNDg/dHlwZT10Y3AmZW5jcnlwdGlvbj1ub25lJmhvc3Q9JnBhdGg9JmhlYWRlclR5cGU9bm9uZSZxdWljU2VjdXJpdHk9bm9uZSZzZXJ2aWNlTmFtZT0mc2VjdXJpdHk9cmVhbGl0eSZmbG93PXh0bHMtcnByeC12aXNpb24mZnA9Y2hyb21lJnNuaT13d3cubGFtZXIuY29tLmhrJnBiaz1JR3NTeEMwd2duN3dMeTBOTTBRTl95T1JFREtUXzgxNFlfM19yYmdEb1RjJnNpZD1jOGMwZjk1MSMlRTUlQTUlOTclRTklQTQlOTAlRTUlODglQjAlRTYlOUMlOUYlRUYlQkMlOUElRTklOTUlQkYlRTYlOUMlOUYlRTYlOUMlODklRTYlOTUlODgNCnZsZXNzOi8vNTMwNGVjY2MtN2Q3OC00NzQxLWFiNzEtMjdmZDZmMGMwZjhlQGF3cy1saW5rMS5saWFuZ3hpbjEueHl6OjM1MjQ4P3R5cGU9dGNwJmVuY3J5cHRpb249bm9uZSZob3N0PSZwYXRoPSZoZWFkZXJUeXBlPW5vbmUmcXVpY1NlY3VyaXR5PW5vbmUmc2VydmljZU5hbWU9JnNlY3VyaXR5PXJlYWxpdHkmZmxvdz14dGxzLXJwcngtdmlzaW9uJmZwPWNocm9tZSZzbmk9d3d3LmxhbWVyLmNvbS5oayZwYms9SUdzU3hDMHdnbjd3THkwTk0wUU5feU9SRURLVF84MTRZXzNfcmJnRG9UYyZzaWQ9YzhjMGY5NTEjJUYwJTlGJTg3JUFEJUYwJTlGJTg3JUIwJUU5JUE2JTk5JUU2JUI4JUFGJUU5JUFCJTk4JUU5JTgwJTlGMDElN0NCR1AlN0MlRTYlQjUlODElRTUlQUElOTIlRTQlQkQlOTMNCnZsZXNzOi8vNTMwNGVjY2MtN2Q3OC00NzQxLWFiNzEtMjdmZDZmMGMwZjhlQGF3cy1saW5rMi5saWFuZ3hpbjEueHl6OjM4NzI1P3R5cGU9dGNwJmVuY3J5cHRpb249bm9uZSZob3N0PSZwYXRoPSZoZWFkZXJUeXBlPW5vbmUmcXVpY1NlY3VyaXR5PW5vbmUmc2VydmljZU5hbWU9JnNlY3VyaXR5PXJlYWxpdHkmZmxvdz14dGxzLXJwcngtdmlzaW9uJmZwPWNocm9tZSZzbmk9d3d3LmxhbWVyLmNvbS5oayZwYms9SHZ3bkxCTU1Lc212Z2hHWDV5VlBxM0oySFd4d3IxR0dRQjJXSXZiUHZBWSZzaWQ9OGY2Y2EzNzgjJUYwJTlGJTg3JUFEJUYwJTlGJTg3JUIwJUU5JUE2JTk5JUU2JUI4JUFGJUU5JUFCJTk4JUU5JTgwJTlGMDIlN0NCR1AlN0MlRTYlQjUlODElRTUlQUElOTIlRTQlQkQlOTMNCnZsZXNzOi8vNTMwNGVjY2MtN2Q3OC00NzQxLWFiNzEtMjdmZDZmMGMwZjhlQGF3cy1saW5rMy5saWFuZ3hpbjEueHl6OjI3NzU4P3R5cGU9dGNwJmVuY3J5cHRpb249bm9uZSZob3N0PSZwYXRoPSZoZWFkZXJUeXBlPW5vbmUmcXVpY1NlY3VyaXR5PW5vbmUmc2VydmljZU5hbWU9JnNlY3VyaXR5PXJlYWxpdHkmZmxvdz14dGxzLXJwcngtdmlzaW9uJmZwPWNocm9tZSZzbmk9d3d3LmxhbWVyLmNvbS5oayZwYms9RVlhNGljM0dBeHF6blY2MVUtT093dy1XS3N1NXd1UVFwdHlTM2Z3N2N6TSZzaWQ9YzUwZGIzOWYjJUYwJTlGJTg3JUFEJUYwJTlGJTg3JUIwJUU5JUE2JTk5JUU2JUI4JUFGJUU5JUFCJTk4JUU5JTgwJTlGMDMlN0NCR1AlN0MlRTYlQjUlODElRTUlQUElOTIlRTQlQkQlOTMNCnZsZXNzOi8vNTMwNGVjY2MtN2Q3OC00NzQxLWFiNzEtMjdmZDZmMGMwZjhlQGF3cy1saW5rNC5saWFuZ3hpbjEueHl6OjQ0Mz90eXBlPXRjcCZlbmNyeXB0aW9uPW5vbmUmaG9zdD0mcGF0aD0maGVhZGVyVHlwZT1ub25lJnF1aWNTZWN1cml0eT1ub25lJnNlcnZpY2VOYW1lPSZzZWN1cml0eT1yZWFsaXR5JmZsb3c9eHRscy1ycHJ4LXZpc2lvbiZmcD1jaHJvbWUmc25pPXd3dy5sYW1lci5jb20uaGsmcGJrPTNGUEdUYXhrZk9NM25FVVdVeUNpcWtINW9KR3NPeC1XeFBKZkFEaTFRV1kmc2lkPTdmMzY5ZTE0IyVGMCU5RiU4NyVBRCVGMCU5RiU4NyVCMCVFOSVBNiU5OSVFNiVCOCVBRiVFOSVBQiU5OCVFOSU4MCU5RjA0JTdDQkdQJTdDJUU2JUI1JTgxJUU1JUFBJTkyJUU0JUJEJTkzDQp2bGVzczovLzUzMDRlY2NjLTdkNzgtNDc0MS1hYjcxLTI3ZmQ2ZjBjMGY4ZUBhd3MtbGluazcubGlhbmd4aW4xLnh5ejo0ODU3ND90eXBlPXRjcCZlbmNyeXB0aW9uPW5vbmUmaG9zdD0mcGF0aD0maGVhZGVyVHlwZT1ub25lJnF1aWNTZWN1cml0eT1ub25lJnNlcnZpY2VOYW1lPSZzZWN1cml0eT1yZWFsaXR5JmZsb3c9eHRscy1ycHJ4LXZpc2lvbiZmcD1jaHJvbWUmc25pPXd3dy5sYW1lci5jb20uc2cmcGJrPWxteFNheU44dFVnMkRhZzJNUFhyZHFaMlNRSzlLM09qbGFLazh3VkNSbmMmc2lkPWY4ZjE4OTAyIyVGMCU5RiU4NyVCOCVGMCU5RiU4NyVBQyVFNiU5NiVCMCVFNSU4QSVBMCVFNSU5RCVBMSVFOSVBQiU5OCVFOSU4MCU5RjAxJTdDQkdQJTdDJUU2JUI1JTgxJUU1JUFBJTkyJUU0JUJEJTkzDQp2bGVzczovLzUzMDRlY2NjLTdkNzgtNDc0MS1hYjcxLTI3ZmQ2ZjBjMGY4ZUBhd3MtbGluazgubGlhbmd4aW4xLnh5ejozOTY0NT90eXBlPXRjcCZlbmNyeXB0aW9uPW5vbmUmaG9zdD0mcGF0aD0maGVhZGVyVHlwZT1ub25lJnF1aWNTZWN1cml0eT1ub25lJnNlcnZpY2VOYW1lPSZzZWN1cml0eT1yZWFsaXR5JmZsb3c9eHRscy1ycHJ4LXZpc2lvbiZmcD1jaHJvbWUmc25pPWlvc2FwcHMuaXR1bmVzLmFwcGxlLmNvbSZwYms9eDdWcXBGUDdfUHJZNGViTnc4aGk4RWM1VG01VXBtdDVKT2RyTjFNOVZuUSZzaWQ9MmIzYjBiOTMjJUYwJTlGJTg3JUI4JUYwJTlGJTg3JUFDJUU2JTk2JUIwJUU1JThBJUEwJUU1JTlEJUExJUU5JUFCJTk4JUU5JTgwJTlGMDIlN0NCR1AlN0MlRTYlQjUlODElRTUlQUElOTIlRTQlQkQlOTMNCnZsZXNzOi8vNTMwNGVjY2MtN2Q3OC00NzQxLWFiNzEtMjdmZDZmMGMwZjhlQGF3cy1saW5rOS5saWFuZ3hpbjEueHl6OjIzNTg3P3R5cGU9dGNwJmVuY3J5cHRpb249bm9uZSZob3N0PSZwYXRoPSZoZWFkZXJUeXBlPW5vbmUmcXVpY1NlY3VyaXR5PW5vbmUmc2VydmljZU5hbWU9JnNlY3VyaXR5PXJlYWxpdHkmZmxvdz14dGxzLXJwcngtdmlzaW9uJmZwPWNocm9tZSZzbmk9aW9zYXBwcy5pdHVuZXMuYXBwbGUuY29tJnBiaz1INjZQTExmNkhrWndIazRvRnFpc2ZUYXdJdncyY3hrRXdrOFVlOHNIWmdBJnNpZD0xOWI1ODBhZSMlRjAlOUYlODclQjglRjAlOUYlODclQUMlRTYlOTYlQjAlRTUlOEElQTAlRTUlOUQlQTElRTklQUIlOTglRTklODAlOUYwMyU3Q0JHUCU3QyVFNiVCNSU4MSVFNSVBQSU5MiVFNCVCRCU5Mw0Kdmxlc3M6Ly81MzA0ZWNjYy03ZDc4LTQ3NDEtYWI3MS0yN2ZkNmYwYzBmOGVAYXdzLWxpbmsxMC5saWFuZ3hpbjEueHl6OjQ0Mz90eXBlPXRjcCZlbmNyeXB0aW9uPW5vbmUmaG9zdD0mcGF0aD0maGVhZGVyVHlwZT1ub25lJnF1aWNTZWN1cml0eT1ub25lJnNlcnZpY2VOYW1lPSZzZWN1cml0eT1yZWFsaXR5JmZsb3c9eHRscy1ycHJ4LXZpc2lvbiZmcD1jaHJvbWUmc25pPXd3dy5sYW1lci5jb20uc2cmcGJrPXhRTzdDQmg2eW1TVzlxZnc5T0dIeWtoN1BMVHpXUVpqeERULUg0dWwyQUUmc2lkPTJiYjZkYTg4IyVGMCU5RiU4NyVCOCVGMCU5RiU4NyVBQyVFNiU5NiVCMCVFNSU4QSVBMCVFNSU5RCVBMSVFOSVBQiU5OCVFOSU4MCU5RjA0JTdDQkdQJTdDJUU2JUI1JTgxJUU1JUFBJTkyJUU0JUJEJTkzDQp2bGVzczovLzUzMDRlY2NjLTdkNzgtNDc0MS1hYjcxLTI3ZmQ2ZjBjMGY4ZUBhd3MtbGluazEzLmxpYW5neGluMS54eXo6MzY1NzQ/dHlwZT10Y3AmZW5jcnlwdGlvbj1ub25lJmhvc3Q9JnBhdGg9JmhlYWRlclR5cGU9bm9uZSZxdWljU2VjdXJpdHk9bm9uZSZzZXJ2aWNlTmFtZT0mc2VjdXJpdHk9cmVhbGl0eSZmbG93PXh0bHMtcnByeC12aXNpb24mZnA9Y2hyb21lJnNuaT13d3cuYXBwbGUuY29tLmNuJnBiaz1zREctS1FrMUJGN1Y4My14bm1yV0RvdVh4cFBkX1pTeEtjSHJKSnpib2xzJnNpZD0zMmEzNjUwZCMlRjAlOUYlODclQUYlRjAlOUYlODclQjUlRTYlOTclQTUlRTYlOUMlQUMlRTklQUIlOTglRTklODAlOUYwMSU3Q0JHUCU3QyVFNiVCNSU4MSVFNSVBQSU5MiVFNCVCRCU5Mw0Kdmxlc3M6Ly81MzA0ZWNjYy03ZDc4LTQ3NDEtYWI3MS0yN2ZkNmYwYzBmOGVAYXdzLWxpbmsxNC5saWFuZ3hpbjEueHl6OjI1NDg1P3R5cGU9dGNwJmVuY3J5cHRpb249bm9uZSZob3N0PSZwYXRoPSZoZWFkZXJUeXBlPW5vbmUmcXVpY1NlY3VyaXR5PW5vbmUmc2VydmljZU5hbWU9JnNlY3VyaXR5PXJlYWxpdHkmZmxvdz14dGxzLXJwcngtdmlzaW9uJmZwPWNocm9tZSZzbmk9d3d3LmFwcGxlLmNvbS5jbiZwYms9Vk9GU2pqV1Qwd0lIM1EwbnR5RVpkOFd3a3NySUFiNWdQdF8zUEJuRUFTZyZzaWQ9OWM1YjhjNTMjJUYwJTlGJTg3JUFGJUYwJTlGJTg3JUI1JUU2JTk3JUE1JUU2JTlDJUFDJUU5JUFCJTk4JUU5JTgwJTlGMDIlN0NCR1AlN0MlRTYlQjUlODElRTUlQUElOTIlRTQlQkQlOTMNCnZsZXNzOi8vNTMwNGVjY2MtN2Q3OC00NzQxLWFiNzEtMjdmZDZmMGMwZjhlQGF3cy1saW5rMTUubGlhbmd4aW4xLnh5ejozNTQ1Nz90eXBlPXRjcCZlbmNyeXB0aW9uPW5vbmUmaG9zdD0mcGF0aD0maGVhZGVyVHlwZT1ub25lJnF1aWNTZWN1cml0eT1ub25lJnNlcnZpY2VOYW1lPSZzZWN1cml0eT1yZWFsaXR5JmZsb3c9eHRscy1ycHJ4LXZpc2lvbiZmcD1jaHJvbWUmc25pPXd3dy5hcHBsZS5jb20uY24mcGJrPTNnYi1hRzZxTENKcEVPRnJFUFo5cUtxTHZWUEFfb3ZsdTBYMVB2amNFMGsmc2lkPTA1Mjg4ZGIzIyVGMCU5RiU4NyVBRiVGMCU5RiU4NyVCNSVFNiU5NyVBNSVFNiU5QyVBQyVFOSVBQiU5OCVFOSU4MCU5RjAzJTdDQkdQJTdDJUU2JUI1JTgxJUU1JUFBJTkyJUU0JUJEJTkzDQp2bGVzczovLzUzMDRlY2NjLTdkNzgtNDc0MS1hYjcxLTI3ZmQ2ZjBjMGY4ZUBjZnllcy5seHkxMDE1LnRvcDo0NDM/dHlwZT13cyZlbmNyeXB0aW9uPW5vbmUmaG9zdD1seC0xanAubHh5MTAxNS50b3AmcGF0aD0lMkZsaWFuZ3hpbiUyRmpwMSZoZWFkZXJUeXBlPW5vbmUmcXVpY1NlY3VyaXR5PW5vbmUmc2VydmljZU5hbWU9JnNlY3VyaXR5PXRscyZmcD1jaHJvbWUmc25pPWx4czFqcC5seHkxMDE1LnRvcCMlRjAlOUYlODclQUYlRjAlOUYlODclQjUlRTYlOTclQTUlRTYlOUMlQUMlRTklQUIlOTglRTklODAlOUYwNCU3Q0JHUCU3QyVFNiVCNSU4MSVFNSVBQSU5MiVFNCVCRCU5Mw0Kdmxlc3M6Ly81MzA0ZWNjYy03ZDc4LTQ3NDEtYWI3MS0yN2ZkNmYwYzBmOGVAY2Z5ZXMubHh5MTAxNS50b3A6NDQzP3R5cGU9d3MmZW5jcnlwdGlvbj1ub25lJmhvc3Q9bHgtMWpwLmx4eTEwMTUudG9wJnBhdGg9JTJGbGlhbmd4aW4lMkZqcDEmaGVhZGVyVHlwZT1ub25lJnF1aWNTZWN1cml0eT1ub25lJnNlcnZpY2VOYW1lPSZzZWN1cml0eT10bHMmZnA9Y2hyb21lJnNuaT1seHMxanAubHh5MTAxNS50b3AjJUYwJTlGJTg3JUFGJUYwJTlGJTg3JUI1JUU2JTk3JUE1JUU2JTlDJUFDJUU5JUFCJTk4JUU5JTgwJTlGMDUlN0NCR1AlN0MlRTYlQjUlODElRTUlQUElOTIlRTQlQkQlOTMNCnZsZXNzOi8vNTMwNGVjY2MtN2Q3OC00NzQxLWFiNzEtMjdmZDZmMGMwZjhlQGNmeWVzLmx4eTEwMTUudG9wOjQ0Mz90eXBlPXdzJmVuY3J5cHRpb249bm9uZSZob3N0PWx4LTFqcC5seHkxMDE1LnRvcCZwYXRoPSUyRmxpYW5neGluJTJGanAxJmhlYWRlclR5cGU9bm9uZSZxdWljU2VjdXJpdHk9bm9uZSZzZXJ2aWNlTmFtZT0mc2VjdXJpdHk9dGxzJmZwPWNocm9tZSZzbmk9bHhzMWpwLmx4eTEwMTUudG9wIyVGMCU5RiU4NyVBRiVGMCU5RiU4NyVCNSVFNiU5NyVBNSVFNiU5QyVBQyVFOSVBQiU5OCVFOSU4MCU5RjA2JTdDQkdQJTdDJUU2JUI1JTgxJUU1JUFBJTkyJUU0JUJEJTkzDQp2bGVzczovLzUzMDRlY2NjLTdkNzgtNDc0MS1hYjcxLTI3ZmQ2ZjBjMGY4ZUBhd3MtbGluazE5LmxpYW5neGluMS54eXo6NDQzP3R5cGU9dGNwJmVuY3J5cHRpb249bm9uZSZob3N0PSZwYXRoPSZoZWFkZXJUeXBlPW5vbmUmcXVpY1NlY3VyaXR5PW5vbmUmc2VydmljZU5hbWU9JnNlY3VyaXR5PXJlYWxpdHkmZmxvdz14dGxzLXJwcngtdmlzaW9uJmZwPWNocm9tZSZzbmk9ZG93bmxvYWQtcG9ydGVyLmhveW92ZXJzZS5jb20mcGJrPVFFNWwwUlVxczRPc0gzajN1X3hIbTA2LTRObElMbVFpdlpVSnFpRXgxMW8mc2lkPTYzMTRlODI1IyVGMCU5RiU4NyVCQSVGMCU5RiU4NyVCOCVFNyVCRSU4RSVFNSU5QiVCRCVFOSVBQiU5OCVFOSU4MCU5RjAxJTdDJUU2JUI1JTgxJUU1JUFBJTkyJUU0JUJEJTkzJTIwMC4xJUU1JTgwJThEDQp2bGVzczovLzUzMDRlY2NjLTdkNzgtNDc0MS1hYjcxLTI3ZmQ2ZjBjMGY4ZUBjZnllcy5seHkxMDE1LnRvcDo0NDM/dHlwZT13cyZlbmNyeXB0aW9uPW5vbmUmaG9zdD1seC11czEubHh5MTAxNS50b3AmcGF0aD0lMkZsaWFuZ3hpbiUyRnVzJmhlYWRlclR5cGU9bm9uZSZxdWljU2VjdXJpdHk9bm9uZSZzZXJ2aWNlTmFtZT0mc2VjdXJpdHk9dGxzJmZwPWNocm9tZSZzbmk9bHgtdXMxLmx4eTEwMTUudG9wIyVGMCU5RiU4NyVCQSVGMCU5RiU4NyVCOCVFNyVCRSU4RSVFNSU5QiVCRCVFOSVBQiU5OCVFOSU4MCU5RjAzJTdDJUU2JUI1JTgxJUU1JUFBJTkyJUU0JUJEJTkzDQp2bGVzczovLzUzMDRlY2NjLTdkNzgtNDc0MS1hYjcxLTI3ZmQ2ZjBjMGY4ZUBjZnllcy5seHkxMDE1LnRvcDo0NDM/dHlwZT13cyZlbmNyeXB0aW9uPW5vbmUmaG9zdD1seC11czEubHh5MTAxNS50b3AmcGF0aD0lMkZsaWFuZ3hpbiUyRnVzJmhlYWRlclR5cGU9bm9uZSZxdWljU2VjdXJpdHk9bm9uZSZzZXJ2aWNlTmFtZT0mc2VjdXJpdHk9dGxzJmZwPWNocm9tZSZzbmk9bHgtdXMxLmx4eTEwMTUudG9wIyVGMCU5RiU4NyVCQSVGMCU5RiU4NyVCOCVFNyVCRSU4RSVFNSU5QiVCRCVFOSVBQiU5OCVFOSU4MCU5RjA0JTdDJUU2JUI1JTgxJUU1JUFBJTkyJUU0JUJEJTkzDQp2bGVzczovLzUzMDRlY2NjLTdkNzgtNDc0MS1hYjcxLTI3ZmQ2ZjBjMGY4ZUBhd3MtbGluazI1LmxpYW5neGluMS54eXo6MzQ1Nzg/dHlwZT10Y3AmZW5jcnlwdGlvbj1ub25lJmhvc3Q9JnBhdGg9JmhlYWRlclR5cGU9bm9uZSZxdWljU2VjdXJpdHk9bm9uZSZzZXJ2aWNlTmFtZT0mc2VjdXJpdHk9cmVhbGl0eSZmbG93PXh0bHMtcnByeC12aXNpb24mZnA9Y2hyb21lJnNuaT1kb3dubG9hZC1wb3J0ZXIuaG95b3ZlcnNlLmNvbSZwYms9UFNuMnM1VE40ZTduMExrelB1bnUySUExaFNtT29QWUZ1M2RfcHNsMk5tYyZzaWQ9ZTUzNGM4YmUjJUYwJTlGJTg3JUIwJUYwJTlGJTg3JUI3JUU5JTlGJUE5JUU1JTlCJUJEJUU5JUFCJTk4JUU5JTgwJTlGMDElN0NCR1AlN0MlRTYlQjUlODElRTUlQUElOTIlRTQlQkQlOTMNCnZsZXNzOi8vNTMwNGVjY2MtN2Q3OC00NzQxLWFiNzEtMjdmZDZmMGMwZjhlQGF3cy1saW5rMjcubGlhbmd4aW4xLnh5ejo0NDM/dHlwZT10Y3AmZW5jcnlwdGlvbj1ub25lJmhvc3Q9JnBhdGg9JmhlYWRlclR5cGU9bm9uZSZxdWljU2VjdXJpdHk9bm9uZSZzZXJ2aWNlTmFtZT0mc2VjdXJpdHk9cmVhbGl0eSZmbG93PXh0bHMtcnByeC12aXNpb24mZnA9Y2hyb21lJnNuaT1kb3dubG9hZC1wb3J0ZXIuaG95b3ZlcnNlLmNvbSZwYms9YTlJMnVBM05OWkE2dUJBZTNUdWk5dlo4Q0c1TXJNYVlPaWZXckFkYzB6ZyZzaWQ9YTg2MDliZTgjJUYwJTlGJTg3JUE4JUYwJTlGJTg3JUIzJUU1JThGJUIwJUU2JUI5JUJFJUU5JUFCJTk4JUU5JTgwJTlGMDElN0NCR1AlN0MlRTYlQjUlODElRTUlQUElOTIlRTQlQkQlOTMNCmh5c3RlcmlhMjovLzUzMDRlY2NjLTdkNzgtNDc0MS1hYjcxLTI3ZmQ2ZjBjMGY4ZUBhd3MtbGlua2h5Mi5saWFuZ3hpbjEueHl6OjYwMDAwLz9pbnNlY3VyZT0xJnNuaT1pb3NhcHBzLml0dW5lcy5hcHBsZS5jb20mbXBvcnQ9NjAwMDAtNjU1MzAjJUYwJTlGJTg3JUFEJUYwJTlGJTg3JUIwJUU5JUE2JTk5JUU2JUI4JUFGJUU0JUI4JTkzJUU3JUJBJUJGMDIlN0NCR1AlN0MlRTYlQjUlODElRTUlQUElOTIlRTQlQkQlOTMNCmh5c3RlcmlhMjovLzUzMDRlY2NjLTdkNzgtNDc0MS1hYjcxLTI3ZmQ2ZjBjMGY4ZUBhd3MtbGlua2h5My5saWFuZ3hpbjEueHl6OjQ0My8/aW5zZWN1cmU9MSZzbmk9aW9zYXBwcy5pdHVuZXMuYXBwbGUuY29tIyVGMCU5RiU4NyVBRCVGMCU5RiU4NyVCMCVFOSVBNiU5OSVFNiVCOCVBRiVFNCVCOCU5MyVFNyVCQSVCRjAzJTdDQkdQJTdDJUU2JUI1JTgxJUU1JUFBJTkyJUU0JUJEJTkzDQpoeXN0ZXJpYTI6Ly81MzA0ZWNjYy03ZDc4LTQ3NDEtYWI3MS0yN2ZkNmYwYzBmOGVAYXdzLWxpbmtoeTEwLmxpYW5neGluMS54eXo6NjAwMDAvP2luc2VjdXJlPTEmc25pPWlvc2FwcHMuaXR1bmVzLmFwcGxlLmNvbSZtcG9ydD02MDAwMC02NTUzMCMlRjAlOUYlODclQjglRjAlOUYlODclQUMlRTYlOTYlQjAlRTUlOEElQTAlRTUlOUQlQTElRTQlQjglOTMlRTclQkElQkYwMiU3Q0JHUCU3QyVFNiVCNSU4MSVFNSVBQSU5MiVFNCVCRCU5Mw0KaHlzdGVyaWEyOi8vNTMwNGVjY2MtN2Q3OC00NzQxLWFiNzEtMjdmZDZmMGMwZjhlQGF3cy1saW5raHkxMS5saWFuZ3hpbjEueHl6OjQ0My8/aW5zZWN1cmU9MSZzbmk9aW9zYXBwcy5pdHVuZXMuYXBwbGUuY29tIyVGMCU5RiU4NyVCOCVGMCU5RiU4NyVBQyVFNiU5NiVCMCVFNSU4QSVBMCVFNSU5RCVBMSVFNCVCOCU5MyVFNyVCQSVCRjAzJTdDQkdQJTdDJUU2JUI1JTgxJUU1JUFBJTkyJUU0JUJEJTkzDQpoeXN0ZXJpYTI6Ly81MzA0ZWNjYy03ZDc4LTQ3NDEtYWI3MS0yN2ZkNmYwYzBmOGVAYXdzLWxpbmtoeTE1LmxpYW5neGluMS54eXo6NjAwMDAvP2luc2VjdXJlPTEmc25pPWJpbGliaWxpLWpwLmJpbGlpbWcuY29tJm1wb3J0PTYwMDAwLTY1NTMwIyVGMCU5RiU4NyVBRiVGMCU5RiU4NyVCNSVFNiU5NyVBNSVFNiU5QyVBQyVFNCVCOCU5MyVFNyVCQSVCRjAxJTdDQkdQJTdDJUU2JUI1JTgxJUU1JUFBJTkyJUU0JUJEJTkzDQpoeXN0ZXJpYTI6Ly81MzA0ZWNjYy03ZDc4LTQ3NDEtYWI3MS0yN2ZkNmYwYzBmOGVAYXdzLWxpbmtoeTE2LmxpYW5neGluMS54eXo6NDQzLz9pbnNlY3VyZT0xJnNuaT1iaWxpYmlsaS1qcDIuYmlsaWltZy5jb20jJUYwJTlGJTg3JUFGJUYwJTlGJTg3JUI1JUU2JTk3JUE1JUU2JTlDJUFDJUU0JUI4JTkzJUU3JUJBJUJGMDIlN0NCR1AlN0MlRTYlQjUlODElRTUlQUElOTIlRTQlQkQlOTMNCmh5c3RlcmlhMjovLzUzMDRlY2NjLTdkNzgtNDc0MS1hYjcxLTI3ZmQ2ZjBjMGY4ZUBhd3MtbGlua2h5MTcubGlhbmd4aW4xLnh5ejo0NDMvP2luc2VjdXJlPTEmc25pPWJpbGliaWxpLWpwMy5iaWxpaW1nLmNvbSMlRjAlOUYlODclQUYlRjAlOUYlODclQjUlRTYlOTclQTUlRTYlOUMlQUMlRTQlQjglOTMlRTclQkElQkYwMyU3Q0JHUCU3QyVFNiVCNSU4MSVFNSVBQSU5MiVFNCVCRCU5Mw0KaHlzdGVyaWEyOi8vNTMwNGVjY2MtN2Q3OC00NzQxLWFiNzEtMjdmZDZmMGMwZjhlQGF3cy1saW5raHkyMS5saWFuZ3hpbjEueHl6OjQ0My8/aW5zZWN1cmU9MSZzbmk9YmlsaWJpbGkta3IuYmlsaWltZy5jb20jJUYwJTlGJTg3JUIwJUYwJTlGJTg3JUI3JUU5JTlGJUE5JUU1JTlCJUJEJUU0JUI4JTkzJUU3JUJBJUJGMDElN0NCR1AlN0MlRTYlQjUlODElRTUlQUElOTIlRTQlQkQlOTMNCmh5c3RlcmlhMjovLzUzMDRlY2NjLTdkNzgtNDc0MS1hYjcxLTI3ZmQ2ZjBjMGY4ZUBhd3MtbGlua2h5MjMubGlhbmd4aW4xLnh5ejo0NDMvP2luc2VjdXJlPTEmc25pPWJpbGliaWxpLXR3LmJpbGlpbWcuY29tIyVGMCU5RiU4NyVBOCVGMCU5RiU4NyVCMyVFNSU4RiVCMCVFNiVCOSVCRSVFNCVCOCU5MyVFNyVCQSVCRjAxJTdDQkdQJTdDJUU2JUI1JTgxJUU1JUFBJTkyJUU0JUJEJTkzDQpoeXN0ZXJpYTI6Ly81MzA0ZWNjYy03ZDc4LTQ3NDEtYWI3MS0yN2ZkNmYwYzBmOGVAYXdzLWxpbmtoeTI3LmxpYW5neGluMS54eXo6NDQzLz9pbnNlY3VyZT0xJnNuaT13d3cuYXBwbGUuY29tIyVGMCU5RiU4NyVCQSVGMCU5RiU4NyVCOCVFNyVCRSU4RSVFNSU5QiVCRDAyJTdDJUU2JUI1JTgxJUU1JUFBJTkyJUU0JUJEJTkzJTIwMC4xJUU1JTgwJThEDQo=
"""

# 解码Base64
decoded = base64.b64decode(sub_content.strip()).decode('utf-8')
lines = decoded.strip().split('\n')

outbounds = []
outbound_tags = []

# 解析每个节点
for line in lines:
    line = line.strip()
    if line.startswith('vless://'):
        outbound = parse_vless(line)
        if outbound:
            outbounds.append(outbound)
            outbound_tags.append(outbound['tag'])
    elif line.startswith('hysteria2://'):
        outbound = parse_hysteria2(line)
        if outbound:
            outbounds.append(outbound)
            outbound_tags.append(outbound['tag'])

# 添加直连和block出口
outbounds.append({"type": "direct", "tag": "direct"})
outbounds.append({"type": "block", "tag": "block"})

# 添加负载均衡urltest
outbounds.insert(0, {
    "type": "urltest",
    "tag": "auto",
    "outbounds": outbound_tags[:10],  # 只用前10个节点做负载均衡
    "url": "https://www.google.com/generate_204",
    "interval": "5m"
})

# 为每个节点生成独立的SOCKS5入站（从10001端口开始）
inbounds = []
base_port = 10001

# 为前N个节点创建独立入站（最多30个）
for i, tag in enumerate(outbound_tags[:30]):
    port = base_port + i
    inbounds.append({
        "type": "socks",
        "tag": f"in-{port}",
        "listen": "127.0.0.1",
        "listen_port": port,
        "users": []
    })
    
    # 为每个入站创建对应的selector出站，指向特定节点
    outbounds.insert(i + 1, {
        "type": "selector",
        "tag": f"proxy-{port}",
        "outbounds": [tag, "auto", "direct"],
        "default": tag
    })

# 添加统一的mixed入站用于测试（可选）
inbounds.append({
    "type": "mixed",
    "tag": "mixed-in",
    "listen": "127.0.0.1",
    "listen_port": 7890,
    "sniff": True,
    "sniff_override_destination": True
})

# 生成完整配置
config = {
    "log": {
        "level": "info",
        "timestamp": True
    },
    "inbounds": inbounds,
    "outbounds": outbounds,
    "route": {
        "rules": [
            # 为每个入站配置路由到对应的selector
            *[{
                "inbound": f"in-{base_port + i}",
                "outbound": f"proxy-{base_port + i}"
            } for i in range(min(len(outbound_tags), 30))],
            # mixed入站使用auto
            {
                "inbound": "mixed-in",
                "outbound": "auto"
            }
        ]
    }
}

# 保存到文件
with open('singbox_config.json', 'w', encoding='utf-8') as f:
    json.dump(config, f, indent=2, ensure_ascii=False)

node_count = len([ob for ob in outbounds if ob.get("type") in ["vless", "hysteria2", "vmess", "trojan", "ss"]])
inbound_count = len([ib for ib in inbounds if ib.get("type") == "socks"])

print(f"[OK] 配置已保存到 singbox_config.json")
print(f"[OK] 解析了 {node_count} 个节点")
print(f"[OK] 生成了 {inbound_count} 个独立SOCKS5入站（端口 {base_port}-{base_port + inbound_count - 1}）")
print(f"[OK] 负载均衡组包含前 10 个节点")
print(f"[OK] 混合入站端口：7890（测试用）")
