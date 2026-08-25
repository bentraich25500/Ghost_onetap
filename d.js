const { Client, GatewayIntentBits, ChannelType, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// === SETUP YOUR VALUES HERE ===
const BOT_TOKEN = 'MTM4NDYwODMyMjIxMjMzNTc0Ng.GxcaPi.CRoEPwHQSYfevVAxEn6HVjZEWTQL3U4MBeJPwc'; // 🔑 Put your bot token here
const LOBBY_CHANNEL_ID = '1388266976018960436'; // 🔊 Put your voice lobby channel ID here
// ================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

const dbFolder = path.join(__dirname, 'database');
if (!fs.existsSync(dbFolder)) fs.mkdirSync(dbFolder);

const dbPath = path.join(dbFolder, 'voiceSystem.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('❌ Failed to connect to SQLite DB:', err);
  else console.log('<a:verif_vert:1440432091853492254> Connected to SQLite DB');
});

// 🔊 Voice Lobby System
client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const member = newState.member;
    const guild = newState.guild;

    if (!newState.channel || oldState.channel === newState.channel) return;
    if (newState.channel.id !== LOBBY_CHANNEL_ID) return;

    const tempChannel = await guild.channels.create({
      name: `${member.user.username}'s Room`,
      type: ChannelType.GuildVoice,
      parent: newState.channel.parentId,
      permissionOverwrites: [
        {
          id: guild.roles.everyone,
          allow: [PermissionsBitField.Flags.Connect],
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: member.id,
          allow: [
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.ViewChannel,
            // PermissionsBitField.Flags.ManageChannels,
          ],
        },
      ],
    });

    await member.voice.setChannel(tempChannel);

    // ✅ Send message in the voice channel's built-in chat
    setTimeout(async () => {
      try {
        await tempChannel.send({
          content: `👋 Welcome <@${member.id}> to your private voice room!`,
        });
      } catch (err) {
        console.error('❌ Error sending in voice channel chat:', err);
      }
    }, 2000);
  } catch (err) {
    console.error('❌ Error in voiceStateUpdate:', err);
  }
});

// 🟢 Bot Ready
client.once('ready', () => {
  console.log(`<a:verif_vert:1440432091853492254> Logged in as ${client.user.tag}`);
});

// 🔑 Login
client.login(BOT_TOKEN);
