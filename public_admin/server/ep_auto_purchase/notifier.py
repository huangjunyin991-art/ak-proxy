from __future__ import annotations

from typing import Any, Callable, Mapping


class EPAutoPurchaseSuccessNotifier:
    """Persist EP success history and deliver it through the IM push contract."""

    def __init__(self, *, notification_service: Any, notify_center_supplier: Callable[[], Any]) -> None:
        self._notification_service = notification_service
        self._notify_center_supplier = notify_center_supplier

    async def publish(self, order: Mapping[str, Any]) -> None:
        buyer_account = str(order.get("buyer_account") or "").strip().lower()
        sid = str(order.get("sid") or "").strip()
        if not buyer_account or not sid:
            raise ValueError("EP 抢购成功记录缺少订单号或抢购账号")

        event_id = f"ep-auto-purchase:{sid}:success"
        title = "EP 抢购成功"
        content = _build_success_content(order, buyer_account)
        payload = {
            "source": "ep_auto_purchase",
            "event_id": event_id,
            "sid": sid,
            "buyer_account": buyer_account,
            "seller_account": str(order.get("seller_account") or "").strip(),
            "ep_amount": str(order.get("ep_amount") or "").strip(),
        }

        await self._notification_service.publish_system_notification(
            event_id=event_id,
            username=buyer_account,
            title=title,
            content=content,
            payload=payload,
        )

        notify_center = self._notify_center_supplier()
        if notify_center is None:
            raise RuntimeError("通知中心暂不可用")
        await notify_center.handle_im_message_event({
            **payload,
            # Keep the event compatible with clients that only handle IM
            # notification events. This is a push envelope, not a chat row.
            "event_type": "im.system.ep_auto_purchase.success",
            "message_type": "system_notification",
            "sender_username": "system",
            "recipient_usernames": [buyer_account],
            "notification_title": title,
            "notification_body": content,
            "notification_url": "/pages/home.html?first=true",
        })


def _build_success_content(order: Mapping[str, Any], buyer_account: str) -> str:
    sid = str(order.get("sid") or "").strip()
    ep_amount = str(order.get("ep_amount") or "").strip()
    seller_account = str(order.get("seller_account") or "").strip()
    parts = [f"账号 {buyer_account} 已成功抢购订单 #{sid}"]
    if ep_amount:
        parts.append(f"数量 {ep_amount} EP")
    if seller_account:
        parts.append(f"挂卖账号 {seller_account}")
    return "，".join(parts) + "。"
