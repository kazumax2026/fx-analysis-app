import test from 'node:test';
import assert from 'node:assert/strict';
test('画面初期化と3通貨のタップ切り替えで価格・チャートが更新',async()=>{
 const ids=new Map();const buttons=['USD/JPY','EUR/JPY','GBP/JPY'].map(pair=>({dataset:{pair},attrs:{},setAttribute(k,v){this.attrs[k]=v;},addEventListener(_,fn){this.click=fn;}}));
 globalThis.document={getElementById(id){if(!ids.has(id))ids.set(id,{});return ids.get(id);},querySelectorAll(){return buttons;}};
 try{await import('../src/app.js');const prices=[];for(const button of buttons){button.click();prices.push(ids.get('price').textContent);assert.equal(button.attrs['aria-pressed'],'true');assert.equal(buttons.filter(b=>b.attrs['aria-pressed']==='true').length,1);for(const id of ['price-chart','rsi-chart','macd-chart']){assert.ok(ids.get(id).innerHTML.includes('<svg'));assert.ok(!/NaN|undefined/.test(ids.get(id).innerHTML));}assert.ok(ids.get('data-period').textContent.includes('固定サンプル'));}assert.equal(new Set(prices).size,3);}finally{delete globalThis.document;}
});
