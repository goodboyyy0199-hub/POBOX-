// =====================================================================
// บอทรายงานโปร  —  มีคำสั่งเดียวคือ /setreport
//   ห้อง 1 แอดมิน      : รับรายงาน + ปุ่ม "ยืนยันแบนแล้ว" (กดแล้วเขียนข้อความ + แนบรูปจากเครื่องได้)
//   ห้อง 2 ปุ่มรายงาน   : กล่องที่มีปุ่ม "รายงาน" (กดแล้วเขียนข้อความ + แนบรูปหลักฐานจากเครื่อง)
//   ห้อง 3 แสดงรายงาน   : แสดงรายงานที่ผู้เล่นส่งเข้ามา (แอดมินกดแบน → บอทตอบกลับใต้ข้อความเดิม)
// ต้องใช้ discord.js >= 14.22 (ช่องอัปโหลดไฟล์ใน Modal)
// =====================================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const {
  Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ChannelType, PermissionFlagsBits, MessageFlags, SlashCommandBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, AttachmentBuilder, LabelBuilder, FileUploadBuilder,
} = require('discord.js');

if (!LabelBuilder || !FileUploadBuilder) {
  console.error('❌ discord.js เวอร์ชันเก่าเกินไป ไม่รองรับการแนบไฟล์ใน Modal — ให้รัน: npm i discord.js@latest');
  process.exit(1);
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

// ---------- Keep Alive (Render) ----------
const app = express();
app.get('/', (req, res) => res.send('Report bot is alive!'));
app.listen(process.env.PORT || 3000, () => console.log('🌐 Web server is running'));
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL;
if (KEEP_ALIVE_URL) {
  setInterval(() => fetch(KEEP_ALIVE_URL).catch((e) => console.error('keep-alive:', e.message)), 2 * 60 * 1000);
}

// ---------- เก็บข้อมูล ----------
// ตั้ง MONGODB_URI → เก็บถาวร  |  ไม่ตั้ง → เก็บใน data.json
const DATA_FILE = path.join(__dirname, 'data.json');
let data = { reports: {} };
let mongoCol = null;
let saveTimer = null;

async function loadData() {
  if (process.env.MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    const mc = new MongoClient(process.env.MONGODB_URI);
    await mc.connect();
    mongoCol = mc.db(process.env.MONGODB_DB || 'reportbot').collection('botdata');
    const doc = await mongoCol.findOne({ _id: 'main' });
    if (doc?.data) data = doc.data;
    console.log('🗄️ เชื่อมต่อ MongoDB สำเร็จ');
  } else {
    try { if (fs.existsSync(DATA_FILE)) data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch (e) { console.error('อ่าน data.json ไม่สำเร็จ เริ่มใหม่:', e); }
    console.log('⚠️ ไม่ได้ตั้ง MONGODB_URI → ข้อมูลอาจหายเมื่อ deploy ใหม่');
  }
  data.reports ||= {};
}
const writeMongo = () => mongoCol.replaceOne({ _id: 'main' }, { _id: 'main', data }, { upsert: true })
  .catch((e) => console.error('บันทึก MongoDB ไม่สำเร็จ:', e.message));
function save() {
  if (mongoCol) { clearTimeout(saveTimer); saveTimer = setTimeout(writeMongo, 500); return; }
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('บันทึก data.json ไม่สำเร็จ:', e); }
}
process.on('SIGTERM', async () => {
  if (mongoCol) { clearTimeout(saveTimer); await writeMongo(); }
  process.exit(0);
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.on('error', (e) => console.error('client error:', e));

// ---------- helpers ----------
const norm = (s) => String(s || '').trim().toLowerCase();
const isHex = (c) => /^#?[0-9a-f]{6}$/i.test(c || '');
const fixHex = (c) => (c.startsWith('#') ? c : `#${c}`);
const bad = (i, text) => i.reply({ content: `❌ ${text}`, flags: MessageFlags.Ephemeral });
const isAdmin = (i) => i.memberPermissions?.has(PermissionFlagsBits.Administrator);
const mk = (id, label, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const SHORT = TextInputStyle.Short;
const PARA = TextInputStyle.Paragraph;

const BTN_STYLES = {
  primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success, danger: ButtonStyle.Danger,
};
const BTN_NAMES = { primary: 'น้ำเงิน', secondary: 'เทา', success: 'เขียว', danger: 'แดง' };
const BTN_ALIASES = {
  'น้ำเงิน': 'primary', blue: 'primary', primary: 'primary',
  'เทา': 'secondary', grey: 'secondary', gray: 'secondary', secondary: 'secondary',
  'เขียว': 'success', green: 'success', success: 'success',
  'แดง': 'danger', red: 'danger', danger: 'danger',
};

// ช่องข้อความใน Modal (ใช้ Label ครอบ)
function txt(id, label, style, value, max, placeholder, required = false) {
  const t = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required).setMaxLength(max);
  if (value) t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(String(placeholder).slice(0, 100));
  return new LabelBuilder().setLabel(label.slice(0, 45)).setTextInputComponent(t);
}
// ช่องแนบรูปจากในเครื่องใน Modal
function upload(id, label, desc, required, max = 3) {
  const f = new FileUploadBuilder().setCustomId(id).setRequired(required)
    .setMinValues(required ? 1 : 0).setMaxValues(max);
  return new LabelBuilder().setLabel(label.slice(0, 45)).setDescription(desc.slice(0, 100))
    .setFileUploadComponent(f);
}

// ---------- ค่าเริ่มต้น ----------
const REPORT_COOLDOWN_MS = 60 * 1000;
const ST_WAIT = '⏳ รอแอดมินตรวจสอบ';
const ST_BANNED = '✅ แบนเรียบร้อยแล้ว';
const reportCooldown = new Map();
const banBusy = new Set();

const DEF = {
  title: '🚨 แจ้งผู้เล่นใช้โปร / โกง',
  description: 'พบผู้เล่นใช้โปรหรือโกง กดปุ่มด้านล่าง เขียนรายละเอียด และแนบรูปหลักฐานได้เลย\nทีมงานจะตรวจสอบและแจ้งผลให้ทราบ',
  color: '#ED4245',
  buttonLabel: '🚨 รายงานโปร',
  question: 'รายละเอียด (ชื่อผู้เล่น / สิ่งที่พบ)',
  banLabel: '✅ ยืนยันแบนแล้ว',
};
const BOX_DEFAULT = {
  rep: { title: '🚨 รายงานโปร #{no}', description: '{text}', color: '#FEE75C', footer: null },
  ban: { title: '🔨 แบนผู้เล่นเรียบร้อยแล้ว', description: '{text}', color: '#57F287', footer: null },
};
const boxOf = (g, kind) => ({ ...BOX_DEFAULT[kind], ...(g?.[`${kind}Box`] || {}) });

const guildPanels = (gid) => (data.reports[gid] ||= []);
const findPanel = (gid, name) => guildPanels(gid).find((p) => norm(p.name) === norm(name));
const panelById = (gid, id) => guildPanels(gid).find((p) => p.id === id);

// ---------- คำสั่ง /setreport ----------
const nameOpt = (o, auto, desc) => o.setName('name').setDescription(desc || 'ชื่อระบบรายงาน')
  .setRequired(true).setMaxLength(50).setAutocomplete(auto);

const setReportCmd = new SlashCommandBuilder()
  .setName('setreport')
  .setDescription('ตั้งระบบรายงานโปร (ห้องแอดมิน / ห้องปุ่มรายงาน / ห้องแสดงรายงาน)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((s) => s.setName('create').setDescription('สร้างระบบรายงานใหม่')
    .addStringOption((o) => nameOpt(o, false, 'ตั้งชื่อระบบ (ห้ามซ้ำ)')))
  .addSubcommand((s) => s.setName('edit').setDescription('เปิดแผงตั้งค่า + ตัวอย่าง')
    .addStringOption((o) => nameOpt(o, true)))
  .addSubcommand((s) => s.setName('list').setDescription('ดูรายชื่อระบบทั้งหมด'))
  .addSubcommand((s) => s.setName('send').setDescription('ส่งปุ่มรายงานจริงไปยังห้อง')
    .addStringOption((o) => nameOpt(o, true))
    .addChannelOption((o) => o.setName('channel').setDescription('ห้องที่จะส่ง (ไม่เลือก = ห้องปุ่มรายงานที่ตั้งไว้)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand((s) => s.setName('delete').setDescription('ลบระบบ')
    .addStringOption((o) => nameOpt(o, true)))
  .toJSON();

// ---------- Embed ----------
function publicEmbed(g) {
  const e = new EmbedBuilder().setColor(g.color || DEF.color)
    .setTitle((g.title ?? DEF.title).slice(0, 256) || null)
    .setDescription((g.description ?? DEF.description).slice(0, 4096) || null);
  if (g.image) e.setImage(g.image);
  if (g.thumbnail) e.setThumbnail(g.thumbnail);
  if (g.footer) e.setFooter({ text: g.footer.slice(0, 2048) });
  if (g.timestamp !== false) e.setTimestamp();
  return e;
}
const publicPayload = (g) => ({
  embeds: [publicEmbed(g)],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rpt_open:${g.id}`)
      .setLabel((g.buttonLabel || DEF.buttonLabel).slice(0, 80))
      .setStyle(BTN_STYLES[g.btnColor] ?? ButtonStyle.Danger))],
});

// แทนตัวแปรในข้อความที่แอดมินตั้งไว้ — {text} แทนเป็นอันสุดท้าย ข้อความผู้ใช้จะไม่ถูกตีความซ้ำ
function fillTpl(t, v, plain) {
  const out = String(t || '')
    .split('{user}').join(plain ? v.name : v.user)
    .split('{name}').join(v.name)
    .split('{no}').join(String(v.no ?? ''))
    .split('{admin}').join(plain ? (v.adminName || '') : (v.admin || ''));
  return v.text == null ? out : (out.includes('{text}') ? out.split('{text}').join(v.text) : (out ? `${out}\n\n${v.text}` : v.text));
}

// รูปแนบ: ใช้ attachment://ชื่อไฟล์ (ถาวร) ถ้าอัปโหลดซ้ำไม่ได้ค่อยใช้ลิงก์เดิม
function imgParts(imgs, useFiles) {
  const ok = useFiles && imgs.every((m) => m.buf);
  return {
    files: ok ? imgs.map((m) => new AttachmentBuilder(m.buf, { name: m.name })) : [],
    first: imgs[0] ? (ok ? `attachment://${imgs[0].name}` : imgs[0].url) : null,
    extra: ok ? '' : imgs.slice(1).map((m) => m.url).join('\n'),
  };
}
async function trySend(ch, build) {
  try { return await ch.send(build(true)); }
  catch (e) {
    console.error('ส่งแบบแนบไฟล์ไม่สำเร็จ ลองใหม่แบบลิงก์:', e.message);
    return await ch.send(build(false));
  }
}

// Embed รายงาน (ใช้ทั้งห้องแสดงและห้องแอดมิน)
function reportEmbed(g, r, parts) {
  const box = boxOf(g, 'rep');
  const who = r.preview ? '**@ผู้รายงาน**' : `<@${r.user}>`;
  const v = { user: who, name: r.displayName, no: r.no, text: r.text };
  const e = new EmbedBuilder().setColor(box.color).setAuthor({ name: r.displayName.slice(0, 256) })
    .setDescription(fillTpl(box.description, v).slice(0, 4096))
    .addFields(
      { name: '🆔 เลขรายงาน', value: `#${r.no}`, inline: true },
      { name: '👤 ผู้รายงาน', value: `${who} (\`${r.username}\`)`, inline: true },
      { name: '📌 สถานะ', value: ST_WAIT, inline: true },
    ).setTimestamp(r.createdAt);
  const title = fillTpl(box.title, { ...v, text: null }, true);
  if (title) e.setTitle(title.slice(0, 256));
  if (r.avatar) e.setThumbnail(r.avatar);
  const footer = fillTpl(box.footer, { ...v, text: null }, true);
  if (footer) e.setFooter({ text: footer.slice(0, 2048) });
  if (parts?.first) e.setImage(parts.first);
  if (parts?.extra) e.addFields({ name: '🖼️ รูปเพิ่มเติม', value: parts.extra.slice(0, 1000) });
  return e;
}
// Embed ข้อความตอนแอดมินกดแบน
function banEmbed(g, c, parts) {
  const box = boxOf(g, 'ban');
  const v = { user: `<@${c.reporterId}>`, name: c.reporterName, no: c.no, admin: `<@${c.adminId}>`, adminName: c.adminName, text: c.text };
  const e = new EmbedBuilder().setColor(box.color)
    .setDescription(fillTpl(box.description, v).slice(0, 4096))
    .addFields(
      { name: '🆔 ตามรายงาน', value: `#${c.no}`, inline: true },
      { name: '👮 ดำเนินการโดย', value: `<@${c.adminId}>`, inline: true },
    ).setTimestamp();
  const title = fillTpl(box.title, { ...v, text: null }, true);
  if (title) e.setTitle(title.slice(0, 256));
  const footer = fillTpl(box.footer, { ...v, text: null }, true);
  if (footer) e.setFooter({ text: footer.slice(0, 2048) });
  if (parts?.first) e.setImage(parts.first);
  if (parts?.extra) e.addFields({ name: '🖼️ รูปเพิ่มเติม', value: parts.extra.slice(0, 1000) });
  if (c.link) e.addFields({ name: '🔗 รายงานเดิม', value: `[ไปที่ข้อความ](${c.link})` });
  return e;
}
// เปลี่ยน Embed รายงานเป็นสถานะ "แบนแล้ว"
function markBanned(embed, byId) {
  return EmbedBuilder.from(embed).setColor(0x57f287).setFields((embed.fields || []).map((f) => (
    f.name.includes('สถานะ')
      ? { name: f.name, value: byId ? `${ST_BANNED}\nโดย <@${byId}>` : ST_BANNED, inline: f.inline }
      : { name: f.name, value: f.value, inline: f.inline })));
}

// ---------- ดึงรูปจากช่องแนบไฟล์ใน Modal ----------
async function grabImages(i, id) {
  let col = null;
  try { col = i.fields.getUploadedFiles(id, false); } catch { col = null; }
  const imgs = [];
  let skipped = 0;
  for (const a of col?.values() ?? []) {
    if (!a.contentType?.startsWith('image/')) { skipped++; continue; }
    let ext = path.extname(a.name || '').toLowerCase();
    if (!/^\.[a-z0-9]{1,5}$/.test(ext)) ext = '.png';
    const name = `${crypto.randomBytes(4).toString('hex')}_${imgs.length + 1}${ext}`;
    let buf = null;
    try {
      const r = await fetch(a.url);
      if (r.ok) buf = Buffer.from(await r.arrayBuffer());
    } catch { /* ใช้ลิงก์เดิมแทน */ }
    imgs.push({ name, url: a.url, buf });
  }
  return { imgs, skipped };
}

// ---------- แผงตั้งค่า (ตัวอย่าง + ปุ่มแก้ไข) ----------
const ROOM_KEYS = { rep: 'reportChannelId', disp: 'displayChannelId', adm: 'adminChannelId' };

function panelPayload(g, note) {
  const guild = client.guilds.cache.get(g.guildId);
  const timeOn = g.timestamp !== false;
  const banToReport = g.banTarget === 'report';

  const row1 = new ActionRowBuilder().addComponents(
    mk(`rpt:basic:${g.id}`, '✏️ ข้อความกล่องปุ่มรายงาน'),
    mk(`rpt:images:${g.id}`, '🖼️ รูปกล่อง'),
    mk(`rpt:label:${g.id}`, '🏷️ ปุ่ม / คำถาม'),
    mk(`rpt:tgltime:${g.id}`, `🕒 เวลา: ${timeOn ? 'เปิด' : 'ปิด'}`, timeOn ? ButtonStyle.Success : ButtonStyle.Secondary),
    mk(`rpt:delete:${g.id}`, '🗑️ ลบ', ButtonStyle.Danger),
  );
  const row2 = new ActionRowBuilder().addComponents(
    mk(`rpt:reptext:${g.id}`, '📢 ข้อความรายงาน'),
    mk(`rpt:bantext:${g.id}`, '🔨 ข้อความตอนแบน'),
    mk(`rpt:roles:${g.id}`, '🛡️ ยศทีมงาน'),
    mk(`rpt:bantarget:${g.id}`, `📍 ผลแบนส่งที่: ${banToReport ? 'ห้องปุ่ม' : 'ห้องแสดง'}`),
    mk(`rpt:send:${g.id}`, '📤 ส่งปุ่มจริง', ButtonStyle.Success),
  );
  const menu = (kind, placeholder) => {
    const m = new ChannelSelectMenuBuilder().setCustomId(`rptch:${kind}:${g.id}`).setPlaceholder(placeholder)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
    const cur = g[ROOM_KEYS[kind]];
    if (cur && guild?.channels.cache.has(cur)) m.setDefaultChannels(cur);
    return new ActionRowBuilder().addComponents(m);
  };
  const roles = (g.approverRoles || []).filter((id) => guild?.roles.cache.has(id));
  const room = (k) => (g[ROOM_KEYS[k]] ? `<#${g[ROOM_KEYS[k]]}>` : '**ยังไม่ได้ตั้ง**');
  const info =
    `1️⃣ ห้องแอดมิน (ปุ่มยืนยันแบน): ${room('adm')}\n` +
    `2️⃣ ห้องปุ่มรายงาน: ${room('rep')}\n` +
    `3️⃣ ห้องแสดงรายงาน: ${room('disp')}\n` +
    `🛡️ ทีมงานที่กดแบนได้: ${roles.length ? roles.map((id) => `<@&${id}>`).join(' ') : 'เฉพาะแอดมิน / Manage Server'}\n` +
    `📍 ผลแบนส่งที่: ${banToReport ? 'ห้องปุ่มรายงาน' : 'ห้องแสดงรายงาน (ตอบกลับใต้รายงานเดิม)'}`;

  const sample = {
    preview: true, no: 1, user: '0', username: 'username', displayName: 'ชื่อผู้รายงาน',
    avatar: client.user?.displayAvatarURL(), createdAt: Date.now(),
    text: 'ตัวอย่างรายงาน — ข้อความที่ผู้เล่นเขียนจะมาอยู่ตรงนี้',
  };
  const pub = publicEmbed(g);
  const repE = reportEmbed(g, sample);
  const banE = banEmbed(g, { reporterId: '0', reporterName: 'ชื่อผู้รายงาน', adminId: '0', adminName: 'แอดมิน', no: 1, text: 'ตัวอย่างข้อความยืนยันแบนจากแอดมิน' });
  const fits = pub.length + repE.length + banE.length <= 5500;

  return {
    content: note || `📌 **${g.name}** — ตัวอย่างก่อนส่งจริง\n${info}\n` +
      (fits ? '**กล่อง ①** ปุ่มรายงาน • **②** รายงานที่แสดง • **③** ข้อความตอนแบน\n' : '') +
      'เลือกห้องจากเมนูด้านล่าง แล้วกด **📤 ส่งปุ่มจริง**',
    embeds: fits ? [pub, repE, banE] : [pub],
    components: [row1, row2, menu('rep', '2️⃣ เลือก “ห้องปุ่มรายงาน”'),
      menu('disp', '3️⃣ เลือก “ห้องแสดงรายงาน”'), menu('adm', '1️⃣ เลือก “ห้องแอดมิน”')],
    allowedMentions: { parse: [] },
  };
}

function panelModal(action, g) {
  const m = new ModalBuilder().setCustomId(`rptm:${action}:${g.id}`);
  if (action === 'basic') {
    m.setTitle('ข้อความกล่องปุ่มรายงาน').addLabelComponents(
      txt('title', 'หัวข้อ (- = ไม่มี)', SHORT, g.title ?? DEF.title, 256),
      txt('description', 'ข้อความ (- = ไม่มี)', PARA, g.description ?? DEF.description, 4000),
      txt('color', 'สี HEX', SHORT, g.color || DEF.color, 20, '#ED4245'),
      txt('footer', 'footer (- = ไม่มี)', SHORT, g.footer, 2048),
      txt('name', 'ชื่อระบบ (ใช้ค้นหา)', SHORT, g.name, 50, '', true),
    );
  } else if (action === 'images') {
    m.setTitle('รูปกล่องปุ่มรายงาน').addLabelComponents(
      txt('image', 'รูปใหญ่ (ลิงก์ - = ไม่มี)', SHORT, g.image, 500, 'https://...'),
      txt('thumbnail', 'รูปเล็กมุมขวาบน (ลิงก์)', SHORT, g.thumbnail, 500, 'https://...'),
    );
  } else if (action === 'label') {
    m.setTitle('ปุ่ม / คำถาม').addLabelComponents(
      txt('label', 'ข้อความบนปุ่มรายงาน', SHORT, g.buttonLabel || DEF.buttonLabel, 80, '', true),
      txt('c_btn', 'สีปุ่ม (น้ำเงิน/เทา/เขียว/แดง)', SHORT, BTN_NAMES[g.btnColor] || 'แดง', 10),
      txt('question', 'หัวข้อช่องเขียนรายงาน', SHORT, g.question || DEF.question, 45),
      txt('banlabel', 'ข้อความปุ่มแอดมิน (ยืนยันแบน)', SHORT, g.banLabel || DEF.banLabel, 80),
    );
  } else {
    const kind = action === 'reptext' ? 'rep' : 'ban';
    const b = boxOf(g, kind);
    m.setTitle(kind === 'rep' ? 'ข้อความรายงานที่แสดง' : 'ข้อความตอนแบน').addLabelComponents(
      txt('title', 'หัวข้อ (- = ไม่มี)', SHORT, b.title, 256, '{no}=เลขรายงาน {name}=ชื่อผู้รายงาน'),
      txt('description', 'ข้อความ ({text} = ข้อความจริง)', PARA, b.description, 1000,
        '{text} {user}=แท็กผู้รายงาน {name} {no}' + (kind === 'ban' ? ' {admin}=แท็กแอดมิน' : '')),
      txt('color', 'สี HEX', SHORT, b.color, 20, '#57F287'),
      txt('footer', 'footer (- = ไม่มี)', SHORT, b.footer, 300),
    );
  }
  return m;
}

// ---------- ปุ่มในแผงตั้งค่า ----------
async function handlePanelButton(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่แก้ระบบนี้ได้');
  const [, action, id] = i.customId.split(':');
  const g = panelById(i.guildId, id);
  if (!g) return bad(i, 'ไม่พบระบบนี้แล้ว (อาจถูกลบไป)');

  if (['basic', 'images', 'label', 'reptext', 'bantext'].includes(action)) return i.showModal(panelModal(action, g));
  if (action === 'tgltime') { g.timestamp = g.timestamp === false; save(); return i.update(panelPayload(g)); }
  if (action === 'bantarget') { g.banTarget = g.banTarget === 'report' ? 'display' : 'report'; save(); return i.update(panelPayload(g)); }
  if (action === 'roles') {
    const m = new RoleSelectMenuBuilder().setCustomId(`rptroles:${g.id}`)
      .setPlaceholder('เลือกยศทีมงานที่กดยืนยันแบนได้ + ถูกแท็ก (ไม่เลือก = เฉพาะแอดมิน)')
      .setMinValues(0).setMaxValues(10);
    const cur = (g.approverRoles || []).filter((r) => i.guild.roles.cache.has(r)).slice(0, 10);
    if (cur.length) m.setDefaultRoles(...cur);
    return i.reply({ content: '🛡️ เลือกยศทีมงาน', components: [new ActionRowBuilder().addComponents(m)], flags: MessageFlags.Ephemeral });
  }
  if (action === 'send') {
    if (!g.reportChannelId) return bad(i, 'ยังไม่ได้เลือก “ห้องปุ่มรายงาน” (เมนูที่ 2)');
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const err = await sendPublic(g, i.guild, g.reportChannelId);
    return i.editReply(err ? `❌ ${err}` : `✅ ส่งปุ่มรายงานไปที่ <#${g.reportChannelId}> แล้ว`);
  }
  if (action === 'delete') {
    return i.reply({
      content: `⚠️ ยืนยันลบระบบ **${g.name}** ?`,
      components: [new ActionRowBuilder().addComponents(mk(`rpt:delok:${g.id}`, 'ยืนยันลบ', ButtonStyle.Danger))],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (action === 'delok') {
    data.reports[i.guildId] = guildPanels(i.guildId).filter((x) => x.id !== g.id);
    save();
    return i.update({ content: `🗑️ ลบระบบ **${g.name}** แล้ว (ปุ่มที่ส่งไปแล้วจะกดไม่ได้อีก)`, components: [] });
  }
}

async function handlePanelModal(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่แก้ระบบนี้ได้');
  const [, action, id] = i.customId.split(':');
  const g = panelById(i.guildId, id);
  if (!g) return bad(i, 'ไม่พบระบบนี้แล้ว (อาจถูกลบไป)');
  const get = (k) => { const v = i.fields.getTextInputValue(k).trim(); return v === '' || v === '-' ? null : v; };
  const color = (v, fb) => {
    if (!v) return fb;
    if (!isHex(v)) throw new Error('สี HEX ไม่ถูกต้อง เช่น #ED4245');
    return fixHex(v);
  };
  const url = (v) => {
    if (v && !/^https?:\/\/\S+$/i.test(v)) throw new Error('ลิงก์รูปต้องขึ้นต้นด้วย https://');
    return v;
  };
  try {
    if (action === 'basic') {
      const name = get('name');
      if (!name) throw new Error('ชื่อระบบห้ามว่าง');
      const dup = findPanel(i.guildId, name);
      if (dup && dup.id !== g.id) throw new Error(`มีระบบชื่อ **${name}** อยู่แล้ว`);
      g.title = get('title') ?? ''; g.description = get('description') ?? '';
      g.color = color(get('color'), DEF.color); g.footer = get('footer'); g.name = name;
    } else if (action === 'images') {
      g.image = url(get('image')); g.thumbnail = url(get('thumbnail'));
    } else if (action === 'label') {
      g.buttonLabel = get('label');
      const c = get('c_btn');
      if (c && !BTN_ALIASES[norm(c)]) throw new Error('สีปุ่มต้องเป็น น้ำเงิน / เทา / เขียว / แดง');
      g.btnColor = c ? BTN_ALIASES[norm(c)] : null;
      g.question = get('question'); g.banLabel = get('banlabel');
    } else {
      const key = action === 'reptext' ? 'repBox' : 'banBox';
      g[key] = {
        title: get('title') ?? '', description: get('description') ?? '{text}',
        color: color(get('color'), BOX_DEFAULT[action === 'reptext' ? 'rep' : 'ban'].color), footer: get('footer'),
      };
    }
  } catch (e) { return bad(i, e.message); }
  save();
  return i.isFromMessage() ? i.update(panelPayload(g)) : i.reply({ ...panelPayload(g), flags: MessageFlags.Ephemeral });
}

// เลือกห้อง / ยศ
async function handleChannelSelect(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้น');
  const [, kind, id] = i.customId.split(':');
  const g = panelById(i.guildId, id);
  if (!g || !ROOM_KEYS[kind]) return bad(i, 'ไม่พบระบบนี้แล้ว');
  const ch = i.channels.first();
  g[ROOM_KEYS[kind]] = ch.id;
  save();
  const me = i.guild.members.me;
  const perms = ch.permissionsFor(me);
  const need = [['SendMessages', 'ส่งข้อความ'], ['EmbedLinks', 'ฝัง Embed'], ['AttachFiles', 'แนบไฟล์']]
    .filter(([f]) => !perms?.has(PermissionFlagsBits[f])).map(([, t]) => t);
  const warn = need.length ? `⚠️ บอทยังไม่มีสิทธิ์ ${need.join(' / ')} ใน <#${ch.id}>` : null;
  return i.update(warn ? panelPayload(g, `${warn}\n(ให้สิทธิ์บอทในห้องนั้นก่อนใช้งานจริง)`) : panelPayload(g));
}
async function handleRoleSelect(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้น');
  const g = panelById(i.guildId, i.customId.split(':')[1]);
  if (!g) return bad(i, 'ไม่พบระบบนี้แล้ว');
  g.approverRoles = [...i.values];
  save();
  return i.update({
    content: g.approverRoles.length ? `✅ ทีมงานที่กดแบนได้: ${g.approverRoles.map((r) => `<@&${r}>`).join(' ')}` : '✅ ตั้งเป็นเฉพาะแอดมิน',
    components: [], allowedMentions: { parse: [] },
  });
}

// ---------- ส่งปุ่มจริง ----------
async function sendPublic(g, guild, channelId) {
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch?.isTextBased()) return 'ไม่พบห้องนี้ หรือบอทมองไม่เห็นห้อง';
  try { await ch.send(publicPayload(g)); return null; }
  catch (e) { return `ส่งไม่สำเร็จ: ${e.message} (เช็คสิทธิ์บอทในห้อง)`; }
}

// ---------- /setreport ----------
async function handleSetReport(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่ใช้คำสั่งนี้ได้');
  const sub = i.options.getSubcommand();
  const gid = i.guildId;

  if (sub === 'create') {
    const name = i.options.getString('name').trim();
    if (!name) return bad(i, 'ชื่อระบบห้ามว่าง');
    if (findPanel(gid, name)) return bad(i, `มีระบบชื่อ **${name}** อยู่แล้ว (ใช้ /setreport edit เพื่อแก้ของเดิม)`);
    const g = {
      id: crypto.randomBytes(4).toString('hex'), guildId: gid, name,
      title: DEF.title, description: DEF.description, color: DEF.color,
      image: null, thumbnail: null, footer: null, timestamp: true,
      buttonLabel: null, btnColor: null, question: null, banLabel: null,
      reportChannelId: null, displayChannelId: null, adminChannelId: null,
      approverRoles: [], banTarget: 'display', counter: 0,
      createdBy: i.user.id, createdAt: Date.now(),
    };
    guildPanels(gid).push(g);
    save();
    return i.reply(panelPayload(g, `✅ สร้างระบบ **${name}** แล้ว\n**ขั้นตอนต่อไป:** เลือกห้องทั้ง 3 จากเมนู (1️⃣ แอดมิน • 2️⃣ ปุ่มรายงาน • 3️⃣ แสดงรายงาน) แล้วกด **📤 ส่งปุ่มจริง**`));
  }
  if (sub === 'list') {
    const list = guildPanels(gid);
    if (!list.length) return bad(i, 'ยังไม่มีระบบ ใช้ /setreport create เพื่อสร้าง');
    return i.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`📚 ระบบรายงานที่สร้างไว้ (${list.length})`)
        .setDescription(list.map((g, n) => `**${n + 1}.** \`${g.name}\` — รับแล้ว ${g.counter || 0} รายงาน`).join('\n').slice(0, 4000))],
      flags: MessageFlags.Ephemeral,
    });
  }
  const name = i.options.getString('name');
  const g = findPanel(gid, name);
  if (!g) return bad(i, `ไม่พบระบบชื่อ **${name}** (ดูรายชื่อด้วย /setreport list)`);
  if (sub === 'edit') return i.reply(panelPayload(g));
  if (sub === 'send') {
    const target = i.options.getChannel('channel')?.id || g.reportChannelId || i.channelId;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const err = await sendPublic(g, i.guild, target);
    return i.editReply(err ? `❌ ${err}` : `✅ ส่งปุ่มรายงานไปที่ <#${target}> แล้ว`);
  }
  if (sub === 'delete') {
    data.reports[gid] = guildPanels(gid).filter((x) => x.id !== g.id);
    save();
    return i.reply({ content: `🗑️ ลบระบบ **${g.name}** แล้ว`, flags: MessageFlags.Ephemeral });
  }
}

// =====================================================================
// ฝั่งผู้เล่น: กดปุ่ม → เขียนข้อความ + แนบรูปหลักฐาน → ห้องแสดง + ห้องแอดมิน
// =====================================================================
function readyError(g, guild) {
  if (!g.displayChannelId || !guild.channels.cache.has(g.displayChannelId)) return 'ยังไม่ได้ตั้ง “ห้องแสดงรายงาน”';
  if (!g.adminChannelId || !guild.channels.cache.has(g.adminChannelId)) return 'ยังไม่ได้ตั้ง “ห้องแอดมิน”';
  return null;
}
const waitLeft = (uid) => {
  const left = REPORT_COOLDOWN_MS - (Date.now() - (reportCooldown.get(uid) || 0));
  return left > 0 ? Math.ceil(left / 1000) : 0;
};

async function handleOpen(i) {
  const g = panelById(i.guildId, i.customId.split(':')[1]);
  if (!g) return bad(i, 'ระบบนี้ถูกปิดแล้ว');
  if (readyError(g, i.guild)) return bad(i, 'ระบบรายงานยังตั้งค่าไม่เสร็จ กรุณาแจ้งทีมงาน');
  const w = waitLeft(i.user.id);
  if (w) return bad(i, `ส่งรายงานถี่เกินไป กรุณารออีก ${w} วินาที`);
  return i.showModal(new ModalBuilder().setCustomId(`rptform:${g.id}`).setTitle('รายงานผู้เล่นใช้โปร')
    .addLabelComponents(
      txt('text', g.question || DEF.question, PARA, null, 1500, 'ชื่อผู้เล่น / สิ่งที่พบ / เวลา / เซิร์ฟเวอร์', true),
      upload('files', '📎 รูปหลักฐาน', 'เลือกรูปจากในเครื่อง (สูงสุด 3 รูป)', true, 3),
    ));
}

async function handleForm(i) {
  const g = panelById(i.guildId, i.customId.split(':')[1]);
  if (!g) return bad(i, 'ระบบนี้ถูกปิดแล้ว');
  const text = i.fields.getTextInputValue('text').trim();
  if (text.length < 5) return bad(i, 'กรุณาเขียนรายละเอียดอย่างน้อย 5 ตัวอักษร');
  const w = waitLeft(i.user.id);
  if (w) return bad(i, `ส่งรายงานถี่เกินไป กรุณารออีก ${w} วินาที`);

  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const { imgs, skipped } = await grabImages(i, 'files');
  if (!imgs.length) return i.editReply('❌ ต้องแนบ “รูปภาพ” เป็นหลักฐานอย่างน้อย 1 รูป (รองรับเฉพาะไฟล์รูป)');

  const disp = await i.guild.channels.fetch(g.displayChannelId).catch(() => null);
  const adm = await i.guild.channels.fetch(g.adminChannelId).catch(() => null);
  if (!disp?.isTextBased() || !adm?.isTextBased()) return i.editReply('❌ ระบบรายงานยังตั้งค่าไม่เสร็จ กรุณาแจ้งทีมงาน');

  g.counter = (g.counter || 0) + 1;
  save();
  const r = {
    no: g.counter, user: i.user.id, username: i.user.username,
    displayName: i.member?.displayName || i.user.globalName || i.user.username,
    avatar: i.member?.displayAvatarURL?.() || i.user.displayAvatarURL(),
    text: text.slice(0, 1500), createdAt: Date.now(),
  };

  // 1) ห้อง 3: แสดงรายงาน
  let dispMsg;
  try {
    dispMsg = await trySend(disp, (f) => {
      const p = imgParts(imgs, f);
      return { embeds: [reportEmbed(g, r, p)], files: p.files, allowedMentions: { parse: [] } };
    });
  } catch (e) {
    console.error('ส่งรายงานเข้าห้องแสดงไม่สำเร็จ:', e.message);
    return i.editReply('❌ ส่งรายงานไม่สำเร็จ กรุณาแจ้งทีมงาน (บอทอาจไม่มีสิทธิ์ในห้องแสดงรายงาน)');
  }

  // 2) ห้อง 1: แอดมิน (ปุ่มยืนยันแบน) — เก็บอ้างอิงห้องแสดงไว้ในรหัสปุ่ม
  const approvers = (g.approverRoles || []).filter((id) => i.guild.roles.cache.has(id));
  try {
    await trySend(adm, (f) => {
      const p = imgParts(imgs, f);
      const e = reportEmbed(g, r, p).addFields({ name: '🔗 ข้อความที่แสดง', value: `[ไปที่ข้อความ](${dispMsg.url})` });
      return {
        content: approvers.length ? approvers.map((x) => `<@&${x}>`).join(' ') : undefined,
        embeds: [e], files: p.files,
        components: [new ActionRowBuilder().addComponents(
          mk(`rptban:${disp.id}:${dispMsg.id}:${g.id}:${i.user.id}`, (g.banLabel || DEF.banLabel).slice(0, 80), ButtonStyle.Success))],
        allowedMentions: { roles: approvers, users: [] },
      };
    });
  } catch (e) {
    console.error('ส่งรายงานเข้าห้องแอดมินไม่สำเร็จ:', e.message);
    dispMsg.delete().catch(() => {});
    return i.editReply('❌ ส่งรายงานไม่สำเร็จ กรุณาแจ้งทีมงาน (บอทอาจไม่มีสิทธิ์ในห้องแอดมิน)');
  }

  reportCooldown.set(i.user.id, Date.now());
  return i.editReply(`✅ ส่งรายงาน **#${r.no}** เรียบร้อยแล้ว ดูได้ที่ <#${disp.id}>` +
    (skipped ? `\n(ข้ามไฟล์ที่ไม่ใช่รูป ${skipped} ไฟล์)` : ''));
}

// =====================================================================
// ฝั่งแอดมิน: กด "ยืนยันแบนแล้ว" → เขียนข้อความ + แนบรูป → ส่งตอบกลับใต้รายงานเดิม
// =====================================================================
function canBan(i, g) {
  const m = i.member;
  return !!m && (
    m.permissions.has(PermissionFlagsBits.Administrator) ||
    m.permissions.has(PermissionFlagsBits.ManageGuild) ||
    (g?.approverRoles || []).some((id) => m.roles.cache.has(id)));
}

async function handleBanButton(i) {
  const [, , , panelId] = i.customId.split(':');
  if (!canBan(i, panelById(i.guildId, panelId))) return bad(i, 'เฉพาะแอดมินหรือทีมงานที่ได้รับสิทธิ์เท่านั้น');
  if (banBusy.has(i.message.id)) return bad(i, 'รายงานนี้กำลังถูกดำเนินการอยู่ รอสักครู่');
  return i.showModal(new ModalBuilder()
    .setCustomId(i.customId.replace('rptban:', 'rptbanm:'))
    .setTitle('ยืนยันแบนผู้เล่นแล้ว')
    .addLabelComponents(
      txt('text', 'ข้อความยืนยัน', PARA, null, 1000, 'เช่น แบนผู้เล่นแล้ว ขอบคุณที่แจ้ง', true),
      upload('files', '📎 รูปยืนยัน (ไม่บังคับ)', 'เลือกรูปจากในเครื่อง เช่น รูปหน้าจอแบน (สูงสุด 3 รูป)', false, 3),
    ));
}

async function handleBanModal(i) {
  if (!i.isFromMessage()) return bad(i, 'ใช้งานไม่ได้ ลองกดปุ่มใหม่อีกครั้ง');
  const [, dispChId, dispMsgId, panelId, reporterId] = i.customId.split(':');
  const g = panelById(i.guildId, panelId);
  if (!canBan(i, g)) return bad(i, 'เฉพาะแอดมินหรือทีมงานที่ได้รับสิทธิ์เท่านั้น');
  const emb = i.message.embeds[0];
  if (!emb) return bad(i, 'อ่านข้อมูลรายงานนี้ไม่ได้');
  if (banBusy.has(i.message.id)) return bad(i, 'รายงานนี้กำลังถูกดำเนินการอยู่ รอสักครู่');

  const text = i.fields.getTextInputValue('text').trim();
  if (!text) return bad(i, 'กรุณาเขียนข้อความยืนยัน');

  banBusy.add(i.message.id);
  try {
    await i.deferUpdate();
    const { imgs } = await grabImages(i, 'files');
    const no = (emb.fields.find((f) => f.name.includes('🆔'))?.value || '').replace('#', '') || '?';
    const reporter = await client.users.fetch(reporterId).catch(() => null);

    // ห้องปลายทาง: ค่าเริ่มต้น = ห้องแสดง (ตอบกลับใต้รายงานเดิม) หรือ ห้องปุ่มรายงานถ้าแอดมินเลือกไว้
    const toReport = g?.banTarget === 'report' && g.reportChannelId;
    const target = await i.guild.channels.fetch(toReport ? g.reportChannelId : dispChId).catch(() => null);
    if (!target?.isTextBased()) {
      return i.followUp({ content: '❌ ไม่พบห้องที่จะส่งข้อความ (บอทมองไม่เห็นห้อง)', flags: MessageFlags.Ephemeral });
    }
    const link = `https://discord.com/channels/${i.guildId}/${dispChId}/${dispMsgId}`;
    const ctx = {
      text, no, reporterId, reporterName: reporter?.globalName || reporter?.username || 'ผู้รายงาน',
      adminId: i.user.id, adminName: i.member?.displayName || i.user.username, link: toReport ? link : null,
    };

    let sent;
    try {
      sent = await trySend(target, (f) => {
        const p = imgParts(imgs, f);
        return {
          content: `<@${reporterId}>`,
          embeds: [banEmbed(g, ctx, p)], files: p.files,
          reply: toReport ? undefined : { messageReference: dispMsgId, failIfNotExists: false },
          allowedMentions: { users: [reporterId], parse: [] },
        };
      });
    } catch (e) {
      console.error('ส่งข้อความแบนไม่สำเร็จ:', e.message);
      return i.followUp({ content: '❌ ส่งข้อความไม่สำเร็จ (บอทอาจไม่มีสิทธิ์ส่งข้อความ/แนบไฟล์ในห้องปลายทาง)', flags: MessageFlags.Ephemeral });
    }

    // อัปเดตสถานะรายงานในห้องแสดง
    let warn = null;
    try {
      const ch = await i.guild.channels.fetch(dispChId);
      const msg = await ch.messages.fetch(dispMsgId);
      await msg.edit({ embeds: [markBanned(msg.embeds[0], null)], allowedMentions: { parse: [] } });
    } catch (e) {
      console.error('อัปเดตรายงานในห้องแสดงไม่สำเร็จ:', e.message);
      warn = '⚠️ อัปเดตสถานะในห้องแสดงรายงานไม่สำเร็จ (ข้อความอาจถูกลบ)';
    }

    // อัปเดตข้อความในห้องแอดมิน (เอาปุ่มออก)
    await i.editReply({
      content: i.message.content || undefined,
      embeds: [markBanned(emb, i.user.id).addFields(
        { name: '💬 ข้อความยืนยัน', value: text.slice(0, 1000) },
        { name: '🔗 ข้อความที่ส่ง', value: `[ไปที่ข้อความ](${sent.url})` })],
      components: [],
      allowedMentions: { parse: [] },
    });
    if (warn) i.followUp({ content: warn, flags: MessageFlags.Ephemeral }).catch(() => {});
  } finally {
    banBusy.delete(i.message.id);
  }
}

// ---------- ลงทะเบียนคำสั่ง ----------
const registerCommands = (guild) => guild.commands.set([setReportCmd]).catch(console.error);
client.once(Events.ClientReady ?? 'ready', async () => {
  console.log(`🤖 ล็อกอินเป็น ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) registerCommands(guild);
});
client.on(Events.GuildCreate, registerCommands);

// ---------- ตัวจัดการ interaction ----------
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (!i.inGuild()) return;
    if (i.isAutocomplete() && i.commandName === 'setreport') {
      const q = norm(i.options.getFocused());
      return await i.respond(guildPanels(i.guildId).filter((p) => norm(p.name).includes(q)).slice(0, 25)
        .map((p) => ({ name: p.name.slice(0, 100), value: p.name })));
    }
    if (i.isChatInputCommand() && i.commandName === 'setreport') return await handleSetReport(i);

    const id = i.customId || '';
    if (i.isButton()) {
      if (id.startsWith('rpt:')) return await handlePanelButton(i);
      if (id.startsWith('rpt_open:')) return await handleOpen(i);
      if (id.startsWith('rptban:')) return await handleBanButton(i);
    }
    if (i.isModalSubmit()) {
      if (id.startsWith('rptm:')) return await handlePanelModal(i);
      if (id.startsWith('rptform:')) return await handleForm(i);
      if (id.startsWith('rptbanm:')) return await handleBanModal(i);
    }
    if (i.isChannelSelectMenu() && id.startsWith('rptch:')) return await handleChannelSelect(i);
    if (i.isRoleSelectMenu() && id.startsWith('rptroles:')) return await handleRoleSelect(i);
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
