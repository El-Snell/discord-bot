// mirror-bot.js (Node 18+ / discord.js v14)
// Runs on GitHub Actions. Token/IDs come from env vars + GitHub Secrets.
//
// REQUIRED secrets/env:
//   BOT_TOKEN   = Discord bot token
//   CLIENT_ID  = Discord Application ID
//
// Optional (persist across restarts):
//   Uses repo workspace files: config.json and mirror-map.json.
//   (On GitHub-hosted runners, these do NOT persist between runs unless you upload/download artifacts.)

import fs from "node:fs";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!BOT_TOKEN) throw new Error("Missing env BOT_TOKEN");
if (!CLIENT_ID) throw new Error("Missing env CLIENT_ID");

/* ===============================
   Persistent config (local file)
================================= */
const CONFIG_FILE = "./config.json";

let config = {
  source: null,
  sourceCategory: null,
  target: null,
  paused: false,
};

if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch {}
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/* ===============================
   Persistent mapping (local file)
================================= */
const MAP_FILE = "./mirror-map.json";
let mirrorMap = {};

if (fs.existsSync(MAP_FILE)) {
  try {
    mirrorMap = JSON.parse(fs.readFileSync(MAP_FILE, "utf8")) || {};
  } catch {
    mirrorMap = {};
  }
}

function saveMap() {
  fs.writeFileSync(MAP_FILE, JSON.stringify(mirrorMap, null, 2));
}

function setMap(sourceId, mirroredId) {
  mirrorMap[sourceId] = mirroredId;
  saveMap();
}

function getMap(sourceId) {
  return mirrorMap[sourceId] || null;
}

function delMap(sourceId) {
  if (mirrorMap[sourceId]) {
    delete mirrorMap[sourceId];
    saveMap();
  }
}

/* ===============================
   Discord client
================================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

/* ===============================
   Slash commands
================================= */
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("config")
      .setDescription("Configure mirror channels")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) =>
        s.setName("show").setDescription("Show current configuration")
      )
      .addSubcommand((s) =>
        s
          .setName("set")
          .setDescription("Set mirror source/target channels")
          .addChannelOption((o) =>
            o.setName("source").setDescription("Source channel").setRequired(true)
          )
          .addChannelOption((o) =>
            o.setName("target").setDescription("Target channel").setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s
        .setName("setcategory")
        .setDescription("Mirror all channels in a category to the target channel")
        .addChannelOption((o) =>
          o.setName("category").setDescription("Source category").setRequired(true)
        )
        .addChannelOption((o) =>
          o.setName("target").setDescription("Target channel").setRequired(true)
        )
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("pause")
      .setDescription("Pause mirroring")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("resume")
      .setDescription("Resume mirroring")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .toJSON(),
    
  ];

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
}

/* ===============================
   Helpers
================================= */
function messageLink(msg) {
  return `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`;
}

function baseContent(msg) {
  const link = messageLink(msg);
  const text = msg.content || "";
  return `**${msg.author.tag}:** ${text}\n${link}`.trim();
}

function buildFiles(msg) {
  return [...msg.attachments.values()].map((a) => a.url);
}

function isFromConfiguredSource(msg) {
  // Single channel mode
  if (config.source && msg.channelId === config.source) return true;

  // Category mode (text channels under a category)
  if (config.sourceCategory && msg.channel?.parentId === config.sourceCategory) return true;

  return false;
}

/* ===============================
   Interaction handlers
================================= */
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "config") {
    const sub = interaction.options.getSubcommand();

    if (sub === "show") {
      await interaction.reply({
        content:
          `Source: ${config.source ? `<#${config.source}>` : "(not set)"}\n` +
          `Source Category: ${config.sourceCategory ? `<#${config.sourceCategory}>` : "(not set)"}\n` +
          `Target: ${config.target ? `<#${config.target}>` : "(not set)"}`
        ephemeral: true,
      });
      return;
    }

    if (sub === "set") {
      const source = interaction.options.getChannel("source");
      const target = interaction.options.getChannel("target");

      config.source = source.id;
      config.target = target.id;
      saveConfig();

      await interaction.reply({
        content: `Updated.\nSource → ${source}\nTarget → ${target}`,
        ephemeral: true,
      });
      return;
    }
    if (sub === "setcategory") {
      const category = interaction.options.getChannel("category");
      const target = interaction.options.getChannel("target");

      // Store category as the source mode; clear single-channel source
      config.sourceCategory = category.id;
      config.source = null;
      config.target = target.id;
      saveConfig();

      await interaction.reply({
        content: `Updated.\nSource Category → ${category}\nTarget → ${target}`,
        ephemeral: true,
      });
      return;
    }
  }

  if (interaction.commandName === "pause") {
    config.paused = true;
    saveConfig();
    await interaction.reply({ content: "Mirroring paused.", ephemeral: true });
    return;
  }

  if (interaction.commandName === "resume") {
    config.paused = false;
    saveConfig();
    await interaction.reply({ content: "Mirroring resumed.", ephemeral: true });
    return;
  }
});

/* ===============================
   Mirror: create
================================= */
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (config.paused) return;
    if ((!config.source && !config.sourceCategory) || !config.target) return;
    if (!isFromConfiguredSource(msg)) return;

    const target = await client.channels.fetch(config.target);

    const sent = await target.send({
      content: baseContent(msg),
      files: buildFiles(msg),
      allowedMentions: { parse: [] },
    });

    setMap(msg.id, sent.id);
  } catch {}
});

/* ===============================
   Mirror: edit
================================= */
client.on("messageUpdate", async (_oldMsg, newMsg) => {
  try {
    if (config.paused) return;
    if ((!config.source && !config.sourceCategory) || !config.target) return;
    if (!isFromConfiguredSource(msg)) return;

    if (newMsg.partial) newMsg = await newMsg.fetch();
    if (newMsg.author?.bot) return;

    const target = await client.channels.fetch(config.target);
    const mirroredId = getMap(newMsg.id);

    if (!mirroredId) {
      await target.send({
        content: `✏️ **Edited:** ${baseContent(newMsg)}`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const mirrored = await target.messages.fetch(mirroredId).catch(() => null);
    if (!mirrored) {
      delMap(newMsg.id);
      await target.send({
        content: `✏️ **Edited:** ${baseContent(newMsg)}`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await mirrored.edit({
      content: baseContent(newMsg),
      allowedMentions: { parse: [] },
    });
  } catch {}
});

/* ===============================
   Mirror: delete
================================= */
client.on("messageDelete", async (msg) => {
  try {
    if (config.paused) return;
    if ((!config.source && !config.sourceCategory) || !config.target) return;
    if (!isFromConfiguredSource(msg)) return;

    if (msg.partial) msg = await msg.fetch().catch(() => null);

    const target = await client.channels.fetch(config.target);
    const mirroredId = msg?.id ? getMap(msg.id) : null;

    if (!mirroredId) {
      await target.send({
        content: `🗑️ **Deleted a message.**${msg ? ` ${messageLink(msg)}` : ""}`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const mirrored = await target.messages.fetch(mirroredId).catch(() => null);
    if (mirrored) await mirrored.delete().catch(() => null);

    delMap(msg?.id);
  } catch {}
});

/* ===============================
   Start
================================= */
(async () => {
  await registerCommands();
  await client.login(BOT_TOKEN);
})();
