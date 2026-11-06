'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType,
} = require('@discordjs/voice');

const PREFIX = '!';
const MAX_QUEUE = Math.max(1, Number(process.env.MAX_QUEUE || 50));
const YTDLP_PATH = process.env.YTDLP_PATH || (process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const YTDLP_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 30_000;

function readTokens() {
  const fromEnv = process.env.TOKENS || process.env.DISCORD_TOKENS || process.env.DISCORD_TOKEN;
  let rows = [];

  if (fromEnv) {
    rows = fromEnv.split(/[\r\n,;]+/g);
  } else {
    const tokenFile = path.join(__dirname, 'tokens.txt');
    if (!fs.existsSync(tokenFile)) {
      throw new Error('ما لقيت tokens.txt. انسخ tokens.txt.example وسمّه tokens.txt وحط التوكنات داخله.');
    }
    rows = fs.readFileSync(tokenFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/g);
  }

  const tokens = [...new Set(rows.map((line) => line.trim()).filter((line) => line && !line.startsWith('#')))];
  if (!tokens.length) throw new Error('ما فيه توكنات. حط كل توكن في سطر داخل tokens.txt أو عيّن TOKENS.');
  return tokens;
}

const bots = [];
const claimedMessages = new Set();
const startLocks = new Set();

function log(bot, message) {
  const prefix = bot?.client?.user?.tag || bot?.label || 'MusicBot';
  console.log(`[${new Date().toISOString()}] [${prefix}] ${message}`);
}

function clip(value, max = 180) {
  const text = String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'غير معروف';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function shortUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.hostname}${parsed.pathname.length > 32 ? `${parsed.pathname.slice(0, 31)}…` : parsed.pathname}`;
  } catch {
    return clip(value, 70);
  }
}

function trackName(track) {
  return clip(track?.title || shortUrl(track?.inputUrl || ''), 180) || 'مقطع بدون اسم';
}

function makePanelEmbed(state) {
  const paused = state.player.state.status === AudioPlayerStatus.Paused;
  const playing = state.player.state.status === AudioPlayerStatus.Playing;
  const loading = Boolean(state.loading);
  const current = state.currentTrack;

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎵 مشغّل الموسيقى')
    .setDescription(
      current
        ? `**الحين:** ${trackName(current)}`
        : loading
          ? '**جاري تجهيز المقطع...**'
          : '**ما فيه مقطع شغّال حالياً**',
    )
    .addFields(
      { name: 'الحالة', value: paused ? '⏸️ متوقف مؤقتاً' : playing ? '▶️ شغّال' : loading ? '⏳ جاري التحميل' : '⏹️ متوقف', inline: true },
      { name: 'المدة', value: current?.duration ? formatDuration(current.duration) : '—', inline: true },
      { name: 'القائمة', value: `${state.queue.length} مقطع`, inline: true },
    )
    .setFooter({ text: `البوت: ${state.bot.client.user.username}` });

  if (current?.webpageUrl) {
    try {
      const url = new URL(current.webpageUrl);
      if (url.protocol === 'https:' || url.protocol === 'http:') embed.setURL(url.toString());
    } catch { /* تجاهل الروابط غير الصالحة في الـ Embed */ }
  }

  const next = state.queue[0];
  if (next) embed.addFields({ name: 'التالي', value: trackName(next).slice(0, 1024), inline: false });
  return embed;
}

function makePanelComponents(state) {
  const canPause = Boolean(state.currentTrack) && !state.loading;
  const paused = state.player.state.status === AudioPlayerStatus.Paused;
  const canPrevious = state.history.length > 0;
  const canNext = state.queue.length > 0 || Boolean(state.currentTrack);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`music:${state.guildId}:prev`)
      .setLabel('السابقة')
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canPrevious),
    new ButtonBuilder()
      .setCustomId(`music:${state.guildId}:pause`)
      .setLabel(paused ? 'تشغيل' : 'إيقاف مؤقت')
      .setEmoji(paused ? '▶️' : '⏸️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!canPause),
    new ButtonBuilder()
      .setCustomId(`music:${state.guildId}:next`)
      .setLabel('التالية')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canNext),
    new ButtonBuilder()
      .setCustomId(`music:${state.guildId}:list`)
      .setLabel('Playlist')
      .setEmoji('📃')
      .setStyle(ButtonStyle.Success),
  );
  return [row];
}

async function updatePanel(state) {
  if (state.closing || !state.panelChannelId) return;

  state.panelUpdate = (state.panelUpdate || Promise.resolve()).then(async () => {
    if (state.closing) return;
    const payload = {
      embeds: [makePanelEmbed(state)],
      components: makePanelComponents(state),
      allowedMentions: { parse: [] },
    };

    if (state.panelMessage) {
      try {
        await state.panelMessage.edit(payload);
        return;
      } catch {
        state.panelMessage = null;
      }
    }

    const channel = await state.bot.client.channels.fetch(state.panelChannelId).catch(() => null);
    if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') return;
    state.panelMessage = await channel.send(payload).catch((error) => {
      log(state.bot, `تعذر إرسال لوحة التحكم: ${error.message}`);
      return null;
    });
  }).catch((error) => log(state.bot, `خطأ تحديث اللوحة: ${error.message}`));

  return state.panelUpdate;
}

function runYtDlp(inputUrl) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-warnings',
      '--no-progress',
      '--no-playlist',
      '--no-call-home',
      '--socket-timeout', '20',
      '--extractor-retries', '2',
      '--fragment-retries', '2',
      '--format', 'bestaudio/best',
      '--js-runtimes', 'deno',
      '--dump-single-json',
      inputUrl,
    ];

    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    let timer = null;

    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(data);
    };

    try {
      child = spawn(YTDLP_PATH, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish(new Error(`تعذر تشغيل yt-dlp: ${error.message}`));
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 15 * 1024 * 1024) {
        child.kill();
        finish(new Error('بيانات الرابط أكبر من المتوقع.'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-7000);
    });
    child.once('error', (error) => {
      finish(new Error(`ما قدرت أشغل yt-dlp. تأكد إنه مثبت ومضاف إلى PATH. ${error.message}`));
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = clip(stderr || `exit code ${code}`, 700);
        finish(new Error(`yt-dlp ما قدر يستخرج الرابط: ${detail}`));
        return;
      }
      try {
        const info = JSON.parse(stdout.trim());
        if (!info.url) throw new Error('المصدر ما رجّع رابط بث مباشر.');
        finish(null, info);
      } catch (error) {
        finish(new Error(`تعذر قراءة نتيجة yt-dlp: ${error.message}`));
      }
    });

    timer = setTimeout(() => {
      child.kill();
      finish(new Error('انتهت مهلة استخراج الرابط. جرّب رابطاً آخر أو حدّث yt-dlp.'));
    }, YTDLP_TIMEOUT_MS);
    timer.unref?.();
  });
}

function makeFfmpegArgs(info) {
  const headers = info.http_headers && typeof info.http_headers === 'object'
    ? Object.entries(info.http_headers)
        .map(([key, value]) => `${key}: ${String(value).replace(/[\r\n]/g, '')}\r\n`)
        .join('')
    : '';

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-nostdin',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
  ];

  if (headers) args.push('-headers', headers);
  args.push(
    '-i', info.url,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '48000',
    '-ac', '2',
    '-f', 's16le',
    'pipe:1',
  );
  return args;
}

function cleanupFfmpeg(state) {
  const proc = state.ffmpeg;
  state.ffmpeg = null;
  if (proc && proc.exitCode === null && !proc.killed) {
    try { proc.kill(); } catch { /* انتهى مسبقاً */ }
  }
}

function sendToPanelChannel(state, content) {
  return state.bot.client.channels.fetch(state.panelChannelId)
    .then((channel) => channel?.isTextBased() && typeof channel.send === 'function'
      ? channel.send({ content: clip(content, 1900), allowedMentions: { parse: [] } })
      : null)
    .catch((error) => log(state.bot, `تعذر إرسال التنبيه: ${error.message}`));
}

async function playNext(state) {
  if (state.closing || state.loading || state.currentTrack || !state.queue.length) {
    await updatePanel(state);
    return;
  }

  const track = state.queue.shift();
  state.currentTrack = track;
  state.loading = true;
  const generation = ++state.generation;
  await updatePanel(state);

  try {
    const info = await runYtDlp(track.inputUrl);
    if (state.closing || generation !== state.generation) return;

    track.title = info.title || track.title || shortUrl(track.inputUrl);
    track.duration = Number(info.duration) || null;
    track.webpageUrl = info.webpage_url || track.inputUrl;

    const ffmpeg = spawn(FFMPEG_PATH, makeFfmpegArgs(info), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.ffmpeg = ffmpeg;
    let ffmpegError = '';
    ffmpeg.stderr.setEncoding('utf8');
    ffmpeg.stderr.on('data', (chunk) => { ffmpegError = (ffmpegError + chunk).slice(-4000); });

    ffmpeg.once('error', async (error) => {
      if (state.closing || generation !== state.generation) return;
      state.ffmpeg = null;
      await sendToPanelChannel(state, `تعذر تشغيل FFmpeg. تأكد إنه مثبت ومضاف إلى PATH. ${error.message}`);
      if (state.player.state.status !== AudioPlayerStatus.Idle) {
        state.suppressHistoryOnce = true;
        state.player.stop(true);
      } else {
        state.currentTrack = null;
        state.loading = false;
        state.generation += 1;
        void playNext(state);
      }
    });

    ffmpeg.once('close', (code) => {
      if (state.ffmpeg === ffmpeg) state.ffmpeg = null;
      if (code && code !== 0 && !state.closing && generation === state.generation && ffmpegError) {
        log(state.bot, `FFmpeg انتهى برمز ${code}: ${clip(ffmpegError, 500)}`);
      }
    });

    if (state.closing || generation !== state.generation) {
      try { ffmpeg.kill(); } catch { /* تجاهل */ }
      return;
    }

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
      metadata: track,
    });
    state.loading = false;
    state.player.play(resource);
    await updatePanel(state);
    log(state.bot, `بدأ التشغيل: ${trackName(track)}`);
  } catch (error) {
    if (state.closing || generation !== state.generation) return;
    cleanupFfmpeg(state);
    state.currentTrack = null;
    state.loading = false;
    state.generation += 1;
    await sendToPanelChannel(state, `ما قدرت أشغّل المقطع: ${clip(error.message, 900)}`);
    await updatePanel(state);
    void playNext(state);
  }
}

function handlePlayerIdle(state) {
  if (state.closing) return;
  cleanupFfmpeg(state);

  const ended = state.currentTrack;
  state.currentTrack = null;
  state.loading = false;

  if (ended && !state.suppressHistoryOnce) {
    state.history.push(ended);
    if (state.history.length > 30) state.history.shift();
  }
  state.suppressHistoryOnce = false;
  void updatePanel(state);
  void playNext(state);
}

function createSession(bot, guild, voiceChannel, textChannelId) {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });

  const state = {
    bot,
    guildId: guild.id,
    channelId: voiceChannel.id,
    panelChannelId: textChannelId,
    panelMessage: null,
    panelUpdate: Promise.resolve(),
    connection: null,
    player,
    ffmpeg: null,
    queue: [],
    history: [],
    currentTrack: null,
    loading: false,
    closing: false,
    generation: 0,
    suppressHistoryOnce: false,
  };

  player.on(AudioPlayerStatus.Idle, () => handlePlayerIdle(state));
  player.on('error', (error) => {
    log(bot, `خطأ بالمشغّل: ${error.message}`);
    if (!state.closing && state.player.state.status !== AudioPlayerStatus.Idle) {
      state.player.stop(true);
    }
  });

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    group: `${bot.client.user.id}:${guild.id}`,
  });
  state.connection = connection;
  connection.subscribe(player);
  connection.on('error', (error) => log(bot, `خطأ اتصال الصوت: ${error.message}`));

  return state;
}

async function closeSession(state, reason = 'تم إيقاف التشغيل') {
  if (!state || state.closing) return;
  state.closing = true;
  state.generation += 1;
  cleanupFfmpeg(state);

  try { state.player.stop(true); } catch { /* تجاهل */ }
  try { state.connection?.destroy(); } catch { /* تجاهل */ }
  state.bot.sessions.delete(state.guildId);

  if (state.panelMessage) {
    const stopped = new EmbedBuilder()
      .setColor(0x747F8D)
      .setTitle('⏹️ تم إيقاف مشغّل الموسيقى')
      .setDescription(reason);
    await state.panelMessage.edit({ embeds: [stopped], components: [] }).catch(() => null);
  }
}

function findSession(guildId, voiceChannelId) {
  return bots
    .map((bot) => bot.sessions.get(guildId))
    .find((state) => state && !state.closing && state.channelId === voiceChannelId) || null;
}

async function handleStart(message, channelId) {
  const guildId = message.guild.id;
  if (startLocks.has(guildId)) {
    await message.reply('فيه أمر تشغيل قاعد يتنفّذ، جرّب بعد لحظة.').catch(() => null);
    return;
  }
  startLocks.add(guildId);

  try {
    const existing = findSession(guildId, channelId);
    if (existing) {
      await message.reply(`فيه بوت شغّال من قبل في <#${channelId}>.`).catch(() => null);
      return;
    }

    let selected = null;
    let selectedGuild = null;
    for (const bot of bots) {
      if (!bot.ready || bot.sessions.has(guildId)) continue;
      const guild = bot.client.guilds.cache.get(guildId);
      if (!guild) continue;
      selected = bot;
      selectedGuild = guild;
      break;
    }

    if (!selected || !selectedGuild) {
      await message.reply('ما فيه بوت فاضي وموجود في هالسيرفر. تأكد إن كل البوتات مضافة للسيرفر.').catch(() => null);
      return;
    }

    const voiceChannel = await selectedGuild.channels.fetch(channelId).catch(() => null);
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      await message.reply('اكتب ID روم صوتي صحيح من نفس السيرفر.').catch(() => null);
      return;
    }

    const permissions = voiceChannel.permissionsFor(selected.client.user);
    if (!permissions?.has([PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak])) {
      await message.reply('البوت ما عنده صلاحية Connect و Speak في الروم.').catch(() => null);
      return;
    }

    let state;
    try {
      state = createSession(selected, selectedGuild, voiceChannel, message.channel.id);
      selected.sessions.set(guildId, state);
      await entersState(state.connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    } catch (error) {
      if (state) await closeSession(state, 'تعذر الاتصال بالروم الصوتي.').catch(() => null);
      await message.reply(`ما قدرت أوصل للروم الصوتي: ${clip(error.message, 700)}`).catch(() => null);
      return;
    }

    await message.reply(`دخل **${selected.client.user.username}** إلى <#${channelId}>.`).catch(() => null);
    log(selected, `دخل الروم ${voiceChannel.name} في السيرفر ${guildId}`);
  } finally {
    startLocks.delete(guildId);
  }
}

async function handleSong(message, rawUrl) {
  const voiceChannelId = message.member?.voice?.channelId;
  if (!voiceChannelId) {
    await message.reply('ادخل الروم الصوتي أول، ثم اكتب الأمر.').catch(() => null);
    return;
  }

  const state = findSession(message.guild.id, voiceChannelId);
  if (!state) {
    await message.reply('ما فيه بوت مشغّل في رومك. استخدم `!start ID` أول.').catch(() => null);
    return;
  }

  let parsed;
  try { parsed = new URL(rawUrl); } catch { parsed = null; }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
    await message.reply('حط رابط صحيح يبدأ بـ http أو https.').catch(() => null);
    return;
  }

  if (state.queue.length + (state.currentTrack ? 1 : 0) >= MAX_QUEUE) {
    await message.reply(`القائمة ممتلئة. الحد الأعلى ${MAX_QUEUE} مقطع.`).catch(() => null);
    return;
  }

  const track = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    inputUrl: parsed.toString(),
    title: null,
    duration: null,
    webpageUrl: parsed.toString(),
    requestedBy: message.author.username,
  };
  state.queue.push(track);
  if (!state.panelMessage && !state.loading && !state.currentTrack) {
    state.panelChannelId = message.channel.id;
  }

  await message.reply('تمت إضافة المقطع للقائمة. 🎶').catch(() => null);
  await updatePanel(state);
  if (!state.loading && !state.currentTrack && state.player.state.status === AudioPlayerStatus.Idle) {
    void playNext(state);
  }
}

async function handleStop(message) {
  const voiceChannelId = message.member?.voice?.channelId;
  if (!voiceChannelId) {
    await message.reply('ادخل الروم الصوتي اللي فيه البوت واكتب الأمر.').catch(() => null);
    return;
  }

  const state = findSession(message.guild.id, voiceChannelId);
  if (!state) {
    await message.reply('ما فيه بوت شغّال في رومك.').catch(() => null);
    return;
  }

  await message.reply('تم إيقاف الأغنية وخروج البوت.').catch(() => null);
  await closeSession(state, 'تم إيقاف الأغنية وطلع البوت من الروم.');
}

async function handleMessage(message) {
  if (!message.guild || message.author.bot || !message.content.startsWith(PREFIX)) return;
  const [command = '', ...parts] = message.content.trim().split(/\s+/);
  const name = command.slice(PREFIX.length).toLowerCase();

  if (name === 'start') {
    const channelId = parts[0];
    if (!channelId) {
      await message.reply('الاستخدام: `!start VOICE_CHANNEL_ID`').catch(() => null);
      return;
    }
    await handleStart(message, channelId);
    return;
  }

  if (name === 'song') {
    const rawUrl = message.content.trim().slice(command.length).trim();
    if (!rawUrl) {
      await message.reply('الاستخدام: `!song https://...`').catch(() => null);
      return;
    }
    await handleSong(message, rawUrl);
    return;
  }

  if (name === 'stop') {
    await handleStop(message);
  }
}

function makePlaylistEmbed(state) {
  const lines = [];
  if (state.currentTrack) lines.push(`**الحين:** ${trackName(state.currentTrack)}`);
  else if (state.loading) lines.push('**الحين:** جاري تجهيز المقطع...');
  else lines.push('**الحين:** ما فيه شيء شغّال');

  if (state.queue.length) {
    lines.push('', '**القائمة:**');
    state.queue.slice(0, 25).forEach((track, index) => {
      lines.push(`${index + 1}. ${trackName(track)}`);
    });
    if (state.queue.length > 25) lines.push(`... و ${state.queue.length - 25} مقطع إضافي`);
  } else {
    lines.push('', 'القائمة فاضية.');
  }

  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('📃 قائمة التشغيل')
    .setDescription(lines.join('\n').slice(0, 4000));
}

async function handleButton(bot, interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('music:')) return;
  const [, guildId, action] = interaction.customId.split(':');
  if (!guildId || !action) return;

  const state = bot.sessions.get(guildId);
  if (!state || state.closing) {
    await interaction.reply({ content: 'جلسة الموسيقى انتهت.', ephemeral: true }).catch(() => null);
    return;
  }

  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!member || member.voice.channelId !== state.channelId) {
    await interaction.reply({ content: 'لازم تكون في نفس الروم الصوتي عشان تتحكم.', ephemeral: true }).catch(() => null);
    return;
  }

  if (action === 'list') {
    await interaction.reply({ embeds: [makePlaylistEmbed(state)], ephemeral: true }).catch(() => null);
    return;
  }

  if (action === 'pause') {
    if (state.player.state.status === AudioPlayerStatus.Paused) {
      state.player.unpause();
    } else if (state.player.state.status === AudioPlayerStatus.Playing) {
      state.player.pause();
    } else {
      await interaction.reply({ content: 'ما فيه مقطع جاهز للتحكم فيه للحين.', ephemeral: true }).catch(() => null);
      return;
    }
    await interaction.deferUpdate().catch(() => null);
    await updatePanel(state);
    return;
  }

  if (action === 'next') {
    if (!state.currentTrack && !state.loading) {
      await interaction.reply({ content: 'ما فيه مقطع حالي للتخطي.', ephemeral: true }).catch(() => null);
      return;
    }
    await interaction.deferUpdate().catch(() => null);
    if (state.loading && state.player.state.status === AudioPlayerStatus.Idle) {
      state.generation += 1;
      state.currentTrack = null;
      state.loading = false;
      cleanupFfmpeg(state);
      void playNext(state);
    } else {
      state.player.stop(true);
    }
    await updatePanel(state);
    return;
  }

  if (action === 'prev') {
    const previous = state.history.pop();
    if (!previous) {
      await interaction.reply({ content: 'ما فيه مقطع سابق.', ephemeral: true }).catch(() => null);
      return;
    }

    const current = state.currentTrack;
    if (current) state.queue.unshift(current);
    state.queue.unshift(previous);
    await interaction.deferUpdate().catch(() => null);

    if (state.loading && state.player.state.status === AudioPlayerStatus.Idle) {
      state.generation += 1;
      state.currentTrack = null;
      state.loading = false;
      cleanupFfmpeg(state);
      void playNext(state);
    } else if (state.player.state.status === AudioPlayerStatus.Idle) {
      void playNext(state);
    } else {
      state.suppressHistoryOnce = true;
      state.player.stop(true);
    }
    await updatePanel(state);
  }
}

function attachBot(bot) {
  bot.client.once(Events.ClientReady, (client) => {
    bot.ready = true;
    log(bot, `جاهز — ${client.user.tag}`);
  });

  bot.client.on(Events.MessageCreate, (message) => {
    if (!message.guild || message.author.bot || claimedMessages.has(message.id)) return;
    claimedMessages.add(message.id);
    if (claimedMessages.size > 5000) {
      const oldest = claimedMessages.values().next().value;
      if (oldest) claimedMessages.delete(oldest);
    }
    void handleMessage(message).catch((error) => {
      log(bot, `خطأ معالجة أمر: ${error.stack || error.message}`);
    });
  });

  bot.client.on(Events.InteractionCreate, (interaction) => {
    void handleButton(bot, interaction).catch(async (error) => {
      log(bot, `خطأ زر: ${error.stack || error.message}`);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'صار خطأ أثناء تنفيذ الزر.', ephemeral: true }).catch(() => null);
      }
    });
  });

  bot.client.on('error', (error) => log(bot, `Discord client error: ${error.message}`));
}

async function main() {
  let tokens;
  try {
    tokens = readTokens();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  console.log(`جاري تشغيل ${tokens.length} بوت...`);
  for (let index = 0; index < tokens.length; index += 1) {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
      ],
    });

    const bot = {
      label: `Bot ${index + 1}`,
      client,
      ready: false,
      sessions: new Map(),
    };
    bots.push(bot);
    attachBot(bot);
  }

  const results = await Promise.allSettled(
    bots.map(async (bot, index) => {
      await bot.client.login(tokens[index]);
      return bot;
    }),
  );

  const failed = results.filter((result) => result.status === 'rejected');
  failed.forEach((result, index) => console.error(`تعذر تسجيل دخول أحد البوتات: ${result.reason?.message || result.reason}`));

  if (failed.length === bots.length) {
    console.error('كل التوكنات فشلت. راجع tokens.txt والتوكنات.');
    process.exitCode = 1;
  }
}

async function shutdown(signal) {
  console.log(`\nوصل ${signal}، جاري إغلاق البوتات...`);
  for (const bot of bots) {
    for (const state of [...bot.sessions.values()]) {
      await closeSession(state, 'تم إغلاق البوت.').catch(() => null);
    }
    bot.client.destroy();
  }
  process.exit(0);
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

void main();
