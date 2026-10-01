/* LIVE realtime transport.
   WebSocket is primary. SSE/POST remains a compatibility fallback. The wire
   protocol carries a monotonic sequence so reconnects can request replay. */
import { uid } from './model.js';

export class ServerTransport {
  constructor() {
    this.clientId = uid(); this.channel = null; this._eventCb=null; this._stateCb=null; this._state='offline';
    this._queue=[]; this._wsFailures=0; this._lastSeq=Number(sessionStorage.getItem('live:lastSeq')||0);
    this._fallback=false; this._reconnectTimer=null;
  }
  get tabId(){return this.clientId;}
  connect(){ this._fallback=false; this._connectWS(); }
  _connectWS(){
    this._setState('connecting');
    try{
      const proto=location.protocol==='https:'?'wss':'ws';
      this.channel=new WebSocket(`${proto}://${location.host}/ws?clientId=${encodeURIComponent(this.clientId)}&lastSeq=${this._lastSeq}`);
      this.channel.onopen=()=>{this._wsFailures=0;this._setState('live');this.channel.send(JSON.stringify({type:'sync.resume',lastSeq:this._lastSeq}));this._flush();};
      this.channel.onmessage=(e)=>{try{const env=JSON.parse(e.data);if(env.seq)this._rememberSeq(env.seq);if(env.type==='sync.ready'||env.type==='event.ack')return;if(env.tabId===this.clientId)return;this._eventCb?.(env);}catch{}};
      this.channel.onerror=()=>{};
      this.channel.onclose=()=>{this.channel=null;if(this._state!=='unauthorized'){this._wsFailures++;this._setState('connecting');if(this._wsFailures>=3)this._connectSSE();else this._scheduleReconnect();}};
    }catch{this._connectSSE();}
  }
  _connectSSE(){
    if(this._fallback)return; this._fallback=true; this._setState('connecting');
    const clientId=encodeURIComponent(this.clientId); this.channel=new EventSource(`/events?clientId=${clientId}&lastSeq=${this._lastSeq}`);
    this.channel.onopen=()=>{this._setState('live');this._flush();};
    this.channel.onmessage=(e)=>{try{const env=JSON.parse(e.data);if(env.seq)this._rememberSeq(env.seq);if(env.type==='stream.open')return;if(env.tabId===this.clientId)return;this._eventCb?.(env);}catch{}};
    this.channel.onerror=()=>{this._setState('connecting');};
  }
  _scheduleReconnect(){clearTimeout(this._reconnectTimer);this._reconnectTimer=setTimeout(()=>this._connectWS(),Math.min(5000,500*this._wsFailures));}
  _rememberSeq(seq){this._lastSeq=Math.max(this._lastSeq,Number(seq)||0);try{sessionStorage.setItem('live:lastSeq',String(this._lastSeq));}catch{}}
  send(event){
    const cid=uid();
    if(this.channel instanceof WebSocket && this.channel.readyState===WebSocket.OPEN){try{this.channel.send(JSON.stringify({type:'event',cid,event}));return Promise.resolve(true);}catch{}}
    if(this._fallback && this.channel?.readyState===1){return fetch('/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:this.clientId,event})}).then(r=>{if(r.status===401)this._setState('unauthorized');return r.ok;}).catch(()=>{this._setState('offline');return false;});}
    this._queue.push(event);return Promise.resolve(false);
  }
  _flush(){const q=this._queue.splice(0);for(const e of q)this.send(e);}
  onEvent(cb){this._eventCb=cb;} onState(cb){this._stateCb=cb;cb(this._state);}
  _setState(s){if(this._state===s)return;this._state=s;this._stateCb?.(s);}
}

export class BroadcastTransport {
  constructor(roomId){this.roomId=roomId;this.tabId=uid();this.channel=null;this._eventCb=null;this._stateCb=null;this._state='offline';this._minLatency=18;this._maxLatency=55;}
  connect(){try{this.channel=new BroadcastChannel(`live:${this.roomId}`);this.channel.onmessage=e=>this._receive(e.data);this.channel.onmessageerror=()=>this._setState('degraded');this._setState('live');}catch{this.channel=null;this._setState('offline');}}
  send(event){if(!this.channel)return null;const envelope={...event,eid:uid(),tabId:this.tabId,ts:Date.now()};try{this.channel.postMessage(envelope);}catch{this._setState('degraded');}return envelope;}
  onEvent(cb){this._eventCb=cb;} onState(cb){this._stateCb=cb;cb(this._state);}
  _receive(envelope){if(!envelope||envelope.tabId===this.tabId)return;const delay=this._minLatency+Math.random()*(this._maxLatency-this._minLatency);setTimeout(()=>this._eventCb?.(envelope),delay);}
  _setState(s){if(this._state===s)return;this._state=s;this._stateCb?.(s);}
}
