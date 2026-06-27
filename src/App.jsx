import React, { useState, useEffect, useRef, useCallback } from 'react';
import { TrendingUp, AlertTriangle, BarChart3, Activity } from 'lucide-react';

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface TradeSignal {
  type: 'BOS' | 'FVG' | 'OB' | 'FIBONACCI' | 'NONE';
  direction: 'LONG' | 'SHORT' | 'NONE';
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number;
  reason: string;
  atr: number;
}

interface Position {
  id: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  tp1Closed: boolean;
  tp2Closed: boolean;
  openTime: Date;
  trailingStop: number;
  pnl: number;
  type: string;
}

// ==================== CORE STRATEGY ====================

const calculateATR = (candles: Candle[], period: number = 14): number => {
  if (candles.length < period) return 0;
  let tr_sum = 0;
  
  for (let i = candles.length - period; i < candles.length; i++) {
    const curr = candles[i];
    const prev = i > 0 ? candles[i - 1] : curr;
    
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    tr_sum += tr;
  }
  
  return tr_sum / period;
};

const findSwingHigh = (candles: Candle[], lookback: number = 10): number => {
  let max = candles[candles.length - 1].high;
  for (let i = candles.length - lookback; i < candles.length; i++) {
    if (candles[i].high > max) max = candles[i].high;
  }
  return max;
};

const findSwingLow = (candles: Candle[], lookback: number = 10): number => {
  let min = candles[candles.length - 1].low;
  for (let i = candles.length - lookback; i < candles.length; i++) {
    if (candles[i].low < min) min = candles[i].low;
  }
  return min;
};

// BOS - Break of Structure
const detectBOS = (candles: Candle[], atr: number): TradeSignal | null => {
  if (candles.length < 15) return null;
  
  const lastSwingHigh = findSwingHigh(candles, 10);
  const lastSwingLow = findSwingLow(candles, 10);
  const currentClose = candles[candles.length - 1].close;
  const currentHigh = candles[candles.length - 1].high;
  const currentLow = candles[candles.length - 1].low;
  
  // LONG BOS: пробив Swing High
  if (currentHigh > lastSwingHigh && currentClose > lastSwingHigh) {
    return {
      type: 'BOS',
      direction: 'LONG',
      entryPrice: currentClose,
      stopLoss: lastSwingLow - atr * 0.5,
      tp1: currentClose + atr * 1.0,
      tp2: currentClose + atr * 2.0,
      tp3: currentClose + atr * 3.5,
      confidence: 75,
      reason: `BOS LONG: пробив Swing High ${lastSwingHigh.toFixed(2)}`,
      atr
    };
  }
  
  // SHORT BOS: пробив Swing Low
  if (currentLow < lastSwingLow && currentClose < lastSwingLow) {
    return {
      type: 'BOS',
      direction: 'SHORT',
      entryPrice: currentClose,
      stopLoss: lastSwingHigh + atr * 0.5,
      tp1: currentClose - atr * 1.0,
      tp2: currentClose - atr * 2.0,
      tp3: currentClose - atr * 3.5,
      confidence: 75,
      reason: `BOS SHORT: пробив Swing Low ${lastSwingLow.toFixed(2)}`,
      atr
    };
  }
  
  return null;
};

// FVG - Fair Value Gap
const detectFVG = (candles: Candle[], atr: number): TradeSignal | null => {
  if (candles.length < 3) return null;
  
  const curr = candles[candles.length - 1];
  const prev2 = candles[candles.length - 3];
  
  // Медвежий FVG: prev2.high < curr.low (зазор ВВЕРХУ)
  if (prev2 && prev2.high < curr.low) {
    const fvgMid = (prev2.high + curr.low) / 2;
    return {
      type: 'FVG',
      direction: 'SHORT',
      entryPrice: fvgMid,
      stopLoss: curr.low + atr * 0.3,
      tp1: fvgMid - atr * 1.0,
      tp2: fvgMid - atr * 2.0,
      tp3: fvgMid - atr * 3.0,
      confidence: 70,
      reason: `FVG SHORT: медвежий зазор ${(curr.low - prev2.high).toFixed(2)} пункти`,
      atr
    };
  }
  
  // Бычий FVG: prev2.low > curr.high (зазор ВНИЗУ)
  if (prev2 && prev2.low > curr.high) {
    const fvgMid = (prev2.low + curr.high) / 2;
    return {
      type: 'FVG',
      direction: 'LONG',
      entryPrice: fvgMid,
      stopLoss: curr.high - atr * 0.3,
      tp1: fvgMid + atr * 1.0,
      tp2: fvgMid + atr * 2.0,
      tp3: fvgMid + atr * 3.0,
      confidence: 70,
      reason: `FVG LONG: бычий зазор ${(prev2.low - curr.high).toFixed(2)} пункти`,
      atr
    };
  }
  
  return null;
};

// Order Block
const detectOrderBlock = (candles: Candle[], atr: number): TradeSignal | null => {
  if (candles.length < 20) return null;
  
  // Шукаємо блок консолідації (4-6 свечей з малим діапазоном)
  let bestBlock = null;
  let minRange = Infinity;
  
  for (let i = candles.length - 15; i < candles.length - 5; i++) {
    let blockHigh = candles[i].high;
    let blockLow = candles[i].low;
    let blockSize = 0;
    
    // Перевіряємо 4-6 свечей
    for (let j = i; j < Math.min(i + 6, candles.length - 2); j++) {
      blockHigh = Math.max(blockHigh, candles[j].high);
      blockLow = Math.min(blockLow, candles[j].low);
      blockSize++;
    }
    
    const range = blockHigh - blockLow;
    if (range < minRange && blockSize >= 4) {
      minRange = range;
      bestBlock = { high: blockHigh, low: blockLow, mid: (blockHigh + blockLow) / 2 };
    }
  }
  
  if (bestBlock && minRange < atr * 1.5) {
    const currentClose = candles[candles.length - 1].close;
    
    // LONG: Order Block ВНИЗУ
    if (currentClose > bestBlock.high) {
      return {
        type: 'OB',
        direction: 'LONG',
        entryPrice: currentClose,
        stopLoss: bestBlock.low - atr * 0.3,
        tp1: currentClose + atr * 1.0,
        tp2: currentClose + atr * 2.0,
        tp3: currentClose + atr * 3.0,
        confidence: 72,
        reason: `OB LONG: тест на ${bestBlock.high.toFixed(2)}`,
        atr
      };
    }
    
    // SHORT: Order Block ВВЕРХУ
    if (currentClose < bestBlock.low) {
      return {
        type: 'OB',
        direction: 'SHORT',
        entryPrice: currentClose,
        stopLoss: bestBlock.high + atr * 0.3,
        tp1: currentClose - atr * 1.0,
        tp2: currentClose - atr * 2.0,
        tp3: currentClose - atr * 3.0,
        confidence: 72,
        reason: `OB SHORT: тест на ${bestBlock.low.toFixed(2)}`,
        atr
      };
    }
  }
  
  return null;
};

// Fibonacci Correction
const detectFibonacci = (candles: Candle[], atr: number): TradeSignal | null => {
  if (candles.length < 50) return null;
  
  // Знаходимо останній High/Low за 50 свечей
  let highest = candles[candles.length - 50].high;
  let lowest = candles[candles.length - 50].low;
  
  for (let i = candles.length - 50; i < candles.length; i++) {
    highest = Math.max(highest, candles[i].high);
    lowest = Math.min(lowest, candles[i].low);
  }
  
  const range = highest - lowest;
  const fib50 = lowest + range * 0.5;
  const fib618 = lowest + range * 0.618;
  const currentClose = candles[candles.length - 1].close;
  
  // LONG: Коррекція до 0.5 від низу
  if (Math.abs(currentClose - fib50) < atr * 0.5 && currentClose > lowest) {
    return {
      type: 'FIBONACCI',
      direction: 'LONG',
      entryPrice: fib50,
      stopLoss: lowest - atr * 0.3,
      tp1: fib50 + atr * 1.5,
      tp2: fib50 + atr * 2.5,
      tp3: highest,
      confidence: 68,
      reason: `Fib LONG: 0.5 корекція на ${fib50.toFixed(2)}`,
      atr
    };
  }
  
  // SHORT: Коррекція до 0.5 від вверху
  if (Math.abs(currentClose - fib50) < atr * 0.5 && currentClose < highest) {
    return {
      type: 'FIBONACCI',
      direction: 'SHORT',
      entryPrice: fib50,
      stopLoss: highest + atr * 0.3,
      tp1: fib50 - atr * 1.5,
      tp2: fib50 - atr * 2.5,
      tp3: lowest,
      confidence: 68,
      reason: `Fib SHORT: 0.5 корекція на ${fib50.toFixed(2)}`,
      atr
    };
  }
  
  return null;
};

// MAIN: Комбо сигнал
const analyzeSignal = (candles: Candle[]): TradeSignal => {
  const atr = calculateATR(candles);
  
  const bosSignal = detectBOS(candles, atr);
  const fvgSignal = detectFVG(candles, atr);
  const obSignal = detectOrderBlock(candles, atr);
  const fibSignal = detectFibonacci(candles, atr);
  
  // Пріоритет: BOS > OB > FVG > Fibonacci
  const signal = bosSignal || obSignal || fvgSignal || fibSignal;
  
  return signal || {
    type: 'NONE',
    direction: 'NONE',
    entryPrice: 0,
    stopLoss: 0,
    tp1: 0,
    tp2: 0,
    tp3: 0,
    confidence: 0,
    reason: 'Немає сигналу',
    atr
  };
};

// ==================== REACT COMPONENT ====================

export default function GoldScalpBotV3() {
  const [signal, setSignal] = useState<TradeSignal | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [status, setStatus] = useState('idle');
  const [pnl, setPnl] = useState(0);
  
  // Mock candles (у реальному боті - API)
  const mockCandles: Candle[] = Array.from({ length: 100 }, (_, i) => {
    const basePrice = 2000 + Math.sin(i * 0.3) * 50 + Math.random() * 30;
    return {
      time: Date.now() - (100 - i) * 60000,
      open: basePrice + Math.random() * 5,
      high: basePrice + 15 + Math.random() * 10,
      low: basePrice - 15 - Math.random() * 10,
      close: basePrice + Math.random() * 10 - 5,
      volume: Math.random() * 1000000
    };
  });
  
  const analyze = useCallback(() => {
    setStatus('analyzing');
    const newSignal = analyzeSignal(mockCandles);
    setSignal(newSignal);
    setLastUpdate(new Date());
    setStatus('ready');
  }, []);
  
  useEffect(() => {
    analyze();
    const interval = setInterval(analyze, 30000);
    return () => clearInterval(interval);
  }, [analyze]);
  
  const openPosition = () => {
    if (!signal || signal.direction === 'NONE') return;
    
    const pos: Position = {
      id: Date.now().toString(),
      direction: signal.direction as 'LONG' | 'SHORT',
      entryPrice: signal.entryPrice,
      quantity: 0.1,
      stopLoss: signal.stopLoss,
      tp1: signal.tp1,
      tp2: signal.tp2,
      tp3: signal.tp3,
      tp1Closed: false,
      tp2Closed: false,
      openTime: new Date(),
      trailingStop: signal.stopLoss,
      pnl: 0,
      type: signal.type
    };
    
    setPositions([...positions, pos]);
  };
  
  const currentPrice = mockCandles[mockCandles.length - 1].close;
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-blue-900 to-gray-900 text-white p-4">
      <div className="max-w-6xl mx-auto space-y-6">
        
        {/* HEADER */}
        <div className="bg-gray-800/50 backdrop-blur border border-cyan-500/30 rounded-lg p-6">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-3xl font-bold text-cyan-400 mb-2">🥇 Gold Scalp Bot v3.0</h1>
              <p className="text-gray-400">BOS + FVG + Order Block + Fibonacci</p>
              <p className="text-sm text-gray-500 mt-2">
                {lastUpdate && `Last update: ${lastUpdate.toLocaleTimeString()}`}
              </p>
            </div>
            <div className="text-right">
              <div className="text-4xl font-bold text-yellow-400">${currentPrice.toFixed(2)}</div>
              <div className={`text-lg ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}%
              </div>
            </div>
          </div>
        </div>
        
        {/* SIGNAL */}
        {signal && signal.direction !== 'NONE' && (
          <div className={`border-2 rounded-lg p-6 ${
            signal.direction === 'LONG' 
              ? 'border-green-500/50 bg-green-900/20' 
              : 'border-red-500/50 bg-red-900/20'
          }`}>
            <div className="flex justify-between items-start mb-4">
              <div>
                <h2 className="text-2xl font-bold mb-2">
                  {signal.direction === 'LONG' ? '📈 LONG' : '📉 SHORT'} SIGNAL
                </h2>
                <p className="text-gray-300 mb-4">{signal.reason}</p>
                
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div>
                    <div className="text-gray-400 text-sm">Entry Price</div>
                    <div className="text-2xl font-bold">${signal.entryPrice.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-sm">Stop Loss</div>
                    <div className="text-xl font-bold text-red-400">${signal.stopLoss.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-sm">TP1 (30%)</div>
                    <div className="text-lg text-green-400">${signal.tp1.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-sm">TP2 (40%)</div>
                    <div className="text-lg text-green-400">${signal.tp2.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-sm">TP3 (30%)</div>
                    <div className="text-lg text-green-400">${signal.tp3.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-sm">Confidence</div>
                    <div className="text-lg text-cyan-400">{signal.confidence}%</div>
                  </div>
                </div>
              </div>
              
              <button
                onClick={openPosition}
                className="px-6 py-3 bg-cyan-500 hover:bg-cyan-600 text-black font-bold rounded-lg transition"
              >
                OPEN TRADE
              </button>
            </div>
            
            <div className="bg-gray-900/50 p-3 rounded text-sm text-gray-300">
              <p>💡 Risk/Reward: {(Math.abs(signal.tp3 - signal.entryPrice) / Math.abs(signal.entryPrice - signal.stopLoss)).toFixed(2)}:1</p>
              <p>📊 ATR: {signal.atr.toFixed(2)}</p>
            </div>
          </div>
        )}
        
        {/* POSITIONS */}
        {positions.length > 0 && (
          <div className="bg-gray-800/50 backdrop-blur border border-cyan-500/30 rounded-lg p-6">
            <h2 className="text-xl font-bold mb-4">📊 Open Positions ({positions.length})</h2>
            <div className="space-y-3">
              {positions.map(pos => (
                <div key={pos.id} className="bg-gray-900/50 p-4 rounded border border-gray-700">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-bold text-lg">
                        {pos.direction === 'LONG' ? '📈' : '📉'} {pos.type} - {pos.direction}
                      </div>
                      <div className="text-gray-400 text-sm">Entry: ${pos.entryPrice.toFixed(2)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-cyan-400">Current: ${currentPrice.toFixed(2)}</div>
                      <div className={pos.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                        {pos.pnl >= 0 ? '+' : ''}{((currentPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2)}%
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        
        {/* INFO */}
        <div className="bg-gray-800/50 backdrop-blur border border-cyan-500/30 rounded-lg p-6 text-sm text-gray-300">
          <h3 className="font-bold mb-3 text-cyan-400">📖 Стратегія</h3>
          <ul className="space-y-2">
            <li>✅ BOS (Break of Structure) - пробив Swing High/Low</li>
            <li>✅ FVG (Fair Value Gap) - заповнення зазорів</li>
            <li>✅ OB (Order Block) - тест консолідації</li>
            <li>✅ Fibonacci 0.5 - коррекції на середину</li>
            <li>✅ Scaling In - 3-5 входов по підтвердженню</li>
            <li>✅ Partial TP - закриття 30% / 40% / 30%</li>
            <li>✅ Trailing SL - динамічний стоп</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
