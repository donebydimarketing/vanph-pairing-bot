// VANPH Pairing Bot
// Handles: welcome DM on join, email collection, linking Discord ID to Supabase profile,
// and (later) creating private pairing channels.

const { Client, GatewayIntentBits, Partials, ChannelType, PermissionsBitField } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// ---- ENV VARS (set these in Railway) ----
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // service role, not anon key — bot needs write access
const GUILD_ID = process.env.DISCORD_GUILD_ID; // "Done By Di" server ID
const PAIRING_CATEGORY_NAME = 'VA Pairings'; // channels will be grouped under this category

if (!DISCORD_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GUILD_ID) {
  console.error('Missing required environment variables. Check DISCORD_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DISCORD_GUILD_ID.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message], // needed to receive DMs reliably
});

// In-memory state: tracks who we're waiting on an email reply from.
// Key: discordUserId, Value: { step: 'awaiting_email' }
const pendingLinks = new Map();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ---------- STEP 1: Welcome DM when someone joins the server ----------
client.on('guildMemberAdd', async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  try {
    await member.send(
      `Welcome to Done By Di! 👋\n\n` +
      `To get you connected to your VA Newbies pairings, what email did you use to sign up on the portal?\n\n` +
      `Just reply here with that email and I'll link your account.`
    );
    pendingLinks.set(member.id, { step: 'awaiting_email' });
  } catch (err) {
    console.error(`Could not DM ${member.user.tag}:`, err.message);
  }
});

// ---------- STEP 2: Listen for DM replies with the email ----------
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.guild) return; // only handle DMs, not server messages

  const discordUserId = message.author.id;
  const state = pendingLinks.get(discordUserId);

  // Allow re-linking anytime by typing a command, even if not in pendingLinks state
  const text = message.content.trim();

  if (!state && !EMAIL_REGEX.test(text)) {
    // Not currently expecting an email AND message isn't an email — ignore, or offer help
    if (text.toLowerCase() === 'help' || text.toLowerCase() === 'link') {
      await message.reply(`Reply with the email you used to sign up on the VA Newbies portal, and I'll link your Discord account.`);
    }
    return;
  }

  if (!EMAIL_REGEX.test(text)) {
    await message.reply(`That doesn't look like a valid email. Please reply with just your email address (e.g. name@example.com).`);
    return;
  }

  const email = text.toLowerCase();

  // Try matching against members (VAs) first, then clients (hosts)
  const { data: memberMatch } = await sb
    .from('members')
    .select('id, full_name, email')
    .ilike('email', email)
    .maybeSingle();

  if (memberMatch) {
    await sb.from('members').update({ discord_user_id: discordUserId }).eq('id', memberMatch.id);
    await message.reply(`You're linked, ${memberMatch.full_name || 'there'}! ✅\n\nYou'll be added to a private channel automatically once a pairing is confirmed.`);
    pendingLinks.delete(discordUserId);
    return;
  }

  const { data: clientMatch } = await sb
    .from('clients')
    .select('id, full_name, email')
    .ilike('email', email)
    .maybeSingle();

  if (clientMatch) {
    await sb.from('clients').update({ discord_user_id: discordUserId }).eq('id', clientMatch.id);
    await message.reply(`You're linked, ${clientMatch.full_name || 'there'}! ✅\n\nYou'll be added to a private channel automatically once a pairing is confirmed.`);
    pendingLinks.delete(discordUserId);
    return;
  }

  // No match found in either table
  await message.reply(
    `I couldn't find that email in our system. Double check it matches what you used to sign up, or reach out to Coach Di if you think this is a mistake.\n\n` +
    `You can try again by replying with your email.`
  );
});

// ---------- STEP 3: Channel creation for a confirmed pairing ----------
// This function can be called by an internal HTTP endpoint (see server.js) that
// Supabase triggers via a database webhook when a pairing's status flips to 'agreed'.
async function createPairingChannel({ pairingId, clientDiscordId, vaDiscordId, clientName, vaName }) {
  const guild = await client.guilds.fetch(GUILD_ID);

  // Find or create the "VA Pairings" category
  let category = guild.channels.cache.find(
    (c) => c.name === PAIRING_CATEGORY_NAME && c.type === ChannelType.GuildCategory
  );
  if (!category) {
    category = await guild.channels.create({
      name: PAIRING_CATEGORY_NAME,
      type: ChannelType.GuildCategory,
    });
  }

  const safeName = (str) => (str || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20);
  const channelName = `${safeName(clientName)}-x-${safeName(vaName)}`;

  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
  ];
  if (clientDiscordId) {
    permissionOverwrites.push({ id: clientDiscordId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });
  }
  if (vaDiscordId) {
    permissionOverwrites.push({ id: vaDiscordId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites,
  });

  await channel.send(
    `👋 Welcome ${clientName || 'there'} and ${vaName || 'there'}!\n\n` +
    `This is your private space for this pairing. Use it to coordinate tasks, share updates, and ask questions.`
  );

  // Save channel ID back to the pairing record so we don't create duplicates
  await sb.from('pairings').update({ discord_channel_id: channel.id }).eq('id', pairingId);

  return channel.id;
}

module.exports = { client, createPairingChannel, login: () => client.login(DISCORD_BOT_TOKEN) };

