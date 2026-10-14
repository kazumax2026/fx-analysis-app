/** In-memory mock of Durable Object transactional storage. Not a distributed runtime. */
export class MockDurableStorage {
 constructor(){this.data=new Map();this.queue=Promise.resolve();this.available=true;}
 transaction(fn){const task=this.queue.catch(()=>{}).then(async()=>{
  if(!this.available)throw Error('storage unavailable');const copy=structuredClone(this.data);
  const result=await fn({get:async key=>structuredClone(copy.get(key)),put:async(key,value)=>{copy.set(key,structuredClone(value));}});
  if(!this.available)throw Error('storage unavailable');this.data=copy;return structuredClone(result);
 });this.queue=task;return task;}
}
