from __future__ import annotations

import json
from typing import Any, Optional

from ..types import AssistSession
from .base import BaseAssistAdapter


class AkWebAdapter(BaseAssistAdapter):
    ACTIVE_PROXY_PREFIX = "/admin/ak-web/"

    @property
    def site_type(self) -> str:
        return "ak_web"

    def matches_proxy_path(self, path: str) -> bool:
        normalized = str(path or "").strip()
        return normalized.startswith(self.ACTIVE_PROXY_PREFIX)

    def build_bridge_script(
        self,
        session: AssistSession,
        ws_endpoint: str,
        role: str,
        readonly: bool,
        extra: Optional[dict[str, Any]] = None,
    ) -> str:
        payload = {
            "sessionId": session.session_id,
            "site": self.site_type,
            "role": role,
            "readonly": readonly,
            "targetUsername": session.target_username,
            "adminUsername": session.admin_username,
            "wsEndpoint": ws_endpoint,
            "extra": dict(extra or {}),
        }
        options = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
        return (
            r"""
<script>(function(){
try{
if(window.__akRemoteAssistBridgeInstalled)return;
window.__akRemoteAssistBridgeInstalled=true;
window.__AK_REMOTE_ASSIST__=__REMOTE_ASSIST_CFG__;
var cfg=window.__AK_REMOTE_ASSIST__||{};
if(!cfg.wsEndpoint||!cfg.sessionId)return;
var proto=location.protocol==='https:'?'wss://':'ws://';
var wsUrl=/^wss?:\/\//.test(cfg.wsEndpoint)?cfg.wsEndpoint:(proto+location.host+cfg.wsEndpoint);
wsUrl += (wsUrl.indexOf('?')>=0?'&':'?') + 'session_id=' + encodeURIComponent(cfg.sessionId) + '&role=' + encodeURIComponent(cfg.role || 'user') + '&site=' + encodeURIComponent(cfg.site || 'ak_web') + '&readonly=' + encodeURIComponent(cfg.readonly ? '1' : '0');
var ws=null;
var overlay=null;
var clearTimer=0;
function send(type,payload){try{if(!ws||ws.readyState!==1)return;ws.send(JSON.stringify({v:1,type:type,session_id:cfg.sessionId,site:cfg.site||'ak_web',source:(cfg.role||'user')+'_bridge',ts:Date.now(),payload:payload||{}}));}catch(_e){}}
function pickMeta(target){try{if(!target)return {};var rect=target.getBoundingClientRect?target.getBoundingClientRect():null;var selector=(target.id?('#'+target.id):((target.className&&typeof target.className==='string'&&target.className.trim())?((target.tagName||'div').toLowerCase()+'.'+target.className.trim().split(/\s+/).slice(0,2).join('.')):(target.tagName||'div').toLowerCase()));return {selector_hint:selector,text_hint:String((target.innerText||target.textContent||'')).trim().slice(0,40),rect:rect?{x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2),w:Math.round(rect.width),h:Math.round(rect.height)}:null};}catch(_e){return {};}}
function restoreHighlight(el,outline,offset){try{el.style.outline=outline||'';el.style.outlineOffset=offset||'';}catch(_e){}}
function flash(target){try{if(!target)return;var prevOutline=target.style.outline;var prevOffset=target.style.outlineOffset;target.style.outline='2px solid rgba(255,82,82,0.95)';target.style.outlineOffset='2px';if(clearTimer)clearTimeout(clearTimer);clearTimer=setTimeout(function(){restoreHighlight(target,prevOutline,prevOffset);},1200);}catch(_e){}}
function resolveTarget(meta){try{if(meta&&meta.selector_hint&&meta.selector_hint.charAt(0)==='#'){var byId=document.querySelector(meta.selector_hint);if(byId)return byId;}}catch(_e){}try{if(meta&&meta.rect){return document.elementFromPoint(Number(meta.rect.x)||0,Number(meta.rect.y)||0);}}catch(_e){}return null;}
function applyHighlight(meta){var el=resolveTarget(meta||{});if(el)flash(el);}
function emitRoute(){send('route_changed',{route:location.pathname + location.search + location.hash,title:document.title || '',replace:false});}
function heartbeat(){send('heartbeat',{role:cfg.role||'user'});}
function installReadonlyOverlay(){if(cfg.role!=='admin'||!cfg.readonly||overlay)return;if(!document.body){document.addEventListener('DOMContentLoaded',installReadonlyOverlay,{once:true});return;}overlay=document.createElement('div');overlay.id='__akRemoteAssistOverlay';overlay.style.cssText='position:fixed;inset:0;z-index:2147483646;background:transparent;cursor:crosshair;';overlay.addEventListener('click',function(event){try{event.preventDefault();event.stopPropagation();overlay.style.pointerEvents='none';var target=document.elementFromPoint(event.clientX,event.clientY);overlay.style.pointerEvents='auto';var meta=pickMeta(target);applyHighlight(meta);send('click_highlight',meta);}catch(_e){try{overlay.style.pointerEvents='auto';}catch(__e){}}},true);document.body.appendChild(overlay);}
function handleMessage(msg){try{if(!msg||!msg.type)return;if(msg.type==='click_highlight'&&msg.payload){applyHighlight(msg.payload);}if(cfg.role==='admin'&&msg.type==='route_changed'&&msg.payload&&msg.payload.route){var next=String(msg.payload.route||'').trim();var current=location.pathname + location.search + location.hash;if(next&&next!==current){location.assign(next);}}}catch(_e){}}
function connect(){try{ws=new WebSocket(wsUrl);}catch(_e){return;}ws.onopen=function(){send('client_hello',{role:cfg.role||'user',readonly:!!cfg.readonly,capabilities:['route_sync','click_highlight']});if(cfg.role!=='admin'){emitRoute();}heartbeat();};ws.onmessage=function(event){try{handleMessage(JSON.parse(event.data||'{}'));}catch(_e){}};ws.onclose=function(){setTimeout(connect,1500);};}
if(cfg.role!=='admin'){document.addEventListener('click',function(event){send('click_highlight',pickMeta(event.target));},true);window.addEventListener('popstate',emitRoute,true);window.addEventListener('hashchange',emitRoute,true);}else{installReadonlyOverlay();}
setInterval(heartbeat,8000);
connect();
}catch(_e){}
})();</script>
""".replace("__REMOTE_ASSIST_CFG__", options)
        )
