/**
 * Vercel serverless webhook — Tender Monitor Bot
 * Мониторинг госзакупок goszakup.gov.kz — production/live
 * Reward-система: доступ через задания (подписка, соцсети, рефералы)
 *
 * Env vars:
 *   TENDER_DEMO_TOKEN      — Telegram bot token
 *   TENDER_DEMO_ADMIN_ID   — Admin chat ID
 *   NEON_DATABASE_URL       — Neon PostgreSQL connection string
 *   TENDER_BOT_USERNAME     — Bot username without @ (for referral deep links)
 */
import {
  initTenderSchema, upsertUser, isAdmin as dbIsAdmin,
  getActiveAccess, grantAccess, deductChars,
  getChannels, addChannel, removeChannel,
  recordReferral, getReferralCount, grantReferralAccess,
  claimSocialAction, resolveCooldowns,
  getPendingSocialActions, approveSocialAction, rejectSocialAction,
  getStats,
  getUserKeywords, addUserKeyword, removeUserKeyword,
  getUserFilters, setUserFilters, clearUserFilters
} from '../lib/tender-db.js';

// All env reads use .trim() — prod env-vars were saved with literal "\n"
// via vercel CLI echo, which silently breaks API calls and webhook secrets.
const _envTrim = (k, fallback = '') => (process.env[k] || fallback).trim();
const TOKEN = () => _envTrim('TENDER_DEMO_TOKEN');
const ADMIN_ID = () => _envTrim('TENDER_DEMO_ADMIN_ID');
const UNLIMITED_IDS = [
  '8631926965',  // Гульдана (owner, @BotJasau)
  '8468989023',  // Гульдана alt (@NewQaz)
  '454779102',   // Muhammad
  '748220848',   // Адильбек (@Deko_mirror)
  '5584730486',  // Айдар (@KZ888ADR08)
];
const BOT_USERNAME = () => _envTrim('TENDER_BOT_USERNAME', 'tender_bot');

// --- Schema init (once per cold start) ---
let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await initTenderSchema();
  schemaReady = true;
}

// --- In-memory rate limiter ---
const rateLimits = new Map();
function checkRateLimit(chatId) {
  const now = Date.now();
  const entry = rateLimits.get(chatId);
  if (!entry) {
    rateLimits.set(chatId, { count: 1, resetAt: now + 10000 });
    return true;
  }
  if (now > entry.resetAt) {
    rateLimits.set(chatId, { count: 1, resetAt: now + 10000 });
    return true;
  }
  entry.count++;
  return entry.count <= 10;
}

// --- User keywords (persisted in Neon — survive Vercel cold starts) ---
async function getKeywords(chatId) {
  return getUserKeywords(chatId);
}

async function addKeywordToList(chatId, keyword) {
  const normalized = keyword.toLowerCase().trim();
  return addUserKeyword(chatId, normalized);
}

async function removeKeywordFromList(chatId, keyword) {
  return removeUserKeyword(chatId, keyword.toLowerCase().trim());
}

// --- User state (waiting for keyword input, admin input, etc.) ---
// In-memory: ephemeral conversational state, OK to lose on cold start
const userStates = new Map();

// --- Action costs (chars) ---
const ACTION_COST = {
  search: 300,
  latest: 200,
  keywords: 50,
  add_keyword: 20,
};

const LIVE_MODE = true;
// Hardcode URL: prod env-var was saved with literal "\n" via vercel CLI echo,
// breaking fetch (404 "Unable to resolve v3/graphql\n"). Avoid env entirely.
const GQL_URL = "https://ows.goszakup.gov.kz/v3/graphql";
// Trim token: same env CLI bug can leave "\n" or whitespace at the end,
// which breaks the Authorization header.
const GQL_TOKEN = (process.env.TENDER_GQL_TOKEN || "").trim();

// --- Mock tender data ---
const MOCK_TENDERS = [
  {
    id: "1001",
    title: "Разработка мобильного приложения для государственных услуг",
    amount: 5200000,
    customer: 'АО "Казахтелеком"',
    deadline: "25.03.2026",
    keywords: ["разработка", "приложение", "it", "мобильное"],
    url: "https://goszakup.gov.kz/ru/announce/index/1001",
  },
  {
    id: "1002",
    title: "Поставка серверного оборудования и лицензий ПО",
    amount: 12800000,
    customer: 'ТОО "НИТ"',
    deadline: "28.03.2026",
    keywords: ["серверное", "оборудование", "it", "по", "лицензии"],
    url: "https://goszakup.gov.kz/ru/announce/index/1002",
  },
  {
    id: "1003",
    title: "Строительство административного здания",
    amount: 89500000,
    customer: "Акимат г. Астана",
    deadline: "15.04.2026",
    keywords: ["строительство", "здание", "ремонт"],
    url: "https://goszakup.gov.kz/ru/announce/index/1003",
  },
  {
    id: "1004",
    title: "Разработка и внедрение CRM-системы",
    amount: 7400000,
    customer: 'АО "Самрук-Казына"',
    deadline: "01.04.2026",
    keywords: ["разработка", "crm", "it", "система", "внедрение"],
    url: "https://goszakup.gov.kz/ru/announce/index/1004",
  },
  {
    id: "1005",
    title: "Услуги по техническому обслуживанию сети",
    amount: 3100000,
    customer: 'РГП "КЦМР"',
    deadline: "30.03.2026",
    keywords: ["обслуживание", "сеть", "услуги", "it"],
    url: "https://goszakup.gov.kz/ru/announce/index/1005",
  },
  {
    id: "1006",
    title: "Поставка офисной мебели и оргтехники",
    amount: 4600000,
    customer: "Министерство финансов РК",
    deadline: "20.03.2026",
    keywords: ["поставка", "мебель", "оргтехника"],
    url: "https://goszakup.gov.kz/ru/announce/index/1006",
  },
  {
    id: "1007",
    title: "Создание чат-бота для портала электронного правительства",
    amount: 8900000,
    customer: 'АО "НИТ"',
    deadline: "10.04.2026",
    keywords: ["бот", "чат-бот", "it", "разработка", "портал"],
    url: "https://goszakup.gov.kz/ru/announce/index/1007",
  },
];

async function gqlRequest(query, variables = {}) {
  if (!GQL_TOKEN) throw new Error("missing_token");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(GQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(GQL_TOKEN ? { Authorization: `Bearer ${GQL_TOKEN}` } : {}),
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

function normalizeTrdBuy(t) {
  const customerName =
    t.customerNameRu ||
    t.customerNameKz ||
    t.orgNameRu ||
    t.orgNameKz ||
    "Заказчик не указан";
  const customerBin = t.customerBin || t.orgBin || "";
  return {
    id: String(t.id || ""),
    title: t.nameRu || t.nameKz || "Без названия",
    amount: Number(t.totalSum || 0),
    customer: customerBin ? `${customerName} (БИН: ${customerBin})` : customerName,
    deadline: t.endDate || t.publishDate || "",
    startDate: t.startDate || "",
    publishDate: t.publishDate || "",
    kato: t.kato || "",
    keywords: [],
    url: t.id ? `https://goszakup.gov.kz/ru/announce/index/${t.id}` : "",
  };
}

async function fetchLatestLive(limit = 5) {
  const queryCamel = `
    query LatestTrdBuy($limit: Int) {
      TrdBuy(limit: $limit, after: 0) {
        id
        nameRu
        nameKz
        totalSum
        startDate
        customerNameRu
        customerNameKz
        customerBin
        orgNameRu
        orgNameKz
        orgBin
        kato
        publishDate
        endDate
      }
    }
  `;
  const querySnake = `
    query LatestTrdBuy($limit: Int) {
      trd_buy(limit: $limit, after: 0) {
        id
        name_ru
        name_kz
        total_sum
        start_date
        customer_name_ru
        customer_name_kz
        customer_bin
        org_name_ru
        org_name_kz
        org_bin
        kato
        publish_date
        end_date
      }
    }
  `;
  try {
    const data = await gqlRequest(queryCamel, { limit });
    const items = data?.TrdBuy || [];
    return items.map(normalizeTrdBuy);
  } catch (e) {
    const data = await gqlRequest(querySnake, { limit });
    const items = data?.trd_buy || [];
    return items.map(t => normalizeTrdBuy({
      id: t.id,
      nameRu: t.name_ru,
      nameKz: t.name_kz,
      totalSum: t.total_sum,
      startDate: t.start_date,
      customerNameRu: t.customer_name_ru,
      customerNameKz: t.customer_name_kz,
      customerBin: t.customer_bin,
      orgNameRu: t.org_name_ru,
      orgNameKz: t.org_name_kz,
      orgBin: t.org_bin,
      kato: t.kato,
      publishDate: t.publish_date,
      endDate: t.end_date,
    }));
  }
}

function buildCamelQuery(filterField) {
  return `
    query SearchTrdBuy($q: String, $limit: Int) {
      TrdBuy(limit: $limit, after: 0, filter: { ${filterField}: $q }) {
        id
        nameRu
        nameKz
        totalSum
        startDate
        customerNameRu
        customerNameKz
        customerBin
        orgNameRu
        orgNameKz
        orgBin
        kato
        publishDate
        endDate
      }
    }
  `;
}

function buildSnakeQuery(filterField) {
  return `
    query SearchTrdBuy($q: String, $limit: Int) {
      trd_buy(limit: $limit, after: 0, filters: { ${filterField}: $q }) {
        id
        name_ru
        name_kz
        total_sum
        start_date
        customer_name_ru
        customer_name_kz
        customer_bin
        org_name_ru
        org_name_kz
        org_bin
        kato
        publish_date
        end_date
      }
    }
  `;
}

function mapSnakeTender(t) {
  return normalizeTrdBuy({
    id: t.id,
    nameRu: t.name_ru,
    nameKz: t.name_kz,
    totalSum: t.total_sum,
    startDate: t.start_date,
    customerNameRu: t.customer_name_ru,
    customerNameKz: t.customer_name_kz,
    customerBin: t.customer_bin,
    orgNameRu: t.org_name_ru,
    orgNameKz: t.org_name_kz,
    orgBin: t.org_bin,
    kato: t.kato,
    publishDate: t.publish_date,
    endDate: t.end_date,
  });
}

async function fetchByKeyword(kw, perKwLimit) {
  // Try substring filter (nameDescriptionRu) first, then exact (nameRu),
  // each with camelCase + snake_case fallback. Return raw matches; caller verifies.
  const attempts = [
    { query: buildCamelQuery('nameDescriptionRu'), root: 'TrdBuy', snake: false },
    { query: buildCamelQuery('nameRu'),            root: 'TrdBuy', snake: false },
    { query: buildSnakeQuery('name_description_ru'), root: 'trd_buy', snake: true },
    { query: buildSnakeQuery('name_ru'),             root: 'trd_buy', snake: true },
  ];
  for (const a of attempts) {
    try {
      const data = await gqlRequest(a.query, { q: kw, limit: perKwLimit });
      const items = data?.[a.root] || [];
      if (items.length === 0) continue;
      return a.snake ? items.map(mapSnakeTender) : items.map(normalizeTrdBuy);
    } catch (_) {
      continue;
    }
  }
  return [];
}

async function searchLiveByKeywords(keywords, limit = 10) {
  // Server-side filter per keyword (parallel), merge by tender id,
  // verify locally (substring), graceful failure per keyword.
  const normKeywords = keywords
    .map(k => String(k || "").toLowerCase().trim())
    .filter(Boolean);
  if (normKeywords.length === 0) return [];

  const perKwLimit = Math.max(10, Math.min(50, limit * 5));
  const byId = new Map(); // id -> { tender, matchedKeywords: Set<string> }
  let anySucceeded = false;

  const results = await Promise.allSettled(
    normKeywords.map(kw => fetchByKeyword(kw, perKwLimit).then(items => ({ kw, items })))
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    anySucceeded = true;
    const { kw, items } = r.value;
    for (const tender of items) {
      const hay = `${tender.title || ""} ${tender.customer || ""}`.toLowerCase();
      if (!hay.includes(kw)) continue; // local verification
      const existing = byId.get(tender.id);
      if (existing) {
        existing.matchedKeywords.add(kw);
      } else {
        byId.set(tender.id, { tender, matchedKeywords: new Set([kw]) });
      }
    }
  }

  if (!anySucceeded) throw new Error("all_keyword_queries_failed");

  return Array.from(byId.values())
    .slice(0, limit)
    .map(({ tender, matchedKeywords }) => ({
      tender,
      matchedKeywords: Array.from(matchedKeywords),
    }));
}

// --- Telegram helpers ---
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return res.json();
}

async function send(chatId, text, opts = {}) {
  const payload = { chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true, ...opts };
  const result = await tg("sendMessage", payload);
  if (!result.ok && result.description?.includes("parse")) {
    return tg("sendMessage", { ...payload, parse_mode: undefined });
  }
  return result;
}

async function editMessage(chatId, messageId, text, opts = {}) {
  return tg("editMessageText", {
    chat_id: chatId, message_id: messageId, text,
    parse_mode: "Markdown", disable_web_page_preview: true, ...opts
  });
}

async function answer(queryId, text) {
  return tg("answerCallbackQuery", { callback_query_id: queryId, text }).catch(() => {});
}

async function notifyAdmin(text) {
  const adminId = ADMIN_ID();
  if (!adminId) return;
  return send(adminId, text).catch(() => {});
}

function sanitize(str, maxLen = 100) {
  return String(str || "").slice(0, maxLen).replace(/[*_`\[\]()~>#+\-=|{}.!\\]/g, "\\$&");
}

function formatAmount(amount) {
  return amount.toLocaleString("ru-RU");
}

// --- Tender card formatter ---
function formatTender(tender, matchedKeywords) {
  let card = `📋 *${tender.title}*\n`;
  card += `💰 Сумма: ${formatAmount(tender.amount)} ₸\n`;
  card += `🏢 Заказчик: ${tender.customer}\n`;
  card += `📅 Дедлайн: ${tender.deadline}\n`;
  if (matchedKeywords && matchedKeywords.length > 0) {
    card += `🔑 Совпадение: ${matchedKeywords.map(k => `"${k}"`).join(", ")}\n`;
  }
  card += `🔗 ${tender.url}`;
  return card;
}

// --- Search tenders by keywords ---
function searchTenders(keywords) {
  if (!keywords || keywords.length === 0) return [];
  const results = [];
  for (const tender of MOCK_TENDERS) {
    const matched = keywords.filter(kw =>
      tender.keywords.some(tk => tk.includes(kw) || kw.includes(tk)) ||
      tender.title.toLowerCase().includes(kw)
    );
    if (matched.length > 0) {
      results.push({ tender, matchedKeywords: matched });
    }
  }
  return results.sort((a, b) => b.matchedKeywords.length - a.matchedKeywords.length);
}

// --- Menus ---
function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🔍 Найти тендеры" }, { text: "📋 Последние тендеры" }],
        [{ text: "🔑 Мои ключевые слова" }, { text: "➕ Добавить слово" }],
        [{ text: "⚙️ Фильтры" }],
        [{ text: "🎁 Получить доступ" }, { text: "📊 Мой статус" }],
        [{ text: "ℹ️ О боте" }],
      ],
      resize_keyboard: true,
    },
  };
}

async function getFilters(chatId) {
  return getUserFilters(chatId);
}

function parseDateSafe(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

function applyTenderFilters(items, filters) {
  if (!filters || Object.keys(filters).length === 0) return items;
  return items.filter(({ tender }) => {
    if (filters.minSum != null && Number(tender.amount || 0) < filters.minSum) return false;
    if (filters.maxSum != null && Number(tender.amount || 0) > filters.maxSum) return false;

    if (filters.deadlineDays != null) {
      const end = parseDateSafe(tender.deadline);
      if (!end) return false;
      const diffDays = (end.getTime() - Date.now()) / 86400000;
      if (diffDays < 0 || diffDays > filters.deadlineDays) return false;
    }

    if (filters.region) {
      const rg = String(filters.region).toLowerCase().trim();
      const hay = `${tender.title || ""} ${tender.customer || ""} ${tender.kato || ""}`.toLowerCase();
      if (!hay.includes(rg)) return false;
    }

    return true;
  });
}

async function handleFilters(chatId) {
  const f = await getFilters(chatId);
  userStates.set(chatId, { state: "waiting_filter_input" });
  await send(
    chatId,
    `*Текущие фильтры:*\n` +
      `• Регион: ${f.region || "не задан"}\n` +
      `• Бюджет: ${f.minSum ?? "-"} — ${f.maxSum ?? "-"} ₸\n` +
      `• Дедлайн: ${f.deadlineDays ?? "-"} дней\n\n` +
      `Отправьте одной строкой:\n` +
      `• \`регион: алматы\`\n` +
      `• \`бюджет: 100000-5000000\`\n` +
      `• \`дедлайн: 7\`\n` +
      `• \`сброс\``,
    mainMenu()
  );
}

async function handleFilterInput(chatId, text) {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();
  const f = { ...(await getFilters(chatId)) };

  if (lower === "сброс" || lower === "clear") {
    await clearUserFilters(chatId);
    userStates.delete(chatId);
    return send(chatId, `✅ Фильтры сброшены.`, mainMenu());
  }

  if (lower.startsWith("регион:")) {
    f.region = raw.split(":").slice(1).join(":").trim();
  } else if (lower.startsWith("бюджет:")) {
    const val = raw.split(":").slice(1).join(":").trim();
    const m = val.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) return send(chatId, `Формат бюджета: бюджет: 100000-5000000`, mainMenu());
    f.minSum = Number(m[1]);
    f.maxSum = Number(m[2]);
  } else if (lower.startsWith("дедлайн:")) {
    const val = Number(raw.split(":").slice(1).join(":").trim());
    if (!Number.isFinite(val) || val <= 0) return send(chatId, `Формат дедлайна: дедлайн: 7`, mainMenu());
    f.deadlineDays = Math.floor(val);
  } else {
    return send(chatId, `Не понял. Используйте: регион:, бюджет:, дедлайн: или сброс`, mainMenu());
  }

  await setUserFilters(chatId, f);
  userStates.delete(chatId);
  return send(
    chatId,
    `✅ Фильтр сохранён.\n` +
      `• Регион: ${f.region || "не задан"}\n` +
      `• Бюджет: ${f.minSum ?? "-"} — ${f.maxSum ?? "-"} ₸\n` +
      `• Дедлайн: ${f.deadlineDays ?? "-"} дней`,
    mainMenu()
  );
}

function rewardMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🎁 Получить доступ" }],
        [{ text: "📊 Мой статус" }, { text: "ℹ️ О боте" }],
      ],
      resize_keyboard: true,
    },
  };
}

function rewardInlineKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📢 Подписаться на канал", callback_data: "reward:channel" }],
        [{ text: "🎬 Задание TikTok", callback_data: "reward:social:tiktok" }],
        [{ text: "▶️ Задание YouTube", callback_data: "reward:social:youtube" }],
        [{ text: "👥 Пригласить друга", callback_data: "reward:referral" }],
        [{ text: "📊 Мой статус", callback_data: "reward:status" }],
      ],
    },
  };
}

// --- Access gate ---
function isAdminUser(chatId) {
  const adminId = ADMIN_ID();
  return (adminId && String(chatId) === String(adminId)) || UNLIMITED_IDS.includes(String(chatId));
}

async function checkAccess(chatId) {
  if (isAdminUser(chatId)) return { granted: true, access: { remaining_chars: 999999 } };
  if (await dbIsAdmin(chatId)) return { granted: true, access: { remaining_chars: 999999 } };
  const access = await getActiveAccess(chatId);
  if (access) return { granted: true, access };
  return { granted: false, access: null };
}

async function requireAccess(chatId, action) {
  const { granted, access } = await checkAccess(chatId);
  if (!granted) {
    await send(chatId,
      `🔒 *Доступ ограничен*\n\n` +
      `Выполните одно из заданий, чтобы получить доступ на 24 часа:\n`,
      rewardInlineKeyboard()
    );
    return null;
  }
  const cost = ACTION_COST[action];
  if (!cost) return access;
  if (isAdminUser(chatId) || await dbIsAdmin(chatId)) return access;
  if (access.remaining_chars < cost) {
    await send(chatId,
      `⚠️ Недостаточно символов (${access.remaining_chars}/${cost}).\n` +
      `Выполните задание для пополнения:`,
      rewardInlineKeyboard()
    );
    return null;
  }
  return access;
}

// --- Handlers ---
async function handleStart(chatId, from, startParam) {
  userStates.delete(chatId);
  await upsertUser(chatId, from.username, from.first_name);

  // Handle referral deep link
  if (startParam && startParam.startsWith('ref_')) {
    const referrerId = parseInt(startParam.slice(4), 10);
    if (referrerId && referrerId !== chatId) {
      const recorded = await recordReferral(referrerId, chatId);
      if (recorded) {
        const refCount = await getReferralCount(referrerId);
        if (refCount <= 10) {
          await grantReferralAccess(referrerId, chatId);
          await send(referrerId,
            `🎉 Ваш друг присоединился! Вы получили +24ч доступа.\n` +
            `Рефералов за 24ч: ${refCount}/10`
          ).catch(() => {});
        }
      }
    }
  }

  const { granted } = await checkAccess(chatId);
  const menu = granted ? mainMenu() : rewardMenu();

  await send(chatId,
    `*Бот мониторинга госзакупок* 🏛\n\n` +
    `Отслеживаю тендеры на goszakup.gov.kz по вашим ключевым словам.\n\n` +
    `*Что умею:*\n` +
    `• Поиск тендеров по ключевым словам\n` +
    `• Мониторинг новых закупок\n` +
    `• Уведомления о подходящих тендерах\n\n` +
    (granted
      ? `*Начните с добавления ключевых слов* — нажмите "➕ Добавить слово"`
      : `🎁 *Выполните задание* для получения бесплатного доступа:`),
    granted ? menu : { ...menu, ...rewardInlineKeyboard() }
  );

  await notifyAdmin(`Новый пользователь тендер-бота: @${sanitize(from.username || "no_username", 50)} (${sanitize(from.first_name || "", 50)})`);
}

async function handleMyKeywords(chatId) {
  userStates.delete(chatId);
  const access = await requireAccess(chatId, 'keywords');
  if (!access) return;

  const kws = await getKeywords(chatId);
  if (kws.length === 0) {
    return send(chatId,
      `У вас пока нет ключевых слов.\n\nНажмите "➕ Добавить слово" чтобы начать отслеживать тендеры.`,
      mainMenu()
    );
  }

  let text = `*Ваши ключевые слова:*\n\n`;
  const buttons = [];
  for (const kw of kws) {
    text += `• ${kw}\n`;
    buttons.push([{ text: `❌ Удалить "${kw}"`, callback_data: `del:${kw}` }]);
  }
  text += `\nНажмите на кнопку чтобы удалить слово, или добавьте новое.`;

  await deductChars(access.id, ACTION_COST.keywords, 'keywords', chatId);
  await send(chatId, text, { reply_markup: { inline_keyboard: buttons } });
}

async function handleAddKeyword(chatId) {
  const access = await requireAccess(chatId, 'add_keyword');
  if (!access) return;
  userStates.set(chatId, { state: "waiting_keyword", accessId: access.id });
  await send(chatId,
    `Введите ключевое слово для мониторинга тендеров.\n\n` +
    `*Примеры:* IT, разработка, строительство, поставка, боты\n\n` +
    `_Отправьте слово текстом:_`
  );
}

async function handleKeywordInput(chatId, text) {
  const stateData = userStates.get(chatId);
  userStates.delete(chatId);
  const keyword = text.toLowerCase().trim().slice(0, 50);

  if (keyword.length < 2) {
    return send(chatId, `Слово слишком короткое. Минимум 2 символа.`, mainMenu());
  }

  const added = await addKeywordToList(chatId, keyword);
  if (!added) {
    return send(chatId, `Слово "${sanitize(keyword)}" уже есть в вашем списке.`, mainMenu());
  }

  if (stateData?.accessId) {
    await deductChars(stateData.accessId, ACTION_COST.add_keyword, 'add_keyword', chatId);
  }

  const kws = await getKeywords(chatId);
  await send(chatId,
    `Добавлено: *${sanitize(keyword)}*\n\n` +
    `Ваши слова (${kws.length}): ${kws.join(", ")}\n\n` +
    `Нажмите "🔍 Найти тендеры" чтобы найти подходящие закупки.`,
    mainMenu()
  );
}

async function handleSearch(chatId) {
  userStates.delete(chatId);
  const access = await requireAccess(chatId, 'search');
  if (!access) return;

  const kws = await getKeywords(chatId);
  if (kws.length === 0) {
    return send(chatId,
      `Сначала добавьте ключевые слова.\n\nНажмите "➕ Добавить слово"`,
      mainMenu()
    );
  }

  const results = searchTenders(kws);
  let liveResults = [];
  let liveFailed = false;
  if (LIVE_MODE) {
    if (!GQL_TOKEN) {
      return send(chatId, `❌ Live-режим включён, но не настроен TENDER_GQL_TOKEN. Обратитесь к администратору.`, mainMenu());
    }
    try {
      liveResults = await searchLiveByKeywords(kws, 10);
    } catch (e) {
      liveFailed = true;
      liveResults = [];
    }
  }
  if (LIVE_MODE && liveFailed) {
    return send(chatId, `❌ Временная ошибка live API госзакуп. Повторите через 1-2 минуты.`, mainMenu());
  }
  const finalResults = applyTenderFilters(LIVE_MODE ? liveResults : results, await getFilters(chatId));
  if (finalResults.length === 0) {
    await deductChars(access.id, ACTION_COST.search, 'search', chatId);
    return send(chatId,
      `По вашим ключевым словам (${kws.join(", ")}) тендеров не найдено.\n\n` +
      `Попробуйте добавить другие слова.`,
      mainMenu()
    );
  }

  await deductChars(access.id, ACTION_COST.search, 'search', chatId);
  const remaining = await getActiveAccess(chatId);

  await send(chatId,
    `*Найдено ${finalResults.length} тендеров* по словам: ${kws.join(", ")}\n` +
    (remaining ? `_Осталось символов: ${remaining.remaining_chars}_` : ''),
    mainMenu()
  );

  for (const { tender, matchedKeywords } of finalResults.slice(0, 5)) {
    await send(chatId, formatTender(tender, matchedKeywords));
  }

  if (finalResults.length > 5) {
    await send(chatId, `...и ещё ${finalResults.length - 5} тендеров. В полной версии — все результаты.`, mainMenu());
  }
}

async function handleLatest(chatId) {
  userStates.delete(chatId);
  const access = await requireAccess(chatId, 'latest');
  if (!access) return;

  await deductChars(access.id, ACTION_COST.latest, 'latest', chatId);
  await send(chatId, `*Последние тендеры на goszakup.gov.kz:*\n`, mainMenu());

  let latest = [];
  if (LIVE_MODE) {
    if (!GQL_TOKEN) {
      return send(chatId, `❌ Live-режим включён, но не настроен TENDER_GQL_TOKEN. Обратитесь к администратору.`, mainMenu());
    }
    try {
      latest = await fetchLatestLive(5);
    } catch (e) {
      return send(chatId, `❌ Временная ошибка live API госзакуп. Повторите через 1-2 минуты.`, mainMenu());
    }
  } else {
    latest = MOCK_TENDERS.slice(0, 5);
  }
  const filteredLatest = applyTenderFilters(latest.map(t => ({ tender: t, matchedKeywords: [] })), await getFilters(chatId)).map(r => r.tender);
  for (const tender of filteredLatest) {
    await send(chatId, formatTender(tender));
  }

  const remaining = await getActiveAccess(chatId);
  await send(chatId,
    `_Показаны ${filteredLatest.length} тендеров._\n` +
    (remaining ? `_Осталось символов: ${remaining.remaining_chars}_\n\n` : '\n') +
    `Добавьте ключевые слова для персонального мониторинга.`,
    mainMenu()
  );
}

async function handleAbout(chatId) {
  userStates.delete(chatId);
  const dataLine = LIVE_MODE ? "Данные: goszakup.gov.kz (GraphQL API)" : "Данные: демо (mock)";
  const demoNote = LIVE_MODE ? "" : `_Это демо-версия с примерами данных._\n\n`;
  await send(chatId,
    `*О боте мониторинга госзакупок*\n\n` +
    `${dataLine}\n` +
    `Обновление: каждые 30 минут\n\n` +
    `*Полная версия включает:*\n` +
    `• Автоматические уведомления о новых тендерах\n` +
    `• Фильтры по сумме и региону\n` +
    `• Аналитика по заказчикам\n` +
    `• Экспорт в Excel\n` +
    `• История тендеров\n\n` +
    `${demoNote}` +
    `По вопросам: @monkeybot\\_support`,
    mainMenu()
  );
}

async function handleDeleteKeyword(chatId, keyword) {
  const removed = await removeKeywordFromList(chatId, keyword);
  if (removed) {
    await send(chatId, `Удалено: "${sanitize(keyword)}"`, mainMenu());
  } else {
    await send(chatId, `Слово не найдено.`, mainMenu());
  }
}

// --- Reward handlers ---
async function handleRewardMenu(chatId) {
  userStates.delete(chatId);
  const access = await getActiveAccess(chatId);
  if (access) {
    const hours = Math.max(0, Math.round((new Date(access.end_time) - Date.now()) / 3600000));
    await send(chatId,
      `✅ У вас есть активный доступ!\n\n` +
      `⏱ Осталось: ~${hours}ч\n` +
      `📝 Символов: ${access.remaining_chars}\n\n` +
      `Вы можете заработать ещё:`,
      rewardInlineKeyboard()
    );
  } else {
    await send(chatId,
      `🎁 *Получить бесплатный доступ* (24ч + 1000 символов):\n\n` +
      `Выберите задание:`,
      rewardInlineKeyboard()
    );
  }
}

async function handleRewardStatus(chatId) {
  if (isAdminUser(chatId) || await dbIsAdmin(chatId)) {
    await send(chatId,
      `📊 *Ваш статус:*\n\n` +
      `✅ Доступ активен (админ)\n` +
      `⏱ Без ограничений\n` +
      `📝 Символов: ∞`,
      mainMenu()
    );
    return;
  }
  const access = await getActiveAccess(chatId);
  if (access) {
    const hours = Math.max(0, Math.round((new Date(access.end_time) - Date.now()) / 3600000));
    await send(chatId,
      `📊 *Ваш статус:*\n\n` +
      `✅ Доступ активен\n` +
      `⏱ Осталось: ~${hours}ч\n` +
      `📝 Символов: ${access.remaining_chars}\n` +
      `📦 Источник: ${access.source}`,
      mainMenu()
    );
  } else {
    await send(chatId,
      `📊 *Ваш статус:*\n\n` +
      `❌ Доступ не активен\n\n` +
      `Выполните задание для получения доступа:`,
      rewardInlineKeyboard()
    );
  }
}

async function handleChannelReward(chatId) {
  const channels = await getChannels();
  if (channels.length === 0) {
    await send(chatId, `Сейчас нет каналов для подписки. Попробуйте другое задание.`);
    return;
  }

  const buttons = channels.map(c => ([
    { text: `📢 @${c.channel_username}`, url: `https://t.me/${c.channel_username}` }
  ]));
  buttons.push([{ text: "✅ Проверить подписку", callback_data: "reward:check_channels" }]);

  await send(chatId,
    `📢 *Подпишитесь на каналы* и получите доступ:\n`,
    { reply_markup: { inline_keyboard: buttons } }
  );
}

async function handleCheckChannels(chatId) {
  const channels = await getChannels();
  if (channels.length === 0) {
    await grantAccess(chatId, 'channel');
    await send(chatId, `✅ Доступ получен! 24 часа + 1000 символов.`, mainMenu());
    return;
  }

  let allSubscribed = true;
  for (const ch of channels) {
    try {
      const result = await tg("getChatMember", {
        chat_id: `@${ch.channel_username}`,
        user_id: chatId
      });
      const status = result.result?.status;
      if (!status || status === 'left' || status === 'kicked') {
        allSubscribed = false;
        break;
      }
    } catch {
      allSubscribed = false;
      break;
    }
  }

  if (allSubscribed) {
    await grantAccess(chatId, 'channel');
    await send(chatId, `✅ Подписка подтверждена! Доступ получен: 24 часа + 1000 символов.`, mainMenu());
  } else {
    await send(chatId,
      `❌ Вы не подписаны на все каналы. Подпишитесь и нажмите "Проверить" снова.`
    );
  }
}

async function handleSocialReward(chatId, platform) {
  const labels = { tiktok: 'TikTok', youtube: 'YouTube' };
  const links = {
    tiktok: 'https://www.tiktok.com/@monkeybot',
    youtube: 'https://www.youtube.com/@monkeybot'
  };

  const result = await claimSocialAction(chatId, platform);
  if (result.duplicate) {
    const action = result.action;
    if (action.status === 'cooldown') {
      const timeLeft = Math.max(0, Math.round((new Date(action.eligible_at) - Date.now()) / 60000));
      await send(chatId,
        `⏳ Ваша заявка на проверке. Осталось ~${timeLeft} мин.\n` +
        `Доступ будет выдан автоматически.`
      );
    } else {
      await send(chatId, `У вас уже есть заявка на ${labels[platform]}. Попробуйте другое задание.`);
    }
    return;
  }

  await send(chatId,
    `🎬 *Задание ${labels[platform]}:*\n\n` +
    `1. Перейдите по ссылке: ${links[platform]}\n` +
    `2. Подпишитесь и поставьте лайк\n` +
    `3. Нажмите кнопку ниже\n\n` +
    `_Доступ будет выдан через 5 минут автоматически._`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: `🔗 Перейти в ${labels[platform]}`, url: links[platform] }],
          [{ text: "✅ Я выполнил", callback_data: `reward:social_done:${platform}` }],
        ],
      },
    }
  );
}

async function handleSocialDone(chatId, platform) {
  const labels = { tiktok: 'TikTok', youtube: 'YouTube' };
  await send(chatId,
    `⏳ Принято! Доступ к ${labels[platform]} будет проверен через 5 минут.\n` +
    `Отправьте любое сообщение после этого для активации.`
  );
  await notifyAdmin(
    `🔔 Социальное задание: пользователь ${chatId} заявил выполнение ${platform}. Spot-check при необходимости.`
  );
}

async function handleReferralReward(chatId) {
  const botUsername = BOT_USERNAME();
  const link = `https://t.me/${botUsername}?start=ref_${chatId}`;
  const refCount = await getReferralCount(chatId);

  await send(chatId,
    `👥 *Пригласите друга* и получите +24ч доступа!\n\n` +
    `Ваша ссылка:\n\`${link}\`\n\n` +
    `Отправьте другу эту ссылку. Когда он запустит бота, вы оба получите доступ.\n\n` +
    `Приглашено за 24ч: ${refCount}/10`,
    mainMenu()
  );
}

// --- Admin handlers ---
async function handleAdmin(chatId, text) {
  if (!isAdminUser(chatId) && !(await dbIsAdmin(chatId))) {
    return send(chatId, `❌ Нет доступа.`);
  }

  const parts = text.replace(/^\/admin\s*/, '').trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (!cmd || cmd === 'help') {
    return send(chatId,
      `*Админ-панель тендер-бота:*\n\n` +
      `/admin stats — статистика\n` +
      `/admin channels — список каналов\n` +
      `/admin channel add @name — добавить канал\n` +
      `/admin channel del @name — удалить канал\n` +
      `/admin pending — соц.действия на проверке\n` +
      `/admin grant <user\\_id> — выдать доступ`
    );
  }

  if (cmd === 'stats') {
    const s = await getStats();
    return send(chatId,
      `📊 *Статистика:*\n\n` +
      `👥 Всего пользователей: ${s.totalUsers}\n` +
      `✅ С активным доступом: ${s.activeUsers}\n` +
      `🔗 Рефералов за 24ч: ${s.referrals24h}\n` +
      `🎬 Соц.действий за 24ч: ${s.socialActions24h}\n` +
      `📢 Активных каналов: ${s.activeChannels}`
    );
  }

  if (cmd === 'channels') {
    const channels = await getChannels();
    if (channels.length === 0) {
      return send(chatId, `Нет активных каналов.\n\nДобавьте: /admin channel add @username`);
    }
    const list = channels.map(c => `• @${c.channel_username}`).join('\n');
    return send(chatId, `*Каналы для подписки:*\n\n${list}\n\nУдалить: /admin channel del @username`);
  }

  if (cmd === 'channel') {
    const action = parts[1]?.toLowerCase();
    const name = parts[2];
    if (!name) return send(chatId, `Укажите @username канала.`);
    if (action === 'add') {
      await addChannel(name);
      return send(chatId, `✅ Канал ${sanitize(name)} добавлен.`);
    }
    if (action === 'del') {
      await removeChannel(name);
      return send(chatId, `🗑 Канал ${sanitize(name)} удалён.`);
    }
    return send(chatId, `Используйте: /admin channel add|del @name`);
  }

  if (cmd === 'pending') {
    const actions = await getPendingSocialActions();
    if (actions.length === 0) {
      return send(chatId, `Нет действий на проверке.`);
    }
    for (const a of actions) {
      await send(chatId,
        `${a.status === 'cooldown' ? '⏳' : '✅'} *${a.platform}* — @${sanitize(a.username || 'нет', 30)} (${a.telegram_id})\n` +
        `Статус: ${a.status} | ${new Date(a.created_at).toLocaleString('ru')}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Одобрить", callback_data: `admin:approve:${a.id}` },
                { text: "❌ Отклонить", callback_data: `admin:reject:${a.id}` },
              ],
            ],
          },
        }
      );
    }
    return;
  }

  if (cmd === 'grant') {
    const userId = parseInt(parts[1], 10);
    if (!userId) return send(chatId, `Укажите user\\_id: /admin grant 123456789`);
    await grantAccess(userId, 'admin_grant');
    return send(chatId, `✅ Доступ выдан пользователю ${userId} (24ч + 1000 символов).`);
  }

  return send(chatId, `Неизвестная команда. /admin help`);
}

// --- Webhook auth ---
function verifyWebhook(req) {
  const secret = (process.env.TENDER_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || '').trim();
  if (!secret) return true;
  return req.headers["x-telegram-bot-api-secret-token"] === secret;
}

// --- Main handler ---
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!verifyWebhook(req)) return res.status(401).json({ error: "Unauthorized" });

  const update = req.body;
  if (!update) return res.status(200).json({ ok: true });

  try {
    await ensureSchema();

    // Handle callback queries
    if (update.callback_query) {
      const q = update.callback_query;
      const chatId = q.message?.chat?.id;
      if (!chatId) return res.status(200).json({ ok: true });

      if (!checkRateLimit(chatId)) {
        await answer(q.id, "Слишком много запросов, подождите.");
        return res.status(200).json({ ok: true });
      }

      await answer(q.id);
      const d = q.data;

      await upsertUser(chatId, q.from?.username, q.from?.first_name);
      await resolveCooldowns(chatId);

      if (d.startsWith("del:")) {
        await handleDeleteKeyword(chatId, d.slice(4));
      } else if (d === "reward:channel") {
        await handleChannelReward(chatId);
      } else if (d === "reward:check_channels") {
        await handleCheckChannels(chatId);
      } else if (d === "reward:social:tiktok") {
        await handleSocialReward(chatId, 'tiktok');
      } else if (d === "reward:social:youtube") {
        await handleSocialReward(chatId, 'youtube');
      } else if (d.startsWith("reward:social_done:")) {
        await handleSocialDone(chatId, d.split(':')[2]);
      } else if (d === "reward:referral") {
        await handleReferralReward(chatId);
      } else if (d === "reward:status") {
        await handleRewardStatus(chatId);
      } else if (d.startsWith("admin:approve:")) {
        if (isAdminUser(chatId) || await dbIsAdmin(chatId)) {
          const actionId = parseInt(d.split(':')[2], 10);
          const result = await approveSocialAction(actionId);
          if (result) {
            await editMessage(chatId, q.message.message_id,
              `✅ Одобрено: ${result.platform} для ${result.telegram_id}`);
          }
        }
      } else if (d.startsWith("admin:reject:")) {
        if (isAdminUser(chatId) || await dbIsAdmin(chatId)) {
          const actionId = parseInt(d.split(':')[2], 10);
          await rejectSocialAction(actionId);
          await editMessage(chatId, q.message.message_id, `❌ Отклонено.`);
        }
      }

      return res.status(200).json({ ok: true });
    }

    // Handle messages
    const msg = update.message;
    if (!msg?.text) return res.status(200).json({ ok: true });

    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const from = msg.from || {};

    if (!checkRateLimit(chatId)) {
      return res.status(200).json({ ok: true });
    }

    await upsertUser(chatId, from.username, from.first_name);
    await resolveCooldowns(chatId);

    // Check if waiting for keyword input
    const currentState = userStates.get(chatId);
    if (currentState?.state === "waiting_keyword" && !text.startsWith("/")) {
      await handleKeywordInput(chatId, text);
      return res.status(200).json({ ok: true });
    }
    if (currentState?.state === "waiting_filter_input" && !text.startsWith("/")) {
      await handleFilterInput(chatId, text);
      return res.status(200).json({ ok: true });
    }
    // Legacy state format support
    if (currentState === "waiting_keyword" && !text.startsWith("/")) {
      await handleKeywordInput(chatId, text);
      return res.status(200).json({ ok: true });
    }

    // Admin waiting for input
    if (currentState?.state === "waiting_admin_input" && !text.startsWith("/")) {
      userStates.delete(chatId);
      return res.status(200).json({ ok: true });
    }

    // Extract /start parameter
    const startMatch = text.match(/^\/start\s+(.+)$/);

    // Commands & menu buttons
    if (text === "/start" || startMatch) {
      await handleStart(chatId, from, startMatch?.[1]);
    } else if (text.startsWith("/admin")) {
      await handleAdmin(chatId, text);
    } else if (text === "🔍 Найти тендеры" || text === "/search") {
      await handleSearch(chatId);
    } else if (text === "📋 Последние тендеры" || text === "/latest") {
      await handleLatest(chatId);
    } else if (text === "🔑 Мои ключевые слова" || text === "/keywords") {
      await handleMyKeywords(chatId);
    } else if (text === "➕ Добавить слово" || text === "/add") {
      await handleAddKeyword(chatId);
    } else if (text === "⚙️ Фильтры" || text === "/filters") {
      await handleFilters(chatId);
    } else if (text === "🎁 Получить доступ" || text === "/reward") {
      await handleRewardMenu(chatId);
    } else if (text === "📊 Мой статус" || text === "/status") {
      await handleRewardStatus(chatId);
    } else if (text === "ℹ️ О боте" || text === "/about") {
      await handleAbout(chatId);
    } else {
      // Treat any unknown text as keyword if short enough and user has access
      if (text.length <= 50 && !text.startsWith("/")) {
        const { granted } = await checkAccess(chatId);
        if (granted) {
          await handleKeywordInput(chatId, text);
        } else {
          await send(chatId,
            `🔒 Выполните задание для получения доступа:`,
            rewardInlineKeyboard()
          );
        }
      } else {
        await send(chatId, `Используйте кнопки меню или команды:\n/search — поиск тендеров\n/latest — последние тендеры\n/reward — получить доступ\n/status — мой статус`, mainMenu());
      }
    }
  } catch (err) {
    console.error("Tender demo webhook error:", err);
  }

  return res.status(200).json({ ok: true });
}

export const config = { maxDuration: 45 };
