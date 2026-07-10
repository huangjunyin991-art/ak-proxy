from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AccountIDColumnSpec:
    table_name: str
    username_column: str
    account_id_column: str
    description: str = ""


@dataclass(frozen=True)
class AccountIDPhase:
    key: str
    title: str
    description: str
    specs: tuple[AccountIDColumnSpec, ...]


ACCOUNT_ID_PHASES: tuple[AccountIDPhase, ...] = (
    AccountIDPhase(
        key="core",
        title="核心账号表",
        description="覆盖主账号资料、授权能力和关键业务缓存等核心数据表。",
        specs=(
            AccountIDColumnSpec("user_stats", "username", "account_id", "用户主资料与登录态。"),
            AccountIDColumnSpec("user_assets", "username", "account_id", "用户资产、等级与区值数据。"),
            AccountIDColumnSpec("authorized_accounts", "username", "account_id", "白名单与套餐授权。"),
            AccountIDColumnSpec("point_history_records", "username", "account_id", "点数流水明细。"),
            AccountIDColumnSpec("point_history_user_summary", "username", "account_id", "点数流水汇总。"),
            AccountIDColumnSpec("meeting_publish_permissions", "username", "account_id", "会议发布权限归属。"),
            AccountIDColumnSpec("ak_scan_runtime", "current_account_username", "current_account_id", "AK 数据扫描运行账号。"),
            AccountIDColumnSpec("admin_recommend_tree_cache", "account", "account_id", "组织架构缓存归属账号。"),
        ),
    ),
    AccountIDPhase(
        key="relations",
        title="账号关系表",
        description="覆盖绑定关系、风险隔离和通知订阅等依赖账号身份的数据表。",
        specs=(
            AccountIDColumnSpec("sub_admin_account_bindings", "account_username", "account_id", "子管理员绑定账号。"),
            AccountIDColumnSpec("risk_isolations", "username", "account_id", "风险隔离目标账号。"),
            AccountIDColumnSpec("risk_isolations", "umbrella_root", "umbrella_root_account_id", "风险隔离伞下根账号。"),
            AccountIDColumnSpec("risk_isolation_userkeys", "username", "account_id", "风险隔离 UserKey 缓存归属。"),
            AccountIDColumnSpec("notify_push_subscriptions", "username", "account_id", "Web Push 订阅归属。"),
            AccountIDColumnSpec("notify_pushdeer_bindings", "username", "account_id", "PushDeer 绑定归属。"),
            AccountIDColumnSpec("notify_ntfy_bindings", "username", "account_id", "ntfy 绑定归属。"),
            AccountIDColumnSpec("notify_outbox", "recipient_username", "recipient_account_id", "待发送通知接收人。"),
        ),
    ),
    AccountIDPhase(
        key="im_core",
        title="IM 核心表",
        description="覆盖 IM 用户资料、会话、消息等核心身份数据表。",
        specs=(
            AccountIDColumnSpec("im_user_profile", "username", "account_id", "IM 用户资料。"),
            AccountIDColumnSpec("im_user_avatar_history", "username", "account_id", "IM 头像历史。"),
            AccountIDColumnSpec("im_conversation", "owner_username", "owner_account_id", "会话拥有者。"),
            AccountIDColumnSpec("im_conversation_member", "username", "account_id", "会话成员身份。"),
            AccountIDColumnSpec("im_conversation_admin", "username", "account_id", "会话管理员身份。"),
            AccountIDColumnSpec("im_message", "sender_username", "sender_account_id", "消息发送者身份。"),
            AccountIDColumnSpec("im_message_mention", "mentioned_username", "mentioned_account_id", "消息提及对象身份。"),
            AccountIDColumnSpec("im_switch_tokens", "username", "account_id", "IM 切换令牌归属。"),
        ),
    ),
    AccountIDPhase(
        key="im_social",
        title="IM 社交表",
        description="覆盖联系人、黑名单和私聊门禁等 IM 社交关系数据表。",
        specs=(
            AccountIDColumnSpec("im_user_contact", "owner_username", "owner_account_id", "联系人拥有者。"),
            AccountIDColumnSpec("im_user_contact", "target_username", "target_account_id", "联系人目标账号。"),
            AccountIDColumnSpec("im_user_blacklist", "owner_username", "owner_account_id", "黑名单拥有者。"),
            AccountIDColumnSpec("im_user_blacklist", "target_username", "target_account_id", "黑名单目标账号。"),
            AccountIDColumnSpec("im_direct_message_gate", "initiator_username", "initiator_account_id", "私聊门禁发起账号。"),
        ),
    ),
)


PHASE_BY_KEY = {phase.key: phase for phase in ACCOUNT_ID_PHASES}
