const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const StellarSdk = require("@stellar/stellar-sdk");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const {
  StrKey,
  Keypair,
  Networks,
  Horizon,
  Server,
  TransactionBuilder,
  Asset,
} = require("@stellar/stellar-sdk");


const horizonUrl = "https://horizon-testnet.stellar.org";
const server = new Horizon.Server(horizonUrl);

// Simulated database file
const dbFilePath = path.join(__dirname, "db.json");
let userWallets = JSON.parse(fs.readFileSync(dbFilePath, "utf-8") || "{}");
let currentState = {};

// Utility functions to handle encryption and decryption
const algorithm = "aes-256-cbc";
const key = crypto.randomBytes(32);
const iv = Buffer.alloc(16, 0)

function encrypt(text, pin) {
  const cipher = crypto.createCipheriv(
    algorithm,
    crypto.scryptSync(pin, "salt", 32),
    iv
  );
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
}

function decrypt(text, pin) {
  console.log("encrypted: ", text);
  const decipher = crypto.createDecipheriv(
    algorithm,
    crypto.scryptSync(pin, "salt", 32),
    iv
  );
  let decrypted = decipher.update(text, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

async function fetchAccount(publicKey) {
  if (StrKey.isValidEd25519PublicKey(publicKey)) {
    try {
      let account = await server.accounts().accountId(publicKey).call();
      return account;
    } catch (err) {
      // @ts-ignore
      if (err.response?.status === 404) {
        throw error(404, "account not funded on network");
      } else {
        // @ts-ignore
        throw error(err.response?.status ?? 400, {
          // @ts-ignore
          message: `${err.response?.title} - ${err.response?.detail}`,
        });
      }
    }
  } else {
    throw error(400, { message: "invalid public key" });
  }
}

async function createWallet(sock, senderId) {
  const keypair = StellarSdk.Keypair.random();
  const publicKey = keypair.publicKey();
  const privateKey = keypair.secret();
  currentState[senderId] = { state: "AWAITING_PIN", publicKey, privateKey };
  await sock.sendMessage(senderId, {
    text: "Please create a PIN for your wallet:",
  });
}

async function checkBalance(sock, senderId) {
  const userWallet = userWallets[senderId];
  if (!userWallet) {
    await sock.sendMessage(senderId, {
      text: "You don't have a wallet yet. Create one using /create.",
    });
    return;
  }

  const publicKey = userWallet.publicKey;

  try {
    const account = await fetchAccount(publicKey);
    const balance = account.balances.find(
      (asset) => asset.asset_type === "native"
    ).balance;

    await sock.sendMessage(senderId, {
      text: `Your XLM balance is: ${balance}`,
    });
  } catch (error) {
    console.error("Error fetching account balance:", error);
    await sock.sendMessage(senderId, {
      text: "Error checking balance. Please try again later.",
    });
  }
}

async function getPublicKey(sock, senderId) {
  const userWallet = userWallets[senderId];
  if (!userWallet) {
    await sock.sendMessage(senderId, {
      text: "You don't have a wallet yet. Create one using /create.",
    });
    return;
  }

  const publicKey = userWallet.publicKey;
  await sock.sendMessage(senderId, {
    text: `Your public key is: ${publicKey}`,
  });
}

async function showHelp(sock, senderId) {
  const helpText = `*fckWallet Doc:*

> _/create_ - Create a new wallet

> _/balance_ - Check your XLM balance

> _/getKey_ - Show your public key

> _/send_ - Send XLM to another user

> _/confirm_ - Confirm a pending transaction

> _/help_ - Show this help message`;

  await sock.sendMessage(senderId, { text: helpText });
}

/**
 * Connects to WhatsApp and handles incoming messages.
 * @returns {Promise<void>} A promise that resolves when the connection is established.
 */
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("QR Code: ");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(
        "connection closed due to ",
        lastDisconnect.error,
        ", reconnecting ",
        shouldReconnect
      );
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === "open") {
      console.log("opened connection");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];

    if (!m.key.fromMe && m.message) {
      const senderId = m.key.remoteJid;
      const messageText =
        m.message.conversation ||
        (m.message.extendedTextMessage && m.message.extendedTextMessage.text);

      if (messageText) {
        if (messageText.startsWith("/")) {
          await handleCommand(sock, senderId, messageText);
        } else if (currentState[senderId]) {
          await handleState(sock, senderId, messageText);
        }
      }
    }
  });
}

async function handleCommand(sock, senderId, command) {
  switch (command) {
    case "/create":
      if (userWallets[senderId]) {
        await sock.sendMessage(senderId, {
          text: "You already have a wallet.",
        });
      } else {
        await createWallet(sock, senderId);
      }
      break;
    case "/balance":
      await checkBalance(sock, senderId);
      break;
    case "/send":
      currentState[senderId] = { state: "AWAITING_RECIPIENT" };
      await sock.sendMessage(senderId, {
        text: "Please enter the recipient's phone number:",
      });
      break;
    case "/confirm":
      await confirmTransaction(sock, senderId);
      break;
    case "/help":
      await showHelp(sock, senderId);
      break;
    case "/getKey":
      await getPublicKey(sock, senderId);
      break;
    default:
      await sock.sendMessage(senderId, {
        text: "Unknown command. Type /help for available commands.",
      });
      break;
  }
}

async function handleState(sock, senderId, message) {
  const userState = currentState[senderId];
  switch (userState.state) {
    case "AWAITING_PIN":
      userState.pin = message;
      userState.state = "AWAITING_PIN_CONFIRMATION";
      await sock.sendMessage(senderId, {
        text: "Please re-enter your PIN to confirm:",
      });
      break;
    case "AWAITING_PIN_CONFIRMATION":
      if (userState.pin === message) {
        const { publicKey, privateKey } = userState;
        const encryptedPrivateKey = encrypt(privateKey, userState.pin);
        userWallets[senderId] = { publicKey, encryptedPrivateKey };
        fs.writeFileSync(dbFilePath, JSON.stringify(userWallets, null, 2));
        await fetch("https://friendbot.stellar.org?addr=" + publicKey);
        await sock.sendMessage(senderId, {
          text: "Wallet created successfully!",
        });
        delete currentState[senderId];
      } else {
        await sock.sendMessage(senderId, {
          text: "PINs do not match. Please start over with /create.",
        });
        delete currentState[senderId];
      }
      break;
    case "AWAITING_RECIPIENT":
      userState.recipient = message;
      userState.state = "AWAITING_AMOUNT";
      await sock.sendMessage(senderId, {
        text: "Please enter the amount to send:",
      });
      break;
    case "AWAITING_AMOUNT":
      userState.amount = parseFloat(message);
      userState.state = "AWAITING_PIN_FOR_CONFIRMATION";
      await sock.sendMessage(senderId, {
        text: "Please enter your PIN to confirm the transaction:",
      });
      break;
    case "AWAITING_PIN_FOR_CONFIRMATION":
      userState.pin = message;
      await confirmTransaction(sock, senderId);
      break;
    default:
      break;
  }
}

async function confirmTransaction(sock, senderId) {
  const userState = currentState[senderId];
  if (!userState || userState.state !== "AWAITING_PIN_FOR_CONFIRMATION") {
    await sock.sendMessage(senderId, {
      text: "No pending transaction. Use /send to start a new transaction.",
    });
    return;
  }

  const { recipient, amount, pin } = userState;
  const senderWallet = userWallets[senderId];

  if (!senderWallet) {
    await sock.sendMessage(senderId, {
      text: "Sender wallet not found. Make sure you have created a wallet using /create.",
    });
    return;
  }

  try {
    const servers = new Horizon.Server("https://horizon-testnet.stellar.org");
    console.log("step1");
    const decryptedPrivateKey = decrypt(senderWallet.encryptedPrivateKey, pin);
    const updatedRecipient = `91${recipient}@s.whatsapp.net`;
    const recipientPublicKey = await getRecipientPublicKeyFromPhoneNumber(
      updatedRecipient
    );

    console.log("decryptedPrivateKey: ", decryptedPrivateKey);
    console.log("recipientPublicKey: ", recipientPublicKey);

    const keyPair = Keypair.fromSecret(
      decryptedPrivateKey
    );

    const publicKey = keyPair.publicKey();
    const senderAccount = await servers.loadAccount(publicKey);

    const transaction = new TransactionBuilder(senderAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination:
            recipientPublicKey,
          asset: Asset.native(),
          amount: amount.toString(),
        })
      )
      .setTimeout(3000)
      .build();

    transaction.sign(keyPair);
    const result = await servers.submitTransaction(transaction);

    await sock.sendMessage(senderId, {
      text: `Payment of ${amount} XLM sent to recipient.`,
    });

    delete currentState[senderId];
  } catch (error) {
    console.error("Transaction failed:", error);
    await sock.sendMessage(senderId, {
      text: "Transaction failed. Please try again later.",
    });
  }
}

async function fetchRecipientFromDB(recipientPhoneNumber) {
  try {
    // Assuming userWallets is your database object where phone numbers are keys
    const recipientData = userWallets[recipientPhoneNumber];

    if (!recipientData || !recipientData.publicKey) {
      throw new Error(`Recipient not found for ${recipientPhoneNumber}`);
    }

    return recipientData.publicKey;
  } catch (error) {
    console.error("Error fetching recipient from DB:", error);
    throw error;
  }
}

function extractPhoneNumber(senderId) {
  // Assuming senderId format is 'country code + 10-digit number + @s.whatsapp.net'
  const phoneNumber = senderId.split("@")[0]; // Get everything before '@'
  return phoneNumber;
}

async function getRecipientPublicKeyFromPhoneNumber(recipientPhoneNumber) {
  try {
    // Simulated database lookup
    const recipientData = userWallets[recipientPhoneNumber];

    if (!recipientData || !recipientData.publicKey) {
      throw new Error(`Recipient not found for ${recipientPhoneNumber}`);
    }

    return recipientData.publicKey;
  } catch (error) {
    console.error("Error fetching recipient from database:", error);
    throw error;
  }
}

connectToWhatsApp();
