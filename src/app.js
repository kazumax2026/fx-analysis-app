import {sampleData,analyze} from './analysis.js';
const $=id=>document.getElementById(id);
const colors={up:'#41d4af',down:'#f27a91',fast:'#ffbb67',slow:'#79aaff'};
function chart(target,series,{height=150,min,max,candles=null,levels=[]}={}){
 const width=960,left=12,right=72,top=15,bottom=26,n=series[0].values.length;
 const all=series.flatMap(s=>s.values.filter(v=>v!==null));if(candles)all.push(...candles.flatMap(c=>[c.high,c.low]));
 min??=Math.min(...all);max??=Math.max(...all);const pad=(max-min)*.1||.1;if(!levels.length){min-=pad;max+=pad;}const x=i=>left+(i+.5)*(width-left-right)/n,y=v=>top+(max-v)/(max-min)*(height-top-bottom);
 let parts=[];for(let j=0;j<5;j++){const v=min+(max-min)*j/4;parts.push(`<line x1="${left}" x2="${width-right}" y1="${y(v)}" y2="${y(v)}" stroke="#28354a"/><text x="${width-right+10}" y="${y(v)+4}">${v.toFixed(candles?3:1)}</text>`);}
 for(const v of levels)parts.push(`<line x1="${left}" x2="${width-right}" y1="${y(v)}" y2="${y(v)}" stroke="#7990ac" stroke-dasharray="5 5"/><text x="20" y="${y(v)-4}">${v}</text>`);
 if(candles)candles.forEach((c,i)=>{const color=c.close>=c.open?colors.up:colors.down;parts.push(`<line x1="${x(i)}" x2="${x(i)}" y1="${y(c.high)}" y2="${y(c.low)}" stroke="${color}"/><rect x="${x(i)-3}" y="${Math.min(y(c.open),y(c.close))}" width="6" height="${Math.max(1,Math.abs(y(c.open)-y(c.close)))}" fill="${color}"/>`);});
 for(const s of series){if(s.bars){s.values.forEach((v,i)=>parts.push(`<rect x="${x(i)-3}" y="${Math.min(y(0),y(v))}" width="6" height="${Math.max(1,Math.abs(y(v)-y(0)))}" fill="${v>=0?colors.up:colors.down}" opacity=".5"/>`));}else{parts.push(`<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${s.values.map((v,i)=>v===null?'':`${x(i)},${y(v)}`).join(' ')}"/>`);}}
 if(candles)[0,18,36,54,71].forEach(i=>parts.push(`<text x="${x(i)}" y="${height-5}" text-anchor="middle">${new Date(candles[i].time).toISOString().slice(5,16).replace('T',' ')}</text>`));
 $(target).innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${target==='price-chart'?'ローソク足と移動平均線':target==='rsi-chart'?'RSI指標':'MACD指標'}">${parts.join('')}</svg>`;
}
function render(pair){const data=sampleData(pair),a=analyze(data),last=data.at(-1),previous=data.at(-2),delta=last.close-previous.close;const take=v=>v.slice(-72);
 $('pair-name').textContent=pair.replace('/',' / ');$('price').textContent=last.close.toFixed(3);$('change').textContent=`${delta>=0?'+':''}${delta.toFixed(3)} (${(delta/previous.close*100).toFixed(2)}%) 前の足比`;$('change').className=delta>=0?'green':'red';$('verdict').textContent=a.verdict;$('verdict').className=a.verdict==='買い'?'green':a.verdict==='売り'?'red':'';$('rsi-value').textContent=a.rsi.at(-1).toFixed(1);$('rsi-description').textContent=a.rsi.at(-1)>=70?'買われすぎの水準':a.rsi.at(-1)<=30?'売られすぎの水準':'中立の水準';
 chart('price-chart',[{values:take(a.fast),color:colors.fast},{values:take(a.slow),color:colors.slow}],{height:340,candles:take(data)});
 chart('rsi-chart',[{values:take(a.rsi),color:colors.slow}],{height:140,min:0,max:100,levels:[30,70]});
 chart('macd-chart',[{values:take(a.macd.map((v,i)=>v-a.signal[i])),bars:true},{values:take(a.macd),color:colors.fast},{values:take(a.signal),color:colors.slow}],{height:150});
 $('data-period').textContent=`データ期間：${new Date(data[0].time).toISOString().slice(0,16).replace('T',' ')} ～ ${new Date(last.time).toISOString().slice(0,16).replace('T',' ')} UTC（固定サンプル）`;
 document.querySelectorAll('[data-pair]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.pair===pair)));
}
document.querySelectorAll('[data-pair]').forEach(b=>b.addEventListener('click',()=>render(b.dataset.pair)));render('USD/JPY');
