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
    switch (interaction.commandName) {
      case "add_role":
        await handleAddRoleCommand(interaction);
        return;
      case "start":
        await sendInitialMessage(interaction.channelId);
        return;
    }
    switch (interaction.customId) {
      case "verify":
        await handleVerifyCommand(interaction);
      case "addWallet":
        await handleAddWalletCommand(interaction);
      case "listWallets":
        await handleListWalletsCommand(interaction);
    }
  } catch (error) {
    console.error(error);
    await replyToInteraction(interaction, "An error occurred.");
  }
});

const handleAddWalletCommand = async (interaction) => {
  try {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const salt = uuid();
    await redis.set(`salt:${userId}`, salt, { EX: 300 });
    const url = `${process.env.APP_DOMAIN}?guildId=${guildId}&userId=${userId}`;
    await replyToInteraction(interaction, `Click here: ${url}`);
  } catch (error) {
    console.error("Error:", error);
    await replyToInteraction(interaction, "An error occurred.");
  }
};

const handleListWalletsCommand = async (interaction) => {
  try {
    const userId = interaction.user.id;
    const addresses = await redis.hGetAll(`user:${userId}`);
    await replyToInteraction(interaction, Object.keys(addresses).join("\n"));
  } catch (error) {
    console.error("Error:", error);
    await replyToInteraction(interaction, "An error occurred.");
  }
};

const handleVerifyCommand = async (interaction) => {
  try {
    const userId = interaction.user.id;
    const addresses = await redis.hGetAll(`user:${userId}`);
    if (Object.keys(addresses).length > 0) {
      await interaction.reply({ content: "Verification complete.", ephemeral: true });
    } else {
      await handleAddWalletCommand(interaction);
    }
  } catch (error) {
    console.error("Error:", error);
    await interaction.reply({ content: "An error occurred.", ephemeral: true });
  }
};

const handleAddRoleCommand = async (interaction) => {
  const userId = interaction.user.id;
  if (userId !== adminId) {
    return await replyToInteraction(interaction, "You are not authorized to use this command.");
  }
  const address = interaction.options.getString("address");
  const count = interaction.options.getInteger("count");
  const chainId = interaction.options.getInteger("chainid");
  const roleId = interaction.options.getString("roleid");
  await redis.hSet(`guild:${interaction.guildId}`, roleId, JSON.stringify({ address, count, chainId }));
  await replyToInteraction(interaction, "Role added.");
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
    console.error("Error:", error);
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
    await handleRoleUpdate(address, guildId, userId);
    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

const getMessage = (salt) => {
  return `Please sign this message to verify your address: ${salt}`;
};

const handleRoleUpdate = async (address, guildId, userId) => {
  const roles = await getRolesForAddress(guildId, address);
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(userId);
  for await (const r of roles) {
    const role = await guild.roles.fetch(r);
    if (member.roles.cache.has(role.id)) continue;
    await member.roles.add(role);
  }
};

const getRolesForAddress = async (guildId, userAddress) => {
  let deservedRoles = [];
  try {
    const roles = await redis.hGetAll(`guild:${guildId}`);
    if (Object.keys(roles).length === 0) {
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
      const balance = await nft.read.balanceOf([userAddress]);
      if (balance >= count) {
        deservedRoles.push(roleId);
      }
    }
  } catch (error) {
    console.error("Error:", error);
    throw error;
  } finally {
    return deservedRoles;
  }
};

const sendInitialMessage = async (channelId) => {
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel.isTextBased()) {
      const button = new ButtonBuilder()
        .setCustomId("verify")
        .setLabel("Register Wallet")
        .setStyle(ButtonStyle.Primary);
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
  } catch (error) {
    console.error("Error fetching the channel or sending the message:", error);
  }
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

const registerCommands = async () => {
  await registerAddRoleCommand();
  await registerStartCommand();
};

const registerStartCommand = async () => {
  const data = new SlashCommandBuilder().setName("start").setDescription("Start verification for the current server");
  await client.application.commands.create(data);
};

const replyToInteraction = async (interaction, content) => {
  try {
    await interaction.reply({ content, ephemeral: true });
  } catch (error) {
    console.error("Error:", error);
  }
};
