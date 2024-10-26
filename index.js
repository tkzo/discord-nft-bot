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

app.post('/add', async (req, res) => {
  try {
    const header = req.headers.authorization
    if (!header) throw error(401, 'Missing authorization header.')
    const token = header.split(' ')[1]
    if (!token) throw error(401, 'Missing token.')
    if (token !== process.env.TOKEN) throw error(401, 'Invalid token.')
    const address = req.params.address
    if (!address) throw error(400, 'Missing address.')
    const role = req.params.role
    if (!role) throw error(400, 'Missing role.')
    await redis.set(`role:${getAddress(address)}`, salt, { EX: 2592000 })
    return res.json({ success: true })
  } catch (error) {
    console.error('Error:', error)
    return res.status(error.status || 500).json({ success: false, message: error.message })
  }
})

app.post('/salt/:address', async (req, res) => {
  try {
    const redis = getRedisClient();
    const salt = uuid();
    const address = req.params.address;
    if (!address) {
      return res.status(400).json({ success: false, message: 'Missing address.' });
    }
    await redis.set(`salt:${getAddress(address)}`, salt, { EX: 300 });
    return res.json({
      success: true,
      salt: salt,
    });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

const handleRoleUpdate = async (address) => { }

app.post('/verify', async (req, res) => {
  try {
    redis = getRedisClient()
    const address = url.searchParams.get('address')
    const signature = url.searchParams.get('signature')
    if (!address || !signature) throw error(400, 'Missing address or signature.')
    const salt = (await redis.get(`salt:${getAddress(address)}`))
    const client = createClient({
      chain: config.chains.find((c) => c.id === getChainId(config)),
      transport: http(),
    })
    const valid = await client.verifyMessage({
      address: address,
      message: messageForSalt(salt),
      signature: signature
    })
    if (!valid) throw error(400, 'Invalid signature.')
    await redis.del(`salt:${getAddress(address)}`)
    handleRoleUpdate(address)
    return res.json({ success: true })
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
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
