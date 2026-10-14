import {CoordinationError} from './coordinator.js';
const SYMBOLS={USDJPY:'USD/JPY',EURJPY:'EUR/JPY',GBPJPY:'GBP/JPY'};
const STEP=300000,SETTLE=15000,RETAIN=3600;
class ApiError extends Error {
  constructor(status,code,message,retry=0){super(message);Object.assign(this,{status,code,retry});}
}
const invalid=()=>new ApiError(502,'INVALID_UPSTREAM','配信データの形式・OHLC・UTC時刻が不正です。');
function utcTime(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))throw invalid();
  const time=Date.parse(value.replace(' ','T')+'Z');
  if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,19).replace('T',' ')!==value||time%STEP!==0)throw invalid();
  return time;
}
function price(value){
  if(typeof value!=='string'||!/^\d+(?:\.\d+)?$/.test(value))throw invalid();
  const result=Number(value);if(!Number.isFinite(result)||result<=0)throw invalid();return result;
}
export function normalizeTwelveData(body,symbol,fetchedAt){
  if(body?.status==='error')throw new ApiError(body.code===429?429:502,'UPSTREAM_ERROR',body.code===429?'配信サービスの利用上限です。':'配信サービスが取得エラーを返しました。',body.code===429?60:0);
  if(body?.meta?.symbol!==symbol||body.meta.interval!=='5min'||body.meta.exchange_timezone!=='UTC'||!Array.isArray(body.values)||body.values.length>1000)throw invalid();
  const seen=new Set(),candles=[];
  for(const row of body.values){
    const time=utcTime(row?.datetime),open=price(row.open),high=price(row.high),low=price(row.low),close=price(row.close);
    if(time<0||time>fetchedAt||seen.has(time)||high<Math.max(open,close)||low>Math.min(open,close)||low>high)throw invalid();
    seen.add(time);
    // Exclude still forming bars and give upstream 15 seconds to settle.
    if(time+STEP+SETTLE<=fetchedAt)candles.push({time,open,high,low,close,complete:true});
  }
  candles.sort((a,b)=>a.time-b.time);
  if(candles.length<34)throw new ApiError(502,'INSUFFICIENT_DATA','データ不足：確定した5分足が34本以上必要です。');
  // No trading calendar is available. Do not assert that an old quote is a live quote.
  const stale=fetchedAt-candles.at(-1).time-STEP>2*STEP;
  return {schemaVersion:1,source:'twelve-data',pair:symbol,timeframe:'5m',fetchedAt,
    expiresAt:Math.floor((fetchedAt-SETTLE)/STEP)*STEP+STEP+SETTLE,
    stale,marketStatus:'unknown',delaySeconds:null,candles:candles.slice(-300)};
}
/** Authorization and global budget hooks must be implemented before enabling production. */
export function createWorker({coordinator=null,mockSource=null,fetchImpl=globalThis.fetch,now=Date.now,cache=null,authorize=null,consumeBudget=null,perIpLimit=30,timeoutMs=10000}={}){
  if(!Number.isInteger(perIpLimit)||perIpLimit<1)throw new Error('Invalid per-IP limit');
  const inflight=new Map(),clients=new Map();
  const json=(body,status=200,extra={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra}});
  const keyFor=pair=>new Request(`https://fx-compass-api.invalid/cache/v1/${pair}/5m`);
  async function readCache(pair){
    try{const result=await (cache||globalThis.caches?.default)?.match(keyFor(pair));return result?await result.json():null;}catch{return null;}
  }
  async function load(pair,env){
    if(inflight.has(pair))return inflight.get(pair);
    const pending=(async()=>{
      const retrieve=async signal=>{
      const budget=coordinator?{allowed:true}:await consumeBudget({pair,timeframe:'5m',env});
      if(budget?.allowed!==true)throw new ApiError(429,'GLOBAL_LIMIT','利用回数の上限です。時間をおいて再試行してください。',Math.max(1,Math.min(86400,Number(budget?.retryAfter)||60)));
      if(mockSource){try{return normalizeTwelveData(await mockSource({pair,symbol:SYMBOLS[pair],signal}),SYMBOLS[pair],now());}catch(e){if(e instanceof ApiError)throw e;throw new ApiError(502,'MOCK_NETWORK','モック通信に失敗しました。');}}
      const url=new URL('https://api.twelvedata.com/time_series');
      for(const [name,value] of Object.entries({symbol:SYMBOLS[pair],interval:'5min',outputsize:'302',timezone:'UTC',format:'JSON'}))url.searchParams.set(name,value);
      const controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(()=>controller.abort(),timeoutMs);
      let body;
      try{
        const response=await fetchImpl(url,{headers:{Authorization:`apikey ${env.TWELVE_DATA_API_KEY}`},signal:controller.signal,redirect:'error'});
        if(!response.ok)throw new ApiError(response.status===429?429:502,'UPSTREAM_HTTP',response.status===429?'配信サービスの利用上限です。':'配信サービスに接続できません。',response.status===429?60:0);
        try{body=await response.json();}catch(error){if(controller.signal.aborted)throw error;throw invalid();}
      }catch(error){if(error instanceof ApiError)throw error;throw new ApiError(controller.signal.aborted?504:502,'UPSTREAM_NETWORK',controller.signal.aborted?'配信サービスへの通信がタイムアウトしました。':'配信サービスとの通信に失敗しました。');}
      finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
      const result=normalizeTwelveData(body,SYMBOLS[pair],now());
      // Never overwrite a good retained history with an already stale upstream response.
      if(!coordinator&&!result.stale)try{await (cache||globalThis.caches?.default)?.put(keyFor(pair),new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json','Cache-Control':`max-age=${RETAIN}`}}));}catch{/* Successful validated data is still usable if cache storage fails. */}
      return result;
      };
      try{return coordinator?await coordinator.get(pair+':5m',retrieve):await retrieve();}
      catch(e){if(e instanceof CoordinationError)throw new ApiError(e.status,e.code,e.message,e.retry);throw e;}
    })();
    inflight.set(pair,pending);try{return await pending;}finally{inflight.delete(pair);}
  }
  return {async fetch(request,env={}){
    const url=new URL(request.url),origin=request.headers.get('Origin');
    const cors=origin&&origin===env.ALLOWED_ORIGIN?{'Access-Control-Allow-Origin':origin,'Vary':'Origin'}:{};
    try{
      if(url.pathname!=='/v1/candles')throw new ApiError(404,'NOT_FOUND','該当するAPIはありません。');
      if(env.PUBLIC_OHLC_ENABLED!=='true'||env.LICENSE_APPROVED!=='true')throw new ApiError(403,'DISABLED','公開OHLC取得は無効です。利用許諾の確認が必要です。');
      if(origin&&origin!==env.ALLOWED_ORIGIN)throw new ApiError(403,'ORIGIN_DENIED','このサイトからのアクセスは許可されていません。');
      if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...cors,'Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Accept','Cache-Control':'no-store'}});
      if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED','GETのみ利用できます。');
      const pair=url.searchParams.get('pair');
      if(!Object.hasOwn(SYMBOLS,pair)||url.searchParams.get('timeframe')!=='5m'||[...url.searchParams.keys()].some(k=>!['pair','timeframe'].includes(k))||url.searchParams.getAll('pair').length!==1||url.searchParams.getAll('timeframe').length!==1)throw new ApiError(400,'INVALID_QUERY','3通貨の5分足のみ対応しています。');
      if(typeof authorize!=='function'||(!coordinator&&typeof consumeBudget!=='function'))throw new ApiError(503,'SECURITY_NOT_CONFIGURED','認証・全体利用上限管理が未設定です。');
      if(await authorize(request,env)!==true)throw new ApiError(401,'UNAUTHORIZED','APIへのアクセスが許可されていません。');
      const minute=Math.floor(now()/60000),ip=request.headers.get('CF-Connecting-IP')||'unknown';
      for(const [id,entry] of clients)if(entry.minute!==minute)clients.delete(id);
      if(!clients.has(ip)&&clients.size>=10000)throw new ApiError(429,'LOCAL_LIMIT','利用上限です。時間をおいて再試行してください。',60);
      const entry=clients.get(ip)||{minute,count:0};entry.count++;clients.set(ip,entry);
      if(entry.count>perIpLimit)throw new ApiError(429,'LOCAL_LIMIT','利用回数の上限です。時間をおいて再試行してください。',60);
      if(!mockSource&&(typeof env.TWELVE_DATA_API_KEY!=='string'||!env.TWELVE_DATA_API_KEY.trim()))throw new ApiError(503,'SECRET_NOT_CONFIGURED','配信サービスの認証設定がありません。');
      const cached=coordinator?null:await readCache(pair);
      const usable=cached&&cached.schemaVersion===1&&cached.pair===SYMBOLS[pair]&&Array.isArray(cached.candles)&&now()-cached.fetchedAt<RETAIN*1000;
      if(usable&&!cached.stale&&now()<cached.expiresAt)return json(cached,200,cors);
      try{return json(await load(pair,env),200,cors);}
      catch(error){if(usable&&error instanceof ApiError&&error.status>=500)return json({...cached,stale:true},200,cors);throw error;}
    }catch(error){const safe=error instanceof ApiError?error:new ApiError(503,'INTERNAL_ERROR','APIの処理に失敗しました。');return json({error:{code:safe.code,message:safe.message}},safe.status,{...cors,...(safe.retry?{'Retry-After':String(safe.retry)}:{})});}
  }};
}
// Intentionally fail closed: default entry has no production auth/global-budget adapters.
export default createWorker();
