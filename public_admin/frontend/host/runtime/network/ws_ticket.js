(function(global) {
    'use strict';

    if (global.AKWsTicket && typeof global.AKWsTicket.fetchTicket === 'function') return;

    function getEndpoint(audience, options) {
        const config = options || {};
        if (config.endpoint) return String(config.endpoint);
        const aud = String(audience || '').trim().toLowerCase();
        if (aud === 'im') return '/im/api/ws-ticket';
        if (config.admin) return '/admin/api/ws-ticket';
        return '/chat/api/ws-ticket';
    }

    async function fetchTicket(audience, payload, options) {
        const config = options || {};
        const body = Object.assign({}, payload || {}, { audience: String(audience || '').trim().toLowerCase() });
        const headers = Object.assign({ 'Content-Type': 'application/json' }, config.headers || {});
        const response = await fetch(getEndpoint(audience, config), {
            method: 'POST',
            credentials: 'include',
            headers: headers,
            body: JSON.stringify(body)
        });
        let data = null;
        try { data = await response.json(); } catch (e) { data = null; }
        if (!response.ok || !data || !data.ticket) {
            const message = data && data.message ? data.message : ('WebSocket ticket failed: ' + response.status);
            const error = new Error(message);
            error.status = response.status;
            error.code = data && data.code ? data.code : 'ticket_failed';
            throw error;
        }
        return data;
    }

    function buildWsUrl(path, ticket) {
        const base = new URL(String(path || '/'), global.location.origin);
        base.protocol = global.location.protocol === 'https:' ? 'wss:' : 'ws:';
        base.search = '';
        base.searchParams.set('ticket', String(ticket || ''));
        return base.toString();
    }

    global.AKWsTicket = {
        fetchTicket: fetchTicket,
        buildWsUrl: buildWsUrl
    };
})(window);
