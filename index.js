const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const express = require('express');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const app = express();
const PORT = 3000;

client.login('YOUR_BOT_TOKEN');
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

app.post('/salt', async (req, res) => {
  redis = getRedisClient()
  const salt = uuid()
  const address = url.searchParams.get('address')
  if (address == null) throw error(400, 'Missing address.')
  await redis.set(`salt:${getAddress(address)}`, salt, { EX: 2592000 })
  return json({
    success: true,
    salt: salt,
  })
})

app.post('/verify', async (req, res) => {
  redis = getRedisClient()
  const address = url.searchParams.get('address')
  const signature = url.searchParams.get('signature')
  if (!address || !signature) throw error(400, 'Missing address or signature.')
  const salt = (await redis.get(`salt:${getAddress(address)}`))
  const client = createPublicClient({
    chain: config.chains.find((c) => c.id === getChainId(config)),
    transport: http(),
  })
  const valid = await client.verifyMessage({
    address: address,
    message: messageForSalt(salt),
    signature: signature
  })
  if (!valid) throw error(400, 'Invalid signature.')
  // check for role to give
})

client.on('messageCreate', async (message) => {
  if (message.content === '!button') {
    const button = new ButtonBuilder()
      .setCustomId('send_link')
      .setLabel('Click Me!')
      .setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(button);
    await message.channel.send({ content: 'Click the button to go to the website!', components: [row] });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId === 'send_link') {
    const userId = interaction.user.id;
    const url = `https://example.com?userId=${userId}`; // Replace with your desired URL
    await interaction.reply(`You will be redirected to: ${url}`);
    await interaction.followUp({ content: `Click here: ${url}`, ephemeral: true });
  }
});

import { error, json } from '@sveltejs/kit'
import { PRIVATE_KV_REST_API_URL } from '$env/static/private'
import { v4 as uuid } from 'uuid'
import { getAddress } from 'viem'
import { createClient } from 'redis'

let redis
const getRedisClient = () => {
  if (!redis) {
    redis = createClient({
      url: PRIVATE_KV_REST_API_URL,
    })
    redis.connect().catch(console.error)
    redis.on('error', (error) => {
      console.error(`Redis client error:`, error)
    })
  }
  return redis
}
