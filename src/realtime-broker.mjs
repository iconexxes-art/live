import { EventEmitter } from 'node:events';

export class MemoryRealtimeBroker {
  constructor(){ this.seq=0; this.events=[]; this.emitter=new EventEmitter(); this.max=5000; }
  async publish(conversationId, envelope){
    const full={...envelope,seq:++this.seq};
    this.events.push({seq:full.seq,conversationId,envelope:full});
    if(this.events.length>this.max)this.events.splice(0,this.events.length-this.max);
    queueMicrotask(()=>this.emitter.emit('event',full));
    return full;
  }
  async replay(lastSeq, accountId, allowed){ return this.events.filter(x=>x.seq>lastSeq && ((x.envelope.accountIds||[]).includes(accountId) || (x.conversationId && allowed.has(x.conversationId)))).map(x=>x.envelope); }
  async currentSeq(){ return this.seq; }
  onEvent(cb){this.emitter.on('event',cb); return ()=>this.emitter.off('event',cb);}
  async close(){}
}

export class PostgresRealtimeBroker {
  constructor(pool){this.pool=pool;this.listener=null;this.listeners=new Set();this.ready=this.init();}
  async init(){
    await this.pool.query(`CREATE SEQUENCE IF NOT EXISTS live_event_seq START 1;\nCREATE TABLE IF NOT EXISTS live_events (seq BIGINT PRIMARY KEY DEFAULT nextval('live_event_seq'), conversation_id TEXT NOT NULL, envelope JSONB NOT NULL, created_at BIGINT NOT NULL);\nCREATE INDEX IF NOT EXISTS live_events_conversation_seq_idx ON live_events(conversation_id,seq);`);
    this.listener=await this.pool.connect();
    await this.listener.query('LISTEN live_events');
    this.listener.on('notification',msg=>{try{const env=JSON.parse(msg.payload);for(const cb of this.listeners)cb(env);}catch{}});
    this.listener.on('error',()=>{});
  }
  async publish(conversationId,envelope){
    await this.ready;
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');
      const {rows}=await client.query(`INSERT INTO live_events(conversation_id,envelope,created_at) VALUES($1,$2,$3) RETURNING seq`,[conversationId,JSON.stringify(envelope),Date.now()]);
      const full={...envelope,seq:Number(rows[0].seq)};
      await client.query('UPDATE live_events SET envelope=$1 WHERE seq=$2',[JSON.stringify(full),Number(rows[0].seq)]);
      await client.query('SELECT pg_notify($1,$2)', ['live_events', JSON.stringify(full)]);
      await client.query('COMMIT');
      return full;
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }
  async replay(lastSeq, accountId, allowed){
    await this.ready;
    const {rows}=await this.pool.query(`SELECT envelope,conversation_id FROM live_events WHERE seq>$1 ORDER BY seq ASC LIMIT 5000`,[lastSeq]);
    return rows.map(r=>r.envelope).filter(e=>((e.accountIds||[]).includes(accountId)) || (e.conversationId && allowed.has(e.conversationId)));
  }
  async currentSeq(){
    await this.ready;
    const {rows}=await this.pool.query(`SELECT COALESCE(MAX(seq),0)::bigint AS seq FROM live_events`); return Number(rows[0].seq);
  }
  onEvent(cb){this.listeners.add(cb);return()=>this.listeners.delete(cb);}
  async close(){try{await this.listener?.query('UNLISTEN live_events');}catch{}this.listener?.release();}
}
