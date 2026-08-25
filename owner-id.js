const { VoiceChannel } = require('discord.js');

module.exports = {
  handle: async function(oldState, newState, db) {
    try {
      if (oldState?.channelId !== '123456' && newState?.channelId === '123456') {
        const guild = newState.guild;
        const member = newState.member;
        const createdChannel = await guild.channels.create({
          name: `${member.user.username}'s VC`,
          type: 2,
          parent: 'ID_PARENT_CATEGORY',
          permissionOverwrites: [
            { id: guild.id, deny: ['Connect'] },
            { id: member.id, allow: ['Connect'] },
          ],
        });
        await member.voice.setChannel(createdChannel);
        await db.run(
          'INSERT INTO temp_channels (channel_id, owner_id) VALUES (?, ?)',
          [createdChannel.id, member.id]
        );
      }
    } catch {}
  }
};
