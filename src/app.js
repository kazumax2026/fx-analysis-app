import {sampleData,analyze,TIMEFRAMES} from './analysis.js';
import {LIVE_CONFIG,createFeed} from './data-source.js';
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
 if(candles)[...new Set([0,Math.floor((n-1)/4),Math.floor((n-1)/2),Math.floor((n-1)*3/4),n-1])].forEach(i=>parts.push(`<text x="${x(i)}" y="${height-5}" text-anchor="${i===0?'start':i===n-1?'end':'middle'}">${new Date(candles[i].time).toISOString().slice(5,16).replace('T',' ')}</text>`));
 $(target).innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${target==='price-chart'?'ローソク足と移動平均線':target==='rsi-chart'?'RSI指標':'MACD指標'}">${parts.join('')}</svg>`;
}
function render(state){
 const {pair,timeframe}=state,isSample=state.mode==='sample',label=isSample?'固定サンプル':'実データ（Twelve Data）';
 $('source-status').textContent=state.message;
 $('price-caption').textContent=isSample?'サンプル最終足の終値 · 円':state.status==='ready'?'実データ最終確定足の終値 · 円':'前回データの参考終値 · 円';
 $('sample-mode').setAttribute('aria-pressed',String(isSample));$('live-mode').setAttribute('aria-pressed',String(!isSample));
 $('refresh-data').disabled=isSample||state.status==='loading'||timeframe!=='5m';
 $('source-badge').textContent=isSample?'● サンプルデータ':'● 実データ / '+(state.status==='ready'?'取得済み':'更新待ち・停止');
 $('sample-notice').textContent=isSample?'ⓘ この画面は固定のサンプルデータです。現在の為替レートではありません。売買注文は行いません。':'ⓘ Twelve Dataの確定5分足です。サインは現在価格や約定価格を保証しません。売買注文は行いません。';
 $('reason-note').textContent=isSample?'確定済みサンプル足から計算。実際の相場・売買推奨ではありません。':'確定足から計算。更新停止時の数値は過去の参考情報です。';
 const data=isSample?sampleData(pair,timeframe):state.data?.candles||[];
 const a=analyze(data),validIndicators=a.verdict!=='判定不可';
 if(!isSample&&state.status!=='ready'){a.verdict='判定不可';a.reasons=[state.message,...(state.data?['以下は前回取得データの参考数値です。',...a.reasons]:[])];}
 const last=data.at(-1),previous=data.at(-2),delta=last&&previous?last.close-previous.close:0;const take=v=>v.slice(-72);
 $('analysis-mode').textContent=TIMEFRAMES[timeframe].group+' · '+TIMEFRAMES[timeframe].label+' · '+label;
 $('chart-period').textContent=TIMEFRAMES[timeframe].label+' · 表示'+Math.min(72,data.length)+'本 / 計算'+data.length+'本 · '+label;
 $('reasons').textContent=a.reasons.join('\n');
 document.querySelectorAll('[data-timeframe]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.timeframe===timeframe)));
 document.querySelectorAll('[data-pair]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.pair===pair)));
 if(!validIndicators||(a.verdict==='判定不可'&&!state.data)){ $('pair-name').textContent=pair.replace('/',' / ');$('price').textContent='—';$('change').textContent='データを確認できません';$('verdict').className='';$('verdict').textContent=a.verdict; $('rsi-value').textContent='—';$('rsi-description').textContent='計算できません';$('data-period').textContent=label+'：判定不可';for(const id of ['price-chart','rsi-chart','macd-chart'])$(id).innerHTML='指標を表示できません';return;}
 $('pair-name').textContent=pair.replace('/',' / ');$('price').textContent=last.close.toFixed(3);$('change').textContent=`${delta>=0?'+':''}${delta.toFixed(3)} (${(delta/previous.close*100).toFixed(2)}%) 前の足比`;$('change').className=delta>=0?'green':'red';$('verdict').textContent=a.verdict;$('verdict').className=a.verdict==='買い'?'green':a.verdict==='売り'?'red':'';$('rsi-value').textContent=a.rsi.at(-1).toFixed(1);$('rsi-description').textContent=a.rsi.at(-1)>=70?'買われすぎの水準':a.rsi.at(-1)<=30?'売られすぎの水準':'中立の水準';
 chart('price-chart',[{values:take(a.fast),color:colors.fast},{values:take(a.slow),color:colors.slow}],{height:340,candles:take(data)});
 chart('rsi-chart',[{values:take(a.rsi),color:colors.slow}],{height:140,min:0,max:100,levels:[30,70]});
 chart('macd-chart',[{values:take(a.macd.map((v,i)=>v-a.signal[i])),bars:true},{values:take(a.macd),color:colors.fast},{values:take(a.signal),color:colors.slow}],{height:150});
 $('data-period').textContent=`データ期間：${new Date(data[0].time).toISOString().slice(0,16).replace('T',' ')} ～ ${new Date(last.time).toISOString().slice(0,16).replace('T',' ')} UTC（${label}）`;
 if(!isSample&&state.data){const d=state.data;$('data-period').textContent+=` / 最終取得：${new Date(d.fetchedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})} JST / 配信遅延：${d.delaySeconds===null?'不明':d.delaySeconds+'秒'} / 市場：${{open:'開場',closed:'休場',unknown:'不明'}[d.marketStatus]}`;}

}
const feed=createFeed({onChange:render});
const select=(pair,timeframe,mode)=>feed.select(pair,timeframe,mode);
document.querySelectorAll('[data-pair]').forEach(b=>b.addEventListener('click',()=>select(b.dataset.pair,feed.snapshot().timeframe)));
document.querySelectorAll('[data-timeframe]').forEach(b=>b.addEventListener('click',()=>select(feed.snapshot().pair,b.dataset.timeframe)));
$('sample-mode').addEventListener('click',()=>select(feed.snapshot().pair,feed.snapshot().timeframe,'sample'));
$('live-mode').disabled=!(LIVE_CONFIG.enabled&&LIVE_CONFIG.licenseApproved);
 if(LIVE_CONFIG.enabled&&LIVE_CONFIG.licenseApproved){$('live-mode').textContent='実データ（5分足）';$('live-policy').textContent='実データは5分足のみ対応。サンプルは全時間足で利用できます。';}
$('live-mode').addEventListener('click',()=>select(feed.snapshot().pair,'5m','live'));
$('refresh-data').addEventListener('click',()=>void feed.refresh());
if(LIVE_CONFIG.enabled&&LIVE_CONFIG.licenseApproved)setInterval(()=>feed.checkExpiry(),15000);
select('USD/JPY','1h','sample');
