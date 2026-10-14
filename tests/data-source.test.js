import test from 'node:test';
import assert from 'node:assert/strict';
import {LIVE_CONFIG,normalizeResponse,fetchCandles,createFeed,DataError} from '../src/data-source.js';
const NOW=Date.UTC(2026,6,6,12),CONFIG={enabled:true,licenseApproved:true,endpoint:'https://example.test/v1/candles'};
const fixture=(pair='USD/JPY',count=300)=>({schemaVersion:1,source:'twelve-data',pair,timeframe:'5m',fetchedAt:NOW,expiresAt:NOW+300000,stale:false,marketStatus:'unknown',candles:Array.from({length:count},(_,i)=>({time:NOW-(count-i)*300000,open:150,high:151,low:149,close:150.2,complete:true}))});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('既定の無効設定・未承認では通信しない',async()=>{
 for(const config of [LIVE_CONFIG,{...CONFIG,licenseApproved:false},{...CONFIG,enabled:false}]){let calls=0;await assert.rejects(fetchCandles('USD/JPY',{config,fetchImpl:()=>{calls++;}}),e=>e.code==='DISABLED');assert.equal(calls,0);const feed=createFeed({config,fetcher:()=>{calls++;}});feed.select('USD/JPY','5m','live');await feed.refresh();assert.equal(calls,0);assert.equal(feed.snapshot().mode,'sample');}
});
test('3通貨のOHLC変換・期限切れ判定',()=>{
 for(const pair of ['USD/JPY','EUR/JPY','GBP/JPY']){const result=normalizeResponse(fixture(pair),pair,NOW);assert.equal(result.candles.length,300);assert.equal(result.stale,false);assert.equal(result.delaySeconds,null);assert.equal(normalizeResponse(fixture(pair),pair,NOW+300000).stale,true);}
});
test('OHLCなしの既存JSON、データ不足、文字列価格、不整合・未確定足を拒否',()=>{
 assert.throws(()=>normalizeResponse({price:150,SMA5:150,SMA20:149,signal:'BUY'},'USD/JPY',NOW),DataError);
 assert.throws(()=>normalizeResponse(fixture('USD/JPY',33),'USD/JPY',NOW),e=>e.code==='INSUFFICIENT');
 for(const mutate of [b=>b.candles[0].close='150',b=>b.candles[0].high=148,b=>b.candles[0].low=152,b=>b.candles[0].complete=false,b=>b.candles[0].time=b.candles[1].time,b=>b.candles.at(-1).time=NOW,b=>b.pair='EUR/JPY',b=>b.timeframe='1m',b=>b.expiresAt=NOW,b=>b.fetchedAt=NOW+120000,b=>b.stale='false']){const b=fixture();mutate(b);assert.throws(()=>normalizeResponse(b,'USD/JPY',NOW),DataError);}
});
test('通信先の検証、固定5分足パラメーター、正常取得',async()=>{
 for(const endpoint of ['', 'http://example.test/api','https://user:password@example.test/api','https://example.test/api?apikey=secret'])await assert.rejects(fetchCandles('USD/JPY',{config:{...CONFIG,endpoint}}),e=>e.code==='CONFIG');
 const result=await fetchCandles('EUR/JPY',{config:CONFIG,now:()=>NOW,fetchImpl:async(url,options)=>{assert.equal(url.searchParams.get('pair'),'EURJPY');assert.equal(url.searchParams.get('timeframe'),'5m');assert.equal(options.credentials,'omit');return {ok:true,json:async()=>fixture('EUR/JPY')};}});assert.equal(result.candles.length,300);
});
test('HTTPエラー・不正JSON・上流本文エラー・タイムアウトを日本語で返す',async()=>{
 for(const status of [401,403,429,500])await assert.rejects(fetchCandles('USD/JPY',{config:CONFIG,fetchImpl:async()=>({ok:false,status})}),e=>e.message.includes('取得エラー'));
 await assert.rejects(fetchCandles('USD/JPY',{config:CONFIG,fetchImpl:async()=>({ok:true,json:async()=>{throw Error('private upstream detail');}})}),e=>e.code==='INVALID'&&!e.message.includes('private'));
 await assert.rejects(fetchCandles('USD/JPY',{config:CONFIG,fetchImpl:async()=>({ok:true,json:async()=>({status:'error'})})}),e=>e.code==='INVALID');
 await assert.rejects(fetchCandles('USD/JPY',{config:CONFIG,timeoutMs:5,fetchImpl:async(_,o)=>new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(Error('aborted'))))}),e=>e.message.includes('タイムアウト'));
});
test('取得失敗・更新停止・期限切れはサンプルへ自動切り替えしない',async()=>{
 let fails=true,clock=NOW;const feed=createFeed({config:CONFIG,now:()=>clock,fetcher:async()=>{if(fails)throw new DataError('NETWORK','取得エラー：通信に失敗しました。');return normalizeResponse(fixture(),'USD/JPY',clock);}});
 feed.select('USD/JPY','5m','live');await settle();assert.equal(feed.snapshot().status,'error');assert.equal(feed.snapshot().mode,'live');
 fails=false;await feed.refresh();assert.equal(feed.snapshot().status,'ready');clock=NOW+300000;feed.checkExpiry();assert.equal(feed.snapshot().status,'stopped');assert.ok(feed.snapshot().message.includes('更新停止'));
 fails=true;await feed.refresh();assert.equal(feed.snapshot().status,'stopped');assert.equal(feed.snapshot().data.candles.length,300);
 feed.select('EUR/JPY','5m','live');await settle();assert.equal(feed.snapshot().data,null);assert.equal(feed.snapshot().status,'error');
 feed.select('USD/JPY','1h','live');assert.equal(feed.snapshot().status,'unsupported');feed.select('USD/JPY','1h','sample');assert.equal(feed.snapshot().status,'sample');
});
test('通貨切替後の遅い応答とサンプル復帰後の応答は無視',async()=>{
 const resolvers=[];const feed=createFeed({config:CONFIG,fetcher:pair=>new Promise(resolve=>resolvers.push(()=>resolve(normalizeResponse(fixture(pair),pair,NOW))))});
 feed.select('USD/JPY','5m','live');feed.select('EUR/JPY','5m','live');resolvers[0]();await settle();assert.equal(feed.snapshot().data,null);resolvers[1]();await settle();assert.equal(feed.snapshot().pair,'EUR/JPY');assert.equal(feed.snapshot().status,'ready');
 void feed.refresh();feed.select('EUR/JPY','5m','sample');resolvers[2]();await settle();assert.equal(feed.snapshot().mode,'sample');assert.equal(feed.snapshot().data,null);
});
test('Workersのデータ不足コードは日本語に変換し任意のエラー本文は表示しない',async()=>{
 await assert.rejects(fetchCandles('USD/JPY',{config:CONFIG,fetchImpl:async()=>({ok:false,status:502,json:async()=>({error:{code:'INSUFFICIENT_DATA',message:'private detail'}})})}),e=>e.code==='INSUFFICIENT'&&e.message.includes('データ不足')&&!e.message.includes('private'));
 await assert.rejects(fetchCandles('USD/JPY',{config:CONFIG,fetchImpl:async()=>({ok:false,status:502,json:async()=>({error:{code:'UNKNOWN',message:'private detail'}})})}),e=>e.code==='HTTP'&&!e.message.includes('private'));
});
