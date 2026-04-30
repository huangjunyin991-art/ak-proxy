(function() {
    'use strict';

    function readJoinURL() {
        const node = document.getElementById('wemeet-join-data');
        return node && node.dataset ? String(node.dataset.joinUrl || '') : '';
    }

    const joinURL = readJoinURL();
    let opened = false;
    let attemptedAt = 0;
    const titleEl = document.getElementById('title');
    const statusEl = document.getElementById('status');
    const tipEl = document.getElementById('install-tip');
    const openBtn = document.getElementById('open-btn');
    const backBtn = document.querySelector('[data-return-url]');

    function markOpened() {
        opened = true;
        if (titleEl) titleEl.textContent = '已尝试打开腾讯会议';
        if (statusEl) statusEl.textContent = '如果腾讯会议已经打开，可以关闭此页面。';
    }

    document.addEventListener('visibilitychange', function() {
        if (document.hidden) markOpened();
    });
    window.addEventListener('blur', markOpened);

    function openApp() {
        if (!joinURL) return;
        attemptedAt = Date.now();
        opened = false;
        if (tipEl) tipEl.className = 'install';
        if (titleEl) titleEl.textContent = '正在打开腾讯会议';
        if (statusEl) statusEl.textContent = '请在浏览器提示中允许打开腾讯会议客户端。';
        window.location.href = joinURL;
        setTimeout(function() {
            if (!opened && Date.now() - attemptedAt >= 1500) {
                if (titleEl) titleEl.textContent = '未检测到腾讯会议客户端';
                if (statusEl) statusEl.textContent = '当前设备可能没有安装腾讯会议，或浏览器阻止了打开客户端。';
                if (tipEl) tipEl.className = 'install visible';
            }
        }, 1800);
    }

    function returnToMeetingList(event) {
        if (event) event.preventDefault();
        if (window.history.length > 1) {
            window.history.back();
            return;
        }
        const fallbackURL = backBtn && backBtn.dataset ? String(backBtn.dataset.returnUrl || '') : '';
        if (fallbackURL) window.location.href = fallbackURL;
    }

    if (openBtn) openBtn.addEventListener('click', openApp);
    if (backBtn) backBtn.addEventListener('click', returnToMeetingList);
    setTimeout(openApp, 120);
})();
