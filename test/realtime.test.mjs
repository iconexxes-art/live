import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';

let root, child, base, cookie;
async function req(path, options={}) { const headers=new Headers(options.headers||{}); if(cookie)headers.set('Cookie',cookie); if(options.method&&options.method!=='GET')headers.set('Origin',base); const r=await fetch(base+path,{...options,headers}); const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];return r; }
function wsFrame(obj){const p=Buffer.from(JSON.stringify(obj));const mask=Buffer.from([7,11,19,23]);const m=Buffer.alloc(2);let head;if(p.length<126){m[0]=0x81;m[1]=0x80|p.length;head=m;}else throw new Error('test payload too large');const out=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)out[i]=p[i]^mask[i%4];return Buffer.concat([head,mask,out]);}
function openRawWS(){return new Promise((resolve,reject)=>{const s=createConnection(5189,'127.0.0.1');let buf='';const key=Buffer.from('live-test-key-123').toString('base64');s.on('connect',()=>s.write(`GET /ws?clientId=rawtest01 HTTP/1.1\r\nHost: 127.0.0.1:5189\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nCookie: ${cookie}\r\n\r\n`));s.on('data',d=>{buf+=d.toString('binary');if(buf.includes('\r\n\r\n')){s.removeAllListeners('data');resolve({s,header:buf});}});s.on('error',reject);setTimeout(()=>reject(new Error('ws handshake timeout')),2000);});}
before(async()=>{root=mkdtempSync(join(tmpdir(),'live-ws-'));cpSync(new URL('../',import.meta.url),root,{recursive:true});for(const f of ['accounts.json','conversations.json','sessions.json','conv-meta.json','requests.json'])writeFileSync(join(root,'data',f),f==='sessions.json'?'{}':f==='conversations.json'||f==='conv-meta.json'?'{}':'[]');child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'5189',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});base='http://127.0.0.1:5189';await new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('server timeout')),5000);child.stdout.on('data',d=>{if(String(d).includes('hardened server')){clearTimeout(t);res();}});child.on('error',rej);});const r=await req('/api/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'rawuser',name:'Raw',password:'strong-pass-123'})});assert.equal(r.status,200);});
after(()=>{child?.kill('SIGTERM');if(root)rmSync(root,{recursive:true,force:true});});

test('authenticated WebSocket upgrade succeeds and accepts a masked event frame',async()=>{const {s,header}=await openRawWS();assert.match(header,/101 Switching Protocols/);s.write(wsFrame({type:'sync.resume',lastSeq:0}));await new Promise(r=>setTimeout(r,50));s.end();});
