import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createCoordinator} from '../workers/coordinator.js';
import {FileStore} from '../test-support/file-store.js';
import {ohlcFixture,MOCK_NOW} from '../test-support/ohlc-fixtures.js';
import {createWorker,normalizeTwelveData} from '../workers/fx-compass-api.js';
const env={PUBLIC_OHLC_ENABLED:'true',LICENSE_APPROVED:'true'}; // no API key at all
const req=(pair='USDJPY')=>new Request(`https://mock.test/v1/candles?pair=${pair}&timeframe=5m`);
async function setup(t,settings={}){const dir=await mkdtemp(join(tmpdir(),'fx-budget-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'state.json');await writeFile(path,'{}',{flag:'wx'});const store=new FileStore(path);let clock=MOCK_NOW;const config={store,now:()=>clock,minuteLimit:10,dayLimit:20,timeoutMs:50,...settings};return {path,store,config,setTime:v=>clock=v,coordinator:createCoordinator(config)};}
function worker(coordinator,mockSource,extra={}){return createWorker({coordinator,mockSource,authorize:async()=>true,now:()=>MOCK_NOW,...extra});}
test('OHLCモック：正常・形成中・欠損・重複・不正価格・古いデータ',()=>{
 const normal=normalizeTwelveData(ohlcFixture(),'USD/JPY',MOCK_NOW);assert.equal(normal.candles.length,300);assert.ok(normal.candles.at(-1).time+300000<MOCK_NOW);
 const gap=normalizeTwelveData(ohlcFixture('missing'),'USD/JPY',MOCK_NOW);assert.ok(gap.candles.some((c,i,a)=>i&&c.time-a[i-1].time>300000));
 for(const kind of ['duplicate','invalid-price','insufficient'])assert.throws(()=>normalizeTwelveData(ohlcFixture(kind),'USD/JPY',MOCK_NOW));assert.equal(normalizeTwelveData(ohlcFixture('old'),'USD/JPY',MOCK_NOW).stale,true);
});
test('別Worker・別Coordinatorの同時要求を共有し一度だけ予約、キャッシュ消費ゼロ',async t=>{
 const x=await setup(t);let calls=0;const source=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return ohlcFixture();};
 const a=worker(x.coordinator,source),b=worker(createCoordinator({...x.config,store:new FileStore(x.path)}),source);
 const results=await Promise.all([a.fetch(req(),env),b.fetch(req(),env),a.fetch(req(),env)]);assert.ok(results.every(r=>r.status===200));assert.equal(calls,1);assert.equal((await x.coordinator.inspect()).day.used,1);
 assert.equal((await b.fetch(req(),env)).status,200);assert.equal(calls,1);assert.equal((await x.coordinator.inspect()).minute.used,1);
});
test('取得前に予約し分・日上限、分境界・UTC日境界を検証',async t=>{
 const x=await setup(t,{minuteLimit:1,dayLimit:2});const load=async()=>{assert.ok((await x.coordinator.inspect()).day.used>=1);return normalizeTwelveData(ohlcFixture(),'USD/JPY',MOCK_NOW);};
 await x.coordinator.get('USDJPY:5m',load);await assert.rejects(x.coordinator.get('EURJPY:5m',load),e=>e.status===429);
 x.setTime(MOCK_NOW+60000);await x.coordinator.get('EURJPY:5m',load);await assert.rejects(x.coordinator.get('GBPJPY:5m',load),e=>e.status===429);
 x.setTime(Date.UTC(2026,6,7));await x.coordinator.get('GBPJPY:5m',load);const s=await x.coordinator.inspect();assert.equal(s.day.used,1);assert.equal(s.minute.used,1);
});
test('通信障害・タイムアウト・データ不正でも予約を返金しない',async t=>{
 const x=await setup(t,{timeoutMs:10});
 const failing=worker(x.coordinator,async()=>{throw Error('private');});assert.equal((await failing.fetch(req(),env)).status,502);
 const timeout=worker(x.coordinator,async()=>new Promise(()=>{}));assert.equal((await timeout.fetch(req('EURJPY'),env)).status,504);
 const invalid=worker(x.coordinator,async()=>ohlcFixture('invalid-price','GBP/JPY'));assert.equal((await invalid.fetch(req('GBPJPY'),env)).status,502);
 assert.equal((await x.coordinator.inspect()).day.used,3);
 const restarted=createCoordinator({...x.config,store:new FileStore(x.path)});assert.equal((await restarted.inspect()).day.used,3);
});
test('永続ストアを別Nodeプロセスで再読込して予約保持を確認',async t=>{
 const x=await setup(t);await x.coordinator.get('USDJPY:5m',async()=>normalizeTwelveData(ohlcFixture(),'USD/JPY',MOCK_NOW));
 const module=new URL('../test-support/file-store.js',import.meta.url).href;
 const code=`import {FileStore} from ${JSON.stringify(module)}; const s=await new FileStore(${JSON.stringify(x.path)}).transaction(s=>s); if(s.day.used!==1)process.exit(1);`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
test('取得途中の再起動：永続予約の期限まで再取得せず期限後も旧消費を保持',async t=>{
 const x=await setup(t,{timeoutMs:20});await x.store.transaction(s=>{s.version=1;s.sequence=1;s.lastTime=MOCK_NOW;s.day={period:Math.floor(MOCK_NOW/86400000),used:1};s.minute={period:Math.floor(MOCK_NOW/60000),used:1};s.entries={'USDJPY:5m':{lease:{token:1,until:MOCK_NOW+100}}};});
 let calls=0;const coordinator=createCoordinator({...x.config,store:new FileStore(x.path)});
 const pending=coordinator.get('USDJPY:5m',async()=>{calls++;return normalizeTwelveData(ohlcFixture(),'USD/JPY',MOCK_NOW);});await new Promise(r=>setTimeout(r,10));assert.equal(calls,0);x.setTime(MOCK_NOW+101);await pending;assert.equal(calls,1);assert.equal((await coordinator.inspect()).day.used,2);
});
test('期限切れ更新失敗でも前回キャッシュの時刻を保ち予算を保持',async t=>{
 const x=await setup(t);const original=await x.coordinator.get('USDJPY:5m',async()=>normalizeTwelveData(ohlcFixture(),'USD/JPY',MOCK_NOW));x.setTime(original.expiresAt+1);
 const stale=await x.coordinator.get('USDJPY:5m',async()=>{throw Object.assign(Error(),{status:502});});assert.equal(stale.stale,true);assert.equal(stale.fetchedAt,original.fetchedAt);assert.equal(stale.expiresAt,original.expiresAt);assert.equal((await x.coordinator.inspect()).day.used,2);
});
test('ストア停止・破損・保存失敗・未設定予算では通信せず拒否',async t=>{
 const x=await setup(t);let calls=0;const source=async()=>{calls++;return ohlcFixture();};const w=worker(x.coordinator,source);
 x.store.available=false;assert.equal((await w.fetch(req(),env)).status,503);x.store.available=true;await writeFile(x.path,'broken');assert.equal((await w.fetch(req(),env)).status,503);assert.equal(calls,0);
 const fail=createCoordinator({...x.config,store:{transaction:async()=>{throw Error('disk failure');}}});assert.equal((await worker(fail,source).fetch(req(),env)).status,503);assert.equal(calls,0);
 const zero=await setup(t,{minuteLimit:0,dayLimit:0});assert.equal((await worker(zero.coordinator,source).fetch(req(),env)).status,429);assert.equal(calls,0);
});
test('公開無効・認証未設定・認証拒否はモック取得と予算予約もゼロ',async t=>{
 const x=await setup(t);let calls=0;const source=async()=>{calls++;return ohlcFixture();};
 assert.equal((await worker(x.coordinator,source).fetch(req(),{})).status,403);
 assert.equal((await createWorker({coordinator:x.coordinator,mockSource:source}).fetch(req(),env)).status,503);
 assert.equal((await worker(x.coordinator,source,{authorize:async()=>false}).fetch(req(),env)).status,401);
 assert.equal(calls,0);assert.equal((await x.coordinator.inspect()).day,undefined);
});
test('予約後の保存障害でも永続予算を残し、キャッシュ取得も管理停止時は拒否',async t=>{
 const x=await setup(t);await assert.rejects(x.coordinator.get('USDJPY:5m',async()=>{x.store.available=false;return normalizeTwelveData(ohlcFixture(),'USD/JPY',MOCK_NOW);}),e=>e.status===503);
 x.store.available=true;assert.equal((await x.coordinator.inspect()).day.used,1);
 await x.coordinator.get('EURJPY:5m',async()=>normalizeTwelveData(ohlcFixture('normal','EUR/JPY'),'EUR/JPY',MOCK_NOW));x.store.available=false;
 let calls=0;assert.equal((await worker(x.coordinator,async()=>{calls++;return ohlcFixture();}).fetch(req('EURJPY'),env)).status,503);assert.equal(calls,0);
});
test('タイムアウト後に遅れた成功応答が来てもキャッシュを書き戻さず返金しない',async t=>{
 const x=await setup(t,{timeoutMs:5});let finish;const pending=x.coordinator.get('USDJPY:5m',()=>new Promise(r=>finish=r));
 await assert.rejects(pending,e=>e.status===504);finish(normalizeTwelveData(ohlcFixture(),'USD/JPY',MOCK_NOW));await new Promise(r=>setImmediate(r));
 const state=await x.coordinator.inspect();assert.equal(state.day.used,1);assert.equal(state.entries['USDJPY:5m'].data,undefined);
});
test('別通貨の並行予約も共通予算で原子的に制限し、設定した単価を消費',async t=>{
 const x=await setup(t,{minuteLimit:2,dayLimit:2,cost:2});let calls=0;
 const load=async()=>{calls++;return normalizeTwelveData(ohlcFixture(),'USD/JPY',MOCK_NOW);};
 const outcomes=await Promise.allSettled([x.coordinator.get('USDJPY:5m',load),createCoordinator({...x.config,store:new FileStore(x.path)}).get('EURJPY:5m',load)]);
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected'&&r.reason.status===429).length,1);assert.equal(calls,1);assert.equal((await x.coordinator.inspect()).day.used,2);
});
test('日次上限1：保存済みカウンター欠落・破損を503で拒否し二回目を取得しない',async t=>{
 const mutations=[s=>delete s.day,s=>delete s.minute,s=>s.day=null,s=>s.minute=null,s=>s.day.used=-1,s=>delete s.minute.used,s=>s.day.used='0',s=>s.minute.period=NaN,s=>delete s.version,s=>delete s.sequence,s=>delete s.lastTime];
 for(const mutate of mutations){
  const x=await setup(t,{dayLimit:1});let calls=0;const source=async({symbol})=>{calls++;return ohlcFixture('normal',symbol);};const w=worker(x.coordinator,source);
  assert.equal((await w.fetch(req(),env)).status,200);assert.equal(calls,1);
  await x.store.transaction(mutate);
  const saved=await x.store.transaction(s=>s);
  assert.equal((await w.fetch(req('EURJPY'),env)).status,503);assert.equal(calls,1);
  // Damage is not repaired by silently resetting counters.
  assert.deepEqual(await x.store.transaction(s=>s),saved);
  // A fresh cache must not bypass corrupt budget state either.
  assert.equal((await w.fetch(req(),env)).status,503);assert.equal(calls,1);
 }
});
test('完全な空状態だけを初期化し、部分的な初期状態は拒否する',async t=>{
 const x=await setup(t,{dayLimit:1});assert.deepEqual(await x.coordinator.inspect(),{});
 let calls=0;await x.coordinator.get('USDJPY:5m',async()=>{calls++;return normalizeTwelveData(ohlcFixture(),'USD/JPY',MOCK_NOW);});
 const state=await x.coordinator.inspect();assert.equal(state.day.used,1);assert.equal(state.minute.used,1);
 await assert.rejects(x.coordinator.get('EURJPY:5m',async()=>{calls++;}),e=>e.status===429);assert.equal(calls,1);
 const partial=await setup(t);await partial.store.transaction(s=>{s.version=1;});
 await assert.rejects(partial.coordinator.get('USDJPY:5m',async()=>{calls++;}),e=>e.code==='BUDGET_UNAVAILABLE');assert.equal(calls,1);
});
