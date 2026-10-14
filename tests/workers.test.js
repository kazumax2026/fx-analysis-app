import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorker,normalizeTwelveData} from '../workers/fx-compass-api.js';
import {normalizeResponse} from '../src/data-source.js';
const NOW=Date.UTC(2026,6,6,12,0,30),END=Date.UTC(2026,6,6,12);
const env={PUBLIC_OHLC_ENABLED:'true',LICENSE_APPROVED:'true',TWELVE_DATA_API_KEY:'mock-test-only',ALLOWED_ORIGIN:'https://example.test'};
const req=(pair='USDJPY',extra={},query=`pair=${pair}&timeframe=5m`)=>new Request(`https://worker.test/v1/candles?${query}`,extra);
function fixture(symbol='USD/JPY',count=302){return {meta:{symbol,interval:'5min',exchange_timezone:'UTC'},values:Array.from({length:count},(_,i)=>({datetime:new Date(END-i*300000).toISOString().slice(0,19).replace('T',' '),open:'150.1',high:'150.3',low:'149.9',close:'150.2'}))};}
function mockCache(){const data=new Map();return {async match(r){return data.get(r.url)?.clone();},async put(r,response){data.set(r.url,response.clone());}};}
const options={now:()=>NOW,authorize:async()=>true,consumeBudget:async()=>({allowed:true})};
test('初期無効・未承認・未設定認証と全体予算で通信ゼロ',async()=>{
 let calls=0;const w=createWorker({...options,fetchImpl:async()=>{calls++;}});
 for(const config of [{},{...env,PUBLIC_OHLC_ENABLED:'false'},{...env,LICENSE_APPROVED:'false'}])assert.equal((await w.fetch(req(),config)).status,403);
 assert.equal((await createWorker({fetchImpl:async()=>{calls++;}}).fetch(req(),env)).status,503);
 assert.equal((await createWorker({...options,authorize:async()=>false,fetchImpl:async()=>{calls++;}}).fetch(req(),env)).status,401);
 assert.equal(calls,0);
});
test('UTC・確定足・3通貨OHLCがフロントの契約と一致',async()=>{
 for(const [pair,symbol] of [['USDJPY','USD/JPY'],['EURJPY','EUR/JPY'],['GBPJPY','GBP/JPY']]){
  const w=createWorker({...options,fetchImpl:async(url,opts)=>{assert.equal(url.hostname,'api.twelvedata.com');assert.equal(url.searchParams.get('symbol'),symbol);assert.equal(url.searchParams.get('timezone'),'UTC');assert.equal(url.searchParams.get('interval'),'5min');assert.ok(!url.toString().includes(env.TWELVE_DATA_API_KEY));assert.equal(opts.headers.Authorization,'apikey '+env.TWELVE_DATA_API_KEY);return Response.json(fixture(symbol));}});
  const response=await w.fetch(req(pair),env),b=await response.json();assert.equal(response.status,200);assert.equal(b.candles.length,300);assert.equal(b.marketStatus,'unknown');assert.equal(b.delaySeconds,null);assert.ok(b.candles.every(c=>c.time+300000+15000<=NOW));assert.equal(normalizeResponse(b,symbol,NOW).stale,false);
 }
});
test('不正UTC・OHLC・重複・通貨・データ不足と古い足を検出',()=>{
 for(const mutate of [b=>b.values[0].datetime='2026-02-30 12:00:00',b=>b.values[0].datetime='2026-07-06 12:01:00',b=>b.values[0].high='149',b=>b.values[0].close='150oops',b=>b.values[0].low='0',b=>b.values[0].open='Infinity',b=>b.values[0].datetime=b.values[1].datetime,b=>b.meta.exchange_timezone='Asia/Tokyo',b=>b.meta.symbol='GBP/JPY',b=>b.values=[]]){const b=fixture();mutate(b);assert.throws(()=>normalizeTwelveData(b,'USD/JPY',NOW));}
 const b=fixture();b.values=b.values.slice(4);assert.equal(normalizeTwelveData(b,'USD/JPY',NOW).stale,true);
});
test('入力・Origin・メソッドを制限しSecret欠落では取得しない',async()=>{
 const w=createWorker({...options});
 for(const query of ['pair=AUDJPY&timeframe=5m','pair=USDJPY&timeframe=1m','pair=USDJPY&pair=EURJPY&timeframe=5m','pair=USDJPY&timeframe=5m&url=https://evil.test'])assert.equal((await w.fetch(req('USDJPY',{},query),env)).status,400);
 assert.equal((await w.fetch(req('USDJPY',{method:'POST'}),env)).status,405);
 assert.equal((await w.fetch(req('USDJPY',{headers:{Origin:'https://evil.test'}}),env)).status,403);
 const preflight=await w.fetch(req('USDJPY',{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGIN}}),env);assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),env.ALLOWED_ORIGIN);
 assert.equal((await w.fetch(req(),{...env,TWELVE_DATA_API_KEY:''})).status,503);
});
test('キャッシュの取得時刻保持と同時取得の共有、期限切れ障害時はstale',async()=>{
 let calls=0,budgets=0,clock=NOW,fail=false;const w=createWorker({...options,now:()=>clock,cache:mockCache(),consumeBudget:async()=>{budgets++;return {allowed:true};},fetchImpl:async()=>{calls++;await new Promise(r=>setTimeout(r,5));if(fail)throw Error('private detail');return Response.json(fixture());}});
 const first=await Promise.all([w.fetch(req(),env),w.fetch(req(),env)]);assert.ok(first.every(r=>r.status===200));assert.equal(calls,1);assert.equal(budgets,1);
 const b=await (await w.fetch(req(),env)).json();assert.equal(b.fetchedAt,NOW);assert.equal(calls,1);
 clock=b.expiresAt+1;fail=true;const old=await (await w.fetch(req(),env)).json();assert.equal(old.stale,true);assert.equal(old.fetchedAt,b.fetchedAt);assert.equal(old.expiresAt,b.expiresAt);
 clock=NOW+3600001;assert.equal((await w.fetch(req(),env)).status,502);
});
test('ローカル/IP制限と全体予算拒否で429・Retry-After',async()=>{
 let calls=0;const w=createWorker({...options,perIpLimit:1,cache:mockCache(),fetchImpl:async()=>{calls++;return Response.json(fixture());}});
 assert.equal((await w.fetch(req(),env)).status,200);const limited=await w.fetch(req(),env);assert.equal(limited.status,429);assert.equal(limited.headers.get('Retry-After'),'60');assert.equal(calls,1);
 const global=createWorker({...options,consumeBudget:async()=>({allowed:false,retryAfter:120}),fetchImpl:async()=>{calls++;}});const response=await global.fetch(req(),env);assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),'120');assert.equal(calls,1);
});
test('上流HTTP・本文エラー・不正JSON・タイムアウトは安全な日本語エラー',async()=>{
 for(const [fetchImpl,status] of [[async()=>new Response('private API key',{status:500}),502],[async()=>Response.json({status:'error',code:429,message:'private'}),429],[async()=>Response.json({status:'error',message:'private'}),502],[async()=>new Response('not json'),502],[async(_,o)=>new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(Error('private')))),504]]){
  const w=createWorker({...options,timeoutMs:5,fetchImpl});const r=await w.fetch(req(),env);assert.equal(r.status,status);const text=await r.text();assert.ok(!text.includes('private'));assert.ok(!text.includes(env.TWELVE_DATA_API_KEY));
 }
});
