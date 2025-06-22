const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

// Standalone DOK TOK Telegram Bot
// This bot connects directly to your database and runs independently

class StandaloneDokTokBot {
  constructor() {
    this.bot = null;
    this.pool = null;
    this.userSessions = new Map();
    this.loginStates = new Map();
    this.isRunning = false;
  }

  async initialize() {
    try {
      console.log('=== DOK TOK Standalone Bot Starting ===');
      
      // Database connection
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });

      // Test database
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      console.log('✓ Database connected successfully');

      // Get bot token
      const tokenResult = await this.pool.query('SELECT bot_token FROM bot_config LIMIT 1');
      const botToken = tokenResult.rows[0]?.bot_token;
      
      if (!botToken || botToken === 'TELEGRAM_BOT_TOKEN_NOT_SET') {
        throw new Error('Bot token not configured in database');
      }

      // Initialize bot
      this.bot = new TelegramBot(botToken, { 
        polling: { 
          interval: 1000,
          autoStart: true,
          params: { timeout: 30 }
        } 
      });

      // Verify bot
      const botInfo = await this.bot.getMe();
      console.log(`✓ Bot authenticated: @${botInfo.username}`);

      this.setupHandlers();
      this.startHealthCheck();
      this.isRunning = true;
      
      console.log('✓ DOK TOK Bot is now running independently');
      console.log('✓ Bot will continue running even when main app is offline');
      
    } catch (error) {
      console.error('✗ Bot initialization failed:', error.message);
      process.exit(1);
    }
  }

  setupHandlers() {
    // Start command
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      await this.bot.sendMessage(chatId, 
        `🏢 Welcome to DOK TOK Sales Order Management

Please login to access your orders:
📝 Send your username to begin`);
      this.loginStates.set(chatId, { step: 'username' });
    });

    // Orders command
    this.bot.onText(/\/orders/, async (msg) => {
      const chatId = msg.chat.id;
      const userId = this.userSessions.get(chatId);
      
      if (!userId) {
        await this.bot.sendMessage(chatId, '❌ Please login first using /start');
        return;
      }
      
      await this.showUserOrders(chatId, userId);
    });

    // Logout command
    this.bot.onText(/\/logout/, async (msg) => {
      const chatId = msg.chat.id;
      this.userSessions.delete(chatId);
      this.loginStates.delete(chatId);
      await this.bot.sendMessage(chatId, '✅ Logged out successfully');
    });

    // Handle text messages (login flow)
    this.bot.on('message', async (msg) => {
      if (msg.text && !msg.text.startsWith('/')) {
        await this.handleLoginFlow(msg);
      }
    });

    // Error handling
    this.bot.on('polling_error', (error) => {
      console.error('Polling error:', error.message);
    });

    console.log('✓ Bot message handlers configured');
  }

  async handleLoginFlow(msg) {
    const chatId = msg.chat.id;
    const text = msg.text;
    const loginState = this.loginStates.get(chatId);
    
    if (!loginState) {
      await this.bot.sendMessage(chatId, '❌ Please start with /start command');
      return;
    }
    
    if (loginState.step === 'username') {
      this.loginStates.set(chatId, { step: 'password', username: text });
      await this.bot.sendMessage(chatId, '🔐 Now send your password:');
      
    } else if (loginState.step === 'password') {
      const username = loginState.username;
      await this.authenticateUser(chatId, username, text);
    }
  }

  async authenticateUser(chatId, username, password) {
    try {
      // Query user from database
      const userResult = await this.pool.query(
        'SELECT * FROM users WHERE username = $1 AND status = $2',
        [username, 'approved']
      );
      
      if (userResult.rows.length === 0) {
        await this.bot.sendMessage(chatId, '❌ Invalid username or user not approved');
        this.loginStates.delete(chatId);
        return;
      }
      
      const user = userResult.rows[0];
      
      // Verify password
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        await this.bot.sendMessage(chatId, '❌ Invalid password');
        this.loginStates.delete(chatId);
        return;
      }
      
      // Successful login
      this.userSessions.set(chatId, user.id);
      this.loginStates.delete(chatId);
      
      const welcomeMsg = `✅ Welcome ${user.first_name} ${user.last_name}!
📊 Role: ${user.role}

Available commands:
📋 /orders - View your orders
🚪 /logout - Logout`;
      
      await this.bot.sendMessage(chatId, welcomeMsg);
      
    } catch (error) {
      console.error('Authentication error:', error);
      await this.bot.sendMessage(chatId, '❌ Login failed. Please try /start again');
      this.loginStates.delete(chatId);
    }
  }

  async showUserOrders(chatId, userId) {
    try {
      const ordersResult = await this.pool.query(`
        SELECT 
          id, order_number, customer_name, total_amount, status, created_at,
          product_type, unit, quantity, price
        FROM orders 
        WHERE sales_officer_id = $1 
        ORDER BY created_at DESC 
        LIMIT 10
      `, [userId]);
      
      const orders = ordersResult.rows;
      
      if (orders.length === 0) {
        await this.bot.sendMessage(chatId, '📭 No orders found');
        return;
      }
      
      let message = '📋 *Your Recent Orders:*\n\n';
      
      orders.forEach((order, index) => {
        const statusIcon = order.status === 'approved' ? '✅' : 
                         order.status === 'pending' ? '⏳' : '❌';
        
        message += `${index + 1}. ${statusIcon} *${order.order_number}*\n`;
        message += `   Customer: ${order.customer_name}\n`;
        message += `   Product: ${order.product_type} (${order.unit})\n`;
        message += `   Quantity: ${order.quantity}\n`;
        message += `   Amount: ${order.total_amount} ETB\n`;
        message += `   Status: ${order.status}\n`;
        message += `   Date: ${new Date(order.created_at).toLocaleDateString()}\n\n`;
      });
      
      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      
    } catch (error) {
      console.error('Error fetching orders:', error);
      await this.bot.sendMessage(chatId, '❌ Error loading orders');
    }
  }

  startHealthCheck() {
    // Health check every 5 minutes
    setInterval(async () => {
      try {
        if (this.bot && this.isRunning) {
          await this.bot.getMe();
          console.log(`${new Date().toISOString()} - Bot health check: OK`);
        }
      } catch (error) {
        console.error('Health check failed:', error.message);
      }
    }, 300000);

    console.log('✓ Health monitoring started (5-minute intervals)');
  }

  async shutdown() {
    console.log('🛑 Shutting down DOK TOK Bot...');
    
    if (this.bot) {
      await this.bot.stopPolling();
    }
    
    if (this.pool) {
      await this.pool.end();
    }
    
    this.isRunning = false;
    console.log('✅ Bot shutdown complete');
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  if (global.dokTokBot) {
    await global.dokTokBot.shutdown();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (global.dokTokBot) {
    await global.dokTokBot.shutdown();
  }
  process.exit(0);
});

// Start the bot
async function startDokTokBot() {
  try {
    const bot = new StandaloneDokTokBot();
    global.dokTokBot = bot;
    await bot.initialize();
    
    // Keep process alive
    setInterval(() => {
      if (bot.isRunning) {
        console.log(`${new Date().toISOString()} - DOK TOK Bot: Running independently`);
      }
    }, 600000); // 10 minutes
    
  } catch (error) {
    console.error('Failed to start DOK TOK Bot:', error);
    process.exit(1);
  }
}

// Only start if this file is run directly
if (require.main === module) {
  console.log('Starting DOK TOK Standalone Telegram Bot...');
  startDokTokBot();
}

module.exports = StandaloneDokTokBot;