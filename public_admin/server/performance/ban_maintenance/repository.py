async def normalize_loopback_records(conn) -> None:
    await conn.execute('''
        UPDATE ip_stats
        SET is_banned = FALSE, banned_at = NULL, banned_reason = '',
            preban_count = 0, preban_first_seen = NULL, preban_last_seen = NULL, preban_reason = ''
        WHERE ip_address IN ('127.0.0.1', '::1', 'localhost')
           OR ip_address LIKE '127.%'
    ''')
    await conn.execute('''
        UPDATE user_stats
        SET last_ip = ''
        WHERE last_ip IN ('127.0.0.1', '::1', 'localhost')
           OR last_ip LIKE '127.%'
    ''')
    await conn.execute('''
        DELETE FROM ip_stats
        WHERE ip_address IN ('127.0.0.1', '::1', 'localhost')
           OR ip_address LIKE '127.%'
    ''')
    await conn.execute('''
        DELETE FROM ban_list
        WHERE ban_type = 'ip'
          AND (
              ban_value IN ('127.0.0.1', '::1', 'localhost')
              OR ban_value LIKE '127.%'
          )
    ''')


async def release_expired_user_bans(conn) -> None:
    await conn.execute('''
        UPDATE user_stats us
        SET is_banned = FALSE, banned_at = NULL, banned_reason = ''
        FROM ban_list bl
        WHERE bl.ban_type = 'username'
          AND bl.ban_value = us.username
          AND bl.is_active = TRUE
          AND bl.banned_until IS NOT NULL
          AND bl.banned_until <= NOW()
          AND us.is_banned = TRUE
    ''')


async def release_expired_ip_bans(conn) -> None:
    await conn.execute('''
        UPDATE ip_stats ips
        SET is_banned = FALSE, banned_at = NULL, banned_reason = '',
            preban_count = 0, preban_first_seen = NULL, preban_last_seen = NULL, preban_reason = ''
        FROM ban_list bl
        WHERE bl.ban_type = 'ip'
          AND bl.ban_value = ips.ip_address
          AND bl.is_active = TRUE
          AND bl.banned_until IS NOT NULL
          AND bl.banned_until <= NOW()
          AND ips.is_banned = TRUE
    ''')


async def cleanup_old_ban_list_rows(conn) -> None:
    await conn.execute('''
        DELETE FROM ban_list
        WHERE (is_active = FALSE OR (banned_until IS NOT NULL AND banned_until <= NOW()))
          AND COALESCE(released_at, banned_until, banned_at) < NOW() - INTERVAL '7 days'
    ''')


async def run_ban_normalization(conn) -> None:
    await normalize_loopback_records(conn)
    await release_expired_user_bans(conn)
    await release_expired_ip_bans(conn)
    await cleanup_old_ban_list_rows(conn)
