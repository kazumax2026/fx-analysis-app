import test from 'node:test';import assert from 'node:assert/strict';import {sma,ema,rsi,analyze,sampleData} from '../src/analysis.js';
test('移動平均は既知の系列と一致',()=>{assert.deepEqual(sma([1,2,3,4],3),[null,null,2,3]);assert.deepEqual(ema([1,2,3],3),[1,1.5,2.25]);});
test('RSIは上昇100・下落0・横ばい50、初期期間は未計算',()=>{for(const [step,expected]of [[1,100],[-1,0],[0,50]]){const result=rsi(Array.from({length:30},(_,i)=>100+i*step));assert.equal(result[13],null);assert.equal(result.at(-1),expected);}});
test('3通貨のサンプルは再現可能でOHLCと指標が有効',()=>{for(const pair of ['USD/JPY','EUR/JPY','GBP/JPY']){const data=sampleData(pair);assert.deepEqual(data,sampleData(pair));assert.equal(data.length,300);for(const c of data){assert.ok(c.high>=Math.max(c.open,c.close));assert.ok(c.low<=Math.min(c.open,c.close));}const a=analyze(data);for(const key of ['fast','slow','rsi','macd','signal'])assert.ok(Number.isFinite(a[key].at(-1)));assert.ok(['買い','売り','様子見'].includes(a.verdict));}});
test('指標不足では判定不可',()=>assert.equal(analyze(sampleData('USD/JPY').slice(0,10)).verdict,'判定不可'));
test('上昇・下降条件で買い・売りを判定し過熱時は様子見',()=>{const prices=Array.from({length:82},(_,i)=>100+i*.02+Math.sin(i*1.8)*.12);const candles=prices.map(close=>({close}));assert.equal(analyze(candles).verdict,'買い');assert.equal(analyze(prices.map(close=>({close:200-close}))).verdict,'売り');assert.equal(analyze(Array.from({length:120},(_,i)=>({close:i+1}))).verdict,'様子見');});

test('3通貨×5時間足のOHLC・時刻・指標と集約整合性',()=>{
 for(const pair of ['USD/JPY','EUR/JPY','GBP/JPY']){
  const minute=sampleData(pair,'1m');
  for(const [tf,size] of [['1m',1],['5m',5],['15m',15],['1h',60],['4h',240]]){
   const data=sampleData(pair,tf);assert.equal(data.length,300);assert.deepEqual(data,sampleData(pair,tf));
   for(let i=0;i<data.length;i++){const c=data[i];assert.ok(c.high>=Math.max(c.open,c.close));assert.ok(c.low<=Math.min(c.open,c.close));assert.equal(c.time%(size*60000),0);if(i)assert.ok(c.time>data[i-1].time);}
   const group=minute.slice(-size),last=data.at(-1);assert.equal(last.open,group[0].open);assert.equal(last.close,group.at(-1).close);assert.equal(last.high,Math.max(...group.map(c=>c.high)));assert.equal(last.low,Math.min(...group.map(c=>c.low)));
   const a=analyze(data);assert.notEqual(a.verdict,'判定不可');assert.equal(a.reasons.length,4);assert.ok(a.reasons[0].includes(a.fast.at(-1).toFixed(3)));assert.ok(a.reasons[1].includes(a.rsi.at(-1).toFixed(1)));assert.ok(a.reasons[2].includes(a.macd.at(-1).toFixed(3)));
  }
 }
});
test('無効なデータと計算オーバーフローは判定不可',()=>{
 for(const bad of [null,[],Array(40).fill({close:NaN}),Array(40).fill({close:Infinity}),Array(40).fill({close:-1}),Array(40).fill({close:Number.MAX_VALUE})]){const a=analyze(bad);assert.equal(a.verdict,'判定不可');assert.ok(a.reasons[0]);}
 assert.throws(()=>sampleData('AUD/JPY'));assert.throws(()=>sampleData('USD/JPY','2m'));
});
