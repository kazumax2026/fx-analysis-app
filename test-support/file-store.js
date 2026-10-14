import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
// Test adapter only. Serializes all instances using the same path within ONE Node process.
// Atomic rename protects snapshots. This is not a production distributed lock.
const queues=new Map();
export class FileStore {
  constructor(path){this.path=resolve(path);this.available=true;}
  async transaction(fn){
    const prior=queues.get(this.path)||Promise.resolve();
    const task=prior.catch(()=>{}).then(async()=>{
      if(!this.available)throw Error('Test store unavailable');
      const state=JSON.parse(await readFile(this.path,'utf8')); // Missing/corrupt state must fail closed.
      const result=fn(state);if(result instanceof Promise)throw Error('Transaction callback must be synchronous');
      await mkdir(dirname(this.path),{recursive:true});await writeFile(this.path+'.tmp',JSON.stringify(state));await rename(this.path+'.tmp',this.path);return structuredClone(result);
    });
    queues.set(this.path,task);try{return await task;}finally{if(queues.get(this.path)===task)queues.delete(this.path);}
  }
}
