import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleData,analyze,TIMEFRAMES} from '../src/analysis.js';
test('3通貨×5時間足の操作で選択・チャート・数値・判定理由を更新',async()=>{
 const ids=new Map();const make=(key,value)=>({dataset:{[key]:value},attrs:{},setAttribute(k,v){this.attrs[k]=v;},addEventListener(_,fn){this.click=fn;}});
 const pairs=['USD/JPY','EUR/JPY','GBP/JPY'].map(p=>make('pair',p));
 const frames=Object.keys(TIMEFRAMES).map(tf=>make('timeframe',tf));
 globalThis.document={getElementById(id){if(!ids.has(id))ids.set(id,{setAttribute(){},addEventListener(){}});return ids.get(id);},querySelectorAll(selector){return selector==='[data-pair]'?pairs:frames;}};
 try{
  await import('../src/app.js');assert.equal(frames.find(b=>b.dataset.timeframe==='1h').attrs['aria-pressed'],'true');
  for(const pair of pairs){pair.click();for(const frame of frames){frame.click();const data=sampleData(pair.dataset.pair,frame.dataset.timeframe),a=analyze(data);
   assert.equal(ids.get('price').textContent,data.at(-1).close.toFixed(3));assert.equal(ids.get('verdict').textContent,a.verdict);assert.equal(ids.get('reasons').textContent,a.reasons.join('\n'));
   assert.equal(pair.attrs['aria-pressed'],'true');assert.equal(frame.attrs['aria-pressed'],'true');assert.equal(pairs.filter(b=>b.attrs['aria-pressed']==='true').length,1);assert.equal(frames.filter(b=>b.attrs['aria-pressed']==='true').length,1);
   assert.ok(ids.get('analysis-mode').textContent.includes(TIMEFRAMES[frame.dataset.timeframe].group));
   for(const id of ['price-chart','rsi-chart','macd-chart']){assert.ok(ids.get(id).innerHTML.includes('<svg'));assert.ok(!/NaN|undefined/.test(ids.get(id).innerHTML));}
   assert.ok(ids.get('data-period').textContent.includes('固定サンプル'));
  }}
 }finally{delete globalThis.document;}
});
