  require('dotenv').config();

const { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  Collection,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  TextInputStyle,
  MessageFlags,
  ChannelType,
} = require('discord.js');

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
// Firebase Admin (for writing realtime stats to dashboards)
let admin;
try { admin = require('firebase-admin'); } catch {}
const GuildConfigService = require('./config.json');
let devConfig = { developers: [] };
try {
  devConfig = require('./config.json');
} catch {}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// Developer IDs (super users)
client.developers = new Set(Array.isArray(devConfig.developers) ? devConfig.developers : []);
client.isDeveloper = (userId) => client.developers.has(String(userId));

// In-memory pending selections for admin roles UI
const taskAdminPending = new Map(); // key: `${guildId}:${userId}` -> { add: string[], remove: string[] }
// Track the live Task Setup message per user to always update the same message
const taskSetupMessages = new Map(); // key: `${guildId}:${userId}` -> { channelId, messageId }
// Live leaderboard message reference per guild
const voiceLbRefs = new Map(); // key: guildId -> { channelId, messageId }
const voiceLbDebounce = new Map(); // key: guildId -> NodeJS.Timeout
const voicePointsTickers = new Map(); // key: guildId -> NodeJS.Interval
// Setup Points/Time transient state per admin
const setupPTState = new Map(); // key: `${guildId}:${userId}` -> { points:number, unit:'S'|'M'|'H' }

// Ephemeral help session state per user
const epHelpState = new Map(); // key: `${guildId}:${userId}` -> { cat: string|null, page: number, voiceCmds: Array<{name:string,value:string}> }

async function loadVoiceCommandsForEphemeral() {
  try {
    const dir = path.join(__dirname, 'commands', 'voice');
    const entries = await fs.promises.readdir(dir);
    const items = [];
    for (const file of entries) {
      if (!file.endsWith('.js')) continue;
      if (file === 'fm.js') continue;
      if (file.startsWith('_')) continue;
      try {
        const full = path.join(dir, file);
        const mod = require(full);
        const base = path.parse(file).name;
        const name = (mod && typeof mod.name === 'string' && mod.name.trim().length > 0) ? mod.name : base;
        const value = (mod && typeof mod.description === 'string' && mod.description.trim().length > 0) ? mod.description : 'Voice command.';
        items.push({ name, value });
      } catch {}
    }
    items.sort((a,b)=> a.name.localeCompare(b.name));
    return items;
  } catch {
    return [
      { name: 'lock', value: 'Voice command.' },
      { name: 'unlock', value: 'Voice command.' },
      { name: 'rename', value: 'Voice command.' },
    ];
  }
}

function getStaticHelpCategories() {
  return {
    setup: {
      label: 'Setup',
      description: 'Commands for server administrators to configure the bot.',
      commands: [
        { name: '.v setup', value: 'Setup One Tap.' },
        { name: '.v prefix', value: 'Change the bot command prefix.' },
        { name: '.v toggle', value: 'Enable or disable the bot in this server.' },
      ],
    },
    manager: {
      label: 'Manager',
      description: 'Commands to manage bot managers.',
      commands: [
        { name: 'man-add', value: 'Manager Added.' },
        { name: 'man-remove', value: 'Manager Removed.' },
        { name: 'man-clear', value: 'Manager Cleared.' },
      ],
    },
    whitelist: {
      label: 'Whitelist',
      description: 'Manage users who can bypass channel locks.',
      commands: [
        { name: 'wl-add', value: 'whitelist Added.' },
        { name: 'wl-remove', value: 'whitelist Removed.' },
        { name: 'wl-list', value: 'whitelist List.' },
      ],
    },
    blacklist: {
      label: 'Blacklist',
      description: 'Manage users who are banned from your channels.',
      commands: [
        { name: 'bl-add', value: 'blacklist Added.' },
        { name: 'bl-remove', value: 'blacklist Removed.' },
        { name: 'bl-list', value: 'blacklist List .' },
      ],
    },
  };
}

function buildCategoryButtons(selectedKey) {
  const btns = [
    new ButtonBuilder().setCustomId('help_ep_cat_voice').setLabel('Help Bot').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('help_ep_cat_setup').setLabel('Setup').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('help_ep_cat_manager').setLabel('Manager').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('help_ep_cat_whitelist').setLabel('Whitelist').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('help_ep_cat_blacklist').setLabel('Blacklist').setStyle(ButtonStyle.Secondary),
  ];
  const ids = ['voice','setup','manager','whitelist','blacklist'];
  const idx = ids.indexOf(selectedKey);
  if (idx >= 0) btns[idx].setDisabled(true);
  return [
    new ActionRowBuilder().addComponents(...btns.slice(0,3)),
    new ActionRowBuilder().addComponents(...btns.slice(3)),
  ];
}

function buildVoiceNavRow(page, totalPages) {
  const prev = new ButtonBuilder().setCustomId('help_ep_voice_prev').setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0);
  const next = new ButtonBuilder().setCustomId('help_ep_voice_next').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1);
  return new ActionRowBuilder().addComponents(prev, next);
}

function buildEphemeralHelpContainer({ label, bannerImageUrl, commandsList, categoryButtonsRows, voiceNavRow }) {
  const contactUrl = process.env.CONTACT_SUPPORT || 'https://discord.com/users/1536781748807934003';
  const contactBtn = new ButtonBuilder().setLabel('Contact Developer').setStyle(ButtonStyle.Link).setURL(contactUrl);
  const contactRow = new ActionRowBuilder().addComponents(contactBtn);

  const title = new TextDisplayBuilder().setContent(`# Oxygen Bot Help — ${label}`);
  const desc = new TextDisplayBuilder().setContent('Select a category below to view available commands');
  const sep = new SeparatorBuilder();
  const container = new ContainerBuilder()
    .addActionRowComponents(contactRow)
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(title)
    .addSeparatorComponents(sep);

  if (bannerImageUrl && String(bannerImageUrl).toLowerCase() !== 'off') {
    container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(m => m.setURL(bannerImageUrl)))
             .addSeparatorComponents(new SeparatorBuilder());
  }

  container
    .addTextDisplayComponents(desc)
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(...commandsList.map(t => new TextDisplayBuilder().setContent(t)))
    .addSeparatorComponents(new SeparatorBuilder());

  if (voiceNavRow) container.addActionRowComponents(voiceNavRow).addSeparatorComponents(new SeparatorBuilder());
  for (const row of categoryButtonsRows) container.addActionRowComponents(row);
  container
    .addSeparatorComponents(new SeparatorBuilder())
    // .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(m => m.setURL('https://ik.imagekit.io/gwqqjru7p/Ghost%20Space%20(2).png?updatedAt=1763073872360')));

  return container;
}

// Register slash commands per-guild for instant availability
client.once('clientReady', async () => {
  try {
    const commandsData = Array.from(client.slashCommands.values()).map(c => c.data.toJSON());
    if (commandsData.length === 0) return;
    const devName = 'Ghost';
    const regRows = [];
    let ok = 0, fail = 0;
    for (const [gid, guild] of client.guilds.cache) {
      try {
        await guild.commands.set(commandsData);
        // Ensure /resetleaderboard exists (admin only)
        try {
          await guild.commands.create({
            name: 'resetleaderboard',
            description: 'Reset the voice points leaderboard for this server',
            default_member_permissions: String(PermissionsBitField.Flags.Administrator),
          });
        } catch {}
        // Ensure /leaderboardtoggle exists (admin only)
        try {
          await guild.commands.create({
            name: 'leaderboardtoggle',
            description: 'Enable or disable the voice leaderboard system in this server',
            default_member_permissions: String(PermissionsBitField.Flags.Administrator),
            options: [
              {
                name: 'state',
                description: 'Enable or disable the leaderboard',
                type: 3, // STRING
                required: true,
                choices: [
                  { name: 'enable', value: 'enable' },
                  { name: 'disable', value: 'disable' }
                ]
              }
            ]
          });
        } catch {}
      } catch (e) {
        fail++;
      }
    }
    // Condensed professional summary
    const totalGuilds = client.guilds.cache.size;
    const totalCommands = commandsData.length; // same set per guild
    console.log('\n================ Slash Registration ========================');
    console.log(`Developer: ${devName}`);
    console.log(`Servers: ${totalGuilds} | Commands: ${totalCommands} | OK: ${ok} | Failed: ${fail}`);
    console.log('============================================================\n');

    // Start any pre-configured live voice leaderboards (only if enabled)
    db.all('SELECT guild_id, leaderboard_channel_id FROM guild_config WHERE leaderboard_channel_id IS NOT NULL AND COALESCE(leaderboard_enabled,1)=1', async (err, rows) => {
      if (err || !rows) return;
      for (const row of rows) {
        const g = client.guilds.cache.get(row.guild_id);
        if (!g) continue;
        await startOrUpdateVoiceLeaderboard(g, row.leaderboard_channel_id).catch(()=>{});
      }
    });
  } catch (e) {
    console.error('[Slash] Registration error:', e);
  }
});

// Auto-register slash commands on new guilds while bot is running
client.on('guildCreate', async (guild) => {
  try {
    const commandsData = Array.from(client.slashCommands.values()).map(c => c.data.toJSON());
    await guild.commands.set(commandsData);
    try {
      await guild.commands.create({
        name: 'resetleaderboard',
        description: 'Reset the voice points leaderboard for this server',
        default_member_permissions: String(PermissionsBitField.Flags.Administrator),
      });
    } catch {}
    try {
      await guild.commands.create({
        name: 'leaderboardtoggle',
        description: 'Enable or disable the voice leaderboard system in this server',
        default_member_permissions: String(PermissionsBitField.Flags.Administrator),
        options: [
          { name: 'state', description: 'Enable or disable the leaderboard', type: 3, required: true, choices: [ { name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' } ] }
        ]
      });
    } catch {}
    console.log(`[Slash] Registered commands for new guild: ${guild.name} (${guild.id})`);
    // Start leaderboard if configured and enabled
    try {
      const row = await dbGet('SELECT leaderboard_channel_id, COALESCE(leaderboard_enabled,1) as enabled FROM guild_config WHERE guild_id = ?', [guild.id]).catch(()=>null);
      if (row?.leaderboard_channel_id && Number(row.enabled) === 1) {
        await startOrUpdateVoiceLeaderboard(guild, row.leaderboard_channel_id).catch(()=>{});
      }
    } catch {}
  } catch (e) {
    console.error('[Slash] guildCreate registration failed:', e);
  }
});

client.commands = new Collection();
client.aliases = new Collection();
client.slashCommands = new Collection();
const defaultPrefix = '$';

// Diagnostics: check availability of Components V2 builders in current runtime
try {
  const djs = require('discord.js');
  const hasV2 = !!(djs.TextDisplayBuilder && djs.ContainerBuilder);
  console.log('[Diagnostics] Components V2 builders available:', hasV2);
} catch {}

// Initialize logger
const VoiceLogger = require('./utils/logger');
let voiceLogger;

// Handle Setup interactions (selects/buttons/modals) here
client.on('interactionCreate', async (interaction) => {
  try {
    const guild = interaction.guild;
    if (!guild) return;

    // Slash commands: /resetleaderboard, /leaderboardtoggle (developer or guild controller only)
    if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
      if (interaction.commandName === 'resetleaderboard') {
        const isDev = client.isDeveloper?.(interaction.user.id);
        const hasControl = client.hasControlAccess ? await client.hasControlAccess(guild.id, interaction.user.id) : false;
        if (!isDev && !hasControl) {
          return interaction.reply({ content: '<a:unVerif:1440432078356348928> You need bot owner or developer access to use this.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(()=>{});
        try {
          await dbRun('DELETE FROM voice_points_users WHERE guild_id = ?', [guild.id]).catch(()=>{});
          await dbRun('DELETE FROM temp_user_points WHERE guild_id = ?', [guild.id]).catch(()=>{});
          if (client.refreshVoiceLeaderboard) await client.refreshVoiceLeaderboard(guild.id);
          return interaction.editReply('<a:verif_vert:1440432091853492254> Leaderboard has been reset.');
        } catch (e) {
          return interaction.editReply('<a:unVerif:1440432078356348928> Failed to reset leaderboard.');
        }
      } else if (interaction.commandName === 'leaderboardtoggle') {
        const isDev = client.isDeveloper?.(interaction.user.id);
        const hasControl = client.hasControlAccess ? await client.hasControlAccess(guild.id, interaction.user.id) : false;
        if (!isDev && !hasControl) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(()=>{});
          return interaction.editReply('<a:unVerif:1440432078356348928> You do not have permission to use this command.');
        }
        const state = interaction.options.getString('state');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(()=>{});
        try {
          if (state === 'disable') {
            await dbRun('INSERT INTO guild_config(guild_id, leaderboard_enabled) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET leaderboard_enabled = excluded.leaderboard_enabled', [guild.id, 0]);
            // Stop tickers/debouncers if running
            const t = voicePointsTickers.get(guild.id);
            if (t) { clearInterval(t); voicePointsTickers.delete(guild.id); }
            const d = voiceLbDebounce.get(guild.id);
            if (d) { clearTimeout(d); voiceLbDebounce.delete(guild.id); }
            return interaction.editReply('<a:verif_vert:1440432091853492254> Leaderboard has been disabled for this server.');
          } else {
            await dbRun('INSERT INTO guild_config(guild_id, leaderboard_enabled) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET leaderboard_enabled = excluded.leaderboard_enabled', [guild.id, 1]);
            // Start if channel configured
            const row = await dbGet('SELECT leaderboard_channel_id FROM guild_config WHERE guild_id = ?', [guild.id]).catch(()=>null);
            const chId = row?.leaderboard_channel_id;
            if (chId) await startOrUpdateVoiceLeaderboard(guild, chId).catch(()=>{});
            return interaction.editReply('<a:verif_vert:1440432091853492254> Leaderboard has been enabled for this server.');
          }
        } catch (e) {
          console.error('leaderboardtoggle error:', e);
          return interaction.editReply('<a:unVerif:1440432078356348928> Failed to toggle leaderboard.');
        }
      }
    }

    // Select menus for Setup
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'pt_points_select') {
        await interaction.deferUpdate().catch(()=>{});
        const val = Number(interaction.values?.[0] || 10);
        const key = `${guild.id}:${interaction.user.id}`;
        const st = setupPTState.get(key) || {};
        const pointsNow = isNaN(val) ? 10 : val;
        setupPTState.set(key, { ...st, points: pointsNow });
        // Rebuild minimal PT container with summary
        const title = new TextDisplayBuilder().setContent('# Points / Time Controls');
        const desc = new TextDisplayBuilder().setContent('Pick a time preset then press Add Time. You can also type a custom value like 3s / 4m / 1h.');
        const timePresetSelect = new StringSelectMenuBuilder()
          .setCustomId('pt_time_preset_select')
          .setPlaceholder('Select time preset')
          .addOptions([
            new StringSelectMenuOptionBuilder().setLabel('1s').setValue('1s'),
            new StringSelectMenuOptionBuilder().setLabel('2s').setValue('2s'),
            new StringSelectMenuOptionBuilder().setLabel('5s').setValue('5s'),
            new StringSelectMenuOptionBuilder().setLabel('10s').setValue('10s'),
            new StringSelectMenuOptionBuilder().setLabel('30s').setValue('30s'),
            new StringSelectMenuOptionBuilder().setLabel('1m').setValue('1m'),
            new StringSelectMenuOptionBuilder().setLabel('2m').setValue('2m'),
            new StringSelectMenuOptionBuilder().setLabel('5m').setValue('5m'),
            new StringSelectMenuOptionBuilder().setLabel('10m').setValue('10m'),
            new StringSelectMenuOptionBuilder().setLabel('30m').setValue('30m'),
            new StringSelectMenuOptionBuilder().setLabel('1h').setValue('1h'),
          ]);
        const timePresetRow = new ActionRowBuilder().addComponents(timePresetSelect);
        const addTimeBtn = new ButtonBuilder().setCustomId('pt_time_manual_btn').setLabel('Add Time').setStyle(ButtonStyle.Secondary);
        const addTimeRow = new ActionRowBuilder().addComponents(addTimeBtn);
        const pointsPresetSelect = new StringSelectMenuBuilder()
          .setCustomId('pt_points_select')
          .setPlaceholder('Select points preset')
          .addOptions([
            new StringSelectMenuOptionBuilder().setLabel('10 pts').setValue('10'),
            new StringSelectMenuOptionBuilder().setLabel('20 pts').setValue('20'),
            new StringSelectMenuOptionBuilder().setLabel('50 pts').setValue('50'),
            new StringSelectMenuOptionBuilder().setLabel('100 pts').setValue('100'),
            new StringSelectMenuOptionBuilder().setLabel('200 pts').setValue('200'),
            new StringSelectMenuOptionBuilder().setLabel('500 pts').setValue('500'),
            new StringSelectMenuOptionBuilder().setLabel('1000 pts').setValue('1000'),
          ]);
        const pointsPresetRow = new ActionRowBuilder().addComponents(pointsPresetSelect);
        const addPointsBtn = new ButtonBuilder().setCustomId('pt_points_manual_btn').setLabel('Add Points').setStyle(ButtonStyle.Secondary);
        const addPointsRow = new ActionRowBuilder().addComponents(addPointsBtn);
        const scheduleBtn = new ButtonBuilder().setCustomId('pt_schedule_award').setLabel('Apply').setStyle(ButtonStyle.Success);
        const scheduleRow = new ActionRowBuilder().addComponents(scheduleBtn);
        const cur = setupPTState.get(key) || { preset: '1m', points: pointsNow };
        const preset = cur.preset || '1m';
        const pts = Math.max(1, Number(cur.points || pointsNow));
        let sec = 60; if (/^\d+[smh]$/i.test(preset)) { const n=parseInt(preset,10); const u=preset.slice(-1).toLowerCase(); sec = u==='h'?n*3600:u==='s'?n:n*60; }
        const ppm = Math.round(((pts*60)/(sec||60))*100)/100;
        const summary = new TextDisplayBuilder().setContent(`Current: **${preset} → ${pts} pts**  •  Rate: **${ppm} pts/min**`);
        const container = new ContainerBuilder()
          .addTextDisplayComponents(title)
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(desc)
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(summary)
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(timePresetRow)
          .addActionRowComponents(addTimeRow)
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(pointsPresetRow)
          .addActionRowComponents(addPointsRow)
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(scheduleRow);
        return interaction.editReply({ components: [container], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 }).catch(()=>{});
      }
      if (interaction.customId === 'pt_time_preset_select') {
        await interaction.deferUpdate().catch(()=>{});
        const val = (interaction.values?.[0] || '1m');
        const key = `${guild.id}:${interaction.user.id}`;
        const st = setupPTState.get(key) || {};
        setupPTState.set(key, { ...st, preset: val });
        // Rebuild minimal PT container with summary
        const title = new TextDisplayBuilder().setContent('# Points / Time Controls');
        const desc = new TextDisplayBuilder().setContent('Pick a time preset then press Add Time. You can also type a custom value like 3s / 4m / 1h.');
        const timePresetSelect = new StringSelectMenuBuilder()
          .setCustomId('pt_time_preset_select')
          .setPlaceholder('Select time preset')
          .addOptions([
            new StringSelectMenuOptionBuilder().setLabel('1s').setValue('1s'),
            new StringSelectMenuOptionBuilder().setLabel('2s').setValue('2s'),
            new StringSelectMenuOptionBuilder().setLabel('5s').setValue('5s'),
            new StringSelectMenuOptionBuilder().setLabel('10s').setValue('10s'),
            new StringSelectMenuOptionBuilder().setLabel('30s').setValue('30s'),
            new StringSelectMenuOptionBuilder().setLabel('1m').setValue('1m'),
            new StringSelectMenuOptionBuilder().setLabel('2m').setValue('2m'),
            new StringSelectMenuOptionBuilder().setLabel('5m').setValue('5m'),
            new StringSelectMenuOptionBuilder().setLabel('10m').setValue('10m'),
            new StringSelectMenuOptionBuilder().setLabel('30m').setValue('30m'),
            new StringSelectMenuOptionBuilder().setLabel('1h').setValue('1h'),
          ]);
        const timePresetRow = new ActionRowBuilder().addComponents(timePresetSelect);
        const addTimeBtn = new ButtonBuilder().setCustomId('pt_time_manual_btn').setLabel('Add Time').setStyle(ButtonStyle.Secondary);
        const addTimeRow = new ActionRowBuilder().addComponents(addTimeBtn);
        const pointsPresetSelect = new StringSelectMenuBuilder()
          .setCustomId('pt_points_select')
          .setPlaceholder('Select points preset')
          .addOptions([
            new StringSelectMenuOptionBuilder().setLabel('10 pts').setValue('10'),
            new StringSelectMenuOptionBuilder().setLabel('20 pts').setValue('20'),
            new StringSelectMenuOptionBuilder().setLabel('50 pts').setValue('50'),
            new StringSelectMenuOptionBuilder().setLabel('100 pts').setValue('100'),
            new StringSelectMenuOptionBuilder().setLabel('200 pts').setValue('200'),
            new StringSelectMenuOptionBuilder().setLabel('500 pts').setValue('500'),
            new StringSelectMenuOptionBuilder().setLabel('1000 pts').setValue('1000'),
          ]);
        const pointsPresetRow = new ActionRowBuilder().addComponents(pointsPresetSelect);
        const addPointsBtn = new ButtonBuilder().setCustomId('pt_points_manual_btn').setLabel('Add Points').setStyle(ButtonStyle.Secondary);
        const addPointsRow = new ActionRowBuilder().addComponents(addPointsBtn);
        const scheduleBtn = new ButtonBuilder().setCustomId('pt_schedule_award').setLabel('Apply').setStyle(ButtonStyle.Success);
        const scheduleRow = new ActionRowBuilder().addComponents(scheduleBtn);
        const cur = setupPTState.get(key) || { preset: val, points: 10 };
        const preset = cur.preset || val;
        const pts = Math.max(1, Number(cur.points || 10));
        let sec = 60; if (/^\d+[smh]$/i.test(preset)) { const n=parseInt(preset,10); const u=preset.slice(-1).toLowerCase(); sec = u==='h'?n*3600:u==='s'?n:n*60; }
        const ppm = Math.round(((pts*60)/(sec||60))*100)/100;
        const summary = new TextDisplayBuilder().setContent(`Current: **${preset} → ${pts} pts**  •  Rate: **${ppm} pts/min**`);
        const container = new ContainerBuilder()
          .addTextDisplayComponents(title)
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(desc)
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(summary)
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(timePresetRow)
          .addActionRowComponents(addTimeRow)
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(pointsPresetRow)
          .addActionRowComponents(addPointsRow)
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(scheduleRow);
        return interaction.editReply({ components: [container], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 }).catch(()=>{});
      }
      if (interaction.customId === 'setup_logs_select') {
        const selected = interaction.values?.[0];
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        if (!selected) return interaction.editReply('<a:unVerif:1440432078356348928> No channel selected.').catch(() => {});
        try {
          await dbRun('INSERT INTO guild_config(guild_id, log_channel_id) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET log_channel_id = excluded.log_channel_id', [guild.id, selected]);
          return interaction.editReply(`<a:verif_vert:1440432091853492254> Logs channel set to <#${selected}>`).catch(() => {});
        } catch (e) {
          console.error('setup_logs_select error:', e);
          return interaction.editReply('<a:unVerif:1440432078356348928> Failed to save logs channel.').catch(() => {});
        }
      }
      if (interaction.customId === 'setup_lobby_select') {
        const selected = interaction.values?.[0];
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        if (!selected) return interaction.editReply('<a:unVerif:1440432078356348928> No channel selected.').catch(() => {});
        try {
          await dbRun('INSERT INTO guild_config(guild_id, lobby_channel_id) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET lobby_channel_id = excluded.lobby_channel_id', [guild.id, selected]);
          return interaction.editReply(`<a:verif_vert:1440432091853492254> Lobby voice channel set to <#${selected}>`).catch(() => {});
        } catch (e) {
          console.error('setup_lobby_select error:', e);
          return interaction.editReply('<a:unVerif:1440432078356348928> Failed to save lobby channel.').catch(() => {});
        }
      }
      if (interaction.customId === 'setup_category_select') {
        const selected = interaction.values?.[0];
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        if (!selected) return interaction.editReply('<a:unVerif:1440432078356348928> No category selected.').catch(() => {});
        try {
          await dbRun('INSERT INTO guild_config(guild_id, temp_category_id) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET temp_category_id = excluded.temp_category_id', [guild.id, selected]);
          return interaction.editReply(`<a:verif_vert:1440432091853492254> Temp voice category set to ${selected}`).catch(() => {});
        } catch (e) {
          console.error('setup_category_select error:', e);
          return interaction.editReply('<a:unVerif:1440432078356348928> Failed to save category.').catch(() => {});
        }
      }
      if (interaction.customId === 'setup_reject_select') {
        const selected = interaction.values?.[0];
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        if (!selected) return interaction.editReply('<a:unVerif:1440432078356348928> No channel selected.').catch(() => {});
        try {
          await dbRun('INSERT INTO guild_config(guild_id, reject_channel_id) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET reject_channel_id = excluded.reject_channel_id', [guild.id, selected]);
          return interaction.editReply(`<a:verif_vert:1440432091853492254> Reject channel set to <#${selected}>`).catch(() => {});
        } catch (e) {
          console.error('setup_reject_select error:', e);
          return interaction.editReply('<a:unVerif:1440432078356348928> Failed to save reject channel.').catch(() => {});
        }
      }
      if (interaction.customId === 'setup_leaderboard_select') {
        const selected = interaction.values?.[0];
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        if (!selected) return interaction.editReply('<a:unVerif:1440432078356348928> No channel selected.').catch(() => {});
        try {
          await dbRun('INSERT INTO guild_config(guild_id, leaderboard_channel_id) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET leaderboard_channel_id = excluded.leaderboard_channel_id', [guild.id, selected]);
          await startOrUpdateVoiceLeaderboard(guild, selected).catch(()=>{});
          return interaction.editReply(`<a:verif_vert:1440432091853492254> Leaderboard channel set to <#${selected}>`).catch(() => {});
        } catch (e) {
          console.error('setup_leaderboard_select error:', e);
          return interaction.editReply('<a:unVerif:1440432078356348928> Failed to save leaderboard channel.').catch(() => {});
        }
      }
    }

    // Buttons to open modals / bot toggle
    if (interaction.isButton()) {
      if (interaction.customId === 'bot_toggle_switch') {
        // Toggle for enabling/disabling the bot in this guild (developer or guild controller only)
        const isDev = client.isDeveloper?.(interaction.user.id);
        const hasControl = client.hasControlAccess ? await client.hasControlAccess(guild.id, interaction.user.id) : false;
        if (!isDev && !hasControl) {
          return interaction.reply({ content: '<a:unVerif:1440432078356348928> You need bot owner or developer access to toggle the bot.', flags: MessageFlags.Ephemeral }).catch(()=>{});
        }
        if (!client.config || !client.config.getBotEnabled || !client.config.setBotEnabled) {
          return interaction.reply({ content: '<a:unVerif:1440432078356348928> Configuration service is not initialized.', flags: MessageFlags.Ephemeral }).catch(()=>{});
        }
        let enabled = true;
        try {
          enabled = await client.config.getBotEnabled(guild.id);
        } catch (e) {
          console.error('bot_toggle_switch getBotEnabled error:', e);
        }
        const newState = !enabled;
        try {
          await client.config.setBotEnabled(guild.id, newState);
        } catch (e) {
          console.error('bot_toggle_switch setBotEnabled error:', e);
          return interaction.reply({ content: '<a:unVerif:1440432078356348928> Failed to update bot enabled state.', flags: MessageFlags.Ephemeral }).catch(()=>{});
        }
        const title = new TextDisplayBuilder().setContent('# Bot Toggle');
        const statusLine = newState ? 'Enabled' : 'Disabled';
        const desc = new TextDisplayBuilder().setContent(`Status: **${statusLine}**`);
        const btnLabel = newState ? 'Disable Bot' : 'Enable Bot';
        const btnStyle = newState ? ButtonStyle.Danger : ButtonStyle.Success;
        const toggleBtn = new ButtonBuilder().setCustomId('bot_toggle_switch').setLabel(btnLabel).setStyle(btnStyle);
        const row = new ActionRowBuilder().addComponents(toggleBtn);
        const container = new ContainerBuilder()
          .addTextDisplayComponents(title)
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(desc)
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(row);
        return interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
      }
      if (interaction.customId === 'task_setup_open') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(()=>{});
        // Allow developers or approved guild owners/controllers
        const rowOwner = await dbGet('SELECT 1 FROM guild_owners WHERE guild_id = ? AND user_id = ?', [guild.id, interaction.user.id]).catch(()=>null);
        const isDev = client.isDeveloper?.(interaction.user.id);
        const ownerAllowed = !!rowOwner;
        if (!isDev && !ownerAllowed) {
          const contactUrl = process.env.CONTACT_SUPPORT || 'https://discord.com/users/1536781748807934003';
          const btnRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Contact Developer').setStyle(ButtonStyle.Link).setURL(contactUrl)
          );
          try {
            const containerReply = new ContainerBuilder()
              .addTextDisplayComponents(new TextDisplayBuilder().setContent('<a:unVerif:1440432078356348928> You do not have permission to open Task Setup.'))
              .addSeparatorComponents(new SeparatorBuilder())
              .addActionRowComponents(btnRow);
            return await interaction.editReply({
              components: [containerReply],
              flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
            });
          } catch (e) {
            console.error('task_setup_open (deny) reply failed, retrying V2:', e?.message || e);
            try {
              const containerReply = new ContainerBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent('<a:unVerif:1440432078356348928> You do not have permission to open Task Setup.'))
                .addSeparatorComponents(new SeparatorBuilder())
                .addActionRowComponents(btnRow);
              // Retry with same V2 flags
              return await interaction.editReply({ components: [containerReply], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
            } catch (e2) {
              console.error('task_setup_open (deny) V2 retry failed, trying followUp:', e2?.message || e2);
              try {
                const containerReply = new ContainerBuilder()
                  .addTextDisplayComponents(new TextDisplayBuilder().setContent('<a:unVerif:1440432078356348928> You do not have permission to open Task Setup.'))
                  .addSeparatorComponents(new SeparatorBuilder())
                  .addActionRowComponents(btnRow);
                return await interaction.followUp({ components: [containerReply], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
              } catch (e3) {
                console.error('task_setup_open (deny) followUp failed:', e3?.message || e3);
                // Last resort: keep buttons without embeds to at least show contact
                return interaction.editReply({ components: [btnRow] }).catch(() => {});
              }
            }
          }
        }
        // Authorized: show Task Setup container styled like Points/Time
        try {
          const title = new TextDisplayBuilder().setContent('# Task Setup');
          const desc = new TextDisplayBuilder().setContent('Use the controls below to configure task settings.');
          const btnOpenPT = new ButtonBuilder().setCustomId('setup_points_time_panel').setLabel('Points / Time').setStyle(ButtonStyle.Secondary);
          const row = new ActionRowBuilder().addComponents(btnOpenPT);
          const contactUrl = process.env.CONTACT_SUPPORT || 'https://discord.com/users/1536781748807934003';
          const contactRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Contact Developer').setStyle(ButtonStyle.Link).setURL(contactUrl)
          );
          const container = new ContainerBuilder()
            .addActionRowComponents(contactRow)
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(title)
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(desc)
            .addSeparatorComponents(new SeparatorBuilder())
            .addActionRowComponents(row);
          return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
        } catch {
          return interaction.editReply({ content: '<a:verif_vert:1440432091853492254> Opening Task Setup...' }).catch(()=>{});
        }
      }
      if (interaction.customId === 'setup_search_logs') {
        const modal = new ModalBuilder().setCustomId('setupLogsModal').setTitle('Set Logs Channel by ID');
        const input = new TextInputBuilder().setCustomId('channelIdInput').setLabel('Text Channel ID').setStyle(TextInputStyle.Short).setPlaceholder('e.g., 123456789012345678').setRequired(true).setMaxLength(25);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }
      if (interaction.customId === 'setup_search_lobby') {
        const modal = new ModalBuilder().setCustomId('setupLobbyModal').setTitle('Set Lobby Voice by ID');
        const input = new TextInputBuilder().setCustomId('channelIdInput').setLabel('Voice Channel ID').setStyle(TextInputStyle.Short).setPlaceholder('e.g., 123456789012345678').setRequired(true).setMaxLength(25);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }
      if (interaction.customId === 'setup_search_leaderboard') {
        const modal = new ModalBuilder().setCustomId('setupLeaderboardModal').setTitle('Set Leaderboard Channel by ID');
        const input = new TextInputBuilder().setCustomId('channelIdInput').setLabel('Text Channel ID').setStyle(TextInputStyle.Short).setPlaceholder('e.g., 123456789012345678').setRequired(true).setMaxLength(25);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }
      if (interaction.customId === 'setup_search_category') {
        const modal = new ModalBuilder().setCustomId('setupCategoryModal').setTitle('Set Temp Category by ID');
        const input = new TextInputBuilder().setCustomId('channelIdInput').setLabel('Category Channel ID').setStyle(TextInputStyle.Short).setPlaceholder('e.g., 123456789012345678').setRequired(true).setMaxLength(25);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }
      if (interaction.customId === 'setup_search_reject') {
        const modal = new ModalBuilder().setCustomId('setupRejectModal').setTitle('Set Reject Voice by ID');
        const input = new TextInputBuilder().setCustomId('channelIdInput').setLabel('Voice Channel ID').setStyle(TextInputStyle.Short).setPlaceholder('e.g., 123456789012345678').setRequired(true).setMaxLength(25);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }
      if (interaction.customId === 'help_category_general') {
        try {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(()=>{});
          // Contact link
          const contactUrl = process.env.CONTACT_SUPPORT || 'https://discord.com/users/1536781748807934003';
          const contactBtn = new ButtonBuilder().setLabel('Contact Developer').setStyle(ButtonStyle.Link).setURL(contactUrl);
          const contactRow = new ActionRowBuilder().addComponents(contactBtn);

          // Resolve banner similar to help.js
          let style = 'a';
          try {
            const row = await new Promise((resolve) => {
              db.get('SELECT control_panel_style FROM guild_config WHERE guild_id = ?', [guild.id], (err, r) => resolve(r || null));
            });
            if (row?.control_panel_style) style = String(row.control_panel_style).toLowerCase();
          } catch {}
          const bannerByStyle = {
            a: process.env.HELP_BANNER_URL_A || 'https://ik.imagekit.io/gwqqjru7p/onetap.gif?updatedAt=1755271990900',
            b: process.env.HELP_BANNER_URL_B || 'https://ik.imagekit.io/gwqqjru7p/download%20(20).gif?updatedAt=1763044977901',
            c: process.env.HELP_BANNER_URL_C || 'https://ik.imagekit.io/gwqqjru7p/download%20(25).gif?updatedAt=1763075651339',
          };
          const defaultBanner = bannerByStyle[style] || bannerByStyle.a;
          const bannerImageUrl = process.env.HELP_BANNER_URL || defaultBanner;
          const bannerImage = bannerImageUrl && String(bannerImageUrl).toLowerCase() !== 'off'
            ? new MediaGalleryBuilder().addItems(m => m.setURL(bannerImageUrl))
            : null;

          // Title & description
          const titleText = new TextDisplayBuilder().setContent('# v!cky Bot Help');
          const descriptionText = new TextDisplayBuilder().setContent(' -  Select a category below to view available commands');

          // Category buttons (interactive, ephemeral-only)
          const catButtons = [
            new ButtonBuilder().setCustomId('help_ep_cat_voice').setLabel('Help Bot').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('help_ep_cat_setup').setLabel('Setup').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('help_ep_cat_manager').setLabel('Manager').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('help_ep_cat_whitelist').setLabel('Whitelist').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('help_ep_cat_blacklist').setLabel('Blacklist').setStyle(ButtonStyle.Secondary),
          ];
          const catRow1 = new ActionRowBuilder().addComponents(...catButtons.slice(0, 3));
          const catRow2 = new ActionRowBuilder().addComponents(...catButtons.slice(3));

          // Footer image
          // const footerImg = new MediaGalleryBuilder().addItems(m => m.setURL('https://ik.imagekit.io/gwqqjru7p/v!cky%20Space%20(2).png?updatedAt=1763073872360'));

          // Build container
          const sep1 = new SeparatorBuilder();
          const sep2 = new SeparatorBuilder();
          const sep3 = new SeparatorBuilder();
          const sep4 = new SeparatorBuilder();
          const container = new ContainerBuilder()
            .addActionRowComponents(contactRow)
            .addSeparatorComponents(sep1)
            .addTextDisplayComponents(titleText)
            .addSeparatorComponents(sep2)
            .addMediaGalleryComponents(...(bannerImage ? [bannerImage] : []))
            .addSeparatorComponents(sep3)
            .addTextDisplayComponents(descriptionText)
            .addSeparatorComponents(sep4)
            .addActionRowComponents(catRow1)
            .addActionRowComponents(catRow2)
            .addSeparatorComponents(new SeparatorBuilder());
            // .addMediaGalleryComponents(footerImg)
            // .addSeparatorComponents(new SeparatorBuilder());

          return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
        } catch (e) {
          // Fallback: ensure we still respond ephemerally
          try {
            if (!interaction.deferred && !interaction.replied) {
              return interaction.reply({ content: 'Help panel is unavailable right now.', flags: MessageFlags.Ephemeral }).catch(()=>{});
            }
            return interaction.editReply({ content: 'Help panel is unavailable right now.' }).catch(()=>{});
          } catch {}
        }
      }
      if (interaction.customId && interaction.customId.startsWith('help_ep_cat_')) {
        try {
          const keySel = interaction.customId.replace('help_ep_cat_', '');
          const categories = getStaticHelpCategories();
          const labelMap = { voice: 'Help Bot', setup: 'Setup', manager: 'Manager', whitelist: 'Whitelist', blacklist: 'Blacklist' };
          const label = labelMap[keySel] || 'Help';

          // Load voice commands once per user
          const stateKey = `${guild.id}:${interaction.user.id}`;
          let st = epHelpState.get(stateKey);
          if (!st || !Array.isArray(st.voiceCmds)) {
            const voiceCmds = await loadVoiceCommandsForEphemeral();
            st = { cat: keySel, page: 0, voiceCmds };
          } else {
            st.cat = keySel;
          }
          // Voice pagination setup
          const PAGE_SIZE = 5;
          const totalPages = Math.max(1, Math.ceil((st.voiceCmds?.length || 0) / PAGE_SIZE));
          if (keySel !== 'voice') st.page = 0;

          // Build commands list
          let commandsList = [];
          if (keySel === 'voice') {
            const start = st.page * PAGE_SIZE;
            const slice = st.voiceCmds.slice(start, start + PAGE_SIZE);
            commandsList = slice.map(c => `**\`${c.name}\`**: ${c.value}`);
          } else if (categories[keySel]) {
            commandsList = categories[keySel].commands.map(c => `**\`${c.name}\`**: ${c.value}`);
          }

          // Category buttons rows
          const catRows = buildCategoryButtons(keySel);
          const voiceNavRow = keySel === 'voice' ? buildVoiceNavRow(st.page, totalPages) : null;

          // Banner by style
          let style = 'a';
          try {
            const row = await new Promise((resolve) => {
              db.get('SELECT control_panel_style FROM guild_config WHERE guild_id = ?', [guild.id], (err, r) => resolve(r || null));
            });
            if (row?.control_panel_style) style = String(row.control_panel_style).toLowerCase();
          } catch {}
          const bannerByStyle = {
            a: process.env.HELP_BANNER_URL_A || 'https://ik.imagekit.io/gwqqjru7p/download%20(20).gif?updatedAt=1763044977901',
            b: process.env.HELP_BANNER_URL_B || 'https://ik.imagekit.io/gwqqjru7p/onetap.gif?updatedAt=1755271990900',
            c: process.env.HELP_BANNER_URL_C || 'https://ik.imagekit.io/gwqqjru7p/download%20(25).gif?updatedAt=1763075651339',
          };
          const bannerImageUrl = process.env.HELP_BANNER_URL || bannerByStyle[style] || bannerByStyle.a;

          const container = buildEphemeralHelpContainer({
            label,
            bannerImageUrl,
            commandsList,
            categoryButtonsRows: catRows,
            voiceNavRow,
          });

          epHelpState.set(stateKey, st);
          return interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
        } catch (e) {
          return interaction.deferUpdate().catch(()=>{});
        }
      }
      if (interaction.customId === 'help_ep_voice_prev' || interaction.customId === 'help_ep_voice_next') {
        try {
          const stateKey = `${guild.id}:${interaction.user.id}`;
          let st = epHelpState.get(stateKey);
          if (!st) {
            st = { cat: 'voice', page: 0, voiceCmds: await loadVoiceCommandsForEphemeral() };
          }
          const PAGE_SIZE = 5;
          const totalPages = Math.max(1, Math.ceil((st.voiceCmds?.length || 0) / PAGE_SIZE));
          if (interaction.customId === 'help_ep_voice_prev') st.page = Math.max(0, st.page - 1);
          else st.page = Math.min(totalPages - 1, st.page + 1);

          const start = st.page * PAGE_SIZE;
          const slice = st.voiceCmds.slice(start, start + PAGE_SIZE);
          const commandsList = slice.map(c => `**\`${c.name}\`**: ${c.value}`);
          const catRows = buildCategoryButtons('voice');
          const voiceNavRow = buildVoiceNavRow(st.page, totalPages);

          // Banner by style
          let style = 'a';
          try {
            const row = await new Promise((resolve) => {
              db.get('SELECT control_panel_style FROM guild_config WHERE guild_id = ?', [guild.id], (err, r) => resolve(r || null));
            });
            if (row?.control_panel_style) style = String(row.control_panel_style).toLowerCase();
          } catch {}
          const bannerByStyle = {
            a: process.env.HELP_BANNER_URL_A || 'https://ik.imagekit.io/gwqqjru7p/download%20(20).gif?updatedAt=1763044977901',
            b: process.env.HELP_BANNER_URL_B || 'https://ik.imagekit.io/gwqqjru7p/onetap.gif?updatedAt=1755271990900',
            c: process.env.HELP_BANNER_URL_C || 'https://ik.imagekit.io/gwqqjru7p/download%20(25).gif?updatedAt=1763075651339',
          };
          const bannerImageUrl = process.env.HELP_BANNER_URL || bannerByStyle[style] || bannerByStyle.a;

          const container = buildEphemeralHelpContainer({
            label: 'Help Bot',
            bannerImageUrl,
            commandsList,
            categoryButtonsRows: catRows,
            voiceNavRow,
          });

          epHelpState.set(stateKey, st);
          return interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
        } catch (e) {
          return interaction.deferUpdate().catch(()=>{});
        }
      }
      if (interaction.customId === 'setup_points_time_panel') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(()=>{});
        // ONLY allow explicit guild owners/controllers via /owneradd
        const rowOwner = await dbGet('SELECT 1 FROM guild_owners WHERE guild_id = ? AND user_id = ?', [guild.id, interaction.user.id]).catch(()=>null);
        const isDev = client.isDeveloper?.(interaction.user.id);
        const ownerAllowed = !!rowOwner;
        if (!isDev && !ownerAllowed) {
          const contactUrl = process.env.CONTACT_SUPPORT || 'https://discord.com/users/1536781748807934003';
          const btnRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Contact Developer').setStyle(ButtonStyle.Link).setURL(contactUrl)
          );
          try {
            const containerReply = new ContainerBuilder()
              .addTextDisplayComponents(new TextDisplayBuilder().setContent('<a:unVerif:1440432078356348928> You do not have permission to open Points / Time controls.'))
              .addSeparatorComponents(new SeparatorBuilder())
              .addActionRowComponents(btnRow);
            return await interaction.editReply({
              components: [containerReply],
              flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
            });
          } catch (e) {
            console.error('setup_points_time_panel (deny) reply failed, falling back:', e?.message || e);
            const embed = new EmbedBuilder()
              .setColor(0xFF5555)
              .setDescription('<a:unVerif:1440432078356348928> You do not have permission to open Points / Time controls.\nContact the developer if you believe this is a mistake.');
            return interaction.editReply({
              embeds: [embed],
              components: [btnRow]
            }).catch(err => console.error('setup_points_time_panel (deny) fallback failed:', err?.message || err));
          }
        }
        // Minimal panel: time preset select + single Add Time button; applies to the clicking user
        const key = `${guild.id}:${interaction.user.id}`;
        setupPTState.set(key, { preset: '1m', points: 10 });
        const title = new TextDisplayBuilder().setContent('# Points / Time Controls');
        const desc = new TextDisplayBuilder().setContent('Pick a time preset then press Add Time. You can also type a custom value like 3s / 4m / 1h.');
        const timePresetSelect = new StringSelectMenuBuilder()
          .setCustomId('pt_time_preset_select')
          .setPlaceholder('Select time preset')
          .addOptions([
            new StringSelectMenuOptionBuilder().setLabel('1s').setValue('1s'),
            new StringSelectMenuOptionBuilder().setLabel('2s').setValue('2s'),
            new StringSelectMenuOptionBuilder().setLabel('5s').setValue('5s'),
            new StringSelectMenuOptionBuilder().setLabel('10s').setValue('10s'),
            new StringSelectMenuOptionBuilder().setLabel('30s').setValue('30s'),
            new StringSelectMenuOptionBuilder().setLabel('1m').setValue('1m').setDefault(true),
            new StringSelectMenuOptionBuilder().setLabel('2m').setValue('2m'),
            new StringSelectMenuOptionBuilder().setLabel('5m').setValue('5m'),
            new StringSelectMenuOptionBuilder().setLabel('10m').setValue('10m'),
            new StringSelectMenuOptionBuilder().setLabel('30m').setValue('30m'),
            new StringSelectMenuOptionBuilder().setLabel('1h').setValue('1h'),
          ]);
        const timePresetRow = new ActionRowBuilder().addComponents(timePresetSelect);
        const addTimeBtn = new ButtonBuilder().setCustomId('pt_time_manual_btn').setLabel('Add Time').setStyle(ButtonStyle.Secondary);
        const addTimeRow = new ActionRowBuilder().addComponents(addTimeBtn);
        // Points controls (separate)
        const pointsPresetSelect = new StringSelectMenuBuilder()
          .setCustomId('pt_points_select')
          .setPlaceholder('Select points preset')
          .addOptions([
            new StringSelectMenuOptionBuilder().setLabel('10 pts').setValue('10').setDefault(true),
            new StringSelectMenuOptionBuilder().setLabel('20 pts').setValue('20'),
            new StringSelectMenuOptionBuilder().setLabel('50 pts').setValue('50'),
            new StringSelectMenuOptionBuilder().setLabel('100 pts').setValue('100'),
            new StringSelectMenuOptionBuilder().setLabel('200 pts').setValue('200'),
            new StringSelectMenuOptionBuilder().setLabel('500 pts').setValue('500'),
            new StringSelectMenuOptionBuilder().setLabel('1000 pts').setValue('1000'),
          ]);
        const pointsPresetRow = new ActionRowBuilder().addComponents(pointsPresetSelect);
        const addPointsBtn = new ButtonBuilder().setCustomId('pt_points_manual_btn').setLabel('Add Points').setStyle(ButtonStyle.Secondary);
        const addPointsRow = new ActionRowBuilder().addComponents(addPointsBtn);
        // Schedule accrual button (uses current time preset + points preset)
        const scheduleBtn = new ButtonBuilder().setCustomId('pt_schedule_award').setLabel('Apply').setStyle(ButtonStyle.Success);
        const scheduleRow = new ActionRowBuilder().addComponents(scheduleBtn);
        // Summary of current selection
        const st0 = setupPTState.get(key) || { preset: '1m', points: 10 };
        const preset0 = st0.preset || '1m';
        const pts0 = Math.max(1, Number(st0.points || 10));
        let sec0 = 60; { if (/^\d+[smh]$/i.test(preset0)) { const n = parseInt(preset0,10); const u=preset0.slice(-1).toLowerCase(); sec0 = u==='h'?n*3600:u==='s'?n:n*60; } }
        const ppm0 = Math.round(((pts0*60)/(sec0||60))*100)/100;
        const summary0 = new TextDisplayBuilder().setContent(`Current: **${preset0} → ${pts0} pts**  •  Rate: **${ppm0} pts/min**`);

        const container = new ContainerBuilder()
          .addTextDisplayComponents(title)
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(desc)
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(summary0)
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(timePresetRow)
          .addActionRowComponents(addTimeRow)
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(pointsPresetRow)
          .addActionRowComponents(addPointsRow)
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(scheduleRow)
          .addSeparatorComponents(new SeparatorBuilder());
          // .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(item => item.setURL('https://ik.imagekit.io/gwqqjru7p/v!cky%20Space%20(2).png?updatedAt=1763073872360')));
        try {
          return await interaction.editReply({ components: [container], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
        } catch (e) {
          console.error('setup_points_time_panel (panel) reply failed, falling back:', e?.message || e);
          // Fallback plain text if Components V2 payload is not accepted
          return interaction.editReply({
            content: 'Points / Time Controls:\n- Select a time preset and click "Add Time"\n- Select a points preset and click "Add Points"\n- Click Apply to schedule the current selections.'
          }).catch(err => console.error('setup_points_time_panel (panel) fallback failed:', err?.message || err));
        }
      }
      if (interaction.customId === 'pt_time_manual_btn') {
        const modal = new ModalBuilder().setCustomId('ptTimeManual').setTitle('Add Time Manually');
        const amount = new TextInputBuilder().setCustomId('amountInput').setLabel('Time Amount').setStyle(TextInputStyle.Short).setPlaceholder('e.g., 3s or 4m or 1h').setRequired(true).setMaxLength(10);
        modal.addComponents(new ActionRowBuilder().addComponents(amount));
        return interaction.showModal(modal);
      }
      if (interaction.customId === 'pt_points_manual_btn') {
        const modal = new ModalBuilder().setCustomId('ptPointsManual').setTitle('Add Points Manually');
        const amount = new TextInputBuilder().setCustomId('pointsInput').setLabel('Points Amount').setStyle(TextInputStyle.Short).setPlaceholder('e.g., 50').setRequired(true).setMaxLength(6);
        modal.addComponents(new ActionRowBuilder().addComponents(amount));
        return interaction.showModal(modal);
      }
      if (interaction.customId === 'pt_schedule_award') {
        const key = `${guild.id}:${interaction.user.id}`;
        const st = setupPTState.get(key) || { preset: '1m', points: 10 };
        const preset = (st.preset || '1m');
        const pts = Math.max(1, Number(st.points || 10));
        // Parse preset to seconds
        let requiredSec = 60;
        if (/^\d+[smh]$/i.test(preset)) {
          const num = parseInt(preset, 10);
          const u = preset.slice(-1).toLowerCase();
          requiredSec = u === 'h' ? num * 3600 : u === 's' ? num : num * 60;
        }
        // Store guild-wide points per minute derived from selection
        const ppm = Math.max(0.1, (pts * 60) / (requiredSec || 60));
        await dbRun(`INSERT INTO guild_config(guild_id, voice_points_per_minute, voice_points_required_sec, voice_points_points)
                     VALUES(?, ?, ?, ?)
                     ON CONFLICT(guild_id) DO UPDATE SET voice_points_per_minute = excluded.voice_points_per_minute,
                                                     voice_points_required_sec = excluded.voice_points_required_sec,
                                                     voice_points_points = excluded.voice_points_points`,
          [guild.id, ppm, requiredSec, pts]).catch(()=>{});
        if (client.ensurePointsTicker) client.ensurePointsTicker(guild.id);
        if (client.refreshVoiceLeaderboard) client.refreshVoiceLeaderboard(guild.id);
        const doneTitle = new TextDisplayBuilder().setContent('# Points / Time Controls');
        const doneText = new TextDisplayBuilder().setContent(`<a:verif_vert:1440432091853492254> Applied successfully.\nTime: **${preset}** → Points: **${pts}** (Rate: **${(Math.round(ppm*100)/100)} pts/min**)`);
        const appliedContainer = new ContainerBuilder()
          .addTextDisplayComponents(doneTitle)
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(doneText);
          // .addSeparatorComponents(new SeparatorBuilder())
          // .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(item => item.setURL('https://ik.imagekit.io/gwqqjru7p/v!cky%20Space%20(2).png?updatedAt=1763073872360')));
        return interaction.update({ components: [appliedContainer], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 }).catch(()=>{});
      }
    }

    // Modal submits
    if (interaction.isModalSubmit()) {
      const safeModalReply = async (data) => {
        try {
          if (interaction.deferred || interaction.replied) {
            try { return await interaction.editReply(data); } catch {}
            return await interaction.followUp({ ...data });
          }
          return await interaction.reply(data);
        } catch {}
      };
      if (interaction.customId === 'ptTimeManual') {
        const key = `${guild.id}:${interaction.user.id}`;
        const raw = (interaction.fields.getTextInputValue('amountInput') || '').trim();
        if (!/^\d+[smh]$/i.test(raw)) {
          return safeModalReply({
            flags: MessageFlags.Ephemeral,
            content: '<a:unVerif:1440432078356348928> Invalid time. Use formats like 1s, 5m, 2h.'
          });
        }
        const st = setupPTState.get(key) || {};
        setupPTState.set(key, { ...st, preset: raw.toLowerCase() });
        return safeModalReply({
          flags: MessageFlags.Ephemeral,
          content: `<a:verif_vert:1440432091853492254> Time preset set to ${raw.toLowerCase()}.`
        });
      }
      if (interaction.customId === 'ptPointsManual') {
        const key = `${guild.id}:${interaction.user.id}`;
        const raw = (interaction.fields.getTextInputValue('pointsInput') || '').trim();
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
          return safeModalReply({
            flags: MessageFlags.Ephemeral,
            content: '<a:unVerif:1440432078356348928> Invalid points. Enter a positive number.'
          });
        }
        const st = setupPTState.get(key) || {};
        setupPTState.set(key, { ...st, points: Math.floor(n) });
        return safeModalReply({
          flags: MessageFlags.Ephemeral,
          content: `<a:verif_vert:1440432091853492254> Points preset set to ${Math.floor(n)}.`
        });
      }
      if (interaction.customId === 'setupLogsModal') {
        const id = interaction.fields.getTextInputValue('channelIdInput').trim();
        const ch = guild.channels.cache.get(id);
        if (!ch || ch.type !== ChannelType.GuildText) return safeModalReply({ content: '<a:unVerif:1440432078356348928> Invalid text channel ID.', flags: MessageFlags.Ephemeral });
        await dbRun('INSERT INTO guild_config(guild_id, log_channel_id) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET log_channel_id = excluded.log_channel_id', [guild.id, ch.id]).catch(()=>{});
        return safeModalReply({ content: `<a:verif_vert:1440432091853492254> Logs channel set to <#${ch.id}>`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'setupLobbyModal') {
        const id = interaction.fields.getTextInputValue('channelIdInput').trim();
        const ch = guild.channels.cache.get(id);
        if (!ch || ch.type !== ChannelType.GuildVoice) return safeModalReply({ content: '<a:unVerif:1440432078356348928> Invalid voice channel ID.', flags: MessageFlags.Ephemeral });
        await dbRun('INSERT INTO guild_config(guild_id, lobby_channel_id) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET lobby_channel_id = excluded.lobby_channel_id', [guild.id, ch.id]).catch(()=>{});
        return safeModalReply({ content: `<a:verif_vert:1440432091853492254> Lobby voice channel set to <#${ch.id}>`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'setupLeaderboardModal') {
        // Defer early to avoid 3s modal timeout while we fetch channel and start leaderboard
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(()=>{});
        const id = interaction.fields.getTextInputValue('channelIdInput').trim();
        const ch = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(()=>null);
        // Validate text-based channel (no threads/voice)
        const isTextBased = !!ch && (ch.type === ChannelType.GuildText || ch.isTextBased?.());
        if (!isTextBased) return safeModalReply({ content: '<a:unVerif:1440432078356348928> Invalid channel. Please provide a text channel ID (not thread/voice).', flags: MessageFlags.Ephemeral });
        // Check bot permissions
        const me = guild.members.me;
        const perms = ch.permissionsFor(me);
        if (!perms?.has(PermissionsBitField.Flags.ViewChannel) || !perms?.has(PermissionsBitField.Flags.SendMessages)) {
          return safeModalReply({ content: '<a:unVerif:1440432078356348928> I do not have permission to View/Send in that channel. Please fix permissions and try again.', flags: MessageFlags.Ephemeral });
        }
        try {
          await dbRun('INSERT INTO guild_config(guild_id, leaderboard_channel_id) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET leaderboard_channel_id = excluded.leaderboard_channel_id', [guild.id, ch.id]);
          await startOrUpdateVoiceLeaderboard(guild, ch.id);
          return safeModalReply({ content: `<a:verif_vert:1440432091853492254> Leaderboard channel set to <#${ch.id}>`, flags: MessageFlags.Ephemeral });
        } catch (e) {
          console.error('setupLeaderboardModal start error:', e);
          return safeModalReply({ content: '<a:unVerif:1440432078356348928> Failed to start leaderboard in that channel. Please ensure the channel is valid and I can send messages.', flags: MessageFlags.Ephemeral });
        }
      }
      if (interaction.customId === 'setupCategoryModal') {
        const id = interaction.fields.getTextInputValue('channelIdInput').trim();
        const ch = guild.channels.cache.get(id);
        if (!ch || ch.type !== ChannelType.GuildCategory) return safeModalReply({ content: '<a:unVerif:1440432078356348928> Invalid category ID.', flags: MessageFlags.Ephemeral });
        await dbRun('INSERT INTO guild_config(guild_id, temp_category_id) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET temp_category_id = excluded.temp_category_id', [guild.id, ch.id]).catch(()=>{});
        return safeModalReply({ content: `<a:verif_vert:1440432091853492254> Temp voice category set to ${ch.id}`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'setupRejectModal') {
        const id = interaction.fields.getTextInputValue('channelIdInput').trim();
        const ch = guild.channels.cache.get(id);
        if (!ch || ch.type !== ChannelType.GuildVoice) return safeModalReply({ content: '<a:unVerif:1440432078356348928> Invalid voice channel ID.', flags: MessageFlags.Ephemeral });
        await dbRun('INSERT INTO guild_config(guild_id, reject_channel_id) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET reject_channel_id = excluded.reject_channel_id', [guild.id, ch.id]).catch(()=>{});
        return safeModalReply({ content: `<a:verif_vert:1440432091853492254> Reject voice channel set to <#${ch.id}>`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'ptTimeManual') {
        const key = `${guild.id}:${interaction.user.id}`;
        const st = setupPTState.get(key) || { preset: '1m' };
        const userId = interaction.user.id;
        const raw = interaction.fields.getTextInputValue('amountInput').trim().toLowerCase();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(()=>{});
        let seconds = 0;
        // Accept formats: 1h, 30m, 45s, with optional space like '1 h'
        const m = raw.match(/^\s*(\d+)\s*([smh])?\s*$/i);
        if (m) {
          const num = Math.max(0, parseInt(m[1], 10) || 0);
          const unit = (m[2] || '').toLowerCase();
          if (num <= 0) return interaction.editReply('<a:unVerif:1440432078356348928> Amount must be > 0.');
          if (unit === 's') seconds = num;
          else if (unit === 'h') seconds = num * 3600;
          else if (unit === 'm' || unit === '') seconds = num * 60;
        } else {
          // Fallback: pure number using current unit selection
          const amount = Math.max(0, Math.floor(Number(raw)) || 0);
          if (amount <= 0) return interaction.editReply('<a:unVerif:1440432078356348928> Provide a positive amount.');
          // Use preset's unit when user types pure number (default minutes)
          const preset = (st.preset || '1m');
          const unit = preset.endsWith('h') ? 'h' : preset.endsWith('s') ? 's' : 'm';
          seconds = unit === 'h' ? amount * 3600 : unit === 's' ? amount : amount * 60;
        }
        const minutes = Math.floor(seconds / 60);
        const addPts = minutes * 10;
        if (addPts > 0) await dbRun('INSERT INTO voice_points_users (guild_id, user_id, points) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET points = points + excluded.points', [guild.id, userId, addPts]).catch(()=>{});
        if (client.refreshVoiceLeaderboard) await client.refreshVoiceLeaderboard(guild.id);
        return interaction.editReply(`<a:verif_vert:1440432091853492254> Added ${addPts} points (from ${raw}) to <@${userId}>.`);
      }
      if (interaction.customId === 'ptPointsManual') {
        const userId = interaction.user.id;
        const raw = interaction.fields.getTextInputValue('pointsInput').trim();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(()=>{});
        const pts = Math.max(0, Math.floor(Number(raw)) || 0);
        if (pts <= 0) return interaction.editReply('<a:unVerif:1440432078356348928> Provide a positive points amount.');
        await dbRun('INSERT INTO voice_points_users (guild_id, user_id, points) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET points = points + excluded.points', [guild.id, userId, pts]).catch(()=>{});
        if (client.refreshVoiceLeaderboard) await client.refreshVoiceLeaderboard(guild.id);
        return interaction.editReply(`<a:verif_vert:1440432091853492254> Added ${pts} points to <@${userId}>.`);
      }
    }
  } catch (e) {
    console.error('setup interaction error:', e);
  }
});

// Remove users from leaderboard when they leave the server
client.on('guildMemberRemove', async (member) => {
  try {
    const gid = member.guild.id;
    const uid = member.id;
    await dbRun('DELETE FROM voice_points_users WHERE guild_id = ? AND user_id = ?', [gid, uid]).catch(()=>{});
    await dbRun('DELETE FROM temp_user_points WHERE guild_id = ? AND user_id = ?', [gid, uid]).catch(()=>{});
    if (client.refreshVoiceLeaderboard) await client.refreshVoiceLeaderboard(gid);
  } catch {}
});

// Load message commands from all directories
const loadCommands = (dir) => {
  const commandsPath = path.join(__dirname, 'commands', dir);
  if (fs.existsSync(commandsPath)) {
    fs.readdirSync(commandsPath).forEach(file => {
      if (!file.endsWith('.js')) return;
      try {
        const command = require(path.join(commandsPath, file));
        if (command.name && command.execute) {
          client.commands.set(command.name, command);
          if (command.aliases) {
            command.aliases.forEach(alias => {
              client.aliases.set(alias, command.name);
            });
          }
        }
      } catch (error) {
        console.error(`Error loading command from ${dir}/${file}:`, error.message);
      }
    });
  }
};

// Load commands from all directories
const commandDirs = ['voice', 'general', 'blacklist', 'fun', 'staff', 'user', 'whitlist', 'setup-logs'];
commandDirs.forEach(dir => loadCommands(dir));

// Load slash commands
const slashCommandsPath = path.join(__dirname, 'commands', 'slash');
if (fs.existsSync(slashCommandsPath)) {
    fs.readdirSync(slashCommandsPath).forEach(file => {
        if (!file.endsWith('.js')) return;
        const command = require(path.join(slashCommandsPath, file));
        if (command.data) {
            client.slashCommands.set(command.data.name, command);
        }
    });
}

// Load Task commands
const taskCommandsPath = path.join(__dirname, 'commands', 'Task');
if (fs.existsSync(taskCommandsPath)) {
    fs.readdirSync(taskCommandsPath).forEach(file => {
        if (!file.endsWith('.js')) return;
        const command = require(path.join(taskCommandsPath, file));
        if (command.data) {
            client.slashCommands.set(command.data.name, command);
        }
    });
}

// Setup SQLite DB
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, err => {
  if (err) console.error('Failed to connect to DB', err);
  else console.log('Connected to SQLite DB');
});

// Promisify some db functions for easier usage
// Improve write performance with safe WAL
try {
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA synchronous=NORMAL');
} catch {}
// Best-effort schema ensures (check columns before altering to avoid duplicate column errors)
function ensureGuildConfigColumns() {
  try {
    db.all(`PRAGMA table_info(guild_config)`, (err, rows) => {
      if (err || !rows) return;
      const have = new Set(rows.map(r => String(r.name)));
      const alters = [];
      if (!have.has('voice_points_per_minute')) alters.push(`ALTER TABLE guild_config ADD COLUMN voice_points_per_minute REAL`);
      if (!have.has('voice_points_required_sec')) alters.push(`ALTER TABLE guild_config ADD COLUMN voice_points_required_sec INTEGER`);
      if (!have.has('voice_points_points')) alters.push(`ALTER TABLE guild_config ADD COLUMN voice_points_points INTEGER`);
      if (alters.length === 0) return;
      // Run sequentially to avoid lock/contention
      const next = () => {
        const sql = alters.shift();
        if (!sql) return;
        db.run(sql, [], () => next());
      };
      next();
    });
  } catch {}
}
ensureGuildConfigColumns();
function dbGet(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbRun(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// Check if user has bot control access for a guild (developer or explicit guild owner via /owneradd)
client.hasControlAccess = async (guildId, userId) => {
  try {
    if (client.isDeveloper?.(userId)) return true;
    // Explicit per-guild owners set via /owneradd
    const row = await dbGet('SELECT 1 AS x FROM guild_owners WHERE guild_id = ? AND user_id = ?', [guildId, userId]).catch(() => null);
    if (row) return true;
  } catch {}
  return false;
};

// Helpers for new manager systems
client.isGuildOwnerUser = async (guildId, userId) => {
  try {
    const row = await dbGet('SELECT 1 AS x FROM guild_owners WHERE guild_id = ? AND user_id = ?', [guildId, userId]).catch(() => null);
    return !!row;
  } catch { return false; }
};

client.isGlobalManager = async (guildId, userId) => {
  try {
    const row = await dbGet('SELECT 1 AS x FROM global_managers WHERE guild_id = ? AND user_id = ?', [guildId, userId]).catch(() => null);
    return !!row;
  } catch { return false; }
};

client.isRejectAllManager = async (guildId, userId) => {
  try {
    const row = await dbGet('SELECT 1 AS x FROM rejectall_managers WHERE guild_id = ? AND user_id = ?', [guildId, userId]).catch(() => null);
    return !!row;
  } catch { return false; }
};

// --- Live Voice Leaderboard utils ---
function fmtDuration(ms) {
  if (!ms || ms < 0) ms = 0;
  // Round down to whole minutes for stable display
  ms = Math.floor(ms / 60000) * 60000;
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = 0; // always 00 seconds when minute-rounded
  const pad = n => String(n).padStart(2, '0');
  return `${d}:${pad(h)}:${pad(m)}:${pad(s)}`;
}

function fmtPoints(n) {
  n = Number(n || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}

async function buildVoiceLeaderboardContainer(guild) {
  const now = Date.now();
  const cfg = await dbGet('SELECT temp_category_id, voice_points_per_minute, voice_points_required_sec, voice_points_points FROM guild_config WHERE guild_id = ?', [guild.id]).catch(() => null);
  const ratePPM = Number(cfg?.voice_points_per_minute ?? 10) || 10;
  const selSec = Number(cfg?.voice_points_required_sec || 60);
  const selPts = Number(cfg?.voice_points_points || 10);
  const parseSqlTs = (val, fallbackMs) => {
    if (!val && typeof fallbackMs === 'number') return fallbackMs;
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      // Try native parse
      let t = Date.parse(val);
      if (!isNaN(t)) return t;
      // Try replacing space with T and assume Z
      t = Date.parse(val.replace(' ', 'T') + 'Z');
      if (!isNaN(t)) return t;
    }
    return typeof fallbackMs === 'number' ? fallbackMs : now;
  };
  // Lifetime voice points per user
  const pointsRows = await new Promise((resolve) => {
    db.all(`SELECT user_id, points FROM voice_points_users WHERE guild_id = ?`, [guild.id], (err, r) => resolve(r || []));
  });
  const userPoints = new Map(pointsRows.map(r => [r.user_id, Number(r.points || 0)]));
  // Live accruals per user (only for temp channels)
  const liveRows = await new Promise((resolve) => {
    db.all(`SELECT channel_id, user_id, since_ms FROM temp_user_points WHERE guild_id = ?`, [guild.id], (err, r) => resolve(r || []));
  });
  const totals = new Map(); // userId -> points
  for (const [uid, pts] of userPoints.entries()) totals.set(uid, pts);
  for (const row of liveRows) {
    const ch = guild.channels.cache.get(row.channel_id);
    if (!ch || ch.type !== ChannelType.GuildVoice) continue;
    if (cfg?.temp_category_id && ch.parentId && ch.parentId !== cfg.temp_category_id) continue;
    const mem = guild.members.cache.get(row.user_id) || await guild.members.fetch(row.user_id).catch(()=>null);
    // Eligible only if still in this channel and not muted/deafened
    const eligible = !!mem && mem.voice?.channelId === row.channel_id && !mem.voice?.selfDeaf && !mem.voice?.selfMute && !mem.voice?.serverMute && !mem.voice?.serverDeaf;
    if (!eligible) continue;
    const delta = Math.max(0, now - Number(row.since_ms || 0));
    const fullMin = Math.floor(delta / 60000);
    if (fullMin > 0) totals.set(row.user_id, (totals.get(row.user_id) || 0) + fullMin * ratePPM);
  }
  // Build array with user display
  const agg = [];
  for (const [userId, points] of totals.entries()) {
    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(()=>null);
    agg.push({ userId, name: member?.displayName || `User ${userId}`, points });
  }
  agg.sort((a,b) => (b.points - a.points));
  const top = agg.slice(0, 10);
  const header = new TextDisplayBuilder().setContent('# <:trophy12:1440835690555510784> Top 10 Activity Points');
  const rateTxt = (Number.isInteger(ratePPM) ? String(ratePPM) : ratePPM.toFixed(2));
  const durTxt = selSec % 3600 === 0 ? `${selSec/3600}h` : selSec % 60 === 0 ? `${selSec/60}m` : `${selSec}s`;
  const sub = new TextDisplayBuilder().setContent(`*<a:arrowr:1440836463733244014> Top users by voice points in temp channels (${durTxt} → ${selPts} pts)*`);
  const container = new ContainerBuilder()
    .setAccentColor(0xffdeff)
    .addTextDisplayComponents(header)
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(sub)
    .addSeparatorComponents(new SeparatorBuilder());
  if (top.length) {
    for (let i = 0; i < top.length; i++) {
      const it = top[i];
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`> ### ***${i+1}***. <@${it.userId}>**<a:arrowr:1440836463733244014>Pts: ** ***${fmtPoints(it.points)}***`));
      if (i !== top.length - 1) container.addSeparatorComponents(new SeparatorBuilder());
    }
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('No voice activity yet.'));
  }
  return container;
}

async function startOrUpdateVoiceLeaderboard(guild, channelId) {
  try {
    const ch = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!ch) return;

    // Try memory first
    let ref = voiceLbRefs.get(guild.id);
    let messageId = ref?.messageId;
    // If no memory, try DB
    if (!messageId) {
      const row = await dbGet('SELECT leaderboard_message_id FROM guild_config WHERE guild_id = ?', [guild.id]).catch(() => null);
      if (row?.leaderboard_message_id) messageId = row.leaderboard_message_id;
    }

    let msg = null;
    if (messageId) {
      const refCh = await guild.channels.fetch(ch.id).catch(() => null);
      msg = refCh ? await refCh.messages.fetch(messageId).catch(() => null) : null;
    }

    // Create once if missing
    if (!msg) {
      const container = await buildVoiceLeaderboardContainer(guild);
      msg = await ch.send({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => null);
      if (!msg) return;
      messageId = msg.id;
      voiceLbRefs.set(guild.id, { channelId: ch.id, messageId });
      await dbRun('INSERT INTO guild_config(guild_id, leaderboard_channel_id, leaderboard_message_id) VALUES(?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET leaderboard_channel_id = excluded.leaderboard_channel_id, leaderboard_message_id = excluded.leaderboard_message_id', [guild.id, ch.id, messageId]).catch(() => {});
    } else {
      // Ensure memory is synced
      voiceLbRefs.set(guild.id, { channelId: ch.id, messageId });
    }
  } catch {}
}

// Debounced on-demand refresh callable from other modules
async function refreshVoiceLeaderboardForGuild(guildId) {
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    // Debounce per guild (500ms)
    const pending = voiceLbDebounce.get(guild.id);
    if (pending) { clearTimeout(pending); }
    const timeout = setTimeout(async () => {
      try {
        const ref = voiceLbRefs.get(guild.id) || null;
        let chId = ref?.channelId;
        let msgId = ref?.messageId;
        if (!chId || !msgId) {
          const row = await dbGet('SELECT leaderboard_channel_id, leaderboard_message_id FROM guild_config WHERE guild_id = ?', [guild.id]).catch(()=>null);
          chId = row?.leaderboard_channel_id;
          msgId = row?.leaderboard_message_id;
          if (chId && msgId) voiceLbRefs.set(guild.id, { channelId: chId, messageId: msgId });
        }
        if (!chId || !msgId) return;
        const ch = guild.channels.cache.get(chId) || await guild.channels.fetch(chId).catch(()=>null);
        if (!ch) return;
        const msg = await ch.messages.fetch(msgId).catch(()=>null);
        if (!msg) return;
        const container = await buildVoiceLeaderboardContainer(guild);
        await msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
      } catch {}
    }, 500);
    voiceLbDebounce.set(guild.id, timeout);
  } catch {}
}

// Expose on client for other modules to trigger a refresh
client.refreshVoiceLeaderboard = refreshVoiceLeaderboardForGuild;

// Ensure a lightweight ticker runs while any owner is accruing points in this guild
async function ensurePointsTicker(guildId) {
  if (voicePointsTickers.has(guildId)) return;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const timer = setInterval(async () => {
    try {
      // Find channels with active points accrual
      const rows = await new Promise((resolve) => {
        db.all(`SELECT channel_id, owner_id, owner_points_since_ms FROM temp_channels WHERE guild_id = ? AND owner_points_since_ms IS NOT NULL`, [guildId], (err, r) => resolve(r || []));
      });
      // Presence of any activity that requires ticking
      let needTick = (rows && rows.length > 0);
      // also check per-user accruals
      const urows = await new Promise((resolve) => {
        db.all(`SELECT user_id, channel_id, since_ms FROM temp_user_points WHERE guild_id = ?`, [guildId], (err, r) => resolve(r || []));
      });
      if (urows && urows.length > 0) needTick = true;
      // also check scheduled overrides
      const orows = await new Promise((resolve) => {
        db.all(`SELECT user_id, required_sec, progress_ms, last_ts_ms, points FROM voice_points_overrides WHERE guild_id = ?`, [guildId], (err, r) => resolve(r || []));
      });
      if (orows && orows.length > 0) needTick = true;
      if (!needTick) {
        clearInterval(timer);
        voicePointsTickers.delete(guildId);
        return;
      }
      const now = Date.now();
      let anySettled = false;
      for (const r of rows) {
        const start = Number(r.owner_points_since_ms) || 0;
        const delta = Math.max(0, now - start);
        const fullMin = Math.floor(delta / 60000);
        if (fullMin > 0) {
          const addPts = fullMin * 10;
          await dbRun('INSERT INTO voice_points (guild_id, owner_id, points) VALUES (?, ?, ?) ON CONFLICT(guild_id, owner_id) DO UPDATE SET points = points + excluded.points', [guildId, r.owner_id, addPts]).catch(()=>{});
          // Advance the marker to avoid double counting; keep remainder seconds
          const advance = start + fullMin * 60000;
          await dbRun('UPDATE temp_channels SET owner_points_since_ms = ? WHERE channel_id = ?', [advance, r.channel_id]).catch(()=>{});
          anySettled = true;
        }
      }
      // Settle per-user accruals
      const urows2 = await new Promise((resolve) => {
        db.all(`SELECT user_id, channel_id, since_ms FROM temp_user_points WHERE guild_id = ?`, [guildId], (err, r) => resolve(r || []));
      });
      for (const ur of urows2) {
        const start = Number(ur.since_ms) || 0;
        const delta = Math.max(0, now - start);
        const fullMin = Math.floor(delta / 60000);
        if (fullMin > 0) {
          const addPts = fullMin * 10;
          await dbRun('INSERT INTO voice_points_users (guild_id, user_id, points) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET points = points + excluded.points', [guildId, ur.user_id, addPts]).catch(()=>{});
          const advance = start + fullMin * 60000;
          await dbRun('UPDATE temp_user_points SET since_ms = ? WHERE guild_id = ? AND user_id = ?', [advance, guildId, ur.user_id]).catch(()=>{});
          anySettled = true;
        }
      }
      // Process scheduled overrides: accrue only while user is eligible in temp channels
      if (orows && orows.length > 0) {
        for (const ov of orows) {
          const member = guild.members.cache.get(ov.user_id) || await guild.members.fetch(ov.user_id).catch(()=>null);
          const vs = member?.voice;
          let eligible = false;
          if (vs?.channelId) {
            const ch = guild.channels.cache.get(vs.channelId);
            const cfg = await dbGet('SELECT temp_category_id FROM guild_config WHERE guild_id = ?', [guildId]).catch(()=>null);
            const inTemp = ch && ch.type === ChannelType.GuildVoice && (!cfg?.temp_category_id || ch.parentId === cfg.temp_category_id);
            eligible = inTemp && !vs.selfDeaf && !vs.selfMute && !vs.serverMute && !vs.serverDeaf;
          }
          const last = Number(ov.last_ts_ms) || now;
          const requiredMs = Math.max(1, Number(ov.required_sec) || 0) * 1000;
          const prevProg = Math.max(0, Number(ov.progress_ms) || 0);
          const delta = eligible ? Math.max(0, now - last) : 0;
          let accum = prevProg + delta;
          const cycles = Math.floor(accum / requiredMs);
          const givePts = cycles > 0 ? (Math.max(0, Number(ov.points) || 0) * cycles) : 0;
          const newProg = accum % requiredMs; // keep remainder for next cycle
          if (givePts > 0) {
            await dbRun('INSERT INTO voice_points_users (guild_id, user_id, points) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET points = points + excluded.points', [guildId, ov.user_id, givePts]).catch(()=>{});
            anySettled = true;
          }
          // Always advance last to now to avoid banking time while ineligible
          await dbRun('UPDATE voice_points_overrides SET progress_ms = ?, last_ts_ms = ?, carry_mp = 0 WHERE guild_id = ? AND user_id = ?', [newProg, now, guildId, ov.user_id]).catch(()=>{});
        }
      }
      if (anySettled) {
        await refreshVoiceLeaderboardForGuild(guildId);
      }
      // Sync active eligible members into temp_user_points (bootstrap)
      const cfg = await dbGet('SELECT temp_category_id FROM guild_config WHERE guild_id = ?', [guildId]).catch(()=>null);
      const chans = await new Promise((resolve)=>{
        db.all(`SELECT channel_id FROM temp_channels WHERE guild_id = ?`, [guildId], (e, r)=>resolve(r||[]));
      });
      const seenUsers = new Set();
      for (const c of chans) {
        const vc = guild.channels.cache.get(c.channel_id) || await guild.channels.fetch(c.channel_id).catch(()=>null);
        if (!vc || vc.type !== ChannelType.GuildVoice) continue;
        if (cfg?.temp_category_id && vc.parentId && vc.parentId !== cfg.temp_category_id) continue;
        for (const [uid, member] of vc.members) {
          if (member.user.bot) continue;
          const eligible = member.voice && member.voice.channelId === vc.id && !member.voice.selfDeaf && !member.voice.selfMute && !member.voice.serverMute && !member.voice.serverDeaf;
          if (!eligible) continue;
          seenUsers.add(uid);
          await dbRun('INSERT INTO temp_user_points (guild_id, user_id, channel_id, since_ms) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO NOTHING', [guildId, uid, vc.id, Date.now()]).catch(()=>{});
        }
      }
      // Clean up temp_user_points rows for users no longer eligible/present
      const existing = await new Promise((resolve)=>{
        db.all(`SELECT user_id FROM temp_user_points WHERE guild_id = ?`, [guildId], (e, r)=>resolve(r||[]));
      });
      for (const r of existing) {
        if (!seenUsers.has(r.user_id)) {
          // settle and remove to avoid leaks
          const row = await new Promise((resolve)=>{
            db.get(`SELECT since_ms FROM temp_user_points WHERE guild_id = ? AND user_id = ?`, [guildId, r.user_id], (e2, rr)=>resolve(rr||null));
          });
          if (row?.since_ms) {
            const start = Number(row.since_ms) || 0;
            const delta = Math.max(0, Date.now() - start);
            const fullMin = Math.floor(delta / 60000);
            if (fullMin > 0) {
              await dbRun('INSERT INTO voice_points_users (guild_id, user_id, points) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET points = points + excluded.points', [guildId, r.user_id, fullMin * 10]).catch(()=>{});
            }
          }
          await dbRun('DELETE FROM temp_user_points WHERE guild_id = ? AND user_id = ?', [guildId, r.user_id]).catch(()=>{});
        }
      }
    } catch {}
  }, 5000);
  voicePointsTickers.set(guildId, timer);
}

// Expose on client
client.ensurePointsTicker = ensurePointsTicker;

// Create tables if not exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS temp_channels (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT,
      owner_id TEXT,
      base_name TEXT,
      locked INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY,
      lobby_channel_id TEXT,
      setup_room_id TEXT,
      banner_url TEXT,
      leaderboard_channel_id TEXT,
      bot_enabled INTEGER DEFAULT 1
    )
  `);

  // Check and add columns to guild_config after ensuring the table exists
  db.all("PRAGMA table_info(guild_config)", (err, columns) => {
    if (err) {
      console.error("Error checking guild_config schema:", err);
      return;
    }

    const columnNames = columns.map(c => c.name);
    if (!columnNames.includes('panel_webhook_id')) {
      db.run("ALTER TABLE guild_config ADD COLUMN panel_webhook_id TEXT", (alterErr) => {
        if (alterErr) console.error("Error adding panel_webhook_id column:", alterErr);
        else console.log("Added panel_webhook_id column to guild_config.");
      });
    }
    if (!columnNames.includes('panel_webhook_token')) {
      db.run("ALTER TABLE guild_config ADD COLUMN panel_webhook_token TEXT", (alterErr) => {
        if (alterErr) console.error("Error adding panel_webhook_token column:", alterErr);
        else console.log("Added panel_webhook_token column to guild_config.");
      });
    }
    if (!columnNames.includes('log_channel_id')) {
      db.run("ALTER TABLE guild_config ADD COLUMN log_channel_id TEXT", (alterErr) => {
        if (alterErr) console.error("Error adding log_channel_id column:", alterErr);
        else console.log("Added log_channel_id column to guild_config.");
      });
    }
    if (!columnNames.includes('prefix')) {
      db.run("ALTER TABLE guild_config ADD COLUMN prefix TEXT", (alterErr) => {
        if (alterErr) console.error("Error adding prefix column:", alterErr);
        else console.log("Added prefix column to guild_config.");
      });
    }
    if (!columnNames.includes('temp_category_id')) {
      db.run("ALTER TABLE guild_config ADD COLUMN temp_category_id TEXT", (alterErr) => {
        if (alterErr) console.error("Error adding temp_category_id column:", alterErr);
        else console.log("Added temp_category_id column to guild_config.");
      });
    }
    if (!columnNames.includes('reject_channel_id')) {
      db.run("ALTER TABLE guild_config ADD COLUMN reject_channel_id TEXT", (alterErr) => {
        if (alterErr) console.error("Error adding reject_channel_id column:", alterErr);
        else console.log("Added reject_channel_id column to guild_config.");
      });
    }
    if (!columnNames.includes('control_panel_style')) {
      db.run("ALTER TABLE guild_config ADD COLUMN control_panel_style TEXT", (alterErr) => {
        if (alterErr) console.error("Error adding control_panel_style column:", alterErr);
        else console.log("Added control_panel_style column to guild_config.");
      });
    }
    if (!columnNames.includes('leaderboard_channel_id')) {
      db.run("ALTER TABLE guild_config ADD COLUMN leaderboard_channel_id TEXT", (alterErr) => {
        if (alterErr) console.error("Error adding leaderboard_channel_id column:", alterErr);
        else console.log("Added leaderboard_channel_id column to guild_config.");
      });
    }
    if (!columnNames.includes('leaderboard_message_id')) {
      db.run("ALTER TABLE guild_config ADD COLUMN leaderboard_message_id TEXT", (alterErr) => {
        if (alterErr) console.error("Error adding leaderboard_message_id column:", alterErr);
        else console.log("Added leaderboard_message_id column to guild_config.");
      });
    }
    if (!columnNames.includes('leaderboard_enabled')) {
      db.run("ALTER TABLE guild_config ADD COLUMN leaderboard_enabled INTEGER DEFAULT 1", (alterErr) => {
        if (alterErr) console.error("Error adding leaderboard_enabled column:", alterErr);
        else console.log("Added leaderboard_enabled column to guild_config.");
      });
    }
  });

  // Ensure temp_channels has optional columns used later
  db.all("PRAGMA table_info(temp_channels)", (err, columns) => {
    if (err) {
      console.error("Error checking temp_channels schema:", err);
      return;
    }
    const columnNames = columns.map(c => c.name);
    if (!columnNames.includes('created_at')) {
      db.run("ALTER TABLE temp_channels ADD COLUMN created_at TEXT", (alterErr) => {
        if (alterErr) {
          console.error("Error adding created_at column to temp_channels:", alterErr);
        } else {
          console.log("Added created_at column to temp_channels.");
          // Backfill existing rows to current timestamp
          db.run("UPDATE temp_channels SET created_at = datetime('now') WHERE created_at IS NULL OR created_at = ''", (bfErr) => {
            if (bfErr) console.error('Backfill created_at failed:', bfErr);
          });
        }
      });
    }
    if (!columnNames.includes('owner_present_since')) {
      db.run("ALTER TABLE temp_channels ADD COLUMN owner_present_since TEXT", (alterErr) => {
        if (alterErr) console.error("Error adding owner_present_since column:", alterErr);
        else console.log("Added owner_present_since column to temp_channels.");
      });
    }
    if (!columnNames.includes('owner_present_since_ms')) {
      db.run("ALTER TABLE temp_channels ADD COLUMN owner_present_since_ms INTEGER", (alterErr) => {
        if (alterErr) console.error("Error adding owner_present_since_ms column:", alterErr);
        else console.log("Added owner_present_since_ms column to temp_channels.");
      });
    }
    if (!columnNames.includes('owner_points_since_ms')) {
      db.run("ALTER TABLE temp_channels ADD COLUMN owner_points_since_ms INTEGER", (alterErr) => {
        if (alterErr) console.error("Error adding owner_points_since_ms column:", alterErr);
        else console.log("Added owner_points_since_ms column to temp_channels.");
      });
    }
    if (!columnNames.includes('status_name')) {
      db.run("ALTER TABLE temp_channels ADD COLUMN status_name TEXT", (alterErr) => {
        if (alterErr) console.error("Error adding status_name column:", alterErr);
        else console.log("Added status_name column to temp_channels.");
      });
    }
    if (!columnNames.includes('user_limit')) {
      db.run("ALTER TABLE temp_channels ADD COLUMN user_limit INTEGER", (alterErr) => {
        if (alterErr) console.error("Error adding user_limit column:", alterErr);
        else console.log("Added user_limit column to temp_channels.");
      });
    }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS user_managers (
      owner_id TEXT,
      manager_id TEXT,
      PRIMARY KEY(owner_id, manager_id)
    )
  `);

  // Centralize whitelist/blacklist tables in the main DB for multi-guild support
  db.run(`
    CREATE TABLE IF NOT EXISTS user_whitelists (
      owner_id TEXT,
      user_id TEXT,
      PRIMARY KEY (owner_id, user_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_blacklists (
      owner_id TEXT,
      user_id TEXT,
      PRIMARY KEY (owner_id, user_id)
    )
  `);
  // Per-guild bot owners/controllers
  db.run(`
    CREATE TABLE IF NOT EXISTS guild_owners (
      guild_id TEXT,
      user_id TEXT,
      PRIMARY KEY (guild_id, user_id)
    )
  `);
  // Global managers: protected users who can control voice commands anywhere in guild
  db.run(`
    CREATE TABLE IF NOT EXISTS global_managers (
      guild_id TEXT,
      user_id TEXT,
      PRIMARY KEY (guild_id, user_id)
    )
  `);
  // Guild-scoped managers allowed to use rejectall in their current voice channel
  db.run(`
    CREATE TABLE IF NOT EXISTS rejectall_managers (
      guild_id TEXT,
      user_id TEXT,
      PRIMARY KEY (guild_id, user_id)
    )
  `);
  
  // Task configuration per guild
  db.run(`
    CREATE TABLE IF NOT EXISTS task_config (
      guild_id TEXT PRIMARY KEY,
      task_enabled INTEGER DEFAULT 0,
      logs_channel_id TEXT,
      command_channel_id TEXT,
      required_duration_sec INTEGER DEFAULT 900,
      required_member_count INTEGER DEFAULT 3,
      points_per_task INTEGER DEFAULT 5,
      task_roles TEXT,
      ignore_roles TEXT,
      same_role_counts INTEGER DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS task_points (
      guild_id TEXT,
      user_id TEXT,
      points INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    )
  `);
  // Lifetime voice stats per owner
  db.run(`
    CREATE TABLE IF NOT EXISTS voice_stats (
      guild_id TEXT,
      owner_id TEXT,
      created_count INTEGER DEFAULT 0,
      total_time_ms INTEGER DEFAULT 0,
      total_members_accum INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, owner_id)
    )
  `);
  // Voice points per owner (lifetime)
  db.run(`
    CREATE TABLE IF NOT EXISTS voice_points (
      guild_id TEXT,
      owner_id TEXT,
      points INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, owner_id)
    )
  `);
  // Per-user voice points (top users in temp channels)
  db.run(`
    CREATE TABLE IF NOT EXISTS voice_points_users (
      guild_id TEXT,
      user_id TEXT,
      points INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    )
  `);
  // Active per-user accrual markers
  db.run(`
    CREATE TABLE IF NOT EXISTS temp_user_points (
      guild_id TEXT,
      user_id TEXT,
      channel_id TEXT,
      since_ms INTEGER,
      PRIMARY KEY (guild_id, user_id)
    )
  `);
  // Scheduled manual time+points awards per user
  db.run(`
    CREATE TABLE IF NOT EXISTS voice_points_overrides (
      guild_id TEXT,
      user_id TEXT,
      required_sec INTEGER,
      progress_ms INTEGER DEFAULT 0,
      last_ts_ms INTEGER,
      points INTEGER,
      carry_mp INTEGER DEFAULT 0,
      awarded_points INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    )
  `);
  // Ensure new columns exist when upgrading from previous versions
  db.all("PRAGMA table_info(voice_points_overrides)", (err, cols) => {
    if (err) return;
    const names = (cols||[]).map(c=>c.name);
    if (!names.includes('carry_mp')) {
      db.run("ALTER TABLE voice_points_overrides ADD COLUMN carry_mp INTEGER DEFAULT 0", ()=>{});
    }
    if (!names.includes('awarded_points')) {
      db.run("ALTER TABLE voice_points_overrides ADD COLUMN awarded_points INTEGER DEFAULT 0", ()=>{});
    }
  });
  // Track unique member visits per owner (lifetime)
  db.run(`
    CREATE TABLE IF NOT EXISTS voice_member_visits (
      guild_id TEXT,
      owner_id TEXT,
      user_id TEXT,
      PRIMARY KEY (guild_id, owner_id, user_id)
    )
  `);
});

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log('Bot is online and ready!');
  client.db = db;
  // Initialize config service
  client.config = new GuildConfigService(db);

  // Initialize voice logger
  voiceLogger = new VoiceLogger(client, db);
  client.voiceLogger = voiceLogger;

  // Register interaction handlers (buttons/modals)
  try { require('./event/interactionCreate')(client, { tempDb: db }); } catch (e) { console.error('Failed to register interactionCreate handler:', e); }

  // Import your temp voice system here (make sure it emits buttons)
  require('./tempVoiceSystem')(client, db);

  // Set bot status/presence with rotating activities
  // Wait for WebSocket to be fully ready before setting presence
  setTimeout(async () => {
    try {
      const serverCount = client.guilds.cache.size;
      const userCount = client.guilds.cache.reduce((acc, guild) => acc + (guild.memberCount || 0), 0);
      
      // Define two separate presence groups
      const motivationalActivities = [
        { name: `Usage : ${userCount.toLocaleString()} Members ✨`, type: 4 },
        { name: `+help to Show Commands !`, type: 4 },
        { name: `Be patient to reach the top ❤️`, type: 4 },
        { name: `اصبر لتصل الى القمة ❤️`, type: 4 }
      ];

      // Use only motivational activities
      let idxMot = 0;
      
      // Set initial presence
      if (client.user && client.ws.status === 0) {
        client.user.setPresence({
          activities: [motivationalActivities[idxMot]],
          status: 'dnd'
        });
        console.log('[Status] Bot presence set successfully');
        
        // Rotate activities every 20 seconds
        setInterval(() => {
          try {
            if (client.user && client.ws.status === 0) {
              idxMot = (idxMot + 1) % motivationalActivities.length;
              client.user.setPresence({
                activities: [motivationalActivities[idxMot]],
                status: 'dnd'
              });
            }
          } catch (e) {
            console.error('[Status] Failed to update presence:', e?.message);
          }
        }, 20000); // 20 seconds
      }
      
    } catch (e) {
      console.error('[Status] Failed to set bot presence:', e?.message || e);
    }
  }, 3000); // Wait 3 seconds for WebSocket to be ready

  // Initialize Firebase Admin and start publishing stats for web dashboards
  (async () => {
    try {
      if (!admin || admin.apps?.length) {
        // already initialized or not installed
      } else {
        const projectId = process.env.FIREBASE_PROJECT_ID;
        const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
        const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
        const databaseURL = process.env.FIREBASE_DATABASE_URL;
        if (projectId && clientEmail && privateKeyRaw && databaseURL) {
          // Support accidental wrapping with backticks and ensure \n becomes real newlines
          const cleanedRaw = String(privateKeyRaw).trim().replace(/^`+|`+$/g, '');
          const privateKey = cleanedRaw.replace(/\\n/g, '\n');
          admin.initializeApp({
            credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
            databaseURL,
          });
          console.log('[Firebase] Admin initialized');
        } else {
          const missing = [
            !projectId && 'FIREBASE_PROJECT_ID',
            !clientEmail && 'FIREBASE_CLIENT_EMAIL',
            !privateKeyRaw && 'FIREBASE_PRIVATE_KEY',
            !databaseURL && 'FIREBASE_DATABASE_URL',
          ].filter(Boolean).join(', ');
          console.warn('[Firebase] Missing env vars:', missing || 'unknown', 'Skipping publish.');
        }
      }
    } catch (e) { console.warn('[Firebase] init error:', e?.message || e); }

    async function publishStats() {
      try {
        if (!admin || !admin.apps?.length) return;
        const rtdb = admin.database();
        const botId = client.user?.id || 'bot';
        const botRef = rtdb.ref(`bots/${botId}`);

        // Bot status block
        const guilds = Array.from(client.guilds.cache.values());
        const users = guilds.reduce((acc, g) => acc + (g.memberCount || 0), 0);
        const channels = guilds.reduce((acc, g) => acc + (g.channels?.cache?.size || 0), 0);
        const botData = {
          status: 'online',
          username: client.user?.tag || client.user?.username || 'v!cky',
          guilds: guilds.length,
          users,
          channels,
          ping: client.ws.ping || 0,
          uptime: Math.floor(process.uptime()),
          timestamp: Date.now(),
        };

        // Guilds simple list (optional fields)
        const guildList = {};
        for (const g of guilds) {
          // Try to get an invite link safely (vanity > permanent invite > any invite)
          let inviteLink = null;
          try {
            const vanity = g.vanityURLCode ? `https://discord.gg/${g.vanityURLCode}` : null;
            inviteLink = vanity;
            if (!inviteLink && typeof g.invites?.fetch === 'function') {
              const invites = await g.invites.fetch().catch(()=>null);
              if (invites && invites.size > 0) {
                const perm = [...invites.values()].find(i => (i.maxAge === 0 && i.maxUses === 0));
                const pick = perm || invites.first();
                if (pick && pick.code) inviteLink = `https://discord.gg/${pick.code}`;
              }
            }
          } catch {}

          guildList[g.id] = {
            id: g.id,
            name: g.name,
            memberCount: g.memberCount || 0,
            icon: (typeof g.iconURL === 'function') ? g.iconURL() : null,
            inviteLink,
          };
        }

        // Voice aggregates (lightweight)
        let activeTempChannels = 0;
        let activeOwners = 0;
        try {
          const rows = await new Promise((resolve) => {
            db.all(`SELECT channel_id, owner_id FROM temp_channels`, [], (err, r) => resolve(r || []));
          });
          const ownerSet = new Set();
          for (const r of rows) {
            const ch = client.channels.cache.get(r.channel_id);
            if (ch && ch.members && ch.members.size > 0) activeTempChannels++;
            if (r.owner_id) ownerSet.add(r.owner_id);
          }
          activeOwners = ownerSet.size;
        } catch {}
        const leaderboardMessages = (client?.voiceLogger && typeof client.voiceLogger.getLeaderboardCount === 'function')
          ? await client.voiceLogger.getLeaderboardCount().catch(()=>0)
          : (new Map(client?.voiceLbRefs || []).size || 0);

        const voiceModel = {
          activeTempChannels,
          activeOwners,
          leaderboardMessages,
          guilds: guilds.length,
        };

        await botRef.update({ bot: botData, guilds: guildList, stats: { vipGuilds: 0 } }).catch(()=>{});
        await rtdb.ref('voiceSystem').update({
          activeTempChannels: voiceModel.activeTempChannels,
          activeOwners: voiceModel.activeOwners,
          leaderboardMessages: voiceModel.leaderboardMessages,
          guilds: voiceModel.guilds,
          timestamp: Date.now(),
        }).catch(()=>{});
      } catch (e) {
        console.warn('[Firebase] publish error:', e?.message || e);
      }
    }

    // initial and interval publish
    setTimeout(() => publishStats(), 2000);
    setInterval(() => publishStats(), 30000);
  })();

  // Bootstrap voice points accrual for owners already in their channels at startup
  (async () => {
    try {
      for (const [gid, guild] of client.guilds.cache) {
        const rows = await new Promise((resolve) => {
          db.all(`SELECT channel_id, owner_id, owner_points_since_ms FROM temp_channels WHERE guild_id = ?`, [gid], (err, r) => resolve(r || []));
        });
        const now = Date.now();
        let activated = false;
        for (const r of rows) {
          const owner = guild.members.cache.get(r.owner_id) || await guild.members.fetch(r.owner_id).catch(() => null);
          if (!owner) continue;
          const vs = owner.voice;
          const eligible = vs?.channelId === r.channel_id && !vs?.selfDeaf && !vs?.serverMute;
          if (eligible && !r.owner_points_since_ms) {
            await dbRun('UPDATE temp_channels SET owner_points_since_ms = ? WHERE channel_id = ?', [now, r.channel_id]).catch(()=>{});
            activated = true;
          }
        }
        if (activated && client.ensurePointsTicker) client.ensurePointsTicker(gid);
      }
    } catch {}
  })();
});

// Message command handler
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.guild) return;
  // Resolve per-guild prefix
  let guildPrefix = defaultPrefix;
  try {
    guildPrefix = await client.config.getPrefix(message.guild.id);
  } catch {}
  if (!message.content.startsWith(guildPrefix)) return;

  const args = message.content.slice(guildPrefix.length).trim().split(/\s+/);
  const cmdName = args.shift().toLowerCase();

    const command = client.commands.get(cmdName) || client.commands.get(client.aliases.get(cmdName));

  if (!command) return;

  // Respect per-guild bot_enabled flag: when disabled, only allow the toggle command
  try {
    if (client.config && typeof client.config.getBotEnabled === 'function') {
      const enabled = await client.config.getBotEnabled(message.guild.id);
      const isDev = client.isDeveloper?.(message.author.id);
      if (!enabled && cmdName !== 'toggle' && !isDev) {
        return; // bot disabled for this guild; ignore all commands except .v toggle (or dev override)
      }
    }
  } catch {}

  try {
    await command.execute(message, args, client, db);
  } catch (e) {
    console.error(e);
    message.channel.send('<a:unVerif:1440432078356348928> An error occurred while executing the command.');
  }
});

// Helper function to build voice channel name
function buildChannelName(baseName, statusName) {
  return statusName && statusName.length > 0 ? `${baseName} ✏️ ${statusName}` : baseName;
}

// Helper function to send the control dashboard
async function sendDashboard(channel, member) {
    const guild = member.guild;
    const dashboardEmbed = new EmbedBuilder()
        .setColor('#2f3136')
        .setAuthor({ name: `Welcome, @!${member.displayName}`, iconURL: member.user.displayAvatarURL({ dynamic: true }) })
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .setDescription(`This is your personal voice room panel — crafted for simplicity, control, and a smooth experience. and Welcome in **${guild.name}** \n\n<:1199874572657377381:1390715667195367536>Powered by GHOST`);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vc_lock').setEmoji('<:arcadialock:1381382294073380874>').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vc_unlock').setEmoji('<:arcadiaunlock:1381382454480212168>').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vc_claim').setEmoji('<:crown:1390709396484653177>').setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vc_options').setEmoji('⚙️').setStyle(ButtonStyle.Secondary).setDisabled(true)
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vc_add_user').setEmoji('<:arcadiapermit:1381382925244694548>').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vc_remove_user').setEmoji('<:arcadiadeny:1381383091544653824>').setStyle(ButtonStyle.Secondary)
    );

    const row4 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vc_rename').setEmoji('<:rename:1390709372749086872>').setStyle(ButtonStyle.Secondary)
    );

    try {
        await channel.send({ embeds: [dashboardEmbed], components: [row1, row2, row3, row4] });
    } catch (err) {
        console.error('Failed to send dashboard embed:', err);
    }
}

// Combined Interaction Handler
// ===================================================================
//                         SLASH COMMANDS
// ===================================================================
client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const command = client.slashCommands.get(interaction.commandName);
    if (!command) return;

    try {
      // Enforce task_admin_roles for most slash commands (skip leaderboard and owner control commands)
      if (!['taskleaderboard', 'owneradd', 'ownerremove'].includes(interaction.commandName)) {
        const row = await dbGet('SELECT task_admin_roles FROM task_config WHERE guild_id = ?', [interaction.guildId]).catch(() => null);
        const adminRoles = (row?.task_admin_roles || '').split(',').filter(Boolean);
        if (adminRoles.length > 0) {
          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const hasRole = member?.roles.cache.some(r => adminRoles.includes(r.id));
          if (!hasRole) {
            return interaction.reply({ content: '<a:unVerif:1440432078356348928> You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
          }
        } else {
          // Fallback: if no admin roles configured yet, allow Administrators and Guild Owner
          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const isOwner = interaction.guild.ownerId === interaction.user.id;
          const isAdmin = member?.permissions.has(PermissionsBitField.Flags.Administrator);
          if (!isOwner && !isAdmin) {
            return interaction.reply({ content: '<a:unVerif:1440432078356348928> No admin roles configured. Only server Admins/Owner can use this until roles are set via /set-tasked-role.', flags: MessageFlags.Ephemeral });
          }
        }
      }

      await command.execute(interaction, client, db);
    } catch (error) {
      console.error(error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
      }
    }
    return; // Stop further execution
  }

  try {
    const { guild, member } = interaction;
    const userId = member.id;

    // Let help.js own its collector interactions entirely to avoid 40060
    if (interaction.isButton()) {
      const cid = interaction.customId || '';
      if (
        cid.startsWith('help_cat_') ||
        cid.startsWith('help_category_') ||
        cid === 'help_voice_prev' ||
        cid === 'help_voice_next'
      ) {
        return; // handled by help.js
      }
      // Let event/interactionCreate.js exclusively handle voice panel buttons
      if (cid.startsWith('vc_')) {
        return; // handled by event/interactionCreate.js
      }
      // Setup panel buttons (handled by earlier handler)
      if (cid.startsWith('setup_')) {
        return; // handled in the dedicated setup interaction handler
      }
    }
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'help_category_select') {
        return; // handled by help.js
      }
      if (interaction.customId.startsWith('setup_')) {
        return; // handled in the dedicated setup interaction handler
      }
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('setup')) {
      return; // handled in the dedicated setup interaction handler
    }

    // // Fast-path for select menus to avoid timeouts/duplicate replies
    // if (interaction.isStringSelectMenu()) {
    //   try {
    //     if (!interaction.deferred && !interaction.replied) {
    //       await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    //     }
    //     await interaction.editReply({ content: '<a:unVerif:1440432078356348928> This select menu is not implemented yet.' });
    //   } catch (e) {
    //     // Swallow errors since interaction may already be acknowledged elsewhere
    //   }
    //   return;
    // }

    // Early ack only for buttons that open a response
    if (interaction.isButton()) {
      const bid = interaction.customId || '';
      if (bid.startsWith('cp_style_')) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      }
    }

    // ===================================================================
    //                      SETUP PANEL INTERACTIONS
    // ===================================================================
    // Central auth guard for all Task Setup and Points/Time controls
    const denyNoPermsV2 = async () => {
      const contactUrl = process.env.CONTACT_SUPPORT || 'https://discord.com/users/1536781748807934003';
      const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Contact Developer').setStyle(ButtonStyle.Link).setURL(contactUrl)
      );
      const containerReply = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('<a:unVerif:1440432078356348928> You do not have permission to use Task Setup / Points / Time controls.'))
        .addSeparatorComponents(new SeparatorBuilder())
        .addActionRowComponents(btnRow);
      try {
        if (interaction.deferred || interaction.replied) {
          return await interaction.editReply({ components: [containerReply], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
        }
        return await interaction.reply({ components: [containerReply], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
      } catch {
        try {
          return await interaction.followUp({ components: [containerReply], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
        } catch {
          return await interaction.reply({ components: [btnRow], flags: MessageFlags.Ephemeral }).catch(()=>{});
        }
      }
    };

    const needsSetupAuth = (id) => {
      if (!id) return false;
      return id === 'setup_points_time_panel'
        || id.startsWith('task_')
        || id.startsWith('pt')
        || id === 'task_setup_open'
        || id === 'task_setup_open_clean'
        || id === 'setup_task_open_v2';
    };

    if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())) {
      const cid = interaction.customId || '';
      if (needsSetupAuth(cid)) {
        const isDev = client.isDeveloper?.(interaction.user.id);
        const rowOwner = await dbGet('SELECT 1 FROM guild_owners WHERE guild_id = ? AND user_id = ?', [guild.id, interaction.user.id]).catch(()=>null);
        const allowed = !!isDev || !!rowOwner;
        if (!allowed) {
          return await denyNoPermsV2();
        }
      }
    }
    // Helpers for Task Setup
    const getTaskConfig = async (gid) => {
      const row = await dbGet('SELECT * FROM task_config WHERE guild_id = ?', [gid]).catch(() => null);
      return row || { guild_id: gid, task_enabled: 0, logs_channel_id: null, command_channel_id: null, required_duration_sec: 900, required_member_count: 3, points_per_task: 5, task_roles: '', ignore_roles: '', same_role_counts: 0 };
    };

    const upsertTaskConfig = (gid, column, value) => dbRun(`INSERT INTO task_config(guild_id, ${column}) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET ${column} = excluded.${column}`, [gid, value]);

    const buildTaskSetupContainer = async (g, over = {}) => {
      const cfg = await getTaskConfig(g.id);
      const sep = new SeparatorBuilder();
      const title = new TextDisplayBuilder().setContent('# <:axlboba:1456990939146092669> System Task Setup');
      const helpRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('task_setup_help').setLabel('How to setup').setStyle(ButtonStyle.Primary)
      );
      // Optional inline search results (stay in the same container)
      const searchChannelsNames = Array.isArray(over.searchChannels)
        ? over.searchChannels.map(c => (c && c.name ? `#${c.name}` : String(c))).slice(0, 25)
        : null;
      const searchRolesNames = Array.isArray(over.searchRoles)
        ? over.searchRoles.map(r => (r && r.name ? `${r.name}` : String(r))).slice(0, 25)
        : null;
      // Compact: omit inline search results to keep components under limits
      const channelsHeader = null;
      const channelsList = null;
      const rolesHeader = null;
      const rolesList = null;

      // Channels
      const textChansAll = g.channels.cache.filter(c => c.type === ChannelType.GuildText).toJSON();
      const textChans = (over.logsCandidates || textChansAll).slice(0,25);
      const logsOptions = (textChans.length
        ? textChans.map(ch => new StringSelectMenuOptionBuilder().setLabel(`#${ch.name}`).setValue(ch.id).setDefault(ch.id === cfg.logs_channel_id))
        : [new StringSelectMenuOptionBuilder().setLabel('No text channels found').setValue('none')]
      );
      const logsSelect = new StringSelectMenuBuilder()
        .setCustomId('task_logs_select')
        .setPlaceholder('Select logs channel')
        .addOptions(logsOptions)
        .setDisabled(textChans.length === 0);
      const cmdCandidates = (over.cmdCandidates || textChansAll).slice(0,25);
      const cmdOptions = (cmdCandidates.length
        ? cmdCandidates.map(ch => new StringSelectMenuOptionBuilder().setLabel(`#${ch.name}`).setValue(ch.id).setDefault(ch.id === cfg.command_channel_id))
        : [new StringSelectMenuOptionBuilder().setLabel('No text channels found').setValue('none')]
      );
      const cmdSelect = new StringSelectMenuBuilder()
        .setCustomId('task_command_channel_select')
        .setPlaceholder('Select command channel for .v task')
        .addOptions(cmdOptions)
        .setDisabled(cmdCandidates.length === 0);

      // Roles
      const rolesAll = g.roles.cache.filter(r => r.editable && r.id !== g.id).toJSON();
      const roles = (over.taskRoleCandidates || rolesAll).slice(0,25);
      const selectedTaskRoles = (cfg.task_roles || '').split(',').filter(Boolean);
      const selectedIgnoreRoles = (cfg.ignore_roles || '').split(',').filter(Boolean);
      const taskRoleOptions = (roles.length
        ? roles.map(r => new StringSelectMenuOptionBuilder().setLabel(r.name).setValue(r.id).setDefault(selectedTaskRoles.includes(r.id)))
        : [new StringSelectMenuOptionBuilder().setLabel('No manageable roles').setValue('none')]
      );
      const taskRolesSelect = new StringSelectMenuBuilder()
        .setCustomId('task_roles_select')
        .setPlaceholder('Select roles that can do task (multi)')
        .setMinValues(0)
        .setMaxValues(Math.max(1, roles.length || 1))
        .addOptions(taskRoleOptions)
        .setDisabled(roles.length === 0);
      const ignoreCandidates = (over.ignoreRoleCandidates || rolesAll).slice(0,25);
      const ignoreRoleOptions = (ignoreCandidates.length
        ? ignoreCandidates.map(r => new StringSelectMenuOptionBuilder().setLabel(r.name).setValue(r.id).setDefault(selectedIgnoreRoles.includes(r.id)))
        : [new StringSelectMenuOptionBuilder().setLabel('No manageable roles').setValue('none')]
      );
      const ignoreRolesSelect = new StringSelectMenuBuilder()
        .setCustomId('task_ignore_roles_select')
        .setPlaceholder('Select roles to ignore counting (multi)')
        .setMinValues(0)
        .setMaxValues(Math.max(1, ignoreCandidates.length || 1))
        .addOptions(ignoreRoleOptions)
        .setDisabled(ignoreCandidates.length === 0);

      // Duration select
      const durations = [
        { label: '5 minutes', v: 300 },
        { label: '10 minutes', v: 600 },
        { label: '15 minutes', v: 900 },
        { label: '30 minutes', v: 1800 },
        { label: '1 hour', v: 3600 },
      ];
      const durationSelect = new StringSelectMenuBuilder()
        .setCustomId('task_duration_select')
        .setPlaceholder('Select required duration')
        .addOptions(durations.map(d => new StringSelectMenuOptionBuilder().setLabel(d.label).setValue(String(d.v)).setDefault(d.v === cfg.required_duration_sec)));
      const durationCustomRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('task_duration_custom_btn').setLabel('Set Duration (custom)').setStyle(ButtonStyle.Secondary)
      );

      // Required members count
      const counts = [1,2,3,4,5];
      const membersSelect = new StringSelectMenuBuilder()
        .setCustomId('task_member_count_select')
        .setPlaceholder('Select required member count to start')
        .addOptions(counts.map(n => new StringSelectMenuOptionBuilder().setLabel(`${n} member${n>1?'s':''}`).setValue(String(n)).setDefault(n === cfg.required_member_count)));

      // Points per task
      const points = [1,3,5,10,15,20];
      const pointsSelect = new StringSelectMenuBuilder()
        .setCustomId('task_points_select')
        .setPlaceholder('Select points awarded per task')
        .addOptions(points.map(p => new StringSelectMenuOptionBuilder().setLabel(`${p} points`).setValue(String(p)).setDefault(p === cfg.points_per_task)));

      const togglesRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('task_enabled_toggle').setLabel(`Task System: ${cfg.task_enabled ? 'Enabled' : 'Disabled'}`).setStyle(cfg.task_enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('task_same_role_toggle').setLabel(`Same-Role Counts: ${cfg.same_role_counts ? 'On' : 'Off'}`).setStyle(cfg.same_role_counts ? ButtonStyle.Success : ButtonStyle.Secondary),
      );

      const resetsRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('task_reset_setup').setLabel('Reset Setup').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('task_reset_all').setLabel('Reset All (incl. points)').setStyle(ButtonStyle.Danger),
      );

      // Separate rows: select menus must not share an ActionRow with buttons
      const logsRow = new ActionRowBuilder().addComponents(logsSelect);
      const taskRolesRow = new ActionRowBuilder().addComponents(taskRolesSelect);
      const ignoreRolesRow = new ActionRowBuilder().addComponents(ignoreRolesSelect);
      const cmdRow = new ActionRowBuilder().addComponents(cmdSelect);

      const logsSearchRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('task_search_logs_id').setLabel('Set Logs (ID)').setStyle(ButtonStyle.Secondary)
      );
      const taskRolesSearchRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('task_search_task_roles_id').setLabel('Set Task Roles (IDs)').setStyle(ButtonStyle.Secondary)
      );
      const ignoreRolesSearchRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('task_search_ignore_roles_id').setLabel('Set Ignore Roles (IDs)').setStyle(ButtonStyle.Secondary)
      );
      const cmdSearchRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('task_search_command_id').setLabel('Set Command (ID)').setStyle(ButtonStyle.Secondary)
      );

      const container = new ContainerBuilder()
        .setAccentColor(0xffdeff)
        .addTextDisplayComponents(title)
        .addActionRowComponents(helpRow)
        .addSeparatorComponents(new SeparatorBuilder())
        .addActionRowComponents(logsRow)
        .addActionRowComponents(logsSearchRow)
        .addActionRowComponents(taskRolesRow)
        .addActionRowComponents(taskRolesSearchRow)
        .addActionRowComponents(new ActionRowBuilder().addComponents(durationSelect))
        .addActionRowComponents(durationCustomRow)
        .addActionRowComponents(new ActionRowBuilder().addComponents(membersSelect))
        .addActionRowComponents(ignoreRolesRow)
        .addActionRowComponents(ignoreRolesSearchRow)
        .addActionRowComponents(new ActionRowBuilder().addComponents(pointsSelect))
        .addActionRowComponents(cmdRow)
        .addActionRowComponents(cmdSearchRow)
        .addSeparatorComponents(new SeparatorBuilder())
        .addActionRowComponents(togglesRow)
        .addActionRowComponents(resetsRow);

      return container;
    };

    // Build help container for Task Setup
    const buildTaskSetupHelpContainer = () => {
      const t = new TextDisplayBuilder().setContent('# <:axlboba:1456990939146092669> How to setup tasks');
      // const lines = [
      //   '1) Set Logs channel to receive task logs.',
      //   '2) Select roles allowed to do task (optional).',
      //   '3) Choose required duration and members count.',
      //   '4) Choose points per task and command channel (.v task).',
      //   '5) Toggle Task System to Enabled.',
      //   '6) Use .v task in the command channel to claim when eligible.'
      // ];
      // const body = new TextDisplayBuilder().setContent(lines.map(l=>`- ${l}`).join('\n'));
      const back = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('task_setup_back').setLabel('Back').setStyle(ButtonStyle.Secondary)
      );
      return new ContainerBuilder()
        .setAccentColor(0xffdeff)
        .addTextDisplayComponents(t)
        .addSeparatorComponents(new SeparatorBuilder())
        .addMediaGalleryComponents(new MediaGalleryBuilder().addItems([
          new MediaGalleryItemBuilder().setURL('https://ik.imagekit.io/gwqqjru7p/download%20(20).gif?updatedAt=1763044977901'),
        ]))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('**1** <a:arrowr:1440836463733244014> Set Logs channel to receive task logs.'))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('**2** <a:arrowr:1440836463733244014> Select roles allowed to do task (optional).'))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('**3** <a:arrowr:1440836463733244014> Choose required duration and members count.'))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('**4** <a:arrowr:1440836463733244014> Choose points per task and command channel (.v task).'))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('**5** <a:arrowr:1440836463733244014> Toggle Task System to Enabled.'))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('**6** <a:arrowr:1440836463733244014> Use .v task in the command channel to claim when eligible.'))
        .addSeparatorComponents(new SeparatorBuilder())
        // .addMediaGalleryComponents(new MediaGalleryBuilder().addItems([
        //   new MediaGalleryItemBuilder().setURL('https://ik.imagekit.io/gwqqjru7p/v!cky%20Space%20(2).png?updatedAt=1763073872360'),
        // ]))
        .addActionRowComponents(back);
    };

    const buildTaskAdminRolesContainer = async (g) => {
      const row = await dbGet('SELECT task_admin_roles FROM task_config WHERE guild_id = ?', [g.id]).catch(() => null);
      const current = (row?.task_admin_roles || '').split(',').filter(Boolean);
      const roles = g.roles.cache.filter(r => r.editable && r.id !== g.id).first(25) || [];

      const title = new TextDisplayBuilder().setContent('# Task Admin Roles');
      const info = new TextDisplayBuilder().setContent('Select roles allowed to use admin task commands (add/remove/reset points).');
      const sep = new SeparatorBuilder();

      const addOptions = (roles.length
        ? roles.map(r => new StringSelectMenuOptionBuilder().setLabel(r.name).setValue(r.id).setDefault(false))
        : [new StringSelectMenuOptionBuilder().setLabel('No manageable roles').setValue('none')]
      );
      const addSelect = new StringSelectMenuBuilder()
        .setCustomId('task_admin_roles_select_add')
        .setPlaceholder('Select roles to add (multi)')
        .setMinValues(0)
        .setMaxValues(Math.max(1, roles.length || 1))
        .addOptions(addOptions)
        .setDisabled(roles.length === 0);
      const addRow = new ActionRowBuilder().addComponents(addSelect);

      const removeList = current.slice(0, 25);
      const removeOptions = (removeList.length
        ? removeList.map(id => {
            const r = g.roles.cache.get(id);
            return new StringSelectMenuOptionBuilder().setLabel(r ? r.name : id).setValue(id).setDefault(false);
          })
        : [new StringSelectMenuOptionBuilder().setLabel('No admin roles set').setValue('none')]
      );
      const removeSelect = new StringSelectMenuBuilder()
        .setCustomId('task_admin_roles_select_remove')
        .setPlaceholder('Select roles to remove (multi)')
        .setMinValues(0)
        .setMaxValues(Math.max(1, removeList.length || 1))
        .addOptions(removeOptions)
        .setDisabled(removeList.length === 0);
      const removeRow = new ActionRowBuilder().addComponents(removeSelect);

      const buttonsRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('task_admin_roles_save').setLabel('Save').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('task_admin_roles_remove_btn').setLabel('Remove Selected').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('task_admin_roles_reset').setLabel('Reset All').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('task_admin_roles_search_add').setLabel('Search Add (IDs)').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('task_admin_roles_search_remove').setLabel('Search Remove (IDs)').setStyle(ButtonStyle.Secondary),
      );

      const currentText = new TextDisplayBuilder().setContent(`Current admin roles: ${current.length ? current.map(id => g.roles.cache.get(id)?.name || id).join(', ') : 'None'}`);

      const container = new ContainerBuilder()
        .addTextDisplayComponents(title)
        .addTextDisplayComponents(info)
        .addSeparatorComponents(sep)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('Add roles'))
        .addActionRowComponents(addRow)
        .addSeparatorComponents(sep)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('Remove roles'))
        .addActionRowComponents(removeRow)
        .addSeparatorComponents(sep)
        .addActionRowComponents(buttonsRow)
        .addSeparatorComponents(sep)
        .addTextDisplayComponents(currentText);
      return container;
    };
    if (interaction.isStringSelectMenu() && interaction.customId === 'setup_logs_select') {
      const selected = interaction.values?.[0];
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
      if (!selected) return interaction.editReply('<a:unVerif:1440432078356348928> No channel selected.').catch(() => {});
      try {
        await dbRun('INSERT INTO guild_config(guild_id, log_channel_id) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET log_channel_id = excluded.log_channel_id', [guild.id, selected]);
        return interaction.editReply(`<a:verif_vert:1440432091853492254> Logs channel set to <#${selected}>`).catch(() => {});
      } catch (e) {
        console.error('setup_logs_select error:', e);
        return interaction.editReply('<a:unVerif:1440432078356348928> Failed to save logs channel.').catch(() => {});
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'setup_lobby_select') {
      const selected = interaction.values?.[0];
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
      if (!selected) return interaction.editReply('<a:unVerif:1440432078356348928> No channel selected.').catch(() => {});
      try {
        await dbRun('INSERT INTO guild_config(guild_id, lobby_channel_id) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET lobby_channel_id = excluded.lobby_channel_id', [guild.id, selected]);
        return interaction.editReply(`<a:verif_vert:1440432091853492254> Lobby voice channel set to <#${selected}>`).catch(() => {});
      } catch (e) {
        console.error('setup_lobby_select error:', e);
        return interaction.editReply('<a:unVerif:1440432078356348928> Failed to save lobby channel.').catch(() => {});
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'setup_category_select') {
      const selected = interaction.values?.[0];
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
      if (!selected) return interaction.editReply('<a:unVerif:1440432078356348928> No category selected.').catch(() => {});
      try {
        await dbRun('INSERT INTO guild_config(guild_id, temp_category_id) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET temp_category_id = excluded.temp_category_id', [guild.id, selected]);
        return interaction.editReply(`<a:verif_vert:1440432091853492254> Temp voice category set to ${selected}`).catch(() => {});
      } catch (e) {
        console.error('setup_category_select error:', e);
        return interaction.editReply('<a:unVerif:1440432078356348928> Failed to save category.').catch(() => {});
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'setup_leaderboard_select') {
      const selected = interaction.values?.[0];
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
      if (!selected) return interaction.editReply('<a:unVerif:1440432078356348928> No channel selected.').catch(() => {});
      try {
        await dbRun('INSERT INTO guild_config(guild_id, leaderboard_channel_id) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET leaderboard_channel_id = excluded.leaderboard_channel_id', [guild.id, selected]);
        await startOrUpdateVoiceLeaderboard(guild, selected).catch(()=>{});
        return interaction.editReply(`<a:verif_vert:1440432091853492254> Leaderboard channel set to <#${selected}>`).catch(() => {});
      } catch (e) {
        console.error('setup_leaderboard_select error:', e);
        return interaction.editReply('<a:unVerif:1440432078356348928> Failed to save leaderboard channel.').catch(() => {});
      }
    }

    // Open modal to set logs channel by ID
    if (interaction.isButton() && interaction.customId === 'setup_search_logs') {
      const modal = new ModalBuilder().setCustomId('setupLogsModal').setTitle('Set Logs Channel by ID');
      const input = new TextInputBuilder()
        .setCustomId('channelIdInput')
        .setLabel('Text Channel ID')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 123456789012345678')
        .setRequired(true)
        .setMaxLength(25);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    // Task Setup: Reset handlers
    if (interaction.isButton() && interaction.customId === 'task_reset_setup') {
      await interaction.deferUpdate().catch(() => {});
      try {
        const defaults = {
          task_enabled: 0,
          logs_channel_id: null,
          command_channel_id: null,
          required_duration_sec: 900,
          required_member_count: 3,
          points_per_task: 5,
          task_roles: '',
          ignore_roles: '',
          same_role_counts: 0,
        };
        // Upsert each column to defaults
        await dbRun('INSERT INTO task_config(guild_id) VALUES(?) ON CONFLICT(guild_id) DO NOTHING', [guild.id]).catch(()=>{});
        await dbRun('UPDATE task_config SET task_enabled=?, logs_channel_id=?, command_channel_id=?, required_duration_sec=?, required_member_count=?, points_per_task=?, task_roles=?, ignore_roles=?, same_role_counts=? WHERE guild_id=?', [
          defaults.task_enabled,
          defaults.logs_channel_id,
          defaults.command_channel_id,
          defaults.required_duration_sec,
          defaults.required_member_count,
          defaults.points_per_task,
          defaults.task_roles,
          defaults.ignore_roles,
          defaults.same_role_counts,
          guild.id,
        ]);
      } catch (e) {
        console.error('task_reset_setup error:', e);
      }
      const container = await buildTaskSetupContainer(guild);
      return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId === 'task_reset_all') {
      await interaction.deferUpdate().catch(() => {});
      try {
        const defaults = {
          task_enabled: 0,
          logs_channel_id: null,
          command_channel_id: null,
          required_duration_sec: 900,
          required_member_count: 3,
          points_per_task: 5,
          task_roles: '',
          ignore_roles: '',
          same_role_counts: 0,
        };
        await dbRun('INSERT INTO task_config(guild_id) VALUES(?) ON CONFLICT(guild_id) DO NOTHING', [guild.id]).catch(()=>{});
        await dbRun('UPDATE task_config SET task_enabled=?, logs_channel_id=?, command_channel_id=?, required_duration_sec=?, required_member_count=?, points_per_task=?, task_roles=?, ignore_roles=?, same_role_counts=? WHERE guild_id=?', [
          defaults.task_enabled,
          defaults.logs_channel_id,
          defaults.command_channel_id,
          defaults.required_duration_sec,
          defaults.required_member_count,
          defaults.points_per_task,
          defaults.task_roles,
          defaults.ignore_roles,
          defaults.same_role_counts,
          guild.id,
        ]);
        await dbRun('DELETE FROM task_points WHERE guild_id = ?', [guild.id]);
      } catch (e) {
        console.error('task_reset_all error:', e);
      }
      const container = await buildTaskSetupContainer(guild);
      return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    }

    // Open modal to set lobby voice channel by ID
    if (interaction.isButton() && interaction.customId === 'setup_search_lobby') {
      const modal = new ModalBuilder().setCustomId('setupLobbyModal').setTitle('Set Lobby Voice by ID');
      const input = new TextInputBuilder()
        .setCustomId('channelIdInput')
        .setLabel('Voice Channel ID')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 123456789012345678')
        .setRequired(true)
        .setMaxLength(25);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    // Open modal to set leaderboard text channel by ID
    if (interaction.isButton() && interaction.customId === 'setup_search_leaderboard') {
      const modal = new ModalBuilder().setCustomId('setupLeaderboardModal').setTitle('Set Leaderboard Channel by ID');
      const input = new TextInputBuilder()
        .setCustomId('channelIdInput')
        .setLabel('Text Channel ID')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 123456789012345678')
        .setRequired(true)
        .setMaxLength(25);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    // Open modal to set temp category by ID
    if (interaction.isButton() && interaction.customId === 'setup_search_category') {
      const modal = new ModalBuilder().setCustomId('setupCategoryModal').setTitle('Set Temp Category by ID');
      const input = new TextInputBuilder()
        .setCustomId('channelIdInput')
        .setLabel('Category Channel ID')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 123456789012345678')
        .setRequired(true)
        .setMaxLength(25);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    // Task Setup: open search modals (no defer)
    if (interaction.isButton() && interaction.customId === 'task_search_logs') {
      const modal = new ModalBuilder().setCustomId('taskFindLogs').setTitle('Find Logs Channel by name');
      const input = new TextInputBuilder()
        .setCustomId('queryInput')
        .setLabel('Search text (min 2 chars)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., logs')
        .setRequired(true)
        .setMaxLength(50);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
    if (interaction.isButton() && interaction.customId === 'task_search_command') {
      const modal = new ModalBuilder().setCustomId('taskFindCmd').setTitle('Find Command Channel by name');
      const input = new TextInputBuilder()
        .setCustomId('queryInput')
        .setLabel('Search text (min 2 chars)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., task-cmd')
        .setRequired(true)
        .setMaxLength(50);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
    if (interaction.isButton() && interaction.customId === 'task_search_logs_id') {
      const modal = new ModalBuilder().setCustomId('taskSetLogsId').setTitle('Set Task Logs Channel by ID');
      const input = new TextInputBuilder()
        .setCustomId('channelIdInput')
        .setLabel('Text Channel ID')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 123456789012345678')
        .setRequired(true)
        .setMaxLength(25);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
    if (interaction.isButton() && interaction.customId === 'task_search_command_id') {
      const modal = new ModalBuilder().setCustomId('taskSetCmdId').setTitle('Set Task Command Channel by ID');
      const input = new TextInputBuilder()
        .setCustomId('channelIdInput')
        .setLabel('Text Channel ID')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 123456789012345678')
        .setRequired(true)
        .setMaxLength(25);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
    if (interaction.isButton() && interaction.customId === 'task_search_task_roles_id') {
      const modal = new ModalBuilder().setCustomId('taskSetTaskRolesByIds').setTitle('Set Task Roles by IDs');
      const input = new TextInputBuilder()
        .setCustomId('rolesIdsInput')
        .setLabel('Role IDs (comma-separated)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('e.g., 111,222,333')
        .setRequired(true)
        .setMaxLength(400);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
    if (interaction.isButton() && interaction.customId === 'task_search_ignore_roles_id') {
      const modal = new ModalBuilder().setCustomId('taskSetIgnoreRolesByIds').setTitle('Set Ignore Roles by IDs');
      const input = new TextInputBuilder()
        .setCustomId('rolesIdsInput')
        .setLabel('Role IDs (comma-separated)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('e.g., 111,222,333')
        .setRequired(true)
        .setMaxLength(400);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
    if (interaction.isButton() && interaction.customId === 'task_search_task_roles') {
      const modal = new ModalBuilder().setCustomId('taskFindTaskRoles').setTitle('Find Task Roles by name');
      const input = new TextInputBuilder()
        .setCustomId('queryInput')
        .setLabel('Search text (min 2 chars)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., task')
        .setRequired(true)
        .setMaxLength(50);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
    if (interaction.isButton() && interaction.customId === 'task_search_ignore_roles') {
      const modal = new ModalBuilder().setCustomId('taskFindIgnoreRoles').setTitle('Find Ignore Roles by name');
      const input = new TextInputBuilder()
        .setCustomId('queryInput')
        .setLabel('Search text (min 2 chars)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., afk')
        .setRequired(true)
        .setMaxLength(50);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    // Open Task Setup panel (clean handler) - supports legacy IDs too
    if (interaction.isButton() && ['task_setup_open_clean','setup_task_open_v2','setup_task_open'].includes(interaction.customId)) {
      try {
        const guild = interaction.guild;
        const isDev = client.isDeveloper?.(interaction.user.id);
        const rowOwner = await dbGet('SELECT 1 FROM guild_owners WHERE guild_id = ? AND user_id = ?', [guild.id, interaction.user.id]).catch(()=>null);
        const allowed = !!isDev || !!rowOwner;
        if (!allowed) {
          const contactUrl = process.env.CONTACT_SUPPORT || 'https://discord.com/users/1536781748807934003';
          const btnRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Contact Developer').setStyle(ButtonStyle.Link).setURL(contactUrl)
          );
          const containerReply = new ContainerBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent('<a:unVerif:1440432078356348928> You do not have permission to open Task Setup.'))
            .addSeparatorComponents(new SeparatorBuilder())
            .addActionRowComponents(btnRow);
          try {
            return await interaction.reply({ components: [containerReply], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
          } catch {
            return interaction.reply({ components: [btnRow], flags: MessageFlags.Ephemeral }).catch(()=>{});
          }
        }
        await interaction.deferUpdate().catch(()=>{});
        let container;
        try {
          container = await buildTaskSetupContainer(guild);
        } catch (e) {
          return interaction.editReply({ content: '<a:unVerif:1440432078356348928> Failed to build Task Setup UI. Please try again later.' }).catch(()=>{});
        }
        try {
          await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
          try {
            const key = `${guild.id}:${interaction.user.id}`;
            taskSetupMessages.set(key, { channelId: interaction.channelId, messageId: interaction.message?.id });
          } catch {}
        } catch (e) {
          await interaction.editReply({ content: 'Task Setup: UI failed to display. Please try again later.' }).catch(()=>{});
        }
      } catch (e) {}
    }

    // Remove legacy handlers above; using task_setup_open_clean only

    // Name-based search modal submits to populate selects
    if (interaction.isModalSubmit() && interaction.customId === 'taskFindLogs') {
      const q = (interaction.fields.getTextInputValue('queryInput') || '').toLowerCase().trim();
      const candidates = guild.channels.cache
        .filter(c => c.type === ChannelType.GuildText && c.name.toLowerCase().includes(q))
        .first(25) || [];
      const container = await buildTaskSetupContainer(guild, { logsCandidates: candidates, searchChannels: candidates });
      const key = `${guild.id}:${interaction.user.id}`;
      const ref = taskSetupMessages.get(key);
      if (ref) {
        const ch = await client.channels.fetch(ref.channelId).catch(()=>null);
        const msg = ch ? await ch.messages.fetch(ref.messageId).catch(()=>null) : null;
        if (msg) {
          await msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
          return interaction.reply({ content: '<a:verif_vert:1440432091853492254> Updated.', flags: MessageFlags.Ephemeral }).catch(()=>{});
        }
      }
      return interaction.reply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
    }
    if (interaction.isModalSubmit() && interaction.customId === 'taskFindCmd') {
      const q = (interaction.fields.getTextInputValue('queryInput') || '').toLowerCase().trim();
      const candidates = guild.channels.cache
        .filter(c => c.type === ChannelType.GuildText && c.name.toLowerCase().includes(q))
        .first(25) || [];
      const container = await buildTaskSetupContainer(guild, { cmdCandidates: candidates, searchChannels: candidates });
      const key = `${guild.id}:${interaction.user.id}`;
      const ref = taskSetupMessages.get(key);
      if (ref) {
        const ch = await client.channels.fetch(ref.channelId).catch(()=>null);
        const msg = ch ? await ch.messages.fetch(ref.messageId).catch(()=>null) : null;
        if (msg) {
          await msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
          return interaction.reply({ content: '<a:verif_vert:1440432091853492254> Updated.', flags: MessageFlags.Ephemeral }).catch(()=>{});
        }
      }
      return interaction.reply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
    }
    if (interaction.isModalSubmit() && interaction.customId === 'taskFindTaskRoles') {
      const q = (interaction.fields.getTextInputValue('queryInput') || '').toLowerCase().trim();
      const candidates = guild.roles.cache
        .filter(r => r.editable && r.id !== guild.id && r.name.toLowerCase().includes(q))
        .first(25) || [];
      const container = await buildTaskSetupContainer(guild, { taskRoleCandidates: candidates, searchRoles: candidates });
      const key = `${guild.id}:${interaction.user.id}`;
      const ref = taskSetupMessages.get(key);
      if (ref) {
        const ch = await client.channels.fetch(ref.channelId).catch(()=>null);
        const msg = ch ? await ch.messages.fetch(ref.messageId).catch(()=>null) : null;
        if (msg) {
          await msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
          return interaction.reply({ content: '<a:verif_vert:1440432091853492254> Updated.', flags: MessageFlags.Ephemeral }).catch(()=>{});
        }
      }
      return interaction.reply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
    }
    if (interaction.isModalSubmit() && interaction.customId === 'taskFindIgnoreRoles') {
      const q = (interaction.fields.getTextInputValue('queryInput') || '').toLowerCase().trim();
      const candidates = guild.roles.cache
        .filter(r => r.editable && r.id !== guild.id && r.name.toLowerCase().includes(q))
        .first(25) || [];
      const container = await buildTaskSetupContainer(guild, { ignoreRoleCandidates: candidates, searchRoles: candidates });
      const key = `${guild.id}:${interaction.user.id}`;
      const ref = taskSetupMessages.get(key);
      if (ref) {
        const ch = await client.channels.fetch(ref.channelId).catch(()=>null);
        const msg = ch ? await ch.messages.fetch(ref.messageId).catch(()=>null) : null;
        if (msg) {
          await msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
          return interaction.reply({ content: '<a:verif_vert:1440432091853492254> Updated.', flags: MessageFlags.Ephemeral }).catch(()=>{});
        }
      }
      return interaction.reply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
    }

    // ID-based Task Setup modals
    if (interaction.isModalSubmit() && interaction.customId === 'taskSetLogsId') {
      const id = (interaction.fields.getTextInputValue('channelIdInput') || '').trim();
      const ch = guild.channels.cache.get(id);
      if (!/^\d{10,}$/.test(id) || !ch || ch.type !== ChannelType.GuildText) {
        return interaction.reply({ content: '<a:unVerif:1440432078356348928> Invalid text channel ID.', flags: MessageFlags.Ephemeral }).catch(()=>{});
      }
      const container = await buildTaskSetupContainer(guild, { logsCandidates: [ch], searchChannels: [ch] });
      const key = `${guild.id}:${interaction.user.id}`;
      const ref = taskSetupMessages.get(key);
      if (ref) {
        const chn = await client.channels.fetch(ref.channelId).catch(()=>null);
        const msg = chn ? await chn.messages.fetch(ref.messageId).catch(()=>null) : null;
        if (msg) await msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
      }
      return interaction.reply({ content: '<a:verif_vert:1440432091853492254> Found 1 logs channel. Select it in the dropdown.', flags: MessageFlags.Ephemeral }).catch(()=>{});
    }

    if (interaction.isModalSubmit() && interaction.customId === 'taskSetCmdId') {
      const id = (interaction.fields.getTextInputValue('channelIdInput') || '').trim();
      const ch = guild.channels.cache.get(id);
      if (!/^\d{10,}$/.test(id) || !ch || ch.type !== ChannelType.GuildText) {
        return interaction.reply({ content: '<a:unVerif:1440432078356348928> Invalid text channel ID.', flags: MessageFlags.Ephemeral }).catch(()=>{});
      }
      const container = await buildTaskSetupContainer(guild, { cmdCandidates: [ch], searchChannels: [ch] });
      const key = `${guild.id}:${interaction.user.id}`;
      const ref = taskSetupMessages.get(key);
      if (ref) {
        const chn = await client.channels.fetch(ref.channelId).catch(()=>null);
        const msg = chn ? await chn.messages.fetch(ref.messageId).catch(()=>null) : null;
        if (msg) await msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
      }
      return interaction.reply({ content: '<a:verif_vert:1440432091853492254> Found 1 command channel. Select it in the dropdown.', flags: MessageFlags.Ephemeral }).catch(()=>{});
    }

    if (interaction.isModalSubmit() && interaction.customId === 'taskSetTaskRolesByIds') {
      const raw = (interaction.fields.getTextInputValue('rolesIdsInput') || '').trim();
      const ids = raw.split(/[\s,]+/).filter(x => /^\d{10,}$/.test(x));
      const roles = ids.map(id => guild.roles.cache.get(id)).filter(Boolean);
      if (!roles.length) {
        return interaction.reply({ content: '<a:unVerif:1440432078356348928> No valid role IDs provided.', flags: MessageFlags.Ephemeral }).catch(()=>{});
      }
      const container = await buildTaskSetupContainer(guild, { taskRoleCandidates: roles, searchRoles: roles });
      const key = `${guild.id}:${interaction.user.id}`;
      const ref = taskSetupMessages.get(key);
      if (ref) {
        const chn = await client.channels.fetch(ref.channelId).catch(()=>null);
        const msg = chn ? await chn.messages.fetch(ref.messageId).catch(()=>null) : null;
        if (msg) await msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
      }
      return interaction.reply({ content: `<a:verif_vert:1440432091853492254> Found ${roles.length} role(s). Select them in the dropdown.`, flags: MessageFlags.Ephemeral }).catch(()=>{});
    }

    if (interaction.isModalSubmit() && interaction.customId === 'taskSetIgnoreRolesByIds') {
      const raw = (interaction.fields.getTextInputValue('rolesIdsInput') || '').trim();
      const ids = raw.split(/[\s,]+/).filter(x => /^\d{10,}$/.test(x));
      const roles = ids.map(id => guild.roles.cache.get(id)).filter(Boolean);
      if (!roles.length) {
        return interaction.reply({ content: '<a:unVerif:1440432078356348928> No valid role IDs provided.', flags: MessageFlags.Ephemeral }).catch(()=>{});
      }
      const container = await buildTaskSetupContainer(guild, { ignoreRoleCandidates: roles, searchRoles: roles });
      const key = `${guild.id}:${interaction.user.id}`;
      const ref = taskSetupMessages.get(key);
      if (ref) {
        const chn = await client.channels.fetch(ref.channelId).catch(()=>null);
        const msg = chn ? await chn.messages.fetch(ref.messageId).catch(()=>null) : null;
        if (msg) await msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(()=>{});
      }
      return interaction.reply({ content: `<a:verif_vert:1440432091853492254> Found ${roles.length} ignore role(s). Select them in the dropdown.`, flags: MessageFlags.Ephemeral }).catch(()=>{});
    }

    // Task Setup: Help and Back
    if (interaction.isButton() && interaction.customId === 'task_setup_help') {
      try {
        const help = buildTaskSetupHelpContainer();
        return interaction.update({ components: [help], flags: MessageFlags.IsComponentsV2 });
      } catch (e) {
        console.error('task_setup_help error:', e);
      }
    }
    if (interaction.isButton() && interaction.customId === 'task_setup_back') {
      try {
        const main = await buildTaskSetupContainer(guild);
        return interaction.update({ components: [main], flags: MessageFlags.IsComponentsV2 });
      } catch (e) {
        console.error('task_setup_back error:', e);
      }
    }

    // Toggle: Same-Role Counts
    if (interaction.isButton() && interaction.customId === 'task_same_role_toggle') {
      try {
        const cfg = await getTaskConfig(guild.id);
        const newVal = cfg.same_role_counts ? 0 : 1;
        await upsertTaskConfig(guild.id, 'same_role_counts', newVal);
        const refreshed = await buildTaskSetupContainer(guild);
        return interaction.update({ components: [refreshed], flags: MessageFlags.IsComponentsV2 });
      } catch (e) {
        console.error('task_same_role_toggle error:', e);
        return interaction.reply({ content: '<a:unVerif:1440432078356348928> Failed to toggle Same-Role Counts.', flags: MessageFlags.Ephemeral }).catch(()=>{});
      }
    }

    // (Removed) Duplicate setup modal submit handlers are defined earlier

    if (interaction.isButton() && ['cp_style_a','cp_style_b','cp_style_c'].includes(interaction.customId)) {
      try {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        const style = interaction.customId.replace('cp_style_','');
        await dbRun('INSERT INTO guild_config(guild_id, control_panel_style) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET control_panel_style = excluded.control_panel_style', [guild.id, style]);
        const text = new TextDisplayBuilder().setContent(`<a:verif_vert:1440432091853492254> Control panel style set to ${style.toUpperCase()}.`);
        const container = new ContainerBuilder().addTextDisplayComponents(text);
        return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
      } catch (e) {
        console.error('cp_style set error:', e);
        if (!interaction.deferred && !interaction.replied) {
          return interaction.reply({ content: '<a:unVerif:1440432078356348928> Failed to save control panel style.', flags: MessageFlags.Ephemeral });
        }
        return interaction.editReply({ content: '<a:unVerif:1440432078356348928> Failed to save control panel style.' }).catch(() => {});
      }
    }

    // ================= Task Setup: selects & toggles =================
    if (interaction.isStringSelectMenu() && interaction.customId === 'task_logs_select') {
      await interaction.deferUpdate().catch(() => {});
      const selected = interaction.values?.[0] || null;
      await upsertTaskConfig(guild.id, 'logs_channel_id', selected).catch(() => {});
      const container = await buildTaskSetupContainer(guild);
      return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'task_command_channel_select') {
      await interaction.deferUpdate().catch(() => {});
      const selected = interaction.values?.[0] || null;
      await upsertTaskConfig(guild.id, 'command_channel_id', selected).catch(() => {});
      const container = await buildTaskSetupContainer(guild);
      return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'task_roles_select') {
      await interaction.deferUpdate().catch(() => {});
      const vals = interaction.values || [];
      await upsertTaskConfig(guild.id, 'task_roles', vals.join(',')).catch(() => {});
      const container = await buildTaskSetupContainer(guild);
      return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'task_ignore_roles_select') {
      await interaction.deferUpdate().catch(() => {});
      const vals = interaction.values || [];
      await upsertTaskConfig(guild.id, 'ignore_roles', vals.join(',')).catch(() => {});
      const container = await buildTaskSetupContainer(guild);
      return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'task_duration_select') {
      await interaction.deferUpdate().catch(() => {});
      const v = parseInt(interaction.values?.[0] || '900', 10);
      await upsertTaskConfig(guild.id, 'required_duration_sec', isNaN(v) ? 900 : v).catch(() => {});
      const container = await buildTaskSetupContainer(guild);
      return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    }
    if (interaction.isButton() && interaction.customId === 'task_duration_custom_btn') {
      // Open modal to input custom duration (supports s/m/h/d)
      const modal = new ModalBuilder().setCustomId('taskDurationCustomModal').setTitle('Custom Task Duration');
      const input = new TextInputBuilder()
        .setCustomId('taskDurationInput')
        .setLabel('Duration (e.g., 45s, 5m, 2h, 1d)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 45s or 5m or 2h or 1d')
        .setRequired(true)
        .setMaxLength(8);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'task_member_count_select') {
      await interaction.deferUpdate().catch(() => {});
      const v = parseInt(interaction.values?.[0] || '3', 10);
      await upsertTaskConfig(guild.id, 'required_member_count', isNaN(v) ? 3 : v).catch(() => {});
      const container = await buildTaskSetupContainer(guild);
      return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'task_points_select') {
      await interaction.deferUpdate().catch(() => {});
      const v = parseInt(interaction.values?.[0] || '5', 10);
      await upsertTaskConfig(guild.id, 'points_per_task', isNaN(v) ? 5 : v).catch(() => {});
      const container = await buildTaskSetupContainer(guild);
      return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    }
    if (interaction.isButton() && interaction.customId === 'task_enabled_toggle') {
      await interaction.deferUpdate().catch(() => {});
      const cfg = await getTaskConfig(guild.id);
      await upsertTaskConfig(guild.id, 'task_enabled', cfg.task_enabled ? 0 : 1).catch(() => {});
      const container = await buildTaskSetupContainer(guild);
      return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    }
    if (interaction.isButton() && interaction.customId === 'task_same_role_toggle') {
      await interaction.deferUpdate().catch(() => {});
      const cfg = await getTaskConfig(guild.id);
      await upsertTaskConfig(guild.id, 'same_role_counts', cfg.same_role_counts ? 0 : 1).catch(() => {});
      const container = await buildTaskSetupContainer(guild);
      return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    }

    // ===================================================================
    //                             MODAL SUBMISSIONS
    // ===================================================================
    if (interaction.isModalSubmit()) {
      // Task Setup search modal submissions (reply ephemeral; no defer)
      if (interaction.customId === 'taskSearchLogsModal') {
        const id = interaction.fields.getTextInputValue('channelIdInput').trim();
        const ch = guild.channels.cache.get(id);
        if (!ch || ch.type !== ChannelType.GuildText) return interaction.reply({ content: '<a:unVerif:1440432078356348928> Invalid text channel ID.', flags: MessageFlags.Ephemeral });
        await upsertTaskConfig(guild.id, 'logs_channel_id', ch.id).catch(() => {});
        return interaction.reply({ content: `<a:verif_vert:1440432091853492254> Logs channel set to <#${ch.id}>`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'taskSearchCmdModal') {
        const id = interaction.fields.getTextInputValue('channelIdInput').trim();
        const ch = guild.channels.cache.get(id);
        if (!ch || ch.type !== ChannelType.GuildText) return interaction.reply({ content: '<a:unVerif:1440432078356348928> Invalid text channel ID.', flags: MessageFlags.Ephemeral });
        await upsertTaskConfig(guild.id, 'command_channel_id', ch.id).catch(() => {});
        return interaction.reply({ content: `<a:verif_vert:1440432091853492254> Command channel set to <#${ch.id}>`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'taskDurationCustomModal') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(()=>{});
        const raw = (interaction.fields.getTextInputValue('taskDurationInput') || '').trim();
        if (!/^\d+[smhd]$/i.test(raw)) {
          return interaction.editReply('<a:unVerif:1440432078356348928> Invalid duration. Use formats like 45s, 5m, 2h, 1d.').catch(()=>{});
        }
        const num = parseInt(raw, 10);
        const unit = raw.slice(-1).toLowerCase();
        const seconds = unit === 'd' ? num * 86400 : unit === 'h' ? num * 3600 : unit === 'm' ? num * 60 : num;
        await upsertTaskConfig(guild.id, 'required_duration_sec', seconds).catch(()=>{});
        const container = await buildTaskSetupContainer(guild);
        await interaction.editReply('<a:verif_vert:1440432091853492254> Duration updated successfully.').catch(()=>{});
        return interaction.followUp({ components: [container], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral }).catch(()=>{});
      }
      if (interaction.customId === 'taskSearchTaskRolesModal') {
        const raw = interaction.fields.getTextInputValue('roleIdsInput') || '';
        const ids = (raw.match(/\d{10,}/g) || []).filter((v,i,a)=>a.indexOf(v)===i);
        if (ids.length === 0) return interaction.reply({ content: '<a:unVerif:1440432078356348928> Provide at least one valid role ID.', flags: MessageFlags.Ephemeral });
        await upsertTaskConfig(guild.id, 'task_roles', ids.join(',')).catch(() => {});
        return interaction.reply({ content: `<a:verif_vert:1440432091853492254> Task roles set (${ids.length}).`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'taskSearchIgnoreRolesModal') {
        const raw = interaction.fields.getTextInputValue('roleIdsInput') || '';
        const ids = (raw.match(/\d{10,}/g) || []).filter((v,i,a)=>a.indexOf(v)===i);
        if (ids.length === 0) return interaction.reply({ content: '<a:unVerif:1440432078356348928> Provide at least one valid role ID.', flags: MessageFlags.Ephemeral });
        await upsertTaskConfig(guild.id, 'ignore_roles', ids.join(',')).catch(() => {});
        return interaction.reply({ content: `<a:verif_vert:1440432091853492254> Ignore roles set (${ids.length}).`, flags: MessageFlags.Ephemeral });
      }
      const { voice: { channel: voiceChannel } } = member;
      if (!voiceChannel) return interaction.reply({ content: '<a:unVerif:1440432078356348928> You must be in your temp voice channel.', flags: MessageFlags.Ephemeral });

      const channelInfo = await dbGet('SELECT owner_id, base_name, status_name FROM temp_channels WHERE channel_id = ?', [voiceChannel.id]);
      if (!channelInfo) return interaction.reply({ content: '<a:unVerif:1440432078356348928> This is not a managed temp channel.', flags: MessageFlags.Ephemeral });

      const isOwner = channelInfo.owner_id === userId;
      if (!isOwner) return interaction.reply({ content: '<a:unVerif:1440432078356348928> You do not have permission to manage this channel.', flags: MessageFlags.Ephemeral });

      // --- Status Modal ---
      if (interaction.customId === 'statusModal') {
        const newStatusName = interaction.fields.getTextInputValue('statusInput').trim();
        if (newStatusName.length > 100) return interaction.reply({ content: '<a:unVerif:1440432078356348928> Status name must be 100 characters or less.', flags: MessageFlags.Ephemeral });
        const newChannelName = buildChannelName(channelInfo.base_name, newStatusName);
        await voiceChannel.setName(newChannelName);
        await dbRun('UPDATE temp_channels SET status_name = ? WHERE channel_id = ?', [newStatusName, voiceChannel.id]);
        return interaction.reply({ content: `<a:verif_vert:1440432091853492254> Channel status updated: **${newChannelName}**`, flags: MessageFlags.Ephemeral });
      }

      // --- Rename Modal ---
      if (interaction.customId === 'limitModal') {
        const limit = parseInt(interaction.fields.getTextInputValue('limitInput'), 10);

        if (isNaN(limit) || limit < 0 || limit > 99) {
          return interaction.reply({ content: '<a:unVerif:1440432078356348928> Please enter a valid number between 0 and 99 (0 for unlimited).', flags: MessageFlags.Ephemeral });
        }

        await voiceChannel.setUserLimit(limit);
        await dbRun('UPDATE temp_channels SET user_limit = ? WHERE channel_id = ?', [limit, voiceChannel.id]);

        return interaction.reply({ content: `<a:verif_vert:1440432091853492254> Channel user limit set to **${limit === 0 ? 'Unlimited' : limit}**.`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'renameModal') {
        const newBaseName = interaction.fields.getTextInputValue('renameInput').trim();
        if (newBaseName.length < 1 || newBaseName.length > 100) return interaction.reply({ content: '<a:unVerif:1440432078356348928> Name must be 1-100 chars.', flags: MessageFlags.Ephemeral });
        const newChannelName = buildChannelName(newBaseName, channelInfo.status_name);
        const oldChannelName = voiceChannel.name;
        await voiceChannel.setName(newChannelName);
        await dbRun('UPDATE temp_channels SET base_name = ? WHERE channel_id = ?', [newBaseName, voiceChannel.id]);
        
        // Log the rename action
        if (voiceLogger) {
          await voiceLogger.logChannelRename(guild.id, voiceChannel, member, oldChannelName, newChannelName);
        }
        
        return interaction.reply({ content: `<a:verif_vert:1440432091853492254> Channel renamed to **${newChannelName}**`, flags: MessageFlags.Ephemeral });
      }

      // --- Permit Modal ---
      if (interaction.customId === 'permitModal') {
        const userInput = interaction.fields.getTextInputValue('userInput');
        const targetMember = guild.members.cache.get(userInput.match(/\d+/)?.[0]) || await guild.members.fetch(userInput).catch(() => null);
        if (!targetMember) return interaction.reply({ content: '<a:unVerif:1440432078356348928> Target user not found in this server.', flags: MessageFlags.Ephemeral });
        await voiceChannel.permissionOverwrites.edit(targetMember.id, { Connect: true, Speak: true, ViewChannel: true });
        
        // Log the permit action
        if (voiceLogger) {
          await voiceLogger.logPermissionChange(guild.id, voiceChannel, member, targetMember, 'permitted');
        }
        
        return interaction.reply({ content: `<a:verif_vert:1440432091853492254> Permitted ${targetMember.user.tag} to join.`, flags: MessageFlags.Ephemeral });
      }

      // --- Deny Modal ---
      if (interaction.customId === 'denyModal') {
        const userInput = interaction.fields.getTextInputValue('userInput');
        const targetMember = guild.members.cache.get(userInput.match(/\d+/)?.[0]) || await guild.members.fetch(userInput).catch(() => null);
        if (!targetMember) return interaction.reply({ content: '<a:unVerif:1440432078356348928> Target user not found in this server.', flags: MessageFlags.Ephemeral });
        if (targetMember.id === userId) return interaction.reply({ content: '<a:unVerif:1440432078356348928> You cannot deny yourself.', flags: MessageFlags.Ephemeral });
        const targetIsManager = await dbGet('SELECT 1 FROM user_managers WHERE owner_id = ? AND manager_id = ?', [channelInfo.owner_id, targetMember.id]);
        if (targetIsManager) return interaction.reply({ content: '<a:unVerif:1440432078356348928> You cannot deny managers.', flags: MessageFlags.Ephemeral });

        await voiceChannel.permissionOverwrites.edit(targetMember.id, { Connect: false, Speak: false, ViewChannel: true });

        if (targetMember.voice.channelId === voiceChannel.id) {
          const configRow = await dbGet('SELECT lobby_channel_id FROM guild_config WHERE guild_id = ?', [guild.id]);
          if (configRow?.lobby_channel_id) {
            const lobbyRoom = guild.channels.cache.get(configRow.lobby_channel_id);
            if (lobbyRoom?.isVoiceBased()) await targetMember.voice.setChannel(lobbyRoom).catch(e => console.error("Failed to move denied user:", e));
          }
        }
        
        // Log the deny action
        if (voiceLogger) {
          await voiceLogger.logPermissionChange(guild.id, voiceChannel, member, targetMember, 'denied');
        }
        
        return interaction.reply({ content: `🚫 Denied access for ${targetMember.user.tag}.`, flags: MessageFlags.Ephemeral });
      }
    }

    // vc_* interactions are handled exclusively in event/interactionCreate.js

  } catch (err) {
    console.error('Interaction handler error:', err);
    if (interaction.isModalSubmit() || interaction.isButton() || interaction.isStringSelectMenu()) {
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '<a:unVerif:1440432078356348928> An error occurred while handling this interaction.', flags: MessageFlags.Ephemeral }).catch(() => {});
        } else {
            await interaction.followUp({ content: '<a:unVerif:1440432078356348928> An error occurred while handling this interaction.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }
  }
});

process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
}); 

// Prevent process from exiting on unexpected errors
process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
});

process.on('uncaughtExceptionMonitor', err => {
  console.error('Uncaught exception (monitor):', err);
});

process.on('warning', (warning) => {
  console.warn('Process warning:', warning);
});

// Discord client-level resilience
client.on('error', (e) => console.error('Client error:', e));
client.on('shardError', (e) => console.error('Shard error:', e));
client.on('warn', (w) => console.warn('Client warn:', w));
client.on('shardDisconnect', (event, shardId) => {
  console.warn(`Shard ${shardId} disconnected:`, event?.code, event?.reason);
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('Failed to login:', err);
});
