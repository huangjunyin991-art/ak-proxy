(function(global) {
    'use strict';

    const appShellModule = {
        ctx: null,
        elements: null,
        eventsBound: false,

        init(ctx) {
            this.ctx = ctx || {};
            this.eventsBound = false;
        },

        buildStyleText() {
            return `
                #ak-im-root{display:none;position:fixed;left:calc(50% + 46px);top:calc(env(safe-area-inset-top, 0px) - 10px);z-index:2147483643;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
                #ak-im-root.ak-visible{display:block}
                #ak-im-root.ak-im-open{z-index:2147483647}
                #ak-im-root .ak-im-launcher{width:56px;height:56px;border:none;border-radius:999px;background:transparent;color:rgba(233,244,255,.84);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;position:relative;transition:color .18s ease,transform .18s ease,filter .18s ease,opacity .18s ease}
                #ak-im-root .ak-im-launcher svg{position:relative;z-index:1;width:30px;height:30px;transition:filter .18s ease}
                #ak-im-root .ak-im-launcher:hover,#ak-im-root .ak-im-launcher.is-open{transform:translateY(-1px);color:#fff0c0}
                #ak-im-root .ak-im-launcher:hover svg,#ak-im-root .ak-im-launcher.is-open svg{filter:drop-shadow(0 0 10px rgba(255,213,100,.32)) drop-shadow(0 0 4px rgba(255,240,192,.22))}
                @keyframes ak-im-icon-green-flash{0%,100%{filter:drop-shadow(0 0 8px rgba(7,193,96,.34)) drop-shadow(0 0 3px rgba(52,211,153,.22))}50%{filter:drop-shadow(0 0 14px rgba(52,211,153,.44)) drop-shadow(0 0 6px rgba(7,193,96,.28))}}
                #ak-im-root .ak-im-launcher.has-unread{color:#56c57b}
                #ak-im-root .ak-im-launcher.has-unread svg{animation:ak-im-icon-green-flash 1.8s ease-in-out infinite}
                #ak-im-root .ak-im-launcher-badge{position:absolute;top:8px;right:8px;min-width:9px;width:9px;height:9px;border-radius:999px;background:linear-gradient(180deg,#ff2f43 0%,#f30023 100%);box-shadow:0 0 8px rgba(255,39,66,.24);border:1px solid rgba(255,140,150,.22);display:none}
                #ak-im-root .ak-im-launcher.has-unread .ak-im-launcher-badge{display:block}
                #ak-im-root .ak-im-shell{display:none;position:fixed;inset:0;background:#ededed;overflow:hidden}
                #ak-im-root.ak-im-open .ak-im-shell{display:block}
                #ak-im-root.ak-im-open .ak-im-launcher{opacity:0;pointer-events:none;transform:scale(.96)}
                #ak-im-root .ak-im-screen{display:none;position:absolute;inset:0;flex-direction:column;min-height:0}
                #ak-im-root.ak-view-sessions .ak-im-session-screen{display:flex}
                #ak-im-root.ak-view-chat .ak-im-chat-screen{display:flex}
                #ak-im-root.ak-view-compose .ak-im-compose-screen{display:flex}
                #ak-im-root.ak-view-group-info .ak-im-group-info-screen{display:flex}
                #ak-im-root.ak-view-member-action .ak-im-member-action-screen{display:flex}
                #ak-im-root.ak-view-profile-subpage .ak-im-profile-subpage-screen{display:flex}
                #ak-im-root .ak-im-topbar{height:calc(56px + env(safe-area-inset-top, 0px));padding:calc(env(safe-area-inset-top, 0px) + 8px) 12px 8px;display:grid;grid-template-columns:52px 1fr 52px;align-items:center;background:#ededed;border-bottom:1px solid rgba(15,23,42,.06);box-sizing:border-box}
                #ak-im-root .ak-im-session-screen .ak-im-topbar{grid-template-columns:80px minmax(0,1fr) 80px;column-gap:8px}
                #ak-im-root .ak-im-topbar-title,#ak-im-root .ak-im-topbar-title-wrap{text-align:center;min-width:0}
                #ak-im-root .ak-im-topbar-title{font-size:17px;font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-chat-title-btn{width:100%;border:none;background:transparent;padding:0;margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:10px;min-width:0}
                #ak-im-root .ak-im-chat-title-btn.is-clickable{cursor:pointer}
                #ak-im-root .ak-im-chat-title-btn.is-clickable:active{opacity:.76}
                #ak-im-root .ak-im-chat-title-btn:disabled{cursor:default;opacity:1}
                #ak-im-root .ak-im-chat-title{font-size:17px;font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;justify-content:center;min-width:0}
                #ak-im-root .ak-im-chat-subtitle{margin-top:2px;font-size:11px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-name-with-honor{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;vertical-align:middle}
                #ak-im-root .ak-im-name-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
                #ak-im-root .ak-im-honor-badge{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;max-width:112px;min-height:18px;padding:0 6px;border-radius:999px;background:rgba(7,193,96,.12);color:#16a34a;font-size:10px;font-weight:700;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-nav-btn{height:34px;border:none;background:transparent;color:#111827;padding:0 8px;font-size:15px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:10px}
                #ak-im-root .ak-im-nav-btn.is-hidden{opacity:0;pointer-events:none}
                #ak-im-root .ak-im-nav-btn svg{width:20px;height:20px;stroke:currentColor}
                #ak-im-root .ak-im-nav-btn.ak-im-new{justify-self:end;font-size:15px;color:#1f2937}
                #ak-im-root .ak-im-contact-search-back{display:none}
                #ak-im-root .ak-im-topbar-search-wrap{display:none;align-items:center;min-width:0}
                #ak-im-root .ak-im-contact-search-box{height:38px;border-radius:14px;background:#ffffff;display:flex;align-items:center;gap:8px;padding:0 10px;box-shadow:0 1px 0 rgba(15,23,42,.03) inset;min-width:0;flex:1}
                #ak-im-root .ak-im-contact-search-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;color:#9ca3af}
                #ak-im-root .ak-im-contact-search-icon svg{width:16px;height:16px;stroke:currentColor}
                #ak-im-root .ak-im-contact-search-input{flex:1;min-width:0;height:100%;border:none;background:transparent;padding:0;font-size:15px;color:#111827;outline:none}
                #ak-im-root .ak-im-contact-search-input::placeholder{color:#9ca3af}
                #ak-im-root .ak-im-contact-search-clear{width:22px;height:22px;border:none;border-radius:999px;background:#e5e7eb;color:#6b7280;padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:1;cursor:pointer;flex:0 0 auto}
                #ak-im-root .ak-im-topbar-actions{justify-self:end;display:flex;align-items:center;gap:4px}
                #ak-im-root .ak-im-session-screen .ak-im-close,#ak-im-root .ak-im-session-screen .ak-im-contact-search-back{grid-column:1;grid-row:1;justify-self:start}
                #ak-im-root .ak-im-session-screen .ak-im-session-topbar-title,#ak-im-root .ak-im-topbar-search-wrap{grid-column:2;grid-row:1}
                #ak-im-root .ak-im-session-screen .ak-im-new,#ak-im-root .ak-im-session-screen .ak-im-home-topbar-actions{grid-column:3;grid-row:1;justify-self:end}
                #ak-im-root .ak-im-session-screen .ak-im-new.is-hidden{display:none}
                #ak-im-root .ak-im-topbar-actions .ak-im-nav-btn.is-hidden{display:none}
                #ak-im-root .ak-im-home-topbar-actions{position:relative}
                #ak-im-root .ak-im-home-topbar-actions .ak-im-nav-btn{width:34px;height:34px;padding:0;color:#111827}
                #ak-im-root .ak-im-home-topbar-actions .ak-im-home-add-trigger svg{width:18px;height:18px}
                #ak-im-root .ak-im-home-add-menu{position:absolute;top:calc(100% + 10px);right:0;min-width:176px;padding:8px 0;background:#ffffff;border-radius:16px;box-shadow:0 18px 36px rgba(15,23,42,.16);display:none;flex-direction:column;z-index:8}
                #ak-im-root .ak-im-home-add-menu.is-open{display:flex}
                #ak-im-root .ak-im-home-add-menu::before{content:'';position:absolute;top:-7px;right:14px;width:14px;height:14px;background:#ffffff;border-radius:3px;transform:rotate(45deg)}
                #ak-im-root .ak-im-home-add-action{position:relative;width:100%;min-height:48px;border:none;background:transparent;padding:0 16px;display:flex;align-items:center;gap:12px;text-align:left;color:#111827;font-size:15px;cursor:pointer;box-sizing:border-box}
                #ak-im-root .ak-im-home-add-action + .ak-im-home-add-action{border-top:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-home-add-action-icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;color:#374151;flex:0 0 auto}
                #ak-im-root .ak-im-home-add-action-icon svg{width:20px;height:20px;stroke:currentColor;fill:none}
                #ak-im-root .ak-im-home-add-action-label{flex:1;line-height:1.4}
                #ak-im-root.ak-contact-search-open .ak-im-session-screen .ak-im-topbar{grid-template-columns:40px minmax(0,1fr);column-gap:8px}
                #ak-im-root.ak-contact-search-open .ak-im-close{display:none}
                #ak-im-root.ak-contact-search-open .ak-im-contact-search-back{display:inline-flex}
                #ak-im-root.ak-contact-search-open .ak-im-session-topbar-title{display:none}
                #ak-im-root.ak-contact-search-open .ak-im-topbar-search-wrap{display:flex}
                #ak-im-root.ak-contact-search-open .ak-im-home-topbar-actions{display:none}
                #ak-im-root .ak-im-session-page{flex:1;display:flex;flex-direction:column;min-height:0;background:#f7f7f7}
                #ak-im-root .ak-im-home-panels{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
                #ak-im-root .ak-im-home-panel{display:none;flex:1;min-height:0;flex-direction:column}
                #ak-im-root .ak-im-home-panel.is-active{display:flex}
                #ak-im-root .ak-im-search-bar{padding:8px 12px;background:#ededed;border-bottom:1px solid rgba(15,23,42,.04)}
                #ak-im-root .ak-im-search-pill{height:36px;border-radius:12px;background:#ffffff;color:#6b7280;display:flex;align-items:center;justify-content:center;font-size:12px}
                #ak-im-root .ak-im-session-list{flex:1;overflow:auto;background:#ffffff}
                #ak-im-root .ak-im-session-item{display:flex;align-items:center;gap:12px;padding:12px 14px;border:none;border-bottom:1px solid rgba(15,23,42,.05);background:#fff;cursor:pointer;position:relative}
                #ak-im-root .ak-im-session-item.ak-active{background:#f0fdf4}
                #ak-im-root .ak-im-session-item.is-pinned{background:#f7fcf7}
                #ak-im-root .ak-im-session-avatar{width:48px;height:48px;border-radius:14px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex:0 0 auto}
                #ak-im-root .ak-im-avatar-photo{width:100%;height:100%;display:block;object-fit:cover}
                #ak-im-root .ak-im-session-avatar,#ak-im-root .ak-im-avatar,#ak-im-root .ak-im-member-avatar,#ak-im-root .ak-im-member-action-avatar,#ak-im-root .ak-im-contact-avatar,#ak-im-root .ak-im-profile-avatar,#ak-im-root .ak-im-avatar-cell{overflow:hidden}
                #ak-im-root .ak-im-session-body{min-width:0;flex:1;display:grid;grid-template-columns:1fr auto;grid-template-areas:'name time' 'preview unread';align-items:center;column-gap:10px;row-gap:4px}
                #ak-im-root .ak-im-session-title{grid-area:name;display:flex;align-items:center;gap:6px;min-width:0;font-size:16px;font-weight:500;color:#111827}
                #ak-im-root .ak-im-session-title-text{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-session-title-text.ak-im-name-with-honor{display:inline-flex;align-items:center;gap:6px;max-width:100%}
                #ak-im-root .ak-im-session-pin-tag{display:none;align-items:center;justify-content:center;flex:0 0 auto;height:18px;padding:0 6px;border-radius:999px;background:rgba(15,23,42,.06);color:#4b5563;font-size:10px;font-weight:700}
                #ak-im-root .ak-im-session-pin-tag.visible{display:inline-flex}
                #ak-im-root .ak-im-session-pin-tag.is-system{background:rgba(7,193,96,.12);color:#07c160}
                #ak-im-root .ak-im-session-time{grid-area:time;font-size:11px;color:#9ca3af;white-space:nowrap}
                #ak-im-root .ak-im-session-preview{grid-area:preview;font-size:13px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-session-unread{grid-area:unread;justify-self:end;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#ef4444;color:#fff;font-size:11px;display:none;align-items:center;justify-content:center}
                #ak-im-root .ak-im-session-unread.visible{display:inline-flex}
                #ak-im-root .ak-im-contact-search-page{display:none;flex:1;min-height:0;overflow:auto;background:#f7f7f7;flex-direction:column}
                #ak-im-root.ak-contact-search-open .ak-im-home-panels{display:none}
                #ak-im-root.ak-contact-search-open .ak-im-contact-search-page{display:flex}
                #ak-im-root .ak-im-contact-search-empty{margin:auto;padding:28px 18px;color:#94a3b8;font-size:13px;line-height:1.7;text-align:center}
                #ak-im-root .ak-im-contact-search-section{padding-top:8px}
                #ak-im-root .ak-im-contact-search-section-title{padding:0 16px 10px;font-size:13px;font-weight:600;color:#6b7280;line-height:1.5}
                #ak-im-root .ak-im-contact-search-section-list{background:#ffffff}
                #ak-im-root .ak-im-contacts-list{flex:1;overflow:auto;background:#ffffff}
                #ak-im-root .ak-im-contact-item{width:100%;border:none;background:#ffffff;padding:13px 16px;display:flex;align-items:center;gap:12px;text-align:left;cursor:pointer}
                #ak-im-root .ak-im-contact-item + .ak-im-contact-item{border-top:1px solid rgba(15,23,42,.05)}
                #ak-im-root .ak-im-contact-avatar{width:46px;height:46px;border-radius:14px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex:0 0 auto}
                #ak-im-root .ak-im-contact-body{min-width:0;flex:1}
                #ak-im-root .ak-im-contact-name{font-size:15px;font-weight:600;color:#111827;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;min-width:0}
                #ak-im-root .ak-im-contact-meta{margin-top:3px;font-size:12px;color:#9ca3af;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-profile-page{flex:1;overflow:auto;padding:14px 12px calc(18px + env(safe-area-inset-bottom, 0px));background:#f7f7f7}
                #ak-im-root .ak-im-profile-card{background:#ffffff;border-radius:22px;padding:22px 18px 18px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
                #ak-im-root .ak-im-profile-head{display:flex;flex-direction:column;align-items:center;text-align:center}
                #ak-im-root .ak-im-profile-avatar{width:88px;height:88px;border-radius:24px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:26px;font-weight:700;box-shadow:0 10px 22px rgba(7,193,96,.14)}
                #ak-im-root .ak-im-profile-name{margin-top:14px;font-size:20px;font-weight:700;color:#111827;line-height:1.3;display:flex;align-items:center;justify-content:center;min-width:0}
                #ak-im-root .ak-im-profile-username{margin-top:6px;font-size:13px;color:#9ca3af;line-height:1.4}
                #ak-im-root .ak-im-profile-meta{margin-top:8px;font-size:13px;color:#6b7280;line-height:1.5}
                #ak-im-root .ak-im-profile-entry-list{margin-top:12px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.04)}
                #ak-im-root .ak-im-profile-entry{width:100%;border:none;background:#ffffff;padding:0 16px;min-height:58px;display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left;cursor:pointer;box-sizing:border-box}
                #ak-im-root .ak-im-profile-entry + .ak-im-profile-entry{border-top:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-profile-entry-main{min-width:0;flex:1}
                #ak-im-root .ak-im-profile-entry-label{font-size:16px;font-weight:500;color:#111827;line-height:1.5}
                #ak-im-root .ak-im-profile-entry-meta{margin-top:4px;font-size:12px;color:#9ca3af;line-height:1.5}
                #ak-im-root .ak-im-profile-entry-arrow{color:#c7cdd8;font-size:20px;line-height:1;flex:0 0 auto}
                #ak-im-root .ak-im-profile-subpage-screen{background:#ededed}
                #ak-im-root .ak-im-profile-subpage-page{flex:1;overflow:auto;padding:12px 12px calc(16px + env(safe-area-inset-bottom, 0px));background:#f7f7f7}
                #ak-im-root .ak-im-profile-panel{background:#ffffff;border-radius:18px;padding:16px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
                #ak-im-root .ak-im-profile-panel + .ak-im-profile-panel{margin-top:12px}
                #ak-im-root .ak-im-profile-subtitle{margin-top:8px;font-size:13px;color:#6b7280;line-height:1.55}
                #ak-im-root .ak-im-profile-action-row{margin-top:16px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
                #ak-im-root .ak-im-profile-primary-btn{margin-top:16px;width:100%;height:46px;border:none;border-radius:14px;background:#07c160;color:#ffffff;font-size:16px;font-weight:700;cursor:pointer;box-shadow:0 10px 22px rgba(7,193,96,.18)}
                #ak-im-root .ak-im-profile-action-row .ak-im-profile-primary-btn{margin-top:0}
                #ak-im-root .ak-im-profile-primary-btn:disabled{opacity:.42;cursor:not-allowed;box-shadow:none}
                #ak-im-root .ak-im-profile-note{margin-top:4px;padding:10px 12px;border-radius:12px;background:#fffbeb;color:#b45309;font-size:12px;line-height:1.6}
                #ak-im-root .ak-im-profile-history-section + .ak-im-profile-history-section{margin-top:18px}
                #ak-im-root .ak-im-profile-history-section:first-child .ak-im-profile-history-section-head{margin-top:0}
                #ak-im-root .ak-im-profile-history-section-head{margin-top:14px;display:flex;align-items:center;justify-content:space-between;gap:12px}
                #ak-im-root .ak-im-profile-history-section-head .ak-im-profile-entry-label{font-size:18px;font-weight:700;line-height:1.35}
                #ak-im-root .ak-im-profile-history-section-count{font-size:13px;color:#94a3b8;font-weight:600;line-height:1.4;white-space:nowrap}
                #ak-im-root .ak-im-profile-history-grid{margin-top:14px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
                #ak-im-root .ak-im-profile-history-item{position:relative;min-height:188px;background:#f8fafc;border:1px solid #eef2f7;border-radius:18px;padding:14px 12px 16px;box-sizing:border-box}
                #ak-im-root .ak-im-profile-history-item.is-current{border-color:rgba(7,193,96,.26);box-shadow:0 10px 22px rgba(7,193,96,.08)}
                #ak-im-root .ak-im-profile-history-card{width:100%;border:none;background:transparent;padding:40px 0 0;display:flex;flex-direction:column;align-items:center;text-align:center;cursor:pointer;color:#0f172a}
                #ak-im-root .ak-im-profile-history-card:disabled{cursor:default;opacity:1}
                #ak-im-root .ak-im-profile-history-avatar{width:80px;height:80px;border-radius:22px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;overflow:hidden}
                #ak-im-root .ak-im-profile-history-current{position:absolute;top:10px;left:10px;display:inline-flex;align-items:center;justify-content:center;min-height:24px;padding:0 9px;border-radius:999px;background:#dcfce7;color:#166534;font-size:11px;font-weight:700;line-height:1;box-shadow:0 1px 2px rgba(22,101,52,.08)}
                #ak-im-root .ak-im-profile-history-remove{position:absolute;top:11px;right:11px;width:21px;height:21px;border:1px solid rgba(239,68,68,.18);border-radius:999px;background:#fee2e2;color:#dc2626;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:none}
                #ak-im-root .ak-im-profile-history-remove:disabled{opacity:.46;cursor:not-allowed;box-shadow:none}
                #ak-im-root .ak-im-profile-history-remove-mark{display:block;font-size:15px;font-weight:800;line-height:1;transform:translateY(-1px)}
                #ak-im-root .ak-im-profile-history-favorite{position:absolute;right:10px;bottom:12px;width:28px;height:28px;border:none;border-radius:999px;background:#ffffff;color:#94a3b8;font-size:16px;font-weight:700;line-height:1;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 12px rgba(15,23,42,.08)}
                #ak-im-root .ak-im-profile-history-favorite.is-active{background:#fef3c7;color:#d97706}
                #ak-im-root .ak-im-profile-history-favorite:disabled{opacity:.46;cursor:not-allowed;box-shadow:none}
                #ak-im-root .ak-im-profile-history-time{font-size:12px;color:#6b7280;line-height:1.5}
                #ak-im-root .ak-im-profile-history-hint{margin-top:2px;font-size:12px;color:#94a3b8;line-height:1.45}
                #ak-im-root .ak-im-profile-history-item.is-current .ak-im-profile-history-hint{color:#16a34a;font-weight:600}
                #ak-im-root .ak-im-profile-form{display:flex;flex-direction:column;gap:14px}
                #ak-im-root .ak-im-profile-form-group{display:flex;flex-direction:column}
                #ak-im-root .ak-im-profile-form-label{font-size:13px;color:#6b7280;line-height:1.5}
                #ak-im-root .ak-im-profile-form-input,#ak-im-root .ak-im-profile-form-select{margin-top:8px;width:100%;height:46px;border:none;border-radius:12px;background:#f3f4f6;padding:0 14px;font-size:15px;color:#111827;outline:none;box-sizing:border-box}
                #ak-im-root .ak-im-profile-form-input:focus,#ak-im-root .ak-im-profile-form-select:focus{background:#ffffff;box-shadow:0 0 0 2px rgba(7,193,96,.14) inset}
                #ak-im-root .ak-im-profile-form-help{margin-top:6px;font-size:12px;color:#9ca3af;line-height:1.6}
                #ak-im-root .ak-im-profile-placeholder{padding:28px 14px;color:#6b7280;font-size:13px;line-height:1.7;text-align:center}
                #ak-im-root .ak-im-profile-error{margin-bottom:12px;padding:11px 12px;border-radius:14px;background:rgba(239,68,68,.08);color:#dc2626;font-size:13px;line-height:1.6}
                #ak-im-root .ak-im-home-tabbar{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;padding:8px 8px calc(8px + env(safe-area-inset-bottom, 0px));background:#ffffff;border-top:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-home-tab-btn{position:relative;border:none;background:transparent;min-height:56px;border-radius:14px;color:#6b7280;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;cursor:pointer}
                #ak-im-root .ak-im-home-tab-btn svg{width:22px;height:22px;stroke:currentColor}
                #ak-im-root .ak-im-home-tab-btn span{font-size:11px;line-height:1.2}
                #ak-im-root .ak-im-home-tab-btn.is-active{color:#07c160;background:rgba(7,193,96,.06)}
                #ak-im-root .ak-im-home-tab-badge{position:absolute;top:5px;right:calc(50% - 23px);min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#ff5a5f;color:#ffffff;font-size:11px;font-weight:700;line-height:18px;text-align:center;box-sizing:border-box;box-shadow:0 0 0 2px #ffffff;display:none}
                #ak-im-root .ak-im-home-tab-btn.has-unread .ak-im-home-tab-badge{display:inline-flex;align-items:center;justify-content:center}
                #ak-im-root .ak-im-home-panel[data-im-home-panel="meetings"]{background:#f2f3f5}
                #ak-im-root .ak-im-meeting-list{flex:1;overflow:auto;padding:12px 12px calc(12px + env(safe-area-inset-bottom, 0px));display:flex;flex-direction:column;gap:10px}
                #ak-im-root .ak-im-meeting-empty{padding:28px 16px;text-align:center;color:#9ca3af;font-size:13px;line-height:1.7;background:#ffffff;border-radius:12px}
                #ak-im-root .ak-im-meeting-empty.ak-im-meeting-error{color:#dc2626;background:rgba(239,68,68,.06)}
                #ak-im-root .ak-im-meeting-card{background:#ffffff;border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:6px;box-shadow:0 1px 0 rgba(15,23,42,.04)}
                #ak-im-root .ak-im-meeting-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
                #ak-im-root .ak-im-meeting-title{display:flex;align-items:center;gap:6px;font-size:15px;font-weight:600;color:#111827;min-width:0}
                #ak-im-root .ak-im-meeting-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
                #ak-im-root .ak-im-meeting-unread-dot{width:8px;height:8px;border-radius:999px;background:#f43f5e;flex:0 0 auto}
                #ak-im-root .ak-im-meeting-state{flex:0 0 auto;font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid currentColor}
                #ak-im-root .ak-im-meeting-row{font-size:13px;color:#374151;line-height:1.6;word-break:break-all}
                #ak-im-root .ak-im-meeting-row.ak-im-meeting-sender{color:#6b7280;font-size:12px;display:flex;align-items:center;gap:4px;flex-wrap:wrap;word-break:break-word}
                #ak-im-root .ak-im-meeting-row.ak-im-meeting-password{display:flex;align-items:center;justify-content:space-between;gap:8px;background:#fffbeb;border:1px dashed #f59e0b;color:#b45309;border-radius:8px;padding:6px 10px}
                #ak-im-root .ak-im-meeting-copy-btn{border:none;background:#f59e0b;color:#ffffff;height:24px;padding:0 10px;border-radius:6px;font-size:12px;cursor:pointer}
                #ak-im-root .ak-im-meeting-actions{display:flex;gap:8px;margin-top:4px}
                #ak-im-root .ak-im-meeting-join-btn{flex:1;border:none;background:#07c160;color:#ffffff;height:34px;border-radius:10px;font-size:14px;font-weight:500;cursor:pointer}
                #ak-im-root .ak-im-meeting-join-btn:disabled{background:#9ca3af;cursor:not-allowed}
                #ak-im-root .ak-im-meeting-link-btn{flex:0 0 auto;border:1px solid rgba(15,23,42,.12);background:#ffffff;color:#374151;height:34px;padding:0 12px;border-radius:10px;font-size:13px;cursor:pointer}
                #ak-im-root .ak-im-meeting-publish-mask{position:fixed;inset:0;background:rgba(15,23,42,.18);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:1}
                #ak-im-root .ak-im-meeting-publish-sheet{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(420px,92%);max-height:86vh;background:#ffffff;border-radius:20px;z-index:2;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 48px rgba(15,23,42,.18)}
                #ak-im-root .ak-im-meeting-publish-header{padding:14px 18px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(15,23,42,.06);font-weight:600;font-size:15px;color:#111827}
                #ak-im-root .ak-im-meeting-publish-close{border:none;background:transparent;font-size:22px;line-height:1;color:#6b7280;cursor:pointer}
                #ak-im-root .ak-im-meeting-publish-body{padding:14px 18px;overflow:auto;display:flex;flex-direction:column;gap:12px}
                #ak-im-root .ak-im-meeting-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#6b7280}
                #ak-im-root .ak-im-meeting-field input[type="url"],#ak-im-root .ak-im-meeting-field input[type="text"],#ak-im-root .ak-im-meeting-field input[type="datetime-local"]{height:38px;border:1px solid rgba(15,23,42,.12);border-radius:10px;padding:0 12px;font-size:14px;color:#111827;background:#ffffff;transition:border-color .15s,box-shadow .15s}
                #ak-im-root .ak-im-meeting-field input[type="url"]:focus,#ak-im-root .ak-im-meeting-field input[type="text"]:focus,#ak-im-root .ak-im-meeting-field input[type="datetime-local"]:focus{outline:none;border-color:#07c160;box-shadow:0 0 0 3px rgba(7,193,96,.12)}
                #ak-im-root .ak-im-meeting-field-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
                #ak-im-root .ak-im-meeting-hint{font-style:normal;font-size:11px;color:#9ca3af;margin-left:4px}
                #ak-im-root .ak-im-meeting-publish-error{padding:8px 10px;border-radius:8px;background:rgba(239,68,68,.08);color:#dc2626;font-size:12px}
                #ak-im-root .ak-im-meeting-publish-footer{padding:12px 18px;display:flex;gap:10px;justify-content:flex-end;border-top:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-meeting-publish-cancel{border:1px solid rgba(15,23,42,.12);background:#ffffff;color:#374151;height:34px;padding:0 14px;border-radius:10px;font-size:13px;cursor:pointer}
                #ak-im-root .ak-im-meeting-publish-submit{border:none;background:#07c160;color:#ffffff;height:34px;padding:0 16px;border-radius:10px;font-size:13px;font-weight:500;cursor:pointer}
                #ak-im-root .ak-im-meeting-publish-submit:disabled{background:#9ca3af;cursor:not-allowed}
                #ak-im-root .ak-im-meeting-password-mask{position:fixed;inset:0;background:rgba(15,23,42,.24);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:3}
                #ak-im-root .ak-im-meeting-password-sheet{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(340px,86%);background:#ffffff;border-radius:20px;z-index:4;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 56px rgba(15,23,42,.28)}
                #ak-im-root .ak-im-meeting-password-title{padding:16px 18px 4px;font-weight:600;font-size:15px;color:#111827}
                #ak-im-root .ak-im-meeting-password-desc{padding:0 18px 4px;font-size:12px;color:#6b7280;line-height:1.6}
                #ak-im-root .ak-im-meeting-password-body{padding:10px 18px 4px}
                #ak-im-root .ak-im-meeting-password-body input{width:100%;box-sizing:border-box;height:38px;border:1px solid rgba(15,23,42,.12);border-radius:10px;padding:0 12px;font-size:15px;color:#111827;background:#ffffff;transition:border-color .15s,box-shadow .15s}
                #ak-im-root .ak-im-meeting-password-body input:focus{outline:none;border-color:#07c160;box-shadow:0 0 0 3px rgba(7,193,96,.12)}
                #ak-im-root .ak-im-meeting-password-error{margin:6px 18px 0;padding:6px 10px;border-radius:8px;background:rgba(239,68,68,.08);color:#dc2626;font-size:12px}
                #ak-im-root .ak-im-meeting-password-footer{padding:12px 18px 16px;display:flex;gap:10px;justify-content:flex-end}
                #ak-im-root .ak-im-meeting-password-cancel{border:1px solid rgba(15,23,42,.12);background:#ffffff;color:#374151;height:34px;padding:0 14px;border-radius:10px;font-size:13px;cursor:pointer}
                #ak-im-root .ak-im-meeting-password-submit{border:none;background:#07c160;color:#ffffff;height:34px;padding:0 16px;border-radius:10px;font-size:13px;font-weight:500;cursor:pointer}
                #ak-im-root .ak-im-meeting-password-submit:disabled{background:#9ca3af;cursor:not-allowed}
                #ak-im-root .ak-im-message-list{flex:1;overflow:auto;padding:14px 12px 10px;background:#ebebeb;display:flex;flex-direction:column;gap:14px}
                #ak-im-root .ak-im-empty{margin:auto;color:#94a3b8;font-size:13px;text-align:center;padding:28px 24px;line-height:1.6;white-space:pre-line}
                #ak-im-root .ak-im-time-divider{text-align:center;font-size:11px;color:#9ca3af;line-height:1.4}
                #ak-im-root .ak-im-message-row{display:flex;align-items:flex-start;gap:8px;max-width:100%}
                #ak-im-root .ak-im-message-row.ak-self{flex-direction:row-reverse}
                #ak-im-root .ak-im-avatar{width:34px;height:34px;border-radius:10px;background:#d1d5db;color:#374151;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex:0 0 auto}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-avatar{background:#7fd88a;color:#ffffff}
                #ak-im-root .ak-im-message-main{display:flex;flex-direction:column;max-width:min(78%, 420px)}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-message-main{align-items:flex-end}
                #ak-im-root .ak-im-message-sender{margin-bottom:4px;padding:0 2px;font-size:11px;color:#6b7280;line-height:1.4;display:flex;align-items:center;min-width:0}
                #ak-im-root .ak-im-bubble{padding:10px 12px;border-radius:8px;background:#ffffff;color:#111827;word-break:break-word;white-space:pre-wrap;box-shadow:0 1px 1px rgba(15,23,42,.04);font-size:15px;line-height:1.45}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-bubble{background:#95ec69}
                #ak-im-root .ak-im-bubble.ak-im-bubble-image{padding:4px;background:#ffffff;box-shadow:0 2px 8px rgba(15,23,42,.06);border-radius:16px;overflow:hidden;white-space:normal}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-bubble.ak-im-bubble-image{background:#d9f7c7}
                #ak-im-root .ak-im-image-bubble-link{display:block;line-height:0;text-decoration:none}
                #ak-im-root .ak-im-image-bubble-link.is-disabled{cursor:default}
                #ak-im-root .ak-im-image-bubble-surface{position:relative;display:block;overflow:hidden;border-radius:12px}
                #ak-im-root .ak-im-image-bubble-image{display:block;width:min(220px,56vw);max-width:100%;height:auto;max-height:280px;border-radius:12px;background:#f8fafc;object-fit:cover}
                #ak-im-root .ak-im-image-bubble-overlay{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px 9px;background:linear-gradient(180deg,rgba(15,23,42,0) 0%,rgba(15,23,42,.36) 28%,rgba(15,23,42,.68) 100%);color:#ffffff;font-size:12px;line-height:1.35;box-sizing:border-box}
                #ak-im-root .ak-im-image-bubble-overlay.is-failed{background:linear-gradient(180deg,rgba(127,29,29,0) 0%,rgba(127,29,29,.34) 28%,rgba(127,29,29,.8) 100%)}
                #ak-im-root .ak-im-image-bubble-status{display:inline-flex;align-items:center;min-width:0;font-weight:600;word-break:break-word;line-height:1.35}
                #ak-im-root .ak-im-image-bubble-progress{display:inline-flex;align-items:center;justify-content:flex-end;min-width:44px;font-weight:700;white-space:nowrap;line-height:1.2}
                #ak-im-root .ak-im-bubble.ak-im-bubble-file{padding:0;display:block;white-space:normal;overflow:hidden;border-radius:18px;min-width:0}
                #ak-im-root .ak-im-file-bubble-link,#ak-im-root .ak-im-file-bubble-expired{display:flex;align-items:center;gap:12px;min-width:min(220px,60vw);padding:12px 14px;box-sizing:border-box;color:inherit;text-decoration:none}
                #ak-im-root .ak-im-file-bubble-expired{opacity:.86}
                #ak-im-root .ak-im-file-bubble-icon{width:40px;height:40px;border-radius:14px;background:rgba(15,23,42,.06);display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;color:#0f172a}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-file-bubble-icon{background:rgba(255,255,255,.42)}
                #ak-im-root .ak-im-file-bubble-icon svg{width:22px;height:22px;stroke:currentColor}
                #ak-im-root .ak-im-file-bubble-body{min-width:0;display:flex;flex-direction:column;gap:4px}
                #ak-im-root .ak-im-file-bubble-name{font-size:14px;font-weight:700;line-height:1.35;color:inherit;word-break:break-all}
                #ak-im-root .ak-im-file-bubble-meta{font-size:12px;line-height:1.35;color:#6b7280}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-file-bubble-meta{color:rgba(15,23,42,.62)}
                #ak-im-root .ak-im-bubble.ak-im-bubble-emoji{padding:0;background:transparent;box-shadow:none;border-radius:14px;overflow:hidden;white-space:normal}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-bubble.ak-im-bubble-emoji{background:transparent}
                #ak-im-root .ak-im-bubble.ak-im-bubble-voice{min-width:0;padding:0;display:block;white-space:normal;overflow:hidden;border-radius:18px}
                #ak-im-root .ak-im-voice-bubble-surface{--ak-im-voice-progress:0;position:relative;width:min(100%,var(--ak-im-voice-bubble-width,148px));min-height:44px;display:flex;align-items:center;padding:10px 14px;box-sizing:border-box;cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:pan-y;border-radius:inherit;isolation:isolate;transition:transform .16s ease}
                #ak-im-root .ak-im-voice-bubble-surface:active{transform:scale(.992)}
                #ak-im-root .ak-im-voice-bubble-indicator{position:relative;z-index:1;display:inline-flex;align-items:center;gap:8px;min-width:0}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-voice-bubble-indicator{flex-direction:row-reverse}
                #ak-im-root .ak-im-voice-bubble-icon{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;opacity:.84;flex:0 0 auto}
                #ak-im-root .ak-im-voice-duration{font-size:15px;font-weight:700;line-height:1.2;color:inherit;white-space:nowrap}
                #ak-im-root .ak-im-voice-track{position:absolute;inset:0;border-radius:inherit;overflow:hidden;pointer-events:none}
                #ak-im-root .ak-im-voice-track-progress{position:absolute;left:0;top:0;bottom:0;width:calc(var(--ak-im-voice-progress,0) * 100%);border-radius:inherit;overflow:hidden;background:linear-gradient(90deg,rgba(255,255,255,.22) 0%,rgba(255,255,255,.16) 68%,rgba(255,255,255,.08) 100%);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08),inset -18px 0 26px rgba(255,255,255,.12);opacity:0;transition:width .1s linear,opacity .16s ease,box-shadow .16s ease}
                #ak-im-root .ak-im-voice-track-progress::before{content:"";position:absolute;inset:-12% -10px;background:radial-gradient(120% 92% at 32% 50%,rgba(255,255,255,.26) 0%,rgba(255,255,255,.14) 48%,rgba(255,255,255,0) 100%);filter:blur(10px);opacity:.95}
                #ak-im-root .ak-im-voice-track-progress::after{content:"";position:absolute;top:-10%;bottom:-10%;right:-10px;width:24px;background:linear-gradient(90deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.32) 55%,rgba(255,255,255,.08) 100%);filter:blur(4px)}
                #ak-im-root .ak-im-message-row.ak-peer .ak-im-voice-track-progress{background:linear-gradient(90deg,rgba(7,193,96,.14) 0%,rgba(7,193,96,.1) 68%,rgba(7,193,96,.04) 100%);box-shadow:inset 0 0 0 1px rgba(7,193,96,.08),inset -18px 0 24px rgba(34,197,94,.1)}
                #ak-im-root .ak-im-message-row.ak-peer .ak-im-voice-track-progress::before{background:radial-gradient(120% 92% at 32% 50%,rgba(34,197,94,.18) 0%,rgba(34,197,94,.09) 48%,rgba(34,197,94,0) 100%)}
                #ak-im-root .ak-im-message-row.ak-peer .ak-im-voice-track-progress::after{background:linear-gradient(90deg,rgba(34,197,94,0) 0%,rgba(34,197,94,.24) 55%,rgba(34,197,94,.04) 100%)}
                #ak-im-root .ak-im-voice-track-scan{position:absolute;top:4px;bottom:4px;left:calc(var(--ak-im-voice-progress,0) * 100%);width:30%;border-radius:999px;transform:translateX(-50%);background:radial-gradient(90% 80% at 50% 50%,rgba(255,255,255,.86) 0%,rgba(255,255,255,.34) 38%,rgba(255,255,255,0) 100%);filter:blur(8px);opacity:0;transition:left .1s linear,opacity .16s ease}
                #ak-im-root .ak-im-message-row.ak-peer .ak-im-voice-track-scan{background:radial-gradient(90% 80% at 50% 50%,rgba(34,197,94,.42) 0%,rgba(34,197,94,.18) 42%,rgba(34,197,94,0) 100%)}
                #ak-im-root .ak-im-voice-bubble-surface.is-active .ak-im-voice-track-progress{opacity:1}
                #ak-im-root .ak-im-voice-bubble-surface.is-playing .ak-im-voice-track-scan,#ak-im-root .ak-im-voice-bubble-surface.is-dragging .ak-im-voice-track-scan{opacity:.82}
                #ak-im-root .ak-im-voice-bubble-surface.is-complete .ak-im-voice-track-scan{opacity:0}
                #ak-im-root .ak-im-emoji-bubble-image{display:block;width:min(128px,42vw);max-width:100%;height:auto;border-radius:14px;background:#ffffff;object-fit:contain}
                #ak-im-root .ak-im-emoji-bubble-fallback{display:inline-flex;align-items:center;justify-content:center;min-width:92px;min-height:92px;padding:12px 14px;border-radius:14px;background:#ffffff;color:#111827;font-size:14px;line-height:1.5;box-sizing:border-box}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-emoji-bubble-fallback{background:#95ec69}
                #ak-im-root .ak-im-message-footer{margin-top:4px;display:flex;align-items:center;gap:6px;min-height:22px}
                #ak-im-root .ak-im-message-row.ak-self .ak-im-message-footer{justify-content:flex-end}
                #ak-im-root .ak-im-meta{font-size:11px;color:#9ca3af;line-height:1.4}
                #ak-im-root .ak-im-progress-btn{width:24px;height:24px;border:none;background:transparent;padding:0;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;cursor:pointer;position:relative}
                #ak-im-root .ak-im-progress-ring{width:24px;height:24px;transform:rotate(-90deg);overflow:visible}
                #ak-im-root .ak-im-progress-track{fill:none;stroke:rgba(15,23,42,.1);stroke-width:2}
                #ak-im-root .ak-im-progress-value{fill:none;stroke:#16a34a;stroke-width:2;stroke-linecap:round;transition:stroke-dashoffset .18s ease}
                #ak-im-root .ak-im-progress-label{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;color:#16a34a;line-height:1;letter-spacing:-.02em}
                #ak-im-root .ak-im-progress-btn.is-complete .ak-im-progress-label{font-size:11px}
                #ak-im-root .ak-im-progress-btn:focus-visible{outline:none}
                #ak-im-root .ak-im-composer{padding:8px 10px calc(8px + env(safe-area-inset-bottom, 0px));border-top:1px solid rgba(15,23,42,.06);display:grid;grid-template-columns:auto 1fr auto;align-items:flex-end;gap:8px;background:#f7f7f7}
                #ak-im-root .ak-im-composer-side,#ak-im-root .ak-im-composer-actions{display:flex;align-items:flex-end;gap:8px}
                #ak-im-root .ak-im-composer-main{min-width:0;display:flex;align-items:flex-end}
                #ak-im-root .ak-im-composer-btn{width:38px;height:38px;border:none;border-radius:999px;background:transparent;color:#111827;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;box-shadow:none;flex:0 0 auto;transition:opacity .18s ease,transform .18s ease,color .18s ease}
                #ak-im-root .ak-im-composer-btn svg{width:28px;height:28px;stroke:currentColor;fill:none;stroke-width:1.55;stroke-linecap:round;stroke-linejoin:round}
                #ak-im-root .ak-im-composer-btn:disabled,#ak-im-root .ak-im-composer-btn.is-disabled{opacity:.55;cursor:default;box-shadow:none}
                #ak-im-root .ak-im-composer-btn.is-active{color:#111827;background:transparent}
                #ak-im-root .ak-im-composer-voice .ak-im-icon-default,#ak-im-root .ak-im-composer-voice .ak-im-icon-alt,#ak-im-root .ak-im-emoji-toggle .ak-im-icon-default,#ak-im-root .ak-im-emoji-toggle .ak-im-icon-alt,#ak-im-root .ak-im-composer-plus svg{width:30px;height:30px}
                #ak-im-root .ak-im-composer-plus svg{stroke-width:1.75}
                #ak-im-root .ak-im-composer-plus:disabled,#ak-im-root .ak-im-composer-plus.is-disabled{opacity:1;color:#111827}
                #ak-im-root .ak-im-composer-voice .ak-im-icon-alt,#ak-im-root .ak-im-emoji-toggle .ak-im-icon-alt{display:none}
                #ak-im-root.ak-im-composer-voice-mode .ak-im-composer-voice .ak-im-icon-default{display:none}
                #ak-im-root.ak-im-composer-voice-mode .ak-im-composer-voice .ak-im-icon-alt{display:block}
                #ak-im-root.ak-im-emoji-open .ak-im-emoji-toggle .ak-im-icon-default{display:none}
                #ak-im-root.ak-im-emoji-open .ak-im-emoji-toggle .ak-im-icon-alt{display:block}
                #ak-im-root .ak-im-input-wrap{flex:1;min-height:38px;display:flex;align-items:flex-end;background:#ffffff;border-radius:18px;padding:8px 12px;box-shadow:0 1px 1px rgba(15,23,42,.06)}
                #ak-im-root .ak-im-input{width:100%;resize:none;border:none;outline:none;background:transparent;min-height:22px;max-height:96px;font-size:15px;line-height:1.5;color:#111827}
                #ak-im-root .ak-im-hold-to-talk{display:none;width:100%;min-height:38px;border:none;border-radius:18px;background:#ffffff;color:#111827;font-size:15px;line-height:1.4;align-items:center;justify-content:center;padding:0 16px;box-shadow:0 1px 1px rgba(15,23,42,.06);cursor:pointer}
                #ak-im-root .ak-im-hold-to-talk:active{background:#e5e7eb}
                #ak-im-root .ak-im-hold-to-talk:disabled{opacity:.5;cursor:default}
                #ak-im-root.ak-im-composer-voice-mode .ak-im-input-wrap{display:none}
                #ak-im-root.ak-im-composer-voice-mode .ak-im-hold-to-talk{display:inline-flex}
                #ak-im-root.ak-im-voice-hold-recording .ak-im-hold-to-talk{background:#e5e7eb;color:#111827}
                #ak-im-root.ak-im-voice-hold-cancel-ready .ak-im-hold-to-talk{background:#fee2e2;color:#dc2626}
                #ak-im-root.ak-im-voice-hold-sending .ak-im-hold-to-talk{background:#f3f4f6;color:#9ca3af}
                #ak-im-root .ak-im-voice-record-overlay{pointer-events:none;opacity:0;transition:opacity .18s ease;position:absolute;inset:0;z-index:8;display:flex;flex-direction:column;justify-content:flex-end;background:rgba(0,0,0,0)}
                #ak-im-root .ak-im-voice-record-overlay::before{content:"";position:absolute;inset:0;background:rgba(0,0,0,.36);opacity:0;transition:opacity .18s ease}
                #ak-im-root .ak-im-voice-record-overlay-inner{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:28px;min-height:100%;padding:96px 18px calc(104px + env(safe-area-inset-bottom, 0px));box-sizing:border-box}
                #ak-im-root .ak-im-voice-record-card{position:relative;min-width:228px;max-width:min(72vw,312px);padding:18px 22px 22px;border-radius:22px;background:linear-gradient(180deg,#9bf46d 0%,#8eef61 100%);box-shadow:0 18px 42px rgba(0,0,0,.18);display:flex;flex-direction:column;align-items:center;gap:12px;color:#1f2937;transform:translateY(10px) scale(.96);transition:transform .18s ease,background .18s ease,color .18s ease}
                #ak-im-root .ak-im-voice-record-card::after{content:"";position:absolute;left:50%;bottom:-10px;width:20px;height:20px;background:inherit;transform:translateX(-50%) rotate(45deg);border-radius:4px;box-shadow:6px 6px 18px rgba(0,0,0,.08)}
                #ak-im-root .ak-im-voice-record-meter{position:relative;z-index:1;display:flex;align-items:flex-end;justify-content:center;gap:3px;height:34px;margin-top:0}
                #ak-im-root .ak-im-voice-record-bar{width:4px;height:12px;border-radius:999px;background:rgba(17,24,39,.42);transform-origin:center bottom;transition:height .08s linear,background .18s ease,opacity .18s ease}
                #ak-im-root .ak-im-voice-record-bar.is-active{background:rgba(17,24,39,.86)}
                #ak-im-root .ak-im-voice-record-timer{position:relative;z-index:1;font-size:16px;font-weight:700;line-height:1.2;letter-spacing:.04em}
                #ak-im-root .ak-im-voice-cancel-zone{position:relative;width:min(62vw,248px);max-width:100%;aspect-ratio:2 / 1;box-sizing:border-box;transform:translateY(18px);background:transparent;display:flex;align-items:center;justify-content:center;padding:18px 18px 10px;color:#475569;font-size:15px;font-weight:700;line-height:1.35;overflow:visible;transition:color .18s ease,transform .18s ease}
                #ak-im-root .ak-im-voice-cancel-zone::before{content:"";position:absolute;inset:0;clip-path:ellipse(50% 100% at 50% 100%);background:linear-gradient(180deg,rgba(246,247,250,.86) 0%,rgba(223,228,236,.88) 46%,rgba(208,214,223,.68) 72%,rgba(208,214,223,.18) 88%,rgba(208,214,223,0) 100%);filter:drop-shadow(0 18px 34px rgba(0,0,0,.12));pointer-events:none;transition:background .18s ease,filter .18s ease}
                #ak-im-root .ak-im-voice-cancel-zone::after{content:"";position:absolute;inset:0;clip-path:ellipse(50% 100% at 50% 100%);background:radial-gradient(140% 110% at 50% 0%,rgba(255,255,255,.94) 0%,rgba(255,255,255,.74) 16%,rgba(255,255,255,.36) 40%,rgba(255,255,255,.12) 58%,rgba(255,255,255,0) 78%);pointer-events:none}
                #ak-im-root .ak-im-voice-cancel-zone.is-active{color:#ffffff}
                #ak-im-root .ak-im-voice-cancel-zone.is-active::before{background:linear-gradient(180deg,rgba(248,113,113,.92) 0%,rgba(239,68,68,.92) 54%,rgba(220,38,38,.62) 78%,rgba(220,38,38,.16) 90%,rgba(220,38,38,0) 100%);filter:drop-shadow(0 20px 34px rgba(239,68,68,.24))}
                #ak-im-root .ak-im-voice-cancel-label{position:relative;z-index:1;white-space:nowrap;transform:translateY(10px)}
                #ak-im-root.ak-im-voice-hold-recording .ak-im-voice-record-overlay,#ak-im-root.ak-im-voice-hold-cancel-ready .ak-im-voice-record-overlay{opacity:1}
                #ak-im-root.ak-im-voice-hold-recording .ak-im-voice-record-overlay::before,#ak-im-root.ak-im-voice-hold-cancel-ready .ak-im-voice-record-overlay::before{opacity:1}
                #ak-im-root.ak-im-voice-hold-recording .ak-im-voice-record-card,#ak-im-root.ak-im-voice-hold-cancel-ready .ak-im-voice-record-card{transform:translateY(0) scale(1)}
                #ak-im-root.ak-im-voice-hold-cancel-ready .ak-im-voice-record-card{background:linear-gradient(180deg,#9bf46d 0%,#8eef61 100%);color:#1f2937}
                #ak-im-root.ak-im-voice-hold-cancel-ready .ak-im-voice-record-bar{background:rgba(17,24,39,.38)}
                #ak-im-root.ak-im-voice-hold-cancel-ready .ak-im-voice-record-bar.is-active{background:rgba(17,24,39,.84)}
                #ak-im-root .ak-im-send{display:none;height:36px;border:none;border-radius:18px;padding:0 18px;background:#07c160;color:#ffffff;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .18s ease,transform .18s ease}
                #ak-im-root.ak-im-composer-has-text .ak-im-send{display:inline-flex;align-items:center;justify-content:center}
                #ak-im-root.ak-im-composer-has-text .ak-im-composer-plus{display:none}
                #ak-im-root .ak-im-send:disabled{opacity:.42;cursor:not-allowed}
                #ak-im-root .ak-im-emoji-sheet{height:0;overflow:hidden;background:#f7f7f7;transition:height .22s ease;border-top:1px solid transparent}
                #ak-im-root .ak-im-emoji-sheet.is-open{height:min(320px,44vh);border-top-color:rgba(15,23,42,.06)}
                #ak-im-root .ak-im-plus-sheet{height:0;overflow:hidden;background:#f7f7f7;transition:height .22s ease;border-top:1px solid transparent}
                #ak-im-root .ak-im-plus-sheet.is-open{height:min(244px,34vh);border-top-color:rgba(15,23,42,.06)}
                #ak-im-root .ak-im-plus-sheet-panel{height:100%;background:#f7f7f7;padding:18px 18px calc(18px + env(safe-area-inset-bottom, 0px));box-sizing:border-box}
                #ak-im-root .ak-im-plus-grid{height:100%;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 20px;align-content:start;justify-items:center}
                #ak-im-root .ak-im-plus-item{width:100%;max-width:132px;border:none;background:transparent;padding:0;display:flex;flex-direction:column;align-items:center;gap:10px;cursor:pointer;color:#111827}
                #ak-im-root .ak-im-plus-item:disabled{opacity:.45;cursor:default}
                #ak-im-root .ak-im-plus-item:active .ak-im-plus-item-icon{transform:scale(.96)}
                #ak-im-root .ak-im-plus-item-icon{width:58px;height:58px;border-radius:18px;background:#ffffff;box-shadow:0 1px 2px rgba(15,23,42,.06);display:flex;align-items:center;justify-content:center;transition:transform .16s ease}
                #ak-im-root .ak-im-plus-item-icon svg{width:28px;height:28px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
                #ak-im-root .ak-im-plus-item-label{font-size:13px;line-height:1.4;color:#6b7280;text-align:center}
                #ak-im-root .ak-im-emoji-sheet-panel{height:100%;display:flex;flex-direction:column;background:#f7f7f7}
                #ak-im-root .ak-im-emoji-sheet-tabs{display:flex;align-items:center;gap:12px;padding:10px 12px 8px}
                #ak-im-root .ak-im-emoji-sheet-tab{width:44px;height:44px;border:none;border-radius:12px;background:transparent;color:#111827;opacity:.52;display:inline-flex;align-items:center;justify-content:center;padding:0;cursor:pointer;transition:background .18s ease,opacity .18s ease,box-shadow .18s ease}
                #ak-im-root .ak-im-emoji-sheet-tab.is-active{background:#e5e7eb;opacity:1;box-shadow:none}
                #ak-im-root .ak-im-emoji-sheet-tab svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
                #ak-im-root .ak-im-emoji-sheet-body{flex:1;overflow:auto;padding:0 10px calc(12px + env(safe-area-inset-bottom, 0px))}
                #ak-im-root .ak-im-emoji-section + .ak-im-emoji-section{margin-top:16px}
                #ak-im-root .ak-im-emoji-section-title{margin:0 0 8px 4px;font-size:12px;font-weight:600;color:#9ca3af;line-height:1.5}
                #ak-im-root .ak-im-emoji-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px}
                #ak-im-root .ak-im-emoji-item{min-height:46px;border:none;border-radius:16px;background:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:24px;cursor:pointer;box-shadow:0 1px 2px rgba(15,23,42,.05);padding:0}
                #ak-im-root .ak-im-emoji-item:active,#ak-im-root .ak-im-sticker-item:active{transform:scale(.96)}
                #ak-im-root .ak-im-sticker-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
                #ak-im-root .ak-im-sticker-item{aspect-ratio:1 / 1;border:none;border-radius:18px;background:#ffffff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:10px 8px 9px;cursor:pointer;box-shadow:0 1px 2px rgba(15,23,42,.05)}
                #ak-im-root .ak-im-sticker-preview{flex:1;min-height:0;width:100%;display:flex;align-items:center;justify-content:center}
                #ak-im-root .ak-im-sticker-img{max-width:100%;max-height:100%;object-fit:contain}
                #ak-im-root .ak-im-sticker-label{max-width:100%;font-size:12px;line-height:1.2;color:#6b7280;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                #ak-im-root .ak-im-sticker-fallback{font-size:12px;line-height:1.2;color:#6b7280;text-align:center}
                #ak-im-root .ak-im-emoji-loading,#ak-im-root .ak-im-emoji-error,#ak-im-root .ak-im-emoji-empty{padding:36px 16px;color:#6b7280;font-size:13px;line-height:1.7;text-align:center}
                #ak-im-root .ak-im-emoji-error{color:#ef4444}
                #ak-im-root .ak-im-status{padding:0 12px calc(8px + env(safe-area-inset-bottom, 0px));background:#f7f7f7;font-size:11px;color:#9ca3af}
                #ak-im-root .ak-im-status:empty{display:none}
                #ak-im-root .ak-im-chat-subtitle:empty{display:none}
                #ak-im-root .ak-im-compose-page{flex:1;background:#f7f7f7;padding:22px 16px calc(24px + env(safe-area-inset-bottom, 0px));display:flex;flex-direction:column;gap:14px}
                #ak-im-root .ak-im-compose-card{background:#ffffff;border-radius:18px;padding:18px 16px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
                #ak-im-root .ak-im-compose-label{font-size:13px;line-height:1.6;color:#6b7280}
                #ak-im-root .ak-im-compose-input{margin-top:12px;width:100%;height:48px;border:none;border-radius:12px;background:#f3f4f6;padding:0 14px;font-size:16px;color:#111827;outline:none;box-sizing:border-box}
                #ak-im-root .ak-im-compose-input:focus{background:#ffffff;box-shadow:0 0 0 2px rgba(7,193,96,.16) inset}
                #ak-im-root .ak-im-compose-tip{margin-top:10px;font-size:12px;line-height:1.6;color:#9ca3af}
                #ak-im-root .ak-im-compose-error{color:#ef4444}
                #ak-im-root .ak-im-compose-actions{display:flex;gap:10px;margin-top:auto}
                #ak-im-root .ak-im-compose-btn{flex:1;height:44px;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer}
                #ak-im-root .ak-im-compose-btn-secondary{background:#e5e7eb;color:#374151}
                #ak-im-root .ak-im-compose-btn-primary{background:#07c160;color:#ffffff}
                #ak-im-root .ak-im-compose-btn:disabled{opacity:.42;cursor:not-allowed}
                #ak-im-root .ak-im-system-row{align-self:center;background:rgba(0,0,0,.06);color:#6b7280;font-size:12px;line-height:1.6;padding:6px 10px;border-radius:999px;max-width:78%;text-align:center}
                #ak-im-root .ak-im-system-row a{color:#07c160;text-decoration:none;margin-left:6px;font-size:12px}
                #ak-im-root .ak-im-system-row a:active{opacity:.7}
                #ak-im-root .ak-im-action-sheet{display:none;position:fixed;inset:0;z-index:2147483648}
                #ak-im-root .ak-im-action-sheet.visible{display:block}
                #ak-im-root .ak-im-action-mask{position:absolute;inset:0;background:rgba(0,0,0,.18)}
                #ak-im-root .ak-im-action-panel{position:absolute;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom, 0px));background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 16px 36px rgba(0,0,0,.18)}
                #ak-im-root .ak-im-action-btn{width:100%;height:52px;border:none;background:#ffffff;color:#111827;font-size:16px;font-weight:600;cursor:pointer}
                #ak-im-root .ak-im-action-btn + .ak-im-action-btn{border-top:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-action-btn.danger{color:#ef4444}
                #ak-im-root .ak-im-action-btn:disabled{opacity:.45;cursor:not-allowed}
                #ak-im-root .ak-im-progress-sheet{display:none;position:fixed;inset:0;z-index:2147483649}
                #ak-im-root .ak-im-progress-sheet.visible{display:block}
                #ak-im-root .ak-im-progress-mask{position:absolute;inset:0;background:rgba(0,0,0,.22)}
                #ak-im-root .ak-im-progress-panel{position:absolute;left:0;right:0;bottom:0;background:#ffffff;border-radius:18px 18px 0 0;box-shadow:0 -12px 36px rgba(0,0,0,.18);max-height:min(72vh,560px);display:flex;flex-direction:column}
                #ak-im-root .ak-im-progress-header{padding:14px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-progress-title{font-size:15px;font-weight:600;color:#111827;line-height:1.4}
                #ak-im-root .ak-im-progress-close{border:none;background:transparent;color:#6b7280;font-size:14px;cursor:pointer}
                #ak-im-root .ak-im-progress-panel-body{flex:1;min-height:0;overflow:auto}
                #ak-im-root .ak-im-member-sheet{display:none;position:fixed;inset:0;z-index:2147483650}
                #ak-im-root .ak-im-member-sheet.visible{display:block}
                #ak-im-root .ak-im-member-mask{position:absolute;inset:0;background:rgba(0,0,0,.22)}
                #ak-im-root .ak-im-member-panel{position:absolute;left:0;right:0;bottom:0;background:#ffffff;border-radius:18px 18px 0 0;box-shadow:0 -12px 36px rgba(0,0,0,.18);max-height:min(72vh,560px);display:flex;flex-direction:column}
                #ak-im-root .ak-im-member-header{padding:14px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-member-title{font-size:15px;font-weight:600;color:#111827;line-height:1.4}
                #ak-im-root .ak-im-member-close{border:none;background:transparent;color:#6b7280;font-size:14px;cursor:pointer}
                #ak-im-root .ak-im-progress-loading,#ak-im-root .ak-im-progress-error,#ak-im-root .ak-im-progress-empty,#ak-im-root .ak-im-member-loading,#ak-im-root .ak-im-member-error,#ak-im-root .ak-im-member-empty{padding:28px 16px;text-align:center;font-size:13px;line-height:1.7;color:#9ca3af}
                #ak-im-root .ak-im-progress-error,#ak-im-root .ak-im-member-error{color:#ef4444}
                #ak-im-root .ak-im-progress-summary{padding:18px 16px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;border-bottom:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-progress-stat{background:#f8fafc;border-radius:14px;padding:14px 10px;text-align:center}
                #ak-im-root .ak-im-progress-stat-value{font-size:22px;font-weight:700;color:#111827;line-height:1.2}
                #ak-im-root .ak-im-progress-stat-label{margin-top:4px;font-size:12px;color:#6b7280;line-height:1.4}
                #ak-im-root .ak-im-progress-list{padding:16px}
                #ak-im-root .ak-im-progress-list-title{margin:0 0 12px;font-size:13px;font-weight:600;color:#6b7280;line-height:1.5}
                #ak-im-root .ak-im-progress-member{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 0;border-bottom:1px solid rgba(15,23,42,.05)}
                #ak-im-root .ak-im-progress-member:last-child{border-bottom:none}
                #ak-im-root .ak-im-progress-member-name{font-size:14px;color:#111827;line-height:1.5;display:inline-flex;align-items:center;min-width:0}
                #ak-im-root .ak-im-progress-member-username{margin-left:6px;font-size:12px;color:#9ca3af;line-height:1.4;white-space:nowrap}
                #ak-im-root .ak-im-member-panel-body{flex:1;min-height:0;overflow:auto;padding:14px 16px 18px}
                #ak-im-root .ak-im-member-summary{font-size:13px;color:#9ca3af;line-height:1.6;margin-bottom:12px}
                #ak-im-root .ak-im-member-list{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px 10px;align-content:start}
                #ak-im-root .ak-im-member-item{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;min-width:0}
                #ak-im-root .ak-im-member-avatar{width:56px;height:56px;border-radius:16px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:18px;font-weight:700}
                #ak-im-root .ak-im-member-body{width:100%;min-width:0}
                #ak-im-root .ak-im-member-name{font-size:13px;font-weight:600;color:#111827;line-height:1.5;display:flex;align-items:center;justify-content:center;min-width:0}
                #ak-im-root .ak-im-member-role{font-size:11px;color:#07c160;line-height:1.4}
                #ak-im-root .ak-im-group-info-hero{background:#ffffff;padding:20px 16px 16px;display:flex;flex-direction:column;align-items:center;gap:8px}
                #ak-im-root .ak-im-group-info-hero-avatar{width:72px;height:72px;border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.06)}
                #ak-im-root .ak-im-group-info-hero-avatar .ak-im-avatar-mosaic .ak-im-avatar-cell{font-size:11px}
                #ak-im-root .ak-im-group-info-hero-avatar .ak-im-avatar-mosaic.is-single .ak-im-avatar-cell{font-size:22px}
                #ak-im-root .ak-im-group-info-hero-title{font-size:17px;font-weight:700;color:#111827;line-height:1.3;text-align:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 12px}
                #ak-im-root .ak-im-group-info-hero-subtitle{font-size:12px;color:#6b7280;line-height:1.4}
                #ak-im-root .ak-im-group-info-screen{background:#ededed}
                #ak-im-root .ak-im-group-info-side{width:52px;min-width:52px}
                #ak-im-root .ak-im-group-info-page{flex:1;overflow:auto;padding:12px 12px calc(24px + env(safe-area-inset-bottom, 0px));background:#f7f7f7}
                #ak-im-root .ak-im-group-info-section{background:#ffffff;border-radius:18px;padding:0 16px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
                #ak-im-root .ak-im-group-info-section + .ak-im-group-info-section{margin-top:12px}
                #ak-im-root .ak-im-group-info-cell{width:100%;border:none;background:#ffffff;padding:15px 0;display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left;cursor:default}
                #ak-im-root .ak-im-group-info-cell + .ak-im-group-info-cell{border-top:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-group-info-cell.is-action{cursor:pointer}
                #ak-im-root .ak-im-group-info-cell.is-danger .ak-im-group-info-cell-label{color:#ef4444}
                #ak-im-root .ak-im-group-info-cell-main{min-width:0;flex:1;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
                #ak-im-root .ak-im-group-info-cell-label{font-size:16px;color:#111827;line-height:1.5;text-align:left}
                #ak-im-root .ak-im-group-info-cell-value{min-width:0;max-width:70%;font-size:14px;color:#9ca3af;line-height:1.5;text-align:right;display:block;white-space:normal;overflow:visible;text-overflow:clip;word-break:break-word}
                #ak-im-root .ak-im-group-info-member-inline{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%}
                #ak-im-root .ak-im-group-info-member-username{font-size:12px;color:#9ca3af;white-space:nowrap}
                #ak-im-root .ak-im-inline-sep{color:#cbd5e1}
                #ak-im-root .ak-im-group-info-collection-more{color:#9ca3af;white-space:nowrap}
                #ak-im-root .ak-im-group-info-cell-arrow{color:#c7cdd8;font-size:20px;line-height:1;flex:0 0 auto}
                #ak-im-root .ak-im-session-avatar.is-mosaic{padding:0;background:transparent}
                #ak-im-root .ak-im-session-avatar.is-mosaic .ak-im-avatar-mosaic .ak-im-avatar-cell{font-size:9px}
                #ak-im-root .ak-im-member-action-screen{background:#ededed}
                #ak-im-root .ak-im-member-action-page{position:relative;flex:1;display:flex;flex-direction:column;min-height:0;background:#f7f7f7}
                #ak-im-root .ak-im-member-action-search{padding:10px 12px;background:#ededed;border-bottom:1px solid rgba(15,23,42,.04)}
                #ak-im-root .ak-im-member-action-search-input{width:100%;height:36px;border:none;border-radius:12px;background:#ffffff;padding:0 14px;font-size:14px;color:#111827;outline:none;box-sizing:border-box}
                #ak-im-root .ak-im-member-action-search-input:focus{box-shadow:0 0 0 2px rgba(7,193,96,.14) inset}
                #ak-im-root .ak-im-member-action-body{flex:1;overflow:auto;padding:12px 12px calc(92px + env(safe-area-inset-bottom, 0px));background:#f7f7f7}
                #ak-im-root .ak-im-member-action-section{background:#ffffff;border-radius:18px;padding:14px 14px 12px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
                #ak-im-root .ak-im-member-action-section + .ak-im-member-action-section{margin-top:12px}
                #ak-im-root .ak-im-member-action-section-title{margin:0 0 10px;font-size:13px;font-weight:600;color:#374151;line-height:1.4}
                #ak-im-root .ak-im-member-action-selected-empty{padding:10px 2px;color:#9ca3af;font-size:13px;line-height:1.6}
                #ak-im-root .ak-im-member-action-chip-list{display:flex;flex-wrap:wrap;gap:8px}
                #ak-im-root .ak-im-member-action-chip{max-width:100%;border:none;background:#f0fdf4;color:#166534;min-height:32px;border-radius:999px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;cursor:pointer}
                #ak-im-root .ak-im-member-action-chip:active{opacity:.78}
                #ak-im-root .ak-im-member-action-chip-label{min-width:0;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;font-weight:600;display:flex;align-items:center}
                #ak-im-root .ak-im-member-action-chip-remove{font-size:14px;line-height:1}
                #ak-im-root .ak-im-member-action-list{display:flex;flex-direction:column}
                #ak-im-root .ak-im-member-action-row{width:100%;padding:12px 0;border:none;background:transparent;display:flex;align-items:center;gap:12px;text-align:left;cursor:pointer}
                #ak-im-root .ak-im-member-action-row + .ak-im-member-action-row{border-top:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-member-action-row:disabled{cursor:not-allowed;opacity:1}
                #ak-im-root .ak-im-member-action-row.is-disabled .ak-im-member-action-name{color:#9ca3af}
                #ak-im-root .ak-im-member-action-row.is-disabled .ak-im-member-action-meta{color:#c7cdd8}
                #ak-im-root .ak-im-member-action-avatar{width:44px;height:44px;border-radius:14px;background:linear-gradient(180deg,#8fe3a8 0%,#56c57b 100%);color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex:0 0 auto}
                #ak-im-root .ak-im-member-action-main{min-width:0;flex:1}
                #ak-im-root .ak-im-member-action-name{font-size:15px;font-weight:600;color:#111827;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;min-width:0}
                #ak-im-root .ak-im-member-action-meta{margin-top:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:#6b7280;line-height:1.4}
                #ak-im-root .ak-im-member-action-role{display:inline-flex;align-items:center;justify-content:center;height:18px;padding:0 6px;border-radius:999px;background:rgba(7,193,96,.12);color:#16a34a;font-size:10px;font-weight:700}
                #ak-im-root .ak-im-member-action-reason{color:#ef4444}
                #ak-im-root .ak-im-member-action-reason.is-muted{color:#9ca3af}
                #ak-im-root .ak-im-member-action-check{width:22px;height:22px;border-radius:999px;border:1.5px solid rgba(156,163,175,.6);display:inline-flex;align-items:center;justify-content:center;color:transparent;font-size:14px;font-weight:700;flex:0 0 auto;box-sizing:border-box}
                #ak-im-root .ak-im-member-action-check.is-selected{background:#07c160;border-color:#07c160;color:#ffffff}
                #ak-im-root .ak-im-member-action-check.is-disabled{border-style:dashed;background:#f3f4f6;color:transparent}
                #ak-im-root .ak-im-member-action-footer{position:absolute;left:0;right:0;bottom:0;padding:12px 12px calc(12px + env(safe-area-inset-bottom, 0px));background:linear-gradient(180deg,rgba(247,247,247,0) 0%,#f7f7f7 28%,#f7f7f7 100%)}
                #ak-im-root .ak-im-member-action-submit{width:100%;height:48px;border:none;border-radius:14px;background:#07c160;color:#ffffff;font-size:16px;font-weight:700;cursor:pointer;box-shadow:0 10px 24px rgba(7,193,96,.18)}
                #ak-im-root .ak-im-member-action-submit:disabled{opacity:.42;cursor:not-allowed;box-shadow:none}
                #ak-im-root .ak-im-member-action-error{margin-bottom:12px;padding:11px 12px;border-radius:14px;background:rgba(239,68,68,.08);color:#dc2626;font-size:13px;line-height:1.6}
                #ak-im-root .ak-im-member-action-empty{padding:28px 14px;color:#9ca3af;font-size:13px;line-height:1.7;text-align:center}
                #ak-im-root .ak-im-dialog{display:none;position:fixed;inset:0;z-index:2147483651}
                #ak-im-root .ak-im-dialog.visible{display:block}
                #ak-im-root .ak-im-dialog-mask{position:absolute;inset:0;background:rgba(0,0,0,.36)}
                #ak-im-root .ak-im-dialog-panel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(320px,calc(100vw - 40px));background:#ffffff;border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.22);overflow:hidden}
                #ak-im-root .ak-im-dialog-content{padding:24px 20px 18px;text-align:center}
                #ak-im-root .ak-im-dialog-title{font-size:18px;font-weight:600;color:#111827;line-height:1.4}
                #ak-im-root .ak-im-dialog-message{margin-top:12px;font-size:14px;color:#6b7280;line-height:1.7;white-space:pre-line}
                #ak-im-root .ak-im-dialog-actions{display:flex;border-top:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-dialog-actions.is-single .ak-im-dialog-btn + .ak-im-dialog-btn{display:none}
                #ak-im-root .ak-im-dialog-btn{flex:1;height:52px;border:none;background:#ffffff;color:#111827;font-size:16px;font-weight:500;cursor:pointer}
                #ak-im-root .ak-im-dialog-btn + .ak-im-dialog-btn{border-left:1px solid rgba(15,23,42,.06)}
                #ak-im-root .ak-im-dialog-btn.is-danger{color:#ef4444;font-weight:600}
                #ak-im-root .ak-im-dialog-btn:disabled{opacity:.42;cursor:not-allowed}
                @media (max-width: 640px){#ak-im-root{left:calc(50% + 42px);top:calc(env(safe-area-inset-top, 0px) - 10px)}#ak-im-root .ak-im-topbar{grid-template-columns:48px 1fr 56px}#ak-im-root .ak-im-session-avatar{width:44px;height:44px;border-radius:12px}#ak-im-root .ak-im-message-main{max-width:78%}}
            `;
        },

        buildMarkupText() {
            return `
            <button class="ak-im-launcher" type="button" aria-label="内部聊天">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M6.25 6.15C6.25 4.96 7.21 4 8.4 4H13.05C14.24 4 15.2 4.96 15.2 6.15V9.85C15.2 11.04 14.24 12 13.05 12H10.15L7.45 14.08C7.17 14.3 6.75 14.1 6.75 13.75V12H6.25V6.15Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                    <circle cx="9.45" cy="8" r="0.8" fill="currentColor"/>
                    <circle cx="11.95" cy="8" r="0.8" fill="currentColor"/>
                    <path d="M14.15 8.55H16.2C17.39 8.55 18.35 9.51 18.35 10.7V13.15C18.35 14.34 17.39 15.3 16.2 15.3H15.05V16.55C15.05 16.89 14.66 17.09 14.39 16.89L12.55 15.55" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>
                </svg>
                <span class="ak-im-launcher-badge" aria-hidden="true"></span>
            </button>
            <div class="ak-im-shell">
                <div class="ak-im-screen ak-im-session-screen">
                    <div class="ak-im-topbar">
                        <button class="ak-im-nav-btn ak-im-close" type="button" aria-label="关闭内部聊天">
                            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18L9 12L15 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <button class="ak-im-nav-btn ak-im-contact-search-back is-hidden" type="button" aria-label="返回搜索前页面">
                            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18L9 12L15 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <div class="ak-im-topbar-title ak-im-session-topbar-title">聊天</div>
                        <div class="ak-im-topbar-search-wrap">
                            <label class="ak-im-contact-search-box" aria-label="搜索联系人">
                                <span class="ak-im-contact-search-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="5.8" stroke-width="1.8"></circle><path d="m16 16 3.5 3.5" stroke-width="1.8" stroke-linecap="round"></path></svg></span>
                                <input class="ak-im-contact-search-input" type="search" inputmode="search" autocomplete="off" spellcheck="false" placeholder="搜索联系人" />
                                <button class="ak-im-contact-search-clear is-hidden" type="button" aria-label="清空搜索">×</button>
                            </label>
                        </div>
                        <button class="ak-im-nav-btn ak-im-new" type="button" data-im-action="new">发起</button>
                        <div class="ak-im-topbar-actions ak-im-home-topbar-actions">
                            <button class="ak-im-nav-btn ak-im-home-search-trigger" type="button" aria-label="搜索联系人">
                                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="5.8" stroke-width="1.8"></circle><path d="m16 16 3.5 3.5" stroke-width="1.8" stroke-linecap="round"></path></svg>
                            </button>
                            <button class="ak-im-nav-btn ak-im-home-add-trigger" type="button" aria-label="更多功能" aria-expanded="false">
                                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke-width="1.6"></circle><path d="M12 9v6M9 12h6" stroke-width="1.6" stroke-linecap="round"></path></svg>
                            </button>
                            <div class="ak-im-home-add-menu" aria-label="更多功能菜单" role="menu">
                                <button class="ak-im-home-add-action" type="button" data-im-home-add-action="start_group" role="menuitem">
                                    <span class="ak-im-home-add-action-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4.9 17.8c.32-1.9 1.94-3.2 3.97-3.2 1.98 0 3.58 1.3 3.92 3.2"></path><path d="M8.86 12.35a2.35 2.35 0 1 0 0-4.7 2.35 2.35 0 0 0 0 4.7Z"></path><path d="M13.45 17.2c.26-1.46 1.48-2.46 3.01-2.46 1.48 0 2.67.97 2.94 2.46"></path><path d="M16.46 12.82a1.98 1.98 0 1 0 0-3.96 1.98 1.98 0 0 0 0 3.96Z"></path></svg></span>
                                    <span class="ak-im-home-add-action-label">发起群聊</span>
                                </button>
                                <button class="ak-im-home-add-action" type="button" data-im-home-add-action="add_friend" role="menuitem">
                                    <span class="ak-im-home-add-action-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5.9 17.9c.38-2.23 2.33-3.8 4.72-3.8 1.08 0 2.07.32 2.88.88"></path><path d="M10.62 11.35a2.95 2.95 0 1 0 0-5.9 2.95 2.95 0 0 0 0 5.9Z"></path><path d="M17.7 10.1v6"></path><path d="M14.7 13.1h6"></path></svg></span>
                                    <span class="ak-im-home-add-action-label">添加朋友</span>
                                </button>
                                <button class="ak-im-home-add-action" type="button" data-im-home-add-action="publish_meeting" role="menuitem">
                                    <span class="ak-im-home-add-action-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4.8 6.6c0-.77.63-1.4 1.4-1.4h8.8c.77 0 1.4.63 1.4 1.4v8.1c0 .77-.63 1.4-1.4 1.4H9.4l-2.8 2.3V16.1H6.2c-.77 0-1.4-.63-1.4-1.4V6.6Z"></path><rect x="7.6" y="8.35" width="4.8" height="3.3" rx="0.7"></rect><path d="M12.4 9.45 15 8.35v3.3l-2.6-1.1v-1.1Z"></path></svg></span>
                                    <span class="ak-im-home-add-action-label">发布会议</span>
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="ak-im-session-page">
                        <div class="ak-im-home-panels">
                            <div class="ak-im-home-panel is-chats is-active" data-im-home-panel="chats">
                                <div class="ak-im-search-bar"><div class="ak-im-search-pill">点击右上角搜索联系人</div></div>
                                <div class="ak-im-session-list"></div>
                            </div>
                            <div class="ak-im-home-panel" data-im-home-panel="contacts">
                                <div class="ak-im-contacts-list"></div>
                            </div>
                            <div class="ak-im-home-panel" data-im-home-panel="meetings"></div>
                            <div class="ak-im-home-panel" data-im-home-panel="me">
                                <div class="ak-im-profile-page"></div>
                            </div>
                        </div>
                        <div class="ak-im-contact-search-page"></div>
                        <div class="ak-im-home-tabbar">
                            <button class="ak-im-home-tab-btn is-active" type="button" data-im-home-tab="chats" aria-label="聊天">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.75C6.5 5.78 7.28 5 8.4 5H13.05C14.24 5 15.2 5.78 15.2 6.75V9.85C15.2 11.04 14.24 12 13.05 12H10.15L7.45 14.08C7.17 14.3 6.75 14.1 6.75 13.75V12H6.25V6.75Z" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
                                <span>聊天</span>
                                <span class="ak-im-home-tab-badge" aria-hidden="true"></span>
                            </button>
                            <button class="ak-im-home-tab-btn" type="button" data-im-home-tab="contacts" aria-label="通讯录">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Zm-5.4 6.3c.42-2.44 2.66-4.2 5.4-4.2s4.98 1.76 5.4 4.2" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.2 7.6h.01M18.8 7.6h.01" stroke-width="2.2" stroke-linecap="round"/></svg>
                                <span>通讯录</span>
                            </button>
                            <button class="ak-im-home-tab-btn" type="button" data-im-home-tab="meetings" aria-label="会议">
                                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M4 6.5C4 5.67 4.67 5 5.5 5h13c.83 0 1.5.67 1.5 1.5v8.2c0 .83-.67 1.5-1.5 1.5h-7.4L7.2 19v-2.8H5.5A1.5 1.5 0 0 1 4 14.7V6.5Z" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><rect x="6.8" y="8.3" width="6" height="4.2" rx="0.8" stroke-width="1.3" stroke-linejoin="round"/><path d="M12.8 9.6 15.6 8.4v4l-2.8-1.2V9.6Z" stroke-width="1.3" stroke-linejoin="round"/></svg>
                                <span>会议</span>
                                <span class="ak-im-home-tab-badge" aria-hidden="true"></span>
                            </button>
                            <button class="ak-im-home-tab-btn" type="button" data-im-home-tab="me" aria-label="我">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12.2a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2Zm-6 6.8c.5-2.9 3.15-5 6-5s5.5 2.1 6 5" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
                                <span>我</span>
                            </button>
                        </div>
                    </div>
                </div>
                <div class="ak-im-screen ak-im-chat-screen">
                    <div class="ak-im-topbar">
                        <button class="ak-im-nav-btn ak-im-back" type="button" aria-label="返回会话列表">
                            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18L9 12L15 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <button class="ak-im-topbar-title-wrap ak-im-chat-title-btn" type="button" aria-label="聊天标题" disabled><div class="ak-im-chat-title">内部聊天</div><div class="ak-im-chat-subtitle">选择一个会话开始单聊</div></button>
                        <button class="ak-im-nav-btn ak-im-chat-menu is-hidden" type="button" aria-label="群聊更多功能" disabled><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="6" cy="12" r="1.7" fill="currentColor"></circle><circle cx="12" cy="12" r="1.7" fill="currentColor"></circle><circle cx="18" cy="12" r="1.7" fill="currentColor"></circle></svg></button>
                    </div>
                    <div class="ak-im-message-list"></div>
                    <div class="ak-im-composer"><div class="ak-im-composer-side"><button class="ak-im-composer-btn ak-im-composer-voice" type="button" aria-label="切换到按住说话"><svg class="ak-im-icon-default" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.6"></circle><circle cx="8.95" cy="12" r="1" fill="currentColor" stroke="none"></circle><path d="M11.45 9.75c.8.66 1.2 1.41 1.2 2.25s-.4 1.59-1.2 2.25"></path><path d="M14.15 8.55c1.18.98 1.77 2.13 1.77 3.45s-.59 2.47-1.77 3.45"></path></svg><svg class="ak-im-icon-alt" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.6"></circle><rect x="6.4" y="8.4" width="11.2" height="7.2" rx="1.4"></rect><path d="M9 17.6h6"></path><path d="M8.9 10.8h.01"></path><path d="M11.4 10.8h.01"></path><path d="M13.9 10.8h.01"></path><path d="M16.1 10.8h.01"></path><path d="M8.8 13.2h6.4"></path></svg></button></div><div class="ak-im-composer-main"><div class="ak-im-input-wrap"><textarea class="ak-im-input" placeholder="输入消息"></textarea></div><button class="ak-im-hold-to-talk" type="button">按住 说话</button></div><div class="ak-im-composer-actions"><button class="ak-im-composer-btn ak-im-emoji-toggle" type="button" aria-label="打开表情面板"><svg class="ak-im-icon-default" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.85"></circle><circle cx="9.15" cy="10.15" r="1" fill="currentColor" stroke="none"></circle><circle cx="14.85" cy="10.15" r="1" fill="currentColor" stroke="none"></circle><path d="M8.3 13.85a3.7 3.7 0 0 0 7.4 0h-1.45a2.25 2.25 0 0 1-4.5 0Z" fill="currentColor" stroke="none"></path></svg><svg class="ak-im-icon-alt" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.6"></circle><rect x="6.4" y="8.4" width="11.2" height="7.2" rx="1.4"></rect><path d="M9 17.6h6"></path><path d="M8.9 10.8h.01"></path><path d="M11.4 10.8h.01"></path><path d="M13.9 10.8h.01"></path><path d="M16.1 10.8h.01"></path><path d="M8.8 13.2h6.4"></path></svg></button><button class="ak-im-composer-btn ak-im-composer-plus is-disabled" type="button" aria-label="更多功能" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.6"></circle><path d="M12 8v8"></path><path d="M8 12h8"></path></svg></button><button class="ak-im-send" type="button">发送</button></div></div>
                    <div class="ak-im-emoji-sheet" aria-hidden="true" inert><div class="ak-im-emoji-sheet-panel"><div class="ak-im-emoji-sheet-tabs"></div><div class="ak-im-emoji-sheet-body"></div></div></div>
                    <div class="ak-im-plus-sheet" aria-hidden="true" inert><div class="ak-im-plus-sheet-panel"><div class="ak-im-plus-grid"><button class="ak-im-plus-item" type="button" data-im-plus-action="camera"><span class="ak-im-plus-item-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.2 7.4 9.3 5.9h5.4l1.1 1.5"></path><rect x="4.2" y="7.4" width="15.6" height="11.4" rx="2.4"></rect><circle cx="12" cy="13.1" r="3.3"></circle></svg></span><span class="ak-im-plus-item-label">拍照</span></button><button class="ak-im-plus-item" type="button" data-im-plus-action="album"><span class="ak-im-plus-item-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.3" y="5.2" width="15.4" height="13.6" rx="2.3"></rect><circle cx="9" cy="10" r="1.2"></circle><path d="m7.2 16 3.1-3.1 2.2 2.2 2.6-2.8 1.7 1.8"></path></svg></span><span class="ak-im-plus-item-label">相册</span></button><button class="ak-im-plus-item" type="button" data-im-plus-action="file"><span class="ak-im-plus-item-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.8 8.4h5l1.3 1.7h8.1v6.9a2 2 0 0 1-2 2H6.8a2 2 0 0 1-2-2Z"></path><path d="M4.8 10.1V7.6a2 2 0 0 1 2-2h3"></path></svg></span><span class="ak-im-plus-item-label">文件</span></button><button class="ak-im-plus-item" type="button" data-im-plus-action="location"><span class="ak-im-plus-item-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.1s5.1-5 5.1-9a5.1 5.1 0 1 0-10.2 0c0 4 5.1 9 5.1 9Z"></path><circle cx="12" cy="11.1" r="1.9"></circle></svg></span><span class="ak-im-plus-item-label">位置</span></button></div></div></div>
                    <div class="ak-im-status"></div>
                    <div class="ak-im-voice-record-overlay" aria-hidden="true">
                        <div class="ak-im-voice-record-overlay-inner">
                            <div class="ak-im-voice-record-card">
                                <div class="ak-im-voice-record-meter"><span class="ak-im-voice-record-bar" data-im-voice-meter-bar="0"></span><span class="ak-im-voice-record-bar" data-im-voice-meter-bar="1"></span><span class="ak-im-voice-record-bar" data-im-voice-meter-bar="2"></span><span class="ak-im-voice-record-bar" data-im-voice-meter-bar="3"></span><span class="ak-im-voice-record-bar" data-im-voice-meter-bar="4"></span><span class="ak-im-voice-record-bar" data-im-voice-meter-bar="5"></span><span class="ak-im-voice-record-bar" data-im-voice-meter-bar="6"></span><span class="ak-im-voice-record-bar" data-im-voice-meter-bar="7"></span><span class="ak-im-voice-record-bar" data-im-voice-meter-bar="8"></span><span class="ak-im-voice-record-bar" data-im-voice-meter-bar="9"></span><span class="ak-im-voice-record-bar" data-im-voice-meter-bar="10"></span><span class="ak-im-voice-record-bar" data-im-voice-meter-bar="11"></span><span class="ak-im-voice-record-bar" data-im-voice-meter-bar="12"></span><span class="ak-im-voice-record-bar" data-im-voice-meter-bar="13"></span><span class="ak-im-voice-record-bar" data-im-voice-meter-bar="14"></span><span class="ak-im-voice-record-bar" data-im-voice-meter-bar="15"></span></div>
                                <div class="ak-im-voice-record-timer">00:00</div>
                            </div>
                            <div class="ak-im-voice-cancel-zone"><span class="ak-im-voice-cancel-label">上滑到此，取消发送</span></div>
                        </div>
                    </div>
                </div>
                <div class="ak-im-screen ak-im-compose-screen">
                    <div class="ak-im-topbar">
                        <button class="ak-im-nav-btn ak-im-compose-back" type="button" aria-label="返回会话列表">
                            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18L9 12L15 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <div class="ak-im-topbar-title">发起聊天</div>
                        <button class="ak-im-nav-btn ak-im-compose-close" type="button" aria-label="关闭发起聊天">取消</button>
                    </div>
                    <div class="ak-im-compose-page">
                        <div class="ak-im-compose-card">
                            <div class="ak-im-compose-label">请输入要发起聊天的账号 username</div>
                            <input class="ak-im-compose-input" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="例如：hjy574139" />
                            <div class="ak-im-compose-tip">输入对方账号后开始单聊</div>
                        </div>
                        <div class="ak-im-compose-actions">
                            <button class="ak-im-compose-btn ak-im-compose-btn-secondary" type="button" data-im-action="compose-cancel">返回</button>
                            <button class="ak-im-compose-btn ak-im-compose-btn-primary" type="button" data-im-action="compose-submit">开始聊天</button>
                        </div>
                    </div>
                </div>
                <div class="ak-im-screen ak-im-group-info-screen">
                    <div class="ak-im-topbar">
                        <button class="ak-im-nav-btn ak-im-group-info-back" type="button" aria-label="返回聊天页面">
                            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18L9 12L15 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <div class="ak-im-topbar-title ak-im-group-info-title">聊天信息</div>
                        <div class="ak-im-group-info-side" aria-hidden="true"></div>
                    </div>
                    <div class="ak-im-group-info-page"></div>
                </div>
                <div class="ak-im-screen ak-im-member-action-screen">
                    <div class="ak-im-topbar">
                        <button class="ak-im-nav-btn ak-im-member-action-back" type="button" aria-label="返回群信息页面">
                            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18L9 12L15 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <div class="ak-im-topbar-title ak-im-member-action-title">选择成员</div>
                        <div class="ak-im-group-info-side" aria-hidden="true"></div>
                    </div>
                    <div class="ak-im-member-action-page">
                        <div class="ak-im-member-action-search"><input class="ak-im-member-action-search-input" type="search" inputmode="search" autocomplete="off" spellcheck="false" placeholder="搜索成员" /></div>
                        <div class="ak-im-member-action-body"></div>
                        <div class="ak-im-member-action-footer"><button class="ak-im-member-action-submit" type="button">确认</button></div>
                    </div>
                </div>
                <div class="ak-im-screen ak-im-profile-subpage-screen">
                    <div class="ak-im-topbar">
                        <button class="ak-im-nav-btn ak-im-profile-subpage-back" type="button" aria-label="返回个人页">
                            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 18L9 12L15 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <div class="ak-im-topbar-title ak-im-profile-subpage-title">个人资料</div>
                        <div class="ak-im-group-info-side" aria-hidden="true"></div>
                    </div>
                    <div class="ak-im-profile-subpage-page"></div>
                </div>
            </div>
            <div class="ak-im-action-sheet" aria-hidden="true" inert>
                <div class="ak-im-action-mask"></div>
                <div class="ak-im-action-panel">
                    <button class="ak-im-action-btn danger" type="button" data-im-action="recall">撤回</button>
                    <button class="ak-im-action-btn" type="button" data-im-action="cancel">取消</button>
                </div>
            </div>
            <div class="ak-im-progress-sheet" aria-hidden="true" inert>
                <div class="ak-im-progress-mask"></div>
                <div class="ak-im-progress-panel">
                    <div class="ak-im-progress-header"><div class="ak-im-progress-title">消息读进度</div><button class="ak-im-progress-close" type="button">关闭</button></div>
                    <div class="ak-im-progress-panel-body"></div>
                </div>
            </div>
            <div class="ak-im-member-sheet" aria-hidden="true" inert>
                <div class="ak-im-member-mask"></div>
                <div class="ak-im-member-panel">
                    <div class="ak-im-member-header"><div class="ak-im-member-title">群成员</div><button class="ak-im-member-close" type="button">关闭</button></div>
                    <div class="ak-im-member-panel-body"></div>
                </div>
            </div>
            <div class="ak-im-dialog" aria-hidden="true" inert>
                <div class="ak-im-dialog-mask"></div>
                <div class="ak-im-dialog-panel">
                    <div class="ak-im-dialog-content"><div class="ak-im-dialog-title"></div><div class="ak-im-dialog-message"></div></div>
                    <div class="ak-im-dialog-actions"><button class="ak-im-dialog-btn" type="button" data-im-dialog="cancel">取消</button><button class="ak-im-dialog-btn is-danger" type="button" data-im-dialog="confirm">确定</button></div>
                </div>
            </div>
            `;
        },

        collectElements(root) {
            return {
                root: root,
                panel: root ? root.querySelector('.ak-im-shell') : null,
                launcherEl: root ? root.querySelector('.ak-im-launcher') : null,
                sessionList: root ? root.querySelector('.ak-im-session-list') : null,
                contactsListEl: root ? root.querySelector('.ak-im-contacts-list') : null,
                profilePageEl: root ? root.querySelector('.ak-im-profile-page') : null,
                profileSubpageBodyEl: root ? root.querySelector('.ak-im-profile-subpage-page') : null,
                profileSubpageTitleEl: root ? root.querySelector('.ak-im-profile-subpage-title') : null,
                messageList: root ? root.querySelector('.ak-im-message-list') : null,
                statusLine: root ? root.querySelector('.ak-im-status') : null,
                inputEl: root ? root.querySelector('.ak-im-input') : null,
                newSessionInputEl: root ? root.querySelector('.ak-im-compose-input') : null,
                composerHoldBtnEl: root ? root.querySelector('.ak-im-hold-to-talk') : null,
                voiceHoldOverlayEl: root ? root.querySelector('.ak-im-voice-record-overlay') : null,
                voiceHoldCardEl: root ? root.querySelector('.ak-im-voice-record-card') : null,
                voiceHoldTimerEl: root ? root.querySelector('.ak-im-voice-record-timer') : null,
                voiceHoldMeterBarEls: root ? root.querySelectorAll('[data-im-voice-meter-bar]') : [],
                voiceHoldCancelZoneEl: root ? root.querySelector('.ak-im-voice-cancel-zone') : null,
                voiceHoldCancelLabelEl: root ? root.querySelector('.ak-im-voice-cancel-label') : null,
                sendBtn: root ? root.querySelector('.ak-im-send') : null,
                composerVoiceBtnEl: root ? root.querySelector('.ak-im-composer-voice') : null,
                composerMicBtnEl: root ? root.querySelector('.ak-im-composer-mic') : null,
                composerEmojiBtnEl: root ? root.querySelector('.ak-im-emoji-toggle') : null,
                composerPlusBtnEl: root ? root.querySelector('.ak-im-composer-plus') : null,
                emojiSheetEl: root ? root.querySelector('.ak-im-emoji-sheet') : null,
                plusSheetEl: root ? root.querySelector('.ak-im-plus-sheet') : null,
                plusActionButtons: root ? root.querySelectorAll('[data-im-plus-action]') : [],
                emojiSheetTabsEl: root ? root.querySelector('.ak-im-emoji-sheet-tabs') : null,
                emojiSheetBodyEl: root ? root.querySelector('.ak-im-emoji-sheet-body') : null,
                actionSheetEl: root ? root.querySelector('.ak-im-action-sheet') : null,
                actionSheetRecallBtn: root ? root.querySelector('[data-im-action="recall"]') : null,
                actionSheetCancelBtn: root ? root.querySelector('[data-im-action="cancel"]') : null,
                progressPanelEl: root ? root.querySelector('.ak-im-progress-sheet') : null,
                progressPanelBodyEl: root ? root.querySelector('.ak-im-progress-panel-body') : null,
                memberPanelEl: root ? root.querySelector('.ak-im-member-sheet') : null,
                memberPanelBodyEl: root ? root.querySelector('.ak-im-member-panel-body') : null,
                chatTitleBtnEl: root ? root.querySelector('.ak-im-chat-title-btn') : null,
                settingsPanelEl: root ? root.querySelector('.ak-im-group-info-screen') : null,
                settingsPanelBodyEl: root ? root.querySelector('.ak-im-group-info-page') : null,
                chatMenuBtnEl: root ? root.querySelector('.ak-im-chat-menu') : null,
                groupInfoTitleEl: root ? root.querySelector('.ak-im-group-info-title') : null,
                memberActionPageEl: root ? root.querySelector('.ak-im-member-action-screen') : null,
                memberActionBodyEl: root ? root.querySelector('.ak-im-member-action-body') : null,
                memberActionSearchEl: root ? root.querySelector('.ak-im-member-action-search-input') : null,
                memberActionTitleEl: root ? root.querySelector('.ak-im-member-action-title') : null,
                memberActionSubmitBtnEl: root ? root.querySelector('.ak-im-member-action-submit') : null,
                dialogEl: root ? root.querySelector('.ak-im-dialog') : null,
                dialogTitleEl: root ? root.querySelector('.ak-im-dialog-title') : null,
                dialogMessageEl: root ? root.querySelector('.ak-im-dialog-message') : null,
                dialogCancelBtnEl: root ? root.querySelector('[data-im-dialog="cancel"]') : null,
                dialogConfirmBtnEl: root ? root.querySelector('[data-im-dialog="confirm"]') : null,
                sessionTopbarTitleEl: root ? root.querySelector('.ak-im-session-topbar-title') : null,
                sessionNewBtnEl: root ? root.querySelector('.ak-im-new') : null,
                homeSearchTriggerBtnEl: root ? root.querySelector('.ak-im-home-search-trigger') : null,
                homeAddTriggerBtnEl: root ? root.querySelector('.ak-im-home-add-trigger') : null,
                homeAddMenuEl: root ? root.querySelector('.ak-im-home-add-menu') : null,
                homeAddMenuButtons: root ? root.querySelectorAll('[data-im-home-add-action]') : [],
                contactSearchBackBtnEl: root ? root.querySelector('.ak-im-contact-search-back') : null,
                contactSearchInputEl: root ? root.querySelector('.ak-im-contact-search-input') : null,
                contactSearchClearBtnEl: root ? root.querySelector('.ak-im-contact-search-clear') : null,
                contactSearchPageEl: root ? root.querySelector('.ak-im-contact-search-page') : null,
                searchPillEl: root ? root.querySelector('.ak-im-search-pill') : null,
                chatTitleEl: root ? root.querySelector('.ak-im-chat-title') : null,
                chatSubtitleEl: root ? root.querySelector('.ak-im-chat-subtitle') : null,
                composeBackBtnEl: root ? root.querySelector('.ak-im-compose-back') : null,
                composeCloseBtnEl: root ? root.querySelector('.ak-im-compose-close') : null,
                newActionBtnEl: root ? root.querySelector('[data-im-action="new"]') : null,
                composeCancelBtnEl: root ? root.querySelector('[data-im-action="compose-cancel"]') : null,
                composeSubmitBtnEl: root ? root.querySelector('[data-im-action="compose-submit"]') : null,
                profileSubpageBackBtnEl: root ? root.querySelector('.ak-im-profile-subpage-back') : null,
                closeBtnEl: root ? root.querySelector('.ak-im-close') : null,
                backBtnEl: root ? root.querySelector('.ak-im-back') : null,
                homeTabButtons: root ? root.querySelectorAll('[data-im-home-tab]') : [],
                homePanelNodes: root ? root.querySelectorAll('[data-im-home-panel]') : []
            };
        },

        ensureRoot() {
            const previousRoot = this.elements && this.elements.root && this.elements.root.isConnected ? this.elements.root : null;
            let root = this.elements && this.elements.root && this.elements.root.isConnected ? this.elements.root : null;
            if (!root && this.ctx && typeof this.ctx.getRoot === 'function') {
                const currentRoot = this.ctx.getRoot();
                if (currentRoot && currentRoot.isConnected) root = currentRoot;
            }
            if (!root) {
                root = document.createElement('div');
                root.id = 'ak-im-root';
                root.innerHTML = '<style>' + this.buildStyleText() + '</style>' + this.buildMarkupText();
                document.body.appendChild(root);
            }
            this.elements = this.collectElements(root);
            if (previousRoot !== root) {
                this.eventsBound = false;
            }
            if (this.ctx && typeof this.ctx.onRootReady === 'function') {
                this.ctx.onRootReady(this.elements);
            }
            this.bindEvents();
            if (this.ctx && typeof this.ctx.syncComposerLayout === 'function') {
                this.ctx.syncComposerLayout();
            }
            return this.elements;
        },

        bindEvents() {
            if (this.eventsBound || !this.elements) return;
            const ctx = this.ctx || {};
            const elements = this.elements;
            const bindClick = function(node, handler) {
                if (node && typeof handler === 'function') {
                    node.addEventListener('click', handler);
                }
            };
            this.eventsBound = true;
            bindClick(elements.launcherEl, function() {
                if (typeof ctx.onLauncherClick === 'function') ctx.onLauncherClick();
            });
            bindClick(elements.closeBtnEl, function() {
                if (typeof ctx.onCloseClick === 'function') ctx.onCloseClick();
            });
            bindClick(elements.backBtnEl, function() {
                if (typeof ctx.onBackClick === 'function') ctx.onBackClick();
            });
            bindClick(elements.chatMenuBtnEl, function() {
                if (typeof ctx.onChatMenuClick === 'function') ctx.onChatMenuClick();
            });
            bindClick(elements.chatTitleBtnEl, function() {
                if (typeof ctx.onChatTitleClick === 'function') ctx.onChatTitleClick();
            });
            bindClick(elements.composeBackBtnEl, function() {
                if (typeof ctx.onComposeBackClick === 'function') ctx.onComposeBackClick();
            });
            bindClick(elements.composeCloseBtnEl, function() {
                if (typeof ctx.onComposeCloseClick === 'function') ctx.onComposeCloseClick();
            });
            bindClick(elements.homeSearchTriggerBtnEl, function() {
                if (typeof ctx.onHomeSearchClick === 'function') ctx.onHomeSearchClick();
            });
            bindClick(elements.homeAddTriggerBtnEl, function() {
                if (typeof ctx.onHomeAddClick === 'function') ctx.onHomeAddClick();
            });
            Array.prototype.forEach.call(elements.homeAddMenuButtons || [], function(button) {
                button.addEventListener('click', function() {
                    if (typeof ctx.onHomeAddMenuAction === 'function') {
                        ctx.onHomeAddMenuAction(button.getAttribute('data-im-home-add-action'));
                    }
                });
            });
            bindClick(elements.contactSearchBackBtnEl, function() {
                if (typeof ctx.onContactSearchBackClick === 'function') ctx.onContactSearchBackClick();
            });
            bindClick(elements.contactSearchClearBtnEl, function() {
                if (typeof ctx.onContactSearchClearClick === 'function') ctx.onContactSearchClearClick();
            });
            bindClick(elements.newActionBtnEl, function() {
                if (typeof ctx.onNewSessionClick === 'function') ctx.onNewSessionClick();
            });
            Array.prototype.forEach.call(elements.homeTabButtons || [], function(button) {
                button.addEventListener('click', function() {
                    if (typeof ctx.onHomeTabChange === 'function') {
                        ctx.onHomeTabChange(button.getAttribute('data-im-home-tab'));
                    }
                });
            });
            bindClick(elements.composeCancelBtnEl, function() {
                if (typeof ctx.onComposeCancelClick === 'function') ctx.onComposeCancelClick();
            });
            bindClick(elements.composeSubmitBtnEl, function() {
                if (typeof ctx.onComposeSubmitClick === 'function') ctx.onComposeSubmitClick();
            });
            bindClick(elements.sendBtn, function() {
                if (typeof ctx.onSendClick === 'function') ctx.onSendClick();
            });
            bindClick(elements.composerVoiceBtnEl, function() {
                if (typeof ctx.onComposerVoiceToggleClick === 'function') ctx.onComposerVoiceToggleClick();
            });
            bindClick(elements.composerEmojiBtnEl, function() {
                if (typeof ctx.onComposerEmojiToggleClick === 'function') ctx.onComposerEmojiToggleClick();
            });
            bindClick(elements.composerPlusBtnEl, function() {
                if (typeof ctx.onComposerPlusToggleClick === 'function') ctx.onComposerPlusToggleClick();
            });
            Array.prototype.forEach.call(elements.plusActionButtons || [], function(button) {
                button.addEventListener('click', function() {
                    if (typeof ctx.onPlusActionClick === 'function') {
                        ctx.onPlusActionClick(button.getAttribute('data-im-plus-action'));
                    }
                });
            });
            if (elements.inputEl) {
                elements.inputEl.addEventListener('input', function() {
                    if (typeof ctx.onComposerInput === 'function') {
                        ctx.onComposerInput(elements.inputEl.value || '');
                    }
                });
                elements.inputEl.addEventListener('keydown', function(event) {
                    if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        if (typeof ctx.onComposerSubmit === 'function') ctx.onComposerSubmit();
                    }
                });
            }
            if (elements.contactSearchInputEl) {
                elements.contactSearchInputEl.addEventListener('input', function() {
                    if (typeof ctx.onContactSearchInputChange === 'function') {
                        ctx.onContactSearchInputChange(elements.contactSearchInputEl.value || '');
                    }
                });
            }
            if (elements.newSessionInputEl) {
                elements.newSessionInputEl.addEventListener('input', function() {
                    if (typeof ctx.onNewSessionInputChange === 'function') {
                        ctx.onNewSessionInputChange(elements.newSessionInputEl.value || '');
                    }
                });
                elements.newSessionInputEl.addEventListener('keydown', function(event) {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        if (typeof ctx.onComposeSubmitClick === 'function') ctx.onComposeSubmitClick();
                    }
                });
            }
            if (typeof ctx.bindOverlayEvents === 'function') {
                ctx.bindOverlayEvents();
            }
            const memberMaskEl = elements.memberPanelEl ? elements.memberPanelEl.querySelector('.ak-im-member-mask') : null;
            const memberCloseBtnEl = elements.memberPanelEl ? elements.memberPanelEl.querySelector('.ak-im-member-close') : null;
            bindClick(memberMaskEl, function() {
                if (typeof ctx.onMemberPanelClose === 'function') ctx.onMemberPanelClose();
            });
            bindClick(memberCloseBtnEl, function() {
                if (typeof ctx.onMemberPanelClose === 'function') ctx.onMemberPanelClose();
            });
            bindClick(elements.profileSubpageBackBtnEl, function() {
                if (typeof ctx.onProfileSubpageBackClick === 'function') ctx.onProfileSubpageBackClick();
            });
        },

        renderShell(shellState) {
            if (!this.elements || !this.elements.root || !this.ctx || typeof this.ctx.getShellState !== 'function') return;
            const nextShellState = shellState || this.ctx.getShellState() || {};
            const formatTabBadgeCount = function(value) {
                const count = Math.max(0, Number(value || 0) || 0);
                if (!count) return '';
                return count > 999 ? '999+' : String(count);
            };
            const root = this.elements.root;
            root.classList.toggle('ak-visible', !!nextShellState.allowed);
            root.classList.toggle('ak-im-open', !!nextShellState.open);
            root.classList.toggle('ak-view-sessions', !!nextShellState.showSessions);
            root.classList.toggle('ak-view-chat', !!nextShellState.showChat);
            root.classList.toggle('ak-view-compose', !!nextShellState.showCompose);
            root.classList.toggle('ak-view-group-info', !!nextShellState.showGroupInfo);
            root.classList.toggle('ak-view-member-action', !!nextShellState.showMemberAction);
            root.classList.toggle('ak-view-profile-subpage', !!nextShellState.showProfileSubpage);
            root.classList.toggle('ak-contact-search-open', !!nextShellState.showContactSearch);
            if (this.elements.launcherEl) {
                this.elements.launcherEl.classList.toggle('is-open', !!nextShellState.open);
                this.elements.launcherEl.classList.toggle('has-unread', !!nextShellState.hasUnread);
            }
            if (this.elements.sessionTopbarTitleEl && typeof nextShellState.homeTabTitle === 'string') {
                this.elements.sessionTopbarTitleEl.textContent = nextShellState.homeTabTitle;
            }
            if (this.elements.sessionNewBtnEl) {
                this.elements.sessionNewBtnEl.classList.toggle('is-hidden', !nextShellState.showSessionNewButton);
            }
            if (this.elements.homeSearchTriggerBtnEl) {
                this.elements.homeSearchTriggerBtnEl.classList.toggle('is-hidden', !nextShellState.showHomeTopActions);
            }
            if (this.elements.homeAddTriggerBtnEl) {
                this.elements.homeAddTriggerBtnEl.classList.toggle('is-hidden', !nextShellState.showHomeTopActions);
                this.elements.homeAddTriggerBtnEl.setAttribute('aria-expanded', nextShellState.showHomeAddMenu ? 'true' : 'false');
            }
            if (this.elements.homeAddMenuEl) {
                this.elements.homeAddMenuEl.classList.toggle('is-open', !!nextShellState.showHomeAddMenu);
            }
            if (this.elements.contactSearchBackBtnEl) {
                this.elements.contactSearchBackBtnEl.classList.toggle('is-hidden', !nextShellState.showContactSearch);
            }
            if (this.elements.contactSearchInputEl && this.elements.contactSearchInputEl.value !== String(nextShellState.contactSearchKeyword || '')) {
                this.elements.contactSearchInputEl.value = String(nextShellState.contactSearchKeyword || '');
            }
            if (this.elements.contactSearchClearBtnEl) {
                this.elements.contactSearchClearBtnEl.classList.toggle('is-hidden', !String(nextShellState.contactSearchKeyword || '').trim());
            }
            if (this.elements.searchPillEl && typeof nextShellState.searchPillText === 'string') {
                this.elements.searchPillEl.textContent = nextShellState.searchPillText;
            }
            const chatUnread = Number(nextShellState.chatUnread || 0);
            const meetingsUnread = Number(nextShellState.meetingsUnread || 0);
            Array.prototype.forEach.call(this.elements.homeTabButtons || [], function(button) {
                const tabName = button.getAttribute('data-im-home-tab');
                const badgeEl = button.querySelector('.ak-im-home-tab-badge');
                let badgeText = '';
                button.classList.toggle('is-active', tabName === nextShellState.homeTab);
                if (tabName === 'chats') badgeText = formatTabBadgeCount(chatUnread);
                else if (tabName === 'meetings') badgeText = formatTabBadgeCount(meetingsUnread);
                button.classList.toggle('has-unread', !!badgeText);
                if (badgeEl) badgeEl.textContent = badgeText;
            });
            Array.prototype.forEach.call(this.elements.homePanelNodes || [], function(panelNode) {
                panelNode.classList.toggle('is-active', panelNode.getAttribute('data-im-home-panel') === nextShellState.homeTab);
            });
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.appShell = appShellModule;
})(window);
