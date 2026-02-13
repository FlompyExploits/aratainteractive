import express from "express";
import multer from "multer";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import Stripe from "stripe";
import { Client, GatewayIntentBits, Partials, PermissionsBitField, REST, Routes } from "discord.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 3000,
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  REGISTER_COMMANDS,
  FOUNDERS_ROLE_ID,
  MANAGERS_ROLE_ID,
  GUILD_ID,
  APPLICATION_CHANNEL_ID,
  CONTACT_CHANNEL_ID,
  CONTACT_WEBHOOK_URL,
  PARTNER_WEBHOOK_URL,
  PARTNER_CHANNEL_ID,
  PARTNER_BASE_ROLE_ID,
  PARTNER_WELCOME_CHANNEL_ID,
  AUDIT_LOG_CHANNEL_ID,
  DEV_ROSTER_CHANNEL_ID,
  TEAM_SERVER_ID,
  DEV_ROLE_ID,
  ROLE_SCRIPTER_ID,
  ROLE_VFX_ID,
  ROLE_SFX_ID,
  ROLE_MODELER_ID,
  ROLE_ANIMATOR_ID,
  ROLE_GUI_ID,
  STRIPE_SECRET_KEY,
  STRIPE_PUBLISHABLE_KEY,
  STRIPE_AMOUNT_NAOYA,
  STRIPE_AMOUNT_LAPSE,
  STRIPE_AMOUNT_SUKUNA,
  DISCORD_WEBHOOK_URL,
  ALLOWED_ORIGINS,
  S3_ENDPOINT,
  S3_REGION = "auto",
  S3_BUCKET,
  S3_ACCESS_KEY,
  S3_SECRET_KEY,
  S3_PUBLIC_BASE
} = process.env;

const app = express();
const allowedOrigins = (ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const allowAllOrigins = allowedOrigins.includes("*");
const allowedHostnames = new Set(
  allowedOrigins
    .filter((o) => o !== "*")
    .map((o) => {
      try {
        return new URL(o).hostname;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
);
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin || allowAllOrigins) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    try {
      const host = new URL(origin).hostname;
      if (allowedHostnames.has(host)) return cb(null, true);
    } catch {}
    // Fail-open to stop /apply errors; tighten later if needed.
    return cb(null, true);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Key"]
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
app.use((req, _res, next) => {
  if (req.path === "/apply") {
    console.log("Apply request:", {
      method: req.method,
      origin: req.headers.origin || null,
      contentType: req.headers["content-type"] || null
    });
  }
  next();
});
app.use((err, _req, res, next) => {
  if (err?.message === "Not allowed by CORS") {
    return res.status(403).json({ ok: false, error: "Not allowed by CORS" });
  }
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ ok: false, error: "File too large" });
  }
  return next(err);
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 7 * 1024 * 1024 }
});
const formOnly = multer();

const dataDir = path.join(__dirname, "data");
const appsFile = path.join(dataDir, "applications.json");
const partnerFile = path.join(dataDir, "partners.json");
const instantInvitesFile = path.join(dataDir, "instant_invites.json");
const auditLogFile = path.join(dataDir, "audit.log");
const rosterStateFile = path.join(dataDir, "dev_roster.json");
const runtimeState = {
  apply: { lastSuccessAt: null, lastErrorAt: null, lastError: null },
  contact: { lastSuccessAt: null, lastErrorAt: null, lastError: null }
};

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(appsFile)) fs.writeFileSync(appsFile, JSON.stringify({}));
if (!fs.existsSync(partnerFile)) fs.writeFileSync(partnerFile, JSON.stringify({}));
if (!fs.existsSync(instantInvitesFile)) fs.writeFileSync(instantInvitesFile, JSON.stringify({}));
if (!fs.existsSync(auditLogFile)) fs.writeFileSync(auditLogFile, "");
if (!fs.existsSync(rosterStateFile)) fs.writeFileSync(rosterStateFile, JSON.stringify({}));

const loadApplications = () => JSON.parse(fs.readFileSync(appsFile, "utf-8") || "{}");
const saveApplications = (data) => fs.writeFileSync(appsFile, JSON.stringify(data, null, 2));
const loadPartners = () => JSON.parse(fs.readFileSync(partnerFile, "utf-8") || "{}");
const savePartners = (data) => fs.writeFileSync(partnerFile, JSON.stringify(data, null, 2));
const loadInstantInvites = () => JSON.parse(fs.readFileSync(instantInvitesFile, "utf-8") || "{}");
const saveInstantInvites = (data) => fs.writeFileSync(instantInvitesFile, JSON.stringify(data, null, 2));
const loadRosterState = () => JSON.parse(fs.readFileSync(rosterStateFile, "utf-8") || "{}");
const saveRosterState = (data) => fs.writeFileSync(rosterStateFile, JSON.stringify(data, null, 2));

const logEnvDiagnostics = () => {
  const checks = [
    ["DISCORD_BOT_TOKEN", Boolean(DISCORD_BOT_TOKEN), "Bot/login + channel mode"],
    ["APPLICATION_CHANNEL_ID", Boolean(APPLICATION_CHANNEL_ID), "Apply via bot channel"],
    ["DISCORD_WEBHOOK_URL", Boolean(DISCORD_WEBHOOK_URL), "Apply via webhook fallback"],
    ["CONTACT_CHANNEL_ID", Boolean(INQUIRY_CHANNEL_ID), "Contact via bot channel"],
    ["CONTACT_WEBHOOK_URL", Boolean(CONTACT_WEBHOOK_URL), "Contact via webhook fallback"],
    ["PARTNER_WEBHOOK_URL", Boolean(PARTNER_WEBHOOK_URL), "Partner via webhook"],
    ["PARTNER_CHANNEL_ID", Boolean(PARTNER_REQUEST_CHANNEL_ID), "Partner via bot channel"],
    ["PARTNER_BASE_ROLE_ID", Boolean(PARTNER_ROLE_ID), "Partner base role for accepted partners"],
    ["PARTNER_WELCOME_CHANNEL_ID", Boolean(PARTNER_WELCOME_CH_ID), "Partner welcome ping channel"],
    ["AUDIT_LOG_CHANNEL_ID", Boolean(AUDIT_CHANNEL_ID), "Audit log channel"],
    ["DEV_ROSTER_CHANNEL_ID", Boolean(ROSTER_CHANNEL_ID), "Developer roster channel"],
    ["S3 config", Boolean(S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY && S3_SECRET_KEY), "Resume URL storage"]
  ];
  checks.forEach(([name, ok, note]) => {
    const level = ok ? "OK" : "WARN";
    console.log(`[env:${level}] ${name} - ${note}`);
  });
};

const badWords = [
  "fuck", "shit", "bitch", "nigger", "faggot", "cunt", "retard", "whore", "slut"
];

const containsBadWords = (text) => {
  const lower = (text || "").toLowerCase();
  return badWords.some((w) => lower.includes(w));
};

const isValidEmail = (email) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

const s3Client = (S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY && S3_SECRET_KEY)
  ? new S3Client({
      region: S3_REGION,
      endpoint: S3_ENDPOINT,
      credentials: {
        accessKeyId: S3_ACCESS_KEY,
        secretAccessKey: S3_SECRET_KEY
      }
    })
  : null;

const TEAM_GUILD_ID = TEAM_SERVER_ID || "1467936384525406332";
const DEV_ROLE = DEV_ROLE_ID || "1468017823585538237";
const ROLE_MAP = {
  Programmer: ROLE_SCRIPTER_ID || "1468017643662344253",
  Scripter: ROLE_SCRIPTER_ID || "1468017643662344253",
  VFX: ROLE_VFX_ID || "1468017710821802040",
  SFX: ROLE_SFX_ID || "1468017740853018827",
  Modeler: ROLE_MODELER_ID || "1468017772264030271",
  Animator: ROLE_ANIMATOR_ID || "1468018032831107245",
  "Gui Artist": ROLE_GUI_ID || "1468018100312997952",
  "UI/UX": ROLE_GUI_ID || "1468018100312997952"
};
const ROLE_LABEL_MAP = {
  programmer: "Scripter",
  scripter: "Scripter",
  vfx: "VFX Artist",
  sfx: "SFX Artist",
  modeler: "Modeler",
  animator: "Animator",
  "gui artist": "GUI Artist",
  "ui/ux": "GUI Artist"
};
const OWNER_NOTIFY_USER_ID = "718594927998533662";
const MAIN_SERVER_LINK = "https://discord.gg/JjPuB9Ue2q";
const INQUIRY_CHANNEL_ID = CONTACT_CHANNEL_ID || "1468028979666751707";
const PARTNER_REQUEST_CHANNEL_ID = PARTNER_CHANNEL_ID || "1471770824573714432";
const PARTNER_ROLE_ID = PARTNER_BASE_ROLE_ID || "1471787925531267092";
const PARTNER_WELCOME_CH_ID = PARTNER_WELCOME_CHANNEL_ID || "1471788287923454056";
const MAIN_ARATA_DEVELOPER_ROLE_ID = "1467459331518632076";
const AUDIT_CHANNEL_ID = AUDIT_LOG_CHANNEL_ID || "1471800781349978212";
const ROSTER_CHANNEL_ID = DEV_ROSTER_CHANNEL_ID || AUDIT_CHANNEL_ID;
const PARTNER_COLOR_PRESETS = {
  red: "#ef4444",
  orange: "#f97316",
  yellow: "#eab308",
  green: "#22c55e",
  cyan: "#06b6d4",
  blue: "#3b82f6",
  purple: "#8b5cf6",
  pink: "#ec4899",
  white: "#f8fafc",
  gray: "#94a3b8"
};
const commandLastUse = new Map();
const commandCooldownMs = {
  ping: 3000,
  botstatus: 5000,
  appstatus: 5000,
  reply: 8000,
  dmuser: 12000,
  setappstatus: 6000,
  resendinvite: 12000,
  lookupdiscord: 6000,
  partnerstatus: 5000,
  partnerrolefix: 7000,
  partnerremove: 7000,
  devskillsrefresh: 6000,
  instinv: 7000,
  kickmem: 7000
};

const invitesCache = new Map();
let applicationChannel = null;

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" }) : null;
const PRODUCT_PRICE_MAP = {
  naoya: {
    name: "Naoya Animation",
    amount: Number(STRIPE_AMOUNT_NAOYA || 1000),
    currency: "usd"
  },
  lapse: {
    name: "Lapse Blue Animation",
    amount: Number(STRIPE_AMOUNT_LAPSE || 1000),
    currency: "usd"
  },
  sukuna: {
    name: "Sukuna Domain Animation",
    amount: Number(STRIPE_AMOUNT_SUKUNA || 1500),
    currency: "usd"
  }
};

const uploadResume = async (file, applicantName) => {
  if (!s3Client) return null;
  const safeName = applicantName.replace(/[^a-z0-9\\-_.]/gi, "_");
  const key = `resumes/${Date.now()}_${safeName}_${file.originalname}`;
  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype
  });
  await s3Client.send(command);
  if (S3_PUBLIC_BASE) return `${S3_PUBLIC_BASE}/${key}`;
  return key;
};

const refreshInvitesCache = async () => {
  try {
    const guild = await client.guilds.fetch(TEAM_GUILD_ID);
    const invites = await guild.invites.fetch();
    invitesCache.clear();
    invites.forEach((inv) => invitesCache.set(inv.code, inv.uses ?? 0));
  } catch (e) {
    console.error("Invite cache refresh failed:", e?.message || e);
  }
};

const extractDiscordIdFromMessage = (msg) => {
  if (!msg) return null;
  const idRegex = /\b\d{17,20}\b/;
  const embeds = Array.isArray(msg.embeds) ? msg.embeds : [];
  for (const embed of embeds) {
    const fields = Array.isArray(embed.fields) ? embed.fields : [];
    for (const field of fields) {
      const value = String(field?.value || "");
      const match = value.match(idRegex);
      if (match) return match[0];
    }
    const descMatch = String(embed?.description || "").match(idRegex);
    if (descMatch) return descMatch[0];
  }
  const contentMatch = String(msg.content || "").match(idRegex);
  return contentMatch ? contentMatch[0] : null;
};

const withTimeout = (promise, ms, code) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    const err = new Error(code || "operation_timeout");
    err.code = code || "operation_timeout";
    reject(err);
  }, ms);
  promise
    .then((val) => {
      clearTimeout(timer);
      resolve(val);
    })
    .catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
});

const parseDiscordInviteCode = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      const parts = u.pathname.split("/").filter(Boolean);
      if (u.hostname.includes("discord.gg") && parts[0]) return parts[0];
      if (u.hostname.includes("discord.com") && parts[0] === "invite" && parts[1]) return parts[1];
      return null;
    }
    return raw.replace(/^invite\//i, "");
  } catch {
    return null;
  }
};

const toPartnerRoleName = (serverName) => {
  const cleaned = String(serverName || "")
    .replace(/[^\w !\-()[\].]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!cleaned) return "Partner Server";
  return cleaned.slice(0, 95);
};

const parsePartnerColorInput = (raw) => {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return null;
  if (PARTNER_COLOR_PRESETS[value]) return PARTNER_COLOR_PRESETS[value];
  const hex = value.startsWith("#") ? value : `#${value}`;
  if (/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  return null;
};

const getAcceptedPartnerByUserId = (userId) => {
  const partners = loadPartners();
  const entries = Object.entries(partners);
  const match = entries
    .map(([messageId, data]) => ({ messageId, data }))
    .reverse()
    .find((item) => item.data?.requesterUserId === userId && item.data?.status === "accepted");
  return match || null;
};

const setAcceptedPartnerRoleColor = async (userId, colorHex) => {
  const accepted = getAcceptedPartnerByUserId(userId);
  if (!accepted) return { ok: false, error: "no_accepted_partner" };

  const roleName = accepted.data?.roleName || toPartnerRoleName(accepted.data?.serverName);
  const guild = await resolvePartnerTargetGuild();
  if (!guild) return { ok: false, error: "guild_not_found" };

  const role = guild.roles.cache.find((r) => r.name.toLowerCase() === String(roleName).toLowerCase());
  if (!role) return { ok: false, error: "role_not_found" };

  await role.setColor(colorHex, `Partner color set by ${userId}`);

  const partners = loadPartners();
  if (partners[accepted.messageId]) {
    partners[accepted.messageId].roleName = role.name;
    partners[accepted.messageId].roleColor = colorHex;
    savePartners(partners);
  }

  return { ok: true, roleName: role.name, roleColor: colorHex };
};

const appendAuditLog = async (eventType, payload = {}, actorId = null) => {
  const entry = {
    ts: new Date().toISOString(),
    eventType,
    actorId,
    ...payload
  };
  fs.appendFileSync(auditLogFile, `${JSON.stringify(entry)}\n`);
  if (!AUDIT_CHANNEL_ID || !client.isReady()) return;
  try {
    const ch = await client.channels.fetch(AUDIT_CHANNEL_ID);
    if (ch?.isTextBased?.()) {
      const summary = Object.entries(payload)
        .slice(0, 6)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join("\n");
      await ch.send(
        `Audit: ${eventType}\n` +
        `Actor: ${actorId ? `<@${actorId}>` : "system"}\n` +
        (summary ? `${summary}` : "")
      );
    }
  } catch (e) {
    console.error("Audit channel send failed:", e?.message || e);
  }
};

const findPartnerEntry = (query) => {
  const partners = loadPartners();
  const q = String(query || "").trim();
  const entries = Object.entries(partners).map(([messageId, data]) => ({ messageId, data }));
  const byRequestId = entries.find((e) => e.data?.requestId === q);
  if (byRequestId) return { partners, match: byRequestId };
  const byUserId = entries
    .filter((e) => e.data?.requesterUserId === q)
    .sort((a, b) => (a.data?.requestId || "").localeCompare(b.data?.requestId || ""))
    .pop();
  if (byUserId) return { partners, match: byUserId };
  return { partners, match: null };
};

const resolveRoleInGuild = async (guild, roleInput) => {
  const raw = String(roleInput || "").trim();
  if (!raw) return null;
  const mentionMatch = raw.match(/^<@&(\d{17,20})>$/);
  const roleId = mentionMatch ? mentionMatch[1] : (/^\d{17,20}$/.test(raw) ? raw : null);
  if (roleId) {
    return guild.roles.fetch(roleId).catch(() => null);
  }
  const byName = guild.roles.cache.find((r) => r.name.toLowerCase() === raw.toLowerCase());
  return byName || null;
};

const removePartnerRoles = async (partnerData) => {
  const guild = await resolvePartnerTargetGuild();
  if (!guild) return { ok: false, error: "guild_not_found" };
  const member = await guild.members.fetch(partnerData.requesterUserId).catch(() => null);
  const roleName = partnerData.roleName || toPartnerRoleName(partnerData.serverName);
  const customRole = guild.roles.cache.find((r) => r.name.toLowerCase() === String(roleName).toLowerCase()) || null;
  const roleIds = [PARTNER_ROLE_ID, customRole?.id].filter(Boolean);
  if (member && roleIds.length) {
    await member.roles.remove(roleIds, "Partner removed");
  }
  if (customRole && customRole.members.size === 0) {
    await customRole.delete("Partner removed and no members left").catch(() => {});
  }
  return { ok: true, removedRoleName: customRole?.name || roleName, hadMember: Boolean(member) };
};

const mapRoleToSkill = (roleName) => {
  const name = String(roleName || "").toLowerCase();
  if (name.includes("script") || name.includes("program")) return "Scripting";
  if (name.includes("vfx")) return "VFX";
  if (name.includes("sfx")) return "SFX";
  if (name.includes("anim")) return "Animation";
  if (name.includes("gui") || name.includes("ui")) return "GUI / UI";
  if (name.includes("map")) return "Map Making";
  if (name.includes("model")) return "Modeling";
  if (name.includes("graphic")) return "Graphic Arts";
  if (name.includes("hr")) return "HR";
  return null;
};

const buildDeveloperRosterText = async (guild) => {
  const members = await guild.members.fetch();
  const rows = [];
  members.forEach((m) => {
    if (m.user?.bot) return;
    const roleNames = m.roles.cache
      .filter((r) => r.id !== guild.id)
      .map((r) => r.name);
    const skills = [...new Set(roleNames.map(mapRoleToSkill).filter(Boolean))];
    const hasDevMarker =
      m.roles.cache.has(DEV_ROLE) ||
      roleNames.some((name) => /(script|program|vfx|sfx|anim|gui|ui|map|model|graphic|hr)/i.test(name));
    if (!hasDevMarker) return;
    rows.push({ id: m.id, skills });
  });
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const lines = [
    "━━━━━━━━━━━━━━━━━━━━",
    "TEAM ROSTER",
    "━━━━━━━━━━━━━━━━━━━━"
  ];
  for (const row of rows) {
    lines.push(`<@${row.id}> — ${row.skills.length ? row.skills.join(", ") : "Developer"}`);
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
};

const refreshDeveloperRoster = async (reason = "manual", actorId = null) => {
  if (!client.isReady() || !ROSTER_CHANNEL_ID) return { ok: false, error: "roster_channel_not_configured" };
  const channel = await client.channels.fetch(ROSTER_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased?.()) return { ok: false, error: "roster_channel_invalid" };
  const guild = channel.guild;
  if (!guild) return { ok: false, error: "roster_guild_not_found" };
  const text = await buildDeveloperRosterText(guild);
  const state = loadRosterState();
  const key = String(guild.id);
  let message = null;
  if (state[key]?.messageId) {
    message = await channel.messages.fetch(state[key].messageId).catch(() => null);
  }
  if (message) {
    await message.edit(text);
  } else {
    const sent = await channel.send(text);
    state[key] = { channelId: channel.id, messageId: sent.id };
    saveRosterState(state);
  }
  await appendAuditLog("dev_roster_refresh", { reason, channelId: channel.id }, actorId);
  return { ok: true, channelId: channel.id };
};

const resolvePartnerTargetGuild = async () => {
  if (!PARTNER_WELCOME_CH_ID) return null;
  const welcomeChannel = await client.channels.fetch(PARTNER_WELCOME_CH_ID).catch(() => null);
  if (!welcomeChannel?.guild) return null;
  return welcomeChannel.guild;
};

const assignPartnerRoles = async (partnerData) => {
  const guild = await resolvePartnerTargetGuild();
  if (!guild) return { assigned: false, reason: "welcome_channel_not_found", roleName: toPartnerRoleName(partnerData.serverName) };

  const roleName = toPartnerRoleName(partnerData.serverName);
  const member = await guild.members.fetch(partnerData.requesterUserId).catch(() => null);
  if (!member) return { assigned: false, reason: "member_not_in_main_server", roleName };

  const basePartnerRole = PARTNER_ROLE_ID ? await guild.roles.fetch(PARTNER_ROLE_ID).catch(() => null) : null;
  let serverRole = guild.roles.cache.find((r) => r.name.toLowerCase() === roleName.toLowerCase()) || null;
  if (!serverRole) {
    serverRole = await guild.roles.create({
      name: roleName,
      permissions: new PermissionsBitField(0n),
      hoist: false,
      mentionable: false,
      reason: `Partner accepted: ${partnerData.serverName}`
    });
    if (basePartnerRole) {
      const targetPosition = Math.max(1, basePartnerRole.position - 1);
      await serverRole.setPosition(targetPosition).catch(() => {});
    }
  }

  const rolesToAdd = [];
  if (basePartnerRole) rolesToAdd.push(basePartnerRole.id);
  if (serverRole) rolesToAdd.push(serverRole.id);
  if (rolesToAdd.length) {
    await member.roles.add(rolesToAdd, "Partner request accepted");
  }

  const welcomeChannel = PARTNER_WELCOME_CH_ID
    ? await guild.channels.fetch(PARTNER_WELCOME_CH_ID).catch(() => null)
    : null;
  if (welcomeChannel?.isTextBased?.()) {
    await welcomeChannel.send(
      `You have been roled Partner role and ${roleName} role! Welcome <@${partnerData.requesterUserId}>`
    );
  }

  return { assigned: true, reason: null, roleName, guildId: guild.id };
};

const fetchInviteCounts = async (inviteCode) => {
  if (!inviteCode) return null;
  try {
    const res = await axios.get(`https://discord.com/api/v10/invites/${inviteCode}?with_counts=true`, {
      timeout: 8000
    });
    return {
      memberCount: res.data?.approximate_member_count ?? null,
      onlineCount: res.data?.approximate_presence_count ?? null
    };
  } catch {
    return null;
  }
};

const resolveApplicationByMessageId = async (msgId, guild, knownChannel = null) => {
  const apps = loadApplications();
  if (apps[msgId]) return { appData: apps[msgId], source: "applications.json" };
  const candidateChannels = [];
  if (knownChannel && knownChannel.isTextBased?.()) {
    candidateChannels.push(knownChannel);
  }
  for (const ch of guild.channels.cache.values()) {
    if (!ch?.isTextBased?.()) continue;
    if (candidateChannels.find((c) => c.id === ch.id)) continue;
    candidateChannels.push(ch);
    if (candidateChannels.length >= 40) break;
  }
  for (const sourceChannel of candidateChannels) {
    try {
      const sourceMsg = await sourceChannel.messages.fetch(msgId);
      const inferredDiscordId = extractDiscordIdFromMessage(sourceMsg);
      if (inferredDiscordId) {
        return {
          appData: {
            discord_id: inferredDiscordId,
            discord_username: "Unknown",
            email: "Unknown"
          },
          source: `channel:${sourceChannel.id}`
        };
      }
    } catch {
      // continue
    }
  }
  return null;
};

app.post("/apply", upload.single("resume"), async (req, res) => {
  try {
    const startedAt = Date.now();
    if (!APPLICATION_CHANNEL_ID && !DISCORD_WEBHOOK_URL) {
      return res.status(500).json({ ok: false, error: "Application destination not configured" });
    }
    if (!client.isReady() && !DISCORD_WEBHOOK_URL) {
      return res.status(503).json({ ok: false, error: "Bot not ready, try again shortly" });
    }

    const {
      name = "",
      email = "",
      discord_username = "",
      discord_id = "",
      position = "",
      message = ""
    } = req.body || {};
    const cleanName = String(name).trim();
    const cleanEmail = String(email).trim();
    const cleanDiscordUsername = String(discord_username).trim();
    const cleanDiscordId = String(discord_id).trim();
    const cleanPosition = String(position).trim();
    const cleanMessage = String(message).trim();

    if (!cleanName || !cleanEmail || !cleanDiscordUsername || !cleanDiscordId || !cleanPosition || !cleanMessage) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }
    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({ ok: false, error: "Invalid email" });
    }
    if (!/^\d{17,20}$/.test(cleanDiscordId)) {
      return res.status(400).json({ ok: false, error: "Invalid Discord ID (must be 17-20 digits)" });
    }
    if (containsBadWords(cleanName) || containsBadWords(cleanMessage)) {
      return res.status(400).json({ ok: false, error: "Inappropriate content detected" });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Resume required" });
    }

    let resumeUrl = null;
    if (s3Client) {
      try {
        console.log("Apply resume upload start");
        resumeUrl = await withTimeout(uploadResume(req.file, cleanName), 15_000, "resume_upload_timeout");
        console.log("Apply resume upload ok");
      } catch (uploadErr) {
        console.error("Resume upload failed:", uploadErr?.name, uploadErr?.message || uploadErr);
        return res.status(500).json({ ok: false, error: "Resume upload failed (check S3 settings)" });
      }
    }

    const roleMentions = [FOUNDERS_ROLE_ID, MANAGERS_ROLE_ID]
      .filter(Boolean)
      .map((id) => `<@&${id}>`)
      .join(" ");
    const content = roleMentions ? `${roleMentions}\nNew application submitted` : "New application submitted";
    const embed = {
      title: "New Arata Application",
      color: 0x2d8cff,
      fields: [
        { name: "Name", value: cleanName, inline: true },
        { name: "Email", value: cleanEmail, inline: true },
        { name: "Discord", value: `${cleanDiscordUsername} (ID: ${cleanDiscordId})`, inline: false },
        { name: "Position", value: cleanPosition, inline: true },
        { name: "Resume", value: resumeUrl || "Attached in Discord message", inline: false },
        { name: "Message", value: `\`\`\`\n${cleanMessage}\n\`\`\`` }
      ],
      footer: { text: `Applicant ID: ${cleanDiscordId}` }
    };

    let msgId = null;
    const canUseBotChannel = client.isReady() && APPLICATION_CHANNEL_ID;
    if (canUseBotChannel) {
      if (!applicationChannel) {
        console.log("Apply fetch application channel start");
        const channel = await client.channels.fetch(APPLICATION_CHANNEL_ID);
        if (!channel || !channel.isTextBased?.()) {
          return res.status(500).json({ ok: false, error: "Application channel invalid" });
        }
        applicationChannel = channel;
      }

      console.log("Apply discord channel send start");
      const response = await withTimeout(
        applicationChannel.send({
          content,
          embeds: [embed],
          files: req.file ? [{
            attachment: req.file.buffer,
            name: req.file.originalname
          }] : []
        }),
        12_000,
        "discord_channel_send_timeout"
      );
      msgId = response?.id || null;
    } else if (DISCORD_WEBHOOK_URL) {
      if (!resumeUrl) {
        return res.status(500).json({
          ok: false,
          error: "S3 is required when using webhook mode for resumes"
        });
      }
      const webhookPayload = {
        content,
        embeds: [embed],
        allowed_mentions: { parse: [] }
      };
      console.log("Apply discord webhook send start");
      const webhookResponse = await withTimeout(
        axios.post(
          DISCORD_WEBHOOK_URL.includes("?")
            ? `${DISCORD_WEBHOOK_URL}&wait=true`
            : `${DISCORD_WEBHOOK_URL}?wait=true`,
          webhookPayload,
          { timeout: 10_000 }
        ),
        12_000,
        "discord_webhook_timeout"
      );
      msgId = webhookResponse?.data?.id || null;
    } else {
      return res.status(503).json({ ok: false, error: "Bot not ready and webhook not configured" });
    }
    if (!msgId) {
      return res.status(500).json({ ok: false, error: "Discord did not return a message id" });
    }
    if (msgId) {
      const apps = loadApplications();
      apps[msgId] = {
        name: cleanName,
        email: cleanEmail,
        discord_username: cleanDiscordUsername,
        discord_id: cleanDiscordId,
        position: cleanPosition,
        resumeUrl: resumeUrl || `attachment:${req.file.originalname}`,
        status: "pending"
      };
      saveApplications(apps);
    }

    console.log("Apply success:", { messageId: msgId, hasS3Resume: Boolean(resumeUrl), ms: Date.now() - startedAt });
    runtimeState.apply.lastSuccessAt = new Date().toISOString();
    runtimeState.apply.lastErrorAt = null;
    runtimeState.apply.lastError = null;
    res.json({ ok: true });
  } catch (err) {
    console.error("Apply failed:", err?.response?.status, err?.response?.data || err?.message || err);
    runtimeState.apply.lastErrorAt = new Date().toISOString();
    runtimeState.apply.lastError = String(err?.response?.data?.message || err?.message || err?.code || "unknown_apply_error");
    const status = err?.response?.status;
    if (status === 429 || status === 1015) {
      return res.status(503).json({ ok: false, error: "Discord rate limit, try again shortly" });
    }
    if (DISCORD_WEBHOOK_URL && status === 404) {
      return res.status(500).json({ ok: false, error: "Discord webhook not found (check DISCORD_WEBHOOK_URL)" });
    }
    if (DISCORD_WEBHOOK_URL && (status === 401 || status === 403)) {
      return res.status(500).json({ ok: false, error: "Discord webhook unauthorized (invalid webhook URL/token)" });
    }
    if (
      err?.name === "InvalidAccessKeyId" ||
      err?.name === "SignatureDoesNotMatch" ||
      err?.name === "CredentialsProviderError"
    ) {
      return res.status(500).json({ ok: false, error: "S3 credentials are invalid" });
    }
    if (
      String(err?.code || "").includes("ECONN") ||
      String(err?.code || "").includes("ETIMEDOUT") ||
      String(err?.name || "").includes("Timeout") ||
      String(err?.code || "").includes("timeout")
    ) {
      return res.status(503).json({ ok: false, error: "Network timeout talking to Discord/S3" });
    }
    res.status(500).json({ ok: false, error: "Failed to send application" });
  }
});

app.get("/apply", (_req, res) => {
  res.status(405).json({
    ok: false,
    error: "Use POST /apply with multipart/form-data"
  });
});

app.post("/contact", formOnly.none(), async (req, res) => {
  try {
    const {
      name = "",
      email = "",
      discord_id = "",
      topic = "",
      message = "",
      inquiry_type = "General Inquiry"
    } = req.body || {};

    const cleanName = String(name).trim();
    const cleanEmail = String(email).trim();
    const cleanDiscordId = String(discord_id).trim();
    const cleanTopic = String(topic).trim();
    const cleanMessage = String(message).trim();
    const cleanInquiryType = String(inquiry_type).trim() || "General Inquiry";

    if (!cleanName || !cleanEmail || !cleanTopic || !cleanMessage) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }
    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({ ok: false, error: "Invalid email" });
    }
    if (cleanDiscordId && !/^\d{17,20}$/.test(cleanDiscordId)) {
      return res.status(400).json({ ok: false, error: "Invalid Discord ID" });
    }
    if (containsBadWords(`${cleanName} ${cleanTopic} ${cleanMessage}`)) {
      return res.status(400).json({ ok: false, error: "Message contains prohibited language" });
    }

    const roleMentions = [FOUNDERS_ROLE_ID, MANAGERS_ROLE_ID]
      .filter(Boolean)
      .map((id) => `<@&${id}>`)
      .join(" ");
    const content = roleMentions ? `${roleMentions}\nNew inquiry submitted` : "New inquiry submitted";
    const embed = {
      title: "New Inquiry",
      color: 0x58b2ff,
      fields: [
        { name: "Name", value: cleanName, inline: true },
        { name: "Email", value: cleanEmail, inline: true },
        { name: "Inquiry Type", value: cleanInquiryType, inline: true },
        { name: "Topic", value: cleanTopic, inline: true },
        { name: "Discord ID", value: cleanDiscordId || "N/A", inline: true },
        { name: "Message", value: `\`\`\`\n${cleanMessage}\n\`\`\`` }
      ]
    };

    if (client.isReady() && INQUIRY_CHANNEL_ID) {
      const channel = await client.channels.fetch(INQUIRY_CHANNEL_ID);
      if (!channel || !channel.isTextBased?.()) {
        return res.status(500).json({ ok: false, error: "Contact channel invalid" });
      }
      const response = await withTimeout(
        channel.send({
          content,
          embeds: [embed]
        }),
        12_000,
        "discord_contact_send_timeout"
      );
      runtimeState.contact.lastSuccessAt = new Date().toISOString();
      runtimeState.contact.lastErrorAt = null;
      runtimeState.contact.lastError = null;
      return res.json({ ok: true, messageId: response?.id || null });
    }

    if (CONTACT_WEBHOOK_URL) {
      const webhookPayload = {
        username: "Arata Contact",
        content,
        embeds: [embed],
        allowed_mentions: { parse: roleMentions ? ["roles"] : [] }
      };
      await withTimeout(
        axios.post(
          CONTACT_WEBHOOK_URL.includes("?")
            ? `${CONTACT_WEBHOOK_URL}&wait=true`
            : `${CONTACT_WEBHOOK_URL}?wait=true`,
          webhookPayload,
          { timeout: 10_000 }
        ),
        12_000,
        "contact_webhook_timeout"
      );
      runtimeState.contact.lastSuccessAt = new Date().toISOString();
      runtimeState.contact.lastErrorAt = null;
      runtimeState.contact.lastError = null;
      return res.json({ ok: true });
    }

    return res.status(500).json({ ok: false, error: "Contact destination not configured" });
  } catch (err) {
    console.error("Contact failed:", err?.response?.status, err?.response?.data || err?.message || err);
    runtimeState.contact.lastErrorAt = new Date().toISOString();
    runtimeState.contact.lastError = String(err?.response?.data?.message || err?.message || err?.code || "unknown_contact_error");
    return res.status(500).json({ ok: false, error: "Failed to send message" });
  }
});

app.post("/partner-apply", formOnly.none(), async (req, res) => {
  try {
    if (!PARTNER_REQUEST_CHANNEL_ID && !PARTNER_WEBHOOK_URL) {
      return res.status(500).json({ ok: false, error: "Partner destination not configured" });
    }
    if (!client.isReady() && !PARTNER_WEBHOOK_URL) {
      return res.status(503).json({ ok: false, error: "Bot not ready, try again shortly" });
    }

    const {
      server_link = "",
      username = "",
      user_id = "",
      reason = "",
      server_name = "",
      member_count = "",
      activity = ""
    } = req.body || {};

    const cleanServerLink = String(server_link).trim();
    const cleanUsername = String(username).trim();
    const cleanUserId = String(user_id).trim();
    const cleanReason = String(reason).trim();
    const cleanServerName = String(server_name).trim();
    const cleanMemberCount = String(member_count).trim();
    const cleanActivity = String(activity).trim();

    if (!cleanServerLink || !cleanUsername || !cleanUserId || !cleanReason || !cleanServerName) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }
    if (!/^\d{17,20}$/.test(cleanUserId)) {
      return res.status(400).json({ ok: false, error: "Invalid user ID (must be 17-20 digits)" });
    }
    if (containsBadWords(`${cleanUsername} ${cleanReason} ${cleanServerName}`)) {
      return res.status(400).json({ ok: false, error: "Inappropriate content detected" });
    }

    const inviteCode = parseDiscordInviteCode(cleanServerLink);
    const inviteCounts = await fetchInviteCounts(inviteCode);
    const generatedId = `PR-${Date.now().toString(36)}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const roleMentions = [FOUNDERS_ROLE_ID, MANAGERS_ROLE_ID]
      .filter(Boolean)
      .map((id) => `<@&${id}>`)
      .join(" ");
    const content = roleMentions ? `${roleMentions}\nNew partner request` : "New partner request";
    const embed = {
      title: "Partner Application",
      color: 0x7aa2ff,
      fields: [
        { name: "Server Name", value: cleanServerName, inline: true },
        { name: "Requester", value: cleanUsername, inline: true },
        { name: "Requester ID", value: cleanUserId, inline: true },
        { name: "Server Link", value: cleanServerLink, inline: false },
        { name: "Why Partner", value: `\`\`\`\n${cleanReason}\n\`\`\``, inline: false },
        { name: "Member Count (provided)", value: cleanMemberCount || "N/A", inline: true },
        { name: "Activity (provided)", value: cleanActivity || "N/A", inline: true },
        { name: "Member Count (detected)", value: String(inviteCounts?.memberCount ?? "N/A"), inline: true },
        { name: "Activity (detected online)", value: String(inviteCounts?.onlineCount ?? "N/A"), inline: true },
        { name: "Partner Request ID", value: generatedId, inline: false }
      ],
      footer: { text: `Requester User ID: ${cleanUserId}` }
    };

    let messageId = null;
    if (client.isReady() && PARTNER_REQUEST_CHANNEL_ID) {
      const channel = await client.channels.fetch(PARTNER_REQUEST_CHANNEL_ID);
      if (!channel || !channel.isTextBased?.()) {
        return res.status(500).json({ ok: false, error: "Partner channel invalid" });
      }
      const response = await withTimeout(
        channel.send({
          content,
          embeds: [embed],
          allowed_mentions: { parse: roleMentions ? ["roles"] : [] }
        }),
        12_000,
        "partner_channel_send_timeout"
      );
      messageId = response?.id || null;
    } else if (PARTNER_WEBHOOK_URL) {
      const webhookResponse = await withTimeout(
        axios.post(
          PARTNER_WEBHOOK_URL.includes("?")
            ? `${PARTNER_WEBHOOK_URL}&wait=true`
            : `${PARTNER_WEBHOOK_URL}?wait=true`,
          {
            username: "Arata Partner",
            content,
            embeds: [embed],
            allowed_mentions: { parse: roleMentions ? ["roles"] : [] }
          },
          { timeout: 10_000 }
        ),
        12_000,
        "partner_webhook_timeout"
      );
      messageId = webhookResponse?.data?.id || null;
    }

    if (!messageId) return res.status(500).json({ ok: false, error: "Partner destination did not return message id" });
    const partners = loadPartners();
    partners[messageId] = {
      requestId: generatedId,
      requesterUsername: cleanUsername,
      requesterUserId: cleanUserId,
      serverName: cleanServerName,
      serverLink: cleanServerLink,
      reason: cleanReason,
      memberCountProvided: cleanMemberCount || null,
      activityProvided: cleanActivity || null,
      memberCountDetected: inviteCounts?.memberCount ?? null,
      activityDetected: inviteCounts?.onlineCount ?? null,
      status: "pending",
      acceptedBy: null
    };
    savePartners(partners);
    await appendAuditLog("partner_request_submitted", {
      requestId: generatedId,
      requesterUserId: cleanUserId,
      requesterUsername: cleanUsername,
      serverName: cleanServerName,
      messageId
    });
    return res.json({ ok: true, messageId, partnerRequestId: generatedId });
  } catch (err) {
    console.error("Partner apply failed:", err?.response?.status, err?.response?.data || err?.message || err);
    return res.status(500).json({ ok: false, error: "Failed to submit partner request" });
  }
});

app.get("/stripe-config", (_req, res) => {
  if (!STRIPE_PUBLISHABLE_KEY) {
    return res.status(500).json({ ok: false, error: "Stripe not configured" });
  }
  res.json({ ok: true, publishableKey: STRIPE_PUBLISHABLE_KEY });
});

app.post("/create-payment-intent", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ ok: false, error: "Stripe not configured" });
    }
    const { product } = req.body || {};
    const info = PRODUCT_PRICE_MAP[String(product || "").toLowerCase()];
    if (!info) {
      return res.status(400).json({ ok: false, error: "Invalid product" });
    }
    const paymentIntent = await stripe.paymentIntents.create({
      amount: info.amount,
      currency: info.currency,
      description: info.name,
      metadata: { product: product || "" }
    });
    res.json({ ok: true, clientSecret: paymentIntent.client_secret });
  } catch (_e) {
    res.status(500).json({ ok: false, error: "Failed to create payment" });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    botReady: client.isReady(),
    uptimeSec: Math.floor(process.uptime())
  });
});

app.get("/ops", (_req, res) => {
  res.json({
    ok: true,
    botReady: client.isReady(),
    uptimeSec: Math.floor(process.uptime()),
    apply: runtimeState.apply,
    contact: runtimeState.contact
  });
});

app.listen(PORT, () => {
  console.log(`Application server running on ${PORT}`);
  logEnvDiagnostics();
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.on("clientReady", () => {
  console.log(`Bot online as ${client.user.tag}`);
  refreshInvitesCache();
  (async () => {
    try {
      const guild = await resolvePartnerTargetGuild();
      if (!guild) return;
      const partners = loadPartners();
      let changed = false;
      for (const [msgId, entry] of Object.entries(partners)) {
        if (!(entry?.status === "accepted" && entry?.pendingRoleAssignment && entry?.requesterUserId)) continue;
        const roleResult = await assignPartnerRoles(entry).catch(() => ({ assigned: false }));
        if (roleResult.assigned) {
          partners[msgId].pendingRoleAssignment = false;
          partners[msgId].pendingRoleReason = null;
          partners[msgId].roleName = roleResult.roleName || partners[msgId].roleName || null;
          changed = true;
        }
      }
      if (changed) savePartners(partners);
      await refreshDeveloperRoster("startup_sync", null).catch(() => {});
    } catch (e) {
      console.error("Partner pending-role sync failed:", e?.message || e);
    }
  })();

  if (APPLICATION_CHANNEL_ID) {
    client.channels.fetch(APPLICATION_CHANNEL_ID)
      .then((ch) => {
        if (ch && ch.isTextBased?.()) applicationChannel = ch;
      })
      .catch((e) => console.error("Application channel fetch failed:", e?.message || e));
  }

  if (!DISCORD_BOT_TOKEN || !DISCORD_CLIENT_ID || !GUILD_ID || REGISTER_COMMANDS === "false") {
    console.log("Slash command not registered: missing DISCORD_BOT_TOKEN/DISCORD_CLIENT_ID/GUILD_ID");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
  const commands = [
    {
      name: "reply",
      description: "Reply to an application (staff only)",
      options: [
        {
          type: 3,
          name: "message_id",
          description: "Webhook message ID for the application",
          required: true
        },
        {
          type: 3,
          name: "message",
          description: "Your reply to the applicant",
          required: true
        }
      ]
    },
    {
      name: "ping",
      description: "Check if the bot is responsive"
    },
    {
      name: "botstatus",
      description: "Show bot/application integration status"
    },
    {
      name: "appstatus",
      description: "Lookup application/inquiry by message ID (staff only)",
      options: [
        {
          type: 3,
          name: "message_id",
          description: "Message ID from applications/inquiries channel",
          required: true
        }
      ]
    },
    {
      name: "dmuser",
      description: "DM a Discord user by ID (staff only)",
      options: [
        {
          type: 3,
          name: "user_id",
          description: "Target Discord user ID",
          required: true
        },
        {
          type: 3,
          name: "message",
          description: "Message to send",
          required: true
        }
      ]
    },
    {
      name: "setappstatus",
      description: "Set stored application status by message ID (staff only)",
      options: [
        {
          type: 3,
          name: "message_id",
          description: "Application message ID",
          required: true
        },
        {
          type: 3,
          name: "status",
          description: "pending, accepted, denied",
          required: true,
          choices: [
            { name: "pending", value: "pending" },
            { name: "accepted", value: "accepted" },
            { name: "denied", value: "denied" }
          ]
        }
      ]
    },
    {
      name: "resendinvite",
      description: "Resend team/portfolio invite to an accepted applicant (staff only)",
      options: [
        {
          type: 3,
          name: "message_id",
          description: "Application message ID",
          required: true
        }
      ]
    },
    {
      name: "lookupdiscord",
      description: "Find recent application by Discord ID (staff only)",
      options: [
        {
          type: 3,
          name: "discord_id",
          description: "Applicant Discord ID",
          required: true
        }
      ]
    },
    {
      name: "partnerstatus",
      description: "Lookup partner request by request ID or user ID (staff only)",
      options: [
        {
          type: 3,
          name: "query",
          description: "PR-... request id or Discord user id",
          required: true
        }
      ]
    },
    {
      name: "partnerrolefix",
      description: "Retry partner role assignment (staff only)",
      options: [
        {
          type: 3,
          name: "query",
          description: "PR-... request id or Discord user id",
          required: true
        }
      ]
    },
    {
      name: "partnerremove",
      description: "Remove partner roles and mark request removed (staff only)",
      options: [
        {
          type: 3,
          name: "query",
          description: "PR-... request id or Discord user id",
          required: true
        }
      ]
    },
    {
      name: "devskillsrefresh",
      description: "Refresh TEAM ROSTER message from current member roles (staff only)"
    },
    {
      name: "instinv",
      description: "Instant invite and role assignment without application (staff only)",
      options: [
        {
          type: 3,
          name: "userid",
          description: "Target Discord user ID",
          required: true
        },
        {
          type: 3,
          name: "role",
          description: "Team role name, role ID, or role mention",
          required: true
        }
      ]
    },
    {
      name: "kickmem",
      description: "Kick member from team server and remove main developer role (staff only)",
      options: [
        {
          type: 3,
          name: "userid",
          description: "Target Discord user ID",
          required: true
        },
        {
          type: 3,
          name: "reason",
          description: "Kick reason",
          required: true
        }
      ]
    }
  ];

  rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), { body: commands })
    .then(() => console.log("Slash commands registered: /reply /ping /botstatus /appstatus /dmuser /setappstatus /resendinvite /lookupdiscord /partnerstatus /partnerrolefix /partnerremove /devskillsrefresh /instinv /kickmem"))
    .catch((e) => console.error("Slash command register failed:", e?.message || e));
});

client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (user.bot) return;
    if (!reaction.message.guildId) return;

    const emoji = reaction.emoji.name;
    const isAccept = emoji === "\u2705";
    const isReject = emoji === "\u274C";
    if (!isAccept && !isReject) return;
    const member = await reaction.message.guild.members.fetch(user.id);
    const hasRole =
      member.roles.cache.has(FOUNDERS_ROLE_ID) ||
      member.roles.cache.has(MANAGERS_ROLE_ID) ||
      member.permissions.has("ManageGuild");
    if (!hasRole) return;

    const apps = loadApplications();
    const appData = apps[reaction.message.id];
    const partners = loadPartners();
    const partnerData = partners[reaction.message.id];
    if (!appData && !partnerData) return;

    if (partnerData) {
      if (!isAccept) return;
      partnerData.status = "accepted";
      partnerData.acceptedBy = user.id;
      partnerData.acceptedByTag = user.tag || user.username || "unknown";
      const roleResult = await assignPartnerRoles(partnerData).catch((roleErr) => {
        console.error("Partner role assignment failed:", roleErr?.message || roleErr);
        return { assigned: false, reason: "role_assign_exception", roleName: toPartnerRoleName(partnerData.serverName) };
      });
      partnerData.roleName = roleResult.roleName;
      partnerData.pendingRoleAssignment = !roleResult.assigned;
      partnerData.pendingRoleReason = roleResult.reason || null;
      savePartners(partners);
      await appendAuditLog(
        "partner_accept",
        {
          requestId: partnerData.requestId,
          requesterUserId: partnerData.requesterUserId,
          requesterUsername: partnerData.requesterUsername,
          assignedRoles: roleResult.assigned,
          roleName: partnerData.roleName || null,
          pendingRoleReason: partnerData.pendingRoleReason || null
        },
        user.id
      );

      try {
        const requester = await client.users.fetch(partnerData.requesterUserId);
        await requester.send(
          `We at Arata Interactive are very happy to partner with your server ${partnerData.serverName}!\n` +
          `Main Server: ${MAIN_SERVER_LINK}\n\n` +
          `If you want your custom partner role color, DM me one of these preset names:\n` +
          `${Object.keys(PARTNER_COLOR_PRESETS).join(", ")}\n` +
          `or send a hex color like: #8b5cf6`
        );
      } catch (e) {
        console.error("Partner requester DM failed:", e?.message || e);
      }
      try {
        const ownerUser = await client.users.fetch(OWNER_NOTIFY_USER_ID);
        await ownerUser.send(
          `The Partner request of ${partnerData.requesterUsername} by server: ${partnerData.serverName} has been accepted by: ${partnerData.acceptedByTag}\n` +
          `ID: ${partnerData.requestId}\n` +
          `Role: Partner${partnerData.roleName ? ` + ${partnerData.roleName}` : ""}\n` +
          `User in server: ${roleResult.assigned ? "Yes" : "No"}`
        );
      } catch (e) {
        console.error("Partner owner DM failed:", e?.message || e);
      }
      return;
    }

    const dmUser = await client.users.fetch(appData.discord_id);
    if (isAccept) {
      appData.status = "accepted";
      appData.acceptedBy = user.id;
      appData.acceptedByTag = user.tag || `${user.username || "unknown"}#${user.discriminator || "0000"}`;
      let teamInviteUrl = null;
      if (!/tester/i.test(appData.position || "")) {
        try {
          const teamGuild = await client.guilds.fetch(TEAM_GUILD_ID);
          const channel = teamGuild.systemChannel
            || teamGuild.channels.cache.find((c) => c.isTextBased?.() && c.permissionsFor(teamGuild.members.me).has("CreateInstantInvite"));

          if (channel) {
            const invite = await channel.createInvite({
              maxUses: 1,
              unique: true,
              maxAge: 60 * 60 * 24
            });
            appData.inviteCode = invite.code;
            teamInviteUrl = invite.url;
          }
        } catch (e) {
          console.error("Invite create failed:", e?.message || e);
        }
      }

      saveApplications(apps);
      await appendAuditLog(
        "application_accept",
        { applicantDiscordId: appData.discord_id, position: appData.position || null, messageId: reaction.message.id },
        user.id
      );

      const acceptMsg =
        `You have been accepted to Arata Interactive!\n` +
        (teamInviteUrl ? `Team Server: ${teamInviteUrl}\n` : "Team Server: (invite pending)\n") +
        `Arata Interactive: https://discord.gg/JjPuB9Ue2q\n` +
        `Happy to have you here as a ${appData.position}!\n` +
        `If you need to reach us: renkohang@arata.website`;

      try {
        await dmUser.send(acceptMsg);
      } catch (e) {
        console.error("DM failed:", e?.message || e);
      }
    } else if (isReject) {
      appData.status = "denied";
      saveApplications(apps);
      await appendAuditLog(
        "application_deny",
        { applicantDiscordId: appData.discord_id, messageId: reaction.message.id },
        user.id
      );
      try {
        await dmUser.send("Sorry, you've been denied :(");
      } catch (e) {
        console.error("DM failed:", e?.message || e);
      }
    }
  } catch (e) {
    console.error(e);
  }
});

client.on("guildMemberAdd", async (member) => {
  try {
    const partnerGuild = await resolvePartnerTargetGuild();
    if (partnerGuild && member.guild.id === partnerGuild.id) {
      const partners = loadPartners();
      const pendingPartnerEntry = Object.values(partners).find(
        (p) => p.requesterUserId === member.user.id && p.status === "accepted" && p.pendingRoleAssignment
      );
      if (pendingPartnerEntry) {
        const roleResult = await assignPartnerRoles(pendingPartnerEntry).catch((e) => {
          console.error("Pending partner role assignment failed:", e?.message || e);
          return { assigned: false, reason: "role_assign_exception" };
        });
        if (roleResult.assigned) {
          for (const [msgId, value] of Object.entries(partners)) {
            if (value.requestId === pendingPartnerEntry.requestId) {
              partners[msgId].pendingRoleAssignment = false;
              partners[msgId].pendingRoleReason = null;
              partners[msgId].roleName = roleResult.roleName || partners[msgId].roleName || null;
              break;
            }
          }
          savePartners(partners);
        }
      }
      await refreshDeveloperRoster("member_join", null).catch(() => {});
    }

    if (member.guild.id !== TEAM_GUILD_ID) return;

    const instantInvites = loadInstantInvites();
    const instantEntry = instantInvites[member.user.id];
    if (instantEntry?.roleId) {
      const instantRole = await member.guild.roles.fetch(instantEntry.roleId).catch(() => null);
      if (instantRole) {
        await member.roles.add(instantRole.id, "Instant invite auto role on join").catch(() => {});
      }
      delete instantInvites[member.user.id];
      saveInstantInvites(instantInvites);
      await appendAuditLog(
        "instant_invite_join_role_assigned",
        {
          targetUserId: member.user.id,
          roleId: instantEntry.roleId,
          roleName: instantEntry.roleName || instantRole?.name || "unknown",
          invitedBy: instantEntry.invitedBy || null
        },
        null
      );
    }

    const apps = loadApplications();
    const appEntry = Object.values(apps).find(
      (a) => a.discord_id === member.user.id && a.status === "accepted"
    );
    if (!appEntry) return;

    const invites = await member.guild.invites.fetch();
    let usedCode = null;
    invites.forEach((inv) => {
      const previous = invitesCache.get(inv.code) ?? 0;
      if ((inv.uses ?? 0) > previous) usedCode = inv.code;
    });
    invitesCache.clear();
    invites.forEach((inv) => invitesCache.set(inv.code, inv.uses ?? 0));

    if (appEntry.inviteCode && usedCode && usedCode !== appEntry.inviteCode) return;
    if (/tester/i.test(appEntry.position || "")) return;

    const rolesToAdd = [DEV_ROLE];
    const positionRole = ROLE_MAP[appEntry.position] || null;
    if (positionRole) rolesToAdd.push(positionRole);

    await member.roles.add(rolesToAdd);
    const roleLabel = ROLE_LABEL_MAP[String(appEntry.position || "").toLowerCase()] || String(appEntry.position || "Member");
    const acceptedByText = appEntry.acceptedByTag
      ? `${appEntry.acceptedByTag} (${appEntry.acceptedBy || "unknown"})`
      : (appEntry.acceptedBy ? `<@${appEntry.acceptedBy}> (${appEntry.acceptedBy})` : "Unknown");
    await member.guild.systemChannel?.send?.(
      `Welcome to Arata Int. <@${member.id}>! You have been roled Developer${appEntry.position ? ` and ${roleLabel}` : ""}.`
    );
    try {
      const ownerUser = await client.users.fetch(OWNER_NOTIFY_USER_ID);
      await ownerUser.send(
        `New Member of Arata Int:\n` +
        `Username: ${member.user.tag}\n` +
        `ID: ${member.id}\n` +
        `Role: Developer${appEntry.position ? ` + ${roleLabel}` : ""}\n` +
        `Accepted by: ${acceptedByText}`
      );
    } catch (notifyErr) {
      console.error("Owner notify failed:", notifyErr?.message || notifyErr);
    }
    await refreshDeveloperRoster("member_join", null).catch(() => {});
  } catch (e) {
    console.error("guildMemberAdd failed:", e?.message || e);
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (!message || message.author?.bot) return;
    if (message.guild) return;

    const content = String(message.content || "").trim();
    if (!content) return;

    const accepted = getAcceptedPartnerByUserId(message.author.id);
    if (!accepted) return;

    const colorHex = parsePartnerColorInput(content);
    if (!colorHex) {
      await message.channel.send(
        `Invalid color. Send one preset (${Object.keys(PARTNER_COLOR_PRESETS).join(", ")}) or a hex like #8b5cf6`
      );
      return;
    }

    const result = await setAcceptedPartnerRoleColor(message.author.id, colorHex);
    if (!result.ok) {
      await message.channel.send("I could not update your role color right now. Ask staff to check role setup.");
      return;
    }
    await appendAuditLog(
      "partner_role_color_update",
      { userId: message.author.id, roleName: result.roleName, roleColor: result.roleColor },
      message.author.id
    );

    await message.channel.send(
      `Done. Your partner role color was set to ${result.roleColor} for role ${result.roleName}.`
    );
  } catch (e) {
    console.error("Partner color DM handler failed:", e?.message || e);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (!["reply", "ping", "botstatus", "appstatus", "dmuser", "setappstatus", "resendinvite", "lookupdiscord", "partnerstatus", "partnerrolefix", "partnerremove", "devskillsrefresh", "instinv", "kickmem"].includes(interaction.commandName)) return;
    const cooldownKey = `${interaction.commandName}:${interaction.user.id}`;
    const cooldown = commandCooldownMs[interaction.commandName] || 5000;
    const lastUse = commandLastUse.get(cooldownKey) || 0;
    const now = Date.now();
    if (now - lastUse < cooldown) {
      const waitMs = cooldown - (now - lastUse);
      return interaction.reply({
        flags: 64,
        content: `Please wait ${Math.ceil(waitMs / 1000)}s before using /${interaction.commandName} again.`
      });
    }
    commandLastUse.set(cooldownKey, now);

    if (interaction.commandName === "ping") {
      const latency = Date.now() - interaction.createdTimestamp;
      return interaction.reply({ flags: 64, content: `pong (${latency}ms)` });
    }

    if (interaction.commandName === "botstatus") {
      const mode = DISCORD_WEBHOOK_URL ? "webhook+bot" : "bot-only";
      return interaction.reply({
        flags: 64,
        content:
          `Bot ready: ${client.isReady()}\n` +
          `Apply mode: ${mode}\n` +
          `Application channel set: ${Boolean(APPLICATION_CHANNEL_ID)}\n` +
          `Uptime: ${Math.floor(process.uptime())}s`
      });
    }

    if (!interaction.guild || interaction.guild.id !== GUILD_ID) return;

    await interaction.deferReply({ flags: 64 });

    let member;
    try {
      member = await interaction.guild.members.fetch(interaction.user.id);
    } catch (e) {
      console.error("interactionCreate member fetch failed:", e?.message || e);
      return interaction.editReply("Unable to verify your roles right now. Try again in a moment.");
    }
    const hasRole = member.roles.cache.has(FOUNDERS_ROLE_ID) || member.roles.cache.has(MANAGERS_ROLE_ID);
    if (!hasRole) {
      return interaction.editReply("You do not have permission to use this command.");
    }

    if (interaction.commandName === "dmuser") {
      const userId = interaction.options.getString("user_id", true);
      const text = interaction.options.getString("message", true);
      if (text.length > 1800) return interaction.editReply("Message too long (max 1800 chars).");
      try {
        const user = await client.users.fetch(userId);
        await user.send(text);
        return interaction.editReply(`DM sent to ${user.tag} (${userId}).`);
      } catch (e) {
        return interaction.editReply("Failed to DM that user.");
      }
    }

    if (interaction.commandName === "setappstatus") {
      const msgIdForStatus = interaction.options.getString("message_id", true);
      const newStatus = interaction.options.getString("status", true);
      const appsDb = loadApplications();
      if (!appsDb[msgIdForStatus]) return interaction.editReply("Application message ID not found in storage.");
      appsDb[msgIdForStatus].status = newStatus;
      saveApplications(appsDb);
      return interaction.editReply(`Set status for ${msgIdForStatus} to ${newStatus}.`);
    }

    if (interaction.commandName === "lookupdiscord") {
      const discordId = interaction.options.getString("discord_id", true);
      const appsDb = loadApplications();
      const match = Object.entries(appsDb).find(([, value]) => value.discord_id === discordId);
      if (!match) return interaction.editReply("No stored application found for that Discord ID.");
      const [messageId, value] = match;
      return interaction.editReply(
        `Found application\n` +
        `Message ID: ${messageId}\n` +
        `Name: ${value.name}\n` +
        `Status: ${value.status || "pending"}\n` +
        `Position: ${value.position || "unknown"}`
      );
    }

    if (interaction.commandName === "devskillsrefresh") {
      const refresh = await refreshDeveloperRoster("manual_command", interaction.user.id);
      if (!refresh.ok) return interaction.editReply(`Roster refresh failed: ${refresh.error}`);
      return interaction.editReply(`TEAM ROSTER refreshed in <#${refresh.channelId}>.`);
    }

    if (interaction.commandName === "instinv") {
      const userId = interaction.options.getString("userid", true).trim();
      const roleInput = interaction.options.getString("role", true).trim();
      if (!/^\d{17,20}$/.test(userId)) return interaction.editReply("Invalid user ID.");

      const teamGuild = await client.guilds.fetch(TEAM_GUILD_ID).catch(() => null);
      if (!teamGuild) return interaction.editReply("Team server not found.");
      await teamGuild.members.fetch();
      const teamRole = await resolveRoleInGuild(teamGuild, roleInput);
      if (!teamRole) return interaction.editReply("Team role not found. Use role name, role ID, or role mention.");
      if (teamRole.id === teamGuild.id) return interaction.editReply("Cannot use @everyone role.");

      const targetUser = await client.users.fetch(userId).catch(() => null);
      if (!targetUser) return interaction.editReply("User not found.");

      let inviteUrl = null;
      let teamMember = await teamGuild.members.fetch(userId).catch(() => null);
      const instantInvites = loadInstantInvites();
      if (!teamMember) {
        const channel = teamGuild.systemChannel
          || teamGuild.channels.cache.find((c) => c.isTextBased?.() && c.permissionsFor(teamGuild.members.me).has("CreateInstantInvite"));
        if (!channel) return interaction.editReply("No invite-capable channel found in team server.");
        const invite = await channel.createInvite({ maxUses: 1, unique: true, maxAge: 60 * 60 * 24 });
        inviteUrl = invite.url;
        instantInvites[userId] = {
          roleId: teamRole.id,
          roleName: teamRole.name,
          invitedBy: interaction.user.id,
          invitedAt: new Date().toISOString()
        };
        saveInstantInvites(instantInvites);
      } else {
        await teamMember.roles.add(teamRole.id, `Instant invite role by ${interaction.user.tag || interaction.user.id}`);
        if (instantInvites[userId]) {
          delete instantInvites[userId];
          saveInstantInvites(instantInvites);
        }
      }

      const mainGuild = await client.guilds.fetch(GUILD_ID).catch(() => null);
      let mainDevRoleAdded = false;
      if (mainGuild) {
        const mainMember = await mainGuild.members.fetch(userId).catch(() => null);
        if (mainMember) {
          await mainMember.roles.add(MAIN_ARATA_DEVELOPER_ROLE_ID).catch(() => {});
          mainDevRoleAdded = true;
        }
      }

      const dmLines = [
        `You have been invited to Arata Int${inviteUrl ? `\nTeam Server: ${inviteUrl}` : ""}`,
        `You have been roled: ${teamRole.name} and @Arata Developer!`,
        `Main Server: ${MAIN_SERVER_LINK}`
      ];
      await targetUser.send(dmLines.join("\n")).catch(() => {});

      await appendAuditLog(
        "instant_invite",
        {
          targetUserId: userId,
          roleId: teamRole.id,
          roleName: teamRole.name,
          invitedBy: interaction.user.id,
          existingTeamMember: Boolean(teamMember),
          mainDeveloperRoleAdded: mainDevRoleAdded
        },
        interaction.user.id
      );

      return interaction.editReply(
        `Instant invite sent.\nUser: ${targetUser.tag} (${userId})\nRole: ${teamRole.name}\n` +
        `${inviteUrl ? "Invite link was DM'd." : "User already in team server; role assigned."}`
      );
    }

    if (interaction.commandName === "kickmem") {
      const userId = interaction.options.getString("userid", true).trim();
      const reason = interaction.options.getString("reason", true).trim();
      if (!/^\d{17,20}$/.test(userId)) return interaction.editReply("Invalid user ID.");
      if (reason.length < 2) return interaction.editReply("Reason is too short.");

      const teamGuild = await client.guilds.fetch(TEAM_GUILD_ID).catch(() => null);
      if (!teamGuild) return interaction.editReply("Team server not found.");
      let kicked = false;
      let removedTeamRoles = [];
      const teamMember = await teamGuild.members.fetch(userId).catch(() => null);
      if (teamMember) {
        removedTeamRoles = teamMember.roles.cache.filter((r) => r.id !== teamGuild.id).map((r) => r.name);
        if (removedTeamRoles.length) {
          await teamMember.roles.remove(teamMember.roles.cache.filter((r) => r.id !== teamGuild.id), `Kick cleanup by ${interaction.user.id}`).catch(() => {});
        }
        await teamMember.kick(reason).catch(() => {});
        kicked = true;
      }

      let mainRoleRemoved = false;
      const mainGuild = await client.guilds.fetch(GUILD_ID).catch(() => null);
      if (mainGuild) {
        const mainMember = await mainGuild.members.fetch(userId).catch(() => null);
        if (mainMember?.roles?.cache?.has(MAIN_ARATA_DEVELOPER_ROLE_ID)) {
          await mainMember.roles.remove(MAIN_ARATA_DEVELOPER_ROLE_ID, `kickmem by ${interaction.user.id}`).catch(() => {});
          mainRoleRemoved = true;
        }
      }

      await appendAuditLog(
        "kick_member",
        {
          targetUserId: userId,
          kickedFromTeam: kicked,
          removedTeamRoles: removedTeamRoles.join(", ") || "none",
          removedMainDeveloperRole: mainRoleRemoved,
          reason,
          kickedBy: interaction.user.id
        },
        interaction.user.id
      );

      return interaction.editReply(
        `Kick processed for ${userId}.\n` +
        `Kicked from team: ${kicked ? "yes" : "no"}\n` +
        `Removed @Arata Developer in main: ${mainRoleRemoved ? "yes" : "no"}`
      );
    }

    if (["partnerstatus", "partnerrolefix", "partnerremove"].includes(interaction.commandName)) {
      const query = interaction.options.getString("query", true);
      const { partners, match } = findPartnerEntry(query);
      if (!match) return interaction.editReply("Partner request not found.");
      const { messageId, data } = match;

      if (interaction.commandName === "partnerstatus") {
        return interaction.editReply(
          `Partner request found\n` +
          `Message ID: ${messageId}\n` +
          `Request ID: ${data.requestId}\n` +
          `User ID: ${data.requesterUserId}\n` +
          `Server: ${data.serverName}\n` +
          `Status: ${data.status || "pending"}\n` +
          `Role: ${data.roleName || toPartnerRoleName(data.serverName)}\n` +
          `Pending Role Assignment: ${data.pendingRoleAssignment ? "yes" : "no"}`
        );
      }

      if (interaction.commandName === "partnerrolefix") {
        if (data.status !== "accepted") {
          return interaction.editReply("That partner request is not accepted yet.");
        }
        const roleResult = await assignPartnerRoles(data).catch((e) => {
          console.error("partnerrolefix failed:", e?.message || e);
          return { assigned: false, reason: "role_assign_exception" };
        });
        data.roleName = roleResult.roleName || data.roleName || toPartnerRoleName(data.serverName);
        data.pendingRoleAssignment = !roleResult.assigned;
        data.pendingRoleReason = roleResult.reason || null;
        partners[messageId] = data;
        savePartners(partners);
        await appendAuditLog(
          "partner_role_fix",
          { requestId: data.requestId, userId: data.requesterUserId, assigned: roleResult.assigned, reason: roleResult.reason || null },
          interaction.user.id
        );
        return interaction.editReply(roleResult.assigned
          ? `Partner roles reapplied for ${data.requesterUsername} (${data.requestId}).`
          : `Partner role fix pending: ${roleResult.reason || "unknown_error"}.`);
      }

      if (interaction.commandName === "partnerremove") {
        const removed = await removePartnerRoles(data).catch((e) => {
          console.error("partnerremove failed:", e?.message || e);
          return { ok: false, error: "role_remove_exception" };
        });
        data.status = "removed";
        data.removedBy = interaction.user.id;
        data.removedByTag = interaction.user.tag || interaction.user.username || "unknown";
        data.removedAt = new Date().toISOString();
        data.pendingRoleAssignment = false;
        data.pendingRoleReason = null;
        partners[messageId] = data;
        savePartners(partners);
        await appendAuditLog(
          "partner_remove",
          { requestId: data.requestId, userId: data.requesterUserId, removedOk: removed.ok, reason: removed.error || null },
          interaction.user.id
        );
        return interaction.editReply(removed.ok
          ? `Partner removed for ${data.requesterUsername} (${data.requestId}).`
          : `Partner marked removed but role removal failed: ${removed.error || "unknown_error"}.`);
      }
    }

    const msgId = interaction.options.getString("message_id", true);
    const resolved = await resolveApplicationByMessageId(msgId, interaction.guild, applicationChannel);
    if (!resolved?.appData) return interaction.editReply("Message ID not found in applications/inquiries.");
    const appData = resolved.appData;

    if (interaction.commandName === "appstatus") {
      return interaction.editReply(
        `Found message ID ${msgId}\n` +
        `Source: ${resolved.source}\n` +
        `Discord ID: ${appData.discord_id}\n` +
        `Status: ${appData.status || "unknown"}`
      );
    }

    if (interaction.commandName === "resendinvite") {
      const appsDb = loadApplications();
      if (!appsDb[msgId]) return interaction.editReply("Application message ID not found in storage.");
      const target = appsDb[msgId];
      if (target.status !== "accepted") {
        return interaction.editReply("That applicant is not marked as accepted.");
      }
      try {
        let teamInviteUrl = "Team invite unavailable";
        if (!/tester/i.test(target.position || "")) {
          const teamGuild = await client.guilds.fetch(TEAM_GUILD_ID);
          const channel = teamGuild.systemChannel
            || teamGuild.channels.cache.find((c) => c.isTextBased?.() && c.permissionsFor(teamGuild.members.me).has("CreateInstantInvite"));
          if (channel) {
            const invite = await channel.createInvite({ maxUses: 1, unique: true, maxAge: 60 * 60 * 24 });
            teamInviteUrl = invite.url;
          }
        }
        const dmUser = await client.users.fetch(target.discord_id);
        await dmUser.send(
          `Invite resend from Arata Interactive:\n` +
          `Team Server: ${teamInviteUrl}\n` +
          `Arata Interactive: https://discord.gg/JjPuB9Ue2q`
        );
        return interaction.editReply("Invite resent.");
      } catch {
        return interaction.editReply("Failed to resend invite.");
      }
    }

    const replyText = interaction.options.getString("message", true);
    if (replyText.length > 1800) return interaction.editReply("Message too long (max 1800 chars).");

    const dmUser = await client.users.fetch(appData.discord_id);
    const replyBody =
      `Reply from Arata Interactive:\n` +
      `${replyText}\n\n` +
      `If needed, email us at renkohang@arata.website`;

    try {
      await dmUser.send(replyBody);
      return interaction.editReply(`Sent DM to ${appData.discord_username} (email: ${appData.email}).`);
    } catch (e) {
      console.error("DM failed:", e?.message || e);
      return interaction.editReply("DM failed (user may have DMs closed).");
    }
  } catch (e) {
    console.error("interactionCreate failed:", e?.message || e);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("Command failed. Please try again.");
      }
    } catch {}
  }
});

if (DISCORD_BOT_TOKEN) {
  client.login(DISCORD_BOT_TOKEN).catch((err) => {
    console.error("Discord bot login failed:", err?.message || err);
  });
}
