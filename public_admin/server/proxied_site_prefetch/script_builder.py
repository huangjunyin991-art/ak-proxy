import json

from .config import ProxiedSitePrefetchConfig


class ProxiedSitePrefetchScriptBuilder:
    def __init__(self, config: ProxiedSitePrefetchConfig):
        self.config = config

    def build(self, site_prefix: str) -> str:
        pages = [self._page_url(site_prefix, page) for page in self.config.target_pages]
        payload = {
            'pages': pages,
            'startDelayMs': self.config.start_delay_ms,
            'concurrencyLimit': self.config.concurrency_limit,
            'maxResources': self.config.max_resources,
            'pageFetchCacheMode': self.config.page_fetch_cache_mode,
            'assetFetchCacheMode': self.config.asset_fetch_cache_mode,
        }
        return '<script>(function(){try{' + self._body(payload) + '}catch(e){}})();</script>'

    def _page_url(self, site_prefix: str, page: str) -> str:
        return str(site_prefix or '').rstrip('/') + '/' + str(page or '').lstrip('/')

    def _body(self, payload: dict) -> str:
        return (
            "if(window.__akProxiedSiteResourcePrefetchInstalled)return;"
            "window.__akProxiedSiteResourcePrefetchInstalled=1;"
            "var cfg=" + json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + ";"
            "var seen=Object.create(null),queue=[],running=0,total=0;"
            "function abs(u,b){try{return new URL(String(u||''),b||location.href).href;}catch(e){return'';}}"
            "function clean(u){try{var x=new URL(u,location.href);if(x.protocol!=='http:'&&x.protocol!=='https:')return'';if(x.origin!==location.origin)return'';return x.href;}catch(e){return'';}}"
            "function enqueue(u){u=clean(u);if(!u||seen[u]||total>=cfg.maxResources)return;seen[u]=1;total++;queue.push(u);pump();}"
            "function pump(){while(running<cfg.concurrencyLimit&&queue.length){var u=queue.shift();running++;fetch(u,{credentials:'same-origin',cache:cfg.assetFetchCacheMode}).then(function(r){var ct=(r.headers.get('content-type')||'').toLowerCase();if(ct.indexOf('text/css')>=0){return r.text().then(function(t){scanCss(t,u);});}}).catch(function(){}).finally(function(){running--;pump();});}}"
            "function scanSrcset(v,b){String(v||'').split(',').forEach(function(part){var u=part.trim().split(/\\s+/)[0];if(u)enqueue(abs(u,b));});}"
            "function scanCss(text,b){String(text||'').replace(/url\\((['\"]?)([^)'\"#]+)(?:#[^)'\"]*)?\\1\\)/ig,function(m,q,u){if(u&&u.indexOf('data:')!==0)enqueue(abs(u,b));return m;});}"
            "function scanHtml(text,pageUrl){var doc;try{doc=new DOMParser().parseFromString(String(text||''),'text/html');}catch(e){return;}doc.querySelectorAll('link[href]').forEach(function(n){var rel=String(n.getAttribute('rel')||'').toLowerCase();var href=abs(n.getAttribute('href'),pageUrl);if(rel.indexOf('stylesheet')>=0||rel.indexOf('preload')>=0||rel.indexOf('prefetch')>=0)enqueue(href);});doc.querySelectorAll('script[src]').forEach(function(n){enqueue(abs(n.getAttribute('src'),pageUrl));});doc.querySelectorAll('img[src],source[src]').forEach(function(n){enqueue(abs(n.getAttribute('src'),pageUrl));});doc.querySelectorAll('img[srcset],source[srcset]').forEach(function(n){scanSrcset(n.getAttribute('srcset'),pageUrl);});}"
            "function prefetchPage(pageUrl){pageUrl=clean(pageUrl);if(!pageUrl)return;fetch(pageUrl,{credentials:'same-origin',cache:cfg.pageFetchCacheMode}).then(function(r){return r.text();}).then(function(t){scanHtml(t,pageUrl);}).catch(function(){});}"
            "function start(){if(window.__akProxiedSiteResourcePrefetchStarted)return;window.__akProxiedSiteResourcePrefetchStarted=1;cfg.pages.forEach(prefetchPage);}"
            "if(document.readyState==='complete'){setTimeout(start,cfg.startDelayMs);}else{window.addEventListener('load',function(){setTimeout(start,cfg.startDelayMs);},{once:true});}"
        )
