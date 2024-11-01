import express from 'express'
import 'dotenv/config'
import { v4 as uuid } from 'uuid'
import { getAddress, verifyMessage } from 'viem'
import { createClient } from 'redis'
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'

let redis
const getRedisClient = () => {
  if (!redis) {
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: {
        timeout: 30000,
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            return new Error('Retry limit reached');
          }
          return Math.min(retries * 50, 2000); // Exponential backoff
        }
      }
    })
    redis.connect().catch(console.error)
    redis.on('error', (error) => {
      console.error(`Redis client error:`, error)
    })
  }
  return redis
}
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const app = express();
const PORT = 3000;

client.login(process.env.DISCORD_TOKEN);
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  try {
    const channel = await client.channels.fetch(process.env.CHANNEL_ID);
    if (channel.isTextBased()) {
      const button = new ButtonBuilder()
        .setCustomId('send_link')
        .setLabel('Click Me!')
        .setStyle(ButtonStyle.Primary);
      const row = new ActionRowBuilder().addComponents(button);
      await channel.send({ content: 'Click the button to go to the website!', components: [row] });
    } else {
      console.error('The channel is not a text-based channel.');
    }
  } catch (error) {
    console.error('Error fetching the channel or sending the message:', error);
  }
});
client.on('error', (error) => {
  console.error('Discord client error:', error);
})

app.listen(PORT, () => {
  console.log(process.env.DISCORD_TOKEN);
  console.log(`Server is running on http://localhost:${PORT}`);
});

app.post('/add', async (req, res) => {
  try {
    const header = req.headers.authorization
    if (!header) throw error(401, 'Missing authorization header.')
    const token = header.split(' ')[1]
    if (!token) throw error(401, 'Missing token.')
    if (token !== process.env.TOKEN) throw error(401, 'Invalid token.')
    const address = req.query.address
    if (!address) throw error(400, 'Missing address.')
    const count = req.query.count
    if (!count) throw error(400, 'Missing count.')
    const chainId = req.query.chainId
    if (!chainId) throw error(400, 'Missing chainId.')
    const role = req.params.role
    if (!role) throw error(400, 'Missing role.')
    redis = getRedisClient()
    // create new role
    const data = JSON.stringify({ address, count, chainId })
    await redis.set(`role:${role}`, data)
    return res.json({ success: true })
  } catch (error) {
    console.error('Error:', error)
    return res.status(error.status || 500).json({ success: false, message: error.message })
  }
})

app.get('/message', async (req, res) => {
  try {
    redis = getRedisClient();
    const id = req.query.id;
    if (!id) {
      return res.status(400).json({ success: false, message: 'Missing id.' });
    }
    const salt = await redis.get(`salt:${id}`);
    return res.json({
      success: true,
      message: getMessage(salt)
    });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

const getMessage = (salt) => {
  return `Please sign this message to verify your address: ${salt}`
}

const handleRoleUpdate = async (address, userId) => {
  const tempRoleId = "1293418503596019802"
  await getRoleForAddress();
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const member = await guild.members.fetch(userId);
  const role = await guild.roles.fetch(tempRoleId);
  await member.roles.add(role);
}

const getRoleForAddress = async (address) => {
  redis = getRedisClient()
  const roles = await redis.keys('role:*')
  for (const key of roles) {
    const data = await redis.get(key)
    const { address, count, chainId } = JSON.parse(data)
    if (address === address) {
      return key.split(':')[1]
    }
  }
  return null
}


app.post('/verify', async (req, res) => {
  try {
    redis = getRedisClient()
    const address = req.query.address
    const id = req.query.id
    const signature = req.query.signature
    if (!address || !signature || !id) return res.status(400).json({ success: false, message: 'Missing address or signature.' })
    const salt = (await redis.get(`salt:${id}`))
    const valid = await verifyMessage({
      address: address,
      message: getMessage(salt),
      signature: signature
    })
    if (!valid) return res.status(400).json({ success: false, message: 'Invalid signature.' })
    await redis.del(`salt:${id}`)
    await handleRoleUpdate(address, id)
    return res.json({ success: true })
  } catch (error) {
    console.error(error)
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
})

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (interaction.customId === 'send_link') {
      redis = getRedisClient()
      const userId = interaction.user.id;
      const salt = uuid();
      await redis.set(`salt:${userId}`, salt, { EX: 300 });
      console.log("Salt for user ", userId)
      const url = `https://example.com?id=${userId}`;
      await interaction.reply(`You will be redirected to: ${url}`);
      await interaction.followUp({ content: `Click here: ${url}`, ephemeral: true });
    }
  } catch (error) {
    console.error('Error:', error);
    await interaction.reply({ content: 'An error occurred.', ephemeral: true });
  }
});
