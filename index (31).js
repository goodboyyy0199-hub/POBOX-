// =====================================================================
// index.js — บอทระบบ Report (มีคำสั่งเดียวคือ /report) สำหรับ discord.js v14
//
//  ผู้เล่นกดปุ่ม Report → Modal (รายละเอียด > 5 ตัวอักษร + แนบรูปหลักฐานจากเครื่อง ≥ 1 รูป)
//   → ห้องแอดมินตรวจสอบ: Embed รายละเอียด+รูป พร้อมปุ่ม 2 ปุ่ม
//        🚨 ตรวจพบโปรแกรมโกง / ✅ ไม่ตรวจพบสิ่งผิดปกติ
//   → ห้องรายงานผล: Embed เดียวกัน แต่ไม่มีปุ่มเลย
//   → แอดมินกดปุ่ม → Modal ข้อความ + รูปผลตรวจ (ไม่บังคับ ว่างได้)
//   → ผลตรวจอัปเดตเข้า Embed ทั้งในห้องแอดมินและห้องรายงานผลทันที
//
//  ต้องใช้ discord.js >= 14.24.0 (มี FileUploadBuilder / LabelBuilder ใน Modal)
//  รัน: npm install แล้ว npm start   (ตัวแปร: DISCORD_TOKEN บังคับ, MONGODB_URI/MONGODB_DB/PORT ไม่บังคับ)
//  สถานะของแต่ละรายงานเก็บไว้ในตัวข้อความเอง (รหัสปุ่ม) จึงไม่หายตอนบอทรีสตาร์ท
//  ส่วนค่าตั้งค่าแผง (ห้อง/ข้อความ) เก็บใน MongoDB หรือไฟล์ report-data.json
// =====================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  Client, Events, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, PermissionFlagsBits, MessageFlags, SlashCommandBuilder, AttachmentBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, FileUploadBuilder,
} = require('discord.js');

// ---------- ค่าคงที่ ----------
const RPT_SUPPORTED = typeof LabelBuilder === 'function' && typeof FileUploadBuilder === 'function';
const RPT_COOLDOWN_MS = 60 * 1000;            // ผู้เล่นคนเดิมส่งรายงานถี่ได้ทุก 60 วินาที (กันสแปม)
const RPT_MAX_FILES = 4;                      // รูปหลักฐาน/รูปผลตรวจ สูงสุดกี่รูป
const RPT_MIN_DETAIL = 6;                     // รายละเอียดต้อง "เกิน 5 ตัวอักษร" = อย่างน้อย 6
// เพดานขนาดไฟล์รวมที่บอทอัปโหลดซ้ำได้ใน 1 ข้อความ (ตามเลเวลบูสต์เซิร์ฟเวอร์ เผื่อไว้ 1MB) เกินแล้วใช้ลิงก์เดิมแทน
// ตั้งแบบมองโลกในแง่ดี: ลองอัปโหลดก่อน ถ้า Discord ปฏิเสธว่าไฟล์ใหญ่เกิน (isTooLarge) โค้ดจะส่งใหม่แบบใช้ลิงก์เองอัตโนมัติ
const uploadLimit = (guild) => {
  const mb = guild?.premiumTier >= 3 ? 100 : guild?.premiumTier === 2 ? 50 : 20;
  return mb * 1024 * 1024;
};
const isTooLarge = (err) => err?.code === 40005 || err?.status === 413;

// ข้อความ/สี/ปุ่ม ของ Embed รายงาน + ผลตรวจ (แอดมินแก้ได้ที่แผง → ปุ่ม “📝 ข้อความ Embed อื่นๆ”; เว้นว่าง = ใช้ค่านี้)
const RPT_DEFAULT_TEXTS = {
  reportTitle: '🚨 รายงานใหม่',
  reportColor: '#FEE75C',
  reporterLabel: '👤 ผู้รายงาน',
  statusLabel: '📌 สถานะ',
  pending: '⏳ รอแอดมินตรวจสอบ',
  evidenceFooter: 'หลักฐาน {n} ไฟล์',
  cheatTitle: '🚨 ตรวจพบโปรแกรมโกง',
  cleanTitle: '✅ ไม่ตรวจพบสิ่งผิดปกติ',
  cheatColor: '#ED4245',
  cleanColor: '#57F287',
  resultTitle: '🔎 ผลการตรวจสอบ',
  noNote: '(ไม่มีข้อความเพิ่มเติม)',
  checkedBy: 'ตรวจสอบโดย',
  cheatBtn: '🚨 ตรวจพบโปรแกรมโกง',
  cleanBtn: '✅ ไม่ตรวจพบสิ่งผิดปกติ',
};
// ช่องที่อยู่ในแต่ละ Modal แก้ข้อความ
const RPT_TEXT_GROUPS = {
  rtext: ['reportTitle', 'reportColor', 'reporterLabel', 'statusLabel', 'pending'],
  vtext: ['cheatTitle', 'cleanTitle', 'resultTitle', 'noNote', 'checkedBy'],
  btext: ['cheatBtn', 'cleanBtn', 'cheatColor', 'cleanColor', 'evidenceFooter'],
};
const RPT_COLOR_KEYS = new Set(['reportColor', 'cheatColor', 'cleanColor']);
const getTexts = (g) => {
  const t = { ...RPT_DEFAULT_TEXTS };
  for (const [k, v] of Object.entries(g?.texts || {})) if (k in t && v) t[k] = v;
  return t;
};
// ข้อมูลผลตรวจ (สี + หัวข้อ) ตามที่ตั้งไว้ในแผง
const verdictOf = (g, key) => {
  const t = getTexts(g);
  if (key === 'cheat') return { color: t.cheatColor, title: t.cheatTitle };
  if (key === 'clean') return { color: t.cleanColor, title: t.cleanTitle };
  return null;
};
const SHORT = TextInputStyle.Short;
const PARA = TextInputStyle.Paragraph;

// =====================================================================
// เก็บข้อมูลแผง (MongoDB ถ้ามี ไม่งั้นไฟล์ report-data.json)
// =====================================================================
const RPT_FILE = path.join(__dirname, 'report-data.json');
const RPT_DOC_ID = 'report-panels';
let rptData = { panels: {} };
let rptCol = null;
let rptTimer = null;

async function initReport({ mongoCol, mongoUri, mongoDb } = {}) {
  if (!RPT_SUPPORTED) {
    console.error('❌ /report ต้องใช้ discord.js >= 14.24.0 (ตอนนี้เวอร์ชันเก่าเกินไป) → แก้ package.json เป็น "discord.js": "^14.24.0" แล้วติดตั้งใหม่');
  }
  try {
    if (mongoCol) rptCol = mongoCol;
    else if (mongoUri) {
      const { MongoClient } = require('mongodb');
      const mc = new MongoClient(mongoUri);
      await mc.connect();
      rptCol = mc.db(mongoDb || 'ticketbot').collection('botdata');
    }
    if (rptCol) {
      const doc = await rptCol.findOne({ _id: RPT_DOC_ID });
      if (doc?.data) rptData = doc.data;
      console.log('🗄️ /report: ใช้ MongoDB เก็บข้อมูล');
    } else if (fs.existsSync(RPT_FILE)) {
      rptData = JSON.parse(fs.readFileSync(RPT_FILE, 'utf8'));
      console.log('📁 /report: ใช้ไฟล์ report-data.json (ข้อมูลหายถ้า host ไม่เก็บไฟล์ → แนะนำตั้ง MONGODB_URI)');
    }
  } catch (err) {
    console.error('โหลดข้อมูล /report ไม่สำเร็จ ใช้ข้อมูลว่างแทน:', err.message);
  }
  rptData.panels ||= {};
}

async function rptFlush() {
  try {
    if (rptCol) await rptCol.replaceOne({ _id: RPT_DOC_ID }, { _id: RPT_DOC_ID, data: rptData }, { upsert: true });
    else fs.writeFileSync(RPT_FILE, JSON.stringify(rptData));
  } catch (err) {
    console.error('บันทึกข้อมูล /report ไม่สำเร็จ:', err.message);
  }
}
function rptSave() {
  clearTimeout(rptTimer);
  rptTimer = setTimeout(rptFlush, 300);
}

const guildPanels = (gid) => (rptData.panels[gid] ||= []);
const norm = (s) => String(s || '').trim().toLowerCase();
const findPanel = (gid, name) => guildPanels(gid).find((p) => norm(p.name) === norm(name));
const panelById = (gid, id) => guildPanels(gid).find((p) => p.id === id);

// =====================================================================
// ตัวช่วยทั่วไป
// =====================================================================
const bad = (i, msg) => i.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
const isAdmin = (i) => !!i.memberPermissions?.has(PermissionFlagsBits.Administrator);
const mk = (id, label, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const isUrl = (v) => /^https?:\/\/\S+$/i.test(v);

const COLOR_NAMES = {
  แดง: '#ED4245', เขียว: '#57F287', ฟ้า: '#3498DB', น้ำเงิน: '#5865F2', ทอง: '#F1C40F', เหลือง: '#FEE75C',
  ม่วง: '#9B59B6', ชมพู: '#EB459E', ส้ม: '#E67E22', ขาว: '#FFFFFF', ดำ: '#23272A',
  red: '#ED4245', green: '#57F287', blue: '#3498DB', gold: '#F1C40F', yellow: '#FEE75C',
  purple: '#9B59B6', pink: '#EB459E', orange: '#E67E22', white: '#FFFFFF', black: '#23272A',
};
function parseColor(v) {
  const t = String(v || '').trim();
  if (!t) return null;
  if (COLOR_NAMES[t.toLowerCase()]) return COLOR_NAMES[t.toLowerCase()];
  const m = /^#?([0-9a-f]{6})$/i.exec(t);
  return m ? `#${m[1].toUpperCase()}` : null;
}

const BTN_STYLE = {
  primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success, danger: ButtonStyle.Danger,
};
const BTN_THAI = { primary: 'น้ำเงิน', secondary: 'เทา', success: 'เขียว', danger: 'แดง' };
const BTN_INPUT = {
  น้ำเงิน: 'primary', ฟ้า: 'primary', blue: 'primary', primary: 'primary',
  เทา: 'secondary', grey: 'secondary', gray: 'secondary', secondary: 'secondary',
  เขียว: 'success', green: 'success', success: 'success',
  แดง: 'danger', red: 'danger', danger: 'danger',
};
const parseBtnColor = (v) => BTN_INPUT[String(v || '').trim().toLowerCase()] || null;

// ข้อความบนปุ่ม: ถ้ามีอิโมจิเซิร์ฟเวอร์ (<:ชื่อ:id> / <a:ชื่อ:id>) จะแยกไปเป็นรูปอิโมจิหน้าปุ่ม
const CUSTOM_EMOJI_RE = /<(a?):(\w{2,32}):(\d{17,20})>/;
function applyBtnLabel(btn, text) {
  const t = String(text || '');
  const m = CUSTOM_EMOJI_RE.exec(t);
  if (!m) return btn.setLabel(t.slice(0, 80));
  const rest = t.replace(/<a?:\w{2,32}:\d{17,20}>/g, '').trim().slice(0, 80);
  btn.setEmoji({ id: m[3], name: m[2], animated: m[1] === 'a' });
  if (rest) btn.setLabel(rest);
  return btn;
}

// ช่องกรอกข้อความใน Modal (รูปแบบใหม่: LabelBuilder ครอบ TextInput)
function textField(id, label, style, value, max, placeholder, { required = false, min = 0, description } = {}) {
  const t = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required).setMaxLength(max);
  if (min) t.setMinLength(min);
  if (value) t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(String(placeholder).slice(0, 100));
  const l = new LabelBuilder().setLabel(label.slice(0, 45)).setTextInputComponent(t);
  if (description) l.setDescription(description.slice(0, 100));
  return l;
}

// ช่องแนบไฟล์ใน Modal
function uploadField(id, label, description, { required }) {
  const f = new FileUploadBuilder().setCustomId(id).setRequired(required)
    .setMinValues(required ? 1 : 0).setMaxValues(RPT_MAX_FILES);
  return new LabelBuilder().setLabel(label.slice(0, 45)).setDescription(description.slice(0, 100)).setFileUploadComponent(f);
}

// ดึงไฟล์ที่แนบมาจาก Modal (คืน array เสมอ)
function uploadedFiles(i, id) {
  try {
    const col = i.fields.getUploadedFiles(id);
    return col ? [...col.values()] : [];
  } catch {
    return [];
  }
}
const isImageFile = (a) => {
  const ct = String(a.contentType || '').toLowerCase();
  if (ct) return ct.startsWith('image/');
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name || '');
};
const isVideoFile = (a) => {
  const ct = String(a.contentType || '').toLowerCase();
  if (ct) return ct.startsWith('video/');
  return /\.(mp4|mov|webm|mkv|m4v)$/i.test(a.name || '');
};
const isMediaFile = (a) => isImageFile(a) || isVideoFile(a); // รับทั้งรูปและคลิป
const MEDIA_ERR = 'แนบได้เฉพาะไฟล์รูปภาพหรือคลิปวิดีโอ (png, jpg, gif, webp, mp4, mov, webm) เท่านั้น';
function fileExt(a) {
  const ct = String(a.contentType || '').toLowerCase();
  if (ct === 'image/jpeg') return '.jpg';
  if (ct === 'video/quicktime') return '.mov';
  const m = /^(?:image|video)\/(png|gif|webp|bmp|mp4|webm|x-matroska)/.exec(ct);
  if (m) return `.${m[1] === 'x-matroska' ? 'mkv' : m[1]}`;
  const e = /\.(png|jpe?g|gif|webp|bmp|mp4|mov|webm|mkv|m4v)$/i.exec(a.name || '');
  if (e) return `.${e[1].toLowerCase().replace('jpeg', 'jpg')}`;
  return isVideoFile(a) ? '.mp4' : '.png';
}
// บรรทัดลิงก์คลิป (ใช้เมื่อคลิปใหญ่เกินเพดานอัปโหลดซ้ำ → แปะลิงก์เดิมไว้ในข้อความ Discord จะแสดงเป็นตัวเล่นคลิปให้)
const linkLines = (label, links) => (links.length ? `🎬 ${label}:\n${links.join('\n')}` : '');

// ดาวน์โหลดรูปจาก Discord แล้วทำเป็นไฟล์แนบของบอทเอง (ลิงก์ไม่หมดอายุ)
// ถ้าไฟล์ใหญ่เกิน/ดาวน์โหลดไม่ได้ → ใช้ลิงก์รูปเดิมแทน (files ว่าง)
// รับทั้งรูปและคลิป: รูปมาก่อน (เพราะต้องใช้เป็นรูปใน Embed) แล้วค่อยคลิป ไฟล์ไหนเกินเพดานรวม/ดาวน์โหลดไม่ได้ → ใช้ลิงก์เดิมของไฟล์นั้น
// คืน { files: ไฟล์ที่บอทอัปโหลดเอง, refs: ที่อยู่รูปแต่ละรูปสำหรับ Embed (ตามลำดับรูป), links: ลิงก์คลิปที่อัปโหลดซ้ำไม่ได้ }
async function prepareImages(atts, prefix, limit = uploadLimit()) {
  const files = [];
  const refs = [];
  const links = [];
  let used = 0;
  const take = async (a, name) => {
    if (used + (a.size || 0) > limit) {
      console.log(`ข้ามอัปโหลดซ้ำ (${a.name}: ${((a.size || 0) / 1048576).toFixed(1)}MB เกินเพดาน ${(limit / 1048576).toFixed(0)}MB) → ใช้ลิงก์เดิม`);
      return null;
    }
    try {
      const res = await fetch(a.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      used += a.size || buf.length;
      return new AttachmentBuilder(buf, { name });
    } catch (err) {
      console.error('อัปโหลดไฟล์ซ้ำไม่สำเร็จ ใช้ลิงก์เดิมแทน:', err.message);
      return null;
    }
  };
  const images = atts.filter(isImageFile);
  const videos = atts.filter((a) => !isImageFile(a));
  for (const [n, a] of images.entries()) {
    const f = await take(a, `${prefix}-${n + 1}${fileExt(a)}`);
    if (f) { files.push(f); refs.push(`attachment://${f.name}`); } else refs.push(a.url);
  }
  for (const [n, a] of videos.entries()) {
    const f = await take(a, `${prefix}-vid-${n + 1}${fileExt(a)}`);
    if (f) files.push(f); else links.push(a.url);
  }
  return { files, refs, links };
}
// รูปที่ 2 เป็นต้นไปที่ใช้ลิงก์เดิม (อัปโหลดซ้ำไม่ได้) แสดงเป็น Embed เพิ่ม — รูปที่อัปโหลดซ้ำได้จะอยู่ใต้ข้อความเอง
const extraImageEmbeds = (prep, color) => prep.refs.slice(1).filter((u) => !u.startsWith('attachment://'))
  .map((url) => new EmbedBuilder().setColor(color).setImage(url));

// =====================================================================
// Embed
// =====================================================================
function boxEmbed(g) {
  const e = new EmbedBuilder();
  if (g.title) e.setTitle(g.title);
  if (g.description) e.setDescription(g.description);
  if (g.color) e.setColor(g.color);
  if (g.image) e.setImage(g.image);
  if (g.thumbnail) e.setThumbnail(g.thumbnail);
  if (g.footer) e.setFooter({ text: g.footer });
  if (g.timestamp !== false) e.setTimestamp();
  return e;
}
const boxHasContent = (g) => !!(g.title || g.description || g.image || g.thumbnail || g.footer);

// Embed รายงาน (ใช้ทั้งห้องแอดมินและห้องรายงานผล) — s = ข้อมูลผู้รายงาน + รายละเอียด
function reportEmbed(s, { showReporter = true, imageRef = null, imageCount = 1, tx = RPT_DEFAULT_TEXTS } = {}) {
  const e = new EmbedBuilder()
    .setColor(tx.reportColor)
    .setTitle(String(tx.reportTitle).slice(0, 256))
    .setDescription(String(s.detail).slice(0, 4000))
    .setTimestamp(s.createdAt);
  const fields = [];
  if (showReporter) {
    const who = s.preview ? '**@ผู้รายงาน**' : `<@${s.user}>`;
    e.setAuthor({ name: String(s.displayName || s.username).slice(0, 256) });
    if (s.avatar) e.setThumbnail(s.avatar); // รูปโปรไฟล์ผู้รายงาน มุมขวาบน
    fields.push({ name: String(tx.reporterLabel).slice(0, 256), value: `${who} (\`${s.username}\`)`, inline: true });
  }
  // ช่องสถานะต้องเป็นช่อง "สุดท้าย" เสมอ (ตอนตรวจเสร็จจะหาช่องนี้จากตำแหน่ง)
  fields.push({ name: String(tx.statusLabel).slice(0, 256), value: String(tx.pending).slice(0, 1024), inline: showReporter });
  e.addFields(fields);
  if (imageRef) e.setImage(imageRef);
  if (imageCount > 1) e.setFooter({ text: String(tx.evidenceFooter).replace('{n}', imageCount).slice(0, 2048) });
  return e;
}

// =====================================================================
// แผงตั้งค่า (พรีวิว + ปุ่มแก้ไข + เมนูเลือกห้อง)
// =====================================================================
const publicPayload = (g) => ({
  embeds: [boxEmbed(g)],
  components: [new ActionRowBuilder().addComponents(
    applyBtnLabel(new ButtonBuilder().setCustomId(`rpt_open:${g.id}`), g.buttonLabel || '🚨 Report')
      .setStyle(BTN_STYLE[g.btnColor] ?? ButtonStyle.Danger),
  )],
});

// คืนข้อความ error ถ้ายังตั้งค่าไม่ครบ
function panelReady(g, guild) {
  if (!g.adminChannelId || !guild.channels.cache.has(g.adminChannelId)) {
    return 'ยังไม่ได้เลือก “ห้องแอดมินตรวจสอบ” (หรือห้องนั้นถูกลบไปแล้ว)';
  }
  if (!g.resultChannelId || !guild.channels.cache.has(g.resultChannelId)) {
    return 'ยังไม่ได้เลือก “ห้องรายงานผล” (หรือห้องนั้นถูกลบไปแล้ว)';
  }
  return null;
}

function panelView(i, g, note) {
  const guild = i.client.guilds.cache.get(g.guildId);
  const showName = g.showReporter !== false;

  const row1 = new ActionRowBuilder().addComponents(
    mk(`rpt:basic:${g.id}`, '✏️ ข้อความ / สี'),
    mk(`rpt:images:${g.id}`, '🖼️ รูป / GIF / ปุ่ม'),
    mk(`rpt:texts:${g.id}`, '📝 ข้อความ Embed อื่นๆ'),
    mk(`rpt:tglname:${g.id}`, `👁️ ชื่อผู้รายงาน: ${showName ? 'แสดง' : 'ซ่อน'}`,
      showName ? ButtonStyle.Success : ButtonStyle.Secondary),
    mk(`rpt:delete:${g.id}`, '🗑️ ลบ', ButtonStyle.Danger),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      // เลขสุ่มท้าย id ทำให้เมนูรีเซ็ตทุกครั้งที่วาดแผงใหม่ (เลือกห้องเดิมซ้ำเพื่อส่งอีกได้)
      .setCustomId(`rptsend:${g.id}:${Date.now().toString(36)}`)
      .setPlaceholder('📤 เลือก “ห้องปุ่มกด” ที่จะส่งปุ่ม Report')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );
  const adm = new ChannelSelectMenuBuilder()
    .setCustomId(`rptadm:${g.id}`)
    .setPlaceholder('🛠️ เลือก “ห้องแอดมินตรวจสอบ” (มีปุ่มตรวจ 2 ปุ่ม)')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  if (g.adminChannelId && guild?.channels.cache.has(g.adminChannelId)) adm.setDefaultChannels(g.adminChannelId);
  const res = new ChannelSelectMenuBuilder()
    .setCustomId(`rptres:${g.id}`)
    .setPlaceholder('📋 เลือก “ห้องรายงานผล” (แสดงอย่างเดียว ไม่มีปุ่ม)')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  if (g.resultChannelId && guild?.channels.cache.has(g.resultChannelId)) res.setDefaultChannels(g.resultChannelId);
  const staff = new RoleSelectMenuBuilder()
    .setCustomId(`rptstaff:${g.id}`)
    .setPlaceholder('🛡️ ยศทีมงานที่กดตรวจได้ + ถูกแท็ก (ไม่เลือก = เฉพาะแอดมิน)')
    .setMinValues(0).setMaxValues(10);
  const staffDefaults = (g.staffRoles || []).filter((id) => guild?.roles.cache.has(id)).slice(0, 10);
  if (staffDefaults.length) staff.setDefaultRoles(...staffDefaults);

  const info =
    `🛠️ ห้องแอดมินตรวจสอบ: ${g.adminChannelId ? `<#${g.adminChannelId}>` : '**ยังไม่ได้ตั้ง**'}\n` +
    `📋 ห้องรายงานผล: ${g.resultChannelId ? `<#${g.resultChannelId}>` : '**ยังไม่ได้ตั้ง**'}\n` +
    `🛡️ ทีมงานที่ตรวจได้: ${staffDefaults.length ? staffDefaults.map((id) => `<@&${id}>`).join(' ') : 'เฉพาะแอดมิน / คนมีสิทธิ์ Manage Server'}\n` +
    `ปุ่ม: **${g.buttonLabel || '🚨 Report'}** (สี${BTN_THAI[g.btnColor] || 'แดง'})`;

  // กล่อง ① ที่ผู้เล่นเห็น ② ตัวอย่างข้อความที่ห้องแอดมิน/ห้องรายงานผลจะได้รับ
  const sample = {
    preview: true, user: '0', username: 'username', displayName: 'ชื่อผู้รายงาน',
    avatar: i.client.user?.displayAvatarURL(),
    detail: 'ตัวอย่างรายละเอียดที่ผู้เล่นเขียนมา — รูปหลักฐานจะแสดงใต้ข้อความนี้',
    createdAt: Date.now(),
  };
  const pub = boxEmbed(g);
  const smp = reportEmbed(sample, { showReporter: true, tx: getTexts(g) });
  const fits = (pub.length + smp.length) <= 5500;

  return {
    content: note || `📌 **${g.name}** — ตัวอย่างก่อนส่งจริง\n${info}\n` +
      (fits ? '**กล่อง ①** ปุ่มที่ผู้เล่นเห็น • **②** ตัวอย่างรายงานที่ห้องแอดมิน/ห้องรายงานผลจะเห็น\n' : '') +
      'ตั้งค่าห้องจากเมนูด้านล่าง แล้วเลือก “ห้องปุ่มกด” เพื่อส่งปุ่มจริง',
    embeds: fits ? [pub, smp] : [pub],
    components: [row1, row2, new ActionRowBuilder().addComponents(adm),
      new ActionRowBuilder().addComponents(res), new ActionRowBuilder().addComponents(staff)],
    allowedMentions: { parse: [] },
  };
}

function panelModal(action, g) {
  const m = new ModalBuilder().setCustomId(`rptm:${action}:${g.id}`);
  if (action === 'basic') {
    m.setTitle('แก้ข้อความและสีของกล่อง Report').addLabelComponents(
      textField('title', 'หัวข้อ (เว้นว่าง = ไม่มี)', SHORT, g.title, 256),
      textField('description', 'ข้อความ (เว้นว่าง = ไม่มี)', PARA, g.description, 4000),
      textField('color', 'สี HEX หรือชื่อสี', SHORT, g.color, 20, '#ED4245 หรือ แดง เขียว ฟ้า ทอง ม่วง ชมพู'),
      textField('footer', 'footer ท้าย Embed (เว้นว่าง = ไม่มี)', SHORT, g.footer, 2048),
      textField('name', 'ชื่อระบบ (ห้ามซ้ำ)', SHORT, g.name, 50, null, { required: true }),
    );
  } else if (action === 'images') {
    m.setTitle('แก้รูป / GIF และปุ่ม Report').addLabelComponents(
      textField('image', 'ลิงก์รูป/GIF ใหญ่', SHORT, g.image, 500, 'https://...'),
      textField('thumbnail', 'ลิงก์รูป/GIF เล็กมุมขวาบน', SHORT, g.thumbnail, 500, 'https://...'),
      textField('label', 'ข้อความบนปุ่ม', SHORT, g.buttonLabel, 150, '🚨 Report หรือ <:ชื่อ:id> (อิโมจิเซิร์ฟเวอร์)'),
      textField('c_btn', 'สีปุ่ม', SHORT, BTN_THAI[g.btnColor], 10, 'น้ำเงิน / เทา / เขียว / แดง (เว้นว่าง = แดง)'),
    );
  } else if (RPT_TEXT_GROUPS[action]) {
    // Modal แก้ข้อความ Embed รายงาน / ผลตรวจ / ปุ่มตรวจ — เว้นว่าง = ใช้ค่าเริ่มต้น (แสดงเป็นข้อความจางๆ ในช่อง)
    const L = {
      reportTitle: ['หัวข้อ Embed รายงาน', 256], reportColor: ['สี Embed ตอนรอตรวจ (HEX/ชื่อสี)', 20],
      reporterLabel: ['ชื่อช่อง “ผู้รายงาน”', 256], statusLabel: ['ชื่อช่อง “สถานะ”', 256],
      pending: ['ข้อความสถานะตอนรอตรวจ', 1024],
      cheatTitle: ['หัวข้อผล: ตรวจพบโปรแกรมโกง', 200], cleanTitle: ['หัวข้อผล: ไม่ตรวจพบสิ่งผิดปกติ', 200],
      resultTitle: ['หัวข้อกล่องผลตรวจ (นำหน้า)', 50], noNote: ['ข้อความเมื่อแอดมินไม่พิมพ์อะไร', 200],
      checkedBy: ['ข้อความท้ายกล่อง “ตรวจสอบโดย”', 100],
      cheatBtn: ['ปุ่มตรวจ: ตรวจพบโปรแกรมโกง', 80], cleanBtn: ['ปุ่มตรวจ: ไม่ตรวจพบสิ่งผิดปกติ', 80],
      cheatColor: ['สีผล: ตรวจพบโปรแกรมโกง', 20], cleanColor: ['สีผล: ไม่ตรวจพบสิ่งผิดปกติ', 20],
      evidenceFooter: ['ท้ายกล่องเมื่อมีหลายรูป ({n}=จำนวน)', 100],
    };
    const titles = { rtext: 'แก้ข้อความ Embed รายงาน', vtext: 'แก้ข้อความ Embed ผลตรวจ', btext: 'แก้ปุ่มตรวจ / สีผลตรวจ' };
    m.setTitle(titles[action]).addLabelComponents(
      ...RPT_TEXT_GROUPS[action].map((k) =>
        textField(k, `${L[k][0]}`, SHORT, g.texts?.[k], L[k][1], RPT_DEFAULT_TEXTS[k])),
    );
  } else if (action === 'label') {
    m.setTitle('แก้ปุ่ม Report').addLabelComponents(
      textField('label', 'ข้อความบนปุ่ม', SHORT, g.buttonLabel, 150, '🚨 Report หรือ <:ชื่อ:id> (อิโมจิเซิร์ฟเวอร์)'),
      textField('c_btn', 'สีปุ่ม', SHORT, BTN_THAI[g.btnColor], 10, 'น้ำเงิน / เทา / เขียว / แดง (เว้นว่าง = แดง)'),
    );
  }
  return m;
}

// =====================================================================
// คำสั่ง /report (ฝั่งแอดมิน)
// =====================================================================
const nameOpt = (o, required, desc) => o.setName('name').setDescription(desc)
  .setRequired(required).setAutocomplete(!!required);

const reportCmd = new SlashCommandBuilder()
  .setName('report')
  .setDescription('สร้างและจัดการระบบ Report (ผู้เล่นกดปุ่ม → แนบหลักฐาน → แอดมินตรวจสอบ)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((s) => s.setName('create')
    .setDescription('สร้างระบบ Report ใหม่ตั้งชื่อ (ห้ามซ้ำ) แล้วแก้ไขด้วยปุ่มใต้ตัวอย่าง')
    .addStringOption((o) => nameOpt(o, false, 'ตั้งชื่อระบบ (ห้ามซ้ำกับที่มีอยู่)')))
  .addSubcommand((s) => s.setName('edit')
    .setDescription('เปิดกล่องตัวอย่าง + ปุ่มแก้ไข ของระบบที่สร้างไว้')
    .addStringOption((o) => nameOpt(o, true, 'ชื่อระบบ')))
  .addSubcommand((s) => s.setName('list').setDescription('ดูรายชื่อระบบ Report ทั้งหมดที่สร้างไว้'))
  .addSubcommand((s) => s.setName('send').setDescription('ส่งปุ่ม Report จริงไปยังห้องที่ต้องการ')
    .addStringOption((o) => nameOpt(o, true, 'ชื่อระบบ'))
    .addChannelOption((o) => o.setName('channel').setDescription('ห้องปุ่มกด (ไม่เลือก = ห้องนี้)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand((s) => s.setName('delete').setDescription('ลบระบบ Report ที่สร้างไว้')
    .addStringOption((o) => nameOpt(o, true, 'ชื่อระบบ')))
  .toJSON();

async function sendPublicPanel(g, guild, channelId) {
  const notReady = panelReady(g, guild);
  if (notReady) return notReady;
  try {
    const ch = await guild.channels.fetch(channelId);
    await ch.send(publicPayload(g));
    return null;
  } catch (err) {
    console.error('ส่งปุ่ม Report ไม่สำเร็จ:', err.message);
    return `ส่งไม่สำเร็จ: ${err.message} (ตรวจสิทธิ์ดู/ส่งข้อความ/ฝัง Embed ของบอทในห้องนั้น)`;
  }
}

async function handleCommand(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่ใช้คำสั่งนี้ได้');
  const sub = i.options.getSubcommand();
  const gid = i.guildId;

  if (sub === 'create') {
    const name = i.options.getString('name').trim();
    if (!name) return bad(i, 'ชื่อระบบห้ามว่าง');
    if (findPanel(gid, name)) {
      return bad(i, `มีระบบชื่อ **${name}** อยู่แล้ว กรุณาใช้ชื่ออื่น (หรือใช้ /report edit เพื่อแก้ของเดิม)`);
    }
    const g = {
      id: crypto.randomBytes(4).toString('hex'), guildId: gid, name,
      title: '🚨 แจ้งรายงาน',
      description: 'พบผู้เล่นใช้โปรแกรมโกงหรือทำผิดกฎ?\nกดปุ่มด้านล่าง เขียนรายละเอียด และแนบรูปหรือคลิปหลักฐาน ทีมงานจะตรวจสอบให้',
      image: null, thumbnail: null, footer: null, color: '#ED4245', timestamp: true,
      buttonLabel: null, btnColor: null,
      adminChannelId: null, resultChannelId: null, staffRoles: [], showReporter: true,
      createdBy: i.user.id, createdAt: Date.now(),
    };
    guildPanels(gid).push(g);
    rptSave();
    return i.reply(panelView(i, g, `✅ สร้างระบบ **${name}** แล้ว\n` +
      '**ขั้นตอนต่อไป:** ① เลือก “ห้องแอดมินตรวจสอบ” ② เลือก “ห้องรายงานผล” ③ เลือก “ห้องปุ่มกด” เพื่อส่งปุ่มจริง'));
  }

  if (sub === 'list') {
    const list = guildPanels(gid);
    if (!list.length) return bad(i, 'ยังไม่มีระบบที่สร้างไว้ ใช้ /report create เพื่อสร้าง');
    return i.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`📚 ระบบ Report ที่สร้างไว้ (${list.length})`)
        .setDescription(list.map((g, n) => `**${n + 1}.** \`${g.name}\``).join('\n').slice(0, 4000))],
      flags: MessageFlags.Ephemeral,
    });
  }

  const name = i.options.getString('name');
  const g = findPanel(gid, name);
  if (!g) return bad(i, `ไม่พบระบบชื่อ **${name}** (ดูรายชื่อด้วย /report list)`);

  if (sub === 'edit') return i.reply(panelView(i, g));
  if (sub === 'send') {
    const target = i.options.getChannel('channel') || i.channel;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const err = await sendPublicPanel(g, i.guild, target.id);
    return i.editReply(err ? `❌ ${err}` : `✅ ส่งปุ่ม Report **${g.name}** ไปที่ <#${target.id}> แล้ว`);
  }
  if (sub === 'delete') {
    rptData.panels[gid] = guildPanels(gid).filter((x) => x.id !== g.id);
    rptSave();
    return i.reply({ content: `🗑️ ลบระบบ **${g.name}** แล้ว (ปุ่มที่ส่งไปแล้วจะกดไม่ได้อีก)`, flags: MessageFlags.Ephemeral });
  }
}

// เมนูย่อย “ข้อความ Embed อื่นๆ” (ตอบเฉพาะแอดมินคนที่กด)
function textsMenu(g, note) {
  return {
    content: note || `📝 **${g.name}** — เลือกกล่องที่ต้องการแก้ข้อความ (ช่องไหนเว้นว่าง = ใช้ค่าเริ่มต้น)\n` +
      '• **Embed รายงาน** = กล่องที่ส่งเข้าห้องแอดมิน/ห้องรายงานผล\n' +
      '• **Embed ผลตรวจ** = กล่องผลตรวจที่ต่อท้ายหลังแอดมินกดปุ่ม\n' +
      '• **ปุ่มตรวจ / สี** = ข้อความบนปุ่มตรวจ 2 ปุ่ม และสีของผลตรวจ',
    components: [new ActionRowBuilder().addComponents(
      mk(`rpt:rtext:${g.id}`, '📋 Embed รายงาน'),
      mk(`rpt:vtext:${g.id}`, '🔎 Embed ผลตรวจ'),
      mk(`rpt:btext:${g.id}`, '🎛️ ปุ่มตรวจ / สี'),
      mk(`rpt:treset:${g.id}`, '♻️ รีเซ็ตทั้งหมด', ButtonStyle.Danger),
    )],
  };
}

// ปุ่มในกล่องตัวอย่าง
async function handlePanelButton(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่แก้ระบบนี้ได้');
  const [, action, id] = i.customId.split(':');
  const g = panelById(i.guildId, id);
  if (!g) return bad(i, 'ไม่พบระบบนี้แล้ว (อาจถูกลบไป)');

  if (['basic', 'images', 'label', ...Object.keys(RPT_TEXT_GROUPS)].includes(action)) return i.showModal(panelModal(action, g));
  if (action === 'texts') return i.reply({ ...textsMenu(g), flags: MessageFlags.Ephemeral });
  if (action === 'treset') {
    g.texts = {};
    rptSave();
    return i.update(textsMenu(g, '♻️ รีเซ็ตข้อความ Embed ทั้งหมดเป็นค่าเริ่มต้นแล้ว'));
  }
  if (action === 'tglname') { g.showReporter = g.showReporter === false; rptSave(); return i.update(panelView(i, g)); }
  if (action === 'delete') {
    return i.reply({
      content: `⚠️ ยืนยันลบระบบ **${g.name}** ?`,
      components: [new ActionRowBuilder().addComponents(mk(`rpt:delok:${g.id}`, 'ยืนยันลบ', ButtonStyle.Danger))],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (action === 'delok') {
    rptData.panels[i.guildId] = guildPanels(i.guildId).filter((x) => x.id !== g.id);
    rptSave();
    return i.update({ content: `🗑️ ลบระบบ **${g.name}** แล้ว (ปุ่มที่ส่งไปแล้วจะกดไม่ได้อีก)`, components: [] });
  }
}

// Modal แก้ไขแผง
async function handlePanelModal(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่แก้ระบบนี้ได้');
  const [, action, id] = i.customId.split(':');
  const g = panelById(i.guildId, id);
  if (!g) return bad(i, 'ไม่พบระบบนี้แล้ว (อาจถูกลบไป)');

  const get = (k) => {
    const v = i.fields.getTextInputValue(k).trim();
    return v === '' || v === '-' ? null : v;
  };
  const urlOrNull = (k) => {
    const v = get(k);
    if (v && !isUrl(v)) throw new Error(`ลิงก์ในช่อง ${k} ไม่ถูกต้อง (ต้องขึ้นต้นด้วย https://)`);
    return v;
  };

  const draft = { ...g };
  try {
    if (action === 'basic') {
      const name = i.fields.getTextInputValue('name').trim();
      if (!name) throw new Error('ชื่อระบบห้ามว่าง');
      const dup = findPanel(i.guildId, name);
      if (dup && dup.id !== g.id) throw new Error(`มีระบบชื่อ **${name}** อยู่แล้ว กรุณาใช้ชื่ออื่น`);
      const c = get('color');
      if (c) {
        const parsed = parseColor(c);
        if (!parsed) throw new Error('สีไม่ถูกต้อง ใช้ HEX เช่น #ED4245 หรือชื่อสี เช่น แดง เขียว ฟ้า ทอง ม่วง ชมพู');
        draft.color = parsed;
      } else draft.color = null;
      draft.name = name;
      draft.title = get('title');
      draft.description = get('description');
      draft.footer = get('footer');
    } else if (action === 'images') {
      draft.image = urlOrNull('image');
      draft.thumbnail = urlOrNull('thumbnail');
      draft.buttonLabel = get('label');
      draft.btnColor = parseBtnColor(get('c_btn'));
    } else if (action === 'label') {
      draft.buttonLabel = get('label');
      draft.btnColor = parseBtnColor(get('c_btn'));
    } else if (RPT_TEXT_GROUPS[action]) {
      draft.texts = { ...(g.texts || {}) };
      for (const k of RPT_TEXT_GROUPS[action]) {
        const v = get(k); // เว้นว่างหรือ "-" = null = กลับไปใช้ค่าเริ่มต้น
        if (!v) { delete draft.texts[k]; continue; }
        if (RPT_COLOR_KEYS.has(k)) {
          const parsed = parseColor(v);
          if (!parsed) throw new Error('สีไม่ถูกต้อง ใช้ HEX เช่น #ED4245 หรือชื่อสี เช่น แดง เขียว ฟ้า ทอง ม่วง ชมพู');
          draft.texts[k] = parsed;
        } else draft.texts[k] = v;
      }
    }
    if (!boxHasContent(draft)) throw new Error('กล่องต้องมีข้อมูลอย่างน้อย 1 อย่าง (เช่น หัวข้อหรือข้อความ)');
  } catch (err) {
    return bad(i, err.message);
  }
  Object.assign(g, draft);
  rptSave();
  if (RPT_TEXT_GROUPS[action]) { // Modal มาจากเมนูย่อย → อัปเดตเมนูย่อย (ไม่ทับแผงหลัก)
    const ok = textsMenu(g, '✅ บันทึกแล้ว — ข้อความใหม่จะใช้กับรายงานที่ส่งต่อจากนี้ (รายงานเก่าไม่เปลี่ยน)\nแก้ส่วนอื่นต่อได้ หรือกลับไปดูตัวอย่างที่แผงหลัก');
    return i.isFromMessage() ? i.update(ok) : i.reply({ ...ok, flags: MessageFlags.Ephemeral });
  }
  return i.isFromMessage() ? i.update(panelView(i, g)) : i.reply(panelView(i, g));
}

// เมนูเลือกห้อง/ยศ
async function handlePanelSelect(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้น');
  const [kind, id] = i.customId.split(':');
  const g = panelById(i.guildId, id);
  if (!g) return bad(i, 'ไม่พบระบบนี้แล้ว (อาจถูกลบไป)');

  if (kind === 'rptsend') {
    const target = i.channels.first();
    await i.deferUpdate();
    const err = await sendPublicPanel(g, i.guild, target.id);
    const at = Math.floor(Date.now() / 1000);
    return i.editReply(panelView(i, g, err
      ? `❌ ${err}`
      : `✅ ส่งปุ่ม Report **${g.name}** ไปที่ <#${target.id}> แล้ว เมื่อ <t:${at}:T>\nเลือกห้องอีกครั้งเพื่อส่งซ้ำได้`));
  }
  if (kind === 'rptadm') g.adminChannelId = i.channels.first().id;
  else if (kind === 'rptres') g.resultChannelId = i.channels.first().id;
  else if (kind === 'rptstaff') g.staffRoles = [...i.values].filter((r) => r !== i.guildId); // ตัด @everyone ออก
  rptSave();
  return i.update(panelView(i, g));
}

// =====================================================================
// ฝั่งผู้เล่น: กดปุ่ม Report → Modal → ส่งเข้าห้องแอดมิน + ห้องรายงานผล
// =====================================================================
const cooldowns = new Map(); // userId → เวลาที่ส่งล่าสุด
const waitSeconds = (uid) => {
  const left = RPT_COOLDOWN_MS - (Date.now() - (cooldowns.get(uid) || 0));
  return left > 0 ? Math.ceil(left / 1000) : 0;
};

async function handleOpen(i) {
  const g = panelById(i.guildId, i.customId.split(':')[1]);
  if (!g) return bad(i, 'ระบบนี้ถูกปิดแล้ว');
  if (panelReady(g, i.guild)) return bad(i, 'ระบบ Report ยังตั้งค่าไม่เสร็จ กรุณาแจ้งทีมงาน');
  const wait = waitSeconds(i.user.id);
  if (wait) return bad(i, `ส่งรายงานถี่เกินไป กรุณารออีก ${wait} วินาที`);

  return i.showModal(new ModalBuilder()
    .setCustomId(`rptform:${g.id}`)
    .setTitle('แจ้งรายงาน')
    .addLabelComponents(
      textField('detail', 'รายละเอียดที่ต้องการรายงาน', PARA, null, 1000, 'เขียนรายละเอียด เช่น ชื่อผู้เล่น เหตุการณ์ เวลา',
        { required: true, min: RPT_MIN_DETAIL, description: `ต้องพิมพ์เกิน 5 ตัวอักษรขึ้นไป (อย่างน้อย ${RPT_MIN_DETAIL} ตัว)` }),
      uploadField('evidence', 'แนบรูป/คลิปหลักฐาน', `แนบรูปภาพหรือคลิปจากเครื่องอย่างน้อย 1 ไฟล์ (สูงสุด ${RPT_MAX_FILES} ไฟล์)`, { required: true }),
    ));
}

async function handleForm(i) {
  const g = panelById(i.guildId, i.customId.split(':')[1]);
  if (!g) return bad(i, 'ระบบนี้ถูกปิดแล้ว');

  const detail = i.fields.getTextInputValue('detail').trim();
  if (detail.length < RPT_MIN_DETAIL) return bad(i, 'รายละเอียดต้องพิมพ์เกิน 5 ตัวอักษรขึ้นไป');
  const files = uploadedFiles(i, 'evidence');
  if (!files.length) return bad(i, 'ต้องแนบรูปภาพหรือคลิปหลักฐานอย่างน้อย 1 ไฟล์');
  if (!files.every(isMediaFile)) return bad(i, MEDIA_ERR);
  const wait = waitSeconds(i.user.id);
  if (wait) return bad(i, `ส่งรายงานถี่เกินไป กรุณารออีก ${wait} วินาที`);

  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const adm = g.adminChannelId ? await i.guild.channels.fetch(g.adminChannelId).catch(() => null) : null;
  const res = g.resultChannelId ? await i.guild.channels.fetch(g.resultChannelId).catch(() => null) : null;
  if (!adm?.isTextBased() || !res?.isTextBased()) return i.editReply('❌ ระบบ Report ยังตั้งค่าไม่เสร็จ กรุณาแจ้งทีมงาน');

  const imgs = files.slice(0, RPT_MAX_FILES);
  let prep = await prepareImages(imgs, 'evidence', uploadLimit(i.guild));
  const s = {
    user: i.user.id,
    username: i.user.username,
    displayName: i.member?.displayName || i.user.globalName || i.user.username,
    avatar: i.member?.displayAvatarURL?.() || i.user.displayAvatarURL(),
    detail: detail.slice(0, 1000),
    createdAt: Date.now(),
  };
  const tx = getTexts(g);
  let common = { imageRef: prep.refs[0], imageCount: imgs.length, tx };

  // 1) ห้องรายงานผล (ไม่มีปุ่ม)
  let resMsg;
  const sendToResult = () => res.send({
    content: linkLines('คลิปหลักฐาน', prep.links) || undefined,
    embeds: [reportEmbed(s, { ...common, showReporter: g.showReporter !== false }), ...extraImageEmbeds(prep, tx.reportColor)],
    files: prep.files,
    allowedMentions: { parse: [] },
  });
  try {
    try {
      resMsg = await sendToResult();
    } catch (err) {
      // ไฟล์ใหญ่เกินเพดานจริงของเซิร์ฟเวอร์ → ส่งใหม่โดยไม่อัปโหลดซ้ำ ใช้ลิงก์เดิมแทน (รายงานจะไม่ล้มเพราะขนาดไฟล์)
      if (!isTooLarge(err)) throw err;
      console.error('ไฟล์ใหญ่เกินเพดานอัปโหลด ส่งใหม่แบบใช้ลิงก์เดิม');
      prep = await prepareImages(imgs, 'evidence', 0);
      common = { imageRef: prep.refs[0], imageCount: imgs.length, tx };
      resMsg = await sendToResult();
    }
  } catch (err) {
    console.error('ส่งรายงานเข้าห้องรายงานผลไม่สำเร็จ:', err.message);
    return i.editReply('❌ ส่งรายงานไม่สำเร็จ กรุณาแจ้งทีมงาน (บอทอาจไม่มีสิทธิ์ในห้องรายงานผล)');
  }

  // 2) ห้องแอดมิน (มีปุ่มตรวจ 2 ปุ่ม) — เก็บอ้างอิงข้อความในห้องรายงานผลไว้ในรหัสปุ่ม
  const staff = (g.staffRoles || []).filter((id) => i.guild.roles.cache.has(id));
  const ref = `${res.id}:${resMsg.id}:${g.id}`;
  try {
    await adm.send({
      content: [staff.map((r) => `<@&${r}>`).join(' '), linkLines('คลิปหลักฐาน', prep.links)]
        .filter(Boolean).join('\n') || undefined,
      embeds: [reportEmbed(s, { ...common, showReporter: true }), ...extraImageEmbeds(prep, tx.reportColor)],
      files: prep.files,
      components: [new ActionRowBuilder().addComponents(
        applyBtnLabel(new ButtonBuilder().setCustomId(`rptv:cheat:${ref}`).setStyle(ButtonStyle.Danger), tx.cheatBtn),
        applyBtnLabel(new ButtonBuilder().setCustomId(`rptv:clean:${ref}`).setStyle(ButtonStyle.Success), tx.cleanBtn),
      )],
      allowedMentions: { roles: staff, users: [] },
    });
  } catch (err) {
    console.error('ส่งรายงานเข้าห้องแอดมินไม่สำเร็จ:', err.message);
    resMsg.delete().catch(() => {}); // ไม่ให้เหลือรายงานที่แอดมินไม่เห็น
    return i.editReply('❌ ส่งรายงานไม่สำเร็จ กรุณาแจ้งทีมงาน (บอทอาจไม่มีสิทธิ์ในห้องแอดมิน)');
  }

  cooldowns.set(i.user.id, Date.now());
  return i.editReply(`✅ ส่งรายงานเรียบร้อยแล้ว ทีมงานจะตรวจสอบ ดูผลได้ที่ <#${res.id}>`);
}

// =====================================================================
// ฝั่งแอดมิน: กดปุ่มตรวจสอบ → Modal ผลตรวจ → อัปเดต Embed ทั้งสองห้อง
// =====================================================================
const canReview = (i, g) => {
  const m = i.member;
  if (!m) return false;
  return m.permissions.has(PermissionFlagsBits.Administrator) ||
    m.permissions.has(PermissionFlagsBits.ManageGuild) ||
    (g?.staffRoles || []).some((id) => m.roles.cache.has(id));
};
// ตรวจแล้ว = ปุ่มตรวจถูกเอาออกจากข้อความแล้ว (ไม่พึ่งข้อความสถานะ เพราะแอดมินแก้ข้อความได้)
const isReviewed = (message) => !message?.components?.length;
const reviewBusy = new Set();

// กดปุ่ม "ตรวจพบ…" / "ไม่ตรวจพบ…" → เปิด Modal (ข้อความ + รูป ไม่บังคับทั้งคู่)
async function handleReviewButton(i) {
  const [, verdict, resChId, resMsgId, panelId] = i.customId.split(':');
  const g = panelById(i.guildId, panelId);
  const v = verdictOf(g, verdict);
  if (!v || !resChId || !resMsgId) return bad(i, 'อ่านข้อมูลรายงานนี้ไม่ได้');
  if (!canReview(i, g)) return bad(i, 'เฉพาะแอดมินหรือทีมงานที่ได้รับสิทธิ์เท่านั้น');
  if (isReviewed(i.message)) return bad(i, 'รายงานนี้ถูกตรวจสอบไปแล้ว');

  return i.showModal(new ModalBuilder()
    .setCustomId(`rptr:${verdict}:${resChId}:${resMsgId}:${panelId}`)
    .setTitle(`ผลตรวจ: ${v.title}`.slice(0, 45))
    .addLabelComponents(
      textField('note', 'ข้อความตอบกลับ (ไม่บังคับ)', PARA, null, 1000, 'เว้นว่างได้'),
      uploadField('proof', 'แนบรูป/คลิปผลการตรวจ (ไม่บังคับ)', `เว้นว่างได้ • รูปหรือคลิป สูงสุด ${RPT_MAX_FILES} ไฟล์`, { required: false }),
    ));
}

// สร้างข้อมูลแก้ไขข้อความรายงาน: Embed รายงานเดิม (เปลี่ยนสถานะ+สี) + Embed ผลตรวจ
function verdictPayload(msg, v, note, adminName, prep, tx) {
  const base = msg.embeds[0];
  const rep = EmbedBuilder.from(base).setColor(v.color);
  // ช่อง "สถานะ" คือช่องสุดท้ายเสมอ → เปลี่ยนเป็นผลตรวจ
  const fields = base.fields || [];
  rep.setFields(fields.map((f, n) => ({
    name: f.name, value: n === fields.length - 1 ? String(v.title).slice(0, 1024) : f.value, inline: f.inline,
  })));
  // ถ้ารูปหลักฐานเป็นไฟล์แนบของบอท ให้ชี้กลับไปที่ไฟล์เดิม (ไม่ใช้ลิงก์ที่หมดอายุได้)
  const ev = msg.attachments.find((a) => a.name?.startsWith('evidence-1.'));
  if (ev) rep.setImage(`attachment://${ev.name}`);

  const result = new EmbedBuilder()
    .setColor(v.color)
    .setTitle(`${tx.resultTitle}: ${v.title}`.slice(0, 256))
    .setDescription(note || `*${tx.noNote}*`)
    .setFooter({ text: `${tx.checkedBy} ${adminName}`.slice(0, 2048) })
    .setTimestamp();
  if (prep.refs[0]) result.setImage(prep.refs[0]);

  const keep = msg.embeds.slice(1).map((e) => EmbedBuilder.from(e)); // รูปเพิ่มเติมของหลักฐาน (กรณีใช้ลิงก์เดิม)
  return {
    embeds: [rep, ...keep, result, ...extraImageEmbeds(prep, v.color)],
    // คลิปผลตรวจที่อัปโหลดซ้ำไม่ได้ → ต่อลิงก์ท้ายข้อความเดิม (ไม่ส่ง content = คงข้อความเดิมไว้)
    ...(prep.links.length ? { content: [msg.content, linkLines('คลิปผลตรวจ', prep.links)].filter(Boolean).join('\n').slice(0, 2000) } : {}),
    files: prep.files,
    attachments: [...msg.attachments.values()].map((a) => ({ id: a.id })), // เก็บไฟล์หลักฐานเดิมไว้ (ส่งเฉพาะ id) แล้วเพิ่มไฟล์ผลตรวจเข้าไป
    components: [],
    allowedMentions: { parse: [] },
  };
}

async function handleReviewModal(i) {
  const [, verdict, resChId, resMsgId, panelId] = i.customId.split(':');
  const g = panelById(i.guildId, panelId);
  const v = verdictOf(g, verdict);
  const tx = getTexts(g);
  if (!v) return bad(i, 'อ่านข้อมูลรายงานนี้ไม่ได้');
  if (!canReview(i, g)) return bad(i, 'เฉพาะแอดมินหรือทีมงานที่ได้รับสิทธิ์เท่านั้น');
  if (!i.isFromMessage()) return bad(i, 'ทำรายการไม่ได้ กรุณากดปุ่มตรวจสอบที่รายงานอีกครั้ง');
  if (isReviewed(i.message)) return bad(i, 'รายงานนี้ถูกตรวจสอบไปแล้ว');

  const note = i.fields.getTextInputValue('note').trim();
  const proof = uploadedFiles(i, 'proof');
  if (!proof.every(isMediaFile)) return bad(i, MEDIA_ERR);
  if (reviewBusy.has(i.message.id)) return bad(i, 'รายงานนี้กำลังถูกดำเนินการอยู่ รอสักครู่');

  reviewBusy.add(i.message.id);
  try {
    await i.deferUpdate();
    const proofAtts = proof.slice(0, RPT_MAX_FILES);
    let prep = await prepareImages(proofAtts, 'result', uploadLimit(i.guild));
    const adminName = i.member?.displayName || i.user.username;

    // 1) อัปเดต Embed ในห้องแอดมิน (เอาปุ่มออก) — ถ้าไฟล์ใหญ่เกินเพดานจริง ส่งใหม่แบบใช้ลิงก์เดิม
    try {
      await i.editReply(verdictPayload(i.message, v, note, adminName, prep, tx));
    } catch (err) {
      if (!isTooLarge(err)) throw err;
      console.error('ไฟล์ผลตรวจใหญ่เกินเพดานอัปโหลด ส่งใหม่แบบใช้ลิงก์เดิม');
      prep = await prepareImages(proofAtts, 'result', 0);
      await i.editReply(verdictPayload(i.message, v, note, adminName, prep, tx));
    }

    // 2) อัปเดตข้อความในห้องรายงานผลให้เหมือนกัน
    try {
      const ch = await i.guild.channels.fetch(resChId);
      const msg = await ch.messages.fetch(resMsgId);
      await msg.edit(verdictPayload(msg, v, note, adminName, prep, tx));
    } catch (err) {
      console.error('อัปเดตข้อความห้องรายงานผลไม่สำเร็จ:', err.message);
      await i.followUp({
        content: '⚠️ อัปเดตข้อความในห้องรายงานผลไม่สำเร็จ (ข้อความอาจถูกลบ หรือบอทไม่มีสิทธิ์ในห้องนั้น)',
        flags: MessageFlags.Ephemeral,
      });
    }
  } finally {
    reviewBusy.delete(i.message.id);
  }
}

// =====================================================================
// ตัวรับ interaction ทั้งหมดของ /report — คืน true ถ้าเป็นของระบบนี้ (จัดการให้แล้ว)
// =====================================================================
async function route(i) {
  if (i.isAutocomplete()) {
    if (i.commandName !== 'report') return false;
    const q = norm(i.options.getFocused());
    await i.respond(guildPanels(i.guildId).filter((p) => norm(p.name).includes(q)).slice(0, 25)
      .map((p) => ({ name: p.name.slice(0, 100), value: p.name })));
    return true;
  }
  if (i.isChatInputCommand()) {
    if (i.commandName !== 'report') return false;
    await handleCommand(i);
    return true;
  }
  const id = i.customId || '';
  if (!id.startsWith('rpt')) return false;

  const needsNew = id.startsWith('rpt_open:') || id.startsWith('rptform:') || id.startsWith('rptv:') ||
    id.startsWith('rptr:') || id.startsWith('rptm:') || id.startsWith('rpt:');
  if (needsNew && !RPT_SUPPORTED) {
    await bad(i, 'บอทใช้ discord.js เวอร์ชันเก่าเกินไปสำหรับระบบ Report (ต้อง 14.24.0 ขึ้นไป) กรุณาแจ้งผู้ดูแลบอท');
    return true;
  }
  if (i.isButton()) {
    if (id.startsWith('rpt_open:')) await handleOpen(i);
    else if (id.startsWith('rptv:')) await handleReviewButton(i);
    else if (id.startsWith('rpt:')) await handlePanelButton(i);
    else return false;
    return true;
  }
  if (i.isModalSubmit()) {
    if (id.startsWith('rptform:')) await handleForm(i);
    else if (id.startsWith('rptr:')) await handleReviewModal(i);
    else if (id.startsWith('rptm:')) await handlePanelModal(i);
    else return false;
    return true;
  }
  if ((i.isChannelSelectMenu() || i.isRoleSelectMenu()) &&
      /^(rptsend|rptadm|rptres|rptstaff):/.test(id)) {
    await handlePanelSelect(i);
    return true;
  }
  return false;
}

async function handleReportInteraction(i) {
  try {
    return await route(i);
  } catch (err) {
    console.error('ข้อผิดพลาดในระบบ /report:', err);
    try {
      const msg = { content: '❌ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง หรือแจ้งทีมงาน', flags: MessageFlags.Ephemeral };
      if (i.deferred || i.replied) await i.followUp(msg);
      else if (typeof i.reply === 'function') await i.reply(msg);
    } catch { /* ตอบไม่ได้แล้ว ปล่อยผ่าน */ }
    return true;
  }
}

module.exports = { reportCmd, handleReportInteraction, initReport };

// =====================================================================
// ส่วนเริ่มทำงานของบอท (npm start)
// =====================================================================
if (require.main === module) {
  require('dotenv').config();
  (async () => {
    // Render ต้องมีพอร์ตเปิดไว้ (ถ้ามีตัวแปร PORT)
    if (process.env.PORT) {
      require('http').createServer((_, res) => res.end('ok')).listen(process.env.PORT);
    }
    await initReport({ mongoUri: process.env.MONGODB_URI, mongoDb: process.env.MONGODB_DB });

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    // ใช้ create (ไม่ใช่ set) เพื่อไม่ไปลบคำสั่งอื่นของบอทตัวเดียวกัน
    const register = (guild) => guild.commands.create(reportCmd).catch((e) => console.error('ลงทะเบียน /report ไม่สำเร็จ:', e.message));
    client.once(Events.ClientReady, async (c) => {
      console.log(`✅ ล็อกอินเป็น ${c.user.tag}`);
      for (const guild of c.guilds.cache.values()) await register(guild);
    });
    client.on(Events.GuildCreate, register);
    client.on(Events.InteractionCreate, (i) => { handleReportInteraction(i); });
    process.once('SIGTERM', async () => { await rptFlush(); process.exit(0); });
    await client.login(process.env.DISCORD_TOKEN);
  })();
}
