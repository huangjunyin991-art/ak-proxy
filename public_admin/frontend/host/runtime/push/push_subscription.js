(function() {
    'use strict';

    var lastError = '';

    function setLastError(message) {
        lastError = String(message || '').trim();
    }

    function getLastError() {
        return lastError;
    }

    function getIMUsername() {
        try {
            if (window.AKIMClientUsername) return String(window.AKIMClientUsername || '').trim().toLowerCase();
        } catch(e) {
        }
        try {
            var match = document.cookie.match(/(?:^|; )ak_im_username=([^;]*)/);
            return match ? decodeURIComponent(match[1]).trim().toLowerCase() : '';
        } catch(e) {
            return '';
        }
    }

    function withTimeout(promise, timeoutMs, message) {
        return new Promise(function(resolve, reject) {
            var settled = false;
            var timer = setTimeout(function() {
                if (settled) return;
                settled = true;
                reject(new Error(message));
            }, timeoutMs);
            Promise.resolve(promise).then(function(value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            }).catch(function(error) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    function urlBase64ToUint8Array(base64String) {
        var padding = '='.repeat((4 - base64String.length % 4) % 4);
        var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        var rawData = window.atob(base64);
        var outputArray = new Uint8Array(rawData.length);
        for (var i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    function fetchVapidPublicKey() {
        return withTimeout(fetch('/api/notify-center/web-push/vapid-public-key', {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store'
        }), 8000, '读取通知配置超时，请检查网络后重试').then(function(resp) {
            if (!resp || !resp.ok) {
                setLastError('读取通知配置失败，请稍后重试');
                return null;
            }
            return resp.json();
        }).then(function(data) {
            var body = data && data.data ? data.data : {};
            if (!body.enabled || !body.web_push_ready || !body.public_key) {
                setLastError('通知服务尚未配置完成');
                return null;
            }
            return String(body.public_key || '');
        }).catch(function(error) {
            setLastError(error && error.message ? error.message : '读取通知配置失败，请稍后重试');
            return null;
        });
    }

    function getRegistration() {
        if (!navigator.serviceWorker) {
            setLastError('当前浏览器不支持 Service Worker');
            return Promise.resolve(null);
        }
        return withTimeout(navigator.serviceWorker.ready, 8000, 'Service Worker 未就绪，请刷新页面后重试').catch(function(error) {
            setLastError(error && error.message ? error.message : 'Service Worker 未就绪，请刷新页面后重试');
            return null;
        });
    }

    function subscribe(registration, publicKey) {
        if (!registration) {
            if (!lastError) setLastError('Service Worker 未就绪，请刷新页面后重试');
            return Promise.resolve(null);
        }
        if (!registration.pushManager) {
            setLastError('当前浏览器不支持 Push 订阅');
            return Promise.resolve(null);
        }
        if (!publicKey) {
            if (!lastError) setLastError('通知服务尚未配置完成');
            return Promise.resolve(null);
        }
        return withTimeout(registration.pushManager.getSubscription(), 5000, '读取当前通知订阅超时').then(function(existing) {
            if (existing) return existing;
            return withTimeout(registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey)
            }), 10000, '创建通知订阅超时，当前手机浏览器可能不支持 Web Push');
        }).catch(function(error) {
            setLastError(error && error.message ? error.message : '创建通知订阅失败，当前浏览器可能不支持 Web Push');
            return null;
        });
    }

    function saveSubscription(subscription) {
        if (!subscription) return Promise.resolve(false);
        var imUsername = getIMUsername();
        return withTimeout(fetch('/api/notify-center/web-push/subscriptions', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'X-AK-IM-Username': imUsername
            },
            body: JSON.stringify({
                im_username: imUsername,
                subscription: subscription.toJSON ? subscription.toJSON() : subscription,
                platform: navigator.platform || ''
            })
        }), 8000, '保存通知订阅超时，请检查网络后重试').then(function(resp) {
            if (resp && resp.ok) return true;
            var statusText = resp ? String(resp.status || '') : '';
            return (resp ? resp.json().catch(function() { return null; }) : Promise.resolve(null)).then(function(data) {
                var message = data && data.message ? String(data.message) : '';
                setLastError('保存通知订阅失败' + (statusText ? ' HTTP ' + statusText : '') + (imUsername ? '，当前账号 ' + imUsername : '，当前账号为空') + (message ? '：' + message : ''));
                return false;
            });
        }).catch(function(error) {
            setLastError((error && error.message ? error.message : '保存通知订阅失败，请稍后重试') + (imUsername ? '，当前账号 ' + imUsername : '，当前账号为空'));
            return false;
        });
    }

    function deleteSubscription(subscription) {
        if (!subscription) return Promise.resolve(true);
        var data = subscription.toJSON ? subscription.toJSON() : subscription;
        var endpoint = String(data && data.endpoint || '').trim();
        if (!endpoint) return Promise.resolve(true);
        var imUsername = getIMUsername();
        return fetch('/api/notify-center/web-push/subscriptions', {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'X-AK-IM-Username': imUsername
            },
            body: JSON.stringify({endpoint: endpoint, im_username: imUsername})
        }).then(function(resp) {
            return !!(resp && resp.ok);
        }).catch(function() {
            return false;
        });
    }

    function registerSubscription() {
        setLastError('');
        return fetchVapidPublicKey().then(function(publicKey) {
            if (!publicKey) return false;
            return getRegistration().then(function(registration) {
                return subscribe(registration, publicKey);
            }).then(function(subscription) {
                if (!subscription) {
                    if (!lastError) setLastError('当前设备无法创建通知订阅');
                    return false;
                }
                return saveSubscription(subscription);
            });
        });
    }

    function diagnoseSubscription() {
        setLastError('');
        var result = {
            im_username: getIMUsername(),
            permission: ('Notification' in window) ? Notification.permission : 'unsupported',
            service_worker_supported: !!navigator.serviceWorker,
            push_manager_supported: !!window.PushManager,
            service_worker_ready: false,
            has_subscription: false,
            saved: false,
            last_error: ''
        };
        if (!navigator.serviceWorker) {
            result.last_error = '当前浏览器不支持 Service Worker';
            return Promise.resolve(result);
        }
        return getRegistration().then(function(registration) {
            result.service_worker_ready = !!registration;
            result.push_manager_supported = !!(registration && registration.pushManager);
            if (!registration || !registration.pushManager) {
                result.last_error = lastError || 'Service Worker 或 PushManager 未就绪';
                return result;
            }
            return withTimeout(registration.pushManager.getSubscription(), 5000, '读取当前通知订阅超时').then(function(subscription) {
                result.has_subscription = !!subscription;
                if (!subscription) {
                    result.last_error = '当前浏览器没有本机 Push 订阅';
                    return result;
                }
                return saveSubscription(subscription).then(function(saved) {
                    result.saved = !!saved;
                    result.last_error = lastError || '';
                    return result;
                });
            });
        }).catch(function(error) {
            result.last_error = error && error.message ? error.message : '诊断消息通知失败';
            return result;
        });
    }

    function unregisterSubscription() {
        return getRegistration().then(function(registration) {
            if (!registration || !registration.pushManager) return true;
            return registration.pushManager.getSubscription();
        }).then(function(subscription) {
            if (!subscription) return true;
            return deleteSubscription(subscription).then(function(serverRemoved) {
                return subscription.unsubscribe().then(function(localRemoved) {
                    return !!localRemoved || !!serverRemoved;
                }).catch(function() {
                    return !!serverRemoved;
                });
            });
        }).catch(function() {
            return false;
        });
    }

    window.AKClientRuntimePushSubscription = window.AKClientRuntimePushSubscription || {};
    window.AKClientRuntimePushSubscription.registerSubscription = registerSubscription;
    window.AKClientRuntimePushSubscription.unregisterSubscription = unregisterSubscription;
    window.AKClientRuntimePushSubscription.diagnoseSubscription = diagnoseSubscription;
    window.AKClientRuntimePushSubscription.getLastError = getLastError;
})();
