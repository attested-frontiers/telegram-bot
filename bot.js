require('dotenv').config();
const { WebSocketProvider, Interface } = require('ethers');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Telegram setup
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Database helper functions
class DatabaseManager {
  // Initialize user if not exists
  async initUser(chatId, username = null, firstName = null, lastName = null) {
    const { data, error } = await supabase
      .from('users')
      .upsert({ 
        chat_id: chatId,
        username: username,
        first_name: firstName,
        last_name: lastName,
        last_active: new Date().toISOString() 
      }, { 
        onConflict: 'chat_id',
        ignoreDuplicates: false 
      });
    
    if (error) console.error('Error initializing user:', error);
    return data;
  }

  // Get user's ACTIVE tracked deposits only
  async getUserDeposits(chatId) {
    const { data, error } = await supabase
      .from('user_deposits')
      .select('deposit_id, status')
      .eq('chat_id', chatId)
      .eq('is_active', true); // Only get active deposits
    
    if (error) {
      console.error('Error fetching user deposits:', error);
      return new Set();
    }
    
    return new Set(data.map(row => row.deposit_id));
  }

  // Get user's ACTIVE deposit states only
  async getUserDepositStates(chatId) {
    const { data, error } = await supabase
      .from('user_deposits')
      .select('deposit_id, status, intent_hash')
      .eq('chat_id', chatId)
      .eq('is_active', true); // Only get active deposits
    
    if (error) {
      console.error('Error fetching user deposit states:', error);
      return new Map();
    }
    
    const statesMap = new Map();
    data.forEach(row => {
      statesMap.set(row.deposit_id, {
        status: row.status,
        intentHash: row.intent_hash
      });
    });
    
    return statesMap;
  }

  // Add deposit for user (always creates as active)
  async addUserDeposit(chatId, depositId) {
    const { error } = await supabase
      .from('user_deposits')
      .upsert({ 
        chat_id: chatId, 
        deposit_id: depositId,
        status: 'tracking',
        is_active: true, // Explicitly set as active
        created_at: new Date().toISOString()
      }, { 
        onConflict: 'chat_id,deposit_id' 
      });
    
    if (error) console.error('Error adding deposit:', error);
  }

  // Remove deposit - mark as inactive instead of deleting
  async removeUserDeposit(chatId, depositId) {
    const { error } = await supabase
      .from('user_deposits')
      .update({ 
        is_active: false,
        updated_at: new Date().toISOString()
      })
      .eq('chat_id', chatId)
      .eq('deposit_id', depositId);
    
    if (error) console.error('Error removing deposit:', error);
  }

  // Update deposit status (only for active deposits)
  async updateDepositStatus(chatId, depositId, status, intentHash = null) {
    const updateData = { 
      status: status,
      updated_at: new Date().toISOString()
    };
    
    if (intentHash) {
      updateData.intent_hash = intentHash;
    }

    const { error } = await supabase
      .from('user_deposits')
      .update(updateData)
      .eq('chat_id', chatId)
      .eq('deposit_id', depositId)
      .eq('is_active', true); // Only update active deposits
    
    if (error) console.error('Error updating deposit status:', error);
  }

  // Get ACTIVE listen all preference only
  async getUserListenAll(chatId) {
    const { data, error } = await supabase
      .from('user_settings')
      .select('listen_all')
      .eq('chat_id', chatId)
      .eq('is_active', true) // Only get active settings
      .single();
    
    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
      console.error('Error getting listen all:', error);
    }
    return data?.listen_all || false;
  }

  async setUserListenAll(chatId, listenAll) {
    const { error } = await supabase
      .from('user_settings')
      .upsert({ 
        chat_id: chatId, 
        listen_all: listenAll,
        is_active: true, // Always active when setting
        updated_at: new Date().toISOString()
      }, { 
        onConflict: 'chat_id' 
      });
    
    if (error) console.error('Error setting listen all:', error);
  }

  // Clear user data - mark as inactive (PRESERVES DATA FOR ANALYTICS)
  async clearUserData(chatId) {
    const timestamp = new Date().toISOString();
    
    // Mark deposits as inactive instead of deleting
    const { error: error1 } = await supabase
      .from('user_deposits')
      .update({ 
        is_active: false,
        updated_at: timestamp
      })
      .eq('chat_id', chatId);
    
    // Mark settings as inactive instead of deleting  
    const { error: error2 } = await supabase
      .from('user_settings')
      .update({ 
        is_active: false,
        updated_at: timestamp
      })
      .eq('chat_id', chatId);
    
    if (error1) console.error('Error clearing user deposits:', error1);
    if (error2) console.error('Error clearing user settings:', error2);
  }

  // Log event notification (for analytics)
  async logEventNotification(chatId, depositId, eventType) {
    const { error } = await supabase
      .from('event_notifications')
      .insert({
        chat_id: chatId,
        deposit_id: depositId,
        event_type: eventType,
        sent_at: new Date().toISOString()
      });
    
    if (error) console.error('Error logging notification:', error);
  }

  // Get users interested in a deposit (only ACTIVE users/settings)
  async getUsersInterestedInDeposit(depositId) {
    // Users listening to all deposits (ACTIVE settings only)
    const { data: allListeners } = await supabase
      .from('user_settings')
      .select('chat_id')
      .eq('listen_all', true)
      .eq('is_active', true); // Only active "listen all" users
    
    // Users tracking specific deposit (ACTIVE tracking only)
    const { data: specificTrackers } = await supabase
      .from('user_deposits')
      .select('chat_id')
      .eq('deposit_id', depositId)
      .eq('is_active', true); // Only active deposit tracking
    
    const allUsers = new Set();
    
    allListeners?.forEach(user => allUsers.add(user.chat_id));
    specificTrackers?.forEach(user => allUsers.add(user.chat_id));
    
    return Array.from(allUsers);
  }

  // BONUS: Analytics methods (new!)
  async getAnalytics() {
    // Total users who ever used the bot
    const { data: totalUsers } = await supabase
      .from('users')
      .select('chat_id', { count: 'exact' });

    // Currently active trackers
    const { data: activeTrackers } = await supabase
      .from('user_deposits')
      .select('chat_id', { count: 'exact' })
      .eq('is_active', true);

    // Total tracking sessions (including cleared ones)
    const { data: allTimeTracking } = await supabase
      .from('user_deposits')
      .select('chat_id', { count: 'exact' });

    // Most tracked deposits
    const { data: popularDeposits } = await supabase
      .from('user_deposits')
      .select('deposit_id')
      .eq('is_active', true);

    return {
      totalUsers: totalUsers?.length || 0,
      activeTrackers: activeTrackers?.length || 0,
      allTimeTracking: allTimeTracking?.length || 0,
      popularDeposits: popularDeposits || []
    };
  }
}

const db = new DatabaseManager();

// Enhanced WebSocket Provider with reconnection
class ResilientWebSocketProvider {
  constructor(url, contractAddress, eventHandler) {
    this.url = url;
    this.contractAddress = contractAddress;
    this.eventHandler = eventHandler;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 50;
    this.isConnecting = false;
    this.provider = null;
    
    this.connect();
  }

  async connect() {
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      console.log(`🔌 Attempting WebSocket connection (attempt ${this.reconnectAttempts + 1})`);
      
      if (this.provider) {
        this.provider.removeAllListeners();
        this.provider.destroy?.();
      }

      this.provider = new WebSocketProvider(this.url);
      this.setupEventListeners();
      await this.provider.getNetwork();
      
      console.log('✅ WebSocket connected successfully');
      
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
      this.isConnecting = false;
      
      this.setupContractListening();
      
    } catch (error) {
      console.error('❌ WebSocket connection failed:', error.message);
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  setupEventListeners() {
    this.provider.on('error', (error) => {
      console.error('❌ WebSocket error:', error.message);
      this.scheduleReconnect();
    });

    this.provider.on('close', (code, reason) => {
      console.log(`🔌 WebSocket closed: ${code} - ${reason}`);
      this.scheduleReconnect();
    });

    this.provider.on('network', (newNetwork, oldNetwork) => {
      if (oldNetwork) {
        console.log('🌐 Network changed, reconnecting...');
        this.scheduleReconnect();
      }
    });
  }

  setupContractListening() {
    if (!this.provider) return;
    
    try {
      this.provider.on({ address: this.contractAddress.toLowerCase() }, this.eventHandler);
      console.log(`👂 Listening for events on contract: ${this.contractAddress}`);
    } catch (error) {
      console.error('❌ Failed to set up contract listening:', error.message);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.isConnecting) return;
    
    this.reconnectAttempts++;
    
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(`💀 Max reconnection attempts (${this.maxReconnectAttempts}) reached. Stopping.`);
      return;
    }

    const delay = Math.min(
      this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts), 
      this.maxReconnectDelay
    );
    
    console.log(`⏰ Scheduling reconnection in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      this.connect();
    }, delay);
  }

  get currentProvider() {
    return this.provider;
  }
}

// ZKP2P Escrow contract on Base
const contractAddress = '0xca38607d85e8f6294dc10728669605e6664c2d70';

// ABI with exact event definitions from the contract
const abi = [
  `event IntentSignaled(
    bytes32 indexed intentHash,
    uint256 indexed depositId,
    address indexed verifier,
    address owner,
    address to,
    uint256 amount,
    bytes32 fiatCurrency,
    uint256 conversionRate,
    uint256 timestamp
  )`,
  `event IntentFulfilled(
    bytes32 indexed intentHash,
    uint256 indexed depositId,
    address indexed verifier,
    address owner,
    address to,
    uint256 amount,
    uint256 sustainabilityFee,
    uint256 verifierFee
  )`,
  `event IntentPruned(
    bytes32 indexed intentHash,
    uint256 indexed depositId
  )`
];

const iface = new Interface(abi);
const pendingPrunedEvents = new Map();

// Verifier address to platform mapping
const verifierMapping = {
  '0x76d33a33068d86016b806df02376ddbb23dd3703': { platform: 'CashApp', isUsdOnly: true },
  '0x9a733b55a875d0db4915c6b36350b24f8ab99df5': { platform: 'Venmo', isUsdOnly: true },
  '0xaa5a1b62b01781e789c900d616300717cd9a41ab': { platform: 'Revolut', isUsdOnly: false },
  '0xff0149799631d7a5bde2e7ea9b306c42b3d9a9ca': { platform: 'Wise', isUsdOnly: false },
  '0x1783f040783c0827fb64d128ece548d9b3613ad5': { platform: 'Zelle', isUsdOnly: true }
};

const getPlatformName = (verifierAddress) => {
  const mapping = verifierMapping[verifierAddress.toLowerCase()];
  return mapping ? mapping.platform : `Unknown (${verifierAddress.slice(0, 6)}...${verifierAddress.slice(-4)})`;
};

// Telegram commands - now using database
bot.onText(/\/deposit (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim().toLowerCase();
  
  // Initialize user
  await db.initUser(chatId, msg.from.username, msg.from.first_name, msg.from.last_name);
  
  if (input === 'all') {
    await db.setUserListenAll(chatId, true);
    bot.sendMessage(chatId, `🌍 *Now listening to ALL deposits!*\n\nYou will receive notifications for every event on every deposit.\n\nUse \`/deposit stop\` to stop listening to all deposits.`, { parse_mode: 'Markdown' });
    return;
  }
  
  if (input === 'stop') {
    await db.setUserListenAll(chatId, false);
    bot.sendMessage(chatId, `🛑 *Stopped listening to all deposits.*\n\nYou will now only receive notifications for specifically tracked deposits.`, { parse_mode: 'Markdown' });
    return;
  }
  
  const newIds = input.split(/[,\s]+/).map(id => parseInt(id.trim())).filter(id => !isNaN(id));
  
  if (newIds.length === 0) {
    bot.sendMessage(chatId, `❌ No valid deposit IDs provided. Use:\n• \`/deposit all\` - Listen to all deposits\n• \`/deposit 123\` - Track specific deposit\n• \`/deposit 123,456,789\` - Track multiple deposits`, { parse_mode: 'Markdown' });
    return;
  }
  
  for (const id of newIds) {
    await db.addUserDeposit(chatId, id);
  }
  
  const userDeposits = await db.getUserDeposits(chatId);
  const idsArray = Array.from(userDeposits).sort((a, b) => a - b);
  bot.sendMessage(chatId, `✅ Now tracking deposit IDs: \`${idsArray.join(', ')}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/remove (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const idsString = match[1];
  const idsToRemove = idsString.split(/[,\s]+/).map(id => parseInt(id.trim())).filter(id => !isNaN(id));
  
  if (idsToRemove.length === 0) {
    bot.sendMessage(chatId, `❌ No valid deposit IDs provided. Use: /remove 123 or /remove 123,456,789`, { parse_mode: 'Markdown' });
    return;
  }
  
  for (const id of idsToRemove) {
    await db.removeUserDeposit(chatId, id);
  }
  
  const userDeposits = await db.getUserDeposits(chatId);
  const remainingIds = Array.from(userDeposits).sort((a, b) => a - b);
  
  if (remainingIds.length > 0) {
    bot.sendMessage(chatId, `✅ Removed specified IDs. Still tracking: \`${remainingIds.join(', ')}\``, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, `✅ Removed specified IDs. No deposits being tracked.`, { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  const userDeposits = await db.getUserDeposits(chatId);
  const userStates = await db.getUserDepositStates(chatId);
  const listeningAll = await db.getUserListenAll(chatId);
  
  let message = '';
  
  if (listeningAll) {
    message += `🌍 *Listening to ALL deposits*\n\n`;
  }
  
  const idsArray = Array.from(userDeposits).sort((a, b) => a - b);
  if (idsArray.length === 0 && !listeningAll) {
    bot.sendMessage(chatId, `📋 No deposits currently being tracked.`, { parse_mode: 'Markdown' });
    return;
  }
  
  if (idsArray.length > 0) {
    message += `📋 *Specifically tracking ${idsArray.length} deposits:*\n\n`;
    idsArray.forEach(id => {
      const state = userStates.get(id);
      const status = state ? state.status : 'tracking';
      const emoji = status === 'fulfilled' ? '✅' : 
                    status === 'pruned' ? '🟠' : '👀';
      message += `${emoji} \`${id}\` - ${status}\n`;
    });
  }
  
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/clearall/, async (msg) => {
  const chatId = msg.chat.id;
  await db.clearUserData(chatId);
  bot.sendMessage(chatId, `🗑️ Cleared all tracked deposit IDs and stopped listening to all deposits.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const isConnected = resilientProvider.currentProvider !== null;
  const statusEmoji = isConnected ? '🟢' : '🔴';
  const statusText = isConnected ? 'Connected' : 'Disconnected';
  const listeningAll = await db.getUserListenAll(chatId);
  const trackedCount = (await db.getUserDeposits(chatId)).size;
  
  let message = `${statusEmoji} *WebSocket Status:* ${statusText}\n\n`;
  
  if (listeningAll) {
    message += `🌍 *Listening to:* ALL deposits\n`;
  } else {
    message += `📋 *Tracking:* ${trackedCount} specific deposits\n`;
  }
  
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `
🤖 *ZKP2P Tracker Commands:*

• \`/deposit all\` - Listen to ALL deposits (every event)
• \`/deposit stop\` - Stop listening to all deposits
• \`/deposit 123\` - Track a specific deposit
• \`/deposit 123,456,789\` - Track multiple deposits
• \`/deposit 123 456 789\` - Track multiple deposits (space separated)
• \`/remove 123\` - Stop tracking specific deposit(s)
• \`/list\` - Show tracking status and tracked deposits
• \`/clearall\` - Stop all tracking (specific + all)
• \`/status\` - Check WebSocket connection and tracking status
• \`/help\` - Show this help message

*Note: Each user has their own tracking settings*
`.trim();
  
  bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Helper functions
const formatUSDC = (amount) => (Number(amount) / 1e6).toFixed(2);
const formatTimestamp = (ts) => new Date(Number(ts) * 1000).toUTCString();
const txLink = (hash) => `https://basescan.org/tx/${hash}`;
const depositLink = (id) => `https://www.zkp2p.xyz/deposit/${id}`;

const fiatCurrencyMap = {
  '0x4dab77a640748de8588de6834d814a344372b205265984b969f3e97060955bfa': 'AED',
  '0xcb83cbb58eaa5007af6cad99939e4581c1e1b50d65609c30f303983301524ef3': 'AUD',
  '0x221012e06ebf59a20b82e3003cf5d6ee973d9008bdb6e2f604faa89a27235522': 'CAD',
  '0xc9d84274fd58aa177cabff54611546051b74ad658b939babaad6282500300d36': 'CHF',
  '0xfaaa9c7b2f09d6a1b0971574d43ca62c3e40723167c09830ec33f06cec921381': 'CNY',
  '0xfff16d60be267153303bbfa66e593fb8d06e24ea5ef24b6acca5224c2ca6b907': 'EUR',
  '0x90832e2dc3221e4d56977c1aa8f6a6706b9ad6542fbbdaac13097d0fa5e42e67': 'GBP',
  '0xa156dad863111eeb529c4b3a2a30ad40e6dcff3b27d8f282f82996e58eee7e7d': 'HKD',
  '0xc681c4652bae8bd4b59bec1cdb90f868d93cc9896af9862b196843f54bf254b3': 'IDR',
  '0x313eda7ae1b79890307d32a78ed869290aeb24cc0e8605157d7e7f5a69fea425': 'ILS',
  '0xfe13aafd831cb225dfce3f6431b34b5b17426b6bff4fccabe4bbe0fe4adc0452': 'JPY',
  '0x589be49821419c9c2fbb26087748bf3420a5c13b45349828f5cac24c58bbaa7b': 'KES',
  '0xa94b0702860cb929d0ee0c60504dd565775a058bf1d2a2df074c1db0a66ad582': 'MXN',
  '0xf20379023279e1d79243d2c491be8632c07cfb116be9d8194013fb4739461b84': 'MYR',
  '0xdbd9d34f382e9f6ae078447a655e0816927c7c3edec70bd107de1d34cb15172e': 'NZD',
  '0x9a788fb083188ba1dfb938605bc4ce3579d2e085989490aca8f73b23214b7c1d': 'PLN',
  '0xf998cbeba8b7a7e91d4c469e5fb370cdfa16bd50aea760435dc346008d78ed1f': 'SAR',
  '0xc241cc1f9752d2d53d1ab67189223a3f330e48b75f73ebf86f50b2c78fe8df88': 'SGD',
  '0x326a6608c2a353275bd8d64db53a9d772c1d9a5bc8bfd19dfc8242274d1e9dd4': 'THB',
  '0x128d6c262d1afe2351c6e93ceea68e00992708cfcbc0688408b9a23c0c543db2': 'TRY',
  '0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e': 'USD',
  '0xe85548baf0a6732cfcc7fc016ce4fd35ce0a1877057cfec6e166af4f106a3728': 'VND',
  '0x53611f0b3535a2cfc4b8deb57fa961ca36c7b2c272dfe4cb239a29c48e549361': 'ZAR',
  '0x8fd50654b7dd2dc839f7cab32800ba0c6f7f66e1ccf89b21c09405469c2175ec': 'ARS'
};

const getFiatCode = (hash) => fiatCurrencyMap[hash.toLowerCase()] || '❓ Unknown';

const formatConversionRate = (conversionRate, fiatCode) => {
  const rate = (Number(conversionRate) / 1e18).toFixed(6);
  return `${rate} ${fiatCode} / USDC`;
};

const createDepositKeyboard = (depositId) => {
  return {
    inline_keyboard: [[
      {
        text: `🔗 View Deposit ${depositId}`,
        url: depositLink(depositId)
      }
    ]]
  };
};

// Event handler function - now using database
const handleContractEvent = async (log) => {
  console.log('\n📦 Raw log received:');
  console.log(log);

  try {
    const parsed = iface.parseLog({ 
      data: log.data, 
      topics: log.topics 
    });
    
    if (!parsed) {
      console.log('⚠️ Log format did not match our ABI');
      console.log('📝 Event signature:', log.topics[0]);
      
      if (log.topics.length >= 3) {
        const topicDepositId = parseInt(log.topics[2], 16);
        console.log('📊 Extracted deposit ID from topic:', topicDepositId);
        
        const interestedUsers = await db.getUsersInterestedInDeposit(topicDepositId);
        if (interestedUsers.length > 0) {
          console.log(`⚠️ Sending unrecognized event to ${interestedUsers.length} users`);
          
          const message = `
⚠️ *Unrecognized Event for Deposit*
• *Deposit ID:* \`${topicDepositId}\`
• *Event Signature:* \`${log.topics[0]}\`
• *Block:* ${log.blockNumber}
• *Tx:* [View on BaseScan](${txLink(log.transactionHash)})
`.trim();
          
          interestedUsers.forEach(chatId => {
            bot.sendMessage(chatId, message, { 
              parse_mode: 'Markdown', 
              disable_web_page_preview: true,
              reply_markup: createDepositKeyboard(topicDepositId)
            });
          });
        }
      }
      return;
    }
    
    console.log('✅ Parsed log:', parsed.name);
    console.log('🔍 Args:', parsed.args);

    const { name } = parsed;

    if (name === 'IntentSignaled') {
      const { intentHash, depositId, verifier, owner, to, amount, fiatCurrency, conversionRate, timestamp } = parsed.args;    
      const id = Number(depositId);
      const fiatCode = getFiatCode(fiatCurrency);
      const fiatAmount = ((Number(amount) / 1e6) * (Number(conversionRate) / 1e18)).toFixed(2);
      const platformName = getPlatformName(verifier);
      const formattedRate = formatConversionRate(conversionRate, fiatCode);
      
      console.log('🧪 IntentSignaled depositId:', id);

      const interestedUsers = await db.getUsersInterestedInDeposit(id);
      if (interestedUsers.length === 0) {
        console.log('🚫 Ignored — no users interested in this depositId.');
        return;
      }

      console.log(`📤 Sending to ${interestedUsers.length} users interested in deposit ${id}`);

      const message = `
🟡 *Order Created*
• *Deposit ID:* \`${id}\`
• *Order ID:* \`${intentHash}\`
• *Platform:* ${platformName}
• *Owner:* \`${owner}\`
• *To:* \`${to}\`
• *Amount:* ${formatUSDC(amount)} USDC
• *Fiat Amount:* ${fiatAmount} ${fiatCode} 
• *Rate:* ${formattedRate}
• *Time:* ${formatTimestamp(timestamp)}
• *Block:* ${log.blockNumber}
• *Tx:* [View on BaseScan](${txLink(log.transactionHash)})
`.trim();

      for (const chatId of interestedUsers) {
        await db.updateDepositStatus(chatId, id, 'signaled', intentHash);
        await db.logEventNotification(chatId, id, 'signaled');
        
        bot.sendMessage(chatId, message, { 
          parse_mode: 'Markdown', 
          disable_web_page_preview: true,
          reply_markup: createDepositKeyboard(id)
        });
      }
    }

    if (name === 'IntentFulfilled') {
      const { intentHash, depositId, verifier, owner, to, amount, sustainabilityFee, verifierFee } = parsed.args;
      const id = Number(depositId);
      const txHash = log.transactionHash;
      const platformName = getPlatformName(verifier);
      
      console.log('🧪 IntentFulfilled depositId:', id);

      const interestedUsers = await db.getUsersInterestedInDeposit(id);
      if (interestedUsers.length === 0) {
        console.log('🚫 Ignored — no users interested in this depositId.');
        return;
      }

      if (pendingPrunedEvents.has(txHash)) {
        console.log('🔄 Cancelling IntentPruned notification - order was fulfilled');
        pendingPrunedEvents.delete(txHash);
      }

      console.log(`📤 Sending fulfillment to ${interestedUsers.length} users interested in deposit ${id}`);

      const message = `
🟢 *Order Fulfilled*
• *Deposit ID:* \`${id}\`
• *Order ID:* \`${intentHash}\`
• *Platform:* ${platformName}
• *Owner:* \`${owner}\`
• *To:* \`${to}\`
• *Amount:* ${formatUSDC(amount)} USDC
• *Sustainability Fee:* ${formatUSDC(sustainabilityFee)} USDC
• *Verifier Fee:* ${formatUSDC(verifierFee)} USDC
• *Block:* ${log.blockNumber}
• *Tx:* [View on BaseScan](${txLink(log.transactionHash)})
`.trim();

      for (const chatId of interestedUsers) {
        await db.updateDepositStatus(chatId, id, 'fulfilled', intentHash);
        await db.logEventNotification(chatId, id, 'fulfilled');
        
        bot.sendMessage(chatId, message, { 
          parse_mode: 'Markdown', 
          disable_web_page_preview: true,
          reply_markup: createDepositKeyboard(id)
        });
      }
    }

    if (name === 'IntentPruned') {
      const { intentHash, depositId } = parsed.args;
      const id = Number(depositId);
      console.log('🧪 IntentPruned depositId:', id);

      const interestedUsers = await db.getUsersInterestedInDeposit(id);
      if (interestedUsers.length === 0) {
        console.log('🚫 Ignored — no users interested in this depositId.');
        return;
      }

      const txHash = log.transactionHash;
      pendingPrunedEvents.set(txHash, {
        intentHash,
        depositId: id,
        blockNumber: log.blockNumber,
        txHash,
        interestedUsers
      });

      setTimeout(async () => {
        const prunedEvent = pendingPrunedEvents.get(txHash);
        if (prunedEvent) {
          console.log(`📤 Sending cancellation to ${prunedEvent.interestedUsers.length} users interested in deposit ${id}`);
          
          const message = `
🟠 *Order Cancelled*
• *Deposit ID:* \`${id}\`
• *Order ID:* \`${intentHash}\`
• *Block:* ${prunedEvent.blockNumber}
• *Tx:* [View on BaseScan](${txLink(prunedEvent.txHash)})

*Order was cancelled*
`.trim();

          for (const chatId of prunedEvent.interestedUsers) {
            await db.updateDepositStatus(chatId, id, 'pruned', intentHash);
            await db.logEventNotification(chatId, id, 'pruned');
            
            bot.sendMessage(chatId, message, { 
              parse_mode: 'Markdown', 
              disable_web_page_preview: true,
              reply_markup: createDepositKeyboard(id)
            });
          }
          
          pendingPrunedEvents.delete(txHash);
        }
      }, 2000);
    }

  } catch (err) {
    console.error('❌ Failed to parse log:', err.message);
    console.log('👀 Raw log (unparsed):', log);
    console.log('📝 Topics received:', log.topics);
    console.log('📝 First topic (event signature):', log.topics[0]);
    console.log('🔄 Continuing to listen for other events...');
  }
};

// Initialize the resilient WebSocket provider
const resilientProvider = new ResilientWebSocketProvider(
  process.env.BASE_RPC,
  contractAddress,
  handleContractEvent
);

// Add startup message
console.log('🤖 ZKP2P Telegram Bot Started (Supabase Integration with Auto-Reconnect)');
console.log('🔍 Listening for contract events...');
console.log(`📡 Contract: ${contractAddress}`);

// Enhanced error handlers
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🔄 Received SIGTERM, shutting down gracefully...');
  if (resilientProvider.currentProvider) {
    resilientProvider.currentProvider.removeAllListeners();
    resilientProvider.currentProvider.destroy?.();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🔄 Received SIGINT, shutting down gracefully...');
  if (resilientProvider.currentProvider) {
    resilientProvider.currentProvider.removeAllListeners();
    resilientProvider.currentProvider.destroy?.();
  }
  process.exit(0);
});
