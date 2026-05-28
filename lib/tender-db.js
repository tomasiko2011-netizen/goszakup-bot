/**
 * Tender Bot — Neon PostgreSQL database layer
 * Uses Neon HTTP driver (no TCP, ideal for Vercel serverless)
 */
import { neon } from '@neondatabase/serverless';

let _sql;
function getSql() {
  if (!_sql) _sql = neon(process.env.NEON_DATABASE_URL);
  return _sql;
}

// --- Schema ---
export async function initTenderSchema() {
  const sql = getSql();

  await sql`CREATE TABLE IF NOT EXISTS tender_users (
    telegram_id BIGINT PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    is_admin BOOLEAN DEFAULT FALSE
  )`;

  await sql`CREATE TABLE IF NOT EXISTS tender_access (
    id SERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL REFERENCES tender_users(telegram_id),
    start_time TIMESTAMPTZ DEFAULT NOW(),
    end_time TIMESTAMPTZ NOT NULL,
    remaining_chars INT NOT NULL DEFAULT 1000,
    source TEXT NOT NULL
  )`;

  await sql`CREATE TABLE IF NOT EXISTS tender_channels (
    id SERIAL PRIMARY KEY,
    channel_username TEXT NOT NULL UNIQUE,
    active BOOLEAN DEFAULT TRUE
  )`;

  await sql`CREATE TABLE IF NOT EXISTS tender_referrals (
    id SERIAL PRIMARY KEY,
    referrer_id BIGINT NOT NULL REFERENCES tender_users(telegram_id),
    referred_id BIGINT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    access_granted BOOLEAN DEFAULT FALSE
  )`;

  await sql`CREATE TABLE IF NOT EXISTS tender_social_actions (
    id SERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL REFERENCES tender_users(telegram_id),
    platform TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    eligible_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS tender_char_log (
    id SERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    access_id INT,
    action TEXT NOT NULL,
    chars_used INT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS tender_user_keywords (
    telegram_id BIGINT NOT NULL,
    keyword TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (telegram_id, keyword)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_user_keywords_tg ON tender_user_keywords(telegram_id)`;

  await sql`CREATE TABLE IF NOT EXISTS tender_user_filters (
    telegram_id BIGINT PRIMARY KEY,
    region TEXT,
    min_sum NUMERIC,
    max_sum NUMERIC,
    deadline_days INT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`;
}

// --- User keywords (persistent across cold starts) ---
export async function getUserKeywords(telegramId) {
  const sql = getSql();
  const rows = await sql`SELECT keyword FROM tender_user_keywords
    WHERE telegram_id = ${telegramId}
    ORDER BY created_at`;
  return rows.map(r => r.keyword);
}

export async function addUserKeyword(telegramId, keyword) {
  const sql = getSql();
  const rows = await sql`INSERT INTO tender_user_keywords (telegram_id, keyword)
    VALUES (${telegramId}, ${keyword})
    ON CONFLICT (telegram_id, keyword) DO NOTHING
    RETURNING keyword`;
  return rows.length > 0;
}

export async function removeUserKeyword(telegramId, keyword) {
  const sql = getSql();
  const rows = await sql`DELETE FROM tender_user_keywords
    WHERE telegram_id = ${telegramId} AND keyword = ${keyword}
    RETURNING keyword`;
  return rows.length > 0;
}

// --- User filters (persistent across cold starts) ---
export async function getUserFilters(telegramId) {
  const sql = getSql();
  const rows = await sql`SELECT region, min_sum, max_sum, deadline_days
    FROM tender_user_filters WHERE telegram_id = ${telegramId}`;
  if (rows.length === 0) return {};
  const r = rows[0];
  const out = {};
  if (r.region != null) out.region = r.region;
  if (r.min_sum != null) out.minSum = Number(r.min_sum);
  if (r.max_sum != null) out.maxSum = Number(r.max_sum);
  if (r.deadline_days != null) out.deadlineDays = Number(r.deadline_days);
  return out;
}

export async function setUserFilters(telegramId, filters) {
  const sql = getSql();
  const region = filters.region ?? null;
  const minSum = filters.minSum ?? null;
  const maxSum = filters.maxSum ?? null;
  const deadlineDays = filters.deadlineDays ?? null;
  await sql`INSERT INTO tender_user_filters
      (telegram_id, region, min_sum, max_sum, deadline_days, updated_at)
    VALUES (${telegramId}, ${region}, ${minSum}, ${maxSum}, ${deadlineDays}, NOW())
    ON CONFLICT (telegram_id) DO UPDATE SET
      region = EXCLUDED.region,
      min_sum = EXCLUDED.min_sum,
      max_sum = EXCLUDED.max_sum,
      deadline_days = EXCLUDED.deadline_days,
      updated_at = NOW()`;
}

export async function clearUserFilters(telegramId) {
  const sql = getSql();
  await sql`DELETE FROM tender_user_filters WHERE telegram_id = ${telegramId}`;
}

// --- Users ---
export async function upsertUser(telegramId, username, firstName) {
  const sql = getSql();
  await sql`INSERT INTO tender_users (telegram_id, username, first_name)
    VALUES (${telegramId}, ${username}, ${firstName})
    ON CONFLICT (telegram_id) DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name`;
}

export async function isAdmin(telegramId) {
  const sql = getSql();
  const rows = await sql`SELECT is_admin FROM tender_users WHERE telegram_id = ${telegramId}`;
  return rows.length > 0 && rows[0].is_admin;
}

// --- Access ---
export async function getActiveAccess(telegramId) {
  const sql = getSql();
  const rows = await sql`SELECT id, remaining_chars, end_time, source
    FROM tender_access
    WHERE telegram_id = ${telegramId}
      AND end_time > NOW()
      AND remaining_chars > 0
    ORDER BY end_time DESC LIMIT 1`;
  return rows[0] || null;
}

export async function grantAccess(telegramId, source, chars = 1000, hours = 24) {
  const sql = getSql();
  const rows = await sql`INSERT INTO tender_access (telegram_id, end_time, remaining_chars, source)
    VALUES (${telegramId}, NOW() + ${hours + ' hours'}::INTERVAL, ${chars}, ${source})
    RETURNING id`;
  return rows[0];
}

export async function deductChars(accessId, amount, action, telegramId) {
  const sql = getSql();
  const rows = await sql`UPDATE tender_access
    SET remaining_chars = remaining_chars - ${amount}
    WHERE id = ${accessId} AND remaining_chars >= ${amount}
    RETURNING remaining_chars`;
  if (rows.length > 0) {
    await sql`INSERT INTO tender_char_log (telegram_id, access_id, action, chars_used)
      VALUES (${telegramId}, ${accessId}, ${action}, ${amount})`;
    return rows[0].remaining_chars;
  }
  return null;
}

// --- Channels ---
export async function getChannels() {
  const sql = getSql();
  return sql`SELECT channel_username FROM tender_channels WHERE active = TRUE ORDER BY id`;
}

export async function addChannel(channelUsername) {
  const sql = getSql();
  const clean = channelUsername.replace(/^@/, '');
  await sql`INSERT INTO tender_channels (channel_username)
    VALUES (${clean})
    ON CONFLICT (channel_username) DO UPDATE SET active = TRUE`;
}

export async function removeChannel(channelUsername) {
  const sql = getSql();
  const clean = channelUsername.replace(/^@/, '');
  await sql`UPDATE tender_channels SET active = FALSE WHERE channel_username = ${clean}`;
}

// --- Referrals ---
export async function recordReferral(referrerId, referredId) {
  const sql = getSql();
  try {
    await sql`INSERT INTO tender_referrals (referrer_id, referred_id)
      VALUES (${referrerId}, ${referredId})`;
    return true;
  } catch (e) {
    // UNIQUE violation = already referred
    if (e.code === '23505') return false;
    throw e;
  }
}

export async function getReferralCount(telegramId) {
  const sql = getSql();
  const rows = await sql`SELECT COUNT(*)::INT as cnt FROM tender_referrals
    WHERE referrer_id = ${telegramId}
      AND created_at > NOW() - INTERVAL '24 hours'`;
  return rows[0].cnt;
}

export async function grantReferralAccess(referrerId, referredId) {
  const sql = getSql();
  await sql`UPDATE tender_referrals SET access_granted = TRUE
    WHERE referrer_id = ${referrerId} AND referred_id = ${referredId}`;
  return grantAccess(referrerId, 'referral');
}

// --- Social Actions ---
export async function claimSocialAction(telegramId, platform) {
  const sql = getSql();
  // Check if already has pending for this platform in last hour
  const existing = await sql`SELECT id, status, eligible_at FROM tender_social_actions
    WHERE telegram_id = ${telegramId} AND platform = ${platform}
      AND created_at > NOW() - INTERVAL '1 hour'
      AND status IN ('pending', 'cooldown')
    LIMIT 1`;
  if (existing.length > 0) return { duplicate: true, action: existing[0] };

  // New status model: 'pending' — waiting for admin approval (no auto-grant).
  // The old 'cooldown'/5-minute auto-verify path is removed: users could
  // claim reward without actually subscribing.
  const rows = await sql`INSERT INTO tender_social_actions (telegram_id, platform, status, eligible_at)
    VALUES (${telegramId}, ${platform}, 'pending', NULL)
    RETURNING id, status, eligible_at`;
  return { duplicate: false, action: rows[0] };
}

export async function resolveCooldowns(telegramId) {
  const sql = getSql();
  const resolved = await sql`UPDATE tender_social_actions
    SET status = 'verified'
    WHERE telegram_id = ${telegramId}
      AND status = 'cooldown'
      AND eligible_at <= NOW()
    RETURNING id, platform`;

  for (const row of resolved) {
    await grantAccess(telegramId, `social:${row.platform}`);
  }
  return resolved;
}

export async function getPendingSocialActions() {
  const sql = getSql();
  return sql`SELECT sa.id, sa.telegram_id, sa.platform, sa.status, sa.created_at,
      u.username, u.first_name
    FROM tender_social_actions sa
    JOIN tender_users u ON u.telegram_id = sa.telegram_id
    WHERE sa.status IN ('cooldown', 'verified')
    ORDER BY sa.created_at DESC LIMIT 20`;
}

export async function approveSocialAction(actionId) {
  const sql = getSql();
  const rows = await sql`UPDATE tender_social_actions SET status = 'verified'
    WHERE id = ${actionId} AND status IN ('cooldown', 'pending')
    RETURNING telegram_id, platform`;
  if (rows.length > 0) {
    await grantAccess(rows[0].telegram_id, `social:${rows[0].platform}`);
  }
  return rows[0] || null;
}

export async function rejectSocialAction(actionId) {
  const sql = getSql();
  const rows = await sql`UPDATE tender_social_actions SET status = 'rejected'
    WHERE id = ${actionId}
    RETURNING telegram_id, platform`;
  return rows[0] || null;
}

// --- Stats ---
export async function getStats() {
  const sql = getSql();
  const [users] = await sql`SELECT COUNT(*)::INT as cnt FROM tender_users`;
  const [active] = await sql`SELECT COUNT(DISTINCT telegram_id)::INT as cnt FROM tender_access
    WHERE end_time > NOW() AND remaining_chars > 0`;
  const [refs] = await sql`SELECT COUNT(*)::INT as cnt FROM tender_referrals
    WHERE created_at > NOW() - INTERVAL '24 hours'`;
  const [social] = await sql`SELECT COUNT(*)::INT as cnt FROM tender_social_actions
    WHERE created_at > NOW() - INTERVAL '24 hours'`;
  const [channels] = await sql`SELECT COUNT(*)::INT as cnt FROM tender_channels WHERE active = TRUE`;
  return {
    totalUsers: users.cnt,
    activeUsers: active.cnt,
    referrals24h: refs.cnt,
    socialActions24h: social.cnt,
    activeChannels: channels.cnt
  };
}
