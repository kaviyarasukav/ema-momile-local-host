# Delta Exchange - CCXT Trading Bot

This is a full-stack automated trading bot integrated with Delta Exchange using CCXT. It evaluates market data, processes EMA crossovers, and executes orders automatically.

## 🛑 Critical Notice: Delta Exchange IP Whitelisting

Delta Exchange **MANDATES** IP Whitelisting for all API keys with "Trading" permissions.

Because this application was initially previewed in a serverless cloud environment (which uses dynamic IPs that change constantly), you **must** deploy this bot to an environment with a **Static IP Address** to use it successfully.

### Recommended Deployment Options

To use this bot, you have two primary options:

#### Option 1: Run on a Virtual Private Server (VPS) - Recommended
Deploying on a VPS (like DigitalOcean, AWS EC2, Linode, or Vultr) gives your server a permanent static IP address.
1. Create a modern Ubuntu VPS.
2. Get the IPv4 address of your VPS.
3. Log into Delta Exchange -> Settings -> API Keys.
4. Create a new key with **Trading** permission and enter your VPS Static IP.
5. SSH into your VPS, clone this repository, and start the app (see instructions below).

#### Option 2: Run Locally (On your own computer)
1. Find your home computer's public IP address (Google "What is my IP").
2. Whitelist this IP in your Delta Exchange API Key settings.
3. Keep your computer running for the bot to execute trades. (Note: Many home ISPs change your IP occasionally. If it changes, you will need to update the whitelist).

---

## 🚀 How to Export and Run

### Step 1: Exporting from AI Studio
If you haven't yet, you can easily export this project:
1. Open the project settings dropdown (in the top menu).
2. Click **Export to GitHub** (to push directly to a new repo) OR **Download ZIP** (to extract locally).

### Step 2: Set up your environment
Make sure you have [Node.js](https://nodejs.org/) installed (v18+ recommended).

Open your terminal or command prompt, navigate to the project directory, and run:
```bash
# Install all dependencies
npm install
```

### Step 3: Configure Credentials
Create a `.env` file in the root directory (you can copy `.env.example`).
```bash
cp .env.example .env
```
Open `.env` and fill in your Delta API credentials:
```env
DELTA_KEY="your_whitelisted_delta_api_key"
DELTA_SECRET="your_delta_api_secret"
```

### Step 4: Build and Start
Build the production-ready application:
```bash
npm run build
```

Start the application node server:
```bash
npm start
```
The bot will now load up on `http://localhost:3000`. You can visit this URL to see the interface, update your bot configs, and start the automated loop!

## ⚙️ Running indefinitely on a Server
If deploying to a VPS, it's recommended to run your app using `pm2` so it runs in the background and restarts automatically if it crashes:
```bash
# Install pm2 globally
npm install -g pm2

# Start the application
pm2 start dist/server.cjs --name delta-bot

# Save the pm2 list so it restarts on system reboot
pm2 save
pm2 startup
```

## Features Complete in this Application
- React UI (TailwindCSS) with clean dashboard and logs
- Proxy Node.js Backend Server to hide API secrets
- CCXT integration for Delta Exchange API interactions
- Moving Average (EMA) cross calculations handling real-time data
- Automatic Background Tasks (15-min loops, fetching candles, running algorithms)
- Live Ping and status checks
