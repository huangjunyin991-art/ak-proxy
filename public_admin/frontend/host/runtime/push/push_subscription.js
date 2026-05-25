(function() {
    'use strict';

    var lastError = '';
    var lastSubscribeError = null;
    var lastInvalidEndpointHost = '';
    var lastInvalidEndpointCleared = false;
    var lastSavedSubscriptionId = 0;

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

    function getEndpointHost(subscription) {
        try {
            var data = subscription && subscription.toJSON ? subscription.toJSON() : subscription;
            var endpoint = String(data && data.endpoint || '').trim();
            return endpoint ? new URL(endpoint).hostname : '';
        } catch(e) {
            return '';
        }
    }

    function isInvalidEndpointHost(host) {
        var value = String(host || '').trim().toLowerCase();
        return value === 'permanently-removed.invalid' || /\.invalid$/.test(value);
    }

    function isInvalidSubscription(subscription) {
        return isInvalidEndpointHost(getEndpointHost(subscription));
    }

    function unsubscribeLocalSubscription(subscription) {
        if (!subscription || typeof subscription.unsubscribe !== 'function') return Promise.resolve(false);
        return withTimeout(subscription.unsubscribe(), 5000, '清理不可投递通知订阅超时').then(function(result) {
            return !!result;
        }).catch(function() {
            return false;
        });
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
        return withTimeout(navigator.serviceWorker.ready, 8000, 'Service Worker 未就绪，请刷新页面后重试').then(function(registration) {
            if (!registration || typeof registration.update !== 'function') return registration;
            return registration.update().then(function() {
                return registration;
            }).catch(function() {
                return registration;
            });
        }).catch(function(error) {
            setLastError(error && error.message ? error.message : 'Service Worker 未就绪，请刷新页面后重试');
            return null;
        });
    }

    function getServiceWorkerInfo(registration) {
        var worker = registration && (registration.active || registration.waiting || registration.installing);
        return {
            script_url: worker && worker.scriptURL ? String(worker.scriptURL || '') : '',
            state: worker && worker.state ? String(worker.state || '') : ''
        };
    }

    function fetchServiceWorkerDiagnostics(registration) {
        var worker = registration && registration.active;
        if (!worker || !window.MessageChannel) return Promise.resolve({});
        return withTimeout(new Promise(function(resolve) {
            var channel = new MessageChannel();
            channel.port1.onmessage = function(event) {
                resolve(event && event.data && typeof event.data === 'object' ? event.data : {});
            };
            worker.postMessage({type: 'AK_NOTIFY_SW_DIAGNOSTICS'}, [channel.port2]);
        }), 3000, '读取 Service Worker 通知状态超时').catch(function(error) {
            return {diagnostics_error: error && error.message ? String(error.message) : '读取 Service Worker 通知状态失败'};
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
        lastInvalidEndpointHost = '';
        lastInvalidEndpointCleared = false;
        return withTimeout(registration.pushManager.getSubscription(), 5000, '读取当前通知订阅超时').then(function(existing) {
            if (!isInvalidSubscription(existing)) return existing;
            lastInvalidEndpointHost = getEndpointHost(existing);
            return unsubscribeLocalSubscription(existing).then(function(cleared) {
                lastInvalidEndpointCleared = !!cleared;
                return null;
            });
        }).then(function(existing) {
            if (existing) return existing;
            return withTimeout(registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey)
            }), 10000, '创建通知订阅超时，浏览器 Push Service 没有完成注册');
        }).then(function(subscription) {
            if (!isInvalidSubscription(subscription)) return subscription;
            lastInvalidEndpointHost = getEndpointHost(subscription);
            return unsubscribeLocalSubscription(subscription).then(function(cleared) {
                lastInvalidEndpointCleared = !!cleared;
                setLastError('浏览器返回了不可投递的 Push endpoint，请更换网络或关闭浏览器隐私代理后重试');
                return null;
            });
        }).catch(function(error) {
            lastSubscribeError = {
                name: error && error.name ? String(error.name) : '',
                message: error && error.message ? String(error.message) : ''
            };
            setLastError(formatSubscribeError(error));
            return null;
        });
    }

    function formatSubscribeError(error) {
        var message = error && error.message ? String(error.message) : '';
        var name = error && error.name ? String(error.name) : '';
        var raw = (name ? name + ': ' : '') + message;
        var normalized = raw.toLowerCase();
        if (normalized.indexOf('notallowed') >= 0 || normalized.indexOf('permission') >= 0) {
            return '浏览器拒绝创建通知订阅，请在站点设置中允许通知权限后重试。原始错误：' + raw;
        }
        if (normalized.indexOf('push service error') >= 0 || normalized.indexOf('registration failed') >= 0) {
            return '浏览器 Push Service 注册失败。请检查系统通知权限、后台活动权限、推送服务网络可达性后重试。原始错误：' + raw;
        }
        if (normalized.indexOf('notsupported') >= 0 || normalized.indexOf('not supported') >= 0) {
            return '当前移动浏览器不支持创建 Web Push 订阅，请更换支持 Web Push 的浏览器。原始错误：' + raw;
        }
        return message || '创建通知订阅失败，当前浏览器可能不支持 Web Push';
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
            if (resp && resp.ok) {
                return resp.json().catch(function() {
                    return null;
                }).then(function(data) {
                    var body = data && data.data ? data.data : {};
                    lastSavedSubscriptionId = Number(body.subscription_id || 0);
                    return true;
                });
            }
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

    function fetchServerDiagnostics() {
        return withTimeout(fetch('/api/notify-center/web-push/diagnostics', {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store'
        }), 8000, '读取后端通知诊断超时').then(function(resp) {
            if (!resp || !resp.ok) return {diagnostics_error: '读取后端通知诊断失败 HTTP ' + String(resp && resp.status || '')};
            return resp.json();
        }).then(function(data) {
            return data && data.data && typeof data.data === 'object' ? data.data : {};
        }).catch(function(error) {
            return {diagnostics_error: error && error.message ? String(error.message) : '读取后端通知诊断失败'};
        });
    }

    function appendServerDiagnostics(result) {
        return fetchServerDiagnostics().then(function(data) {
            var recent = data && data.recent_outbox && data.recent_outbox.length ? data.recent_outbox[0] : {};
            var latestSubscription = data && data.subscriptions && data.subscriptions.length ? data.subscriptions[0] : {};
            result.server_enabled = !!(data && data.enabled);
            result.server_web_push_ready = !!(data && data.web_push_ready);
            result.server_active_subscription_count = Number(data && data.active_subscription_count || 0);
            result.server_subscription_count = data && data.subscriptions && data.subscriptions.length ? data.subscriptions.length : 0;
            result.server_latest_subscription_id = Number(latestSubscription.id || 0);
            result.server_latest_subscription_hash = String(latestSubscription.endpoint_hash || '');
            result.server_latest_subscription_enabled = !!latestSubscription.enabled;
            result.server_recent_outbox_status = String(recent.status || '');
            result.server_recent_outbox_attempt_count = Number(recent.attempt_count || 0);
            result.server_recent_outbox_max_attempts = Number(recent.max_attempts || 0);
            result.server_recent_outbox_subscription_id = Number(recent.subscription_id || 0);
            result.server_recent_outbox_provider_record_id = String(recent.provider_record_id || '');
            result.server_recent_outbox_error = String(recent.last_error || '');
            result.server_recent_outbox_created_at = String(recent.created_at || '');
            result.server_recent_outbox_sent_at = String(recent.sent_at || '');
            result.server_diagnostics_error = String(data && data.diagnostics_error || '');
            return result;
        });
    }

    function deleteSubscription(subscription, imUsernameOverride) {
        if (!subscription) return Promise.resolve(true);
        var data = subscription.toJSON ? subscription.toJSON() : subscription;
        var endpoint = String(data && data.endpoint || '').trim();
        if (!endpoint) return Promise.resolve(true);
        var imUsername = String(imUsernameOverride || getIMUsername() || '').trim().toLowerCase();
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

    function disableServerSubscription(imUsernameOverride) {
        var imUsername = String(imUsernameOverride || getIMUsername() || '').trim().toLowerCase();
        return getRegistration().then(function(registration) {
            if (!registration || !registration.pushManager) return true;
            return registration.pushManager.getSubscription();
        }).then(function(subscription) {
            if (!subscription) return true;
            return deleteSubscription(subscription, imUsername);
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
            secure_context: !!window.isSecureContext,
            service_worker_supported: !!navigator.serviceWorker,
            push_manager_supported: !!window.PushManager,
            service_worker_ready: false,
            service_worker_script_url: '',
            service_worker_state: '',
            service_worker_notify_version: '',
            service_worker_last_push_at: '',
            service_worker_last_push_title: '',
            service_worker_last_show_notification_called: false,
            service_worker_last_show_notification_ok: false,
            service_worker_last_show_notification_at: '',
            service_worker_last_show_notification_error: '',
            service_worker_diagnostics_error: '',
            has_subscription: false,
            invalid_endpoint: false,
            invalid_endpoint_host: '',
            invalid_endpoint_cleared: false,
            attempted_create: false,
            created_subscription: false,
            vapid_public_key_length: 0,
            endpoint_host: '',
            subscribe_error_name: '',
            subscribe_error_message: '',
            saved_subscription_id: 0,
            saved: false,
            last_error: ''
        };
        if (!navigator.serviceWorker) {
            result.last_error = '当前浏览器不支持 Service Worker';
            return appendServerDiagnostics(result);
        }
        return getRegistration().then(function(registration) {
            result.service_worker_ready = !!registration;
            var serviceWorkerInfo = getServiceWorkerInfo(registration);
            result.service_worker_script_url = serviceWorkerInfo.script_url;
            result.service_worker_state = serviceWorkerInfo.state;
            result.push_manager_supported = !!(registration && registration.pushManager);
            if (!registration || !registration.pushManager) {
                result.last_error = lastError || 'Service Worker 或 PushManager 未就绪';
                return result;
            }
            return fetchServiceWorkerDiagnostics(registration).then(function(swState) {
                result.service_worker_notify_version = String(swState.version || '');
                result.service_worker_last_push_at = String(swState.last_push_at || '');
                result.service_worker_last_push_title = String(swState.last_push_title || '');
                result.service_worker_last_show_notification_called = !!swState.last_show_notification_called;
                result.service_worker_last_show_notification_ok = !!swState.last_show_notification_ok;
                result.service_worker_last_show_notification_at = String(swState.last_show_notification_at || '');
                result.service_worker_last_show_notification_error = String(swState.last_show_notification_error || '');
                result.service_worker_diagnostics_error = String(swState.diagnostics_error || '');
                return withTimeout(registration.pushManager.getSubscription(), 5000, '读取当前通知订阅超时');
            }).then(function(subscription) {
                result.has_subscription = !!subscription;
                result.endpoint_host = getEndpointHost(subscription);
                result.invalid_endpoint = isInvalidSubscription(subscription);
                if (result.invalid_endpoint) {
                    result.invalid_endpoint_host = result.endpoint_host;
                    return unsubscribeLocalSubscription(subscription).then(function(cleared) {
                        result.invalid_endpoint_cleared = !!cleared;
                        result.has_subscription = false;
                        result.endpoint_host = '';
                        return null;
                    });
                }
                return subscription;
            }).then(function(subscription) {
                if (!subscription) {
                    if (result.permission === 'denied') {
                        result.last_error = '浏览器已拒绝本站通知权限，请在站点设置中允许通知后重试';
                        return result;
                    }
                    result.attempted_create = true;
                    return fetchVapidPublicKey().then(function(publicKey) {
                        if (!publicKey) {
                            result.last_error = lastError || '通知服务尚未配置完成';
                            return null;
                        }
                        result.vapid_public_key_length = String(publicKey || '').length;
                        lastSubscribeError = null;
                        return subscribe(registration, publicKey);
                    }).then(function(createdSubscription) {
                        result.created_subscription = !!createdSubscription;
                        result.has_subscription = !!createdSubscription;
                        result.endpoint_host = getEndpointHost(createdSubscription);
                        result.invalid_endpoint = result.invalid_endpoint || isInvalidSubscription(createdSubscription) || !!lastInvalidEndpointHost;
                        result.invalid_endpoint_host = result.invalid_endpoint_host || lastInvalidEndpointHost;
                        result.invalid_endpoint_cleared = result.invalid_endpoint_cleared || lastInvalidEndpointCleared;
                        result.subscribe_error_name = lastSubscribeError ? lastSubscribeError.name : '';
                        result.subscribe_error_message = lastSubscribeError ? lastSubscribeError.message : '';
                        if (!createdSubscription) {
                            result.last_error = lastError || '当前浏览器没有本机 Push 订阅，且创建订阅失败';
                            return result;
                        }
                        return saveSubscription(createdSubscription).then(function(saved) {
                            result.saved = !!saved;
                            result.saved_subscription_id = lastSavedSubscriptionId;
                            result.last_error = lastError || '';
                            return result;
                        });
                    });
                }
                return saveSubscription(subscription).then(function(saved) {
                    result.saved = !!saved;
                    result.saved_subscription_id = lastSavedSubscriptionId;
                    result.last_error = lastError || '';
                    return result;
                });
            });
        }).catch(function(error) {
            result.last_error = error && error.message ? error.message : '诊断消息通知失败';
            return result;
        }).then(appendServerDiagnostics);
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
    window.AKClientRuntimePushSubscription.disableServerSubscription = disableServerSubscription;
    window.AKClientRuntimePushSubscription.diagnoseSubscription = diagnoseSubscription;
    window.AKClientRuntimePushSubscription.getLastError = getLastError;
})();
