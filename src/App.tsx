import React, { useState, useEffect } from 'react';
import { Play, Square, Activity, Send, Terminal, AlertCircle, RefreshCw } from 'lucide-react';

interface LogEntry {
  time: string;
  message: string;
  type: 'info' | 'error' | 'success';
}

export default function App() {
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  
  // Bot Configuration
  const [botConfig, setBotConfig] = useState(() => {
    const saved = localStorage.getItem('deltaBotConfig');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {}
    }
    return {
      symbol: 'BTCUSD',
      timeframe: '15m',
      fastEmaPeriod: 9,
      slowEmaPeriod: 21,
      size: 10 as number | string,
      leverage: 10 as number | string,
      allocationType: 'fixed' as 'fixed' | 'percent' | 'usd',
      orderType: 'market' as 'market' | 'limit',
      limitPrice: '' as number | string,
      takeProfitPct: '' as number | string,
      stopLossPct: '' as number | string
    };
  });

  const [pingData, setPingData] = useState<any>(null);
  const [isPinging, setIsPinging] = useState(false);
  const [apiAuthError, setApiAuthError] = useState<string | null>(null);

  const [positions, setPositions] = useState<any[]>([]);
  const [balances, setBalances] = useState<any[]>([]);

  useEffect(() => {
    // Sync local configuration to server on load
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(botConfig)
    });
  }, []);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      setIsRunning(data.isBotRunning);
      setLogs(data.logs);
      setApiAuthError(data.apiAuthError || null);
      // We don't overwrite botConfig with server data since localstorage is the source of truth
    } catch (e) {
      console.error("Failed to fetch status");
    }
  };

  const fetchPositions = async () => {
    try {
      const res = await fetch(`/api/positions?symbol=${botConfig.symbol}`);
      const data = await res.json();
      if (data.success) {
        setPositions(data.positions || []);
      }
    } catch (e) {
      // ignore
    }
  };

  const fetchBalances = async () => {
    try {
      const res = await fetch('/api/balances');
      const data = await res.json();
      if (data.success) {
        setBalances(data.assets || []);
      }
    } catch (e) {
      // ignore
    }
  };

  const updateConfig = async (key: string, value: string | number) => {
    const newConfig = { ...botConfig, [key]: value };
    setBotConfig(newConfig);
    localStorage.setItem('deltaBotConfig', JSON.stringify(newConfig));
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newConfig)
    });
  };

  useEffect(() => {
    fetchStatus();
    fetchPositions();
    fetchBalances();
    const interval = setInterval(() => {
      fetchStatus();
      fetchPositions();
      fetchBalances();
    }, 2000);
    return () => clearInterval(interval);
  }, [botConfig.symbol]);

  const toggleBot = async () => {
    const endpoint = isRunning ? '/api/stop' : '/api/start';
    await fetch(endpoint, { method: 'POST' });
    fetchStatus();
  };

  const handlePing = async () => {
    setIsPinging(true);
    setPingData(null);
    try {
      const res = await fetch('/api/ping', { method: 'POST' });
      const data = await res.json();
      setPingData(data);
    } catch (err: any) {
      setPingData({ success: false, message: err.message });
    } finally {
      setIsPinging(false);
    }
  };

  const executeManualTrade = async (side: 'BUY' | 'SELL') => {
    if (!botConfig.symbol || !botConfig.size) return;
    await fetch('/api/manual-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: botConfig.symbol, side, size: botConfig.size, limitPrice: botConfig.limitPrice })
    });
    fetchStatus();
    fetchPositions();
  };

  const closePosition = async (side: string, size: number) => {
    if (!botConfig.symbol) return;
    try {
      await fetch('/api/close_position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: botConfig.symbol, side, size })
      });
      fetchPositions();
    } catch (e) {
      console.error("Failed to close position", e);
    }
  };

  const SYMBOLS = [
    'BTCUSDT', 'BTCUSD', 
    'ETHUSDT', 'ETHUSD',
    'SOLUSDT', 'SOLUSD',
    'BNBUSDT', 'BNBUSD',
    'XRPUSDT', 'XRPUSD',
    'DOGEUSDT', 'DOGEUSD',
    'ADAUSDT', 'ADAUSD',
    'AVAXUSDT', 'AVAXUSD',
    'LINKUSDT', 'LINKUSD',
    'MATICUSDT', 'MATICUSD',
    'DOTUSDT', 'DOTUSD',
    'UNIUSDT', 'UNIUSD',
    'LTCUSDT', 'LTCUSD',
    'BCHUSDT', 'BCHUSD',
    'PIPPINUSDT', 'PIPPINUSD'
  ];
  const TIMEFRAMES = [
    { label: '1 Minute', value: '1m' },
    { label: '3 Minutes', value: '3m' },
    { label: '5 Minutes', value: '5m' },
    { label: '15 Minutes', value: '15m' },
    { label: '30 Minutes', value: '30m' },
    { label: '1 Hour', value: '1h' },
    { label: '4 Hours', value: '4h' },
    { label: '1 Day', value: '1d' }
  ];

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-200 font-sans selection:bg-neutral-800">
      <div className="max-w-4xl mx-auto p-6 md:p-12">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between mb-12 gap-4">
          <div>
            <h1 className="text-2xl font-medium tracking-tight text-white flex items-center gap-3">
              <Activity className="w-6 h-6 text-emerald-500" />
              Delta Trade Engine
            </h1>
            <p className="text-neutral-500 mt-1 text-sm">Automated EMA Signal Execution</p>
          </div>

          <div className="flex items-center gap-3 bg-neutral-900 border border-neutral-800 rounded-full px-4 py-2 w-max">
            <div className={`w-2.5 h-2.5 rounded-full ${isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-neutral-500'}`} />
            <span className="text-sm font-medium text-neutral-300">
              {isRunning ? 'System Active' : 'System Offline'}
            </span>
          </div>
        </header>

        {apiAuthError && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3 w-full">
            <AlertCircle className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
            <div>
              <h3 className="text-sm font-medium text-red-400">Delta API Authentication Error</h3>
              <p className="text-xs text-red-400/80 mt-1">
                {apiAuthError}
              </p>
            </div>
          </div>
        )}

        <div className="grid md:grid-cols-3 gap-6">
          
          {/* Controls Column */}
          <div className="space-y-6">
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
              <h2 className="text-sm font-medium text-neutral-400 mb-4 uppercase tracking-wider">Trading Config</h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-xs text-neutral-500 mb-1">Asset Symbol</label>
                  <select 
                    value={botConfig.symbol}
                    onChange={e => updateConfig('symbol', e.target.value)}
                    disabled={isRunning}
                    className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-neutral-600 disabled:opacity-50"
                  >
                    {SYMBOLS.map(sym => <option key={sym} value={sym}>{sym}</option>)}
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-neutral-500 mb-1">Timeframe</label>
                  <select 
                    value={botConfig.timeframe}
                    onChange={e => updateConfig('timeframe', e.target.value)}
                    disabled={isRunning}
                    className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-neutral-600 disabled:opacity-50"
                  >
                    {TIMEFRAMES.map(tf => <option key={tf.value} value={tf.value}>{tf.label}</option>)}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Fast EMA</label>
                    <input 
                      type="number" 
                      value={botConfig.fastEmaPeriod}
                      onChange={e => updateConfig('fastEmaPeriod', parseInt(e.target.value) || 1)}
                      disabled={isRunning}
                      className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-neutral-600 disabled:opacity-50"
                      min="1"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Slow EMA</label>
                    <input 
                      type="number" 
                      value={botConfig.slowEmaPeriod}
                      onChange={e => updateConfig('slowEmaPeriod', parseInt(e.target.value) || 1)}
                      disabled={isRunning}
                      className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-neutral-600 disabled:opacity-50"
                      min="1"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Leverage (x)</label>
                    <input 
                      type="number" 
                      value={botConfig.leverage}
                      onChange={e => updateConfig('leverage', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      disabled={isRunning}
                      className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-neutral-600 disabled:opacity-50"
                      min="1"
                      max="100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Allocation Type</label>
                    <select 
                      value={botConfig.allocationType}
                      onChange={e => updateConfig('allocationType', e.target.value)}
                      disabled={isRunning}
                      className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-neutral-600 disabled:opacity-50"
                    >
                      <option value="fixed">Fixed Size (Lots)</option>
                      <option value="percent">% of Margin</option>
                      <option value="usd">Fixed USD ($)</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Order Type</label>
                    <select 
                      value={botConfig.orderType}
                      onChange={e => updateConfig('orderType', e.target.value)}
                      disabled={isRunning}
                      className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-neutral-600 disabled:opacity-50"
                    >
                      <option value="market">Market Order</option>
                      <option value="limit">Limit Order</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">
                      {botConfig.allocationType === 'percent' 
                         ? 'Margin Allocation (%)' 
                         : botConfig.allocationType === 'usd' 
                         ? 'Margin Allocation (USD)' 
                         : 'Lot Size / Quantity'}
                    </label>
                    <input 
                      type="number" 
                      value={botConfig.size}
                      onChange={e => updateConfig('size', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      disabled={isRunning}
                      className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-neutral-600 disabled:opacity-50"
                      min="0"
                      step="any"
                    />
                  </div>
                </div>

                {botConfig.orderType === 'limit' && (
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Custom Limit Price (Manual Trades)</label>
                    <input 
                      type="number" 
                      value={botConfig.limitPrice}
                      onChange={e => updateConfig('limitPrice', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      disabled={isRunning}
                      className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-neutral-600 disabled:opacity-50"
                      step="any"
                      placeholder="Leave blank to use current price"
                    />
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Take Profit (%)</label>
                    <input 
                      type="number" 
                      value={botConfig.takeProfitPct}
                      onChange={e => updateConfig('takeProfitPct', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      disabled={isRunning}
                      className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-neutral-600 disabled:opacity-50"
                      min="0"
                      step="any"
                      placeholder="e.g. 2.0"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Stop Loss (%)</label>
                    <input 
                      type="number" 
                      value={botConfig.stopLossPct}
                      onChange={e => updateConfig('stopLossPct', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      disabled={isRunning}
                      className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-neutral-600 disabled:opacity-50"
                      min="0"
                      step="any"
                      placeholder="e.g. 1.0"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
              <h2 className="text-sm font-medium text-neutral-400 mb-4 uppercase tracking-wider">Engine Control</h2>
              
              <button 
                onClick={toggleBot}
                className={`w-full flex items-center justify-center gap-2 py-3 px-4 rounded-lg font-medium transition-all duration-200 ${
                  isRunning 
                    ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20' 
                    : 'bg-emerald-500 text-neutral-950 hover:bg-emerald-400 border border-emerald-500/20'
                }`}
              >
                {isRunning ? (
                  <><Square className="w-4 h-4 fill-current" /> Stop Engine</>
                ) : (
                  <><Play className="w-4 h-4 fill-current" /> Start Engine</>
                )}
              </button>
              
              {!isRunning && (
                <div className="mt-4 flex items-start gap-2 text-xs text-neutral-500 bg-neutral-950 p-3 rounded-lg border border-neutral-800/50">
                  <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                  Configure trades above and ensure credentials are in .env before starting.
                </div>
              )}

              <button
                onClick={handlePing}
                disabled={isPinging}
                className="w-full mt-4 flex items-center justify-center gap-2 py-2 px-4 rounded-lg font-medium transition-all duration-200 bg-neutral-800 text-neutral-300 hover:bg-neutral-700 border border-neutral-700 disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${isPinging ? 'animate-spin' : ''}`} /> 
                {isPinging ? 'Pinging API...' : 'Ping Delta API'}
              </button>

              {pingData && (
                <div className="mt-4 p-3 bg-neutral-950 border border-neutral-800 rounded-lg text-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-neutral-500">Status</span>
                    {pingData.success ? (
                      <span className="text-emerald-500 font-medium tracking-wide">CONNECTED</span>
                    ) : (
                      <span className="text-red-500 font-medium tracking-wide">FAILED</span>
                    )}
                  </div>
                  
                  {pingData.serverTime && pingData.localTime && (
                    <div className="flex items-center justify-between border-t border-neutral-800/50 pt-2">
                      <span className="text-neutral-500">Clock Sync</span>
                      <span className="text-neutral-300 font-mono">
                        {Math.abs(pingData.localTime - pingData.serverTime)}ms diff
                      </span>
                    </div>
                  )}

                  {pingData.profile && (
                    <div className="flex flex-col border-t border-neutral-800/50 pt-2 gap-1">
                      <span className="text-neutral-500">Account Details</span>
                      <span className="text-neutral-300">{(pingData.profile.first_name || '') + ' ' + (pingData.profile.last_name || '')} ({pingData.profile.email})</span>
                      <span className="text-neutral-600 font-mono text-[10px]">ID: {pingData.profile.id}</span>
                    </div>
                  )}

                  {pingData.assets && (
                    <div className="flex flex-col border-t border-neutral-800/50 pt-2 gap-1">
                      <span className="text-neutral-500 mb-1">Assets</span>
                      {pingData.assets.length > 0 ? (
                        pingData.assets.map((a: any, i: number) => (
                           <div key={i} className="flex justify-between font-mono">
                             <span className="text-neutral-400">{a.asset}</span>
                             <span className="text-neutral-300">{a.total} <span className="text-neutral-600">(Free: {a.free})</span></span>
                           </div>
                        ))
                      ) : (
                        <span className="text-neutral-600">No balances</span>
                      )}
                    </div>
                  )}

                  {!pingData.success && (
                    <div className="text-red-400 mt-2 whitespace-pre-wrap">{pingData.message}</div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-neutral-800/50">
                <button 
                  onClick={() => executeManualTrade('BUY')}
                  className="flex items-center justify-center py-2 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-lg text-sm font-medium transition-colors"
                >
                  Buy (Long)
                </button>
                <button 
                  onClick={() => executeManualTrade('SELL')}
                  className="flex items-center justify-center py-2 bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20 rounded-lg text-sm font-medium transition-colors"
                >
                  Sell (Short)
                </button>
              </div>
            </div>
          </div>

          {/* Main Content Column */}
          <div className="md:col-span-2 flex flex-col gap-6">

            {/* Account Balances */}
            <div className="bg-[#0c0c0c] border border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-800/80 bg-neutral-900/50">
                <h2 className="text-sm font-medium text-neutral-400 flex items-center gap-2">
                  Account Balances
                </h2>
              </div>
              <div className="p-4 overflow-x-auto">
                <table className="w-full text-left text-xs text-neutral-400 whitespace-nowrap">
                  <thead className="border-b border-neutral-800/80">
                    <tr>
                      <th className="pb-3 font-medium">Asset</th>
                      <th className="pb-3 font-medium text-right">Total</th>
                      <th className="pb-3 font-medium text-right">Free</th>
                      <th className="pb-3 font-medium text-right">Used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {balances.length === 0 ? (
                      <tr>
                         <td colSpan={4} className="py-6 text-center text-neutral-600">No positive balances available</td>
                      </tr>
                    ) : (
                      balances.map((b, idx) => (
                        <tr key={idx} className="border-b border-neutral-800/30 last:border-0 hover:bg-neutral-900/20 transition-colors">
                          <td className="py-2.5 font-medium text-neutral-300">
                            {b.asset}
                          </td>
                          <td className="py-2.5 text-neutral-200 text-right font-mono">{Number(b.total).toFixed(8).replace(/\.?0+$/, '') || '0'}</td>
                          <td className="py-2.5 text-neutral-200 text-right font-mono">{Number(b.free).toFixed(8).replace(/\.?0+$/, '') || '0'}</td>
                          <td className="py-2.5 text-neutral-200 text-right font-mono">{Number(b.used).toFixed(8).replace(/\.?0+$/, '') || '0'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            
            {/* Active Positions */}
            <div className="bg-[#0c0c0c] border border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-800/80 bg-neutral-900/50">
                <h2 className="text-sm font-medium text-neutral-400 flex items-center gap-2">
                  Active Positions ({botConfig.symbol})
                </h2>
              </div>
              <div className="p-4 overflow-x-auto">
                <table className="w-full text-left text-xs text-neutral-400 whitespace-nowrap">
                  <thead className="border-b border-neutral-800/80">
                    <tr>
                      <th className="pb-3 font-medium">Side</th>
                      <th className="pb-3 font-medium">Size</th>
                      <th className="pb-3 font-medium">Entry Price</th>
                      <th className="pb-3 font-medium">Liq. Price</th>
                      <th className="pb-3 font-medium">PnL</th>
                      <th className="pb-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.filter(p => Math.abs(Number(p.contracts || 0)) > 0).length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-neutral-600">No active positions for {botConfig.symbol}</td>
                      </tr>
                    ) : (
                      positions.filter(p => Math.abs(Number(p.contracts || 0)) > 0).map((pos, idx) => (
                        <tr key={idx} className="border-b border-neutral-800/30 last:border-0 hover:bg-neutral-900/20 transition-colors">
                          <td className={`py-4 font-medium ${pos.side === 'long' || pos.side === 'buy' ? 'text-emerald-500' : 'text-red-500'} uppercase`}>
                            {pos.side}
                          </td>
                          <td className="py-4 text-neutral-200">{Math.abs(Number(pos.contracts))}</td>
                          <td className="py-4 text-neutral-200">{Number(pos.entryPrice || 0).toFixed(4).replace(/\.?0+$/, '') || '0'}</td>
                          <td className="py-4 text-orange-400">{pos.liquidationPrice ? Number(pos.liquidationPrice).toFixed(4).replace(/\.?0+$/, '') : '-'}</td>
                          <td className="py-4 font-mono">
                            {pos.info?.realized_pnl ? (
                              <span className={Number(pos.info.realized_pnl) >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                                {Number(pos.info.realized_pnl) > 0 ? '+' : ''}{Number(pos.info.realized_pnl).toFixed(4).replace(/\.?0+$/, '') || '0'}
                              </span>
                            ) : '-'}
                          </td>
                          <td className="py-4 text-right">
                            <button 
                              onClick={() => closePosition(pos.side, Math.abs(Number(pos.contracts)))}
                              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded text-xs transition-colors"
                            >
                              Close
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Logs Column */}
            <div className="h-full min-h-[400px] bg-[#0c0c0c] border border-neutral-800 rounded-xl overflow-hidden flex flex-col">
              <div className="px-4 py-3 border-b border-neutral-800/80 bg-neutral-900/50 flex items-center justify-between">
                <h2 className="text-sm font-medium text-neutral-400 flex items-center gap-2">
                  <Terminal className="w-4 h-4" />
                  Terminal Logs
                </h2>
                <div className="text-xs text-neutral-600 font-mono">
                  Listening to server...
                </div>
              </div>
              
              <div className="flex-1 p-4 overflow-y-auto font-mono text-xs space-y-2">
                {logs.length === 0 && (
                  <div className="text-neutral-600 text-center mt-10">No logs available.</div>
                )}
                {logs.map((log, idx) => (
                  <div key={idx} className="flex items-start gap-3">
                    <span className="text-neutral-600 shrink-0">[{log.time}]</span>
                    <span className={`break-words ${
                      log.type === 'error' ? 'text-red-400' :
                      log.type === 'success' ? 'text-emerald-400' : 
                      'text-neutral-300'
                    }`}>
                      {log.message}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
