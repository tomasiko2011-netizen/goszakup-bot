/**
 * Vercel Cron endpoint — polls goszakup for new lots matching each user's
 * keywords and pushes Telegram notifications.
 *
 * Triggered by Vercel Cron (configured in vercel.json). Iterates over every
 * user that has saved keywords; for each (user, keyword) pair it pages the
 * goszakup GraphQL Lots cursor. NOTE: the Lots query has NO `sort` argument —
 * results come back ascending by id and you paginate with `after: <last id>`.
 * So we pass `after: last_seen_lot_id`, which returns exactly the lots whose id
 * is greater than what we last notified, and push those to the user.
 *
 * Auth: Vercel Cron sets `Authorization: Bearer <CRON_SECRET>` if CRON_SECRET
 * env var is set on the project. If not set, accepts any caller (handy in dev).
 */
import {
  initTenderSchema,
  getUsersWithKeywords,
  getLastSeen,
  setLastSeen,
} from '../lib/tender-db.js';

const GQL_URL = "https://ows.goszakup.gov.kz/v3/graphql";
const GQL_TOKEN = (process.env.TENDER_GQL_TOKEN || "").trim();
const BOT_TOKEN = (process.env.TENDER_DEMO_TOKEN || "").trim();
const CRON_SECRET = (process.env.CRON_SECRET || "").trim();

const NEW_LOTS_QUERY = `
  query NewLots($q: String, $limit: Int, $after: Int) {
    Lots(limit: $limit, after: $after, filter: { nameDescriptionRu: $q }) {
      id
      lotNumber
      nameRu
      descriptionRu
      amount
      customerNameRu
      customerBin
      trdBuyId
      TrdBuy {
        id
        nameRu
        totalSum
        endDate
        publishDate
        customerNameRu
        customerBin
        orgNameRu
        orgBin
        kato
      }
    }
  }
`;

async function gqlRequest(query, variables, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GQL_TOKEN}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (data?.errors) throw new Error(data.errors[0]?.message || "GraphQL error");
    return data?.data;
  } finally {
    clearTimeout(timeout);
  }
}

// goszakup Lots cursor is ascending by id, paged via `after: <last id>`.
const PAGE_SIZE = 200;          // goszakup max page size
const MAX_NEW_PAGES = 5;        // steady-state: cap pages of new lots scanned per run
const MAX_BASELINE_PAGES = 25;  // first-run high-water mark search (safety-capped)

// Page the Lots cursor starting strictly after `afterId`.
// Returns { lots, maxId, capped }: lots = everything with id > afterId we fetched
// (ascending), maxId = highest id seen (>= afterId), capped = hit the page cap.
async function pageLotsAfter(kw, afterId, maxPages) {
  const lots = [];
  let cursor = afterId;
  let capped = false;
  for (let p = 0; p < maxPages; p++) {
    const data = await gqlRequest(NEW_LOTS_QUERY, { q: kw, limit: PAGE_SIZE, after: cursor });
    const batch = data?.Lots || [];
    if (batch.length === 0) break;
    lots.push(...batch);
    cursor = Math.max(cursor, ...batch.map(l => Number(l.id)));
    if (batch.length < PAGE_SIZE) break;
    if (p === maxPages - 1) capped = true;
  }
  return { lots, maxId: cursor, capped };
}

async function tgSend(chatId, text, extra = {}) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        ...extra,
      }),
      signal: AbortSignal.timeout(8000),
    });
    return res.json();
  } catch {
    return { ok: false };
  }
}

function formatAmount(amount) {
  return Number(amount || 0).toLocaleString("ru-RU");
}

function formatLotCard(lot, keyword) {
  const t = lot.TrdBuy || {};
  const tenderId = t.id || lot.trdBuyId || lot.id;
  const url = `https://goszakup.gov.kz/ru/announce/index/${tenderId}`;
  const customerName = lot.customerNameRu || t.customerNameRu || t.orgNameRu || "Заказчик не указан";
  const customerBin = lot.customerBin || t.customerBin || t.orgBin || "";
  const customer = customerBin ? `${customerName} (БИН: ${customerBin})` : customerName;
  const tenderTitle = t.nameRu || lot.nameRu || "Без названия";
  const amount = formatAmount(t.totalSum || lot.amount || 0);
  const deadline = t.endDate || t.publishDate || "";
  const desc = lot.descriptionRu ? (lot.descriptionRu.length > 180 ? lot.descriptionRu.slice(0, 180) + "…" : lot.descriptionRu) : "";

  let card = `🆕 *Новый тендер по «${keyword}»*\n\n`;
  card += `📋 *${tenderTitle}*\n`;
  if (lot.nameRu && lot.nameRu !== tenderTitle) {
    card += `📦 Лот: ${lot.nameRu}\n`;
  }
  if (desc) card += `📝 ${desc}\n`;
  card += `💰 Сумма: ${amount} ₸\n`;
  card += `🏢 ${customer}\n`;
  if (deadline) card += `📅 Дедлайн: ${deadline}\n`;
  card += `🔗 ${url}`;
  return card;
}

export default async function handler(req, res) {
  // Cron auth: Vercel sets Authorization: Bearer <CRON_SECRET>
  if (CRON_SECRET) {
    const authHeader = req.headers.authorization || "";
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  if (!GQL_TOKEN || !BOT_TOKEN) {
    return res.status(500).json({ error: "missing TENDER_GQL_TOKEN or TENDER_DEMO_TOKEN" });
  }

  await initTenderSchema();

  const startedAt = Date.now();
  const stats = { users: 0, keywords: 0, fetched: 0, notifications: 0, errors: 0 };
  const MAX_NOTIFY_PER_KEYWORD = 3; // cap to avoid flooding a user when many new lots appear

  try {
    const users = await getUsersWithKeywords();
    stats.users = users.length;

    for (const u of users) {
      const tgId = Number(u.telegram_id);
      const keywords = (u.keywords || []).filter(Boolean);
      for (const kw of keywords) {
        stats.keywords++;
        try {
          const lastSeen = await getLastSeen(tgId, kw);

          // First run for this keyword: establish the high-water mark by paging
          // to the newest id, and notify nothing — otherwise we'd dump history.
          if (lastSeen === 0) {
            const { maxId } = await pageLotsAfter(kw, 0, MAX_BASELINE_PAGES);
            if (maxId > 0) await setLastSeen(tgId, kw, maxId);
            continue;
          }

          // Steady state: the cursor returns exactly id > lastSeen (the new lots).
          const { lots, maxId } = await pageLotsAfter(kw, lastSeen, MAX_NEW_PAGES);
          stats.fetched += lots.length;
          if (lots.length === 0) continue;

          // Newest first for display, cap how many we push
          lots.sort((a, b) => Number(b.id) - Number(a.id));
          const toSend = lots.slice(0, MAX_NOTIFY_PER_KEYWORD);

          for (const lot of toSend) {
            const card = formatLotCard(lot, kw);
            const r = await tgSend(tgId, card);
            if (r?.ok) stats.notifications++;
            else stats.errors++;
            // Light rate-limit pacing
            await new Promise(r => setTimeout(r, 250));
          }

          if (lots.length > MAX_NOTIFY_PER_KEYWORD) {
            await tgSend(tgId,
              `…и ещё ${lots.length - MAX_NOTIFY_PER_KEYWORD} новых тендеров по «${kw}». ` +
              `Нажмите «🔍 Найти тендеры» чтобы посмотреть все.`
            );
          }

          await setLastSeen(tgId, kw, maxId);
        } catch (e) {
          stats.errors++;
        }
      }
    }
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e), stats });
  }

  stats.duration_ms = Date.now() - startedAt;
  return res.status(200).json({ ok: true, stats });
}
