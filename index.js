const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const admin = require('firebase-admin');

// ==========================================
// 1. RENDER KEEP-ALIVE WEB SERVER
// ==========================================
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Discord bot is awake!'));
app.listen(port, () => console.log(`Keep-alive web server running on port ${port}`));

// ==========================================
// 2. FIREBASE DATABASE SETUP
// ==========================================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ==========================================
// 3. DISCORD BOT CONFIGURATION
// ==========================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent 
  ]
});

const PREFIX = '!';

// THE ROLE LIST (Must stay highest to lowest)
const ROLE_THRESHOLDS = [
  { count: 5500, id: '1493208783512666253', name: 'Diamond' },
  { count: 3000, id: '1493208783512666253', name: 'Ruby' },
  { count: 1500, id: '1493208783512666253', name: 'Obsidian' },
  { count: 500,  id: '1493208783512666253', name: 'Saphire' }
];

// Helper: Syncs roles (promotes/demotes accurately)
async function syncUserRoles(member, messageCount) {
  const earnedRole = ROLE_THRESHOLDS.find(role => messageCount >= role.count);
  const allRoleIds = ROLE_THRESHOLDS.map(r => r.id);

  if (earnedRole) {
    const rolesToRemove = allRoleIds.filter(id => id !== earnedRole.id && member.roles.cache.has(id));
    if (rolesToRemove.length > 0) await member.roles.remove(rolesToRemove);
    
    if (!member.roles.cache.has(earnedRole.id)) {
      await member.roles.add(earnedRole.id);
      return earnedRole; 
    }
  } else {
    const rolesToRemove = allRoleIds.filter(id => member.roles.cache.has(id));
    if (rolesToRemove.length > 0) await member.roles.remove(rolesToRemove);
  }
  return null;
}

client.on('ready', () => console.log(`Logged in as ${client.user.tag}!`));

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const userId = message.author.id;
  const guildId = message.guild.id;
  const userRef = db.collection('servers').doc(guildId).collection('users').doc(userId);

  // ==========================================
  // COMMAND HANDLING
  // ==========================================
  if (message.content.startsWith(PREFIX)) {
    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    
    const isAdmin = message.member.permissions.has('Administrator');
    const targetUser = message.mentions.users.first();
    const targetMember = message.mentions.members.first();
    const amount = parseInt(args[1]);

    if (command === 'rank' || command === 'stats') {
      const doc = await userRef.get();
      const count = doc.exists ? doc.data().messageCount : 0;
      const nextRole = [...ROLE_THRESHOLDS].reverse().find(role => count < role.count);
      
      let reply = `📊 **${message.author.username}**, you have **${count}** messages.`;
      if (nextRole) reply += `\nYou need **${nextRole.count - count}** more for **${nextRole.name}**.`;
      else reply += `\nYou are at the maximum rank!`;
      return message.reply(reply);
    }

    if (command === 'leaderboard') {
      const snapshot = await db.collection('servers').doc(guildId).collection('users').orderBy('messageCount', 'desc').limit(10).get();
      if (snapshot.empty) return message.reply("No messages recorded yet!");
      
      let board = `🏆 **Server Leaderboard** 🏆\n`;
      let rank = 1;
      snapshot.forEach(doc => { board += `**#${rank}** <@${doc.id}> - ${doc.data().messageCount} msgs\n`; rank++; });
      return message.reply(board);
    }

    if (!isAdmin) return; // Admin only below this line

    if (command === 'setmessages' && targetUser && !isNaN(amount)) {
      await userRef.set({ messageCount: amount }, { merge: true });
      await syncUserRoles(targetMember, amount);
      return message.reply(`✅ Set ${targetUser.username}'s messages to **${amount}**.`);
    }

    if (command === 'addmessages' && targetUser && !isNaN(amount)) {
      const doc = await userRef.get();
      const newCount = (doc.exists ? doc.data().messageCount : 0) + amount;
      await userRef.set({ messageCount: newCount }, { merge: true });
      await syncUserRoles(targetMember, newCount);
      return message.reply(`✅ Added ${amount} messages to ${targetUser.username}. Total: **${newCount}**.`);
    }

    if (command === 'removemessages' && targetUser && !isNaN(amount)) {
      const doc = await userRef.get();
      let newCount = (doc.exists ? doc.data().messageCount : 0) - amount;
      if (newCount < 0) newCount = 0; 
      await userRef.set({ messageCount: newCount }, { merge: true });
      await syncUserRoles(targetMember, newCount);
      return message.reply(`✅ Removed ${amount} messages from ${targetUser.username}. Total: **${newCount}**.`);
    }

    if (command === 'sync' && targetUser) {
      const doc = await userRef.get();
      const count = doc.exists ? doc.data().messageCount : 0;
      await syncUserRoles(targetMember, count);
      return message.reply(`✅ Synced roles for ${targetUser.username} based on their **${count}** messages.`);
    }

    if (command === 'resetall') {
      message.reply("⚠️ Resetting all users...");
      const snapshot = await db.collection('servers').doc(guildId).collection('users').get();
      const batch = db.batch();
      snapshot.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      return message.channel.send("🚨 All message counts have been reset to 0.");
    }
    return;
  }

  // ==========================================
  // NORMAL MESSAGE COUNTING
  // ==========================================
  try {
    const newCount = await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(userRef);
      const count = doc.exists ? doc.data().messageCount + 1 : 1;
      transaction.set(userRef, { messageCount: count }, { merge: true });
      return count;
    });

    const newRoleEarned = await syncUserRoles(message.member, newCount);
    if (newRoleEarned) {
      message.channel.send(`🎉 Congratulations ${message.author}! You hit **${newCount}** messages and earned the **${newRoleEarned.name}** role!`);
    }
  } catch (error) {
    console.error('Database Error:', error);
  }
});

client.login(process.env.DISCORD_TOKEN);