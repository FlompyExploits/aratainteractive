import express from "express";
import multer from "multer";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import Stripe from "stripe";
import { Client, GatewayIntentBits, Partials, REST, Routes } from "discord.js";
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
const runtimeState = {
  apply: { lastSuccessAt: null, lastErrorAt: null, lastError: null },
  contact: { lastSuccessAt: null, lastErrorAt: null, lastError: null }
};

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(appsFile)) fs.writeFileSync(appsFile, JSON.stringify({}));
if (!fs.existsSync(partnerFile)) fs.writeFileSync(partnerFile, JSON.stringify({}));

const loadApplications = () => JSON.parse(fs.readFileSync(appsFile, "utf-8") || "{}");
const saveApplications = (data) => fs.writeFileSync(appsFile, JSON.stringify(data, null, 2));
const loadPartners = () => JSON.parse(fs.readFileSync(partnerFile, "utf-8") || "{}");
const savePartners = (data) => fs.writeFileSync(partnerFile, JSON.stringify(data, null, 2));

const logEnvDiagnostics = () => {
  const checks = [
    ["DISCORD_BOT_TOKEN", Boolean(DISCORD_BOT_TOKEN), "Bot/login + channel mode"],
    ["APPLICATION_CHANNEL_ID", Boolean(APPLICATION_CHANNEL_ID), "Apply via bot channel"],
    ["DISCORD_WEBHOOK_URL", Boolean(DISCORD_WEBHOOK_URL), "Apply via webhook fallback"],
    ["CONTACT_CHANNEL_ID", Boolean(CONTACT_CHANNEL_ID), "Contact via bot channel"],
    ["CONTACT_WEBHOOK_URL", Boolean(CONTACT_WEBHOOK_URL), "Contact via webhook fallback"],
    ["PARTNER_WEBHOOK_URL", Boolean(PARTNER_WEBHOOK_URL), "Partner via webhook"],
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
const commandLastUse = new Map();
const commandCooldownMs = {
  ping: 3000,
  botstatus: 5000,
  appstatus: 5000,
  reply: 8000,
  dmuser: 12000,
  setappstatus: 6000,
  resendinvite: 12000,
  lookupdiscord: 6000
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

    if (client.isReady() && CONTACT_CHANNEL_ID) {
      const channel = await client.channels.fetch(CONTACT_CHANNEL_ID);
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
    if (!PARTNER_WEBHOOK_URL) {
      return res.status(500).json({ ok: false, error: "Partner destination not configured" });
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

    const messageId = webhookResponse?.data?.id || null;
    if (!messageId) return res.status(500).json({ ok: false, error: "Partner webhook did not return message id" });
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
    }
  ];

  rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), { body: commands })
    .then(() => console.log("Slash commands registered: /reply /ping /botstatus /appstatus /dmuser /setappstatus /resendinvite /lookupdiscord"))
    .catch((e) => console.error("Slash command register failed:", e?.message || e));
});

client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (user.bot) return;
    if (!reaction.message.guildId || reaction.message.guildId !== GUILD_ID) return;

    const emoji = reaction.emoji.name;
    const isAccept = emoji === "\u2705";
    const isReject = emoji === "\u274C";
    if (!isAccept && !isReject) return;
    const member = await reaction.message.guild.members.fetch(user.id);
    const hasRole = member.roles.cache.has(FOUNDERS_ROLE_ID) || member.roles.cache.has(MANAGERS_ROLE_ID);
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
      savePartners(partners);
      try {
        const requester = await client.users.fetch(partnerData.requesterUserId);
        await requester.send(
          `We at Arata Interactive are very happy to partner with your server ${partnerData.serverName}!\n` +
          `Main Server: ${MAIN_SERVER_LINK}`
        );
      } catch (e) {
        console.error("Partner requester DM failed:", e?.message || e);
      }
      try {
        const ownerUser = await client.users.fetch(OWNER_NOTIFY_USER_ID);
        await ownerUser.send(
          `The Partner request of ${partnerData.requesterUsername} by server: ${partnerData.serverName} has been accepted by: ${partnerData.acceptedByTag}\n` +
          `ID: ${partnerData.requestId}`
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
    if (member.guild.id !== TEAM_GUILD_ID) return;

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
  } catch (e) {
    console.error("guildMemberAdd failed:", e?.message || e);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (!["reply", "ping", "botstatus", "appstatus", "dmuser", "setappstatus", "resendinvite", "lookupdiscord"].includes(interaction.commandName)) return;
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
