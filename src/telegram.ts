import type { Env, LinkRecord } from "./database";
import { asLink, first, logActivity, query, run } from "./database";
import { createLink, deleteLink, ensureDefaultLink, findLink, linkAllowed, updateLink } from "./links";
import {
  DEFAULT_ALPN_BY_PROTOCOL,
  DEFAULT_FINGERPRINT,
  DEFAULT_PORT,
  DEFAULT_PROTOCOL,
  FINGERPRINTS,
  PROTOCOLS,
  escapeHtml,
  formatBytes,
  getPublicOrigin,
  parseInteger,
  parseSizeToBytes,
  parseSpeedToBytes,
  randomToken,
} from "./utils";
import { deleteSubscription, findSubscription, listSubscriptions } from "./subscriptions";

const PAGE_SIZE = 6;
const WIZARD_TTL = 15 * 60;

type WizardState = {
  action: "wizard" | "newsub" | "subaddlink";
  step: string;
  data: Record<string, unknown>;
  linkUid?: string;
  subId?: string;
};

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat?: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat?: { id: number } };
  };
}

function adminIds(env: Env): Set<number> {
  return new Set(
    String(env.TELEGRAM_ADMIN_IDS || "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  );
}

function stateKey(chatId: number): string {
  return `telegram:wizard:${chatId}`;
}

async function loadState(env: Env, chatId: number): Promise<WizardState | null> {
  const value = await env.TEMP.get(stateKey(chatId));
  if (!value) return null;
  try {
    return JSON.parse(value) as WizardState;
  } catch {
    await env.TEMP.delete(stateKey(chatId));
    return null;
  }
}

async function saveState(env: Env, chatId: number, state: WizardState): Promise<void> {
  await env.TEMP.put(stateKey(chatId), JSON.stringify(state), { expirationTtl: WIZARD_TTL });
}

async function clearState(env: Env, chatId: number): Promise<void> {
  await env.TEMP.delete(stateKey(chatId));
}

async function telegramCall(env: Env, method: string, payload: Record<string, unknown>): Promise<any> {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => null) as { ok?: boolean } | null;
  if (!response.ok || !data?.ok) console.error(`Telegram ${method} failed`, data);
  return data;
}

async function sendMessage(env: Env, chatId: number, text: string, replyMarkup?: unknown): Promise<void> {
  await telegramCall(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function editMessage(env: Env, chatId: number, messageId: number, text: string, replyMarkup?: unknown): Promise<void> {
  const response = await telegramCall(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  if (!response?.ok) await sendMessage(env, chatId, text, replyMarkup);
}

async function answerCallback(env: Env, callbackId: string, text = ""): Promise<void> {
  await telegramCall(env, "answerCallbackQuery", { callback_query_id: callbackId, text });
}

function keyboard(rows: Array<Array<{ text: string; callback_data: string }>>) {
  return { inline_keyboard: rows };
}

function mainKeyboard() {
  return keyboard([
    [{ text: "📋 لیست کانفیگ‌ها", callback_data: "list:0" }],
    [{ text: "➕ ساخت کانفیگ جدید", callback_data: "newcfg" }],
    [{ text: "🗂 گروه‌های ساب", callback_data: "subs:0" }],
    [{ text: "🔄 رفرش", callback_data: "menu" }],
  ]);
}

function listKeyboard(links: LinkRecord[], page: number) {
  const start = page * PAGE_SIZE;
  const rows = links.slice(start, start + PAGE_SIZE).map((link) => ([{
    text: `${linkAllowed(link) ? "🟢" : "🔴"} ${link.label.slice(0, 28)}`,
    callback_data: `view:${link.uuid}`,
  }]));
  const navigation: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) navigation.push({ text: "◀ قبلی", callback_data: `list:${page - 1}` });
  if (start + PAGE_SIZE < links.length) navigation.push({ text: "بعدی ▶", callback_data: `list:${page + 1}` });
  if (navigation.length) rows.push(navigation);
  rows.push([{ text: "➕ ساخت کانفیگ جدید", callback_data: "newcfg" }]);
  rows.push([{ text: "⬅ منوی اصلی", callback_data: "menu" }]);
  return keyboard(rows);
}

function detailKeyboard(uuid: string, active: boolean) {
  return keyboard([
    [{ text: "🔗 نمایش لینک اتصال", callback_data: `link:${uuid}` }],
    [{ text: active ? "⛔ غیرفعال‌سازی" : "✅ فعال‌سازی", callback_data: `toggle:${uuid}` }],
    [{ text: "🗑 حذف کانفیگ", callback_data: `del:${uuid}` }],
    [{ text: "⬅ بازگشت به لیست", callback_data: "list:0" }],
  ]);
}

function wizardCancelKeyboard() {
  return keyboard([[{ text: "❌ انصراف", callback_data: "w:cancel" }]]);
}

function wizardSkipKeyboard(step: string, label: string) {
  return keyboard([
    [{ text: label, callback_data: `w:skip:${step}` }],
    [{ text: "❌ انصراف", callback_data: "w:cancel" }],
  ]);
}

function wizardProtocolKeyboard() {
  return keyboard([
    ...PROTOCOLS.filter((protocol) => protocol !== "xhttp-stream-one").map((protocol) => ([{
      text: protocol === "vless-ws" ? "VLESS + WebSocket" : protocol,
      callback_data: `w:proto:${protocol}`,
    }])),
    [{ text: "❌ انصراف", callback_data: "w:cancel" }],
  ]);
}

function wizardFingerprintKeyboard() {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < FINGERPRINTS.length; i += 3) {
    rows.push(FINGERPRINTS.slice(i, i + 3).map((fingerprint) => ({
      text: fingerprint,
      callback_data: `w:fp:${fingerprint}`,
    })));
  }
  rows.push([{ text: "❌ انصراف", callback_data: "w:cancel" }]);
  return keyboard(rows);
}

function wizardPrompt(step: string): string {
  if (step === "label") return "✏️ اسم/برچسب کانفیگ را ارسال کنید:";
  if (step === "protocol") return "🌐 پروتکل را انتخاب کنید:";
  if (step === "fingerprint") return "🖐 Fingerprint را انتخاب کنید:";
  if (step === "alpn") return "🔤 مقدار ALPN را ارسال کنید یا برای پیش‌فرض، دکمه را بزنید:";
  if (step === "port") return "🔌 پورت Cloudflare ثابت است: 443";
  if (step === "volume") return "📦 محدودیت حجم را مثل <code>10GB</code> یا <code>500MB</code> ارسال کنید:";
  if (step === "speed") return "🚀 محدودیت سرعت را مثل <code>20</code> یا <code>20Mbit</code> ارسال کنید:";
  if (step === "iplimit") return "👥 حداکثر تعداد IP هم‌زمان را ارسال کنید:";
  if (step === "days") return "📅 تعداد روزهای اعتبار را ارسال کنید:";
  return "";
}

function wizardSummary(data: Record<string, unknown>): string {
  const protocol = String(data.protocol || DEFAULT_PROTOCOL);
  const limit = Number(data.limit_bytes || 0) ? formatBytes(Number(data.limit_bytes)) : "نامحدود";
  const speed = Number(data.speed_limit_bytes || 0)
    ? `${(Number(data.speed_limit_bytes) * 8 / 1024 / 1024).toFixed(1)} Mbps`
    : "نامحدود";
  const ipLimit = Number(data.ip_limit || 0) || "نامحدود";
  const days = Number(data.expires_days || 0) ? `${data.expires_days} روز` : "بدون انقضا";
  return [
    "🧩 خلاصه کانفیگ جدید:",
    "",
    `برچسب: <b>${escapeHtml(data.label || "کانفیگ جدید")}</b>`,
    `پروتکل: ${escapeHtml(protocol)}`,
    `Fingerprint: ${escapeHtml(data.fingerprint || DEFAULT_FINGERPRINT)}`,
    `ALPN: ${escapeHtml(data.alpn || DEFAULT_ALPN_BY_PROTOCOL[protocol] || "http/1.1")}`,
    "پورت: 443",
    `حجم: ${limit}`,
    `سرعت: ${speed}`,
    `IP هم‌زمان: ${ipLimit}`,
    `انقضا: ${days}`,
  ].join("\n");
}

function formatLink(link: LinkRecord): string {
  const status = linkAllowed(link) ? "🟢 فعال" : "🔴 غیرفعال/منقضی";
  const limit = link.limit_bytes ? formatBytes(link.limit_bytes) : "نامحدود";
  const speed = link.speed_limit_bytes
    ? `${(link.speed_limit_bytes * 8 / 1024 / 1024).toFixed(1)} Mbps`
    : "نامحدود";
  return [
    `<b>${escapeHtml(link.label)}</b>`,
    `وضعیت: ${status}`,
    `مصرف: ${formatBytes(link.used_bytes)} / ${limit}`,
    `سرعت: ${speed}`,
    `محدودیت IP: ${link.ip_limit || "نامحدود"}`,
    `پروتکل: ${escapeHtml(link.protocol)}`,
    `پورت: 443`,
    `UUID: <code>${link.uuid}</code>`,
  ].join("\n");
}

function parseVolume(value: string): number | null {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(GB|MB|KB)?$/i);
  if (!match) return null;
  return parseSizeToBytes(Number(match[1]), match[2] || "GB");
}

function parseSpeed(value: string): number | null {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(MBIT|MBPS|MB|KB)?$/i);
  if (!match) return null;
  return parseSpeedToBytes(Number(match[1]), match[2] || "MBIT");
}

async function getTelegramLinks(env: Env): Promise<LinkRecord[]> {
  await ensureDefaultLink(env);
  const rows = await query<Record<string, unknown>>(env, "SELECT * FROM links ORDER BY created_at DESC");
  return rows.map(asLink);
}

async function createTelegramGroup(env: Env, name: string): Promise<string> {
  const subId = crypto.randomUUID();
  const uuidKey = randomToken(16);
  const timestamp = new Date().toISOString();
  await run(
    env,
    `INSERT INTO subscriptions (sub_id, name, description, password_hash, uuid_key, created_at, updated_at)
     VALUES (?, ?, '', NULL, ?, ?, ?)`,
    subId,
    name.slice(0, 60),
    uuidKey,
    timestamp,
    timestamp,
  );
  await logActivity(env, "sub", `subscription group created from Telegram: ${name}`, "ok");
  return subId;
}

async function handleMessage(env: Env, request: Request, message: NonNullable<TelegramUpdate["message"]>): Promise<void> {
  const chatId = message.chat?.id;
  if (!chatId) return;
  const text = String(message.text || "").trim();
  if (!adminIds(env).has(chatId)) {
    await sendMessage(env, chatId, "⛔ شما اجازه دسترسی به این ربات را ندارید.");
    return;
  }
  if (text === "/start" || text === "/menu") {
    await clearState(env, chatId);
    await sendMessage(env, chatId, "👋 ربات مدیریت Gateway آماده است.", mainKeyboard());
    return;
  }
  if (text === "/cancel") {
    await clearState(env, chatId);
    await sendMessage(env, chatId, "لغو شد.", mainKeyboard());
    return;
  }

  const state = await loadState(env, chatId);
  if (!state || !text) {
    await sendMessage(env, chatId, "از دکمه‌های زیر استفاده کنید:", mainKeyboard());
    return;
  }

  if (state.action === "newsub" && state.step === "name") {
    const subId = await createTelegramGroup(env, text);
    await clearState(env, chatId);
    await sendMessage(env, chatId, `✅ گروه «${escapeHtml(text.slice(0, 60))}» ساخته شد.\nID: <code>${subId}</code>`, mainKeyboard());
    return;
  }

  if (state.action === "subaddlink" && state.step === "link") {
    const link = await findLink(env, text);
    if (!link) {
      await sendMessage(env, chatId, "UUID کانفیگ پیدا نشد.", wizardCancelKeyboard());
      return;
    }
    await run(env, "UPDATE links SET sub_id = ? WHERE uuid = ?", state.subId || null, text);
    await logActivity(env, "link", `link assigned to subscription from Telegram: ${link.label}`, "info", { sub_id: state.subId || null });
    await clearState(env, chatId);
    await sendMessage(env, chatId, `✅ کانفیگ «${escapeHtml(link.label)}» به گروه اضافه شد.`, mainKeyboard());
    return;
  }

  if (state.action !== "wizard") {
    await sendMessage(env, chatId, "این عملیات منقضی شده است.", mainKeyboard());
    return;
  }

  const data = state.data;
  if (state.step === "label") {
    data.label = text.slice(0, 60);
    state.step = "protocol";
    await saveState(env, chatId, state);
    await sendMessage(env, chatId, wizardPrompt("protocol"), wizardProtocolKeyboard());
    return;
  }
  if (state.step === "alpn") {
    data.alpn = text.slice(0, 100);
    state.step = "port";
    await saveState(env, chatId, state);
    await sendMessage(env, chatId, wizardPrompt("port"), wizardSkipKeyboard("port", "⏭ پورت 443"));
    return;
  }
  if (state.step === "port") {
    if (Number(text) !== 443) {
      await sendMessage(env, chatId, "در Cloudflare فقط پورت 443 استفاده می‌شود.", wizardSkipKeyboard("port", "⏭ پورت 443"));
      return;
    }
    data.port = 443;
    state.step = "volume";
    await saveState(env, chatId, state);
    await sendMessage(env, chatId, wizardPrompt("volume"), wizardSkipKeyboard("volume", "♾ نامحدود"));
    return;
  }
  if (state.step === "volume") {
    const value = parseVolume(text);
    if (value === null) {
      await sendMessage(env, chatId, "فرمت حجم نامعتبر است.", wizardSkipKeyboard("volume", "♾ نامحدود"));
      return;
    }
    data.limit_bytes = value;
    state.step = "speed";
    await saveState(env, chatId, state);
    await sendMessage(env, chatId, wizardPrompt("speed"), wizardSkipKeyboard("speed", "♾ نامحدود"));
    return;
  }
  if (state.step === "speed") {
    const value = parseSpeed(text);
    if (value === null) {
      await sendMessage(env, chatId, "فرمت سرعت نامعتبر است.", wizardSkipKeyboard("speed", "♾ نامحدود"));
      return;
    }
    data.speed_limit_bytes = value;
    state.step = "iplimit";
    await saveState(env, chatId, state);
    await sendMessage(env, chatId, wizardPrompt("iplimit"), wizardSkipKeyboard("iplimit", "♾ نامحدود"));
    return;
  }
  if (state.step === "iplimit" || state.step === "days") {
    const value = parseInteger(text, -1);
    if (value < 0) {
      await sendMessage(env, chatId, "یک عدد صحیح نامعتبر است.", wizardSkipKeyboard(state.step, "♾ نامحدود"));
      return;
    }
    if (state.step === "iplimit") {
      data.ip_limit = value;
      state.step = "days";
      await saveState(env, chatId, state);
      await sendMessage(env, chatId, wizardPrompt("days"), wizardSkipKeyboard("days", "♾ بدون انقضا"));
    } else {
      data.expires_days = value;
      state.step = "confirm";
      await saveState(env, chatId, state);
      await sendMessage(env, chatId, wizardSummary(data), keyboard([
        [{ text: "✅ ساخت کانفیگ", callback_data: "w:confirm" }],
        [{ text: "❌ انصراف", callback_data: "w:cancel" }],
      ]));
    }
  }
}

async function handleCallback(env: Env, request: Request, callback: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const data = String(callback.data || "");
  if (!chatId || !messageId) return;
  if (!adminIds(env).has(chatId)) {
    await answerCallback(env, callback.id, "⛔ دسترسی ندارید");
    return;
  }
  await answerCallback(env, callback.id);
  const links = await getTelegramLinks(env);

  if (data === "menu") {
    await clearState(env, chatId);
    await editMessage(env, chatId, messageId, "منوی مدیریت:", mainKeyboard());
    return;
  }
  if (data.startsWith("list:")) {
    const page = Math.max(0, parseInteger(data.split(":")[1], 0));
    await editMessage(env, chatId, messageId, `📋 لیست کانفیگ‌ها (${links.length} مورد):`, listKeyboard(links, page));
    return;
  }
  if (data === "newcfg") {
    await saveState(env, chatId, { action: "wizard", step: "label", data: {} });
    await editMessage(env, chatId, messageId, wizardPrompt("label"), wizardCancelKeyboard());
    return;
  }
  if (data === "newsub") {
    await saveState(env, chatId, { action: "newsub", step: "name", data: {} });
    await editMessage(env, chatId, messageId, "نام گروه را ارسال کنید:", wizardCancelKeyboard());
    return;
  }
  if (data === "w:cancel") {
    await clearState(env, chatId);
    await editMessage(env, chatId, messageId, "لغو شد.", mainKeyboard());
    return;
  }
  if (data.startsWith("view:")) {
    const link = links.find((item) => item.uuid === data.slice(5));
    if (!link) {
      await editMessage(env, chatId, messageId, "کانفیگ پیدا نشد.", mainKeyboard());
      return;
    }
    await editMessage(env, chatId, messageId, formatLink(link), detailKeyboard(link.uuid, link.active));
    return;
  }
  if (data.startsWith("toggle:")) {
    const uuid = data.slice(7);
    const link = await findLink(env, uuid);
    if (!link) {
      await editMessage(env, chatId, messageId, "کانفیگ پیدا نشد.", mainKeyboard());
      return;
    }
    const updateRequest = new Request(request.url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !link.active }),
    });
    await updateLink(env, updateRequest, uuid);
    const updated = await findLink(env, uuid);
    if (updated) await editMessage(env, chatId, messageId, formatLink(updated), detailKeyboard(uuid, updated.active));
    return;
  }
  if (data.startsWith("del:")) {
    const uuid = data.slice(4);
    const link = links.find((item) => item.uuid === uuid);
    if (!link) {
      await editMessage(env, chatId, messageId, "کانفیگ پیدا نشد.", mainKeyboard());
      return;
    }
    await editMessage(env, chatId, messageId, `❗️ حذف «${escapeHtml(link.label)}»؟`, keyboard([
      [{ text: "✅ بله، حذف کن", callback_data: `delok:${uuid}` }, { text: "❌ انصراف", callback_data: `view:${uuid}` }],
    ]));
    return;
  }
  if (data.startsWith("delok:")) {
    await deleteLink(env, data.slice(6));
    await editMessage(env, chatId, messageId, "🗑 کانفیگ حذف شد.", mainKeyboard());
    return;
  }

  if (data.startsWith("w:proto:")) {
    const state = await loadState(env, chatId);
    if (!state || state.action !== "wizard" || state.step !== "protocol") return;
    state.data.protocol = data.slice(8) as string;
    state.step = "fingerprint";
    await saveState(env, chatId, state);
    await editMessage(env, chatId, messageId, wizardPrompt("fingerprint"), wizardFingerprintKeyboard());
    return;
  }
  if (data.startsWith("w:fp:")) {
    const state = await loadState(env, chatId);
    if (!state || state.action !== "wizard" || state.step !== "fingerprint") return;
    state.data.fingerprint = data.slice(5);
    state.step = "alpn";
    await saveState(env, chatId, state);
    await editMessage(env, chatId, messageId, wizardPrompt("alpn"), wizardSkipKeyboard("alpn", "⏭ پیش‌فرض پروتکل"));
    return;
  }
  if (data.startsWith("w:skip:")) {
    const state = await loadState(env, chatId);
    if (!state || state.action !== "wizard") return;
    const step = data.slice(7);
    if (step === "alpn" && state.step === "alpn") {
      state.data.alpn = "";
      state.step = "port";
      await saveState(env, chatId, state);
      await editMessage(env, chatId, messageId, wizardPrompt("port"), wizardSkipKeyboard("port", "⏭ پورت 443"));
    } else if (step === "port" && state.step === "port") {
      state.data.port = 443;
      state.step = "volume";
      await saveState(env, chatId, state);
      await editMessage(env, chatId, messageId, wizardPrompt("volume"), wizardSkipKeyboard("volume", "♾ نامحدود"));
    } else if (step === "volume" && state.step === "volume") {
      state.data.limit_bytes = 0;
      state.step = "speed";
      await saveState(env, chatId, state);
      await editMessage(env, chatId, messageId, wizardPrompt("speed"), wizardSkipKeyboard("speed", "♾ نامحدود"));
    } else if (step === "speed" && state.step === "speed") {
      state.data.speed_limit_bytes = 0;
      state.step = "iplimit";
      await saveState(env, chatId, state);
      await editMessage(env, chatId, messageId, wizardPrompt("iplimit"), wizardSkipKeyboard("iplimit", "♾ نامحدود"));
    } else if (step === "iplimit" && state.step === "iplimit") {
      state.data.ip_limit = 0;
      state.step = "days";
      await saveState(env, chatId, state);
      await editMessage(env, chatId, messageId, wizardPrompt("days"), wizardSkipKeyboard("days", "♾ بدون انقضا"));
    } else if (step === "days" && state.step === "days") {
      state.data.expires_days = 0;
      state.step = "confirm";
      await saveState(env, chatId, state);
      await editMessage(env, chatId, messageId, wizardSummary(state.data), keyboard([
        [{ text: "✅ ساخت کانفیگ", callback_data: "w:confirm" }],
        [{ text: "❌ انصراف", callback_data: "w:cancel" }],
      ]));
    }
    return;
  }
  if (data === "w:confirm") {
    const state = await loadState(env, chatId);
    if (!state || state.action !== "wizard" || state.step !== "confirm") return;
    const createRequest = new Request(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: state.data.label,
        protocol: state.data.protocol || DEFAULT_PROTOCOL,
        fingerprint: state.data.fingerprint || DEFAULT_FINGERPRINT,
        alpn: state.data.alpn || "",
        port: 443,
        limit_value: Number(state.data.limit_bytes || 0),
        limit_unit: "B",
        speed_limit_value: Number(state.data.speed_limit_bytes || 0),
        speed_limit_unit: "B",
        ip_limit: Number(state.data.ip_limit || 0),
        expires_days: Number(state.data.expires_days || 0),
      }),
    });
    const created = await createLink(env, createRequest);
    await clearState(env, chatId);
    const link = await findLink(env, String(created.uuid));
    if (link) await editMessage(env, chatId, messageId, `✅ کانفیگ ساخته شد.\n\n${formatLink(link)}`, detailKeyboard(link.uuid, link.active));
    return;
  }

  if (data.startsWith("subs:")) {
    const groups = await listSubscriptions(env, request);
    await editMessage(env, chatId, messageId, `🗂 گروه‌های ساب (${groups.length} مورد):`, keyboard([
      ...groups.slice(0, PAGE_SIZE).map((group) => ([{ text: `🗂 ${group.name}`, callback_data: `subview:${group.sub_id}` }])),
      [{ text: "➕ ساخت گروه جدید", callback_data: "newsub" }],
      [{ text: "⬅ منوی اصلی", callback_data: "menu" }],
    ]));
    return;
  }
  if (data.startsWith("subview:")) {
    const group = await findSubscription(env, data.slice(8));
    if (!group) {
      await editMessage(env, chatId, messageId, "گروه پیدا نشد.", mainKeyboard());
      return;
    }
    await editMessage(env, chatId, messageId, `🗂 <b>${escapeHtml(group.name)}</b>\n\nلینک پابلیک:\n<code>${getPublicOrigin(request, env)}/p/${group.uuid_key}</code>`, keyboard([
      [{ text: "➕ افزودن کانفیگ با UUID", callback_data: `subadd:${group.sub_id}` }],
      [{ text: "🗑 حذف گروه", callback_data: `subdel:${group.sub_id}` }],
      [{ text: "⬅ بازگشت", callback_data: "subs:0" }],
    ]));
    return;
  }
  if (data.startsWith("subadd:")) {
    await saveState(env, chatId, { action: "subaddlink", step: "link", data: {}, subId: data.slice(7) });
    await editMessage(env, chatId, messageId, "UUID کانفیگ را ارسال کنید:", wizardCancelKeyboard());
    return;
  }
  if (data.startsWith("subdel:")) {
    await editMessage(env, chatId, messageId, "حذف گروه و خارج کردن کانفیگ‌ها از آن؟", keyboard([
      [{ text: "✅ حذف", callback_data: `subdelok:${data.slice(7)}` }, { text: "❌ انصراف", callback_data: `subview:${data.slice(7)}` }],
    ]));
    return;
  }
  if (data.startsWith("subdelok:")) {
    await deleteSubscription(env, data.slice(9));
    await editMessage(env, chatId, messageId, "🗑 گروه حذف شد.", mainKeyboard());
  }
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN) return new Response("Telegram is disabled", { status: 404 });
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return new Response("Telegram webhook secret is not configured", { status: 503 });
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expected) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await request.json().catch(() => null) as TelegramUpdate | null;
  if (!update) return new Response("bad update", { status: 400 });
  try {
    if (update.message) await handleMessage(env, request, update.message);
    if (update.callback_query) await handleCallback(env, request, update.callback_query);
  } catch (error) {
    console.error("Telegram update error", error);
  }
  return new Response("ok", { status: 200 });
}
