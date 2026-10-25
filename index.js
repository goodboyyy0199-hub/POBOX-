require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ChannelType, PermissionFlagsBits, MessageFlags, SlashCommandBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

// =====================================================================
//  บอทระบบ Report (คำสั่ง /setreport)
//   1) แอดมินสร้างแผง Embed + ปุ่ม Report ด้วย /setreport (มีพรีวิว + ปุ่มแก้ไข + เมนูเลือกห้อง/หมวดหมู่)
//   2) ผู้เล่นกดปุ่ม → กรอกรายละเอียด (เกิน 5 ตัวอักษร) + ลิงก์รูปหลักฐาน (อย่างน้อย 1 รูป)
//   3) บอทสร้างห้อง report-0001 ในหมวดหมู่ที่ตั้งไว้ พร้อมปุ่ม "ตรวจพบโปรแกรมโกง" / "ไม่ตรวจพบสิ่งผิดปกติ"
//   4) แอดมินกดปุ่ม → กรอกข้อความ/รูปผลตรวจ (ไม่บังคับ) → บอทส่งผลให้ผู้เล่นทาง DM แล้วลบห้องหลัง 5 วินาที
//  เก็บข้อมูลได้ทั้ง MongoDB (ตั้ง MONGODB_URI) และไฟล์ JSON (report-data.json)
// =====================================================================

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

// ---------- Keep Alive (กันบอทหลับ) ----------
const app = express();
app.get('/', (req, res) => res.send('Report bot is alive!'));
app.get('/health', (req, res) => res.json({ ok: true, discordReady: client.isReady(), uptimeSec: Math.round(process.uptime()) }));
app.listen(process.env.PORT || 3000, () => console.log('🌐 Web server is running'));

// ปลุกตัวเองทุก 5 นาที (ปรับได้ที่ KEEP_ALIVE_MINUTES)
// URL: Render ตั้ง RENDER_EXTERNAL_URL ให้อัตโนมัติ / ที่อื่นให้ตั้ง KEEP_ALIVE_URL เป็น URL ของบอทเอง
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL;
const KEEP_ALIVE_MIN = Number(process.env.KEEP_ALIVE_MINUTES) || 5;
if (KEEP_ALIVE_URL) {
  setInterval(async () => {
    try {
      const res = await fetch(KEEP_ALIVE_URL);
      console.log(`💓 keep-alive ping: ${res.status}`);
    } catch (e) {
      console.error('keep-alive ping ล้มเหลว:', e.message);
    }
  }, KEEP_ALIVE_MIN * 60 * 1000);
  console.log(`💓 keep-alive เปิดอยู่ → ${KEEP_ALIVE_URL} (ทุก ${KEEP_ALIVE_MIN} นาที)`);
} else {
  console.log('⚠️ ไม่พบ RENDER_EXTERNAL_URL / KEEP_ALIVE_URL จึงไม่เปิด keep-alive ในตัวบอท (ตั้ง KEEP_ALIVE_URL หรือใช้ UptimeRobot)');
}

// ---------- Config ----------
const MONGODB_URI = process.env.MONGODB_URI || '';
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || '';   // ยศทีมงานกลาง (ตั้งแยกต่อแผงได้จากเมนูในแผง)
const CATEGORY_ID = process.env.CATEGORY_ID || '';       // หมวดหมู่ห้อง report (ตั้งแยกต่อแผงได้จากเมนูในแผง)
const MIN_DETAIL = 6;                                    // "เกิน 5 ตัวอักษร" = 6 ตัวขึ้นไป (แก้เป็น 5 ได้ถ้าหมายถึง 5 ตัวขึ้นไป)
const MAX_IMAGES = 4;                                    // แนบลิงก์รูปได้สูงสุดกี่รูป
const DELETE_DELAY_MS = 5 * 1000;                        // ลบห้องหลังส่งผลแล้ว 5 วินาที
const COOLDOWN_MS = (Number(process.env.REPORT_COOLDOWN_SECONDS ?? 60) || 0) * 1000; // กันสแปม (0 = ปิด)
const STATUS_PENDING = '⏳ รอแอดมินตรวจสอบ';

const DEFAULT_CHEAT_MSG = 'ทีมงานตรวจสอบรายงานของคุณแล้ว พบการใช้โปรแกรมโกง และได้ดำเนินการเรียบร้อย ขอบคุณที่ช่วยแจ้งครับ';
const DEFAULT_CLEAN_MSG = 'ทีมงานตรวจสอบรายงานของคุณแล้ว ไม่พบสิ่งผิดปกติ ขอบคุณที่แจ้งครับ';

// ---------- เก็บข้อมูล ----------
// ถ้าตั้ง MONGODB_URI → เก็บถาวรใน MongoDB / ถ้าไม่ตั้ง → เก็บใน report-data.json
// (บน Render/Replit ฟรี ไฟล์ JSON จะหายเมื่อรีสตาร์ท แนะนำให้ใช้ MongoDB)
const DATA_FILE = path.join(__dirname, 'report-data.json');
const MONGO_DOC = process.env.MONGODB_DOC || 'report-bot';
let data = { counters: {}, panels: {}, reports: {} };
let mongoCol = null;
let saveTimer = null;

async function loadData() {
  if (MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    const mc = new MongoClient(MONGODB_URI);
    await mc.connect();
    mongoCol = mc.db(process.env.MONGODB_DB || 'reportbot').collection('botdata');
    const doc = await mongoCol.findOne({ _id: MONGO_DOC });
    if (doc && doc.data) data = doc.data;
    console.log('🗄️ เชื่อมต่อ MongoDB สำเร็จ (ข้อมูลเก็บถาวร)');
  } else {
    try {
      if (fs.existsSync(DATA_FILE)) data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      console.error('อ่าน report-data.json ไม่สำเร็จ เริ่มใหม่:', e);
    }
    console.log('⚠️ ไม่ได้ตั้ง MONGODB_URI → เก็บข้อมูลเป็นไฟล์ JSON (บนโฮสต์ฟรีอาจหายเมื่อรีสตาร์ท)');
  }
  data.counters ||= {};
  data.panels ||= {};
  data.reports ||= {};
}

const writeMongo = () =>
  mongoCol.replaceOne({ _id: MONGO_DOC }, { _id: MONGO_DOC, data }, { upsert: true })
    .catch((e) => console.error('บันทึก MongoDB ไม่สำเร็จ:', e.message));

function save() {
  if (mongoCol) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeMongo, 500);
  } else {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
    catch (e) { console.error('บันทึก report-data.json ไม่สำเร็จ:', e); }
  }
}

// Render ส่ง SIGTERM ตอน deploy → บันทึกให้เสร็จก่อนปิด
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bad = (i, text) => i.reply({ content: `❌ ${text}`, flags: MessageFlags.Ephemeral });
const isAdmin = (i) => i.memberPermissions?.has(PermissionFlagsBits.Administrator);

// สีปุ่ม: Discord มีให้เลือกแค่ 4 สี (น้ำเงิน / เทา / เขียว / แดง) ใช้ HEX ไม่ได้
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
const parseBtnColor = (v) => {
  if (!v) return null;
  const k = BTN_ALIASES[norm(v)];
  if (!k) throw new Error(`สีปุ่ม "${v}" ใช้ไม่ได้ ต้องเป็น น้ำเงิน / เทา / เขียว / แดง (Discord มีให้แค่ 4 สีนี้)`);
  return k;
};
const btnStyle = (name, fallback) => BTN_STYLES[name] ?? fallback;

const guildPanels = (gid) => (data.panels[gid] ||= []);
const findPanel = (gid, name) => guildPanels(gid).find((p) => norm(p.name) === norm(name));
const panelById = (gid, id) => guildPanels(gid).find((p) => p.id === id);

// อ่านลิงก์รูปจากข้อความ (คั่นด้วยบรรทัดใหม่/เว้นวรรค/คอมมา) ต้องเป็นลิงก์รูปตรง (.png .jpg .jpeg .gif .webp)
const IMG_EXT = /\.(png|jpe?g|gif|webp)$/i;
function parseImages(text) {
  const parts = String(text || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const urls = [];
  for (const part of parts) {
    let u;
    try { u = new URL(part); } catch { return { error: `ลิงก์ไม่ถูกต้อง: ${part.slice(0, 60)}` }; }
    if (!/^https?:$/.test(u.protocol) || !IMG_EXT.test(u.pathname)) {
      return { error: `ต้องเป็นลิงก์รูปภาพโดยตรง (ลงท้าย .png .jpg .jpeg .gif .webp) เช่นลิงก์จาก i.imgur.com หรือ Discord: ${part.slice(0, 60)}` };
    }
    if (!urls.includes(u.href)) urls.push(u.href);
  }
  if (urls.length > MAX_IMAGES) return { error: `แนบลิงก์รูปได้สูงสุด ${MAX_IMAGES} รูป` };
  return { urls };
}

// ใส่รูปลง Embed: รูปแรกในกล่องหลัก รูปที่เหลือต่อเป็นแกลเลอรี (Embed ที่ url เดียวกันจะรวมเป็นกลุ่มรูป)
function withImages(main, urls, groupUrl) {
  if (!urls || !urls.length) return [main];
  main.setImage(urls[0]);
  if (urls.length === 1) return [main];
  main.setURL(groupUrl);
  return [main, ...urls.slice(1).map((u) => new EmbedBuilder().setURL(groupUrl).setImage(u))];
}

// ---------- Slash command: /setreport ----------
const nameOpt = (o, auto, desc) => o.setName('name').setDescription(desc || 'ชื่อแผง Report')
  .setRequired(true).setMaxLength(50).setAutocomplete(auto);

const reportCmd = new SlashCommandBuilder()
  .setName('setreport')
  .setDescription('สร้างและจัดการแผง Report พร้อมปุ่มรายงาน (เฉพาะแอดมิน)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(s => s.setName('create')
    .setDescription('สร้างแผง Report ใหม่ตั้งชื่อ (ห้ามซ้ำ) แล้วแก้ไขด้วยปุ่มใต้ตัวอย่าง')
    .addStringOption(o => nameOpt(o, false, 'ตั้งชื่อแผง (ห้ามซ้ำกับที่มีอยู่)')))
  .addSubcommand(s => s.setName('edit')
    .setDescription('เปิดกล่องตัวอย่าง + ปุ่มแก้ไข ของแผงที่สร้างไว้')
    .addStringOption(o => nameOpt(o, true)))
  .addSubcommand(s => s.setName('list').setDescription('ดูรายชื่อแผง Report ทั้งหมดที่สร้างไว้'))
  .addSubcommand(s => s.setName('send').setDescription('ส่งแผง Report จริงไปยังห้องที่ต้องการ')
    .addStringOption(o => nameOpt(o, true))
    .addChannelOption(o => o.setName('channel').setDescription('ห้องที่จะส่ง (ไม่เลือก = ห้องนี้)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand(s => s.setName('delete').setDescription('ลบแผง Report ที่สร้างไว้')
    .addStringOption(o => nameOpt(o, true)))
  .toJSON();

// ---------- Embed แผงที่ผู้เล่นเห็น ----------
function buildPublicEmbed(p) {
  const emb = new EmbedBuilder().setColor(p.color || 0xed4245);
  if (p.author) emb.setAuthor({ name: p.author.slice(0, 256), iconURL: p.authorIcon || undefined });
  if (p.title) emb.setTitle(p.title.slice(0, 256));
  if (p.description) emb.setDescription(p.description.slice(0, 4096));
  if (p.image) emb.setImage(p.image);
  if (p.thumbnail) emb.setThumbnail(p.thumbnail);
  if (p.footer) emb.setFooter({ text: p.footer.slice(0, 2048) });
  if (p.timestamp !== false) emb.setTimestamp();
  return emb;
}
const hasContent = (p) => !!(p.title || p.description || p.image || p.author || p.footer || p.thumbnail);

// ปุ่ม Report ของจริง (ใต้ Embed ที่ส่งไปแล้ว)
const publicPayload = (p) => ({
  embeds: [buildPublicEmbed(p)],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rpt_open:${p.id}`)
      .setLabel((p.buttonLabel || '🚨 รายงาน (Report)').slice(0, 80))
      .setStyle(btnStyle(p.btnReport, ButtonStyle.Danger)),
  )],
});

// ---------- กล่อง Report ในห้องแอดมิน ----------
function reportEmbeds(info, groupUrl, preview = false) {
  const main = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`🚨 Report #${info.number}`)
    .setDescription(String(info.details).slice(0, 4000))
    .addFields(
      { name: '👤 ผู้รายงาน', value: `<@${info.reporter}>`, inline: true },
      { name: '📌 สถานะ', value: STATUS_PENDING, inline: true },
    )
    .setTimestamp(info.createdAt || Date.now());
  if (preview) main.setFooter({ text: 'ตัวอย่างกล่องในห้องแอดมิน (ห้อง report-xxxx)' });
  return withImages(main, info.images, groupUrl);
}

// ปุ่มผลตรวจในห้องแอดมิน
const resultRow = (p) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('rptres:cheat')
    .setLabel(((p && p.cheatLabel) || '🚨 ตรวจพบโปรแกรมโกง').slice(0, 80)).setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId('rptres:clean')
    .setLabel(((p && p.cleanLabel) || '✅ ไม่ตรวจพบสิ่งผิดปกติ').slice(0, 80)).setStyle(ButtonStyle.Success),
);

// ---------- กล่องตัวอย่าง + ปุ่มแก้ไข ----------
const mk = (id, label, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

function panelPayload(p, note) {
  const guild = client.guilds.cache.get(p.guildId);
  const timeOn = p.timestamp !== false;

  const row1 = new ActionRowBuilder().addComponents(
    mk(`rptp:basic:${p.id}`, '✏️ ข้อมูลพื้นฐาน'),
    mk(`rptp:images:${p.id}`, '🖼️ รูปภาพ'),
    mk(`rptp:buttons:${p.id}`, '🔘 ปุ่ม'),
    mk(`rptp:meta:${p.id}`, '👤 ผู้เขียน / footer'),
    mk(`rptp:results:${p.id}`, '📨 ข้อความผลตรวจ'),
  );
  const row2 = new ActionRowBuilder().addComponents(
    mk(`rptp:tgltime:${p.id}`, `🕒 เวลา: ${timeOn ? 'เปิด' : 'ปิด'}`, timeOn ? ButtonStyle.Success : ButtonStyle.Secondary),
    mk(`rptp:delete:${p.id}`, '🗑️ ลบแผง', ButtonStyle.Danger),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`rptsend:${p.id}`)
      .setPlaceholder('📤 เลือกห้องที่จะส่งแผง Report จริง')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );

  const catMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`rptcat:${p.id}`)
    .setPlaceholder('📁 เลือกหมวดหมู่ที่ห้องแอดมิน (report-xxxx) จะไปอยู่')
    .addChannelTypes(ChannelType.GuildCategory);
  if (p.categoryId && guild?.channels.cache.has(p.categoryId)) catMenu.setDefaultChannels(p.categoryId);
  const row4 = new ActionRowBuilder().addComponents(catMenu);

  const roleMenu = new RoleSelectMenuBuilder()
    .setCustomId(`rptrole:${p.id}`)
    .setPlaceholder('🛡️ เลือกยศทีมงานที่เห็นห้อง report + กดผลตรวจได้ (ได้หลายยศ)')
    .setMinValues(0)
    .setMaxValues(10);
  const roleDefaults = (p.staffRoles || []).filter((id) => guild?.roles.cache.has(id)).slice(0, 10);
  if (roleDefaults.length) roleMenu.setDefaultRoles(...roleDefaults);
  const row5 = new ActionRowBuilder().addComponents(roleMenu);

  const roleLine = roleDefaults.length ? roleDefaults.map((r) => `<@&${r}>`).join(' ')
    : STAFF_ROLE_ID ? `<@&${STAFF_ROLE_ID}> (จากค่า STAFF_ROLE_ID)` : '**ยังไม่ได้ตั้ง** (เฉพาะแอดมิน/คนมีสิทธิ์จัดการห้อง)';
  const catLine = p.categoryId ? `<#${p.categoryId}>`
    : CATEGORY_ID ? `<#${CATEGORY_ID}> (จากค่า CATEGORY_ID)`
    : '**ยังไม่ได้ตั้ง** (ห้องจะขึ้นนอกหมวดหมู่ ตั้งได้จากเมนูด้านล่าง)';
  const info =
    `ปุ่มใต้ Embed: **${p.buttonLabel || '🚨 รายงาน (Report)'}** (สี${BTN_NAMES[p.btnReport] || 'แดง'})\n` +
    `ปุ่มในห้องแอดมิน: **${p.cheatLabel || '🚨 ตรวจพบโปรแกรมโกง'}** / **${p.cleanLabel || '✅ ไม่ตรวจพบสิ่งผิดปกติ'}**\n` +
    `📁 หมวดหมู่ห้อง report: ${catLine}\n🛡️ ยศทีมงาน: ${roleLine}\n` +
    '🎫 กล่องที่สองด้านล่าง = ตัวอย่างกล่องที่จะขึ้นในห้องแอดมิน';

  const sample = { number: '0001', reporter: p.createdBy, details: 'ตัวอย่างรายละเอียดที่ผู้เล่นกรอก', images: [], createdAt: Date.now() };
  return {
    content: note || `📌 **${p.name}** — ตัวอย่างก่อนส่งจริง\n${info}\nแก้ไขด้วยปุ่มด้านล่าง แล้วเลือกห้องจากเมนูเพื่อส่งของจริง`,
    embeds: [buildPublicEmbed(p), reportEmbeds(sample, '', true)[0]],
    components: [row1, row2, row3, row4, row5],
    allowedMentions: { parse: [] }, // แสดง @ยศ ได้ แต่ไม่ทำให้ยศถูกแจ้งเตือน
  };
}

// ---------- Modal ----------
const SHORT = TextInputStyle.Short;
const PARA = TextInputStyle.Paragraph;
const field = (id, label, style, opts = {}) => {
  const { value, max = 100, min, placeholder, required = false } = opts;
  const t = new TextInputBuilder().setCustomId(id).setLabel(label.slice(0, 45)).setStyle(style)
    .setRequired(required).setMaxLength(max);
  if (min) t.setMinLength(min);
  if (value) t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
  return new ActionRowBuilder().addComponents(t);
};

function buildPanelModal(action, p) {
  const m = new ModalBuilder().setCustomId(`rptm:${action}:${p.id}`);
  if (action === 'basic') {
    m.setTitle('แก้ข้อมูลพื้นฐาน').addComponents(
      field('title', 'หัวข้อ (เว้นว่าง = ไม่มี)', SHORT, { value: p.title, max: 256 }),
      field('description', 'ข้อความ (เว้นว่าง = ไม่มี)', PARA, { value: p.description, max: 4000 }),
      field('color', 'สี HEX เช่น #ED4245', SHORT, { value: p.color, max: 7 }),
      field('name', 'ชื่อแผง (ห้ามซ้ำ)', SHORT, { value: p.name, max: 50 }),
    );
  } else if (action === 'images') {
    m.setTitle('แก้รูปภาพ').addComponents(
      field('image', 'ลิงก์รูป/GIF ใหญ่', SHORT, { value: p.image, max: 500, placeholder: 'https://...' }),
      field('thumbnail', 'ลิงก์รูปเล็กมุมขวาบน', SHORT, { value: p.thumbnail, max: 500, placeholder: 'https://...' }),
    );
  } else if (action === 'buttons') {
    const hint = 'น้ำเงิน / เทา / เขียว / แดง (เว้นว่าง = แดง)';
    m.setTitle('แก้ข้อความ / สีปุ่ม').addComponents(
      field('label', 'ข้อความบนปุ่ม Report', SHORT, { value: p.buttonLabel, max: 80, placeholder: '🚨 รายงาน (Report)' }),
      field('c_report', 'สีปุ่ม Report', SHORT, { value: BTN_NAMES[p.btnReport], max: 10, placeholder: hint }),
      field('cheat_label', 'ข้อความปุ่ม ตรวจพบโปรแกรมโกง', SHORT, { value: p.cheatLabel, max: 80, placeholder: '🚨 ตรวจพบโปรแกรมโกง' }),
      field('clean_label', 'ข้อความปุ่ม ไม่ตรวจพบ', SHORT, { value: p.cleanLabel, max: 80, placeholder: '✅ ไม่ตรวจพบสิ่งผิดปกติ' }),
    );
  } else if (action === 'meta') {
    m.setTitle('แก้ผู้เขียน / footer').addComponents(
      field('author', 'ชื่อด้านบนสุด (เว้นว่าง = ไม่แสดง)', SHORT, { value: p.author, max: 256 }),
      field('author_icon', 'ลิงก์รูปโปรไฟล์ข้างชื่อ', SHORT, { value: p.authorIcon, max: 500, placeholder: 'https://...' }),
      field('footer', 'ข้อความท้าย Embed (เว้นว่าง = ไม่มี)', SHORT, { value: p.footer, max: 2048 }),
    );
  } else if (action === 'results') {
    m.setTitle('ข้อความผลตรวจ (ค่าเริ่มต้น)').addComponents(
      field('cheat_msg', 'ข้อความเมื่อ ตรวจพบโปรแกรมโกง', PARA, { value: p.cheatMsg, max: 1000, placeholder: DEFAULT_CHEAT_MSG }),
      field('clean_msg', 'ข้อความเมื่อ ไม่พบสิ่งผิดปกติ', PARA, { value: p.cleanMsg, max: 1000, placeholder: DEFAULT_CLEAN_MSG }),
    );
  }
  return m;
}

// ---------- ปุ่มในกล่องตัวอย่าง (แอดมิน) ----------
async function handlePanelButton(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่แก้แผงได้');
  const [, action, id] = i.customId.split(':');
  const p = panelById(i.guildId, id);
  if (!p) return bad(i, 'ไม่พบแผงนี้แล้ว (อาจถูกลบไป)');

  if (['basic', 'images', 'buttons', 'meta', 'results'].includes(action)) {
    return i.showModal(buildPanelModal(action, p));
  }
  if (action === 'tgltime') { p.timestamp = p.timestamp === false; save(); return i.update(panelPayload(p)); }
  if (action === 'delete') {
    return i.reply({
      content: `⚠️ ยืนยันลบแผง **${p.name}** ?`,
      components: [new ActionRowBuilder().addComponents(mk(`rptp:delok:${p.id}`, 'ยืนยันลบ', ButtonStyle.Danger))],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (action === 'delok') {
    data.panels[i.guildId] = guildPanels(i.guildId).filter((x) => x.id !== p.id);
    save();
    return i.update({ content: `🗑️ ลบแผง **${p.name}** แล้ว (ปุ่มที่ส่งไปแล้วจะกดไม่ได้อีก)`, components: [] });
  }
}

// ---------- ส่งข้อมูลจาก Modal แก้ไข (แอดมิน) ----------
async function handlePanelModal(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่แก้แผงได้');
  const [, action, id] = i.customId.split(':');
  const p = panelById(i.guildId, id);
  if (!p) return bad(i, 'ไม่พบแผงนี้แล้ว (อาจถูกลบไป)');

  const get = (k) => {
    const v = i.fields.getTextInputValue(k).trim();
    return v === '' || v === '-' ? null : v;
  };
  const urlOrNull = (k) => {
    const v = get(k);
    if (v && !isUrl(v)) throw new Error(`ลิงก์ในช่อง ${k} ไม่ถูกต้อง (ต้องขึ้นต้นด้วย https://)`);
    return v;
  };

  const draft = { ...p };
  try {
    if (action === 'basic') {
      const name = i.fields.getTextInputValue('name').trim();
      if (!name) throw new Error('ชื่อแผงห้ามว่าง');
      const dup = findPanel(i.guildId, name);
      if (dup && dup.id !== p.id) throw new Error(`มีแผงชื่อ **${name}** อยู่แล้ว กรุณาใช้ชื่ออื่น`);
      const color = get('color');
      if (color && !isHex(color)) throw new Error('สีต้องเป็น HEX เช่น #ED4245');
      draft.name = name;
      draft.title = get('title');
      draft.description = get('description');
      draft.color = color ? (color.startsWith('#') ? color : `#${color}`) : null;
    } else if (action === 'images') {
      draft.image = urlOrNull('image');
      draft.thumbnail = urlOrNull('thumbnail');
    } else if (action === 'buttons') {
      draft.buttonLabel = get('label');
      draft.btnReport = parseBtnColor(get('c_report'));
      draft.cheatLabel = get('cheat_label');
      draft.cleanLabel = get('clean_label');
    } else if (action === 'meta') {
      draft.author = get('author');
      draft.authorIcon = urlOrNull('author_icon');
      draft.footer = get('footer');
    } else if (action === 'results') {
      draft.cheatMsg = get('cheat_msg');
      draft.cleanMsg = get('clean_msg');
    }
    if (!hasContent(draft)) throw new Error('แผงต้องมีข้อมูลอย่างน้อย 1 อย่าง (เช่น หัวข้อหรือข้อความ)');
  } catch (err) {
    return bad(i, err.message);
  }

  Object.assign(p, draft);
  save();
  return i.isFromMessage() ? i.update(panelPayload(p)) : i.reply(panelPayload(p));
}

// ---------- เมนูเลือก: ส่งแผงจริง / หมวดหมู่ / ยศทีมงาน ----------
async function handleSendSelect(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้น');
  const p = panelById(i.guildId, i.customId.split(':')[1]);
  if (!p) return bad(i, 'ไม่พบแผงนี้แล้ว (อาจถูกลบไป)');
  const target = i.channels.first();
  try {
    const ch = await i.guild.channels.fetch(target.id);
    await ch.send(publicPayload(p));
    return i.update({ content: `✅ ส่งแผง **${p.name}** ไปที่ <#${ch.id}> แล้ว (เลือกห้องอื่นเพื่อส่งซ้ำได้)` });
  } catch (err) {
    console.error('ส่งแผงไม่สำเร็จ:', err.message);
    return bad(i, `ส่งไม่สำเร็จ: ${err.message} (ตรวจสิทธิ์ดู/ส่งข้อความ/ฝัง Embed ของบอทในห้องนั้น)`);
  }
}

async function handleCategorySelect(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้น');
  const p = panelById(i.guildId, i.customId.split(':')[1]);
  if (!p) return bad(i, 'ไม่พบแผงนี้แล้ว (อาจถูกลบไป)');
  p.categoryId = i.channels.first().id;
  save();
  return i.update(panelPayload(p));
}

async function handleRoleSelect(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้น');
  const p = panelById(i.guildId, i.customId.split(':')[1]);
  if (!p) return bad(i, 'ไม่พบแผงนี้แล้ว (อาจถูกลบไป)');
  p.staffRoles = [...i.values].filter((r) => r !== i.guildId); // ตัด @everyone ออก
  save();
  return i.update(panelPayload(p));
}

// ---------- /setreport ----------
async function handleSetReport(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่ใช้คำสั่งนี้ได้');
  const sub = i.options.getSubcommand();
  const gid = i.guildId;

  if (sub === 'create') {
    const name = i.options.getString('name').trim();
    if (!name) return bad(i, 'ชื่อแผงห้ามว่าง');
    if (findPanel(gid, name)) {
      return bad(i, `มีแผงชื่อ **${name}** อยู่แล้ว กรุณาใช้ชื่ออื่น (หรือใช้ /setreport edit เพื่อแก้ของเดิม)`);
    }
    const p = {
      id: crypto.randomBytes(4).toString('hex'),
      guildId: gid,
      name,
      title: '🚨 รายงานผู้เล่น (Report)',
      description: 'พบผู้เล่นใช้โปรแกรมโกง? กดปุ่มด้านล่างเพื่อส่งรายงาน\n' +
        'กรอกรายละเอียดและแนบลิงก์รูปหลักฐานให้ครบ ทีมงานจะตรวจสอบและแจ้งผลให้ทาง DM\n\n' +
        '⚠️ กรุณาเปิดรับข้อความส่วนตัว (DM) จากสมาชิกในเซิร์ฟเวอร์ไว้ เพื่อรับผลการตรวจสอบ',
      author: null, authorIcon: null, image: null, thumbnail: null, footer: null,
      color: '#ED4245', timestamp: true,
      buttonLabel: null, btnReport: 'danger', cheatLabel: null, cleanLabel: null,
      cheatMsg: null, cleanMsg: null,
      categoryId: null, staffRoles: [],
      createdBy: i.user.id, createdAt: Date.now(),
    };
    guildPanels(gid).push(p);
    save();
    return i.reply(panelPayload(p, `✅ สร้างแผง **${name}** แล้ว — นี่คือตัวอย่างก่อนส่งจริง\n` +
      '**ขั้นตอนต่อไป:** ① เลือกหมวดหมู่ห้องแอดมิน ② เลือกยศทีมงาน ③ เลือกห้องเพื่อส่งแผงจริง'));
  }

  if (sub === 'list') {
    const list = guildPanels(gid);
    if (!list.length) return bad(i, 'ยังไม่มีแผงที่สร้างไว้ ใช้ /setreport create เพื่อสร้าง');
    const lines = list.map((p, n) => `**${n + 1}.** \`${p.name}\`${p.title ? ` — ${p.title}` : ''}`);
    return i.reply({
      embeds: [new EmbedBuilder().setColor(0xed4245)
        .setTitle(`📚 แผง Report ที่สร้างไว้ (${list.length})`)
        .setDescription(lines.join('\n').slice(0, 4000))],
      flags: MessageFlags.Ephemeral,
    });
  }

  const name = i.options.getString('name');
  const p = findPanel(gid, name);
  if (!p) return bad(i, `ไม่พบแผงชื่อ **${name}** (ดูรายชื่อด้วย /setreport list)`);

  if (sub === 'edit') return i.reply(panelPayload(p));

  if (sub === 'send') {
    const target = i.options.getChannel('channel') || i.channel;
    try {
      const ch = await i.guild.channels.fetch(target.id);
      await ch.send(publicPayload(p));
      return i.reply({ content: `✅ ส่งแผง **${p.name}** ไปที่ <#${ch.id}> แล้ว`, flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error('ส่งแผงไม่สำเร็จ:', err.message);
      return bad(i, `ส่งไม่สำเร็จ: ${err.message} (ตรวจสิทธิ์ดู/ส่งข้อความของบอทในห้องนั้น)`);
    }
  }

  if (sub === 'delete') {
    data.panels[gid] = guildPanels(gid).filter((x) => x.id !== p.id);
    save();
    return i.reply({ content: `🗑️ ลบแผง **${p.name}** แล้ว (ข้อความที่ส่งไปแล้วไม่ถูกลบ แต่ปุ่มจะกดไม่ได้อีก)`, flags: MessageFlags.Ephemeral });
  }
}

// =====================================================================
// ฝั่งผู้เล่น: กดปุ่ม → กรอกรายละเอียด + ลิงก์รูป → บอทสร้างห้อง report-xxxx
// =====================================================================
const cooldown = new Map(); // userId → เวลาที่ส่งล่าสุด
const cooldownLeft = (userId) => {
  if (!COOLDOWN_MS) return 0;
  const left = COOLDOWN_MS - (Date.now() - (cooldown.get(userId) || 0));
  return left > 0 ? Math.ceil(left / 1000) : 0;
};

// ผู้เล่นกดปุ่ม Report → เปิด Modal
async function handleOpen(i) {
  const p = panelById(i.guildId, i.customId.split(':')[1]);
  if (!p) return bad(i, 'แผงนี้ถูกปิดแล้ว');
  const wait = cooldownLeft(i.user.id);
  if (wait) return bad(i, `ส่งรายงานถี่เกินไป กรุณารออีก ${wait} วินาที`);

  return i.showModal(new ModalBuilder()
    .setCustomId(`rptform:${p.id}`)
    .setTitle('ส่งรายงาน (Report)')
    .addComponents(
      field('details', 'รายละเอียดปัญหา', PARA, {
        required: true, min: MIN_DETAIL, max: 1500,
        placeholder: 'ชื่อผู้เล่น + สิ่งที่พบ เขียนให้ละเอียด (ยาวเกิน 5 ตัวอักษร)',
      }),
      field('images', 'ลิงก์รูปหลักฐาน (1 ลิงก์ต่อบรรทัด)', PARA, {
        required: true, max: 2000,
        placeholder: `ลิงก์รูปตรง .png .jpg .gif .webp อย่างน้อย 1 รูป สูงสุด ${MAX_IMAGES} รูป`,
      }),
    ));
}

// ผู้เล่นส่งฟอร์ม
async function handleForm(i) {
  const p = panelById(i.guildId, i.customId.split(':')[1]);
  if (!p) return bad(i, 'แผงนี้ถูกปิดแล้ว');

  const details = i.fields.getTextInputValue('details').trim();
  if (details.length < MIN_DETAIL) {
    return bad(i, `รายละเอียดต้องยาวเกิน ${MIN_DETAIL - 1} ตัวอักษร (อย่างน้อย ${MIN_DETAIL} ตัวอักษร)`);
  }
  const img = parseImages(i.fields.getTextInputValue('images'));
  if (img.error) return bad(i, img.error);
  if (!img.urls.length) return bad(i, 'ต้องใส่ลิงก์รูปหลักฐานอย่างน้อย 1 รูป');
  const wait = cooldownLeft(i.user.id);
  if (wait) return bad(i, `ส่งรายงานถี่เกินไป กรุณารออีก ${wait} วินาที`);

  await i.deferReply({ flags: MessageFlags.Ephemeral });

  // นับ 1 → 9999 แล้ววนกลับ
  const prev = data.counters[i.guildId] || 0;
  const n = (prev % 9999) + 1;
  data.counters[i.guildId] = n;
  const number = String(n).padStart(4, '0');

  const allow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
  ];
  // ห้องนี้เห็นเฉพาะทีมงาน + บอท (ผู้เล่นที่รายงานไม่เห็น ผลจะส่งให้ทาง DM)
  const overwrites = [
    { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: client.user.id, allow: [...allow, PermissionFlagsBits.ManageChannels] },
  ];
  const staffIds = [...new Set([STAFF_ROLE_ID, ...(p.staffRoles || [])]
    .filter((id) => id && i.guild.roles.cache.has(id)))];
  for (const id of staffIds) overwrites.push({ id, allow });

  const wantCat = p.categoryId || CATEGORY_ID;
  const catCh = wantCat ? i.guild.channels.cache.get(wantCat) : null;
  const parent = catCh && catCh.type === ChannelType.GuildCategory ? catCh.id : null;
  if (wantCat && !parent) console.error('ไม่พบหมวดหมู่ที่ตั้งไว้ (อาจถูกลบ) สร้างห้องนอกหมวดหมู่แทน:', wantCat);

  let channel;
  try {
    channel = await i.guild.channels.create({
      name: `report-${number}`,
      type: ChannelType.GuildText,
      parent,
      topic: `report:${i.user.id}`, // เก็บไอดีผู้รายงานไว้ในห้อง เผื่อข้อมูลในฐานข้อมูลหาย
      permissionOverwrites: overwrites,
    });
  } catch (err) {
    console.error('สร้างห้อง report ไม่สำเร็จ:', err);
    if (data.counters[i.guildId] === n) { data.counters[i.guildId] = prev; save(); }
    return i.editReply(`❌ สร้างห้องไม่สำเร็จ: ${String(err.message).slice(0, 300)}`);
  }

  const info = {
    number, reporter: i.user.id, panelId: p.id, details: details.slice(0, 1500),
    images: img.urls, createdAt: Date.now(), done: false, deleteAt: null,
  };
  data.reports[channel.id] = info;
  save();

  try {
    await channel.send({
      content: staffIds.length ? staffIds.map((id) => `<@&${id}>`).join(' ') : undefined,
      embeds: reportEmbeds(info, `https://discord.com/channels/${i.guildId}/${channel.id}`),
      components: [resultRow(p)],
      allowedMentions: { roles: staffIds, users: [] },
    });
  } catch (err) {
    console.error('ส่งรายงานเข้าห้องแอดมินไม่สำเร็จ:', err.message);
    delete data.reports[channel.id];
    save();
    channel.delete('ส่งรายงานไม่สำเร็จ').catch(() => {});
    return i.editReply('❌ ส่งรายงานไม่สำเร็จ กรุณาแจ้งทีมงาน (บอทอาจไม่มีสิทธิ์ในหมวดหมู่/ห้องแอดมิน)');
  }

  cooldown.set(i.user.id, Date.now());
  return i.editReply(`✅ ส่งรายงานเรียบร้อย (Report #${number})\nทีมงานจะแจ้งผลให้ทาง **DM** — กรุณาเปิดรับข้อความส่วนตัวจากสมาชิกเซิร์ฟเวอร์ไว้`);
}

// =====================================================================
// ฝั่งแอดมิน: กดปุ่มผลตรวจ → Modal ข้อความ/รูป (ไม่บังคับ) → ส่ง DM → ลบห้องหลัง 5 วินาที
// =====================================================================
const busy = new Set(); // กันแอดมินสองคนกดห้องเดียวกันพร้อมกัน

// ข้อมูลรายงานของห้องนี้ (ถ้าฐานข้อมูลหาย จะกู้ไอดีผู้รายงานจาก topic และเลขจากชื่อห้อง)
function getReport(channel) {
  if (data.reports[channel.id]) return data.reports[channel.id];
  const m = /^report:(\d+)$/.exec(channel.topic || '');
  if (!m) return null;
  return { number: (/report-(\d+)/.exec(channel.name) || [])[1] || '????', reporter: m[1], panelId: null, recovered: true };
}

const canHandle = (i, p) => {
  const m = i.member;
  if (!m) return false;
  if (m.permissions.has(PermissionFlagsBits.Administrator) ||
      m.permissions.has(PermissionFlagsBits.ManageChannels)) return true;
  const ids = [STAFF_ROLE_ID, ...((p && p.staffRoles) || [])].filter(Boolean);
  return ids.some((id) => m.roles.cache.has(id));
};

// แอดมินกดปุ่มผลตรวจ → เปิด Modal
async function handleResButton(i) {
  const info = getReport(i.channel);
  if (!info) return bad(i, 'ไม่พบข้อมูลรายงานของห้องนี้');
  const p = info.panelId ? panelById(i.guildId, info.panelId) : null;
  if (!canHandle(i, p)) return bad(i, 'เฉพาะทีมงานเท่านั้นที่กดผลตรวจได้');
  if (busy.has(i.channelId)) return bad(i, 'รายงานนี้กำลังถูกดำเนินการอยู่ รอสักครู่');

  const cheat = i.customId.split(':')[1] === 'cheat';
  return i.showModal(new ModalBuilder()
    .setCustomId(`rptresm:${cheat ? 'cheat' : 'clean'}`)
    .setTitle(cheat ? '🚨 ตรวจพบโปรแกรมโกง' : '✅ ไม่พบสิ่งผิดปกติ')
    .addComponents(
      field('msg', 'ข้อความตอบกลับถึงผู้เล่น (ไม่บังคับ)', PARA, {
        max: 1000, placeholder: 'เว้นว่างได้ — ถ้าเว้นว่างจะใช้ข้อความเริ่มต้นของแผง',
      }),
      field('images', 'รูปภาพผลการตรวจ (ลิงก์ ไม่บังคับ)', PARA, {
        max: 2000, placeholder: `เว้นว่างได้ — ลิงก์รูปตรง 1 ลิงก์ต่อบรรทัด สูงสุด ${MAX_IMAGES} รูป`,
      }),
    ));
}

// ลบห้อง (ลองซ้ำ 3 ครั้ง) แล้วเลิกติดตามรายงานนั้น
async function removeReportChannel(channelId) {
  delete data.reports[channelId];
  save();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ch = await client.channels.fetch(channelId);
      if (ch) await ch.delete('ตรวจสอบรายงานเสร็จสิ้น');
      return true;
    } catch (err) {
      if (err.code === 10003) return true; // ห้องถูกลบไปแล้ว
      console.error(`ลบห้อง ${channelId} ไม่สำเร็จ (ครั้งที่ ${attempt}):`, err.message);
      await sleep(1500 * attempt);
    }
  }
  console.error(`⚠️ ลบห้อง ${channelId} ไม่สำเร็จ ตรวจสิทธิ์ "จัดการช่อง" ของบอทในหมวดหมู่/ห้องนั้น`);
  return false;
}
const scheduleRemove = (channelId, delayMs) => setTimeout(() => removeReportChannel(channelId), Math.max(delayMs, 0));

// เปลี่ยน Embed แรกเป็นสถานะ "ตรวจแล้ว" (อ่านจากตัวข้อความเอง) Embed รูปอื่นคงเดิม
function markHandled(embeds, label, byId) {
  return embeds.map((emb, n) => {
    if (n > 0) return EmbedBuilder.from(emb);
    return EmbedBuilder.from(emb).setColor(0x57f287).setFields((emb.fields || []).map((f) => (
      f.name.includes('สถานะ')
        ? { name: f.name, value: `${label}\nโดย <@${byId}>`, inline: !!f.inline }
        : { name: f.name, value: f.value, inline: !!f.inline }
    )));
  });
}

// แอดมินกดยืนยันใน Modal ผลตรวจ
async function handleResSubmit(i) {
  const cheat = i.customId.split(':')[1] === 'cheat';
  const info = getReport(i.channel);
  if (!info) return bad(i, 'ไม่พบข้อมูลรายงานของห้องนี้');
  const p = info.panelId ? panelById(i.guildId, info.panelId) : null;
  if (!canHandle(i, p)) return bad(i, 'เฉพาะทีมงานเท่านั้นที่กดผลตรวจได้');

  const img = parseImages(i.fields.getTextInputValue('images'));
  if (img.error) return bad(i, img.error);
  if (busy.has(i.channelId)) return bad(i, 'รายงานนี้กำลังถูกดำเนินการอยู่ รอสักครู่');
  if (info.done) return bad(i, 'รายงานนี้ตรวจสอบเสร็จแล้ว (ห้องกำลังจะถูกลบ)');

  busy.add(i.channelId);
  try {
    if (i.isFromMessage()) await i.deferUpdate();
    else await i.deferReply({ flags: MessageFlags.Ephemeral });

    const typed = i.fields.getTextInputValue('msg').trim();
    const text = typed || (cheat ? (p?.cheatMsg || DEFAULT_CHEAT_MSG) : (p?.cleanMsg || DEFAULT_CLEAN_MSG));
    const label = cheat ? '🚨 ตรวจพบโปรแกรมโกง' : '✅ ไม่ตรวจพบสิ่งผิดปกติ';

    // 1) ส่งผลให้ผู้เล่นทาง DM
    const dm = new EmbedBuilder()
      .setColor(cheat ? 0x57f287 : 0x5865f2)
      .setTitle(cheat ? '✅ ผลการตรวจสอบ: ตรวจพบโปรแกรมโกง' : 'ℹ️ ผลการตรวจสอบ: ไม่พบสิ่งผิดปกติ')
      .setDescription(text.slice(0, 4000))
      .addFields({ name: '📄 รายงานของคุณ', value: `Report #${info.number}`, inline: true })
      .setFooter({ text: i.guild.name })
      .setTimestamp();
    try {
      const user = await client.users.fetch(info.reporter);
      await user.send({ embeds: withImages(dm, img.urls, `https://discord.com/channels/${i.guildId}`) });
    } catch (err) {
      console.error(`ส่ง DM ถึง ${info.reporter} ไม่สำเร็จ:`, err.message);
      // ส่ง DM ไม่ได้ → ไม่ลบห้อง เพื่อไม่ให้ข้อมูลรายงานหาย (ปุ่มยังกดซ้ำได้)
      await i.channel.send({
        content: `⚠️ ส่ง DM ถึง <@${info.reporter}> ไม่สำเร็จ (ผู้เล่นอาจปิดรับ DM) — **ห้องนี้ยังไม่ถูกลบ**\n` +
          'แจ้งผลผู้เล่นทางอื่น แล้วลบห้องเอง หรือกดปุ่มผลตรวจอีกครั้งเพื่อลองส่งใหม่',
        allowedMentions: { parse: [] },
      }).catch(() => {});
      return;
    }

    // 2) อัปเดตข้อความในห้องแอดมิน + แจ้งเตือน + ลบห้องหลัง 5 วินาที
    info.done = true;
    info.deleteAt = Date.now() + DELETE_DELAY_MS;
    if (data.reports[i.channelId]) save();

    await i.message?.edit({
      embeds: markHandled(i.message.embeds, label, i.user.id),
      components: [],
      allowedMentions: { parse: [] },
    }).catch((e) => console.error('อัปเดตข้อความในห้องแอดมินไม่สำเร็จ:', e.message));

    await i.channel.send({
      content: `✅ ส่งผลการตรวจสอบ (**${label}**) ให้ <@${info.reporter}> ทาง DM เรียบร้อยแล้ว\n🗑️ ห้องนี้จะถูกลบใน ${DELETE_DELAY_MS / 1000} วินาที`,
      allowedMentions: { parse: [] },
    }).catch(() => {});

    scheduleRemove(i.channelId, DELETE_DELAY_MS);
  } finally {
    busy.delete(i.channelId);
  }
}

// ห้องที่ถูกลบไป (โดยบอทหรือคนอื่น) → เลิกติดตาม
client.on('channelDelete', (ch) => {
  if (data.reports[ch.id]) { delete data.reports[ch.id]; save(); }
});

// ---------- เริ่มทำงาน ----------
client.once('clientReady', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    guild.commands.set([reportCmd]).catch(console.error);
  }
  // ห้องที่ตรวจเสร็จแล้วแต่บอทรีสตาร์ทก่อนลบ → ลบต่อ
  for (const [channelId, info] of Object.entries(data.reports)) {
    if (info.deleteAt) scheduleRemove(channelId, info.deleteAt - Date.now());
  }
});

client.on('guildCreate', (guild) => {
  guild.commands.set([reportCmd]).catch(console.error);
});

// ---------- Interactions ----------
client.on('interactionCreate', async (i) => {
  try {
    if (!i.inGuild()) return;

    // autocomplete ชื่อแผง
    if (i.isAutocomplete() && i.commandName === 'setreport') {
      const q = norm(i.options.getFocused());
      const choices = guildPanels(i.guildId)
        .filter((p) => norm(p.name).includes(q))
        .slice(0, 25)
        .map((p) => ({ name: p.name.slice(0, 100), value: p.name }));
      return await i.respond(choices);
    }

    if (i.isChatInputCommand() && i.commandName === 'setreport') return await handleSetReport(i);

    // แผงตั้งค่า (แอดมิน)
    if (i.isButton() && i.customId.startsWith('rptp:')) return await handlePanelButton(i);
    if (i.isModalSubmit() && i.customId.startsWith('rptm:')) return await handlePanelModal(i);
    if (i.isChannelSelectMenu() && i.customId.startsWith('rptsend:')) return await handleSendSelect(i);
    if (i.isChannelSelectMenu() && i.customId.startsWith('rptcat:')) return await handleCategorySelect(i);
    if (i.isRoleSelectMenu() && i.customId.startsWith('rptrole:')) return await handleRoleSelect(i);

    // ผู้เล่น
    if (i.isButton() && i.customId.startsWith('rpt_open:')) return await handleOpen(i);
    if (i.isModalSubmit() && i.customId.startsWith('rptform:')) return await handleForm(i);

    // ทีมงานในห้อง report-xxxx
    if (i.isButton() && i.customId.startsWith('rptres:')) return await handleResButton(i);
    if (i.isModalSubmit() && i.customId.startsWith('rptresm:')) return await handleResSubmit(i);
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
