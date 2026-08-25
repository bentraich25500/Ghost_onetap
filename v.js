const { Client, GatewayIntentBits } = require('discord.js');
const { VibeSync } = require('vibesync'); // Install with npm install vibesync
const dotenv = require('dotenv');
dotenv.config();
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates // Required for voice channel status
    ]
});
const vcStatus = new VibeSync(client);

client.on('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    const channelId = '1388317062325338222'; // Replace with your voice channel ID
    const status = 'Currently active in this voice chat!';

    try {
        await vcStatus.setVoiceStatus(channelId, status);
        console.log('Voice channel status updated successfully.');
    } catch (err) {
        console.error('Failed to update voice channel status:', err);
    }
});

client.login(process.env.DISCORD_TOKEN);