import express from 'express';
import cors from 'cors';
import path from 'path';
import ccxt, { Exchange } from 'ccxt';
import axios from 'axios';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// --- Simple Local State ---
let isBotRunning = false;
let apiAuthError: string | null = null;
let logs: Array<{ time: string; message: string; type: 'info' | 'error' | 'success' }> = [
  { time: new Date().toLocaleTimeString(), message: "System Initialized. Awaiting manual start.", type: 'info' }
];

const addLog = (message: string, type: 'info' | 'error' | 'success' = 'info') => {
  const time = new Date().toLocaleTimeString();
  logs.unshift({ time, message, type });
  if (logs.length > 50) logs.pop(); // Keep only last 50
  console.log(`[${time}] ${message}`);
};

// --- CCXT Delta Exchange Logic ---
const exchangeCache: Record<string, Exchange> = {};

function formatDeltaError(error: any): string {
  const msg = error.message || JSON.stringify(error);
  if (msg.includes('ip_not_whitelisted_for_api_key')) {
    const match = msg.match(/client_ip":"([^"]+)"/);
    const ip = match ? match[1] : 'this server';
    return `Delta Exchange MANDATES IP whitelisting for Trading keys. Since this app runs on a serverless cloud with dynamic IPs (current: ${ip}), connections will be blocked. Alternative: Export this app and run it locally or on a VPS with a static IP.`;
  }
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid_api_key')) {
    return `Invalid Delta API Key/Secret or unauthorized: ${msg}`;
  }
  return msg;
}

// Time offset between local clock and Delta server (in milliseconds)
let serverTimeOffsetMs = 0;

async function syncServerTime() {
  const baseUrl = process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange';
  try {
    const beforeMs = Date.now();
    const resp = await axios.get(`${baseUrl}/v2/settings`);
    const afterMs = Date.now();
    const roundTripMs = afterMs - beforeMs;
    // Delta returns server_time as unix timestamp in MICROSECONDS
    const serverTimeUs = resp.data?.result?.server_time;
    if (serverTimeUs) {
      const serverTimeMs = Math.floor(serverTimeUs / 1000);
      const localTimeMs = beforeMs + Math.floor(roundTripMs / 2);
      serverTimeOffsetMs = serverTimeMs - localTimeMs;
      console.log(`[Time Sync] Local clock is ${(serverTimeOffsetMs / 1000).toFixed(1)}s behind Delta server. Offset applied.`);
    }
  } catch (e: any) {
    console.warn(`[Time Sync] Failed to sync server time: ${e.message}`);
  }
}

const getExchange = async () => {
  if (!process.env.DELTA_KEY || !process.env.DELTA_SECRET) {
    throw new Error("Missing DELTA_KEY or DELTA_SECRET in environment variables.");
  }
  
  const cacheKey = process.env.DELTA_KEY + (process.env.DELTA_BASE_URL || '');
  if (!exchangeCache[cacheKey]) {
    // Sync time with Delta server before creating exchange
    await syncServerTime();

    const exchange = new ccxt.delta({
      apiKey: process.env.DELTA_KEY,
      secret: process.env.DELTA_SECRET,
      enableRateLimit: true,
      options: {
        defaultType: 'future',
      }
    });

    // Override nonce/seconds to use server-corrected time
    (exchange as any).seconds = () => Math.floor((Date.now() + serverTimeOffsetMs) / 1000);
    (exchange as any).milliseconds = () => Date.now() + serverTimeOffsetMs;
    (exchange as any).nonce = () => Date.now() + serverTimeOffsetMs;
    
    // Default to Delta India APIs because generic invalid_api_key issues often occur for Indian accounts querying global.
    const baseUrl = process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange';
    exchange.urls.api = {
      public: baseUrl,
      private: baseUrl
    };
    
    // Attempt authentication handshake by fetching balance or profile to ensure credentials work early
    try {
      exchange.checkRequiredCredentials();
      await exchange.loadMarkets();
    } catch (authErr: any) {
      console.error("Delta API Initialization or Authentication failed:", authErr.message);
      // We don't throw heavily here so we can still allow public api calls if keys are just invalid
    }
    exchangeCache[cacheKey] = exchange;
  }

  return exchangeCache[cacheKey];
};

const formatCcxtSymbol = (exchange: Exchange, symbol: string) => {
  const allMarkets = Object.keys(exchange.markets);
  
  // Clean symbol string (e.g. BTCUSD -> BTC, DOGEUSDT -> DOGE)
  const base = symbol.replace(/USDT?$/, '');
  
  // Prefer USDT perpetual, then USD perpetual
  const targetPerpUsdt = `${base}/USDT:USDT`;
  const targetPerpUsd = `${base}/USD:USD`;

  if (allMarkets.includes(targetPerpUsdt)) return targetPerpUsdt;
  if (allMarkets.includes(targetPerpUsd)) return targetPerpUsd;

  // Fallback to spot
  const targetSpotUsdt = `${base}/USDT`;
  const targetSpotUsd = `${base}/USD`;

  if (allMarkets.includes(targetSpotUsdt)) return targetSpotUsdt;
  if (allMarkets.includes(targetSpotUsd)) return targetSpotUsd;
  
  // Ultimate fallback
  const fallback = allMarkets.find(m => m.replace(/\W/g, '').includes(symbol));
  return fallback || symbol;
};

// Returns exact native symbol needed for Delta's API internally through CCXT
const getNativeSymbol = (symbol: string) => {
     if (symbol.includes('USDT')) return symbol;
     if (symbol.includes('USD')) return symbol;
     return symbol;
};

async function placeDeltaMarketOrder(symbol: string, side: string, sizeInput: number, currentPrice?: number, extraParams: any = {}) {
  const exchange = await getExchange();
  try {
    const ccxtSymbol = formatCcxtSymbol(exchange, symbol);
    if (!exchange.markets[ccxtSymbol]) {
      throw new Error(`Symbol ${ccxtSymbol} does not exist in the exchange market list. Check the trading pair name.`);
    }

    let size = sizeInput;

    if (tradingConfig.allocationType === 'percent' && currentPrice && !extraParams.reduce_only) {
      const balance = await exchange.fetchBalance();
      const freeUsd = balance.free['USD'] || balance.free['USDT'] || 0;
      
      const leverage = Number(tradingConfig.leverage) || 1;
      const percent = Math.min(Math.max(sizeInput, 0), 100) / 100;
      const purchasingPower = freeUsd * leverage * percent;
      
      const market = exchange.markets[ccxtSymbol];
      const contractSize = market?.contractSize || 1;
      
      const rawSize = purchasingPower / (currentPrice * contractSize);
      size = Math.floor(rawSize);
      
      if (size <= 0) {
        throw new Error(`Calculated size is 0 (Purchasing Power: $${purchasingPower.toFixed(2)}, Free USD: $${freeUsd.toFixed(2)}). Not enough margin for 1 contract.`);
      }
      console.log(`[Lot Allocation] Percent: ${sizeInput}% | Free USD: $${freeUsd.toFixed(2)} | Calculated Lots: ${size}`);
    } else if (tradingConfig.allocationType === 'usd' && currentPrice && !extraParams.reduce_only) {
      const leverage = Number(tradingConfig.leverage) || 1;
      const purchasingPower = sizeInput * leverage;
      
      const market = exchange.markets[ccxtSymbol];
      const contractSize = market?.contractSize || 1;
      
      // sizeInput is treated as Margin USD. We multiply by leverage to get purchasing power.
      const rawSize = purchasingPower / (currentPrice * contractSize);
      size = Math.floor(rawSize);
      
      if (size <= 0) {
        throw new Error(`Calculated size is 0 (Requested Margin: $${sizeInput}, Purchasing Power: $${purchasingPower}). Not enough to buy 1 contract.`);
      }
      console.log(`[Lot Allocation] Margin USD: $${sizeInput} | Purchasing Power: $${purchasingPower} | Calculated Lots: ${size}`);
    }

    const orderSide = side.toLowerCase() as 'buy' | 'sell';
    
    // We can use createOrder from CCXT
    const params: any = { ...extraParams };
    if (currentPrice && !extraParams.reduce_only) {
      const isBuy = orderSide === 'buy';
      
      const formatPrice = (val: number) => {
        if (val < 0.1) return val.toFixed(5);
        if (val < 1) return val.toFixed(4);
        if (val < 50) return val.toFixed(3);
        if (val < 1000) return val.toFixed(2);
        return val.toFixed(1);
      };

      if (tradingConfig.takeProfitPct) {
        const tpPct = parseFloat(tradingConfig.takeProfitPct);
        if (!isNaN(tpPct) && tpPct > 0) {
          const tpPrice = isBuy
            ? currentPrice * (1 + tpPct / 100)
            : currentPrice * (1 - tpPct / 100);
          const formatted = formatPrice(tpPrice);
          params.bracket_take_profit_limit_price = formatted;
          params.bracket_take_profit_price = formatted;
        }
      }

      if (tradingConfig.stopLossPct) {
        const slPct = parseFloat(tradingConfig.stopLossPct);
        if (!isNaN(slPct) && slPct > 0) {
          const slPrice = isBuy
            ? currentPrice * (1 - slPct / 100)
            : currentPrice * (1 + slPct / 100);
          const formatted = formatPrice(slPrice);
          params.bracket_stop_loss_limit_price = formatted;
          params.bracket_stop_loss_price = formatted;
        }
      }
      
      if (params.bracket_stop_loss_price || params.bracket_take_profit_price) {
        params.bracket_stop_trigger_method = "last_traded_price";
      }
    }
    if (tradingConfig.leverage) {
      try {
        await exchange.setLeverage(Number(tradingConfig.leverage), ccxtSymbol);
      } catch (err: any) {
        console.warn(`Could not set leverage to ${tradingConfig.leverage}x for ${ccxtSymbol}: ${err.message}`);
      }
    }
    
    // Check if it's a limit order or market order
    const isLimit = tradingConfig.orderType === 'limit';
    // If limit order, use the explicit limitPrice (e.g. from manual trade) or fallback to currentPrice
    const priceToUse = extraParams._limitPrice ? Number(extraParams._limitPrice) : currentPrice;
    
    const result = isLimit && priceToUse
      ? await exchange.createLimitOrder(ccxtSymbol, orderSide, size, priceToUse, params)
      : await exchange.createMarketOrder(ccxtSymbol, orderSide, size, undefined, params);
      
    return result;
  } catch (error: any) {
    throw new Error(`Delta API Error during trade execution: ${formatDeltaError(error)}`);
  }
}

// --- Diagnostic Ping ---
app.post('/api/ping', async (req, res) => {
  try {
    const exchange = await getExchange();
    const balance = await exchange.fetchBalance();
    
    const assets = Object.keys(balance.total || {})
      .filter((k) => (balance.total as any)[k] > 0)
      .map((k) => ({
        asset: k,
        total: (balance.total as any)[k],
        free: (balance.free as any)[k],
      }));

    let profile = null;
    try {
      const p = await (exchange as any).privateGetProfile();
      profile = p?.result || null;
    } catch (e: any) {
      console.warn(`Failed to fetch profile (maybe lacking permissions): ${e.message}`);
    }

    let serverTime = null;
    try {
      serverTime = await exchange.fetchTime();
    } catch (e: any) {
      console.warn(`Failed to fetch server time: ${e.message}`);
    }

    return res.json({ success: true, assets, profile, serverTime, localTime: Date.now() });
  } catch (error: any) {
    return res.status(400).json({ 
      success: false, 
      message: formatDeltaError(error)
    });
  }
});

app.get('/api/positions', async (req, res) => {
  try {
    const { symbol } = req.query;
    const exchange = await getExchange();
    const ccxtSymbol = symbol ? formatCcxtSymbol(exchange, symbol as string) : undefined;
    const positions = await exchange.fetchPositions(ccxtSymbol ? [ccxtSymbol] : undefined);
    return res.json({ success: true, positions });
  } catch (error: any) {
    const msg = formatDeltaError(error);
    if (msg.includes('unauthorized') || msg.includes('Invalid Delta API Key')) {
      return res.status(401).json({ success: false, message: msg });
    }
    return res.status(400).json({ success: false, message: msg });
  }
});

app.post('/api/close_position', async (req, res) => {
  try {
    const { symbol, side, size } = req.body;
    const exchange = await getExchange();
    const ccxtSymbol = formatCcxtSymbol(exchange, symbol);
    
    // To close a position, we place a market order in the opposite direction
    const closingSide = (side as string).toLowerCase() === 'buy' || (side as string).toLowerCase() === 'long' ? 'sell' : 'buy';
    
    const result = await exchange.createMarketOrder(ccxtSymbol, closingSide, Math.abs(Number(size)), undefined, { reduce_only: true });
    return res.json({ success: true, result });
  } catch (error: any) {
    const msg = formatDeltaError(error);
    return res.status(400).json({ success: false, message: msg });
  }
});

app.get('/api/balances', async (req, res) => {
  try {
    const exchange = await getExchange();
    const balance = await exchange.fetchBalance();

    const assets = Object.keys(balance.total || {})
      .filter((k) => (balance.total as any)[k] > 0)
      .map((k) => ({
        asset: k,
        total: (balance.total as any)[k] || 0,
        free: (balance.free as any)[k] || 0,
        used: (balance.used as any)[k] || 0,
      }));

    return res.json({ success: true, assets });
  } catch (error: any) {
    const msg = formatDeltaError(error);
    if (msg.includes('unauthorized') || msg.includes('Invalid Delta API Key')) {
      return res.status(401).json({ success: false, message: msg });
    }
    return res.status(400).json({ success: false, message: msg });
  }
});

let cachedSyncedSymbols: string[] = [];
let cachedSyncedSymbolsTime: number = 0;

app.get('/api/symbols', async (req, res) => {
  try {
    const now = Date.now();
    // Cache for 1 hour (3600000 ms)
    if (cachedSyncedSymbols.length > 0 && now - cachedSyncedSymbolsTime < 3600000) {
      return res.json({ success: true, symbols: cachedSyncedSymbols, cached: true });
    }

    const exchange = await getExchange();
    await exchange.loadMarkets();
    
    // Get Binance tickers for comparison
    const binance = new ccxt.binance();
    await binance.loadMarkets();
    
    // Fetch tickers from both simultaneously
    const [deltaTickers, binanceTickers] = await Promise.all([
       exchange.fetchTickers(),
       binance.fetchTickers()
    ]);

    const validSymbols: string[] = [];

    for (const dSymbol of Object.keys(exchange.markets)) {
       if (dSymbol.includes(':USDT') || dSymbol.includes(':USD')) {
          const rawBase = dSymbol.split(':')[0]; // e.g. "BTC/USDT" or "BTC/USD"
          const cleanSymbol = rawBase.replace('/', ''); // e.g. "BTCUSDT" or "BTCUSD"
          
          const parts = rawBase.split('/');
          const baseAsset = parts[0];
          const binanceSymbol = `${baseAsset}/USDT`; // Normalize to Binance USDT pair
          
          const dTicker = deltaTickers[dSymbol];
          const bTicker = binanceTickers[binanceSymbol];
          
          if (dTicker && dTicker.last && bTicker && bTicker.last) {
              const bPrice = bTicker.last;
              const dPrice = dTicker.last;
              const diffPct = Math.abs(bPrice - dPrice) / Math.min(bPrice, dPrice);
              
              // Only keep assets where price difference is <= 2%
              if (diffPct <= 0.02) {
                 validSymbols.push(cleanSymbol);
              }
          }
       }
    }
    
    // Deduplicate symbols and sort
    cachedSyncedSymbols = [...new Set(validSymbols)].sort();
    cachedSyncedSymbolsTime = now;
    console.log(`[Asset Sync] Synced and verified ${cachedSyncedSymbols.length} assets between Binance and Delta.`);
    
    return res.json({ success: true, symbols: cachedSyncedSymbols });
  } catch (error: any) {
    console.error('[Asset Sync Error]', error.message);
    return res.status(400).json({ success: false, message: formatDeltaError(error) });
  }
});

// --- EMA and Bot Logic ---
let botInterval: NodeJS.Timeout | null = null;
let tradingConfig: any = { 
  symbol: 'BTCUSD', 
  timeframe: '15m', 
  fastEmaPeriod: 9, 
  slowEmaPeriod: 21, 
  size: 10,
  leverage: 10,
  allocationType: 'fixed',
  orderType: 'market',
  takeProfitPct: '',
  stopLossPct: '',
  strategy: 'always_in'
};
let lastExecutedCandleTime = 0;
const binanceUnsupportedSymbols = new Set<string>();

const calculateEmaSeries = (prices: number[], period: number) => {
  const k = 2 / (period + 1);
  const ema = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
};

const runBotCycle = async () => {
  if (!isBotRunning) return;
  try {
    let exchange;
    try {
      exchange = await getExchange();
    } catch (e: any) {
      addLog(`Delta Engine Error: Failed to initialize exchange: ${e.message}`, 'error');
      isBotRunning = false;
      return;
    }
    const ccxtSymbol = formatCcxtSymbol(exchange, tradingConfig.symbol);
    
    if (!exchange.markets[ccxtSymbol]) {
      addLog(`Symbol ${ccxtSymbol} not found in exchange market list. Cannot fetch candles.`, 'error');
      isBotRunning = false;
      return;
    }
    
    const timeframesMs: any = {
      '1m': 60 * 1000,
      '3m': 3 * 60 * 1000,
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '30m': 30 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '2h': 2 * 60 * 60 * 1000,
      '4h': 4 * 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000
    };

    let ohlcv;
    const binanceSymbol = tradingConfig.symbol.replace('USD', '/USDT');
    
    if (!binanceUnsupportedSymbols.has(binanceSymbol)) {
      try {
        // Delta's CCXT implementation can sometimes return sparse data or limited history on certain pairs.
        // We will use Binance as our data source to ensure deep liquidity and consistent candle lengths.
        const binance = new ccxt.binance();
        const limit = Math.max(500, tradingConfig.slowEmaPeriod + 10);
        ohlcv = await binance.fetchOHLCV(binanceSymbol, tradingConfig.timeframe, undefined, limit);
      } catch (candleErr: any) {
        if (candleErr.message.toLowerCase().includes('does not have market symbol')) {
          binanceUnsupportedSymbols.add(binanceSymbol);
        }
        console.warn(`Binance Data Error: ${candleErr.message}. Falling back to Delta API...`);
      }
    }
    
    if (!ohlcv) {
      try {
        const limit = Math.max(500, tradingConfig.slowEmaPeriod + 10);
        ohlcv = await exchange.fetchOHLCV(ccxtSymbol, tradingConfig.timeframe, undefined, limit);
      } catch (deltaErr: any) {
        addLog(`Delta Data Error: Failed to fetch candles for ${ccxtSymbol}: ${deltaErr.message}`, 'error');
        return;
      }
    }
    
    if (!ohlcv || ohlcv.length === 0) {
      addLog(`Failed to fetch candle info for ${ccxtSymbol}: Empty result from Delta API`, 'error');
      return;
    }
    
    const closes = ohlcv.map((c) => c[4] as number);
    const required = tradingConfig.slowEmaPeriod + 5;
    
    if (closes.length < required) {
       addLog(`Not enough data to calculate EMA for ${ccxtSymbol}. Found ${closes.length} candles, require at least ${required}.`, 'error');
       return;
    }

    const fastEmaSeries = calculateEmaSeries(closes, tradingConfig.fastEmaPeriod);
    const slowEmaSeries = calculateEmaSeries(closes, tradingConfig.slowEmaPeriod);
    
    const currentClosedIdx = closes.length - 2;
    const previousClosedIdx = closes.length - 3;
    
    if (previousClosedIdx < 0) return;

    const currFast = fastEmaSeries[currentClosedIdx];
    const currSlow = slowEmaSeries[currentClosedIdx];
    const prevFast = fastEmaSeries[previousClosedIdx];
    const prevSlow = slowEmaSeries[previousClosedIdx];
    
    const closedCandleTime = ohlcv[currentClosedIdx][0];
    const currentPrice = closes[closes.length - 1]; // Live price
    const formatPrice = (p: number) => p < 0.1 ? p.toFixed(5) : p < 1 ? p.toFixed(4) : p < 100 ? p.toFixed(3) : p.toFixed(2);
    
    const isCrossUp = prevFast <= prevSlow && currFast > currSlow;
    const isCrossDown = prevFast >= prevSlow && currFast < currSlow;
    
    const crossStateStr = isCrossUp ? 'BUY' : isCrossDown ? 'SELL' : 'NONE';
    addLog(`Checked ${tradingConfig.symbol} - Price: ${formatPrice(currentPrice)} | Closed Fast: ${formatPrice(currFast)} | Closed Slow: ${formatPrice(currSlow)}`, 'info');

     if ((isCrossUp || isCrossDown) && closedCandleTime > lastExecutedCandleTime) {
        addLog(`🔔 EMA Cross Detected! FastEMA: ${formatPrice(currFast)}, SlowEMA: ${formatPrice(currSlow)}. Signal: ${crossStateStr}`, 'success');
        
        // ENFORCE MANDATORY STOP LOSS
        if (!tradingConfig.stopLossPct || parseFloat(tradingConfig.stopLossPct) <= 0) {
           addLog(`❌ Mandatory Stop Loss is missing! Configure Stop Loss (%) > 0. Bot stopped.`, 'error');
           isBotRunning = false;
           return;
        }

        const orderSide = isCrossUp ? 'buy' : 'sell';
        let targetSize = Number(tradingConfig.size || 1);
        const isAlwaysIn = tradingConfig.strategy === 'always_in';

        // ── STEP 1: Check existing position ──
        let currentContracts = 0;
        let posSide: string | undefined;
        try {
            const positions = await exchange.fetchPositions([ccxtSymbol]);
            const pos = positions.length > 0 ? positions[0] : null;
            currentContracts = pos && pos.contracts ? Math.abs(Number(pos.contracts)) : 0;
            posSide = pos && pos.side ? String(pos.side).toLowerCase() : undefined;
            addLog(`📊 Position check: ${currentContracts > 0 ? `Holding ${posSide?.toUpperCase()} x${currentContracts}` : 'No open position'}`, 'info');
        } catch (posErr: any) {
            addLog(`⚠️ Could not fetch positions: ${posErr.message}. Will attempt trade anyway.`, 'error');
        }

        // ── STEP 2: If holding same direction, skip ──
        if (currentContracts > 0) {
            const isHoldingLong = posSide === 'long' || posSide === 'buy';
            const isHoldingShort = posSide === 'short' || posSide === 'sell';
            const isSameDirection = (isHoldingLong && orderSide === 'buy') || (isHoldingShort && orderSide === 'sell');

            if (isSameDirection) {
                addLog(`⏭️ Ignored ${crossStateStr} signal — already holding ${posSide?.toUpperCase()}.`, 'info');
                lastExecutedCandleTime = closedCandleTime;
                return;
            }

            // ── STEP 3: Close opposite position ──
            const closingSide = isHoldingLong ? 'sell' : 'buy';
            addLog(`🔄 Closing existing ${posSide?.toUpperCase()} position (${currentContracts} contracts)...`, 'info');
            try {
                await placeDeltaMarketOrder(tradingConfig.symbol, closingSide, currentContracts, currentPrice, { reduceOnly: true, reduce_only: true });
                addLog(`✅ Closed ${posSide?.toUpperCase()} position successfully.`, 'success');
            } catch (closeErr: any) {
                addLog(`❌ Failed to close ${posSide?.toUpperCase()} position: ${closeErr.message}`, 'error');
                // Don't update lastExecutedCandleTime — retry next cycle
                return;
            }

            // If strategy is Standard (close only), stop here
            if (!isAlwaysIn) {
                addLog(`📋 Strategy: Standard — closed position, NOT entering new ${orderSide.toUpperCase()}.`, 'info');
                lastExecutedCandleTime = closedCandleTime;
                return;
            }

            // Small delay between close and new entry to let Delta process
            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        // ── STEP 4: Enter new position (always_in mode, or fresh entry with no prior position) ──
        addLog(`🚀 Entering NEW ${orderSide.toUpperCase()} position (Size: ${targetSize}, Strategy: ${isAlwaysIn ? 'Stop & Reverse' : 'Standard'})...`, 'info');
        try {
            const result = await placeDeltaMarketOrder(tradingConfig.symbol, orderSide, targetSize, currentPrice);
            addLog(`✅ ${orderSide.toUpperCase()} entry placed! Order ID: ${result?.id || 'OK'} | Size: ${targetSize}`, 'success');
            lastExecutedCandleTime = closedCandleTime;
        } catch (entryErr: any) {
            addLog(`❌ Failed to enter ${orderSide.toUpperCase()}: ${entryErr.message}`, 'error');
            if (entryErr.message.includes('ip_not_whitelisted_for_api_key')) {
                isBotRunning = false;
                const match = entryErr.message.match(/client_ip":"([^"]+)"/);
                const ip = match ? match[1] : 'this server';
                apiAuthError = `Delta Exchange MANDATES IP whitelisting. Current IP: ${ip}. Run locally or on a VPS with static IP.`;
                addLog(apiAuthError, 'error');
            } else if (entryErr.message.includes('401') || entryErr.message.includes('invalid_api_key')) {
                isBotRunning = false;
                apiAuthError = "Invalid Delta API Credentials. Check .env file.";
                addLog('Bot stopped due to invalid API credentials.', 'error');
            }
            // Don't update lastExecutedCandleTime so we retry next cycle
        }
    }
  } catch (error: any) {
    addLog(`Error in bot cycle: ${error.message}`, 'error');
    if (error.message.includes('ip_not_whitelisted_for_api_key')) {
        isBotRunning = false;
        const match = error.message.match(/client_ip":"([^"]+)"/);
        const ip = match ? match[1] : 'this server';
        apiAuthError = `Delta Exchange MANDATES IP whitelisting for Trading keys. Since this app runs on a serverless cloud with dynamic IPs (current: ${ip}), connections will be blocked. Alternative: Export this app and run it locally or on a VPS with a static IP.`;
        addLog(apiAuthError, 'error');
    } else if (error.message.includes('401') || error.message.includes('invalid_api_key')) {
        isBotRunning = false;
        apiAuthError = "Invalid Delta API Credentials. Please check Settings -> Secrets.";
        addLog('Bot stopped due to invalid API credentials.', 'error');
    }
  }
};

// --- API Routes ---
app.get('/api/status', (req, res) => {
  res.json({ isBotRunning, apiAuthError, logs, tradingConfig });
});

app.post('/api/config', (req, res) => {
  const { symbol, timeframe, fastEmaPeriod, slowEmaPeriod, size, leverage, allocationType, orderType, takeProfitPct, stopLossPct, strategy } = req.body;
  
  if (symbol) tradingConfig.symbol = symbol;
  if (timeframe) tradingConfig.timeframe = timeframe;
  if (fastEmaPeriod !== undefined) tradingConfig.fastEmaPeriod = parseInt(fastEmaPeriod, 10);
  if (slowEmaPeriod !== undefined) tradingConfig.slowEmaPeriod = parseInt(slowEmaPeriod, 10);
  if (size !== undefined) tradingConfig.size = size;
  if (leverage !== undefined) tradingConfig.leverage = leverage;
  if (allocationType !== undefined) tradingConfig.allocationType = allocationType;
  if (orderType !== undefined) tradingConfig.orderType = orderType;
  if (takeProfitPct !== undefined) tradingConfig.takeProfitPct = takeProfitPct;
  if (stopLossPct !== undefined) tradingConfig.stopLossPct = stopLossPct;
  if (strategy !== undefined) tradingConfig.strategy = strategy;

  // reset execution tracking on config change
  lastExecutedCandleTime = 0;
  addLog(`Configuration updated: ${tradingConfig.symbol} (${tradingConfig.timeframe}) Size: ${tradingConfig.size} (${tradingConfig.allocationType}) Leverage: ${tradingConfig.leverage}x Type: ${tradingConfig.orderType.toUpperCase()} Strategy: ${tradingConfig.strategy}`, 'info');
  res.json({ success: true, tradingConfig });
});

app.post('/api/start', (req, res) => {
  if (isBotRunning) {
    return res.status(400).json({ message: "Bot is already running" });
  }
  
  if (!process.env.DELTA_KEY || !process.env.DELTA_SECRET) {
    apiAuthError = "Missing Delta Exchange credentials in .env";
    addLog("Failed to start: Missing Delta Exchange credentials in .env", "error");
    return res.status(400).json({ message: "Missing credentials" });
  }

  isBotRunning = true;
  apiAuthError = null;
  addLog("🤖 Delta Engine Started (via CCXT). Waiting for signals...", "success");
  
  // Start the background evaluation loop if needed (e.g. for EMA)
  // Run once immediately, then every 30 seconds
  runBotCycle();
  botInterval = setInterval(runBotCycle, 30000);
  
  res.json({ success: true });
});

app.post('/api/stop', (req, res) => {
  isBotRunning = false;
  if (botInterval) clearInterval(botInterval);
  addLog("Bot stopped manually.", "info");
  res.json({ success: true });
});

app.post('/api/manual-trade', async (req, res) => {
  const { symbol, side, size, limitPrice } = req.body;
  addLog(`Manual trade requested: ${side} ${symbol} (Size: ${size})...`, "info");

  if (!tradingConfig.stopLossPct || parseFloat(tradingConfig.stopLossPct) <= 0) {
     const errorMsg = "Mandatory Stop Loss is missing! Please configure Stop Loss (%) first.";
     addLog(`➔ Error: ${errorMsg}`, "error");
     return res.status(400).json({ success: false, message: errorMsg });
  }
  
  try {
    // For manual trade, fetch current price first so bracket TP/SL calculates correctly
    let currentPrice: number | undefined = undefined;
    try {
      const exchange = await getExchange();
      const ticker = await exchange.fetchTicker(formatCcxtSymbol(exchange, symbol));
      if (ticker.close) {
        currentPrice = ticker.close;
      }
    } catch (e: any) {
      console.warn(`Could not fetch ticker price for manual trade TP/SL, proceeding without it. Error: ${e.message}`);
    }
    
    // We pass the limitPrice from the UI inside extraParams so the placeDeltaMarketOrder function can use it
    const extraParams = limitPrice ? { _limitPrice: limitPrice } : {};
    
    const result = await placeDeltaMarketOrder(symbol, side, size || 1, currentPrice, extraParams);
    addLog(`➔ Order Placed! ID: ${result?.id || 'Success'}`, "success");
    res.json({ success: true, result });
  } catch (error: any) {
    addLog(`➔ Error: ${error.message}`, "error");
    res.status(500).json({ success: false, error: error.message });
  }
});

// Vite middleware for development
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
