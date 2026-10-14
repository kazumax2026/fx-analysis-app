// Public configuration only. No credentials belong in the browser.
// Keep both flags false until licensing and Workers security have been reviewed.
export const LIVE_CONFIG = Object.freeze({enabled:false,licenseApproved:false,endpoint:''});
export const PAIRS = ['USD/JPY','EUR/JPY','GBP/JPY'];
export class DataError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
export function normalizeResponse(body,pair,now=Date.now()){
  if(!body||body.schemaVersion!==1||body.source!=='twelve-data'||body.pair!==pair||body.timeframe!=='5m')throw new DataError('INVALID','取得エラー：応答の通貨・時間足・形式が一致しません。');
  const {fetchedAt,expiresAt,stale,marketStatus}=body;
  if(!Number.isSafeInteger(fetchedAt)||!Number.isSafeInteger(expiresAt)||fetchedAt>now+60000||expiresAt<=fetchedAt||expiresAt-fetchedAt>600000||typeof stale!=='boolean'||!['open','closed','unknown'].includes(marketStatus))throw new DataError('INVALID','取得エラー：更新時刻や状態が不正です。');
  if(!Array.isArray(body.candles)||body.candles.length>1000)throw new DataError('INVALID','取得エラー：OHLC配列を受け取れませんでした。');
  let previous=-Infinity;
  const candles=body.candles.map(c=>{
    if(!c||!Number.isSafeInteger(c.time)||c.time<0||c.time%300000!==0||c.time<=previous||c.time+300000>fetchedAt||c.complete!==true||!['open','high','low','close'].every(k=>Number.isFinite(c[k])&&c[k]>0)||c.high<Math.max(c.open,c.close)||c.low>Math.min(c.open,c.close)||c.low>c.high)throw new DataError('INVALID','取得エラー：OHLCの数値・時刻・確定状態が不正です。');
    previous=c.time;return {...c};
  });
  if(candles.length<34)throw new DataError('INSUFFICIENT','データ不足：判定には確定した5分足が34本以上必要です。');
  return {candles: candles.slice(-300),fetchedAt,expiresAt,marketStatus,stale:stale||now>=expiresAt,source:'twelve-data',delaySeconds:Number.isFinite(body.delaySeconds)&&body.delaySeconds>=0?body.delaySeconds:null};
}
export async function fetchCandles(pair,{config=LIVE_CONFIG,fetchImpl=globalThis.fetch,signal,now=Date.now,timeoutMs=10000}={}){
  if(!config.enabled||!config.licenseApproved)throw new DataError('DISABLED','実データ接続は無効です。利用許諾の確認が必要です。');
  if(!PAIRS.includes(pair))throw new DataError('INVALID','未対応の通貨ペアです。');
  let url;try{url=new URL(config.endpoint);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error();}catch{throw new DataError('CONFIG','取得エラー：接続先が設定されていません。');}
  url.searchParams.set('pair',pair.replace('/',''));url.searchParams.set('timeframe','5m');
  const controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  try{
    const response=await fetchImpl(url,{method:'GET',signal:controller.signal,credentials:'omit',cache:'no-store',headers:{Accept:'application/json'}});
    if(!response.ok)throw new DataError('HTTP',response.status===429?'取得エラー：利用回数の上限です。時間をおいて再試行してください。':response.status===401||response.status===403?'取得エラー：APIへのアクセスが許可されていません。':'取得エラー：データ配信サービスに接続できません。');
    let body;try{body=await response.json();}catch{throw new DataError('INVALID','取得エラー：JSONを読み取れませんでした。');}
    return normalizeResponse(body,pair,now());
  }catch(error){if(signal?.aborted)throw new DataError('CANCELLED','取得を中止しました。');if(error instanceof DataError)throw error;throw new DataError('NETWORK',timedOut?'取得エラー：通信がタイムアウトしました。':'取得エラー：通信に失敗しました。');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
// State is keyed by pair/timeframe. Late responses must never replace a new selection.
export function createFeed({config=LIVE_CONFIG,fetcher=fetchCandles,onChange=()=>{},now=Date.now}={}){
  let state={mode:'sample',pair:'USD/JPY',timeframe:'1h',status:'sample',data:null,message:'固定サンプルを表示しています。'},revision=0,controller;
  const cache=new Map();const emit=()=>onChange({...state});
  const cancel=()=>{revision++;controller?.abort();};
  const enabled=()=>config.enabled&&config.licenseApproved;
  const key=()=>state.pair;
  async function refresh(){
    if(state.mode!=='live'||state.timeframe!=='5m'||!enabled())return;
    cancel();const ticket=revision;controller=new AbortController();state.status='loading';state.message='実データを取得中です。';emit();
    try{
      const result=await fetcher(state.pair,{config,signal:controller.signal,now});
      if(ticket!==revision)return;
      cache.set(key(),result);state.data=result;state.status=result.stale?'stopped':'ready';state.message=result.stale?'更新停止：取得データの更新期限が過ぎています。':'実データ（Twelve Data・確定5分足）';
    }catch(error){if(ticket!==revision)return;state.data=cache.get(key())||null;state.status=state.data?'stopped':'error';state.message=(state.data?'更新停止：前回取得データを表示しています。 ':'')+(error instanceof DataError?error.message:'取得エラー：通信に失敗しました。');}
    emit();
  }
  function select(pair,timeframe,mode=state.mode){
    cancel();state={mode:mode==='live'&&enabled()?'live':'sample',pair,timeframe,status:'sample',data:null,message:'固定サンプルを表示しています。'};
    if(state.mode==='live'&&timeframe!=='5m'){state.status='unsupported';state.message='実データ未対応：現在は5分足のみです。サンプルへ切り替えてください。';emit();return;}
    if(state.mode==='live'){state.data=cache.get(key())||null;void refresh();}else emit();
  }
  function checkExpiry(){if(state.mode==='live'&&state.data&&state.status==='ready'&&now()>=state.data.expiresAt){state.status='stopped';state.message='更新停止：更新期限が過ぎました。再取得してください。';emit();}}
  return {select,refresh,checkExpiry,snapshot:()=>({...state}),dispose:cancel};
}
