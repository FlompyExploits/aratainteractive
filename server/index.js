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
  allowedHeaders: ["Content-Type", "Authorization"]
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

const dataDir = path.join(__dirname, "data");
const appsFile = path.join(dataDir, "applications.json");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(appsFile)) fs.writeFileSync(appsFile, JSON.stringify({}));

const loadApplications = () => JSON.parse(fs.readFileSync(appsFile, "utf-8") || "{}");
const saveApplications = (data) => fs.writeFileSync(appsFile, JSON.stringify(data, null, 2));

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

    if (!name || !email || !discord_username || !discord_id || !position || !message) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: "Invalid email" });
    }
    if (containsBadWords(name) || containsBadWords(message)) {
      return res.status(400).json({ ok: false, error: "Inappropriate content detected" });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Resume required" });
    }

    let resumeUrl = null;
    if (s3Client) {
      try {
        console.log("Apply resume upload start");
        resumeUrl = await withTimeout(uploadResume(req.file, name), 15_000, "resume_upload_timeout");
        console.log("Apply resume upload ok");
      } catch (uploadErr) {
        console.error("Resume upload failed:", uploadErr?.name, uploadErr?.message || uploadErr);
        return res.status(500).json({ ok: false, error: "Resume upload failed (check S3 settings)" });
      }
    }

    const content = `<@&${FOUNDERS_ROLE_ID}> <@&${MANAGERS_ROLE_ID}>`;
    const embed = {
      title: "New Arata Application",
      color: 0x2d8cff,
      fields: [
        { name: "Name", value: name, inline: true },
        { name: "Email", value: email, inline: true },
        { name: "Discord", value: `${discord_username} (ID: ${discord_id})`, inline: false },
        { name: "Position", value: position, inline: true },
        { name: "Resume", value: resumeUrl || "Attached in Discord message", inline: false },
        { name: "Message", value: `\`\`\`\n${message}\n\`\`\`` }
      ],
      footer: { text: `Applicant ID: ${discord_id}` }
    };

    let msgId = null;
    if (DISCORD_WEBHOOK_URL) {
      if (!resumeUrl) {
        return res.status(500).json({
          ok: false,
          error: "S3 is required when using webhook mode for resumes"
        });
      }
      const webhookPayload = {
        content,
        embeds: [embed],
        allowed_mentions: { parse: ["roles"] }
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
          files: resumeUrl ? [] : [{
            attachment: req.file.buffer,
            name: req.file.originalname
          }]
        }),
        12_000,
        "discord_channel_send_timeout"
      );
      msgId = response?.id || null;
    }
    if (!msgId) {
      return res.status(500).json({ ok: false, error: "Discord did not return a message id" });
    }
    if (msgId) {
      const apps = loadApplications();
      apps[msgId] = {
        name,
        email,
        discord_username,
        discord_id,
        position,
        resumeUrl: resumeUrl || `attachment:${req.file.originalname}`,
        status: "pending"
      };
      saveApplications(apps);
    }

    console.log("Apply success:", { messageId: msgId, hasS3Resume: Boolean(resumeUrl), ms: Date.now() - startedAt });
    res.json({ ok: true });
  } catch (err) {
    console.error("Apply failed:", err?.response?.status, err?.response?.data || err?.message || err);
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

app.listen(PORT, () => {
  console.log(`Application server running on ${PORT}`);
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
    }
  ];

  rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), { body: commands })
    .then(() => console.log("Slash commands registered: /reply /ping /botstatus /appstatus"))
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
    if (!appData) return;

    const dmUser = await client.users.fetch(appData.discord_id);
    if (isAccept) {
      appData.status = "accepted";
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
        `Portfolio Server: https://discord.gg/PzJ5cFwt\n` +
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
    await member.guild.systemChannel?.send?.(
      `Welcome to Arata Int. <@${member.id}>! You have been roled: <@&${DEV_ROLE}>${positionRole ? ` and <@&${positionRole}>` : ""}`
    );
  } catch (e) {
    console.error("guildMemberAdd failed:", e?.message || e);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (!["reply", "ping", "botstatus", "appstatus"].includes(interaction.commandName)) return;

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

    const replyText = interaction.options.getString("message", true);

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
