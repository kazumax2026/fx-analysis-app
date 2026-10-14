import test from 'node:test';import assert from 'node:assert/strict';
import {durableClass,durableClient,FxBudgetCoordinator} from '../workers/durable-coordinator.js';
import {createAccessAuthorizer} from '../workers/access-auth.js';
import {createWorker,normalizeTwelveData} from '../workers/fx-compass-api.js';
import {MockDurableStorage} from '../test-support/durable-storage.js';
import {ohlcFixture,MOCK_NOW} from '../test-support/ohlc-fixtures.js';
const env={PUBLIC_OHLC_ENABLED:'true',LICENSE_APPROVED:'true',MINUTE_BUDGET:'10',DAY_BUDGET:'10'};
const req=(pair='USDJPY',token='mock-token')=>new Request(`https://test/v1/candles?pair=${pair}&timeframe=5m`,{headers:token?{'Cf-Access-Jwt-Assertion':token}:{}});
const authOptions={issuer:'https://access.example.test',audience:'test-app',subjects:['test-user'],now:()=>MOCK_NOW};
const valid={iss:authOptions.issuer,aud:['test-app'],sub:'test-user',exp:MOCK_NOW/1000+60};
function setup(settings={}){
 const storage=new MockDurableStorage();let calls=0;const names=[];
 const Class=durableClass({now:()=>MOCK_NOW,mockSource:async({symbol})=>{calls++;await new Promise(r=>setTimeout(r,5));return ohlcFixture('normal',symbol);},...settings});
 let instance=new Class({storage},env);
 const binding={idFromName:name=>{names.push(name);return name;},get:()=>({fetch:url=>instance.fetch(new Request(url))})};
 return {storage,binding,names,get calls(){return calls;},restart:()=>instance=new Class({storage},env)};
}
test('Accessの許可・拒否・期限切れ・未設定をモックで検証',async()=>{
 assert.equal(await createAccessAuthorizer()(req()),false);
 for(const [claims,result] of [[valid,true],[{...valid,exp:MOCK_NOW/1000},false],[{...valid,nbf:MOCK_NOW/1000+1},false],[{...valid,iss:'https://wrong.test'},false],[{...valid,aud:['other']},false],[{...valid,sub:'other'},false]]){
  const authorize=createAccessAuthorizer({...authOptions,verifyToken:async()=>claims});assert.equal(await authorize(req()),result);assert.equal(await authorize(req('USDJPY','')),false);
 }
 assert.equal(await createAccessAuthorizer({...authOptions,verifyToken:async()=>{throw Error('signature invalid');}})(req()),false);
});
test('AccessとDOクライアントをWorkerへ接続、認証拒否で予算・配信に到達しない',async()=>{
 const x=setup();const coordinator=durableClient(x.binding,{now:()=>MOCK_NOW});
 const allow=createAccessAuthorizer({...authOptions,verifyToken:async()=>valid});
 assert.equal((await createWorker({coordinator,authorize:allow}).fetch(req(),env)).status,200);assert.equal(x.calls,1);
 const deny=createAccessAuthorizer({...authOptions,verifyToken:async()=>({...valid,exp:0})});
 assert.equal((await createWorker({coordinator,authorize:deny}).fetch(req('EURJPY'),env)).status,401);
 assert.equal((await createWorker({coordinator}).fetch(req(),env)).status,503);
 assert.equal((await createWorker({coordinator,authorize:allow}).fetch(req(),{})).status,403);assert.equal(x.calls,1);
});
test('DOストレージ共有：同時要求・キャッシュ非消費・インスタンス再生成の予算保持',async()=>{
 const x=setup();const a=durableClient(x.binding,{now:()=>MOCK_NOW}),b=durableClient(x.binding,{now:()=>MOCK_NOW});
 const data=await Promise.all([a.get('USDJPY:5m'),b.get('USDJPY:5m')]);assert.equal(x.calls,1);assert.equal(data[0].pair,'USD/JPY');
 x.restart();await b.get('USDJPY:5m');assert.equal(x.calls,1);
 await b.get('EURJPY:5m');await a.get('GBPJPY:5m');assert.equal(x.calls,3);assert.equal(new Set(x.names).size,1);
 assert.equal(x.storage.data.get('fx-budget-state-v1').day.used,3);
});
test('DO保存状態の破損・停止とbinding障害は取得拒否',async()=>{
 const x=setup();const client=durableClient(x.binding,{now:()=>MOCK_NOW});await client.get('USDJPY:5m');
 delete x.storage.data.get('fx-budget-state-v1').day;await assert.rejects(client.get('EURJPY:5m'),e=>e.status===503);assert.equal(x.calls,1);
 x.storage.available=false;await assert.rejects(client.get('USDJPY:5m'),e=>e.status===503);
 await assert.rejects(durableClient({idFromName(){throw Error();}}).get('USDJPY:5m'),e=>e.status===503);
 x.storage.available=true;x.storage.data.set('fx-budget-state-v1',{});await assert.rejects(client.get('USDJPY:5m'),e=>e.status===503);assert.equal(x.calls,1);
});
test('標準DOは公開無効・配信未設定で通信なし、未設定予算は0',async()=>{
 const storage=new MockDurableStorage(),instance=new FxBudgetCoordinator({storage},{});const r=new Request('https://internal/internal/candles?pair=USDJPY&timeframe=5m');assert.equal((await instance.fetch(r)).status,403);
 assert.equal((await new FxBudgetCoordinator({storage},env).fetch(r)).status,503);
 let calls=0;const Class=durableClass({now:()=>MOCK_NOW,mockSource:async()=>{calls++;return ohlcFixture();}});
 assert.equal((await new Class({storage},{PUBLIC_OHLC_ENABLED:'true',LICENSE_APPROVED:'true'}).fetch(r)).status,429);assert.equal(calls,0);
});
test('DO経由の分・日上限とタイムアウト予約を維持',async()=>{
 const storage=new MockDurableStorage();let calls=0;
 const Class=durableClass({now:()=>MOCK_NOW,timeoutMs:5,mockSource:async()=>{calls++;return new Promise(()=>{});}});
 const instance=new Class({storage},{...env,MINUTE_BUDGET:'1',DAY_BUDGET:'1'});
 const r=pair=>new Request(`https://internal/internal/candles?pair=${pair}&timeframe=5m`);
 assert.equal((await instance.fetch(r('USDJPY'))).status,504);assert.equal(storage.data.get('fx-budget-state-v1').day.used,1);
 assert.equal((await instance.fetch(r('EURJPY'))).status,429);assert.equal(calls,1);
});
test('管理先無応答・JSON本文停止をタイムアウトで拒否',async()=>{
 for(const response of [new Promise(()=>{}),Promise.resolve({ok:true,json:()=>new Promise(()=>{})})]){
  const binding={idFromName:()=>'',get:()=>({fetch:()=>response})};
  await assert.rejects(durableClient(binding,{timeoutMs:5}).get('USDJPY:5m'),e=>e.status===504);
 }
});
test('保存キャッシュ・成功応答の破損と別通貨の混入を拒否',async()=>{
 const x=setup();const client=durableClient(x.binding,{now:()=>MOCK_NOW});await client.get('USDJPY:5m');
 x.storage.data.get('fx-budget-state-v1').entries['USDJPY:5m'].data.candles[0].close=-1;
 await assert.rejects(client.get('USDJPY:5m'),e=>e.code==='INVALID_RESPONSE');assert.equal(x.calls,1);
 const body={error:{message:'private'}};const binding={idFromName:()=>'',get:()=>({fetch:async()=>Response.json(body)})};
 await assert.rejects(durableClient(binding).get('USDJPY:5m'),e=>e.code==='INVALID_RESPONSE'&&!e.message.includes('private'));
 const wrongPair=normalizeTwelveData(ohlcFixture('normal','EUR/JPY'),'EUR/JPY',MOCK_NOW);
 const otherBinding={idFromName:()=>'',get:()=>({fetch:async()=>Response.json(wrongPair)})};
 await assert.rejects(durableClient(otherBinding,{now:()=>MOCK_NOW}).get('USDJPY:5m'),e=>e.code==='INVALID_RESPONSE');
});
test('認証検証の停止・不正設定・偽トークンを拒否',async()=>{
 assert.equal(await createAccessAuthorizer({...authOptions,timeoutMs:5,verifyToken:()=>new Promise(()=>{})})(req()),false);
 assert.equal(await createAccessAuthorizer({...authOptions,subjects:'test-user',verifyToken:async()=>valid})(req()),false);
 assert.equal(await createAccessAuthorizer({...authOptions,issuer:'https://user:password@access.example.test',verifyToken:async()=>valid})(req()),false);
 const authorize=createAccessAuthorizer({...authOptions,verifyToken:async token=>{if(token!=='mock-token')throw Error('invalid signature');return valid;}});
 assert.equal(await authorize(req('USDJPY','forged')),false);
});
test('DO予算上限は別インスタンス・別通貨の並行要求でも増えない',async()=>{
 const storage=new MockDurableStorage();let calls=0;const Class=durableClass({now:()=>MOCK_NOW,mockSource:async({symbol})=>{calls++;return ohlcFixture('normal',symbol);}});
 const settings={...env,MINUTE_BUDGET:'1',DAY_BUDGET:'1'};
 const request=pair=>new Request(`https://internal/internal/candles?pair=${pair}&timeframe=5m`);
 const a=new Class({storage},settings),b=new Class({storage},settings);
 const results=await Promise.all([a.fetch(request('USDJPY')),b.fetch(request('EURJPY'))]);assert.deepEqual(results.map(r=>r.status).sort(),[200,429]);assert.equal(calls,1);assert.equal(storage.data.get('fx-budget-state-v1').day.used,1);
});
test('クライアントのタイムアウト後も予約保持、DO完了・再起動後の再試行はキャッシュ非消費',async()=>{
 const x=setup({mockSource:async({symbol})=>{await new Promise(r=>setTimeout(r,20));return ohlcFixture('normal',symbol);}});
 await assert.rejects(durableClient(x.binding,{timeoutMs:5,now:()=>MOCK_NOW}).get('USDJPY:5m'),e=>e.status===504);
 await new Promise(r=>setTimeout(r,35));assert.equal(x.storage.data.get('fx-budget-state-v1').day.used,1);
 x.restart();await durableClient(x.binding,{now:()=>MOCK_NOW}).get('USDJPY:5m');assert.equal(x.storage.data.get('fx-budget-state-v1').day.used,1);
});
