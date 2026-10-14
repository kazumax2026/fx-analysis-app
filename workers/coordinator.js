export class CoordinationError extends Error {
  constructor(status,code,message,retryAfter=0){super(message);Object.assign(this,{status,code,retry:retryAfter});}
}
const unavailable=()=>new CoordinationError(503,'BUDGET_UNAVAILABLE','予算管理が利用できないため取得を停止しました。');
/** Store.transaction(fn) must atomically read/update durable state. Never run network I/O in fn. */
export function createCoordinator({store,now=Date.now,minuteLimit=0,dayLimit=0,cost=1,timeoutMs=10000,cooldownMs=1000}={}){
  for(const n of [minuteLimit,dayLimit,cost,timeoutMs,cooldownMs])if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid coordinator configuration');
  if(!cost||!timeoutMs)throw Error('Invalid coordinator configuration');
  async function tx(fn){try{if(!store?.transaction)throw Error();return await store.transaction(fn);}catch(e){if(e instanceof CoordinationError)throw e;throw unavailable();}}
  async function get(key,loader){
    if(!['USDJPY:5m','EURJPY:5m','GBPJPY:5m'].includes(key))throw new CoordinationError(400,'INVALID_KEY','未対応の取得条件です。');
    const deadline=Date.now()+timeoutMs+2000;
    while(true){
      const action=await tx(s=>{
        if(!s||typeof s!=='object'||Array.isArray(s))throw unavailable();
        s.version??=1;if(s.version!==1)throw unavailable();s.entries??={};s.sequence??=0;
        if(!Number.isSafeInteger(s.sequence)||s.sequence<0||!s.entries||typeof s.entries!=='object'||Array.isArray(s.entries))throw unavailable();
        for(const bucket of [s.minute,s.day])if(bucket&&(!Number.isSafeInteger(bucket.period)||!Number.isSafeInteger(bucket.used)||bucket.used<0))throw unavailable();
        const t=now(),minute=Math.floor(t/60000),day=Math.floor(t/86400000),entry=s.entries[key]??={};
        if(s.lastTime!==undefined&&t<s.lastTime)throw unavailable();s.lastTime=t;
        if(entry.data&&!entry.data.stale&&t<entry.data.expiresAt)return {type:'cache',data:entry.data};
        if(entry.lease&&t<entry.lease.until)return {type:'wait'};
        if(entry.blockUntil&&t<entry.blockUntil)throw new CoordinationError(503,'COOLDOWN','取得停止：再試行までお待ちください。',Math.ceil((entry.blockUntil-t)/1000));
        s.minute=s.minute?.period===minute?s.minute:{period:minute,used:0};s.day=s.day?.period===day?s.day:{period:day,used:0};
        if(s.minute.used+cost>minuteLimit||s.day.used+cost>dayLimit){const reset=s.day.used+cost>dayLimit?(day+1)*86400000:(minute+1)*60000;throw new CoordinationError(429,'GLOBAL_LIMIT','利用予算の上限です。',Math.ceil((reset-t)/1000));}
        // Commit debit BEFORE starting upstream. Crashes and failures never refund it.
        s.minute.used+=cost;s.day.used+=cost;const token=++s.sequence;entry.lease={token,until:t+timeoutMs+100};
        return {type:'load',token};
      });
      if(action.type==='cache')return action.data;
      if(action.type==='wait'){if(Date.now()>deadline)throw new CoordinationError(504,'WAIT_TIMEOUT','共有取得の待機がタイムアウトしました。');await new Promise(r=>setTimeout(r,2));continue;}
      const controller=new AbortController();let timer;
      try{
        const data=await Promise.race([Promise.resolve().then(()=>loader(controller.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new CoordinationError(504,'UPSTREAM_TIMEOUT','取得がタイムアウトしました。'));},timeoutMs);})]);
        if(!data||!Number.isSafeInteger(data.fetchedAt)||!Number.isSafeInteger(data.expiresAt)||data.expiresAt<=data.fetchedAt||typeof data.stale!=='boolean'||!Array.isArray(data.candles))throw new CoordinationError(502,'INVALID_RESULT','取得データが不正です。');
        await tx(s=>{const entry=s.entries[key];if(entry.lease?.token!==action.token)throw new CoordinationError(503,'LEASE_LOST','取得予約が無効になりました。');delete entry.lease;if(!data.stale)entry.data=data;else entry.blockUntil=now()+cooldownMs;});
        return data;
      }catch(error){
        const retained=await tx(s=>{const entry=s.entries[key];if(entry.lease?.token===action.token){delete entry.lease;entry.blockUntil=now()+cooldownMs;}return entry.data&&now()-entry.data.fetchedAt<3600000?entry.data:null;});
        if(retained&&error?.status>=500)return {...retained,stale:true};
        throw error;
      }finally{clearTimeout(timer);}
    }
  }
  return {get,inspect:()=>tx(s=>s)};
}
