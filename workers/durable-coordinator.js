import {createCoordinator,CoordinationError} from './coordinator.js';
import {normalizeTwelveData} from './fx-compass-api.js';
import {normalizeResponse} from '../src/data-source.js';
const PAIRS={USDJPY:'USD/JPY',EURJPY:'EUR/JPY',GBPJPY:'GBP/JPY'};
const STORAGE_KEY='fx-budget-state-v1';
const INITIALIZED_KEY='fx-budget-initialized-v1';
/** Cloudflare storage adapter: network I/O stays outside the atomic transaction. */
export function durableStore(storage){
 return {transaction:fn=>storage.transaction(async tx=>{
  const saved=await tx.get(STORAGE_KEY),initialized=await tx.get(INITIALIZED_KEY);
  // Both absent is a new object. Any partial/unknown initialized state fails closed.
  const fresh=saved===undefined&&initialized===undefined;
  if(!fresh&&(initialized!==1||!saved||typeof saved!=='object'||Array.isArray(saved)||Object.keys(saved).length===0))throw new CoordinationError(503,'BUDGET_UNAVAILABLE','初期化済み予算状態が欠落・破損しています。');
  const state=saved===undefined?{}:structuredClone(saved),result=fn(state);
  if(result instanceof Promise)throw new CoordinationError(503,'INVALID_TRANSACTION','予算処理が不正です。');
  if(Object.keys(state).length){
   await tx.put(STORAGE_KEY,state);
   // The marker and first budget debit commit atomically in this same transaction.
   if(fresh)await tx.put(INITIALIZED_KEY,1);
  }
  return result;
 })};
}
// Allowlist every level. Never forward arbitrary cached/auth/internal properties.
function contractResponse(body,pair,now){
 let checked;try{checked=normalizeResponse(body,pair,now);}catch{throw new CoordinationError(503,'INVALID_RESPONSE','共有管理先の応答が不正です。');}
 return {schemaVersion:1,source:'twelve-data',pair,timeframe:'5m',
  fetchedAt:checked.fetchedAt,expiresAt:checked.expiresAt,stale:checked.stale,
  marketStatus:checked.marketStatus,delaySeconds:checked.delaySeconds,
  candles:checked.candles.map(c=>({time:c.time,open:c.open,high:c.high,low:c.low,close:c.close,complete:true}))};
}
function limit(value){if(value===undefined)return 0;if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw Error('Invalid budget configuration');return Number(value);}
/** Factory injection is for tests. The default class has no upstream source. */
export function durableClass({mockSource=null,now=Date.now,timeoutMs=10000}={}){
 return class FxBudgetCoordinator {
  constructor(ctx,env){this.ctx=ctx;this.env=env;}
  async fetch(request){
   const json=(body,status=200,headers={})=>Response.json(body,{status,headers:{'Cache-Control':'no-store',...headers}});
   try{
    if(this.env.PUBLIC_OHLC_ENABLED!=='true'||this.env.LICENSE_APPROVED!=='true')return json({error:{code:'DISABLED',message:'公開OHLC取得は無効です。'}},403);
    const url=new URL(request.url),pair=url.searchParams.get('pair');
    if(request.method!=='GET'||url.pathname!=='/internal/candles'||!Object.hasOwn(PAIRS,pair)||url.searchParams.get('timeframe')!=='5m'||url.searchParams.getAll('pair').length!==1||url.searchParams.getAll('timeframe').length!==1||[...url.searchParams.keys()].some(k=>!['pair','timeframe'].includes(k)))return json({error:{code:'INVALID_QUERY',message:'取得条件が不正です。'}},400);
    if(!mockSource)return json({error:{code:'SOURCE_NOT_CONFIGURED',message:'配信元は未接続です。'}},503);
    const coordinator=createCoordinator({store:durableStore(this.ctx.storage),now,timeoutMs,minuteLimit:limit(this.env.MINUTE_BUDGET),dayLimit:limit(this.env.DAY_BUDGET)});
    const data=await coordinator.get(pair+':5m',async signal=>{
     let body;try{body=await mockSource({pair,symbol:PAIRS[pair],signal});}catch{throw new CoordinationError(502,'MOCK_NETWORK','モック通信に失敗しました。');}
     return normalizeTwelveData(body,PAIRS[pair],now());
    });
    return json(contractResponse(data,PAIRS[pair],now()));
   }catch(e){const known=e instanceof CoordinationError||Number.isInteger(e?.status)&&['INVALID_UPSTREAM','INSUFFICIENT_DATA','UPSTREAM_ERROR'].includes(e.code);return json({error:{code:known?e.code:'BUDGET_UNAVAILABLE',message:known?e.message:'予算管理が利用できないため取得を停止しました。'}},known?e.status:503,known&&e.retry?{'Retry-After':String(e.retry)}:{});}
  }
 };
}
export const FxBudgetCoordinator=durableClass();
/** Every region/pair must resolve to this SAME object in a shared namespace. */
export function durableClient(binding,{timeoutMs=15000,now=Date.now}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw Error('Invalid timeout');
 return {ownsUpstream:true,async get(key){
  if(!['USDJPY:5m','EURJPY:5m','GBPJPY:5m'].includes(key))throw new CoordinationError(400,'INVALID_KEY','取得条件が不正です。');
  const controller=new AbortController();let timer;
  const operation=async()=>{
   const stub=binding.get(binding.idFromName('fx-compass-primary-budget-v1'));
   const response=await stub.fetch(`https://coordinator.internal/internal/candles?pair=${key.split(':')[0]}&timeframe=5m`,{signal:controller.signal});
   const body=await response.json();
   if(!response.ok){const codes=['GLOBAL_LIMIT','BUDGET_UNAVAILABLE','DISABLED','SOURCE_NOT_CONFIGURED','UPSTREAM_TIMEOUT','MOCK_NETWORK','INSUFFICIENT_DATA','INVALID_UPSTREAM','INVALID_RESPONSE','COOLDOWN'];const code=codes.includes(body?.error?.code)?body.error.code:'BUDGET_UNAVAILABLE';const retry=Number(response.headers.get('Retry-After'));throw new CoordinationError(response.status,code,'共有予算管理が取得を拒否しました。',Number.isFinite(retry)?Math.min(86400,Math.max(0,retry)):0);}
   // Validate even cached responses; never trust a malformed success body.
   try{return contractResponse(body,PAIRS[key.split(':')[0]],now());}catch{throw new CoordinationError(503,'INVALID_RESPONSE','共有管理先の応答が不正です。');}
  };
  try{return await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new CoordinationError(504,'COORDINATOR_TIMEOUT','共有管理先の応答がタイムアウトしました。'));},timeoutMs);})]);}
  catch(e){if(e instanceof CoordinationError)throw e;throw new CoordinationError(503,'BUDGET_UNAVAILABLE','共有予算管理へ接続できません。');}
  finally{clearTimeout(timer);}
 }};
}
