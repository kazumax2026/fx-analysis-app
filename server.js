import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd();
http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    const allowed=['index.html','styles.css','src/app.js','src/analysis.js'];
    if(!allowed.includes(path.relative(root,file))){res.writeHead(404);return res.end('Not found');}
    const body=await readFile(file);
    res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html; charset=utf-8'});res.end(body);
  }catch{res.writeHead(404);res.end('Not found');}
}).listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('FX dashboard running on port '+(process.env.PORT||3000)));
