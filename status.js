const { Client, GatewayIntentBits } = require('discord.js');
const { DiscordVCStatus } = require('discord-vc-status');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildVoiceStates, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.MessageContent
  ],
});

// Attach vcStatus handler
client.vcStatus = new DiscordVCStatus(client);

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Command prefix + command
  if (message.content.toLowerCase().startsWith('.vstatus')) {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply('❌ You must be in a voice channel to set a status.');
    }

    // Extract status text after command
    const args = message.content.split(' ').slice(1);
    const statusText = args.join(' ').trim();

    if (!statusText) {
      return message.reply('❌ Please provide a status text. Usage: `.vstatus Your status here`');
    }

    try {
      await client.vcStatus.setVoiceStatus(voiceChannel.id, statusText);
      return message.reply(`✅ Voice channel status updated to: **${statusText}**`);
    } catch (error) {
      console.error('Error setting voice status:', error);
      return message.reply('❌ Failed to set voice channel status. Make sure I have proper permissions.');
    }
  }
});

client.login('MTQ0NTkzMzQ1Njk5NDM0MTAwNw.GtvISB.iP3sSs-FHTGdl46S59PzzpyEjsS1dvWG0CZBWw');
