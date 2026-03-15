import PostalMime from "postal-mime";
import getUrls from "get-urls";
import { compile } from "html-to-text";
import { parse as parseDomain } from "tldts";

const PAGE_SIZE = 20;
const RULES_PAGE_SIZE = 12;
const MAX_RANKED_URLS = 20;
const MAX_EXTRACTED_RESULTS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL_RETENTION_DAYS = 2;
const DEFAULT_DEBUG_BODY_RETENTION_DAYS = 2;
const SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS emails (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, from_address TEXT NOT NULL, to_address TEXT NOT NULL, subject TEXT NOT NULL, extracted_json TEXT NOT NULL, received_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails (received_at DESC)",
  "CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY AUTOINCREMENT, remark TEXT, sender_filter TEXT, pattern TEXT NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS whitelist (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_pattern TEXT NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS email_debug_bodies (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, from_address TEXT NOT NULL, to_address TEXT NOT NULL, subject TEXT NOT NULL, text_content TEXT, html_content TEXT, normalized_text TEXT NOT NULL, ranked_urls_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_email_debug_bodies_expires_at ON email_debug_bodies (expires_at)"
];

const THEME_STORAGE_KEY = "temp-mail-theme";
const URL_PRIORITY_HINTS = [
  /verify/i,
  /verification/i,
  /confirm/i,
  /activate/i,
  /login/i,
  /sign-?in/i,
  /auth/i,
  /magic/i,
  /token/i,
  /code/i,
  /reset/i,
  /password/i,
  /invite/i
];
const URL_NOISE_HINTS = [
  /unsubscribe/i,
  /preferences/i,
  /privacy/i,
  /terms/i,
  /support/i,
  /help/i,
  /status/i,
  /tracking/i,
  /pixel/i,
  /\.(?:png|jpe?g|gif|svg|webp|ico|css|js)(?:[?#]|$)/i
];
const MATCH_REMARK_PRIORITY_HINTS = [
  /验证码/i,
  /校验码/i,
  /动态码/i,
  /登录码/i,
  /verification code/i,
  /verify code/i,
  /login code/i,
  /\botp\b/i,
  /\bpasscode\b/i
];
const htmlToText = compile({
  wordwrap: false,
  selectors: [
    { selector: "a", options: { ignoreHref: true } },
    { selector: "img", format: "skip" }
  ]
});

let schemaReadyPromise = null;

// ─── Exports ──────────────────────────────────────────────────────────────────

export default {
  async email(message, env, ctx) {
    await ensureSchema(env.DB);
    const now = Date.now();
    const messageId = crypto.randomUUID();
    const parsed = await parseIncomingEmail(message);

    // 发信人白名单检查：白名单非空时，不匹配则直接忽略
    const whitelist = await loadWhitelist(env.DB);
    if (!senderInWhitelist(parsed.from, whitelist)) return;

    const rules = await loadRules(env.DB);
    const extraction = buildExtractionContent(parsed);
    const matches = applyRules(extraction.content, parsed.from, rules);
    const pendingWrites = [
      saveEmailRecord(env.DB, {
        messageId,
        fromAddress: parsed.from,
        toAddress: parsed.to.join(","),
        subject: parsed.subject,
        matches,
        receivedAt: now
      })
    ];
    const debugBodyRecord = buildDebugBodyRecord({
      messageId,
      parsed,
      extraction,
      createdAt: now,
      retentionDays: getDebugBodyRetentionDays(env)
    });

    if (debugBodyRecord) pendingWrites.push(saveDebugBody(env.DB, debugBodyRecord));

    ctx.waitUntil(Promise.all(pendingWrites));

    // [新增配置] 可选的全局邮件转发功能
    if (env.FORWARD_TO) {
      try {
        await message.forward(env.FORWARD_TO);
      } catch (err) {
        console.error("邮件转发失败:", err);
      }
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // ── 外部 API /api/ ── API Token 鉴权 ────────────────────────────────────
    if (pathname === "/api/emails/latest") {
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      if (!isApiAuthorized(request, env.API_TOKEN)) return jsonError("Unauthorized", 401);
      await ensureSchema(env.DB);
      return handleEmailsLatest(url, env);
    }

    // ── 管理页面 / ───────────────────────────────────────────────────────────
    if (pathname === "/") {
      if (!isAdminAuthorized(request, env.ADMIN_TOKEN)) {
        return new Response(renderAuthHtml(), { headers: HTML_HEADERS });
      }
      return new Response(renderHtml(), { headers: HTML_HEADERS });
    }

    // ── 管理 API /admin/ ── Admin Token 鉴权 ────────────────────────────────
    if (pathname.startsWith("/admin/")) {
      if (!isAdminAuthorized(request, env.ADMIN_TOKEN)) {
        return new Response("Unauthorized", { status: 401 });
      }
      await ensureSchema(env.DB);
      if (pathname === "/admin/emails" && method === "GET") return handleAdminEmails(url, env);
      if (pathname.startsWith("/admin/emails/") && pathname.endsWith("/body") && method === "GET") return handleAdminEmailBody(pathname, env);
      if (pathname === "/admin/rules" && method === "GET") return handleAdminRulesGet(url, env);
      if (pathname === "/admin/rules" && method === "POST") return handleAdminRulesPost(request, env);
      if (pathname.startsWith("/admin/rules/") && method === "DELETE") return handleAdminRulesDelete(pathname, env);
      if (pathname === "/admin/whitelist" && method === "GET") return handleAdminWhitelistGet(url, env);
      if (pathname === "/admin/whitelist" && method === "POST") return handleAdminWhitelistPost(request, env);
      if (pathname.startsWith("/admin/whitelist/") && method === "DELETE") return handleAdminWhitelistDelete(pathname, env);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    await ensureSchema(env.DB);
    const now = Date.now();
    const emailExpirationTime = now - getEmailRetentionMs(env);

    ctx.waitUntil(Promise.all([
      env.DB.prepare("DELETE FROM emails WHERE received_at < ?")
        .bind(emailExpirationTime)
        .run()
        .then(() => console.log(`[Cron] email cleanup finished: received_at < ${emailExpirationTime}`))
        .catch(err => console.error("[Cron] email cleanup failed:", err)),
      env.DB.prepare("DELETE FROM email_debug_bodies WHERE expires_at <= ?")
        .bind(now)
        .run()
        .then(() => console.log(`[Cron] debug body cleanup finished: expires_at <= ${now}`))
        .catch(err => console.error("[Cron] debug body cleanup failed:", err))
    ]));
  }
};

// ─── Route Handlers ───────────────────────────────────────────────────────────

async function handleEmailsLatest(url, env) {
  const address = String(url.searchParams.get("address") || "").trim();
  if (!address) return jsonError("address is required", 400);

  const row = await env.DB.prepare(
    "SELECT from_address, to_address, extracted_json, received_at FROM emails WHERE instr(',' || to_address || ',', ',' || ? || ',') > 0 ORDER BY received_at DESC LIMIT 1"
  ).bind(address).first();

  if (!row) return jsonError("message not found", 404);

  const parsed = safeParseJson(row.extracted_json);
  const results = Array.isArray(parsed) ? parsed : [];
  const primaryResult = results[0] || null;

  return new Response(
    JSON.stringify({ code: 200, data: { from_address: row.from_address, to_address: row.to_address, received_at: row.received_at, primary_result: primaryResult, results } }),
    { headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS } }
  );
}

async function handleAdminEmails(url, env) {
  const page = clampPage(url.searchParams.get("page"));
  const offset = (page - 1) * PAGE_SIZE;

  const [list, countRow] = await Promise.all([
    env.DB.prepare(
      "SELECT message_id, from_address, to_address, subject, extracted_json, received_at FROM emails ORDER BY received_at DESC LIMIT ? OFFSET ?"
    ).bind(PAGE_SIZE, offset).all(),
    env.DB.prepare("SELECT COUNT(1) as total FROM emails").first()
  ]);

  return json({
    page,
    pageSize: PAGE_SIZE,
    total: countRow?.total || 0,
    items: list.results,
    debugBodyRetentionDays: getDebugBodyRetentionDays(env)
  });
}

async function handleAdminEmailBody(pathname, env) {
  const prefix = "/admin/emails/";
  const suffix = "/body";
  const rawMessageId = pathname.slice(prefix.length, -suffix.length);
  const messageId = decodeURIComponent(rawMessageId || "").trim();
  if (!messageId) return jsonError("invalid message id", 400);

  const row = await env.DB.prepare(
    "SELECT message_id, from_address, to_address, subject, text_content, html_content, normalized_text, ranked_urls_json, created_at, expires_at FROM email_debug_bodies WHERE message_id = ? LIMIT 1"
  ).bind(messageId).first();

  if (!row) return jsonError("debug body not found or expired", 404);

  const rankedUrls = safeParseJson(row.ranked_urls_json);
  return json({
    message_id: row.message_id,
    from_address: row.from_address,
    to_address: row.to_address,
    subject: row.subject,
    text_content: row.text_content || "",
    html_content: row.html_content || "",
    normalized_text: row.normalized_text || "",
    ranked_urls: Array.isArray(rankedUrls) ? rankedUrls : [],
    created_at: row.created_at,
    expires_at: row.expires_at
  });
}

async function handleAdminRulesGet(url, env) {
  const page = clampPage(url.searchParams.get("page"));
  const offset = (page - 1) * RULES_PAGE_SIZE;

  const [list, countRow] = await Promise.all([
    env.DB.prepare(
      "SELECT id, remark, sender_filter, pattern, created_at FROM rules ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).bind(RULES_PAGE_SIZE, offset).all(),
    env.DB.prepare("SELECT COUNT(1) as total FROM rules").first()
  ]);

  return json({ page, pageSize: RULES_PAGE_SIZE, total: countRow?.total || 0, items: list.results });
}

async function handleAdminRulesPost(request, env) {
  const body = await request.json();
  const remark = String(body.remark || "").trim();
  const pattern = String(body.pattern || "").trim();
  const senderFilter = String(body.sender_filter || "").trim();
  if (!pattern) return jsonError("pattern is required", 400);

  await env.DB.prepare("INSERT INTO rules (remark, sender_filter, pattern, created_at) VALUES (?, ?, ?, ?)")
    .bind(remark || null, senderFilter || null, pattern, Date.now())
    .run();
  return json({ ok: true });
}

async function handleAdminWhitelistGet(url, env) {
  const page = clampPage(url.searchParams.get("page"));
  const offset = (page - 1) * RULES_PAGE_SIZE;

  const [list, countRow] = await Promise.all([
    env.DB.prepare(
      "SELECT id, sender_pattern, created_at FROM whitelist ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).bind(RULES_PAGE_SIZE, offset).all(),
    env.DB.prepare("SELECT COUNT(1) as total FROM whitelist").first()
  ]);

  return json({ page, pageSize: RULES_PAGE_SIZE, total: countRow?.total || 0, items: list.results });
}

async function handleAdminWhitelistPost(request, env) {
  const body = await request.json();
  const senderPattern = String(body.sender_pattern || "").trim();
  if (!senderPattern) return jsonError("sender_pattern is required", 400);

  await env.DB.prepare("INSERT INTO whitelist (sender_pattern, created_at) VALUES (?, ?)")
    .bind(senderPattern, Date.now())
    .run();
  return json({ ok: true });
}

async function handleAdminWhitelistDelete(pathname, env) {
  const id = Number(pathname.replace("/admin/whitelist/", ""));
  if (!Number.isFinite(id)) return jsonError("invalid whitelist id", 400);

  await env.DB.prepare("DELETE FROM whitelist WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function handleAdminRulesDelete(pathname, env) {
  const id = Number(pathname.replace("/admin/rules/", ""));
  if (!Number.isFinite(id)) return jsonError("invalid rule id", 400);

  await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ─── Email Processing ─────────────────────────────────────────────────────────

async function parseIncomingEmail(message) {
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parsed = await new PostalMime().parse(rawBuffer);
  const toList = Array.isArray(parsed.to) ? parsed.to : [];

  return {
    from: parsed.from?.address || "",
    to: toList.map((item) => item.address).filter(Boolean),
    subject: parsed.subject || "",
    text: parsed.text || "",
    html: parsed.html || ""
  };
}

function buildExtractionContent(parsed) {
  const subject = normalizeText(parsed.subject);
  const normalizedText = buildNormalizedText(parsed);
  const rankedUrls = buildRankedUrls(parsed, normalizedText);
  const content = [subject, normalizedText, rankedUrls.join("\n")]
    .filter(Boolean)
    .join("\n\n");

  return { subject, normalizedText, rankedUrls, content };
}

function buildNormalizedText(parsed) {
  const sections = [];
  appendUniqueText(sections, normalizeText(parsed.text));
  appendUniqueText(sections, normalizeHtmlText(parsed.html));
  return stripDetectedUrls(sections.join("\n\n"));
}

function normalizeHtmlText(html) {
  const source = String(html || "").trim();
  if (!source) return "";

  try {
    return normalizeText(htmlToText(source));
  } catch (error) {
    console.error("HTML 转文本失败:", error);
    return normalizeText(source.replace(/<[^>]+>/g, " "));
  }
}

function buildRankedUrls(parsed, normalizedText) {
  const senderContext = getSenderContext(parsed.from);
  const candidates = new Map();

  for (const source of [parsed.subject, parsed.text, parsed.html, normalizedText]) {
    for (const url of safeExtractUrls(source)) {
      const score = scoreUrl(url, senderContext);
      const previousScore = candidates.get(url);
      if (previousScore === undefined || score > previousScore) {
        candidates.set(url, score);
      }
    }
  }

  return [...candidates.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].length - right[0].length;
    })
    .slice(0, MAX_RANKED_URLS)
    .map(([url]) => url);
}

function buildDebugBodyRecord({ messageId, parsed, extraction, createdAt, retentionDays }) {
  if (!retentionDays) return null;

  return {
    messageId,
    fromAddress: parsed.from,
    toAddress: parsed.to.join(","),
    subject: parsed.subject,
    textContent: parsed.text,
    htmlContent: parsed.html,
    normalizedText: extraction.normalizedText,
    rankedUrlsJson: JSON.stringify(extraction.rankedUrls),
    createdAt,
    expiresAt: createdAt + retentionDays * DAY_MS
  };
}

async function saveEmailRecord(db, { messageId, fromAddress, toAddress, subject, matches, receivedAt }) {
  await db.prepare(
    "INSERT INTO emails (message_id, from_address, to_address, subject, extracted_json, received_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(messageId, fromAddress, toAddress, subject, JSON.stringify(matches), receivedAt)
    .run();
}

async function saveDebugBody(db, record) {
  await db.prepare(
    "INSERT INTO email_debug_bodies (message_id, from_address, to_address, subject, text_content, html_content, normalized_text, ranked_urls_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      record.messageId,
      record.fromAddress,
      record.toAddress,
      record.subject,
      record.textContent,
      record.htmlContent,
      record.normalizedText,
      record.rankedUrlsJson,
      record.createdAt,
      record.expiresAt
    )
    .run();
}

function getDebugBodyRetentionDays(env) {
  const rawValue = String(env.DEBUG_BODY_RETENTION_DAYS || "").trim();
  if (!rawValue) return DEFAULT_DEBUG_BODY_RETENTION_DAYS;

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return DEFAULT_DEBUG_BODY_RETENTION_DAYS;
  return Math.max(0, Math.floor(parsed));
}

function getEmailRetentionMs(env) {
  return Math.max(EMAIL_RETENTION_DAYS, getDebugBodyRetentionDays(env)) * DAY_MS;
}

function safeExtractUrls(value) {
  const source = String(value || "").trim();
  if (!source) return [];

  try {
    return [...getUrls(source)];
  } catch (error) {
    console.error("URL 提取失败:", error);
    return [];
  }
}

function stripDetectedUrls(value) {
  let output = String(value || "");
  for (const url of safeExtractUrls(output)) {
    output = output.split(url).join(" ");
  }
  return normalizeText(output);
}

function appendUniqueText(target, value) {
  if (!value || target.includes(value)) return;
  target.push(value);
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getSenderContext(sender) {
  const senderValue = String(sender || "").trim().toLowerCase();
  const atIndex = senderValue.lastIndexOf("@");
  const host = atIndex === -1 ? "" : senderValue.slice(atIndex + 1);
  const parsed = host ? parseDomain(host) : null;

  return {
    host,
    domain: String(parsed?.domain || "").toLowerCase()
  };
}

function scoreUrl(url, senderContext) {
  let score = 0;
  let hostname = "";
  let domain = "";

  try {
    const parsed = parseDomain(url);
    hostname = String(parsed.hostname || "").toLowerCase();
    domain = String(parsed.domain || "").toLowerCase();
  } catch {}

  if (/^https:\/\//i.test(url)) score += 10;
  if (URL_PRIORITY_HINTS.some((pattern) => pattern.test(url))) score += 25;
  if (URL_NOISE_HINTS.some((pattern) => pattern.test(url))) score -= 35;

  if (senderContext.host && hostname) {
    if (hostname === senderContext.host) score += 120;
    else if (hostname.endsWith(`.${senderContext.host}`)) score += 90;
  }

  if (senderContext.domain && domain) {
    if (domain === senderContext.domain) score += 100;
    else if (hostname.endsWith(`.${senderContext.domain}`)) score += 80;
  }

  return score;
}

async function loadWhitelist(db) {
  const result = await db.prepare("SELECT id, sender_pattern FROM whitelist ORDER BY created_at DESC").all();
  return result.results.map((row) => ({
    id: Number(row.id),
    sender_pattern: String(row.sender_pattern)
  }));
}

async function loadRules(db) {
  const result = await db.prepare("SELECT id, remark, sender_filter, pattern FROM rules ORDER BY created_at DESC").all();
  return result.results.map((row) => ({
    id: Number(row.id),
    remark: row.remark ? String(row.remark) : "",
    sender_filter: row.sender_filter ? String(row.sender_filter) : "",
    pattern: String(row.pattern)
  }));
}

function applyRules(content, sender, rules) {
  const senderValue = String(sender || "").toLowerCase();
  const candidates = [];
  for (const rule of rules) {
    if (!senderMatches(senderValue, rule.sender_filter)) continue;
    try {
      const match = new RegExp(rule.pattern, "m").exec(content);
      if (match?.[0]) {
        candidates.push({
          rule_id: rule.id,
          value: String(match[0]).trim(),
          remark: rule.remark || null,
          score: scoreRuleMatchCandidate(rule, match[0], match.index),
          matchIndex: Number.isFinite(match.index) ? match.index : Number.MAX_SAFE_INTEGER
        });
      }
    } catch {
      continue;
    }
  }
  return rankRuleMatchCandidates(candidates)
    .slice(0, MAX_EXTRACTED_RESULTS)
    .map(({ rule_id, value, remark }) => ({ rule_id, value, remark }));
}

function scoreRuleMatchCandidate(rule, value, matchIndex) {
  const normalizedValue = String(value || "").trim();
  const remarkValue = String(rule?.remark || "").trim();
  let score = 0;

  if (/^\d{6}$/.test(normalizedValue)) score += 320;
  else if (/^\d{4,8}$/.test(normalizedValue)) score += 260;
  else if (/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{6,8}$/.test(normalizedValue)) score += 180;
  else if (/^https?:\/\//i.test(normalizedValue)) score += 40;
  else if (/\d/.test(normalizedValue)) score += 80;

  if (MATCH_REMARK_PRIORITY_HINTS.some((pattern) => pattern.test(remarkValue))) score += 45;

  if (Number.isFinite(matchIndex)) {
    score += Math.max(0, 24 - Math.floor(matchIndex / 48));
  }

  score += Math.max(0, 20 - Math.min(normalizedValue.length, 20));
  return score;
}

function rankRuleMatchCandidates(candidates) {
  const bestByValue = new Map();

  for (const candidate of candidates) {
    const key = String(candidate.value || "").trim().toLowerCase();
    if (!key) continue;

    const previous = bestByValue.get(key);
    if (!previous || compareRuleMatchCandidates(candidate, previous) < 0) {
      bestByValue.set(key, candidate);
    }
  }

  return [...bestByValue.values()].sort(compareRuleMatchCandidates);
}

function compareRuleMatchCandidates(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  if (left.matchIndex !== right.matchIndex) return left.matchIndex - right.matchIndex;
  if (left.value.length !== right.value.length) return left.value.length - right.value.length;
  return right.rule_id - left.rule_id;
}

function senderInWhitelist(sender, whitelist) {
  if (whitelist.length === 0) return true;
  const senderValue = String(sender || "").toLowerCase();
  return whitelist.some(({ sender_pattern }) => {
    try { return new RegExp(sender_pattern, "i").test(senderValue); } catch { return false; }
  });
}

function senderMatches(senderValue, filterValue) {
  const filter = String(filterValue || "").trim();
  if (!filter) return true;
  const parts = filter.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return true;
  return parts.some((pattern) => {
    try { return new RegExp(pattern, "i").test(senderValue); } catch { return false; }
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function isAdminAuthorized(request, adminToken) {
  if (!adminToken) return false;
  if (getBearerToken(request) === adminToken) return true;
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  return cookies.admin_token === adminToken;
}

function isApiAuthorized(request, apiToken) {
  if (!apiToken) return false;
  return getBearerToken(request) === apiToken;
}

function getBearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function parseCookies(cookieHeader) {
  const output = {};
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey) output[rawKey] = decodeURIComponent(rest.join("="));
  }
  return output;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization"
};

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

function clampPage(value) {
  const page = Number(value);
  return Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
}

function safeParseJson(value) {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function ensureSchema(db) {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      for (const statement of SCHEMA_STATEMENTS) {
        await db.prepare(statement).run();
      }
    })().catch((err) => {
      schemaReadyPromise = null;
      console.error("Schema initialization failed:", err);
      throw err;
    });
  }
  return schemaReadyPromise;
}

function json(data, status = 200) {
  return new Response(JSON.stringify({ code: status, data }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ code: status, message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

// ─── HTML Rendering ───────────────────────────────────────────────────────────

function renderThemeBootScript() {
  return `<script>
    (() => {
      let theme = "light";
      try {
        const stored = localStorage.getItem("${THEME_STORAGE_KEY}");
        if (stored === "dark" || stored === "light") theme = stored;
      } catch {}
      document.documentElement.dataset.theme = theme;
    })();
  </script>`;
}

function renderThemeStyles() {
  return `
      :root {
        color-scheme: light;
        --light-bg: #f5efe7;
        --light-bg-accent: rgba(99, 102, 241, 0.16);
        --light-bg-accent-secondary: rgba(14, 165, 233, 0.14);
        --light-panel: rgba(255, 255, 255, 0.8);
        --light-panel-muted: rgba(255, 255, 255, 0.66);
        --light-panel-strong: rgba(255, 255, 255, 0.94);
        --light-border: rgba(148, 163, 184, 0.28);
        --light-text: #0f172a;
        --light-muted: #64748b;
        --light-faint: #94a3b8;
        --light-accent: #4338ca;
      }

      html[data-theme="light"] {
        color-scheme: light;
      }

      html[data-theme="dark"] {
        color-scheme: dark;
      }

      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        transition: background 0.28s ease, color 0.2s ease;
      }

      html[data-theme="light"] body {
        background:
          radial-gradient(circle at top center, var(--light-bg-accent), transparent 46%),
          radial-gradient(circle at bottom left, var(--light-bg-accent-secondary), transparent 38%),
          var(--light-bg) !important;
        color: var(--light-text) !important;
      }

      html[data-theme="dark"] body {
        background: #09090b !important;
      }

      html[data-theme="light"] .bg-white\\/\\[0\\.01\\] {
        background-color: var(--light-panel-muted) !important;
      }

      html[data-theme="light"] .bg-white\\/\\[0\\.02\\],
      html[data-theme="light"] .backdrop-blur-xl,
      html[data-theme="light"] .backdrop-blur-sm {
        background-color: var(--light-panel) !important;
      }

      html[data-theme="light"] .bg-white\\/\\[0\\.03\\],
      html[data-theme="light"] .bg-white\\/\\[0\\.05\\] {
        background-color: rgba(255, 255, 255, 0.7) !important;
      }

      html[data-theme="light"] .bg-white\\/\\[0\\.04\\],
      html[data-theme="light"] .bg-white\\/\\[0\\.1\\] {
        background-color: var(--light-panel-strong) !important;
      }

      html[data-theme="light"] .bg-black\\/20,
      html[data-theme="light"] .bg-\\[\\#030303\\] {
        background-color: rgba(255, 255, 255, 0.92) !important;
      }

      html[data-theme="light"] .border-white\\/5,
      html[data-theme="light"] .border-white\\/10 {
        border-color: var(--light-border) !important;
      }

      html[data-theme="light"] .ring-white\\/10 {
        --tw-ring-color: rgba(148, 163, 184, 0.3) !important;
      }

      html[data-theme="light"] .text-white,
      html[data-theme="light"] .text-slate-200,
      html[data-theme="light"] .text-slate-300 {
        color: var(--light-text) !important;
      }

      html[data-theme="light"] .text-slate-400,
      html[data-theme="light"] .text-slate-500 {
        color: var(--light-muted) !important;
      }

      html[data-theme="light"] .text-slate-600 {
        color: var(--light-faint) !important;
      }

      html[data-theme="light"] .text-indigo-200,
      html[data-theme="light"] .text-indigo-300 {
        color: var(--light-accent) !important;
      }

      html[data-theme="light"] .bg-indigo-500\\/10 {
        background-color: rgba(99, 102, 241, 0.08) !important;
      }

      html[data-theme="light"] .border-indigo-500\\/20,
      html[data-theme="light"] .hover\\:border-indigo-500\\/30:hover {
        border-color: rgba(99, 102, 241, 0.22) !important;
      }

      html[data-theme="light"] .hover\\:bg-white\\/5:hover,
      html[data-theme="light"] .hover\\:bg-white\\/\\[0\\.04\\]:hover {
        background-color: var(--light-panel-strong) !important;
      }

      html[data-theme="light"] .hover\\:text-white:hover,
      html[data-theme="light"] .hover\\:text-slate-200:hover,
      html[data-theme="light"] .hover\\:text-slate-100:hover {
        color: var(--light-text) !important;
      }

      html[data-theme="light"] .bg-white.text-slate-900 {
        background-color: var(--light-text) !important;
        color: #f8fafc !important;
      }

      html[data-theme="light"] .hover\\:bg-slate-200:hover {
        background-color: #1e293b !important;
        color: #f8fafc !important;
      }

      html[data-theme="light"] .shadow-2xl,
      html[data-theme="light"] .shadow-xl {
        box-shadow: 0 18px 45px rgba(148, 163, 184, 0.18) !important;
      }

      html[data-theme="light"] .shadow-black\\/20,
      html[data-theme="light"] .shadow-white\\/5 {
        --tw-shadow-color: rgba(148, 163, 184, 0.18) !important;
      }

      .theme-toggle {
        backdrop-filter: blur(12px);
        transition: all 0.2s ease;
      }

      html[data-theme="light"] .theme-toggle {
        background: rgba(255, 255, 255, 0.7);
        color: var(--light-muted);
        border: 1px solid var(--light-border);
      }

      html[data-theme="dark"] .theme-toggle {
        background: rgba(255, 255, 255, 0.05);
        color: #94a3b8;
        border: 1px solid rgba(255, 255, 255, 0.08);
      }

      .theme-toggle:hover {
        transform: translateY(-1px);
      }

      html[data-theme="light"] .theme-toggle:hover {
        background: rgba(255, 255, 255, 0.94);
        color: var(--light-text);
      }

      html[data-theme="dark"] .theme-toggle:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #ffffff;
      }
    `;
}

function renderAuthHtml() {
  return `<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Temp Mail Console - Login</title>
    <script src="https://cdn.tailwindcss.com"></script>
    ${renderThemeBootScript()}
    <style>${renderThemeStyles()}</style>
  </head>
  <body class="bg-[#09090b] text-slate-200 antialiased flex items-center justify-center min-h-screen selection:bg-indigo-500/30">
    <div class="absolute right-4 top-4 sm:right-6 sm:top-6">
      <button id="theme-toggle" type="button" class="theme-toggle rounded-xl px-3 py-2 text-[12px] font-medium">暗色模式</button>
    </div>
    <div class="absolute inset-0 bg-[radial-gradient(circle_at_top_center,rgba(99,102,241,0.08),transparent_50%)] pointer-events-none"></div>
    <div class="w-full max-w-sm p-8 rounded-[1.5rem] bg-white/[0.02] border border-white/5 backdrop-blur-xl shadow-2xl relative">
      <div class="w-12 h-12 mb-6 flex border border-white/10 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-inner shadow-white/20">
        <svg class="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
      </div>
      <h1 class="text-xl font-semibold text-white tracking-tight mb-1">Console Access</h1>
      <p class="text-[13px] text-slate-400 mb-8">Light by default, dark mode on demand.</p>
      <form class="space-y-4" onsubmit="return false;">
        <input
          id="admin-token"
          type="password"
          class="w-full px-4 py-2.5 rounded-xl border border-white/10 bg-black/20 text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all text-[13px]"
          placeholder="Admin Token"
          autocomplete="current-password"
        />
        <div id="admin-error" class="text-[12px] text-red-400 hidden">密码不正确，请重试</div>
        <button
          id="admin-submit"
          type="button"
          class="w-full py-2.5 rounded-xl bg-white text-slate-900 font-medium text-[13px] hover:bg-slate-200 transition-colors shadow-lg shadow-white/5"
        >Secure Login</button>
      </form>
    </div>
    </div>
    <script>
      const input = document.getElementById("admin-token");
      const error = document.getElementById("admin-error");
      const submit = document.getElementById("admin-submit");
      const themeToggle = document.getElementById("theme-toggle");

      const readStoredTheme = () => {
        try {
          return localStorage.getItem("${THEME_STORAGE_KEY}") === "dark" ? "dark" : "light";
        } catch {
          return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
        }
      };

      const applyTheme = (theme) => {
        const nextTheme = theme === "dark" ? "dark" : "light";
        document.documentElement.dataset.theme = nextTheme;
        try {
          localStorage.setItem("${THEME_STORAGE_KEY}", nextTheme);
        } catch {}
        if (themeToggle) {
          themeToggle.textContent = nextTheme === "dark" ? "浅色模式" : "暗色模式";
        }
      };

      if (input) input.focus();
      applyTheme(readStoredTheme());

      const setError = (message) => {
        if (!error) return;
        error.textContent = message;
        error.classList.remove("hidden");
      };

      const attempt = async () => {
        const token = input ? input.value.trim() : "";
        if (!token) { setError("请输入访问密码"); return; }
        const res = await fetch("/admin/emails?page=1", {
          headers: { Authorization: "Bearer " + token }
        });
        if (res.status === 401) { setError("密码不正确，请重试"); return; }
        if (!res.ok) { setError("登录失败，请重试"); return; }
        document.cookie = "admin_token=" + encodeURIComponent(token) + "; Path=/; SameSite=Lax";
        window.location.href = "/";
      };

      if (submit) submit.addEventListener("click", attempt);
      if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); });
      if (themeToggle) {
        themeToggle.addEventListener("click", () => {
          applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
        });
      }
    </script>
  </body>
</html>`;
}

function renderHtml() {
  return `<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Temp Mail Console</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
    ${renderThemeBootScript()}
    <style>${renderThemeStyles()}</style>
  </head>
  <body class="bg-[#09090b] text-slate-300 antialiased selection:bg-indigo-500/30">
    <div id="app" class="min-h-screen">
      <header class="max-w-5xl mx-auto px-4 py-4">
        <div class="rounded-2xl border border-white/5 bg-white/[0.02] backdrop-blur-xl px-6 py-5 flex items-center justify-between shadow-2xl">
          <div class="flex items-center gap-4">
            <div class="h-10 w-10 flex border border-white/10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-inner shadow-white/20">
              <svg class="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
            </div>
            <div>
              <h1 class="text-lg font-semibold tracking-tight text-white">Temporary Mail Console</h1>
              <p class="text-xs text-slate-400 mt-0.5">Cloudflare Workers · D1 Database</p>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <div class="flex items-center gap-2">
              <span class="relative flex h-2 w-2">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span class="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Live</span>
            </div>
            <button id="theme-toggle" type="button" class="theme-toggle rounded-xl px-3 py-2 text-[12px] font-medium">暗色模式</button>
          </div>
        </div>
      </header>

      <main class="max-w-5xl mx-auto px-4 py-6">
        <div class="mb-6 p-1 relative flex items-center gap-1 bg-white/[0.03] border border-white/5 rounded-xl w-fit shadow-inner shadow-black/20">
          <button
            class="px-4 py-1.5 rounded-lg text-[13px] font-medium transition-all duration-200"
            :class="activeTab === 'emails' ? 'bg-white/[0.1] text-white shadow-sm ring-1 ring-white/10' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'"
            @click="activeTab = 'emails'"
          >邮件记录</button>
          <button
            class="px-4 py-1.5 rounded-lg text-[13px] font-medium transition-all duration-200"
            :class="activeTab === 'rules' ? 'bg-white/[0.1] text-white shadow-sm ring-1 ring-white/10' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'"
            @click="activeTab = 'rules'"
          >命中规则</button>
          <button
            class="px-4 py-1.5 rounded-lg text-[13px] font-medium transition-all duration-200"
            :class="activeTab === 'whitelist' ? 'bg-white/[0.1] text-white shadow-sm ring-1 ring-white/10' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'"
            @click="activeTab = 'whitelist'"
          >发件人白名单</button>
          <button
            class="px-4 py-1.5 rounded-lg text-[13px] font-medium transition-all duration-200"
            :class="activeTab === 'api' ? 'bg-white/[0.1] text-white shadow-sm ring-1 ring-white/10' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'"
            @click="activeTab = 'api'"
          >API 对接</button>
        </div>

        <div v-if="adminError" class="mb-4 text-xs text-red-400">{{ adminError }}</div>

        <section v-if="activeTab === 'emails'" class="bg-white/[0.02] border border-white/5 rounded-2xl shadow-xl shadow-black/20 overflow-hidden backdrop-blur-sm">
          <div class="p-5 border-b border-white/5 flex items-center justify-between bg-white/[0.01]">
            <div>
              <h2 class="text-sm font-semibold text-white">收件箱</h2>
              <p class="text-[11px] text-slate-400 mt-0.5">调试正文{{ debugBodyRetentionDays > 0 ? '仅保留最近 ' + debugBodyRetentionDays + ' 天' : '已关闭保存' }}，用于排查正则命中问题</p>
            </div>
            <div class="flex items-center gap-2 text-[11px]">
              <button class="px-2.5 py-1.5 rounded-lg border border-white/5 hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" @click="prevPage" :disabled="page===1">PREV</button>
              <span class="px-3 py-1 text-slate-400">{{ page }} / {{ totalPages }}</span>
              <button class="px-2.5 py-1.5 rounded-lg border border-white/5 hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" @click="nextPage" :disabled="page>=totalPages">NEXT</button>
            </div>
          </div>
          <div class="p-5 space-y-3">
            <div class="grid grid-cols-[1.5fr,1.2fr,1.2fr,0.8fr] gap-4 px-3 text-[10px] text-slate-500 uppercase tracking-widest font-medium">
              <div>Subject</div>
              <div>From</div>
              <div>To</div>
              <div class="text-right">Received</div>
            </div>
            <div v-if="items.length===0" class="min-h-[240px] flex items-center justify-center text-xs text-slate-400">暂无邮件记录</div>
            <div v-for="item in items" :key="item.message_id" class="p-3.5 rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] transition-all duration-200 cursor-pointer group" @click="toggleResult(item.message_id)">
              <div class="grid grid-cols-[1.5fr,1.2fr,1.2fr,0.8fr] gap-4 items-center">
                <div class="min-w-0">
                  <div class="text-[13px] font-medium text-slate-200 truncate group-hover:text-white transition-colors">{{ item.subject || '(无主题)' }}</div>
                </div>
                <div class="min-w-0 text-[11px] text-slate-400 truncate">{{ item.from_address }}</div>
                <div class="min-w-0 text-[11px] text-slate-400 truncate">{{ item.to_address }}</div>
                <div class="text-[11px] text-slate-400 text-right tabular-nums">{{ formatTime(item.received_at) }}</div>
                <div v-if="!hasResult(item.extracted_json) || expandedResults[item.message_id]" class="col-span-4 mt-3 space-y-3">
                  <div v-if="hasResult(item.extracted_json) && expandedResults[item.message_id]" class="relative group/copy" @click.stop>
                    <div
                      class="text-[12px] bg-indigo-500/10 border border-indigo-500/20 text-indigo-200 rounded-lg p-3 whitespace-pre-wrap font-mono pr-12"
                    >{{ formatResult(item.extracted_json) }}</div>
                    <button
                      class="absolute top-2 right-2 p-1.5 rounded-md text-indigo-300 hover:text-white hover:bg-indigo-500/20 opacity-0 group-hover/copy:opacity-100 transition-all border border-transparent hover:border-indigo-500/30 font-medium text-[10px] tracking-wider uppercase"
                      @click.stop="copyContent(formatResult(item.extracted_json), item.message_id)"
                    >{{ copyStatus[item.message_id] ? 'Copied' : 'Copy' }}</button>
                  </div>
                  <div v-if="!hasResult(item.extracted_json)" class="text-[11px] text-slate-600">— 未提取到规则内容</div>
                  <div class="flex items-center justify-between gap-3" @click.stop>
                    <div class="text-[10px] text-slate-500">查看归一化文本、原始文本、HTML 与 URL 排序结果，专门用于规则调试</div>
                    <button
                      class="shrink-0 px-2.5 py-1.5 rounded-lg border border-white/10 text-[11px] text-slate-300 hover:text-white hover:bg-white/5 transition-colors"
                      @click.stop="openDebugBody(item)"
                    >查看调试正文</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section v-if="activeTab === 'rules'" class="bg-white/[0.02] border border-white/5 rounded-2xl shadow-xl shadow-black/20 overflow-hidden backdrop-blur-sm">
          <div class="p-5 border-b border-white/5 bg-white/[0.01]">
            <h2 class="text-sm font-semibold text-white">命中规则</h2>
            <p class="text-[11px] text-slate-400 mt-0.5">符合发信人过滤规则的邮件，将会使用对应的邮件内容匹配规则进行解析</p>
          </div>

          <div class="p-5 grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div class="lg:col-span-5">
              <div class="rounded-xl border border-white/5 bg-white/[0.01] p-5 lg:sticky lg:top-5">
                <div class="mb-4">
                  <div class="text-[13px] font-medium text-white mb-0.5">添加规则</div>
                  <div class="text-[11px] text-slate-500">创建新的正则提取器</div>
                </div>

                <div class="space-y-4">
                  <div class="space-y-1.5">
                    <label class="text-[11px] font-medium text-slate-500 uppercase tracking-widest">备注</label>
                    <input v-model="newRule.remark" type="text" class="w-full px-3 py-2 rounded-lg border border-white/5 bg-black/20 text-[13px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all" placeholder="e.g. 验证码" />
                  </div>

                  <div class="space-y-1.5">
                    <label class="text-[11px] font-medium text-slate-500 uppercase tracking-widest">发信人过滤规则</label>
                    <textarea v-model="newRule.sender_filter" rows="3" class="w-full px-3 py-2 rounded-lg border border-white/5 bg-black/20 text-[13px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all font-mono" placeholder="e.g. noreply@example.com"></textarea>
                  </div>

                  <div class="space-y-1.5">
                    <label class="text-[11px] font-medium text-slate-500 uppercase tracking-widest">内容匹配正则</label>
                    <textarea v-model="newRule.pattern" rows="5" class="w-full px-3 py-2 rounded-lg border border-white/5 bg-black/20 text-[13px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all font-mono" placeholder="e.g. (\d{6})"></textarea>
                  </div>

                  <button class="w-full py-2.5 rounded-lg bg-white text-slate-900 font-medium text-[13px] hover:bg-slate-200 transition-colors shadow-lg shadow-white/5 mt-2" @click="addRule">Add Rule</button>
                </div>
              </div>
            </div>

            <div class="lg:col-span-7">
              <div class="rounded-xl border border-white/5 bg-white/[0.01] flex flex-col min-h-[460px]">
                <div class="px-5 py-3 border-b border-white/5 flex items-center justify-between">
                  <div class="text-[12px] font-medium text-slate-300">Existing Rules</div>
                  <div class="flex items-center gap-2 text-[11px]">
                    <span class="text-slate-500 mr-2">Total: {{ rulesTotal }}</span>
                    <button class="px-2.5 py-1 rounded border border-white/5 hover:bg-white/5 transition-colors disabled:opacity-50" @click="prevRulesPage" :disabled="rulesPage===1">PREV</button>
                    <span class="text-slate-400">{{ rulesPage }} / {{ rulesTotalPages }}</span>
                    <button class="px-2.5 py-1 rounded border border-white/5 hover:bg-white/5 transition-colors disabled:opacity-50" @click="nextRulesPage" :disabled="rulesPage>=rulesTotalPages">NEXT</button>
                  </div>
                </div>

                <div class="p-3 space-y-2 flex-1 overflow-auto">
                  <div v-if="rules.length===0" class="h-full flex items-center justify-center text-[12px] text-slate-500">No rules configured.</div>
                  <div v-for="rule in rules" :key="rule.id" class="p-3.5 rounded-lg border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] transition-colors flex items-start justify-between gap-4 group">
                    <div class="min-w-0 space-y-1.5 flex-1">
                      <div v-if="rule.remark" class="text-[13px] font-medium text-slate-200 truncate">{{ rule.remark }}</div>
                      <div class="text-[11px] text-slate-400 truncate flex items-center gap-2">
                        <span class="px-1.5 py-0.5 rounded bg-white/[0.05] border border-white/5 font-mono">From</span>
                        {{ rule.sender_filter || 'Any Sender' }}
                      </div>
                      <div class="text-[11px] text-slate-400 break-words flex items-start gap-2">
                        <span class="px-1.5 py-0.5 rounded bg-white/[0.05] border border-white/5 font-mono shrink-0 pt-0.5">Regex</span>
                        <span class="font-mono text-indigo-300">{{ rule.pattern }}</span>
                      </div>
                    </div>
                    <button class="shrink-0 text-[11px] px-2.5 py-1.5 rounded-md text-red-400 opacity-0 group-hover:opacity-100 hover:bg-red-400/10 transition-all font-medium" @click="deleteRule(rule.id)">Delete</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section v-if="activeTab === 'whitelist'" class="bg-white/[0.02] border border-white/5 rounded-2xl shadow-xl shadow-black/20 overflow-hidden backdrop-blur-sm">
          <div class="p-5 border-b border-white/5 bg-white/[0.01]">
            <h2 class="text-sm font-semibold text-white">发件人白名单</h2>
            <p class="text-[11px] text-slate-400 mt-0.5">只处理匹配白名单的发信人，白名单为空时接受所有邮件</p>
          </div>
          <div class="p-5 grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div class="lg:col-span-5">
              <div class="rounded-xl border border-white/5 bg-white/[0.01] p-5">
                <div class="mb-4">
                  <div class="text-[13px] font-medium text-white mb-0.5">添加白名单</div>
                  <div class="text-[11px] text-slate-500">支持正则表达式</div>
                </div>
                <div class="space-y-4">
                  <div class="space-y-1.5">
                    <label class="text-[11px] font-medium text-slate-500 uppercase tracking-widest">发信人模式</label>
                    <textarea v-model="newWhitelist" rows="4" class="w-full px-3 py-2 rounded-lg border border-white/5 bg-black/20 text-[13px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all font-mono" placeholder="e.g. .*@example\.com"></textarea>
                  </div>
                  <button class="w-full py-2.5 rounded-lg bg-white text-slate-900 font-medium text-[13px] hover:bg-slate-200 transition-colors shadow-lg shadow-white/5 mt-2" @click="addWhitelistEntry">Add Whitelist</button>
                </div>
              </div>
            </div>
            <div class="lg:col-span-7">
              <div class="rounded-xl border border-white/5 bg-white/[0.01] flex flex-col min-h-[220px]">
                <div class="px-5 py-3 border-b border-white/5 flex items-center justify-between">
                  <div class="text-[12px] font-medium text-slate-300">Allowed Senders</div>
                  <div class="flex items-center gap-2 text-[11px]">
                    <span class="text-slate-500 mr-2">Total: {{ whitelistTotal }}</span>
                    <button class="px-2.5 py-1 rounded border border-white/5 hover:bg-white/5 transition-colors disabled:opacity-50" @click="prevWhitelistPage" :disabled="whitelistPage===1">PREV</button>
                    <span class="text-slate-400">{{ whitelistPage }} / {{ whitelistTotalPages }}</span>
                    <button class="px-2.5 py-1 rounded border border-white/5 hover:bg-white/5 transition-colors disabled:opacity-50" @click="nextWhitelistPage" :disabled="whitelistPage>=whitelistTotalPages">NEXT</button>
                  </div>
                </div>
                <div class="p-3 space-y-2 flex-1 overflow-auto">
                  <div v-if="whitelistItems.length===0" class="h-full flex items-center justify-center text-[12px] text-slate-500">尚无白名单，当前接受所有发信人</div>
                  <div v-for="item in whitelistItems" :key="item.id" class="p-3 rounded-lg border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] transition-colors flex items-center justify-between gap-4 group">
                    <div class="min-w-0 font-mono text-[12px] text-indigo-300 truncate">{{ item.sender_pattern }}</div>
                    <button class="shrink-0 text-[11px] px-2.5 py-1.5 rounded-md text-red-400 opacity-0 group-hover:opacity-100 hover:bg-red-400/10 transition-all font-medium" @click="deleteWhitelistEntry(item.id)">Delete</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section v-if="activeTab === 'api'" class="bg-white/[0.02] border border-white/5 rounded-2xl shadow-xl shadow-black/20 overflow-hidden backdrop-blur-sm">
          <div class="p-5 border-b border-white/5">
            <h2 class="text-sm font-semibold text-white">API Integration</h2>
          </div>
          <div class="p-6 space-y-6 text-[13px]">
            <div class="space-y-2">
              <div class="text-[11px] font-medium text-slate-500 uppercase tracking-widest">Authentication</div>
              <pre class="rounded-xl border border-white/5 bg-[#030303] p-4 text-slate-300 font-mono text-[12px] shadow-inner">Authorization: Bearer &lt;API_TOKEN&gt;</pre>
            </div>
            <div class="space-y-2">
              <div class="text-[11px] font-medium text-slate-500 uppercase tracking-widest">Fetch Latest Result</div>
              <pre class="rounded-xl border border-white/5 bg-[#030303] p-4 text-slate-300 font-mono text-[12px] shadow-inner">GET /api/emails/latest?address=&lt;email_address&gt;

Response: {
  "code": 200,
  "data": {
    "from_address": "sender@example.com",
    "to_address": "target@domain.com",
    "received_at": 1741881600000,
    "primary_result": { "rule_id": 1, "value": "123", "remark": "备注" },
    "results": [
      { "rule_id": 1, "value": "123", "remark": "备注" }
    ]
  }
}
data.received_at: 收件时间戳
data.primary_result: 当前最优命中结果，没有命中时为 null
data.results: 命中结果对象序列 [{ rule_id: 1, value: "123", remark: "备注" }]</pre>
            </div>
          </div>
        </section>

        <div v-if="debugBodyModalOpen" class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm p-4 sm:p-6" @click.self="closeDebugBody">
          <div class="max-w-4xl mx-auto mt-6 bg-[#030303] border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
            <div class="px-5 py-4 border-b border-white/10 flex items-start justify-between gap-4">
              <div class="min-w-0">
                <div class="text-[11px] font-medium text-slate-500 uppercase tracking-widest">Debug Body</div>
                <div class="text-sm font-semibold text-white truncate mt-1">{{ debugBodyTarget?.subject || '(无主题)' }}</div>
                <div class="text-[11px] text-slate-400 mt-1 break-all">{{ debugBodyTarget?.from_address || '—' }} → {{ debugBodyTarget?.to_address || '—' }}</div>
              </div>
              <button class="shrink-0 px-3 py-1.5 rounded-lg border border-white/10 text-[11px] text-slate-400 hover:text-white hover:bg-white/5 transition-colors" @click="closeDebugBody">Close</button>
            </div>
            <div class="p-5 max-h-[75vh] overflow-y-auto space-y-4">
              <div v-if="debugBodyLoading" class="text-[12px] text-slate-400">正在加载调试正文...</div>
              <div v-else-if="debugBodyError" class="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-[12px] text-red-300">{{ debugBodyError }}</div>
              <template v-else-if="debugBodyData">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div class="rounded-xl border border-white/5 bg-white/[0.02] p-3">
                    <div class="text-[10px] text-slate-500 uppercase tracking-widest">Saved</div>
                    <div class="text-[12px] text-slate-200 mt-1">{{ formatTime(debugBodyData.created_at) }}</div>
                  </div>
                  <div class="rounded-xl border border-white/5 bg-white/[0.02] p-3">
                    <div class="text-[10px] text-slate-500 uppercase tracking-widest">Expires</div>
                    <div class="text-[12px] text-slate-200 mt-1">{{ formatTime(debugBodyData.expires_at) }}</div>
                  </div>
                </div>

                <div class="space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <div class="text-[11px] font-medium text-slate-400 uppercase tracking-widest">Normalized Text</div>
                    <button class="px-2 py-1 rounded-md border border-white/10 text-[10px] text-slate-400 hover:text-white hover:bg-white/5 transition-colors" @click="copyContent(debugBodyData.normalized_text || '', 'debug-normalized-' + debugBodyData.message_id)">{{ copyStatus['debug-normalized-' + debugBodyData.message_id] ? 'Copied' : 'Copy' }}</button>
                  </div>
                  <pre class="rounded-xl border border-white/5 bg-white/[0.02] p-3 text-[12px] text-slate-200 whitespace-pre-wrap break-words font-mono">{{ debugBodyData.normalized_text || '—' }}</pre>
                </div>

                <div class="space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <div class="text-[11px] font-medium text-slate-400 uppercase tracking-widest">Ranked URLs</div>
                    <button class="px-2 py-1 rounded-md border border-white/10 text-[10px] text-slate-400 hover:text-white hover:bg-white/5 transition-colors" @click="copyContent(formatDebugUrls(debugBodyData.ranked_urls), 'debug-urls-' + debugBodyData.message_id)">{{ copyStatus['debug-urls-' + debugBodyData.message_id] ? 'Copied' : 'Copy' }}</button>
                  </div>
                  <pre class="rounded-xl border border-white/5 bg-white/[0.02] p-3 text-[12px] text-slate-200 whitespace-pre-wrap break-words font-mono">{{ formatDebugUrls(debugBodyData.ranked_urls) }}</pre>
                </div>

                <div class="space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <div class="text-[11px] font-medium text-slate-400 uppercase tracking-widest">Text Content</div>
                    <button class="px-2 py-1 rounded-md border border-white/10 text-[10px] text-slate-400 hover:text-white hover:bg-white/5 transition-colors" @click="copyContent(debugBodyData.text_content || '', 'debug-text-' + debugBodyData.message_id)">{{ copyStatus['debug-text-' + debugBodyData.message_id] ? 'Copied' : 'Copy' }}</button>
                  </div>
                  <pre class="rounded-xl border border-white/5 bg-white/[0.02] p-3 text-[12px] text-slate-200 whitespace-pre-wrap break-words font-mono">{{ debugBodyData.text_content || '—' }}</pre>
                </div>

                <div class="space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <div class="text-[11px] font-medium text-slate-400 uppercase tracking-widest">HTML Content</div>
                    <button class="px-2 py-1 rounded-md border border-white/10 text-[10px] text-slate-400 hover:text-white hover:bg-white/5 transition-colors" @click="copyContent(debugBodyData.html_content || '', 'debug-html-' + debugBodyData.message_id)">{{ copyStatus['debug-html-' + debugBodyData.message_id] ? 'Copied' : 'Copy' }}</button>
                  </div>
                  <pre class="rounded-xl border border-white/5 bg-white/[0.02] p-3 text-[12px] text-slate-200 whitespace-pre-wrap break-words font-mono">{{ debugBodyData.html_content || '—' }}</pre>
                </div>
              </template>
            </div>
          </div>
        </div>
      </main>
      <footer class="max-w-5xl mx-auto px-4 py-6 text-xs text-slate-400">
        <div class="flex items-center justify-between border-t border-white/10 pt-4">
          <span>© 2026 Temp Mail Admin</span>
          <a class="text-slate-300 hover:text-slate-100" href="https://github.com/beyoug/temp-mail-console" target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </footer>
    </div>

    <script>
      const { createApp } = Vue;
      const getThemeToggle = () => document.getElementById("theme-toggle");

      const readStoredTheme = () => {
        try {
          return localStorage.getItem("${THEME_STORAGE_KEY}") === "dark" ? "dark" : "light";
        } catch {
          return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
        }
      };

      const applyTheme = (theme) => {
        const nextTheme = theme === "dark" ? "dark" : "light";
        document.documentElement.dataset.theme = nextTheme;
        try {
          localStorage.setItem("${THEME_STORAGE_KEY}", nextTheme);
        } catch {}
        const themeToggle = getThemeToggle();
        if (themeToggle) {
          themeToggle.textContent = nextTheme === "dark" ? "浅色模式" : "暗色模式";
        }
      };

      applyTheme(readStoredTheme());

      createApp({
        data() {
          return {
            page: 1,
            total: 0,
            items: [],
            rules: [],
            rulesPage: 1,
            rulesTotal: 0,
            debugBodyRetentionDays: 0,
            newRule: { remark: "", sender_filter: "", pattern: "" },
            whitelistItems: [],
            whitelistPage: 1,
            whitelistTotal: 0,
            newWhitelist: "",
            activeTab: "emails",
            adminToken: "",
            adminError: "",
            poller: null,
            expandedResults: {},
            copyStatus: {},
            debugBodyModalOpen: false,
            debugBodyTarget: null,
            debugBodyData: null,
            debugBodyLoading: false,
            debugBodyError: ""
          };
        },
        computed: {
          totalPages() {
            return Math.max(1, Math.ceil(this.total / ${PAGE_SIZE}));
          },
          rulesTotalPages() {
            return Math.max(1, Math.ceil(this.rulesTotal / ${RULES_PAGE_SIZE}));
          },
          whitelistTotalPages() {
            return Math.max(1, Math.ceil(this.whitelistTotal / ${RULES_PAGE_SIZE}));
          }
        },
        mounted() {
          this.adminToken = getCookieValue("admin_token");
          if (!this.adminToken) return;
          this.loadList();
          this.loadRules();
          this.loadWhitelistData();
          this.startPolling();
        },
        beforeUnmount() {
          this.stopPolling();
        },
        methods: {
          startPolling() {
            this.stopPolling();
            this.poller = setInterval(() => {
              if (this.adminToken && this.activeTab === "emails") this.loadList();
            }, 5000);
          },
          stopPolling() {
            if (this.poller) { clearInterval(this.poller); this.poller = null; }
          },
          async handleAuthError(res) {
            if (res.status === 401) { this.clearAdminToken("密码不正确，请重试"); return true; }
            return false;
          },
          clearAdminToken(message) {
            this.adminToken = "";
            this.adminError = message || "";
            document.cookie = "admin_token=; Path=/; Max-Age=0; SameSite=Lax";
            this.stopPolling();
          },
          async requestJson(url, options = {}) {
            const res = await fetch(url, {
              ...options,
              headers: { ...this.adminHeaders(), ...(options.headers || {}) }
            });
            if (await this.handleAuthError(res)) return null;
            return res.json();
          },
          async loadList() {
            const payload = await this.requestJson("/admin/emails?page=" + this.page);
            if (!payload) return;
            const data = payload.data || {};
            this.items = data.items || [];
            this.total = data.total || 0;
            this.debugBodyRetentionDays = Number(data.debugBodyRetentionDays || 0);
          },
          async loadRules() {
            const payload = await this.requestJson("/admin/rules?page=" + this.rulesPage);
            if (!payload) return;
            const data = payload.data || {};
            this.rules = data.items || [];
            this.rulesTotal = data.total || 0;
          },
          async addRule() {
            if (!this.newRule.pattern) return;
            const payload = await this.requestJson("/admin/rules", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(this.newRule)
            });
            if (!payload) return;
            this.newRule = { remark: "", sender_filter: "", pattern: "" };
            this.rulesPage = 1;
            await this.loadRules();
          },
          async deleteRule(id) {
            const payload = await this.requestJson("/admin/rules/" + id, { method: "DELETE" });
            if (!payload) return;
            await this.loadRules();
            if (this.rules.length === 0 && this.rulesPage > 1) {
              this.rulesPage -= 1;
              await this.loadRules();
            }
          },
          adminHeaders() {
            return this.adminToken ? { Authorization: "Bearer " + this.adminToken } : {};
          },
          async nextPage() {
            if (this.page < this.totalPages) { this.page += 1; await this.loadList(); }
          },
          async prevPage() {
            if (this.page > 1) { this.page -= 1; await this.loadList(); }
          },
          async nextRulesPage() {
            if (this.rulesPage < this.rulesTotalPages) { this.rulesPage += 1; await this.loadRules(); }
          },
          async prevRulesPage() {
            if (this.rulesPage > 1) { this.rulesPage -= 1; await this.loadRules(); }
          },
          async loadWhitelistData() {
            const payload = await this.requestJson("/admin/whitelist?page=" + this.whitelistPage);
            if (!payload) return;
            const data = payload.data || {};
            this.whitelistItems = data.items || [];
            this.whitelistTotal = data.total || 0;
          },
          async addWhitelistEntry() {
            if (!this.newWhitelist.trim()) return;
            const payload = await this.requestJson("/admin/whitelist", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sender_pattern: this.newWhitelist.trim() })
            });
            if (!payload) return;
            this.newWhitelist = "";
            this.whitelistPage = 1;
            await this.loadWhitelistData();
          },
          async deleteWhitelistEntry(id) {
            const payload = await this.requestJson("/admin/whitelist/" + id, { method: "DELETE" });
            if (!payload) return;
            await this.loadWhitelistData();
          },
          async nextWhitelistPage() {
            if (this.whitelistPage < this.whitelistTotalPages) { this.whitelistPage += 1; await this.loadWhitelistData(); }
          },
          async prevWhitelistPage() {
            if (this.whitelistPage > 1) { this.whitelistPage -= 1; await this.loadWhitelistData(); }
          },
          toggleResult(messageId) {
            this.expandedResults[messageId] = !this.expandedResults[messageId];
          },
          async openDebugBody(item) {
            this.debugBodyTarget = item;
            this.debugBodyData = null;
            this.debugBodyError = "";
            this.debugBodyLoading = true;
            this.debugBodyModalOpen = true;

            try {
              const res = await fetch("/admin/emails/" + encodeURIComponent(item.message_id) + "/body", {
                headers: this.adminHeaders()
              });
              if (await this.handleAuthError(res)) return;

              const payload = await res.json().catch(() => null);
              if (!res.ok) {
                this.debugBodyError = payload?.message || "调试正文未保存或已过期";
                return;
              }

              this.debugBodyData = payload?.data || null;
            } catch (err) {
              console.error("Failed to load debug body:", err);
              this.debugBodyError = "加载调试正文失败";
            } finally {
              this.debugBodyLoading = false;
            }
          },
          closeDebugBody() {
            this.debugBodyModalOpen = false;
            this.debugBodyTarget = null;
            this.debugBodyData = null;
            this.debugBodyLoading = false;
            this.debugBodyError = "";
          },
          async copyContent(text, messageId) {
            try {
              await navigator.clipboard.writeText(text);
              this.copyStatus[messageId] = true;
              setTimeout(() => { this.copyStatus[messageId] = false; }, 2000);
            } catch (err) {
              console.error("Failed to copy:", err);
            }
          },
          hasResult(raw) {
            try {
              const parsed = JSON.parse(raw);
              return Array.isArray(parsed) && parsed.length > 0;
            } catch { return false; }
          },
          formatResult(raw) {
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                return JSON.stringify(parsed, null, 2);
              }
              return String(parsed ?? "");
            } catch { return raw || ""; }
          },
          formatDebugUrls(urls) {
            return Array.isArray(urls) && urls.length > 0 ? urls.join("\\n") : "—";
          },
          formatTime(ts) {
            return new Date(ts).toLocaleString();
          }
        }
      }).mount("#app");

      document.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest("#theme-toggle")) {
          applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
        }
      });

      function getCookieValue(name) {
        const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
        return match ? decodeURIComponent(match[1]) : "";
      }
    </script>
  </body>
</html>`;
}
