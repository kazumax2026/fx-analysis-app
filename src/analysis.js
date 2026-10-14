export function sma(values,period){return values.map((_,i)=>i<period-1?null:values.slice(i-period+1,i+1).reduce((a,b)=>a+b,0)/period);}
export function ema(values,period){const k=2/(period+1);let prev=values[0];return values.map(v=>prev=v*k+prev*(1-k));}
export function rsi(values,period=14){const out=Array(values.length).fill(null);if(values.length<=period)return out;let gain=0,loss=0;for(let i=1;i<=period;i++){const d=values[i]-values[i-1];gain+=Math.max(d,0)/period;loss+=Math.max(-d,0)/period;}const score=()=>gain===0&&loss===0?50:loss===0?100:100-100/(1+gain/loss);out[period]=score();for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];gain=(gain*(period-1)+Math.max(d,0))/period;loss=(loss*(period-1)+Math.max(-d,0))/period;out[i]=score();}return out;}
export const TIMEFRAMES = {
  '1m': {minutes:1,label:'1分足',group:'短期分析'},
  '5m': {minutes:5,label:'5分足',group:'短期分析'},
  '15m': {minutes:15,label:'15分足',group:'短期分析'},
  '1h': {minutes:60,label:'1時間足',group:'中期分析'},
  '4h': {minutes:240,label:'4時間足',group:'中期分析'},
};
export function analyze(candles){
  const unavailable = reason => ({fast:[],slow:[],rsi:[],macd:[],signal:[],verdict:'判定不可',reasons:[reason]});
  if(!Array.isArray(candles)||candles.length<34)return unavailable('データ不足：指標の判定には34本以上の終値が必要です。');
  if(candles.some(c=>!c||!Number.isFinite(c.close)||c.close<=0))return unavailable('計算エラー：終値に無効な数値が含まれています。');
  try {
    const closes=candles.map(c=>c.close),fast=sma(closes,5),slow=sma(closes,20),strength=rsi(closes),a=ema(closes,12),b=ema(closes,26),macd=a.map((v,i)=>v-b[i]),signal=ema(macd,9);
    const i=closes.length-1;
    if(![fast[i],slow[i],strength[i],macd[i],signal[i]].every(Number.isFinite))return unavailable('計算エラー：指標を正常に計算できませんでした。');
    const buy=[fast[i]>slow[i],strength[i]>=50&&strength[i]<70,macd[i]>signal[i]];
    const sell=[fast[i]<slow[i],strength[i]<=50&&strength[i]>30,macd[i]<signal[i]];
    const verdict=buy.every(Boolean)?'買い':sell.every(Boolean)?'売り':'様子見';
    const f=v=>v.toFixed(3);
    const reasons=[
      `MA 5：${f(fast[i])}円 / MA 20：${f(slow[i])}円。短期平均が長期平均を${fast[i]>slow[i]?'上回っています':fast[i]<slow[i]?'下回っています':'上回っても下回ってもいません'}。`,
      `RSI 14：${strength[i].toFixed(1)}。${buy[1]?'買い条件（50以上70未満）を満たします':sell[1]?'売り条件（30超50以下）を満たします':'買い・売りのRSI条件を満たしません'}。`,
      `MACD：${f(macd[i])} / シグナル：${f(signal[i])}。MACDがシグナルを${buy[2]?'上回っています':sell[2]?'下回っています':'上回っても下回ってもいません'}。`,
      verdict==='様子見'?`条件一致：買い ${buy.filter(Boolean).length}/3、売り ${sell.filter(Boolean).length}/3。3条件が揃わないため様子見です。`:`${verdict}の3条件がすべて揃っています。売買や利益を保証するものではありません。`,
    ];
    return {fast,slow,rsi:strength,macd,signal,verdict,reasons};
  }catch{return unavailable('計算エラー：指標計算中にエラーが発生しました。');}
}
const baseCache=new Map();
function minuteData(pair){
  if(baseCache.has(pair))return baseCache.get(pair);
  const index=['USD/JPY','EUR/JPY','GBP/JPY'].indexOf(pair);
  if(index<0)throw new RangeError('未対応の通貨ペアです');
  let seed=42+index*123;
  const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  let price=[149.8,162.3,193.6][index];
  // 5営業日 × 10週。週末を除いた共通の1分足から全時間足を集計。
  const data=[];let time=Date.UTC(2026,0,5);
  while(data.length<72000){
    const day=new Date(time).getUTCDay();
    if(day!==0&&day!==6){
      const open=price;price+=(random()-.5)*.024;
      data.push({time,open,close:price,high:Math.max(open,price)+random()*.01,low:Math.min(open,price)-random()*.01});
    }
    time+=60000;
  }
  baseCache.set(pair,data);return data;
}
export function sampleData(pair,timeframe='1h'){
  const spec=TIMEFRAMES[timeframe];if(!spec)throw new RangeError('未対応の時間足です');
  const base=minuteData(pair),size=spec.minutes,result=[];
  for(let i=0;i<base.length;i+=size){
    const group=base.slice(i,i+size);
    result.push({time:group[0].time,open:group[0].open,close:group.at(-1).close,high:Math.max(...group.map(c=>c.high)),low:Math.min(...group.map(c=>c.low))});
  }
  return result.slice(-300);
}
