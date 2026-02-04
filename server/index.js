import express from "express";
import multer from "multer";
import axios from "axios";
import dotenv from "dotenv";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 3000,
  WEBHOOK_URL,
  DISCORD_BOT_TOKEN,
  FOUNDERS_ROLE_ID,
  MANAGERS_ROLE_ID,
  GUILD_ID,
  S3_ENDPOINT,
  S3_REGION = "auto",
  S3_BUCKET,
  S3_ACCESS_KEY,
  S3_SECRET_KEY,
  S3_PUBLIC_BASE
} = process.env;

const app = express();
app.use(express.json());
const allowedOrigins = new Set([
  "https://arata.website",
  "https://www.arata.website"
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (_req, res) => {
  res.json({ ok: true, message: "Arata apply API is running" });
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
  if (!email || typeof email !== "string") return false;
  const e = email.trim();
  return e.includes("@") && e.includes(".") && e.length >= 6;
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

app.post("/apply", upload.single("resume"), async (req, res) => {
  try {
    console.log("Apply received", {
      origin: req.headers.origin,
      hasFile: !!req.file,
      fileName: req.file?.originalname,
      fileType: req.file?.mimetype,
      fileSize: req.file?.size
    });

    if (!WEBHOOK_URL) {
      console.error("Apply error: WEBHOOK_URL missing");
      return res.status(500).json({ ok: false, error: "Webhook not configured" });
    }

    const {
      name = "",
      email = "",
      discord_username = "",
      discord_id = "",
      position = "",
      message = ""
    } = req.body || {};

    console.log("Apply body", {
      name,
      email,
      discord_username,
      discord_id,
      position,
      messageLength: (message || "").length
    });

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

    const resumeUrl = await uploadResume(req.file, name);
    console.log("Resume uploaded", { resumeUrl });
    if (!resumeUrl) {
      console.error("Apply error: resume upload failed (S3 not configured?)");
      return res.status(500).json({ ok: false, error: "Resume storage not configured" });
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
        { name: "Resume", value: resumeUrl, inline: false },
        { name: "Message", value: `\`\`\`\n${message}\n\`\`\`` }
      ],
      footer: { text: `Applicant ID: ${discord_id}` }
    };

    const response = await axios.post(`${WEBHOOK_URL}?wait=true`, {
      content,
      embeds: [embed]
    });
    console.log("Webhook sent", { status: response?.status, id: response?.data?.id });

    const msgId = response?.data?.id;
    if (msgId) {
      const apps = loadApplications();
      apps[msgId] = {
        name,
        email,
        discord_username,
        discord_id,
        position,
        resumeUrl
      };
      saveApplications(apps);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Apply failed", {
      message: err?.message,
      code: err?.code,
      status: err?.response?.status,
      data: err?.response?.data
    });
    res.status(500).json({ ok: false, error: "Failed to send application" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Application server running on ${PORT}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.on("ready", () => {
  console.log(`Bot online as ${client.user.tag}`);
});

client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (user.bot) return;
    if (!reaction.message.guildId || reaction.message.guildId !== GUILD_ID) return;

    const emoji = reaction.emoji.name;
    if (emoji !== "✅" && emoji !== "❌") return;

    const member = await reaction.message.guild.members.fetch(user.id);
    const hasRole = member.roles.cache.has(FOUNDERS_ROLE_ID) || member.roles.cache.has(MANAGERS_ROLE_ID);
    if (!hasRole) return;

    const apps = loadApplications();
    const appData = apps[reaction.message.id];
    if (!appData) return;

    const dmUser = await client.users.fetch(appData.discord_id);
    if (emoji === "✅") {
      await dmUser.send(
        `You have been accepted to Arata Interactive!\\n` +
        `Team Server: https://discord.gg/vuXt5JUh\\n` +
        `Portfolio Server: https://discord.gg/PzJ5cFwt\\n` +
        `Happy to have you here as a ${appData.position}!`
      );
    } else if (emoji === "❌") {
      await dmUser.send("Sorry, you've been denied :(");
    }
  } catch (e) {
    console.error(e);
  }
});

if (DISCORD_BOT_TOKEN) {
  client.login(DISCORD_BOT_TOKEN).catch((err) => {
    console.error("Discord bot login failed:", err?.message || err);
  });
}
