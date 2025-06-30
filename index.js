const {
  default: makeWASocket,
  useSingleFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const fs = require("fs-extra");
const pino = require("pino");

const sessionPath = './creds.json';
const { state, saveState } = useSingleFileAuthState(sessionPath);

const USERS_FILE = './data/users.json';
const TASKS_FILE = './data/tasks.json';
const TEMP_FOLDER = './data/temp';

fs.ensureDirSync('./data');
fs.ensureDirSync(TEMP_FOLDER);
fs.ensureFileSync(USERS_FILE);
fs.ensureFileSync(TASKS_FILE);

let users = fs.readJsonSync(USERS_FILE, { throws: false }) || {};
let tasks = fs.readJsonSync(TASKS_FILE, { throws: false }) || {};

function saveAll() {
  fs.writeJsonSync(USERS_FILE, users);
  fs.writeJsonSync(TASKS_FILE, tasks);
}

function todayDate() {
  return new Date().toISOString().split("T")[0];
}

// Replace with your actual group JIDs
const submissionGroupJid = '1111111111@g.us';
const resultsGroupJid = '2222222222@g.us';
const withdrawGroupJid = '3333333333@g.us';

async function startBot() {
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveState);

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("❌ Disconnected. Reconnecting...", shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("✅ Bot connected");
    }
  });

  sock.ev.on("group-participants.update", async (update) => {
    const { id, participants, action } = update;
    if (id === submissionGroupJid && action === "add") {
      for (const user of participants) {
        if (!users[user]) {
          users[user] = {
            balance: 0,
            completedTasks: [],
            account: "",
            taskHistory: {}
          };
          saveAll();
        }
        await sock.sendMessage(id, {
          text: `👋 Welcome @${user.split('@')[0]}!\nUse these:\n/balance, /withdraw, /account, /done, /work`,
          mentions: [user]
        });
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

    // Print group or user JID
    console.log(`📥 Message received from JID: ${from}`);

    const command = text.trim();
    const prefix = ["/", ".", "!"].find((p) => command.startsWith(p));
    if (!prefix) return;

    const args = command.slice(1).split(" ");
    const cmd = args.shift().toLowerCase();

    users[sender] = users[sender] || {
      balance: 0,
      completedTasks: [],
      account: "",
      taskHistory: {}
    };

    if (cmd === "work") {
      return await sock.sendMessage(from, {
        text: `🛠 *How to Work:*
1. Admin posts: !task <url> <task_id>
2. You submit proof: !done (attach screenshot/video)
3. Admin approves via: !g <task_id>

💰 Earn Rs.2/day for 5 days per task
💸 Minimum withdraw: Rs.50

📌 Commands:
/balance /withdraw /account /done /work`
      });
    }

    if (cmd === "balance") {
      const u = users[sender];
      return await sock.sendMessage(from, {
        text: `💰 Balance: Rs.${u.balance}\n📌 Tasks Completed: ${u.completedTasks.length}`,
        mentions: [sender]
      });
    }

    if (cmd === "account") {
      const acc = args.join(" ");
      if (!acc) return await sock.sendMessage(from, {
        text: `❌ Format:\n!account Jazzcash Ali 03001234567`
      });
      users[sender].account = acc;
      saveAll();
      return await sock.sendMessage(from, {
        text: `✅ Account saved.`,
        mentions: [sender]
      });
    }

    if (cmd === "withdraw") {
      const u = users[sender];
      if (!u.account) return await sock.sendMessage(from, {
        text: `⚠️ Set your account first using !account`,
        mentions: [sender]
      });
      if (u.balance < 50) return await sock.sendMessage(from, {
        text: `❌ Minimum Rs.50 required to withdraw.`,
        mentions: [sender]
      });

      await sock.sendMessage(withdrawGroupJid, {
        text: `💸 Withdraw Request:\n• User: wa.me/${sender.split("@")[0]}\n• Account: ${u.account}\n• Amount: Rs.${u.balance}`
      });
      return await sock.sendMessage(from, {
        text: `🕒 Withdraw request submitted. You'll be paid in 1 hour.`,
        mentions: [sender]
      });
    }

    if (cmd === "task" && from === resultsGroupJid) {
      const url = args[0];
      const taskId = args[1];
      if (!url || !taskId) return;

      tasks[taskId] = { url, created: todayDate() };
      saveAll();

      return await sock.sendMessage(resultsGroupJid, {
        text: `📢 *New Task ${taskId}*\n🔗 ${url}`
      });
    }

    if (cmd === "done") {
      if (!msg.message.imageMessage && !msg.message.videoMessage) {
        return await sock.sendMessage(from, { text: "⚠️ Attach media with !done" });
      }

      const media = msg.message.imageMessage || msg.message.videoMessage;
      const caption = `📩 Submission by @${sender.split('@')[0]}\nReply with !g <task_id> or !reject <task_id>`;
      return await sock.sendMessage(resultsGroupJid, {
        image: media,
        caption,
        mentions: [sender]
      });
    }

    if ((cmd === "g" || cmd === "reject") && msg.message.extendedTextMessage?.contextInfo?.participant) {
      const taskId = args[0];
      const userId = msg.message.extendedTextMessage.contextInfo.participant;
      if (!taskId || !tasks[taskId] || !users[userId]) return;

      const today = todayDate();
      let history = users[userId].taskHistory[taskId] || [];

      if (cmd === "g") {
        if (history.includes(today) || history.length >= 5) {
          return await sock.sendMessage(from, {
            text: `⚠️ Already approved or 5 days completed.`,
            mentions: [userId]
          });
        }
        history.push(today);
        users[userId].taskHistory[taskId] = history;
        users[userId].balance += 2;
        users[userId].completedTasks.push(taskId);
        saveAll();

        return await sock.sendMessage(resultsGroupJid, {
          text: `✅ @${userId.split("@")[0]} earned Rs.2 for Task ${taskId}`,
          mentions: [userId]
        });
      } else {
        return await sock.sendMessage(resultsGroupJid, {
          text: `❌ @${userId.split("@")[0]} your Task ${taskId} was rejected.`,
          mentions: [userId]
        });
      }
    }

    if (cmd === "wap" && from === withdrawGroupJid && msg.message.extendedTextMessage?.contextInfo?.participant) {
      const userId = msg.message.extendedTextMessage.contextInfo.participant;
      if (users[userId]) {
        users[userId].balance = 0;
        saveAll();
        return await sock.sendMessage(resultsGroupJid, {
          text: `🎉 @${userId.split("@")[0]} your withdrawal has been approved!`,
          mentions: [userId]
        });
      }
    }

    if (cmd === "cleartemp") {
      fs.emptyDirSync(TEMP_FOLDER);
      return await sock.sendMessage(from, { text: "🧹 Cleared temp folder!" });
    }
  });
}

startBot();
