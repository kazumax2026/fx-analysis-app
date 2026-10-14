/** verifyToken MUST cryptographically verify Access JWT before returning claims.
 * No default verifier, no network, no browser service token. Missing configuration denies.
 */
export function createAccessAuthorizer({verifyToken,issuer,audience,subjects=[],now=Date.now,timeoutMs=5000}={}){
 const allowed=new Set(Array.isArray(subjects)?subjects.filter(s=>typeof s==='string'&&s.length):[]);
 let validIssuer=false;try{const url=new URL(issuer);validIssuer=url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash;}catch{}
 return async request=>{
  if(typeof verifyToken!=='function'||!validIssuer||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||typeof audience!=='string'||!audience||!allowed.size)return false;
  const token=request.headers.get('Cf-Access-Jwt-Assertion');if(!token||token.length>16384)return false;
  let timer;
  try{
   const claims=await Promise.race([Promise.resolve().then(()=>verifyToken(token,{issuer,audience})),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Verification timeout')),timeoutMs);})]);
   const time=Math.floor(now()/1000);
   return !!claims&&claims.iss===issuer&&(claims.aud===audience||Array.isArray(claims.aud)&&claims.aud.includes(audience))&&allowed.has(claims.sub)&&Number.isSafeInteger(claims.exp)&&claims.exp>time&&(claims.nbf===undefined||Number.isSafeInteger(claims.nbf)&&claims.nbf<=time);
  }catch{return false;}finally{clearTimeout(timer);}
 };
}
