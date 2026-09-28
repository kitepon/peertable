import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
export async function connect(root, executable=process.env.PEERTABLE_PROBE_CODEX??'codex') {
  const child=spawn(executable,['app-server','--listen','stdio://'],{cwd:root,stdio:['pipe','pipe','pipe']});
  const pending=new Map(),events=[];let seq=0;
  const send=row=>child.stdin.write(JSON.stringify(row)+'\n');
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timeout'));},15000);pending.set(id,{resolve,reject,timer});send({id,method,params});});
  createInterface({input:child.stdout}).on('line',line=>{const row=JSON.parse(line);const p=pending.get(row.id);if(p){pending.delete(row.id);clearTimeout(p.timer);row.error?p.reject(new Error(JSON.stringify(row.error))):p.resolve(row.result);}else if(row.method)events.push(row);});
  child.stderr.on('data',()=>{});
  child.on('error',e=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(e);}pending.clear();});
  await request('initialize',{clientInfo:{name:'peertable_native_probe',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
  return {request,events,close:async()=>{const closed=new Promise(r=>child.once('close',r));child.stdin.end();const timer=setTimeout(()=>child.kill('SIGKILL'),2000);await closed;clearTimeout(timer);}};
}
