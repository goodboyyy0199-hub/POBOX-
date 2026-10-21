require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ChannelType, PermissionFlagsBits, MessageFlags, SlashCommandBuilder,
  ChannelSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

// ---------- Keep Alive (Express) ----------
const app = express();
app.get('/', (req, res) => res.send('Announce bot is alive!'));
app.listen(process.env.PORT || 3000, () => console.log('🌐 Web server is running'));

const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL;
if (KEEP_ALIVE_URL) {
  setInterval(async () => {
    try {
      const res = await fetch(KEEP_ALIVE_URL);
      console.log(`💓 keep-alive ping: ${res.status}`);
    } catch (e) {
      console.error('keep-alive ping ล้มเหลว:', e.message);
    }
  }, 2 * 60 * 1000);
  console.log(`💓 keep-alive เปิดอยู่ → ${KEEP_ALIVE_URL} (ทุก 2 นาที)`);
} else {
  console.log('⚠️ ไม่พบ RENDER_EXTERNAL_URL / KEEP_ALIVE_URL จึงไม่เปิด keep-alive ในตัวบอท');
}

// ---------- Config ----------
const MONGODB_URI = process.env.MONGODB_URI || '';
const MAX_REACTIONS = 20; // Discord ให้ใส่รีแอคชันได้สูงสุด 20 อันต่อข้อความ

// ---------- เก็บข้อมูล ----------
// ถ้าตั้ง MONGODB_URI → เก็บถาวรใน MongoDB (ใช้ collection แยกจากบอท ticket)
// ถ้าไม่ตั้ง → เก็บใน data.json (บน Render ฟรีจะหายเมื่อ deploy/รีสตาร์ท)
const DATA_FILE = path.join(__dirname, 'data.json');
let data = { embeds: {} };
let mongoCol = null;
let saveTimer = null;

async function loadData() {
  if (MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    const mc = new MongoClient(MONGODB_URI);
    await mc.connect();
    mongoCol = mc.db(process.env.MONGODB_DB || 'ticketbot').collection('announcedata');
    const doc = await mongoCol.findOne({ _id: 'main' });
    if (doc && doc.data) data = doc.data;
    console.log('🗄️ เชื่อมต่อ MongoDB สำเร็จ (ข้อมูลเก็บถาวร)');
  } else {
    try {
      if (fs.existsSync(DATA_FILE)) data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      console.error('อ่าน data.json ไม่สำเร็จ เริ่มใหม่:', e);
    }
    console.log('⚠️ ไม่ได้ตั้ง MONGODB_URI → ข้อมูลจะหายเมื่อ Render deploy/รีสตาร์ท');
  }
  data.embeds ||= {};
}

const writeMongo = () =>
  mongoCol.replaceOne({ _id: 'main' }, { _id: 'main', data }, { upsert: true })
    .catch((e) => console.error('บันทึก MongoDB ไม่สำเร็จ:', e.message));

function save() {
  if (mongoCol) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeMongo, 500);
  } else {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
    catch (e) { console.error('บันทึก data.json ไม่สำเร็จ:', e); }
  }
}

process.on('SIGTERM', async () => {
  if (mongoCol) { clearTimeout(saveTimer); await writeMongo(); }
  process.exit(0);
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.on('error', (e) => console.error('client error:', e));

// ---------- helpers ----------
const isUrl = (u) => /^https?:\/\/\S+$/i.test(u || '');
const isHex = (c) => /^#?[0-9a-f]{6}$/i.test(c || '');
const norm = (s) => String(s || '').trim().toLowerCase();
const bad = (i, text) => i.reply({ content: `❌ ${text}`, flags: MessageFlags.Ephemeral });
const isAdmin = (i) => i.memberPermissions?.has(PermissionFlagsBits.Administrator);
const guildEmbeds = (gid) => (data.embeds[gid] ||= []);
const findEmbed = (gid, name) => guildEmbeds(gid).find((e) => norm(e.name) === norm(name));

// อิโมจิ: รองรับอิโมจิปกติ และอิโมจิเซิร์ฟเวอร์ <:ชื่อ:ไอดี> / <a:ชื่อ:ไอดี>
const CUSTOM_EMOJI = /^<a?:\w{2,32}:\d{17,20}>$/;
const UNI_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[0-9#*]️?⃣)[\p{Extended_Pictographic}️‍⃣\u{1F3FB}-\u{1F3FF}]*$/u;
const isEmoji = (s) => CUSTOM_EMOJI.test(s) || UNI_EMOJI.test(s);

// ---------- Slash command: /announce ----------
const nameOpt = (o, auto, desc) => o.setName('name').setDescription(desc || 'ชื่อประกาศ')
  .setRequired(true).setMaxLength(50).setAutocomplete(auto);

const announceCmd = new SlashCommandBuilder()
  .setName('announce')
  .setDescription('สร้างและจัดการประกาศแบบ Embed พร้อมอิโมจิให้กดเลือก')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(s => s.setName('create')
    .setDescription('สร้างประกาศใหม่ตั้งชื่อ (ห้ามซ้ำ) แล้วแก้ไขด้วยปุ่มใต้ตัวอย่าง')
    .addStringOption(o => nameOpt(o, false, 'ตั้งชื่อประกาศ (ห้ามซ้ำกับที่มีอยู่)')))
  .addSubcommand(s => s.setName('edit')
    .setDescription('เปิดกล่องตัวอย่าง + ปุ่มแก้ไข ของประกาศที่สร้างไว้')
    .addStringOption(o => nameOpt(o, true)))
  .addSubcommand(s => s.setName('list').setDescription('ดูรายชื่อประกาศทั้งหมดที่สร้างไว้'))
  .addSubcommand(s => s.setName('send').setDescription('ส่งประกาศจริงไปยังห้องที่ต้องการ')
    .addStringOption(o => nameOpt(o, true))
    .addChannelOption(o => o.setName('channel').setDescription('ห้องที่จะส่ง (ไม่เลือก = ห้องนี้)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand(s => s.setName('delete').setDescription('ลบประกาศที่สร้างไว้')
    .addStringOption(o => nameOpt(o, true)))
  .toJSON();

// ---------- สร้างหน้าตา Embed ----------
function buildEmbed(e) {
  const emb = new EmbedBuilder().setColor(e.color || 0x5865f2);
  if (e.author) emb.setAuthor({ name: e.author.slice(0, 256), iconURL: e.authorIcon || undefined });
  if (e.title) emb.setTitle(e.title.slice(0, 256));
  if (e.description) emb.setDescription(e.description.slice(0, 4096));
  if (e.image) emb.setImage(e.image);
  if (e.thumbnail) emb.setThumbnail(e.thumbnail);
  if (e.footer) emb.setFooter({ text: e.footer.slice(0, 2048) });
  if (e.timestamp !== false) emb.setTimestamp();
  return emb;
}

const hasContent = (e) => !!(e.title || e.description || e.image || e.author || e.footer || e.thumbnail);

// ข้อความจริงที่ส่งเข้าห้อง: แท็ก (อยู่นอก Embed เพื่อให้แจ้งเตือนจริง) + Embed
const messagePayload = (e) => ({
  content: e.mention || undefined,
  embeds: [buildEmbed(e)],
  allowedMentions: { parse: ['everyone', 'roles', 'users'] },
});

// บอทกดรีแอคชันตามลำดับ เพื่อให้สมาชิกกดเลือกต่อได้
async function addReactions(message, e) {
  const failed = [];
  for (const emoji of e.reactions || []) {
    try { await message.react(emoji); }
    catch (err) { failed.push(emoji); console.error('ใส่รีแอคชันไม่สำเร็จ:', emoji, err.message); }
  }
  return failed;
}

async function sendAnnouncement(channel, e) {
  const msg = await channel.send(messagePayload(e));
  const failed = await addReactions(msg, e);
  return { msg, failed };
}

const failNote = (failed) =>
  failed.length ? `\n⚠️ ใส่อิโมจิไม่สำเร็จ: ${failed.join(' ')} (ตรวจว่าบอทมีสิทธิ์ Add Reactions และอิโมจิอยู่ในเซิร์ฟเวอร์นี้)` : '';

// ---------- กล่องตัวอย่าง + ปุ่มแก้ไข ----------
const mk = (id, label, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

function panelPayload(e, note) {
  const timeOn = e.timestamp !== false;
  const row1 = new ActionRowBuilder().addComponents(
    mk(`emb:basic:${e.id}`, '✏️ แก้ข้อมูลพื้นฐาน (สี / หัวข้อ / ข้อความ)'),
    mk(`emb:author:${e.id}`, '👤 แก้ผู้เขียน'),
    mk(`emb:footer:${e.id}`, '📝 แก้ footer'),
    mk(`emb:images:${e.id}`, '🖼️ แก้รูปภาพ'),
  );
  const row2 = new ActionRowBuilder().addComponents(
    mk(`emb:reactions:${e.id}`, '😀 แก้อิโมจิให้กด'),
    mk(`emb:mention:${e.id}`, '📣 แก้การแท็ก'),
    mk(`emb:tgltime:${e.id}`, `🕒 เวลา: ${timeOn ? 'เปิด' : 'ปิด'}`, timeOn ? ButtonStyle.Success : ButtonStyle.Secondary),
    mk(`emb:delete:${e.id}`, '🗑️ ลบประกาศ', ButtonStyle.Danger),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`embedsend:${e.id}`)
      .setPlaceholder('📤 เลือกห้องที่จะส่งประกาศจริง')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );
  const info =
    `อิโมจิให้กด: ${(e.reactions || []).length ? e.reactions.join(' ') : 'ไม่มี'}\n` +
    `แท็ก: ${e.mention || 'ไม่มี'}`;
  return {
    content: note || `📌 **${e.name}** — ตัวอย่างก่อนส่งจริง\n${info}\nแก้ไขด้วยปุ่มด้านล่าง แล้วเลือกห้องจากเมนูล่างสุดเพื่อส่งของจริง`,
    embeds: [buildEmbed(e)],
    components: [row1, row2, row3],
    allowedMentions: { parse: [] }, // ตัวอย่างไม่แท็กใครจริง
  };
}

// ---------- Modal แก้ไข ----------
const input = (id, label, style, value, max, placeholder) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style)
    .setRequired(false).setMaxLength(max);
  if (value) t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(t);
};
const SHORT = TextInputStyle.Short;
const PARA = TextInputStyle.Paragraph;

function buildModal(action, e) {
  const m = new ModalBuilder().setCustomId(`embm:${action}:${e.id}`);
  if (action === 'basic') {
    m.setTitle('แก้ข้อมูลพื้นฐาน').addComponents(
      input('title', 'หัวข้อ (เว้นว่าง = ไม่มี)', SHORT, e.title, 256),
      input('description', 'ข้อความ (เว้นว่าง = ไม่มี)', PARA, e.description, 4000, 'ใช้ > ทำกรอบอ้างอิง, <#ไอดีห้อง> ลิงก์ห้อง'),
      input('color', 'สี HEX เช่น #5865F2', SHORT, e.color, 7),
      input('name', 'ชื่อประกาศ (ห้ามซ้ำ)', SHORT, e.name, 50),
    );
  } else if (action === 'author') {
    m.setTitle('แก้ผู้เขียน').addComponents(
      input('author', 'ชื่อด้านบนสุด (เว้นว่าง = ไม่แสดง)', SHORT, e.author, 256),
      input('author_icon', 'ลิงก์รูปโปรไฟล์ข้างชื่อ', SHORT, e.authorIcon, 500, 'https://...'),
    );
  } else if (action === 'footer') {
    m.setTitle('แก้ footer').addComponents(
      input('footer', 'ข้อความท้าย Embed (เว้นว่าง = ไม่มี)', SHORT, e.footer, 2048),
    );
  } else if (action === 'images') {
    m.setTitle('แก้รูปภาพ').addComponents(
      input('image', 'ลิงก์รูป/GIF ใหญ่', SHORT, e.image, 500, 'https://...'),
      input('thumbnail', 'ลิงก์รูปเล็กมุมขวาบน', SHORT, e.thumbnail, 500, 'https://...'),
    );
  } else if (action === 'reactions') {
    m.setTitle('แก้อิโมจิให้กด').addComponents(
      input('reactions', `อิโมจิ คั่นด้วยเว้นวรรค (สูงสุด ${MAX_REACTIONS})`, PARA, (e.reactions || []).join(' '), 1000, '✅ 💯 ❤️‍🔥'),
    );
  } else if (action === 'mention') {
    m.setTitle('แก้การแท็ก').addComponents(
      input('mention', 'ข้อความแท็ก (เว้นว่าง = ไม่แท็ก)', PARA, e.mention, 500, '@everyone <@&ไอดียศ>'),
    );
  }
  return m;
}

// ---------- ปุ่มในกล่องตัวอย่าง ----------
async function handleEmbButton(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่แก้ประกาศได้');
  const [, action, id] = i.customId.split(':');
  const e = guildEmbeds(i.guildId).find((x) => x.id === id);
  if (!e) return bad(i, 'ไม่พบประกาศนี้แล้ว (อาจถูกลบไป)');

  if (['basic', 'author', 'footer', 'images', 'reactions', 'mention'].includes(action)) {
    return i.showModal(buildModal(action, e));
  }
  if (action === 'tgltime') { e.timestamp = e.timestamp === false; save(); return i.update(panelPayload(e)); }
  if (action === 'delete') {
    return i.reply({
      content: `⚠️ ยืนยันลบประกาศ **${e.name}** ?`,
      components: [new ActionRowBuilder().addComponents(mk(`emb:delok:${e.id}`, 'ยืนยันลบ', ButtonStyle.Danger))],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (action === 'delok') {
    data.embeds[i.guildId] = guildEmbeds(i.guildId).filter((x) => x.id !== e.id);
    save();
    return i.update({ content: `🗑️ ลบประกาศ **${e.name}** แล้ว (ข้อความที่ส่งไปแล้วไม่ถูกลบ)`, components: [] });
  }
}

// ---------- ส่งข้อมูลจาก Modal ----------
async function handleEmbModal(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่แก้ประกาศได้');
  const [, action, id] = i.customId.split(':');
  const e = guildEmbeds(i.guildId).find((x) => x.id === id);
  if (!e) return bad(i, 'ไม่พบประกาศนี้แล้ว (อาจถูกลบไป)');

  const get = (k) => {
    const v = i.fields.getTextInputValue(k).trim();
    return v === '' || v === '-' ? null : v;
  };
  const urlOrNull = (k) => {
    const v = get(k);
    if (v && !isUrl(v)) throw new Error(`ลิงก์ในช่อง ${k} ไม่ถูกต้อง (ต้องขึ้นต้นด้วย https://)`);
    return v;
  };

  const draft = { ...e };
  try {
    if (action === 'basic') {
      const name = i.fields.getTextInputValue('name').trim();
      if (!name) throw new Error('ชื่อประกาศห้ามว่าง');
      const dup = findEmbed(i.guildId, name);
      if (dup && dup.id !== e.id) throw new Error(`มีประกาศชื่อ **${name}** อยู่แล้ว กรุณาใช้ชื่ออื่น`);
      const color = get('color');
      if (color && !isHex(color)) throw new Error('สีต้องเป็น HEX เช่น #5865F2');
      draft.name = name;
      draft.title = get('title');
      draft.description = get('description');
      draft.color = color ? (color.startsWith('#') ? color : `#${color}`) : null;
    } else if (action === 'author') {
      draft.author = get('author');
      draft.authorIcon = urlOrNull('author_icon');
    } else if (action === 'footer') {
      draft.footer = get('footer');
    } else if (action === 'images') {
      draft.image = urlOrNull('image');
      draft.thumbnail = urlOrNull('thumbnail');
    } else if (action === 'reactions') {
      const raw = get('reactions');
      const list = raw ? [...new Set(raw.split(/\s+/))] : [];
      const wrong = list.filter((x) => !isEmoji(x));
      if (wrong.length) throw new Error(`ไม่ใช่อิโมจิ: ${wrong.join(' ')} (ใส่อิโมจิคั่นด้วยเว้นวรรค อิโมจิเซิร์ฟเวอร์ใช้รูปแบบ <:ชื่อ:ไอดี>)`);
      if (list.length > MAX_REACTIONS) throw new Error(`ใส่อิโมจิได้สูงสุด ${MAX_REACTIONS} อัน`);
      draft.reactions = list;
    } else if (action === 'mention') {
      draft.mention = get('mention');
    }
    if (!hasContent(draft)) throw new Error('ประกาศต้องมีข้อมูลอย่างน้อย 1 อย่าง (เช่น หัวข้อหรือข้อความ)');
  } catch (err) {
    return bad(i, err.message);
  }

  Object.assign(e, draft);
  save();
  return i.isFromMessage() ? i.update(panelPayload(e)) : i.reply(panelPayload(e));
}

// ---------- /announce ----------
async function handleAnnounce(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่ใช้คำสั่งนี้ได้');
  const sub = i.options.getSubcommand();
  const gid = i.guildId;

  if (sub === 'create') {
    const name = i.options.getString('name').trim();
    if (!name) return bad(i, 'ชื่อประกาศห้ามว่าง');
    if (findEmbed(gid, name)) {
      return bad(i, `มีประกาศชื่อ **${name}** อยู่แล้ว กรุณาใช้ชื่ออื่น (หรือใช้ /announce edit เพื่อแก้ของเดิม)`);
    }
    const e = {
      id: crypto.randomBytes(4).toString('hex'),
      name,
      title: 'หัวข้อประกาศ',
      description: 'กดปุ่มด้านล่างเพื่อแก้ไขประกาศนี้',
      author: i.member?.displayName || i.user.username,
      authorIcon: i.user.displayAvatarURL(),
      image: null, thumbnail: null, footer: null, color: null,
      timestamp: true,
      reactions: ['✅', '💯', '❤️‍🔥'],
      mention: null,
      createdBy: i.user.id, createdAt: Date.now(),
    };
    guildEmbeds(gid).push(e);
    save();
    return i.reply(panelPayload(e, `✅ สร้างประกาศชื่อ **${name}** แล้ว — นี่คือตัวอย่างก่อนส่งจริง\nแก้ไขด้วยปุ่มด้านล่าง แล้วเลือกห้องจากเมนูล่างสุดเพื่อส่งของจริง`));
  }

  if (sub === 'list') {
    const list = guildEmbeds(gid);
    if (!list.length) return bad(i, 'ยังไม่มีประกาศที่สร้างไว้ ใช้ /announce create เพื่อสร้าง');
    const lines = list.map((e, n) => `**${n + 1}.** \`${e.name}\`${e.title ? ` — ${e.title}` : ''}`);
    return i.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2)
        .setTitle(`📚 ประกาศที่สร้างไว้ (${list.length})`)
        .setDescription(lines.join('\n').slice(0, 4000))],
      flags: MessageFlags.Ephemeral,
    });
  }

  const name = i.options.getString('name');
  const e = findEmbed(gid, name);
  if (!e) return bad(i, `ไม่พบประกาศชื่อ **${name}** (ดูรายชื่อด้วย /announce list)`);

  if (sub === 'edit') return i.reply(panelPayload(e));

  if (sub === 'send') {
    const target = i.options.getChannel('channel') || i.channel;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const ch = await i.guild.channels.fetch(target.id);
      const { failed } = await sendAnnouncement(ch, e);
      return i.editReply(`✅ ส่งประกาศ **${e.name}** ไปที่ <#${ch.id}> แล้ว${failNote(failed)}`);
    } catch (err) {
      console.error('ส่งประกาศไม่สำเร็จ:', err.message);
      return i.editReply(`❌ ส่งไม่สำเร็จ: ${err.message} (ตรวจสิทธิ์ดู/ส่งข้อความของบอทในห้องนั้น)`);
    }
  }

  if (sub === 'delete') {
    data.embeds[gid] = guildEmbeds(gid).filter((x) => x.id !== e.id);
    save();
    return i.reply({ content: `🗑️ ลบประกาศ **${e.name}** แล้ว (ข้อความที่ส่งไปแล้วในห้องต่างๆ ไม่ถูกลบ)`, flags: MessageFlags.Ephemeral });
  }
}

// เลือกห้องจากเมนูในกล่องตัวอย่าง → ส่งของจริง
async function handleSendSelect(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้น');
  const id = i.customId.split(':')[1];
  const e = guildEmbeds(i.guildId).find((x) => x.id === id);
  if (!e) return bad(i, 'ไม่พบประกาศนี้แล้ว (อาจถูกลบไป)');
  const target = i.channels.first();
  await i.deferUpdate();
  try {
    const ch = await i.guild.channels.fetch(target.id);
    const { failed } = await sendAnnouncement(ch, e);
    return i.editReply({ ...panelPayload(e, `✅ ส่งประกาศ **${e.name}** ไปที่ <#${ch.id}> แล้ว (เลือกห้องอื่นเพื่อส่งซ้ำได้)${failNote(failed)}`) });
  } catch (err) {
    console.error('ส่งประกาศไม่สำเร็จ:', err.message);
    return i.followUp({ content: `❌ ส่งไม่สำเร็จ: ${err.message} (ตรวจสิทธิ์ดู/ส่งข้อความของบอทในห้องนั้น)`, flags: MessageFlags.Ephemeral });
  }
}

// ---------- Ready ----------
client.once('clientReady', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    guild.commands.set([announceCmd]).catch(console.error);
  }
});

client.on('guildCreate', (guild) => {
  guild.commands.set([announceCmd]).catch(console.error);
});

// ---------- Interactions ----------
client.on('interactionCreate', async (i) => {
  try {
    if (i.isAutocomplete() && i.commandName === 'announce') {
      const q = norm(i.options.getFocused());
      const choices = guildEmbeds(i.guildId)
        .filter((e) => norm(e.name).includes(q))
        .slice(0, 25)
        .map((e) => ({ name: e.name.slice(0, 100), value: e.name }));
      return await i.respond(choices);
    }

    if (i.isChatInputCommand() && i.commandName === 'announce') {
      return await handleAnnounce(i);
    }

    if (i.isChannelSelectMenu() && i.customId.startsWith('embedsend:')) {
      return await handleSendSelect(i);
    }

    if (i.isModalSubmit() && i.customId.startsWith('embm:')) {
      return await handleEmbModal(i);
    }

    if (i.isButton() && i.customId.startsWith('emb:')) {
      return await handleEmbButton(i);
    }
  } catch (err) {
    console.error(err);
    if (i.isAutocomplete?.()) return;
    const payload = { content: '❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้ง', flags: MessageFlags.Ephemeral };
    if (i.deferred || i.replied) i.followUp(payload).catch(() => {});
    else i.reply(payload).catch(() => {});
  }
});

(async () => {
  await loadData();
  await client.login(process.env.DISCORD_TOKEN);
})().catch((e) => { console.error('เริ่มบอทไม่สำเร็จ:', e); process.exit(1); });
