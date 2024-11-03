import express from "express";
import cors from "cors";
import "dotenv/config";
import { v4 as uuid } from "uuid";
import { verifyMessage, getAddress, createPublicClient, getContract, http } from "viem";
import { createClient } from "redis";
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { berachainTestnetbArtio } from "viem/chains";
import { SlashCommandBuilder } from "@discordjs/builders";

// SETUP

const getRedisClient = async () => {
  let client = createClient({
    url: process.env.REDIS_URL,
    socket: {
      timeout: 30000,
      reconnectStrategy: (retries) => {
        if (retries > 10) {
          return new Error("Retry limit reached");
        }
        return Math.min(retries * 50, 2000);
      },
    },
  });
  await client.connect().catch(console.error);
  client.on("error", (error) => {
    // console.error(`Redis client error:`, error);
  });
  return client;
};
const nftAbi = [
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "name",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
];
let redis = await getRedisClient();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const app = express();
const PORT = 3000;
const allowlist = [process.env.APP_DOMAIN, "http://localhost"];
const allowedChains = {
  80084: berachainTestnetbArtio,
};
const adminId = process.env.ADMIN_ID;
const corsOptionsDelegate = (req, callback) => {
  let corsOptions;
  if (allowlist.indexOf(req.header("Origin")) !== -1) {
    corsOptions = { origin: true };
  } else {
    corsOptions = { origin: false };
  }
  callback(null, corsOptions);
};
app.use(cors(corsOptionsDelegate));
let interactionCache = [];

// BOT

client.login(process.env.DISCORD_TOKEN);
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  await registerCommands();
});
client.on("error", (error) => {
  console.error("Discord client error:", error);
});
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.commandName == "add_role") {
      await handleAddRoleCommand(interaction);
    } else if (interaction.commandName == "start") {
      await handleStartCommand(interaction);
    } else if (interaction.customId == "verify") {
      await handleVerifyCommand(interaction);
    } else if (interaction.customId == "addWallet") {
      await handleAddWalletCommand(interaction);
    } else if (interaction.customId == "listWallets") {
      await handleListWalletsCommand(interaction);
    }
  } catch (error) {
    console.error("Interaction error:", error);
    await interaction.followUp({ content: "An error occurred.", ephemeral: true });
  }
});

const handleStartCommand = async (interaction) => {
  const userId = interaction.user.id;
  if (userId !== adminId) {
    return await interaction.reply({ content: "You are not authorized to use this command.", ephemeral: true });
  }
  const guild = await client.guilds.fetch(interaction.guildId);
  await interaction.reply({
    content: `Bot online for ${guild.name}. Don't forget to add some roles using /add_role command!`,
    ephemeral: true,
  });
  const channel = await client.channels.fetch(interaction.channelId);
  if (channel.isTextBased()) {
    const button = new ButtonBuilder().setCustomId("verify").setLabel("Verify").setStyle(ButtonStyle.Primary);
    const addAnotherButton = new ButtonBuilder()
      .setCustomId("addWallet")
      .setLabel("Add Another Wallet")
      .setStyle(ButtonStyle.Secondary);
    const listWalletsButton = new ButtonBuilder()
      .setCustomId("listWallets")
      .setLabel("List Wallets")
      .setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder()
      .addComponents(button)
      .addComponents(addAnotherButton)
      .addComponents(listWalletsButton);
    await channel.send({ content: "Welcome.", components: [row] });
  } else {
    throw new Error("Channel is not text based.");
  }
};

const handleAddWalletCommand = async (interaction) => {
  const userId = interaction.user.id;
  const guildId = interaction.guild.id;
  const salt = uuid();
  await redis.set(`salt:${userId}`, salt, { EX: 300 });
  interactionCache.push(interaction);
  const url = `${process.env.APP_DOMAIN}?guildId=${guildId}&userId=${userId}`;
  await interaction.reply(`Click here: ${url}`, { ephemeral: true });
};

const handleListWalletsCommand = async (interaction) => {
  const userId = interaction.user.id;
  const addresses = await redis.hGetAll(`user:${userId}`);
  await interaction.reply({ content: Object.keys(addresses).join("\n"), ephemeral: true });
};

const handleVerifyCommand = async (interaction) => {
  const userId = interaction.user.id;
  const addresses = await redis.hGetAll(`user:${userId}`);
  if (Object.keys(addresses).length > 0) {
    await interaction.deferReply({ ephemeral: true });
    let total = 0;
    for await (const [address] of Object.entries(addresses)) {
      const updated = await updateRole(address, interaction);
      total += updated;
    }
    if (total == 0) {
      await interaction.followUp({ content: "No new roles added.", ephemeral: true });
    } else {
      await interaction.followUp({
        content: `Verification complete, assigned ${total} new roles.`,
        ephemeral: true,
      });
    }
  } else {
    await handleAddWalletCommand(interaction);
  }
};

const handleAddRoleCommand = async (interaction) => {
  const userId = interaction.user.id;
  if (userId !== adminId) {
    return await interaction.reply({ content: "You are not authorized to use this command.", ephemeral: true });
  }
  const address = interaction.options.getString("address");
  const count = interaction.options.getInteger("count");
  const chainId = interaction.options.getInteger("chainid");
  const roleId = interaction.options.getString("roleid");
  const guild = await client.guilds.fetch(interaction.guildId);
  const role = await guild.roles.fetch(roleId);
  await redis.hSet(`guild:${interaction.guildId}`, roleId, JSON.stringify({ address, count, chainId }));
  await interaction.reply({
    content: `Role added for address ${address} on chain ${chainId} with count ${count} granting ${role.name} role.`,
    ephemeral: true,
  });
};

// API

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

app.get("/message", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) {
      return res.status(400).json({ success: false, message: "Missing id." });
    }
    const salt = await redis.get(`salt:${id}`);
    if (!salt) {
      return res.status(400).json({ success: false, message: "No salt found." });
    }
    return res.json({
      success: true,
      message: getMessage(salt),
    });
  } catch (error) {
    console.error("Endpoint error(/message):", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

app.post("/verify", async (req, res) => {
  try {
    const address = req.query.address;
    const userId = req.query.userId;
    const guildId = req.query.guildId;
    const signature = req.query.signature;
    if (!address || !signature || !userId || !guildId)
      return res.status(400).json({ success: false, message: "Missing address or signature." });
    const salt = await redis.get(`salt:${userId}`);
    const valid = await verifyMessage({
      address: getAddress(address),
      message: getMessage(salt),
      signature: signature,
    });
    if (!valid) return res.status(400).json({ success: false, message: "Invalid signature." });
    await redis.del(`salt:${userId}`);
    await redis.hSet(`user:${userId}`, address, signature);
    const interaction = interactionCache.find((interaction) => {
      if (interaction.user.id === userId) {
        return interaction;
      }
    });
    await updateRole(address, interaction);
    removeInteractionFromCache(interaction);
    return res.json({ success: true });
  } catch (error) {
    console.error("Endpoint error(/verify):", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

const removeInteractionFromCache = (interaction) => {
  const index = interactionCache.findIndex((i) => i.id === interaction.id);
  if (index > -1) {
    interactionCache.splice(index, 1);
  }
};

const getMessage = (salt) => {
  return `Please sign this message to verify your address: ${salt}`;
};

const updateRole = async (address, interaction) => {
  const deserveds = await getRolesForAddress(interaction, address);
  let count = 0;
  if (deserveds.length == 0) {
    return count;
  }
  const guild = await client.guilds.fetch(interaction.guildId);
  const member = await guild.members.fetch(interaction.user.id);
  for await (const deserved of deserveds) {
    const role = await guild.roles.fetch(deserved.roleId);
    if (member.roles.cache.has(role.id)) {
      continue;
    }
    await member.roles.add(role);
    await interaction.followUp({ content: `${deserved.name} NFT granted you ${role.name} 🥳`, ephemeral: true });
    count++;
  }
  return count;
};

const getRolesForAddress = async (interaction, userAddress) => {
  let deservedRoles = [];
  const roles = await redis.hGetAll(`guild:${interaction.guildId}`);
  if (Object.keys(roles).length === 0) {
    await interaction.followUp({ content: "No roles found for this guild.", ephemeral: true });
    return [];
  }
  for (const [roleId, data] of Object.entries(roles)) {
    const { address: nftAddress, count, chainId } = JSON.parse(data);
    const publicClient = createPublicClient({
      chain: allowedChains[chainId],
      transport: http(),
    });
    const nft = getContract({
      address: nftAddress,
      abi: nftAbi,
      client: publicClient,
    });
    const name = await nft.read.name();
    const balance = await nft.read.balanceOf([userAddress]);
    if (balance >= count) {
      deservedRoles.push({ roleId, name });
    }
  }
  return deservedRoles;
};

const registerCommands = async () => {
  await registerAddRoleCommand();
  await registerStartCommand();
};

const registerAddRoleCommand = async () => {
  const data = new SlashCommandBuilder()
    .setName("add_role")
    .setDescription("Add a role for a guild")
    .addStringOption((option) => option.setName("address").setDescription("The address").setRequired(true))
    .addIntegerOption((option) => option.setName("count").setDescription("The count").setRequired(true))
    .addIntegerOption((option) => option.setName("chainid").setDescription("The chain ID").setRequired(true))
    .addStringOption((option) => option.setName("roleid").setDescription("The role ID").setRequired(true));
  await client.application.commands.create(data);
};

const registerStartCommand = async () => {
  const data = new SlashCommandBuilder().setName("start").setDescription("Start verification for the current server");
  await client.application.commands.create(data);
};
