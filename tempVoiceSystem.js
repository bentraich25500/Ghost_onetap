const { 
  ChannelType, 
  ContainerBuilder, 
  SectionBuilder, 
  TextDisplayBuilder, 
  ButtonBuilder, 
  ButtonStyle,
  MessageFlags,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  EmbedBuilder,
} = require('discord.js');
const { VibeSync } = require('vibesync');
// Detect Components V2 availability to support fallback
const hasV2Builders = !!(TextDisplayBuilder && ContainerBuilder && MediaGalleryBuilder && SeparatorBuilder);
const { sendV2 } = require('./utils/v2');
const { sendControlPanel } = require('./themes');

// Track per-guild periodic scanners to avoid creating duplicates
const activeGuildIntervals = new Map();
// Stop intervals when guild has no temp channels for a while to reduce overhead
const emptyScanRounds = new Map(); // key: guildId -> consecutive empty scans
// Throttle logs for owner-left to avoid spam
const lastOwnerLogTs = new Map(); // key: channel_id, value: timestamp
// Simple cache for guild_config for 10s
const guildConfigCache = new Map(); // key: guildId, value: { data, ts }
const bottomDebounce = new Map(); // key: parentId, value: timeout
const recentlySorted = new Map(); // key: parentId, value: lastSortTs
const followUpRan = new Map(); // key: parentId, value: boolean (single follow-up executed)
const enforceBottomOnChanges = false; // only sort at creation time
let channelUpdateWatcherInstalled = false;
// Prevent duplicate creations per user (debounce)
const creationLocks = new Map(); // key: userId, value: timestamp
const userLastCreate = new Map(); // key: `${guildId}:${userId}`, value: timestamp
const guildCooldownUntil = new Map(); // key: guildId, value: timestamp
const lobbyCloneLocks = new Map(); // key: guildId, value: boolean (silent lobby clone in progress)
// Force creation mode B: always create a fresh temp channel (keep lobby chat; member will be moved)
const FORCE_FRESH_CREATION = true;
// Maintain a standby voice channel to speed up creation (reuse instead of create)
const standbyEnsuring = new Set(); // guildId set to avoid concurrent ensures
const ENABLE_STANDBY = false; // disable standby channels while keeping speed
const ENABLE_POST_SORT = false; // disable bottom sort after insert for max speed

function dbRunP(db, sql, params = []) {
  return new Promise((resolve) => {
    db.run(sql, params, () => resolve());
  });
}

function formatSecs(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${s}s`;
}

// Safely purge messages from a voice channel's text chat (Text-In-Voice)
async function purgeVoiceTextIfAny(channel) {
  try {
    if (!channel || typeof channel.messages?.fetch !== 'function') return;
    // Fetch up to 100 recent messages
    const msgs = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!msgs || msgs.size === 0) return;
    // Bulk delete those younger than 14 days
    const now = Date.now();
    const younger = msgs.filter(m => (now - m.createdTimestamp) < 14 * 24 * 60 * 60 * 1000);
    if (younger.size > 0) {
      await channel.bulkDelete(younger, true).catch(() => {});
    }

  // New: recompute task tracking for any member in any voice channel (not only temp channels)
  async function recomputeTaskForMember(guild, member) {
    if (!member || !member.voice || !member.voice.channelId) { client.taskTrackers.delete(member?.id); return; }
    const vc = member.voice.channel;
    if (!vc || vc.type !== ChannelType.GuildVoice) { client.taskTrackers.delete(member.id); return; }
    const cfg = await new Promise((resolve) => {
      db.get(`SELECT * FROM task_config WHERE guild_id = ?`, [guild.id], (err, r) => resolve(r || null));
    });
    if (!cfg || !cfg.task_enabled) { client.taskTrackers.delete(member.id); return; }
    const taskRoles = (cfg.task_roles || '').split(',').filter(Boolean);
    const ignoreRoles = (cfg.ignore_roles || '').split(',').filter(Boolean);
    const sameCounts = !!cfg.same_role_counts;

    // Member must have a task role if configured
    if (taskRoles.length > 0 && !member.roles.cache.some(r => taskRoles.includes(r.id))) {
      client.taskTrackers.delete(member.id); return;
    }
    // Count eligible members in the same channel (excluding the member)
    let eligibleCount = 0;
    for (const [mid, m] of vc.members) {
      if (mid === member.id) continue;
      if (m.user.bot) continue;
      const hasIgnore = ignoreRoles.length > 0 && m.roles.cache.some(r => ignoreRoles.includes(r.id));
      if (hasIgnore) continue;
      if (!sameCounts && taskRoles.length > 0 && m.roles.cache.some(r => taskRoles.includes(r.id))) continue;
      eligibleCount++;
    }
    const required = Number(cfg.required_member_count || 3);
    if (eligibleCount >= required) {
      const cur = client.taskTrackers.get(member.id);
      if (!cur || cur.channelId !== vc.id) {
        client.taskTrackers.set(member.id, { startTs: Date.now(), channelId: vc.id });
      }
    } else {
      client.taskTrackers.delete(member.id);
    }
  }
    // Delete any remaining individually (older than 14 days)
    const older = msgs.filter(m => !younger.has(m.id));
    for (const [, m] of older) {
      try { await m.delete().catch(() => {}); } catch {}
    }
  } catch {}
}

// Debounced bottom enforcement: keep temp channels at the bottom inside a category
function scheduleEnsureBottom(guild, parentId, db, delayMs = 450, forceLastChannelId = null, forceRun = false) {
  if (!guild || !parentId) return;
  const key = String(parentId);
  const now = Date.now();
  const last = recentlySorted.get(key) || 0;
  if (!forceRun && now - last < 2000) return; // skip if sorted very recently unless forced
  if (bottomDebounce.has(key)) {
    clearTimeout(bottomDebounce.get(key));
  }
  const run = async () => {
    try {
      const parentCat = guild.channels.cache.get(parentId) || await guild.channels.fetch(parentId).catch(() => null);
      if (!parentCat) return;
      // Fetch temp channel ids for this guild
      const tempIds = await new Promise((resolve) => {
        db.all(`SELECT channel_id FROM temp_channels WHERE guild_id = ?`, [guild.id], (err, rows) => {
          if (err || !rows) return resolve([]);
          resolve(rows.map(r => r.channel_id));
        });
      });
      const tempSet = new Set(tempIds);
      // Collect all siblings under this parent and sort by current position
      const siblingsAll = guild.channels.cache
        .filter(c => c.parentId === parentId)
        .sort((a, b) => {
          const pa = typeof a.rawPosition === 'number' ? a.rawPosition : a.position;
          const pb = typeof b.rawPosition === 'number' ? b.rawPosition : b.position;
          return pa - pb;
        });
      if (siblingsAll.size === 0) return;
      // Partition explicitly: non-temp voice channels, temp voice channels, other channels (text/stage/etc.)
      const nonTempVoices = [];
      const tempVoices = [];
      const otherChannels = [];
      siblingsAll.forEach(ch => {
        if (ch.type === ChannelType.GuildVoice) {
          if (tempSet.has(ch.id)) tempVoices.push(ch);
          else nonTempVoices.push(ch);
        } else {
          otherChannels.push(ch);
        }
      });
      // If we have a forced channel id (newly created/repurposed), treat it as temp even if not yet in DB
      if (forceLastChannelId) {
        const forced = siblingsAll.find(ch => ch.id === forceLastChannelId && ch.type === ChannelType.GuildVoice);
        if (forced) {
          const idxTemp = tempVoices.findIndex(ch => ch.id === forced.id);
          if (idxTemp === -1) {
            // Remove from nonTemp/others if present, then add to temps
            const idxNon = nonTempVoices.findIndex(ch => ch.id === forced.id);
            if (idxNon !== -1) nonTempVoices.splice(idxNon, 1);
            const idxOther = otherChannels.findIndex(ch => ch.id === forced.id);
            if (idxOther !== -1) otherChannels.splice(idxOther, 1);
            tempVoices.push(forced);
          }
        }
      }
      if (tempVoices.length === 0) return;
      // Force the just-created temp to the very end among temps if specified
      if (forceLastChannelId) {
        const idx = tempVoices.findIndex(ch => ch.id === forceLastChannelId);
        if (idx >= 0) tempVoices.push(tempVoices.splice(idx, 1)[0]);
      }
      // Determine base position: after last non-temp VOICE, but before any non-voice channels
      let basePos = -1;
      if (nonTempVoices.length > 0) {
        const lastVoice = nonTempVoices[nonTempVoices.length - 1];
        basePos = typeof lastVoice.rawPosition === 'number' ? lastVoice.rawPosition : lastVoice.position;
      } else if (otherChannels.length > 0) {
        const firstOther = otherChannels[0];
        basePos = (typeof firstOther.rawPosition === 'number' ? firstOther.rawPosition : firstOther.position) - 1;
      } else {
        const first = siblingsAll.first();
        basePos = (typeof first.rawPosition === 'number' ? first.rawPosition : first.position) - 1;
      }
      // Invisible update: move only temp voice channels to target window; do not touch others
      const lastNonTempVoicePos = nonTempVoices.length > 0
        ? (typeof nonTempVoices[nonTempVoices.length - 1].rawPosition === 'number' ? nonTempVoices[nonTempVoices.length - 1].rawPosition : nonTempVoices[nonTempVoices.length - 1].position)
        : null;
      const firstOtherPos = otherChannels.length > 0
        ? (typeof otherChannels[0].rawPosition === 'number' ? otherChannels[0].rawPosition : otherChannels[0].position)
        : null;
      // Short-circuit: if every temp voice is already after last non-temp voice and before first other, skip
      try {
        if (tempVoices.length > 0) {
          const ok = tempVoices.every((ch, i) => {
            const p = (typeof ch.rawPosition === 'number' ? ch.rawPosition : ch.position) || 0;
            const afterNonTemp = (lastNonTempVoicePos == null) || (p > lastNonTempVoicePos);
            const beforeOther = (firstOtherPos == null) || (p < firstOtherPos);
            const prevOk = i === 0 || (((typeof tempVoices[i-1].rawPosition === 'number' ? tempVoices[i-1].rawPosition : tempVoices[i-1].position) || 0) < p);
            return afterNonTemp && beforeOther && prevOk;
          });
          if (ok) { recentlySorted.set(key, Date.now()); return; }
        }
      } catch {}
      let pos = (lastNonTempVoicePos ?? ((typeof siblingsAll.first().rawPosition === 'number' ? siblingsAll.first().rawPosition : siblingsAll.first().position) - 1));
      const updates = [];
      for (const ch of tempVoices) {
        // Keep temps below other (non-voice) channels if present
        if (firstOtherPos != null && pos + 1 >= firstOtherPos) break;
        pos += 1;
        updates.push({ channel: ch.id, position: pos });
      }
      if (updates.length > 0) {
        try { await guild.channels.setPositions(updates); } catch {}
      }
      recentlySorted.set(key, Date.now());
    } catch {}
  };
  if (delayMs <= 0) run().catch(()=>{});
  else bottomDebounce.set(key, setTimeout(() => run().catch(()=>{}), delayMs));
}

// Lightweight one-shot nudge after creation to help stabilization without spamming
function startBottomWatch(guild, channel, parentId, delayMs = 400) {
  setTimeout(async () => {
    try {
      if (!channel?.guild) return;
      if (channel.parentId !== parentId) return;
      const parentCat = guild.channels.cache.get(parentId);
      if (!parentCat) return;
      // Single nudge to bottom
      await channel.setPosition(9999).catch(() => {});
    } catch {}
  }, delayMs);
}

// Silent refresh: re-apply current positions of siblings to force client UI refresh without visible movement
async function silentCategoryRefresh(guild, parentId) {
  try {
    if (!guild || !parentId) return;
    const siblings = guild.channels.cache
      .filter(c => c && c.parentId === parentId)
      .sort((a,b)=>{
        const pa = typeof a.rawPosition === 'number' ? a.rawPosition : a.position;
        const pb = typeof b.rawPosition === 'number' ? b.rawPosition : b.position;
        return pa - pb;
      });
    if (!siblings.size) return;
    const updates = [];
    siblings.forEach(ch => {
      const pos = (typeof ch.rawPosition === 'number' ? ch.rawPosition : ch.position) || 0;
      updates.push({ channel: ch.id, position: pos });
    });
    // Re-apply identical positions to prompt client refresh without visible changes
    await guild.channels.setPositions(updates).catch(()=>{});
  } catch {}
}

async function getGuildConfigCached(db, guildId) {
  const row = await new Promise((resolve) => {
    db.get(`SELECT lobby_channel_id, banner_url, temp_category_id FROM guild_config WHERE guild_id = ?`, [guildId], (err, r) => {
      if (err) return resolve(null);
      resolve(r || null);
    });
  });
  return row;
}

// Push a voice channel under an anchor (if provided) or to the bottom of a category with retries
async function pushChannelToBottom(guild, channel, parentId, anchorId) {
  const doMove = async () => {
    // Use current cache; avoid heavy fetch loops
    const parentCat = guild.channels.cache.get(parentId);
    if (!parentCat) return;
    if (channel.parentId !== parentId) {
      await channel.setParent(parentId).catch(() => {});
    }
    // Consider ALL siblings (text + voice) because ordering is shared inside a category
    const siblings = guild.channels.cache
      .filter(c => c.parentId === parentId && c.id !== channel.id);
    const maxPos = siblings.size > 0 ? Math.max(...siblings.map(c => (typeof c.rawPosition === 'number' ? c.rawPosition : c.position))) : 0;
    const before = typeof channel.rawPosition === 'number' ? channel.rawPosition : channel.position;
    const targetPos = maxPos + 1;
    await channel.setPosition(targetPos).catch(() => {});
    let afterCh = await guild.channels.fetch(channel.id).catch(() => channel);
    const after = typeof afterCh.rawPosition === 'number' ? afterCh.rawPosition : afterCh.position;
    if (after !== targetPos) {
      // Fallback: force positions using bulk API
      try {
        const updates = [];
        siblings.forEach(sib => {
          const pos = (typeof sib.rawPosition === 'number' ? sib.rawPosition : sib.position) || 0;
          updates.push({ channel: sib.id, position: pos });
        });
        updates.push({ channel: channel.id, position: targetPos });
        await guild.channels.setPositions(updates);
      } catch {}
    }
  };
  // Immediate attempt + one quick retry
  doMove().catch(() => {});
  setTimeout(() => { doMove().catch(() => {}); }, 800);
}

module.exports = (client, db) => {
  // Task tracking: ownerId -> { startTs, channelId }
  if (!client.taskTrackers) client.taskTrackers = new Map();

  async function recomputeTaskForChannel(guild, channelId) {
    if (!channelId) return;
    const row = await new Promise((resolve) => {
      db.get(`SELECT owner_id FROM temp_channels WHERE channel_id = ?`, [channelId], (err, r) => resolve(r || null));
    });
    if (!row) return; // not managed
    const ownerId = row.owner_id;
    const vc = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!vc || vc.type !== ChannelType.GuildVoice) return;
    const owner = guild.members.cache.get(ownerId) || await guild.members.fetch(ownerId).catch(() => null);
    if (!owner) { client.taskTrackers.delete(ownerId); return; }
    const cfg = await new Promise((resolve) => {
      db.get(`SELECT * FROM task_config WHERE guild_id = ?`, [guild.id], (err, r) => resolve(r || null));
    });
    if (!cfg || !cfg.task_enabled) { client.taskTrackers.delete(ownerId); return; }
    const taskRoles = (cfg.task_roles || '').split(',').filter(Boolean);
    const ignoreRoles = (cfg.ignore_roles || '').split(',').filter(Boolean);
    const sameCounts = !!cfg.same_role_counts;

    // Owner must have a task role
    if (taskRoles.length > 0 && !owner.roles.cache.some(r => taskRoles.includes(r.id))) {
      client.taskTrackers.delete(ownerId); return;
    }
    // Count eligible members in channel (excluding owner)
    let eligibleCount = 0;
    for (const [mid, m] of vc.members) {
      if (mid === ownerId) continue;
      if (m.user.bot) continue;
      const hasIgnore = ignoreRoles.length > 0 && m.roles.cache.some(r => ignoreRoles.includes(r.id));
      if (hasIgnore) continue;
      if (!sameCounts && taskRoles.length > 0 && m.roles.cache.some(r => taskRoles.includes(r.id))) continue;
      eligibleCount++;
    }
    const required = Number(cfg.required_member_count || 3);
    if (eligibleCount >= required) {
      // start or keep tracking
      const cur = client.taskTrackers.get(ownerId);
      if (!cur || cur.channelId !== channelId) {
        client.taskTrackers.set(ownerId, { startTs: Date.now(), channelId });
      }
    } else {
      // stop tracking
      client.taskTrackers.delete(ownerId);
    }
  }

  client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
      const guild = newState.guild;
      if (!guild) return;

      const guildId = guild.id;

      // Start a 2s periodic scan for this guild if not already running
      if (!activeGuildIntervals.has(guildId)) {
        const interval = setInterval(async () => {
          try {
            // Scan all temp channels in this guild and delete if owner is absent or channel invalid/empty
            db.all(`SELECT channel_id, owner_id FROM temp_channels WHERE guild_id = ?`, [guildId], async (err, rows) => {
              if (err || !rows) return;
              // Adaptive stop: if there are no temp channels for 5 consecutive rounds, stop the scanner
              if (rows.length === 0) {
                const r = (emptyScanRounds.get(guildId) || 0) + 1;
                emptyScanRounds.set(guildId, r);
                if (r >= 5) {
                  try { clearInterval(interval); } catch {}
                  activeGuildIntervals.delete(guildId);
                  emptyScanRounds.delete(guildId);
                }
                return;
              } else {
                emptyScanRounds.set(guildId, 0);
              }
              for (const row of rows) {
                const vc = guild.channels.cache.get(row.channel_id) || await guild.channels.fetch(row.channel_id).catch(() => null);
                if (!vc) {
                  db.run(`DELETE FROM temp_channels WHERE channel_id = ?`, [row.channel_id]);
                  continue;
                }
                // If channel is empty, let empty cleanup handle in 500ms timer, but also enforce here
                if (vc && vc.members.size === 0) {
                  const delName = vc.name;
                  const parentForSilent = vc.parentId;
                  await vc.delete().catch(() => {});
                  db.run(`DELETE FROM temp_channels WHERE channel_id = ?`, [row.channel_id]);
                  try { if (client.voiceLogger) await client.voiceLogger.logChannelDeleted(guildId, delName, row.owner_id); } catch {}
                  // Silent category refresh (no visible reorder) to clear ghost entries on clients
                  try { if (parentForSilent) await silentCategoryRefresh(guild, parentForSilent); } catch {}
                  continue;
                }
                // If owner not present, just log it but don't delete the channel
                if (!vc.members.has(row.owner_id)) {
                  // Channel stays active - members can use .v claim to become the new owner
                }
              }
              // Additionally, recompute task trackers for any member with task roles in any voice channel
              try {
                const voiceChannels = guild.channels.cache.filter(c => c?.type === ChannelType.GuildVoice);
                for (const vc of voiceChannels.values()) {
                  if (vc.members.size === 0) continue;
                  for (const m of vc.members.values()) {
                    await recomputeTaskForMember(guild, m);
                  }
                }
              } catch {}
              // After each scan, optionally enforce bottom ordering
              if (enforceBottomOnChanges) {
                try { rows.forEach(r => { const ch = guild.channels.cache.get(r.channel_id); if (ch?.parentId) scheduleEnsureBottom(guild, ch.parentId, db); }); } catch {}
              }
            });
          } catch (scanErr) {
            console.error('Periodic owner scan error:', scanErr);
          }
        }, 3000);
        activeGuildIntervals.set(guildId, interval);
      }

      const cleanupEmptyChannels = async () => {
        db.all(`SELECT channel_id FROM temp_channels WHERE guild_id = ?`, [guildId], async (err, rows) => {
          if (err) return console.error(err);
          for (const row of rows) {
            const tempChannel = guild.channels.cache.get(row.channel_id) || await guild.channels.fetch(row.channel_id).catch(() => null);
            if (tempChannel && tempChannel.members.size === 0) {
              // Delay 500ms then re-check before deleting to avoid race conditions
              setTimeout(async () => {
                const ch2 = guild.channels.cache.get(row.channel_id) || await guild.channels.fetch(row.channel_id).catch(() => null);
                if (ch2 && ch2.members.size === 0) {
                  await ch2.delete().catch(() => {});
                  db.run(`DELETE FROM temp_channels WHERE channel_id = ?`, [row.channel_id]);
                }
              }, 500);
            }
          }
        });
      };

      // Clean up empty temporary voice channels
      const cleanupTempChannels = async (channelId) => {
        if (!channelId) return;
        
        // First check if this is a temp channel in our database
        const isTempChannel = await new Promise((resolve) => {
          db.get(`SELECT channel_id FROM temp_channels WHERE channel_id = ?`, [channelId], (err, row) => {
            if (err) return resolve(false);
            resolve(!!row);
          });
        });
        
        // Only proceed if this is a temp channel
        if (!isTempChannel) return;
        
        const vc = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        if (!vc) {
          // Channel doesn't exist, clean up the database
          db.run(`DELETE FROM temp_channels WHERE channel_id = ?`, [channelId]);
          return;
        }
        
        // Only clean up if this is a voice channel and it's empty
        if (vc.type === ChannelType.GuildVoice && vc.members.size === 0) {
          setTimeout(async () => {
            const vc2 = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
            
            // Double check it's still empty and a temp channel
            if (vc2 && vc2.type === ChannelType.GuildVoice && vc2.members.size === 0) {
              // Final check in database to be extra sure
              const stillTemp = await new Promise((resolve) => {
                db.get(`SELECT channel_id FROM temp_channels WHERE channel_id = ?`, [channelId], (err, row) => {
                  if (err) return resolve(false);
                  resolve(!!row);
                });
              });
              
              if (stillTemp) {
                // Get channel info for logging before deletion
                const channelInfo = await new Promise((resolve) => {
                  db.get(`SELECT owner_id, base_name FROM temp_channels WHERE channel_id = ?`, [channelId], (err, row) => {
                    if (err) return resolve(null);
                    resolve(row);
                  });
                });
                
                // Log channel deletion
                if (client.voiceLogger && channelInfo) {
                  await client.voiceLogger.logChannelDeleted(guildId, vc2.name, channelInfo.owner_id);
                }
                
                // Safely delete channel; ignore Unknown Channel (10003)
                try {
                  await vc2.delete();
                } catch (err) {
                  if (err?.code !== 10003) console.error(err);
                }
                db.run(`DELETE FROM temp_channels WHERE channel_id = ?`, [channelId]);
                // Refresh after channel deletion may affect ownership mapping
                if (client.refreshVoiceLeaderboard) client.refreshVoiceLeaderboard(guildId);
                // Silent category refresh to nudge clients without visible changes
                try { if (vc2?.parentId) await silentCategoryRefresh(guild, vc2.parentId); } catch {}
                
                // Clean up associated text channel if it exists
                const textChannel = guild.channels.cache.find(c => 
                  c.type === ChannelType.GuildText && 
                  c.name === `vc-${vc2.name.toLowerCase().replace(/\s+/g, '-')}`
                );
                if (textChannel) {
                  try {
                    await textChannel.delete();
                  } catch (err) {
                    if (err?.code !== 10003) console.error(err);
                  }
                }
              }
            }
          }, 1000);
        }
      };

      // ===== Lifetime stats updates (owner presence and member joins) =====
      const isEligible = (state, ownerId, chId) => {
        return !!state && state.member?.id === ownerId && state.channelId === chId && !state.selfDeaf && !state.serverMute;
      };
      const getPPM = async (gid) => {
        try {
          const row = await new Promise((resolve)=>{
            db.get(`SELECT voice_points_per_minute FROM guild_config WHERE guild_id = ?`, [gid], (e, r)=>resolve(r||null));
          });
          const v = Number(row?.voice_points_per_minute);
          return Number.isFinite(v) && v > 0 ? v : 10;
        } catch { return 10; }
      };

      const settlePoints = async (guildId, channelId) => {
        if (!channelId) return;
        const meta = await new Promise((resolve)=>{
          db.get(`SELECT owner_id, owner_points_since_ms FROM temp_channels WHERE channel_id = ?`, [channelId], (e, r)=>resolve(r||null));
        });
        if (!meta || !meta.owner_points_since_ms) return;
        const now = Date.now();
        const delta = Math.max(0, now - Number(meta.owner_points_since_ms));
        const fullMin = Math.floor(delta / 60000);
        if (fullMin > 0) {
          const rate = await getPPM(guildId);
          const addPts = Math.round(fullMin * rate);
          await dbRunP(db,
            `INSERT INTO voice_points (guild_id, owner_id, points)
             VALUES (?, ?, ?)
             ON CONFLICT(guild_id, owner_id) DO UPDATE SET points = points + excluded.points`,
            [guildId, meta.owner_id, addPts]
          );
        }
        // Clear accrual marker (we pause; remainder seconds are discarded for simplicity)
        await dbRunP(db, `UPDATE temp_channels SET owner_points_since_ms = NULL WHERE channel_id = ?`, [channelId]);
        if (client.refreshVoiceLeaderboard) client.refreshVoiceLeaderboard(guildId);
      };

      // Per-user points helpers
      const settleUserPoints = async (guildId, userId, removeRow = true) => {
        if (!guildId || !userId) return;
        const row = await new Promise((resolve)=>{
          db.get(`SELECT since_ms FROM temp_user_points WHERE guild_id = ? AND user_id = ?`, [guildId, userId], (e, r)=>resolve(r||null));
        });
        if (!row || !row.since_ms) return;
        const start = Number(row.since_ms) || 0;
        const now = Date.now();
        const delta = Math.max(0, now - start);
        const fullMin = Math.floor(delta / 60000);
        if (fullMin > 0) {
          const rate = await getPPM(guildId);
          const addPts = Math.round(fullMin * rate);
          await dbRunP(db,
            `INSERT INTO voice_points_users (guild_id, user_id, points)
             VALUES (?, ?, ?)
             ON CONFLICT(guild_id, user_id) DO UPDATE SET points = points + excluded.points`,
            [guildId, userId, addPts]
          );
        }
        if (removeRow) {
          await dbRunP(db, `DELETE FROM temp_user_points WHERE guild_id = ? AND user_id = ?`, [guildId, userId]);
        } else {
          // advance marker to keep remainder seconds
          const advance = start + Math.floor((now - start) / 60000) * 60000;
          await dbRunP(db, `UPDATE temp_user_points SET since_ms = ? WHERE guild_id = ? AND user_id = ?`, [advance, guildId, userId]);
        }
        if (client.refreshVoiceLeaderboard) client.refreshVoiceLeaderboard(guildId);
      };
      const startUserPoints = async (guildId, userId, channelId) => {
        if (!guildId || !userId || !channelId) return;
        await dbRunP(db, `INSERT INTO temp_user_points (guild_id, user_id, channel_id, since_ms) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET channel_id = excluded.channel_id, since_ms = excluded.since_ms`, [guildId, userId, channelId, Date.now()]);
        if (client.ensurePointsTicker) client.ensurePointsTicker(guildId);
        if (client.refreshVoiceLeaderboard) client.refreshVoiceLeaderboard(guildId);
      };
      // Owner join: mark presence start only on real join/move (channel change)
      if (newState.channelId && newState.channelId !== oldState.channelId) {
        const row = await new Promise((resolve)=>{
          db.get(`SELECT owner_id FROM temp_channels WHERE channel_id = ?`, [newState.channelId], (e, r)=>resolve(r||null));
        });
        if (row) {
          // Increment unique members on human non-owner first join per owner
          if (newState.member && !newState.member.user?.bot && newState.member.id !== row.owner_id) {
            db.run(
              `INSERT OR IGNORE INTO voice_member_visits (guild_id, owner_id, user_id) VALUES (?, ?, ?)`,
              [guildId, row.owner_id, newState.member.id],
              (err) => {
                if (!err) {
                  db.run(
                    `INSERT INTO voice_stats (guild_id, owner_id, created_count, total_time_ms, total_members_accum)
                     VALUES (?, ?, 0, 0, 1)
                     ON CONFLICT(guild_id, owner_id) DO UPDATE SET total_members_accum = total_members_accum + 1`,
                    [guildId, row.owner_id]
                  );
                  // Refresh leaderboard after unique visit increases members count
                  if (client.refreshVoiceLeaderboard) client.refreshVoiceLeaderboard(guildId);
                }
              }
            );
          }
          // Owner present mark: force reset on join/move into this channel to avoid stale markers
          if (newState.member?.id === row.owner_id) {
            const nowMs = Date.now();
            // Presence start
            await dbRunP(db, `UPDATE temp_channels SET owner_present_since = datetime('now'), owner_present_since_ms = ? WHERE channel_id = ?`, [nowMs, newState.channelId]);
            // Points accrual start only if eligible (not selfDeaf and not serverMute)
            if (isEligible(newState, row.owner_id, newState.channelId)) {
              await dbRunP(db, `UPDATE temp_channels SET owner_points_since_ms = ? WHERE channel_id = ?`, [nowMs, newState.channelId]);
              if (client.ensurePointsTicker) client.ensurePointsTicker(guildId);
            } else {
              await dbRunP(db, `UPDATE temp_channels SET owner_points_since_ms = NULL WHERE channel_id = ?`, [newState.channelId]);
            }
            // Refresh to reflect live session start
            if (client.refreshVoiceLeaderboard) client.refreshVoiceLeaderboard(guildId);
          }

          // Per-user accrual start on eligible join for anyone (owner or not)
          const mem = newState.member;
          if (mem) {
            const eligible = !mem.user.bot && !mem.voice?.selfDeaf && !mem.voice?.selfMute && !mem.voice?.serverMute && !mem.voice?.serverDeaf;
            if (eligible) await startUserPoints(guildId, mem.id, newState.channelId);
            else await dbRunP(db, `DELETE FROM temp_user_points WHERE guild_id = ? AND user_id = ?`, [guildId, mem.id]);
          }
        }
      }
      // Owner leave or move away: accumulate time since owner_present_since
      if (oldState.channelId && (!newState.channelId || newState.channelId !== oldState.channelId)) {
        const meta = await new Promise((resolve)=>{
          db.get(`SELECT owner_id, owner_present_since, owner_present_since_ms FROM temp_channels WHERE channel_id = ?`, [oldState.channelId], (e, r)=>resolve(r||null));
        });
        if (meta && meta.owner_id === oldState.member?.id && (meta.owner_present_since_ms || meta.owner_present_since)) {
          // Compute elapsed in ms between owner_present_since and now
          const start = typeof meta.owner_present_since_ms === 'number' && meta.owner_present_since_ms > 0
            ? meta.owner_present_since_ms
            : Date.parse(String(meta.owner_present_since).replace(' ', 'T') + 'Z');
          const nowMs = Date.now();
          const delta = Math.max(0, isNaN(start) ? 0 : (nowMs - start));
          if (delta > 0) {
            await dbRunP(db,
              `INSERT INTO voice_stats (guild_id, owner_id, created_count, total_time_ms, total_members_accum)
               VALUES (?, ?, 0, ?, 0)
               ON CONFLICT(guild_id, owner_id) DO UPDATE SET total_time_ms = total_time_ms + excluded.total_time_ms`,
              [guildId, meta.owner_id, delta]
            );
          }
          // Clear presence marker
          await dbRunP(db, `UPDATE temp_channels SET owner_present_since = NULL, owner_present_since_ms = NULL WHERE channel_id = ?`, [oldState.channelId]);
          // Settle points accrual and clear
          await settlePoints(guildId, oldState.channelId);
          // Refresh to reflect session end
          if (client.refreshVoiceLeaderboard) client.refreshVoiceLeaderboard(guildId);
        }
        // Per-user settle when leaving a temp channel
        const wasTemp = await new Promise((resolve)=>{
          db.get(`SELECT 1 FROM temp_channels WHERE channel_id = ?`, [oldState.channelId], (e, r)=>resolve(!!r));
        });
        if (wasTemp && oldState.member) await settleUserPoints(guildId, oldState.member.id, true);
      }

      // Eligibility toggle inside same channel (mute/deaf changes)
      if (oldState.channelId && newState.channelId && oldState.channelId === newState.channelId) {
        // Is this channel a temp channel and owned by this member?
        const row = await new Promise((resolve)=>{
          db.get(`SELECT owner_id FROM temp_channels WHERE channel_id = ?`, [newState.channelId], (e, r)=>resolve(r||null));
        });
        if (row && row.owner_id === newState.member?.id) {
          const wasEligible = isEligible(oldState, row.owner_id, newState.channelId);
          const nowEligible = isEligible(newState, row.owner_id, newState.channelId);
          if (wasEligible && !nowEligible) {
            // Pause accrual: settle and clear
            await settlePoints(guildId, newState.channelId);
          } else if (!wasEligible && nowEligible) {
            // Resume accrual from now
            await dbRunP(db, `UPDATE temp_channels SET owner_points_since_ms = ? WHERE channel_id = ?`, [Date.now(), newState.channelId]);
            if (client.ensurePointsTicker) client.ensurePointsTicker(guildId);
            if (client.refreshVoiceLeaderboard) client.refreshVoiceLeaderboard(guildId);
          }
        }
      }

      if (oldState.channelId && !newState.channelId) cleanupEmptyChannels();
      // Check both channels for temp channel cleanup
      await cleanupTempChannels(oldState.channelId);
      await cleanupTempChannels(newState.channelId);
      // Finally, recompute task state for the channel that changed (if managed) and for involved members generically
      try {
        if (oldState?.channelId) await recomputeTaskForChannel(guild, oldState.channelId);
        if (newState?.channelId) await recomputeTaskForChannel(guild, newState.channelId);
      } catch {}
      try {
        if (oldState?.member) await recomputeTaskForMember(guild, oldState.member);
        if (newState?.member) await recomputeTaskForMember(guild, newState.member);
      } catch {}

      const config = await getGuildConfigCached(db, guildId);
      if (!config?.lobby_channel_id) {
        try { console.warn(`[tempVoice] guild ${guildId}: lobby_channel_id missing; skip creation.`); } catch {}
        return;
      }
      const lobbyId = config.lobby_channel_id;

      // --- Enforce owner blacklist when someone joins a temp channel ---
      if (newState.channelId) {
        // ... (rest of the code remains the same)
        const joinedChannelId = newState.channelId;
        const tempRow = await new Promise((resolve) => {
          db.get(`SELECT owner_id FROM temp_channels WHERE channel_id = ?`, [joinedChannelId], (err, row) => {
            if (err) return resolve(null);
            resolve(row || null);
          });
        });
        if (tempRow && tempRow.owner_id && newState.member?.id !== tempRow.owner_id) {
          const isBlacklisted = await new Promise((resolve) => {
            db.get(`SELECT 1 FROM user_blacklists WHERE owner_id = ? AND user_id = ?`, [tempRow.owner_id, newState.member.id], (err, row) => {
              if (err) return resolve(false);
              resolve(!!row);
            });
          });
          if (isBlacklisted) {
            // DM warn via Embed (reliable in DMs)
            try {
              const embed = new EmbedBuilder()
                .setColor('Red')
                .setDescription('🚫 You are blacklisted by the owner of this voice channel and cannot join.');
              await newState.member.send({ embeds: [embed] });
            } catch {}
            // Move to lobby if possible, otherwise disconnect
            const lobby = guild.channels.cache.get(lobbyId) || await guild.channels.fetch(lobbyId).catch(() => null);
            try {
              if (lobby && newState.member.voice?.channelId === joinedChannelId) {
                await newState.member.voice.setChannel(lobby).catch(() => {});
              }
              if (!lobby && newState.member.voice?.channelId === joinedChannelId) {
                await newState.member.voice.setChannel(null).catch(() => {});
              }
            } catch {}
            return;
          }
        }
      }

        // --- Create temp channel when user joins lobby ---
        if (newState.channelId === lobbyId) {
          const member = newState.member;
          if (!member?.voice?.channelId || member.voice.channelId !== lobbyId) return;

          try {
            const blocked = await new Promise((resolve) => {
              db.run(`CREATE TABLE IF NOT EXISTS dontuse_users (guild_id TEXT, user_id TEXT, PRIMARY KEY (guild_id, user_id))`, [], () => {
                db.get(`SELECT 1 FROM dontuse_users WHERE guild_id = ? AND user_id = ?`, [guildId, member.id], (err, row) => {
                  if (err) return resolve(false);
                  resolve(!!row);
                });
              });
            });
            if (blocked) {
              return;
            }
          } catch {}

          // --- Global guild cooldown check ---
          const gUntil = guildCooldownUntil.get(guildId) || 0;
          if (Date.now() < gUntil) {
            const remain = Math.max(0, gUntil - Date.now());
            const ctn = new ContainerBuilder()
              .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Cooldown\n⏳ Please wait, channel creation is temporarily on cooldown for this server.\nRemaining: ${formatSecs(remain)}`))
              .addSeparatorComponents(new SeparatorBuilder())
              .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('help_ep_cat_voice').setLabel('Help Bot').setStyle(ButtonStyle.Secondary).setDisabled(true)));
            try {
              await member.send({ components: [ctn], flags: MessageFlags.IsComponentsV2 }).catch(async () => {
                await member.send(`⏳ Please wait, channel creation is temporarily on cooldown for this server. Remaining: ${formatSecs(remain)}`).catch(()=>{});
              });
            } catch {}
            return;
          }

          // If a creation is in progress for this user, skip to prevent duplicates
          const now = Date.now();
          const prev = creationLocks.get(member.id) || 0;
          if (now - prev < 3000) return; // tighter window to feel more responsive while preventing dupes
          creationLocks.set(member.id, now);

          // Double-check dontuse immediately after locking to avoid race conditions
          try {
            const blocked2 = await new Promise((resolve) => {
              db.run(`CREATE TABLE IF NOT EXISTS dontuse_users (guild_id TEXT, user_id TEXT, PRIMARY KEY (guild_id, user_id))`, [], () => {
                db.get(`SELECT 1 FROM dontuse_users WHERE guild_id = ? AND user_id = ?`, [guildId, member.id], (err, row) => {
                  if (err) return resolve(false);
                  resolve(!!row);
                });
              });
            });
            if (blocked2) {
              creationLocks.delete(member.id);
              return;
            }
          } catch { creationLocks.delete(member.id); return; }

          // --- Per-user 30s retry triggers a 60s guild cooldown ---
          const k = `${guildId}:${member.id}`;
          const last = userLastCreate.get(k) || 0;

          const containerCoolDown = new ContainerBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Cooldown\n⏳ Please wait, channel creation is temporarily on cooldown for this server.\nRemaining: ${formatSecs(60000)}`))
          .addSeparatorComponents(new SeparatorBuilder())
          .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('help_ep_cat_voice').setLabel('Help Bot').setStyle(ButtonStyle.Secondary).setDisabled(true)));

          if (last && (now - last) < 5000) {
            const coolMs = 5000; // adjust to 5000 if you want 5s
            guildCooldownUntil.set(guildId, now + coolMs);
            setTimeout(() => guildCooldownUntil.delete(guildId), coolMs);
            try {
              const remain = Math.max(0, (guildCooldownUntil.get(guildId) || (now+coolMs)) - Date.now());
              const ctnDyn = new ContainerBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Cooldown\n⚠️ You tried to create a channel again too soon. A cooldown has been applied to the server.\nRemaining: ${formatSecs(remain)}`))
                .addSeparatorComponents(new SeparatorBuilder())
                .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('help_ep_cat_voice').setLabel('Help Bot').setStyle(ButtonStyle.Secondary).setDisabled(true)));
              await member.send({ components: [ctnDyn], flags: MessageFlags.IsComponentsV2 }).catch(async () => {
                await member.send(`Cooldown active. Remaining: ${formatSecs(remain)}`).catch(()=>{});
              });
            } catch {}
            return;
          }

          // If user already owns an active temp channel, do not create another
          const existing = await new Promise((resolve) => {
            db.get(`SELECT channel_id FROM temp_channels WHERE guild_id = ? AND owner_id = ?`, [guildId, member.id], (err, row) => {
              if (err) return resolve(null);
              resolve(row || null);
            });
          });
          if (existing?.channel_id) {
            const existingCh = guild.channels.cache.get(existing.channel_id) || await guild.channels.fetch(existing.channel_id).catch(() => null);
            if (existingCh) {
              // If channel is empty, clean it up and proceed to create a new one
              if (existingCh.members.size === 0) {
                try { await existingCh.delete(); } catch {}
                db.run(`DELETE FROM temp_channels WHERE channel_id = ?`, [existing.channel_id]);
              } else if (existingCh.members.has(member.id)) {
                // Only move back if the owner is already in that channel (rare race)
                await member.voice.setChannel(existingCh).catch(() => {});
                return;
              }
              // If owner is not in that channel and others are there, allow creating a new one
            } else {
              // Channel not found, clean dangling DB row
              db.run(`DELETE FROM temp_channels WHERE channel_id = ?`, [existing.channel_id]);
            }
          }

          // Get lobby channel only if silent flow may run
          const lobbyChannel = (!FORCE_FRESH_CREATION)
            ? (guild.channels.cache.get(lobbyId) || await guild.channels.fetch(lobbyId).catch(() => null))
            : null;
          
          // Copy all settings from the lobby channel
          const channelOptions = {
            name: `${member.displayName}'s Room`,
            type: ChannelType.GuildVoice,
            parent: config?.temp_category_id || newState.channel?.parentId || null,
          };

          // Silent duplicate flow: clone lobby to be the new lobby, repurpose original as user's temp (no member move => no sound)
          let channel = null;
          const cloneLocked = lobbyCloneLocks.get(guildId);
          if (!FORCE_FRESH_CREATION && !cloneLocked && lobbyChannel && typeof lobbyChannel.clone === 'function') {
            lobbyCloneLocks.set(guildId, true);
            try {
              const originalParentId = lobbyChannel.parentId || null;
              const originalName = lobbyChannel.name;
              const newLobby = await lobbyChannel.clone({ reason: `Create new lobby (silent) for ${member.user.tag}` });
              // Match the new lobby with the original
              if (originalParentId && newLobby.parentId !== originalParentId) {
                await newLobby.setParent(originalParentId).catch(() => {});
              }
              if (newLobby.name !== originalName) {
                await newLobby.setName(originalName).catch(() => {});
              }
              // Update DB to point to the new lobby
              await dbRunP(db, `UPDATE guild_config SET lobby_channel_id = ? WHERE guild_id = ?`, [newLobby.id, guildId]);
              // Repurpose original lobby as the user's temp channel
              channel = lobbyChannel;
              const desiredParentId = (config?.temp_category_id) || originalParentId || channel.parentId;
              const desiredParent = desiredParentId ? (guild.channels.cache.get(desiredParentId) || await guild.channels.fetch(desiredParentId).catch(()=>null)) : null;
              if (desiredParent && channel.parentId !== desiredParent.id) {
                await channel.setParent(desiredParent.id, { lockPermissions: false }).catch(() => {});
              }
              // Sync permissions with parent category to inherit its overwrites
              try { await channel.lockPermissions(); } catch {}
              if (channel.name !== `${member.displayName}'s Room`) {
                await channel.setName(`${member.displayName}'s Room`).catch(() => {});
              }
              // Immediate invisible precise nudge: place just after last non-temp voice under same parent
              try {
                const parentId = channel.parentId;
                if (parentId) {
                  const siblings = guild.channels.cache
                    .filter(c => c.parentId === parentId)
                    .sort((a, b) => ((typeof a.rawPosition === 'number' ? a.rawPosition : a.position) - (typeof b.rawPosition === 'number' ? b.rawPosition : b.position)));
                  const nonTempVoices = [];
                  const otherChannels = [];
                  siblings.forEach(ch => {
                    if (ch.type === ChannelType.GuildVoice && ch.id !== channel.id) nonTempVoices.push(ch);
                    else if (ch.id !== channel.id) otherChannels.push(ch);
                  });
                  const lastVoice = nonTempVoices.length > 0 ? nonTempVoices[nonTempVoices.length - 1] : null;
                  const base = lastVoice ? (typeof lastVoice.rawPosition === 'number' ? lastVoice.rawPosition : lastVoice.position) : (((typeof siblings.first().rawPosition === 'number' ? siblings.first().rawPosition : siblings.first().position) || 0) - 1);
                  const firstOther = otherChannels[0];
                  const limit = firstOther ? ((typeof firstOther.rawPosition === 'number' ? firstOther.rawPosition : firstOther.position) - 1) : (base + 1);
                  const target = Math.min(base + 1, limit);
                  await guild.channels.setPositions([{ channel: channel.id, position: target }]).catch(() => {});
                }
              } catch {}
              // Ensure no user limit in the repurposed temp channel
              try { await channel.setUserLimit(0); } catch {}
              // Silently push to bottom under the target parent (immediate + follow-up)

              try {
                if (channel.parentId) {
                  scheduleEnsureBottom(guild, channel.parentId, db, 0, channel.id, true);
                  setTimeout(() => { try { scheduleEnsureBottom(guild, channel.parentId, db, 0, channel.id, true); } catch {} }, 300);
                }
              } catch {}
              // Do not move the member (they remain in this channel), so no sound
            } catch (e) {
              channel = null;
            } finally {
              lobbyCloneLocks.delete(guildId);
            }
          }

          // Fast path: reuse standby (disabled by config)
          if (ENABLE_STANDBY && !channel) {
            try {
              const parentId = channelOptions.parent || newState.channel?.parentId || null;
              if (parentId) {
                const standby = guild.channels.cache.find(c => c && c.type === ChannelType.GuildVoice && c.parentId === parentId && c.members.size === 0 && /^Standby\s•/i.test(c.name));
                if (standby) {
                  channel = standby;
                  channel.setName(channelOptions.name).catch(() => {});
                }
              }
            } catch {}
          }

          // Always create a fresh channel (mode B) if silent flow disabled or failed
          if (!channel) {
            // Ensure bot has permission to create channels
            try {
              const me = guild.members.me;
              const canManage = me?.permissions?.has?.(require('discord.js').PermissionsBitField.Flags.ManageChannels);
              if (!canManage) {
                try { console.warn(`[tempVoice] guild ${guildId}: missing ManageChannels; cannot create channel.`); } catch {}
                creationLocks.delete(member.id);
                return;
              }
            } catch {}
            try {
              // Validate parent category before create
              if (channelOptions.parent && !(guild.channels.cache.get(channelOptions.parent))) {
                delete channelOptions.parent;
              }
              channel = await guild.channels.create(channelOptions).catch((err) => { try { console.warn('[tempVoice] create error:', err?.code || err?.message || err); } catch {} return null; });
            } catch (e) { try { console.warn('[tempVoice] create threw:', e?.code || e?.message || e); } catch {} channel = null; }
          }

          if (!channel) { creationLocks.delete(member.id); return; }

          // No extra adjustments; rely on defaults (inherits parent perms; unlimited users by default)
          // No per-channel setPosition to avoid fights; bulk ordering already scheduled

          // Move member into the newly created channel
          if (channel.id !== lobbyId) {
            await member.voice.setChannel(channel).then(async () => {
              // Start per-user points immediately after successful move (fast path)
              try {
                const vs = member.voice;
                const eligible = vs?.channelId === channel.id && !vs?.selfDeaf && !vs?.selfMute && !vs?.serverMute && !vs?.serverDeaf;
                if (eligible) {
                  await dbRunP(db, `INSERT INTO temp_user_points (guild_id, user_id, channel_id, since_ms) VALUES (?, ?, ?, ?)
                                    ON CONFLICT(guild_id, user_id) DO UPDATE SET channel_id = excluded.channel_id, since_ms = excluded.since_ms`,
                                    [guildId, member.id, channel.id, Date.now()]);
                  if (client.ensurePointsTicker) client.ensurePointsTicker(guildId);
                }
              } catch {}
            }).catch(async () => {
              setTimeout(async () => {
                await channel.delete().catch(() => {});
                db.run(`DELETE FROM temp_channels WHERE channel_id = ?`, [channel.id]);
              }, 3000);
            });
          }

          // Save temp channel meta (await to ensure visible to scheduler)
          await dbRunP(
            db,
            `INSERT INTO temp_channels (channel_id, guild_id, owner_id, base_name, locked, created_at, owner_present_since, owner_present_since_ms)
             VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, datetime('now'), ?)
             ON CONFLICT(channel_id) DO UPDATE SET
               guild_id = excluded.guild_id,
               owner_id = excluded.owner_id,
               base_name = excluded.base_name`,
            [channel.id, guildId, member.id, `${member.displayName}'s Room`, Date.now()]
          );
          // Set a default voice channel status to the server name in bold (owner can change later via .v status)
          try {
            const vcStatus = new VibeSync(client);
            const safeGuildName = (guild?.name || '').replace(/@/g, '@\u200B');
            const boldName = safeGuildName ? `**${safeGuildName}**` : '';
            if (boldName) await vcStatus.setVoiceStatus(channel.id, boldName);
          } catch {}
          // Optional: enforce bottom once (disabled for speed testing)
          try { if (ENABLE_POST_SORT && channel.parentId) scheduleEnsureBottom(guild, channel.parentId, db, 0, channel.id, true); } catch {}

          // Ensure standby (disabled by config)
          if (ENABLE_STANDBY) {
            (async () => {
              try {
                const lobbyParent = lobbyId ? (guild.channels.cache.get(lobbyId)?.parentId || null) : null;
                const parentId = channel.parentId || (config?.temp_category_id) || newState.channel?.parentId || lobbyParent || null;
                if (standbyEnsuring.has(guildId)) return;
                const hasStandby = parentId
                  ? guild.channels.cache.some(c => c && c.type === ChannelType.GuildVoice && c.parentId === parentId && c.members.size === 0 && /^Standby/i.test(c.name))
                  : guild.channels.cache.some(c => c && c.type === ChannelType.GuildVoice && c.members.size === 0 && /^Standby/i.test(c.name));
                if (hasStandby) return;
                standbyEnsuring.add(guildId);
                try {
                  const standbyName = 'Standby • 1';
                  const exists = parentId
                    ? guild.channels.cache.some(c => c && c.type === ChannelType.GuildVoice && c.parentId === parentId && /^Standby/i.test(c.name))
                    : guild.channels.cache.some(c => c && c.type === ChannelType.GuildVoice && /^Standby/i.test(c.name));
                  if (!exists) {
                    try {
                      if (parentId) await guild.channels.create({ name: standbyName, type: ChannelType.GuildVoice, parent: parentId });
                      else await guild.channels.create({ name: standbyName, type: ChannelType.GuildVoice });
                    } catch {
                      try { await guild.channels.create({ name: standbyName, type: ChannelType.GuildVoice }); } catch {}
                    }
                  }
                } finally {
                  standbyEnsuring.delete(guildId);
                }
              } catch {}
            })();
          }
          // Immediately start per-user points for owner if eligible
          try {
            const vs = member.voice;
            const eligible = vs?.channelId === channel.id && !vs?.selfDeaf && !vs?.selfMute && !vs?.serverMute && !vs?.serverDeaf;
            if (eligible) {
              await dbRunP(db, `INSERT INTO temp_user_points (guild_id, user_id, channel_id, since_ms) VALUES (?, ?, ?, ?)
                                ON CONFLICT(guild_id, user_id) DO UPDATE SET channel_id = excluded.channel_id, since_ms = excluded.since_ms`,
                                [guildId, member.id, channel.id, Date.now()]);
              if (client.ensurePointsTicker) client.ensurePointsTicker(guildId);
              if (client.refreshVoiceLeaderboard) client.refreshVoiceLeaderboard(guildId);
            }
          } catch {}
          // Lifetime stats: increment created_count for owner
          db.run(
            `INSERT INTO voice_stats (guild_id, owner_id, created_count, total_time_ms, total_members_accum)
             VALUES (?, ?, 1, 0, 0)
             ON CONFLICT(guild_id, owner_id) DO UPDATE SET created_count = created_count + 1`,
            [guildId, member.id]
          );
          // Refresh to reflect incremented created_count
          if (client.refreshVoiceLeaderboard) client.refreshVoiceLeaderboard(guildId);
          // --- Build Control Panel via themes ASAP ---
          const headerText = `<:axlboba:1456990939146092669> **${guild.name}**`;
          const mentionText = `# Owner: <@${member.id}>`;
          const bodyText = [
            `> <a:arrowr:1440836463733244014> Hi, I'm v!cky. I'll be your assistant in managing your voice channel efficiently. I hope I can live up to your expectations. If you need help with anything, you can contact the developer <@1536781748807934003>`,
          ].join('\n\n');

          const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vc_lock').setEmoji('<:lock:1426154813661384738>').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('vc_unlock').setEmoji('<:unlock:1426154811627143319>').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('vc_claim').setEmoji('<:king:1426154808917757983>').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('vc_limit').setEmoji('<:speedometer:1426154806744973425>').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('vc_kickall').setEmoji('<:kick:1426154804912328704>').setStyle(ButtonStyle.Secondary)
          );

          const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vc_add_user').setEmoji('<:user:1426154799681765446>').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('vc_remove_user').setEmoji('<:deleteuser:1426154802148147230>').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('vc_clear_chat').setEmoji('<:trash:1426154797559447677>').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('vc_rename').setEmoji('<:videoeditor:1426154795970068531>').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('help_category_general').setEmoji('<:setting:1426154794283958343>').setStyle(ButtonStyle.Secondary)
          );

          const PowedByghost = process.env.POWED_GHOST || 'https://discord.com/users/1536781748807934003';
          const LinkButton = new ButtonBuilder().setLabel('Powed By Ghost').setStyle(ButtonStyle.Link).setURL(PowedByghost);
          const Button = new ActionRowBuilder().addComponents(LinkButton);

          // Fetch style and send control panel first to reduce perceived lag
          const style = await new Promise((resolve) => {
            db.get('SELECT control_panel_style FROM guild_config WHERE guild_id = ?', [guildId], (err, row) => {
              resolve(row?.control_panel_style || null);
            });
          });

          if (!style) {
            sendV2(channel, [
              '# ❌ Control panel style not set',
              'Use .v setup and choose Style 1/2/3 to enable the control panel.'
            ], { inside: false }).catch(() => {});
          } else {
            sendControlPanel(guild, channel, member, [row1, row2, Button], {
              style,
              bannerUrl: config?.banner_url,
              headerText,
              mentionText,
              bodyText,
            }).catch(() => {});
          }

          // Log channel creation (non-critical)
          if (client.voiceLogger) {
            client.voiceLogger.logChannelCreated(guildId, channel, member).catch(() => {});
          }

          // Apply whitelist/blacklist permissions in background to avoid blocking UI
          ;(async () => {
            try {
              const whitelistRows = await new Promise((resolve) => {
                db.all(`SELECT user_id FROM user_whitelists WHERE owner_id = ?`, [member.id], (err, rows) => {
                  if (err) return resolve([]);
                  resolve(rows || []);
                });
              });
              const blacklistRows = await new Promise((resolve) => {
                db.all(`SELECT user_id FROM user_blacklists WHERE owner_id = ?`, [member.id], (err, rows) => {
                  if (err) return resolve([]);
                  resolve(rows || []);
                });
              });
              const blacklistSet = new Set(blacklistRows.map(r => r.user_id));
              for (const row of whitelistRows) {
                const user = guild.members.cache.get(row.user_id) || await guild.members.fetch(row.user_id).catch(() => null);
                if (!user) continue;
                await channel.permissionOverwrites.edit(user, {
                  Connect: !blacklistSet.has(user.id),
                  Speak: !blacklistSet.has(user.id),
                  ViewChannel: true
                }).catch(() => {});
              }
              for (const blackUserId of blacklistSet) {
                if (!whitelistRows.find(w => w.user_id === blackUserId)) {
                  const user = guild.members.cache.get(blackUserId) || await guild.members.fetch(blackUserId).catch(() => null);
                  if (!user) continue;
                  await channel.permissionOverwrites.edit(user, { Connect: false, Speak: false, ViewChannel: true }).catch(() => {});
                }
              }
            } catch {}
          })();

          // Release lock after short delay to absorb duplicate events
          setTimeout(() => creationLocks.delete(member.id), 3000);
          // Record last creation timestamp for per-user check (30s window)
          userLastCreate.set(`${guildId}:${member.id}`, Date.now());
        }

    } catch (e) {
      console.error('Error in voiceStateUpdate handler:', e);
    }
  });

  // One-time global watchers to keep temp channels at bottom when category members change
  if (!channelUpdateWatcherInstalled) {
    channelUpdateWatcherInstalled = true;
    client.on('channelCreate', (ch) => {
      try {
        if (!enforceBottomOnChanges) return; // respect manual ordering after creation
        if (ch?.guild && ch.parentId) scheduleEnsureBottom(ch.guild, ch.parentId, db);
      } catch {}
    });
    client.on('channelDelete', (ch) => {
      try {
        if (!enforceBottomOnChanges) return; // do not reorder on deletes if disabled
        if (ch?.guild && ch.parentId) scheduleEnsureBottom(ch.guild, ch.parentId, db);
      } catch {}
    });
    client.on('channelUpdate', (oldCh, newCh) => {
      try {
        if (!newCh?.guild) return;
        if (!enforceBottomOnChanges) return; // never auto-resort on manual updates if disabled
        if (oldCh?.parentId === newCh?.parentId) {
          scheduleEnsureBottom(newCh.guild, newCh.parentId, db);
        } else {
          if (oldCh?.parentId) scheduleEnsureBottom(newCh.guild, oldCh.parentId, db);
          if (newCh?.parentId) scheduleEnsureBottom(newCh.guild, newCh.parentId, db);
        }
      } catch {}
    });
  }
};
