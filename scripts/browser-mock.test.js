import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createWorker} from '../workers/fx-compass-api.js';
import {createCoordinator} from '../workers/coordinator.js';
import {FileStore} from '../test-support/file-store.js';
import {ohlcFixture,MOCK_NOW} from '../test-support/ohlc-fixtures.js';
import {analyze} from '../src/analysis.js';
const {chromium}=createRequire(import.meta.url)('playwright');
let server,browser,base;
before(async()=>{
 server=http.createServer(async(req,res)=>{const p=new URL(req.url,'http://local').pathname;const files={'/':'index.html','/styles.css':'styles.css','/src/app.js':'src/app.js','/src/analysis.js':'src/analysis.js','/src/data-source.js':'src/data-source.js'};if(!files[p]){res.writeHead(404).end();return;}res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html');res.end(await readFile(new URL('../'+files[p],import.meta.url)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.FX_BROWSER_PATH?{executablePath:process.env.FX_BROWSER_PATH}:{})});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});
async function setup(t,{live=true,viewport={width:1024,height:1366}}={}){
 const page=await browser.newPage({viewport,hasTouch:true});const errors=[];let external=0,calls=0;let kind='normal',slowPair=null,release;const expected=new Map();
 const dir=await mkdtemp(join(tmpdir(),'fx-browser-'));const path=join(dir,'store.json');await (await import('node:fs/promises')).writeFile(path,'{}');
 const clock=()=>MOCK_NOW;
 const coordinator=createCoordinator({store:new FileStore(path),now:clock,minuteLimit:100,dayLimit:100,timeoutMs:10000});
 const worker=createWorker({coordinator,authorize:async()=>true,now:clock,mockSource:async({symbol})=>{calls++;if(kind==='network')throw Error('mock network');const data=ohlcFixture(kind,symbol);const offset={'USD/JPY':0,'EUR/JPY':12,'GBP/JPY':40}[symbol];data.values.forEach((v,i)=>{const c=150+offset+i*.002+Math.sin(i)*.12;Object.assign(v,{open:String(c-.01),high:String(c+.2),low:String(c-.2),close:String(c)});});if(kind==='invalid-price')data.values[20].close='bad';return data;}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const url=route.request().url();
  if(url.startsWith(base+'/src/data-source.js')&&live){const r=await route.fetch();const body=await r.text();const replacement=body.replace("enabled:false,licenseApproved:false,endpoint:''","enabled:true,licenseApproved:true,endpoint:'https://mock.fx.test/v1/candles'");assert.notEqual(body,replacement);await route.fulfill({response:r,body:replacement});return;}
  if(url.startsWith('https://mock.fx.test/')){
   const pair=new URL(url).searchParams.get('pair');
   // Let rapid-switch tests deliver an old response after the new selection.
   const delayed=pair===slowPair;const currentKind=kind;
   const response=await worker.fetch(new Request(url),{PUBLIC_OHLC_ENABLED:'true',LICENSE_APPROVED:'true'});const b=await response.json();
   if(b.candles)expected.set(pair,b);
   if(delayed)await new Promise(r=>release=r);
   try{await route.fulfill({status:response.status,json:b,headers:{'Access-Control-Allow-Origin':base}});}catch{}return;
  }
  if(url.startsWith(base+'/'))return route.continue();external++;await route.abort();
 });
 await page.clock.install({time:MOCK_NOW});await page.goto(base);await page.waitForSelector('svg');
 t.after(async()=>{release?.();await page.close();await rm(dir,{recursive:true,force:true});assert.deepEqual(errors,[]);assert.equal(external,0);});
 return {page,expected,get calls(){return calls;},setKind:v=>kind=v,delay:pair=>{slowPair=pair;release=null;},waitDelayed:async()=>{const end=Date.now()+2000;while(!release&&Date.now()<end)await new Promise(r=>setTimeout(r,2));assert.ok(release,'Delayed response was queued');},release:()=>release?.()};
}
async function enter(page){await page.locator('#live-mode').tap();await page.waitForFunction(()=>document.getElementById('source-status').textContent.includes('実データ（'));}
async function status(page,text){await page.waitForFunction(text=>document.getElementById('source-status').textContent.includes(text),text);}
for(const viewport of [{width:1024,height:1366},{width:1366,height:1024}]){
 test(`iPad相当 ${viewport.width}×${viewport.height}：3通貨OHLC・全指標・理由・タップ`,async t=>{
  const x=await setup(t,{viewport});await enter(x.page);
  for(const pair of ['USDJPY','EURJPY','GBPJPY']){
   await x.page.locator(`[data-pair="${pair.slice(0,3)}/${pair.slice(3)}"]`).tap();await status(x.page,'実データ（');
   const b=x.expected.get(pair),a=analyze(b.candles);
   assert.equal(await x.page.locator('#price').innerText(),b.candles.at(-1).close.toFixed(3));assert.equal(await x.page.locator('#rsi-value').innerText(),a.rsi.at(-1).toFixed(1));assert.equal(await x.page.locator('#verdict').innerText(),a.verdict);assert.equal(await x.page.locator('#reasons').innerText(),a.reasons.join('\n'));
   assert.equal(await x.page.locator('svg').count(),3);assert.equal(await x.page.locator('#price-chart rect').count(),72);assert.equal(await x.page.locator('#price-chart polyline').count(),2);assert.equal(await x.page.locator('#macd-chart polyline').count(),2);
   assert.ok((await x.page.locator('#source-badge').innerText()).includes('実データ'));assert.ok((await x.page.locator('#sample-notice').innerText()).includes('Twelve Data'));
  }
  assert.equal(await x.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(x.calls,3);
 });
}
test('既定は実データ無効・通信ゼロ、サンプル3通貨×5時間足を維持',async t=>{
 const x=await setup(t,{live:false});assert.ok(await x.page.locator('#live-mode').isDisabled());
 for(const pair of ['USD/JPY','EUR/JPY','GBP/JPY'])for(const tf of ['1m','5m','15m','1h','4h']){await x.page.locator(`[data-pair="${pair}"]`).tap();await x.page.locator(`[data-timeframe="${tf}"]`).tap();assert.equal(await x.page.locator('svg').count(),3);assert.ok((await x.page.locator('#source-badge').innerText()).includes('サンプル'));}
 assert.equal(x.calls,0);
});
test('通信失敗・データ不足は日本語、失敗からサンプルへ無言で切り替えない',async t=>{
 const x=await setup(t);x.setKind('network');await x.page.locator('#live-mode').tap();await status(x.page,'取得エラー');assert.equal(await x.page.locator('#verdict').innerText(),'判定不可');assert.equal(await x.page.locator('svg').count(),0);
 x.setKind('insufficient');await x.page.locator('[data-pair="EUR/JPY"]').tap();await status(x.page,'データ不足');assert.equal(await x.page.locator('#verdict').innerText(),'判定不可');assert.ok((await x.page.locator('#source-badge').innerText()).includes('実データ'));
 await x.page.locator('#sample-mode').tap();assert.ok((await x.page.locator('#sample-notice').innerText()).includes('固定のサンプル'));assert.equal(await x.page.locator('svg').count(),3);
});
test('古いOHLCは参考チャートのみ、売買判定停止',async t=>{
 const x=await setup(t);x.setKind('old');await x.page.locator('#live-mode').tap();await status(x.page,'更新停止');assert.equal(await x.page.locator('#verdict').innerText(),'判定不可');assert.equal(await x.page.locator('svg').count(),3);assert.ok((await x.page.locator('#reasons').innerText()).includes('参考数値'));
});
test('画面表示後の期限切れで判定停止、再取得失敗は前回データを維持',async t=>{
 const x=await setup(t);await enter(x.page);const price=await x.page.locator('#price').innerText();
 await x.page.clock.fastForward(360000);await status(x.page,'更新停止');assert.equal(await x.page.locator('#verdict').innerText(),'判定不可');assert.equal(await x.page.locator('#price').innerText(),price);
 // First HTTP response failed before Worker; retained client data must remain visible.
 await x.page.route('https://mock.fx.test/**',r=>r.fulfill({status:503,json:{error:{code:'MOCK_FAILURE'}},headers:{'Access-Control-Allow-Origin':base}}));
 await x.page.locator('#refresh-data').tap();await status(x.page,'前回取得データ');assert.equal(await x.page.locator('#verdict').innerText(),'判定不可');assert.equal(await x.page.locator('svg').count(),3);
});
test('連続切替：古い通貨の応答と時間足切替後の応答が画面を上書きしない',async t=>{
 const x=await setup(t);x.delay('USDJPY');await x.page.locator('#live-mode').tap();await x.page.waitForFunction(()=>document.getElementById('source-status').textContent.includes('取得中'));await x.waitDelayed();
 await x.page.locator('[data-pair="EUR/JPY"]').tap();await status(x.page,'実データ（');const eurPrice=await x.page.locator('#price').innerText();x.release();await x.page.waitForTimeout(50);assert.equal(await x.page.locator('#price').innerText(),eurPrice);assert.equal(await x.page.locator('#pair-name').innerText(),'EUR / JPY');
 x.delay('GBPJPY');await x.page.locator('[data-pair="GBP/JPY"]').tap();await x.waitDelayed();await x.page.locator('[data-timeframe="1h"]').tap();await status(x.page,'実データ未対応');x.release();await x.page.waitForTimeout(50);assert.equal(await x.page.locator('#verdict').innerText(),'判定不可');assert.equal(await x.page.locator('svg').count(),0);
 await x.page.locator('#sample-mode').tap();await x.page.locator('[data-timeframe="4h"]').tap();assert.ok((await x.page.locator('#analysis-mode').innerText()).includes('中期分析 · 4時間足'));assert.equal(await x.page.locator('svg').count(),3);
});
