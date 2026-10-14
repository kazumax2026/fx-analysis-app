/** verifyToken MUST cryptographically verify Access JWT before returning claims.
 * No default verifier, no network, no browser service token. Missing configuration denies.
 */
export function createAccessAuthorizer({verifyToken,issuer,audience,subjects=[],now=Date.now}={}){
 const allowed=new Set(subjects);
 return async request=>{
  if(typeof verifyToken!=='function'||typeof issuer!=='string'||!issuer.startsWith('https://')||typeof audience!=='string'||!audience||!allowed.size)return false;
  const token=request.headers.get('Cf-Access-Jwt-Assertion');if(!token||token.length>16384)return false;
  try{
   const claims=await verifyToken(token,{issuer,audience});
   const time=Math.floor(now()/1000);
   return !!claims&&claims.iss===issuer&&(claims.aud===audience||Array.isArray(claims.aud)&&claims.aud.includes(audience))&&allowed.has(claims.sub)&&Number.isSafeInteger(claims.exp)&&claims.exp>time&&(claims.nbf===undefined||Number.isSafeInteger(claims.nbf)&&claims.nbf<=time);
  }catch{return false;}
 };
}
