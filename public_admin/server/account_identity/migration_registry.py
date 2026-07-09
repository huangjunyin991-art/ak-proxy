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
        title="Core Account Tables",
        description="Primary account records and permission-bearing tables.",
        specs=(
            AccountIDColumnSpec("user_stats", "username", "account_id", "Core account profile and auth state."),
            AccountIDColumnSpec("user_assets", "username", "account_id", "Honor and area stats."),
            AccountIDColumnSpec("authorized_accounts", "username", "account_id", "Whitelist and plan authority."),
            AccountIDColumnSpec("point_history_records", "username", "account_id", "Detailed point history."),
            AccountIDColumnSpec("point_history_user_summary", "username", "account_id", "Point history summary."),
            AccountIDColumnSpec("meeting_publish_permissions", "username", "account_id", "Meeting publish permission owner."),
            AccountIDColumnSpec("ak_scan_runtime", "current_account_username", "current_account_id", "Current AK scan runtime account."),
            AccountIDColumnSpec("admin_recommend_tree_cache", "account", "account_id", "Recommend tree cache owner."),
        ),
    ),
    AccountIDPhase(
        key="relations",
        title="Account Relations",
        description="Bindings, risk isolation and notification ownership.",
        specs=(
            AccountIDColumnSpec("sub_admin_account_bindings", "account_username", "account_id", "Sub-admin bound account."),
            AccountIDColumnSpec("risk_isolations", "username", "account_id", "Risk isolation target."),
            AccountIDColumnSpec("risk_isolations", "umbrella_root", "umbrella_root_account_id", "Risk isolation umbrella root."),
            AccountIDColumnSpec("risk_isolation_userkeys", "username", "account_id", "Risk isolation cached userkey owner."),
            AccountIDColumnSpec("notify_push_subscriptions", "username", "account_id", "Web push binding owner."),
            AccountIDColumnSpec("notify_pushdeer_bindings", "username", "account_id", "PushDeer binding owner."),
            AccountIDColumnSpec("notify_ntfy_bindings", "username", "account_id", "ntfy binding owner."),
            AccountIDColumnSpec("notify_outbox", "recipient_username", "recipient_account_id", "Pending notification recipient."),
        ),
    ),
    AccountIDPhase(
        key="im_core",
        title="IM Core",
        description="Identity-bearing IM conversation and message tables.",
        specs=(
            AccountIDColumnSpec("im_user_profile", "username", "account_id", "IM profile owner."),
            AccountIDColumnSpec("im_user_avatar_history", "username", "account_id", "IM avatar history owner."),
            AccountIDColumnSpec("im_conversation", "owner_username", "owner_account_id", "Conversation owner."),
            AccountIDColumnSpec("im_conversation_member", "username", "account_id", "Conversation member identity."),
            AccountIDColumnSpec("im_conversation_admin", "username", "account_id", "Conversation admin identity."),
            AccountIDColumnSpec("im_message", "sender_username", "sender_account_id", "Message sender identity."),
            AccountIDColumnSpec("im_message_mention", "mentioned_username", "mentioned_account_id", "Mention target identity."),
            AccountIDColumnSpec("im_switch_tokens", "username", "account_id", "IM switch token owner."),
        ),
    ),
    AccountIDPhase(
        key="im_social",
        title="IM Social",
        description="IM social graph and direct-message gating tables.",
        specs=(
            AccountIDColumnSpec("im_user_contact", "owner_username", "owner_account_id", "Contact owner."),
            AccountIDColumnSpec("im_user_contact", "target_username", "target_account_id", "Contact target."),
            AccountIDColumnSpec("im_user_blacklist", "owner_username", "owner_account_id", "Blacklist owner."),
            AccountIDColumnSpec("im_user_blacklist", "target_username", "target_account_id", "Blacklist target."),
            AccountIDColumnSpec("im_direct_message_gate", "initiator_username", "initiator_account_id", "Direct-message initiator."),
        ),
    ),
)


PHASE_BY_KEY = {phase.key: phase for phase in ACCOUNT_ID_PHASES}

