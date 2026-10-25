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

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

// ---------- Keep Alive ----------
const app = express();
app.get('/', (req, res) => res.send('Report Bot is alive!'));
app.get('/health', (req, res) => res.json({ ok: true, discordReady: client.isReady(), uptimeSec: Math.round(process.uptime()) }));
app.listen(process.env.PORT || 3000, () => console.log('🌐 Web server is running'));

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
}

// ---------- Config ----------
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || '';
const CATEGORY_ID = process.env.CATEGORY_ID || '';
const MONGODB_URI = process.env.MONGODB_URI || '';
const DATA_FILE = path.join(__dirname, 'report-data.json');
const MONGO_DOC = process.env.MONGO_DOC || 'report-cmd';

let data = { counters: {}, reports: {}, embeds: {} };
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
    console.log('🗄️ เชื่อมต่อ MongoDB สำเร็จ');
  } else {
    try {
      if (fs.existsSync(DATA_FILE)) data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      console.error('อ่าน report-data.json ไม่สำเร็จ:', e);
    }
  }
  data.counters ||= {};
  data.reports ||= {};
  data.embeds ||= {};
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
    catch (e) { console.error('บันทึกไฟล์ไม่สำเร็จ:', e); }
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const isUrl = (u) => /^https?:\/\/\S+$/i.test(u || '');
const isHex = (c) => /^#?[0-9a-f]{6}$/i.test(c || '');
const norm = (s) => String(s || '').trim().toLowerCase();
const bad = (i, text) => i.reply({ content: `❌ ${text}`, flags: MessageFlags.Ephemeral });
const isAdmin = (i) => i.memberPermissions?.has(PermissionFlagsBits.Administrator);

const guildEmbeds = (gid) => (data.embeds[gid] ||= []);
const findEmbed = (gid, name) => guildEmbeds(gid).find((e) => norm(e.name) === norm(name));

// ---------- Slash Command: /report ----------
const reportCmd = new SlashCommandBuilder()
  .setName('report')
  .setDescription('ระบบแจ้งรายงาน (Report System)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(s => s.setName('create').setDescription('สร้าง Embed ปุ่มรายงาน')
    .addStringOption(o => o.setName('name').setDescription('ชื่อ Embed').setRequired(true).setMaxLength(50)))
  .addSubcommand(s => s.setName('edit').setDescription('แก้ไข Embed รายงาน')
    .addStringOption(o => o.setName('name').setDescription('ชื่อ Embed').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('list').setDescription('ดูรายการ Embed ทั้งหมด'))
  .addSubcommand(s => s.setName('send').setDescription('ส่ง Embed ไปยังห้องที่ต้องการ')
    .addStringOption(o => o.setName('name').setDescription('ชื่อ Embed').setRequired(true).setAutocomplete(true))
    .addChannelOption(o => o.setName('channel').setDescription('ห้องที่ต้องการส่ง').addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(s => s.setName('delete').setDescription('ลบ Embed')
    .addStringOption(o => o.setName('name').setDescription('ชื่อ Embed').setRequired(true).setAutocomplete(true)))
  .toJSON();

function buildEmbed(e) {
  const emb = new EmbedBuilder().setColor(e.color || 0x5865f2);
  if (e.title) emb.setTitle(e.title.slice(0, 256));
  if (e.description) emb.setDescription(e.description.slice(0, 4096));
  if (e.image) emb.setImage(e.image);
  if (e.footer) emb.setFooter({ text: e.footer.slice(0, 2048) });
  emb.setTimestamp();
  return emb;
}

const publicPayload = (e) => ({
  embeds: [buildEmbed(e)],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`report_open_modal:${e.id}`)
      .setLabel(e.buttonLabel || '🚨 แจ้งรายงาน (Report)')
      .setStyle(ButtonStyle.Primary)
  )],
});

function panelPayload(e) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rep:basic:${e.id}`).setLabel('✏️ แก้ไขข้อความ/หัวข้อ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rep:img:${e.id}`).setLabel('🖼️ แก้ไขรูปภาพ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rep:label:${e.id}`).setLabel('🏷️ แก้ไขปุ่ม').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rep:del:${e.id}`).setLabel('🗑️ ลบ').setStyle(ButtonStyle.Danger),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId(`repsend:${e.id}`).setPlaceholder('📤 เลือกห้องที่จะส่ง Embed นี้').addChannelTypes(ChannelType.GuildText),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId(`repcat:${e.id}`).setPlaceholder('📁 เลือกหมวดหมู่ห้องรายงานแอดมิน').addChannelTypes(ChannelType.GuildCategory),
  );
  return {
    content: `📌 ตัวอย่าง Embed รายงาน: **${e.name}**`,
    embeds: [buildEmbed(e)],
    components: [row1, row2, row3],
  };
}

// ---------- Modal กรอกข้อมูลรายงาน (บังคับรูป + ข้อความ > 5 ตัว) ----------
function reportModal(embedId) {
  return new ModalBuilder()
    .setCustomId(`report_submit_modal:${embedId}`)
    .setTitle('แบบฟอร์มแจ้งรายงาน (Report)')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('report_details')
          .setLabel('รายละเอียด / ข้อความ (ต้องพิมพ์มากกว่า 5 ตัวอักษร)')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('กรธิบายเหตุการณ์หรือปัญหาที่พบ...')
          .setRequired(true)
          .setMinLength(6)
          .setMaxLength(1000)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('report_image')
          .setLabel('ลิงก์รูปภาพหลักฐาน (บังคับใส่ 1 รูปขึ้นไป)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('https://imgur.com/... หรือลิงก์รูปภาพ')
          .setRequired(true)
          .setMaxLength(500)
      )
    );
}

// ---------- Modal แอดมินตอบกลับ ----------
function adminResponseModal(reportId, actionType) {
  const title = actionType === 'cheat' ? '1. ตรวจพบโปรแกรมโกง' : '2. ไม่ตรวจพบสิ่งผิดปกติ';
  return new ModalBuilder()
    .setCustomId(`admin_response_modal:${reportId}:${actionType}`)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('admin_message')
          .setLabel('ข้อความตอบกลับถึงผู้เล่น (ไม่บังคับ)')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('พิมพ์ข้อความแจ้งผลการตรวจสอบ (เว้นว่างได้)...')
          .setRequired(false)
          .setMaxLength(1000)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('admin_image')
          .setLabel('ลิงก์รูปภาพผลการตรวจ (ไม่บังคับ)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('https://... (เว้นว่างได้)')
          .setRequired(false)
          .setMaxLength(500)
      )
    );
}

// ---------- จัดการคำสั่ง / Interactions ----------
client.on('interactionCreate', async (i) => {
  try {
    if (i.isAutocomplete() && i.commandName === 'report') {
      const q = norm(i.options.getFocused());
      const choices = guildEmbeds(i.guildId).filter(e => norm(e.name).includes(q)).slice(0, 25)
        .map(e => ({ name: e.name, value: e.name }));
      return await i.respond(choices);
    }

    if (i.isChatInputCommand() && i.commandName === 'report') {
      if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้น');
      const sub = i.options.getSubcommand();
      const gid = i.guildId;

      if (sub === 'create') {
        const name = i.options.getString('name').trim();
        if (findEmbed(gid, name)) return bad(i, 'มีชื่อ Embed นี้อยู่แล้ว');
        const e = { id: crypto.randomBytes(4).toString('hex'), name, title: 'ระบบแจ้งรายงาน', description: 'กดปุ่มด้านล่างเพื่อแจ้งรายงาน', buttonLabel: '🚨 แจ้งรายงาน' };
        guildEmbeds(gid).push(e);
        save();
        return i.reply(panelPayload(e));
      }
      if (sub === 'list') {
        const list = guildEmbeds(gid);
        if (!list.length) return bad(i, 'ยังไม่มี Embed');
        return i.reply({ content: list.map((e, idx) => `${idx + 1}. **${e.name}**`).join('\n'), flags: MessageFlags.Ephemeral });
      }
      const name = i.options.getString('name');
      const e = findEmbed(gid, name);
      if (!e) return bad(i, 'ไม่พบ Embed นี้');

      if (sub === 'edit') return i.reply(panelPayload(e));
      if (sub === 'delete') {
        data.embeds[gid] = guildEmbeds(gid).filter(x => x.id !== e.id);
        save();
        return i.reply({ content: '🗑️ ลบสำเร็จ', flags: MessageFlags.Ephemeral });
      }
      if (sub === 'send') {
        const target = i.options.getChannel('channel');
        await target.send(publicPayload(e));
        return i.reply({ content: `✅ ส่งไปที่ <#${target.id}> แล้ว`, flags: MessageFlags.Ephemeral });
      }
    }

    // เมนูเลือกห้องส่ง Embed
    if (i.isChannelSelectMenu() && i.customId.startsWith('repsend:')) {
      const e = guildEmbeds(i.guildId).find(x => x.id === i.customId.split(':')[1]);
      const target = i.channels.first();
      await target.send(publicPayload(e));
      return i.update({ content: `✅ ส่งไปที่ <#${target.id}> สำเร็จ` });
    }

    // เมนูเลือก Category ห้องแอดมิน
    if (i.isChannelSelectMenu() && i.customId.startsWith('repcat:')) {
      const e = guildEmbeds(i.guildId).find(x => x.id === i.customId.split(':')[1]);
      e.categoryId = i.channels.first().id;
      save();
      return i.update(panelPayload(e));
    }

    // กดปุ่มแจ้งรายงาน -> เด้ง Modal
    if (i.isButton() && i.customId.startsWith('report_open_modal:')) {
      const embedId = i.customId.split(':')[1];
      return await i.showModal(reportModal(embedId));
    }

    // ส่ง Modal รายงานจากผู้เล่น
    if (i.isModalSubmit() && i.customId.startsWith('report_submit_modal:')) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const details = i.fields.getTextInputValue('report_details');
      const imageUrl = i.fields.getTextInputValue('report_image');

      if (!isUrl(imageUrl)) return i.editReply('❌ ลิงก์รูปภาพหลักฐานไม่ถูกต้อง (ต้องขึ้นต้นด้วย https://)');

      const embedId = i.customId.split(':')[1];
      const e = guildEmbeds(i.guildId).find(x => x.id === embedId);
      const parentCat = (e && e.categoryId) || CATEGORY_ID || null;

      // สร้างห้องให้แอดมินดู
      const reportNum = String((data.counters[i.guildId] = (data.counters[i.guildId] || 0) + 1)).padStart(4, '0');
      const channel = await i.guild.channels.create({
        name: `report-${reportNum}`,
        type: ChannelType.GuildText,
        parent: parentCat,
        permissionOverwrites: [
          { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
          ...(STAFF_ROLE_ID ? [{ id: STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }] : [])
        ]
      });

      // Embed หลักฐานสำหรับแอดมิน
      const adminEmbed = new EmbedBuilder()
        .setColor(0xfaa61a)
        .setTitle(`🚨 รายงานปัญหาใหม่ #${reportNum}`)
        .addFields(
          { name: '👤 ผู้แจ้ง', value: `<@${i.user.id}> (${i.user.tag})`, inline: false },
          { name: '📝 รายละเอียด', value: details, inline: false }
        )
        .setImage(imageUrl)
        .setTimestamp();

      const adminRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rep_action:cheat:${reportNum}`).setLabel('1. ตรวจพบโปรแกรมโกง').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`rep_action:normal:${reportNum}`).setLabel('2. ไม่ตรวจพบสิ่งผิดปกติ').setStyle(ButtonStyle.Success),
      );

      const sentMsg = await channel.send({ content: `<@&${STAFF_ROLE_ID || i.guild.id}> มีรายงานเข้ามาใหม่!`, embeds: [adminEmbed], components: [adminRow] });

      // บันทึกข้อมูล Report ไว้ในระบบ
      data.reports[reportNum] = {
        userId: i.user.id,
        channelId: channel.id,
        messageId: sentMsg.id,
        userMessage: null, // จะเก็บข้อความที่ส่งหาผู้เล่นทีหลัง
      };
      save();

      // ส่ง Embed กลับไปให้ผู้เล่นทราบสถานะเบื้องต้นในห้องส่วนตัว หรือส่งข้อความบอก
      const userInitialEmbed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(`⏳ สถานะรายงาน #${reportNum}: กำลังรอการตรวจสอบจากแอดมิน`)
        .setDescription(`**รายละเอียดของคุณ:**\n${details}`)
        .setImage(imageUrl)
        .setTimestamp();

      const userMsg = i.user.send ? await i.user.send({ embeds: [userInitialEmbed] }).catch(() => null) : null;
      if (userMsg) data.reports[reportNum].userMessageId = userMsg.id;
      save();

      return i.editReply(`✅ ส่งรายงานเรียบร้อยแล้ว! ติดตามสถานะได้ที่ห้องของคุณหรือห้องส่วนตัว บอทได้สร้างห้องตรวจสอบให้ที่ <#${channel.id}>`);
    }

    // แอดมินกดปุ่มใต้ข้อความรายงาน (1. โกง / 2. ปกติ) -> เด้ง Modal กรอกผล
    if (i.isButton() && i.customId.startsWith('rep_action:')) {
      const [, actionType, reportNum] = i.customId.split(':');
      return await i.showModal(adminResponseModal(reportNum, actionType));
    }

    // ส่ง Modal ตอบกลับจากแอดมิน
    if (i.isModalSubmit() && i.customId.startsWith('admin_response_modal:')) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const [, reportNum, actionType] = i.customId.split(':');
      const adminMsg = i.fields.getTextInputValue('admin_message');
      const adminImg = i.fields.getTextInputValue('admin_image');

      if (adminImg && !isUrl(adminImg)) return i.editReply('❌ ลิงก์รูปภาพไม่ถูกต้อง');

      const repInfo = data.reports[reportNum];
      if (!repInfo) return i.editReply('❌ ไม่พบข้อมูลรายงานนี้ในระบบ');

      const isCheat = actionType === 'cheat';
      const resultTitle = isCheat ? '❌ ตรวจพบโปรแกรมโกง (ถูกปฏิเสธ/ดำเนินการ)' : '✅ ไม่ตรวจพบสิ่งผิดปกติ (ผ่าน)';
      const resultColor = isCheat ? 0xed4245 : 0x57f287;

      const updatedEmbed = new EmbedBuilder()
        .setColor(resultColor)
        .setTitle(`📌 ผลการตรวจสอบรายงาน #${reportNum}: ${resultTitle}`)
        .setDescription(adminMsg ? `**ข้อความจากแอดมิน:**\n${adminMsg}` : 'ไม่มีข้อความเพิ่มเติมจากแอดมิน');

      if (adminImg) updatedEmbed.setImage(adminImg);

      // ส่งไปเด้ง/แก้ไขในแชทส่วนตัวของผู้เล่น (หรือส่งข้อความใหม่เข้า DM)
      try {
        const targetUser = await client.users.fetch(repInfo.userId);
        if (targetUser) {
          await targetUser.send({ embeds: [updatedEmbed] });
        }
      } catch (err) {
        console.error('ไม่สามารถส่งข้อความหาผู้เล่นทาง DM ได้:', err);
      }

      // ส่งข้อความสรุปในห้องแอดมินและลบห้องทิ้ง (หรือเก็บไว้)
      await i.editReply(`✅ ส่งผลการตรวจสอบไปยังผู้เล่นเรียบร้อยแล้ว`);
      await i.channel.send(`🔒 แอดมิน <@${i.user.id}> ได้ดำเนินการเสร็จสิ้น ระบบจะทำการปิดห้องนี้ใน 5วินาที...`);

      setTimeout(async () => {
        try { await i.channel.delete(); } catch(e){}
      }, 5000);
    }

  } catch (err) {
    console.error(err);
    const payload = { content: '❌ เกิดข้อผิดพลาด', flags: MessageFlags.Ephemeral };
    if (i.deferred || i.replied) i.followUp(payload).catch(() => {});
    else i.reply(payload).catch(() => {});
  }
});

(async () => {
  await loadData();
  await client.login(process.env.DISCORD_TOKEN);
})().catch((e) => { console.error('Start error:', e); process.exit(1); });
