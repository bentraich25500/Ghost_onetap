const { EmbedBuilder, PermissionsBitField, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } = require('discord.js');
const util = require('util');

// Helper to check if the interactor is the channel owner
async function isChannelOwner(db, channelId, userId) {
  const get = util.promisify(db.get).bind(db);
  try {
    const row = await get('SELECT owner_id FROM temp_channels WHERE channel_id = ?', [channelId]);
    return row && row.owner_id === userId;
  } catch (error) {
    console.error('Failed to check channel ownership:', error);
    return false;
  }
}

module.exports = {
  async handleButton(interaction, client, db) {
    const { customId, member, channel } = interaction;
    const voiceChannel = member.voice.channel;

    if (!voiceChannel) {
      return interaction.reply({ content: 'You must be in a voice channel to use these controls.', flags: MessageFlags.Ephemeral });
    }

    const isOwner = await isChannelOwner(db, voiceChannel.id, member.id);
    // Allow anyone to use the info and claim buttons
    if (!isOwner && !['vc_info', 'vc_claim'].includes(customId)) {
      return interaction.reply({ content: 'Only the channel owner can use this button.', flags: MessageFlags.Ephemeral });
    }

    switch (customId) {
      case 'vc_lock':
        await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: false });
        // Ensure the owner always keeps access while locked
        await voiceChannel.permissionOverwrites.edit(member.id, { Connect: true, Speak: true, ViewChannel: true });
        await interaction.reply({ content: '🔒 Channel locked to new members.', flags: MessageFlags.Ephemeral });
        break;

      case 'vc_unlock':
        await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: true });
        await interaction.reply({ content: '🔓 Channel unlocked.', flags: MessageFlags.Ephemeral });
        break;

      case 'vc_delete':
        await interaction.reply({ content: '🗑️ Channel will be deleted in 3 seconds.', flags: MessageFlags.Ephemeral });
        setTimeout(() => voiceChannel.delete('Deleted by owner.').catch(console.error), 3000);
        break;

      case 'vc_rename': {
        const modal = new ModalBuilder().setCustomId('vc_rename_modal').setTitle('Rename Voice Channel');
        const nameInput = new TextInputBuilder().setCustomId('vc_new_name').setLabel("Enter the new channel name").setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
        await interaction.showModal(modal);
        break;
      }

      case 'vc_limit': {
        const modal = new ModalBuilder().setCustomId('vc_limit_modal').setTitle('Set User Limit');
        const limitInput = new TextInputBuilder().setCustomId('vc_user_limit').setLabel("Enter user limit (0 for none)").setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(limitInput));
        await interaction.showModal(modal);
        break;
      }

      case 'vc_claim': {
        const get = util.promisify(db.get).bind(db);
        const row = await get('SELECT owner_id FROM temp_channels WHERE channel_id = ?', [voiceChannel.id]);
        if (!row) return interaction.reply({ content: 'This is not a temporary channel.', flags: MessageFlags.Ephemeral });

        const owner = await interaction.guild.members.fetch(row.owner_id).catch(() => null);
        if (owner && owner.voice.channelId === voiceChannel.id) {
          return interaction.reply({ content: `The owner, ${owner.displayName}, is still in the channel.`, flags: MessageFlags.Ephemeral });
        }

        const run = util.promisify(db.run).bind(db);
        await run('UPDATE temp_channels SET owner_id = ? WHERE channel_id = ?', [member.id, voiceChannel.id]);
        await interaction.reply({ content: `👑 You have successfully claimed this channel!`, flags: MessageFlags.Ephemeral });
        break;
      }

      case 'vc_info': {
        const get = util.promisify(db.get).bind(db);
        const infoRow = await get('SELECT owner_id FROM temp_channels WHERE channel_id = ?', [voiceChannel.id]);
        if (!infoRow) return interaction.reply({ content: 'Could not retrieve info for this channel.', flags: MessageFlags.Ephemeral });

        const ownerMember = await interaction.guild.members.fetch(infoRow.owner_id).catch(() => ({ displayName: 'Unknown User' }));
        const infoEmbed = new EmbedBuilder()
          .setTitle(`Channel Info: ${voiceChannel.name}`)
          .setColor('#2B2D31')
          .addFields(
            { name: 'Owner', value: ownerMember.displayName, inline: true },
            { name: 'Members', value: `${voiceChannel.members.size}`, inline: true },
            { name: 'Created', value: `<t:${parseInt(voiceChannel.createdTimestamp / 1000)}:R>`, inline: true }
          );
        await interaction.reply({ embeds: [infoEmbed], flags: MessageFlags.Ephemeral });
        break;
      }

      default:
        await interaction.reply({ content: `The '${customId}' button has not been implemented yet.`, flags: MessageFlags.Ephemeral });
    }
  }
};
