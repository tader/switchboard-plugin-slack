import test from "node:test";
import assert from "node:assert/strict";
import { WebSessionWatch } from "../plugins/slack/lib/web-session-watch.js";
const credentials={kind:"web",teamId:"T123",userId:"U123",accessToken:"xoxc-private012345",cookie:"xoxd-private012345",userAgent:"Fixture"};
const tick=()=>new Promise(r=>setImmediate(r));
async function until(f){for(let n=0;n<500;n++){if(f())return;await tick();}throw Error("Fixture timed out");}
class Socket extends EventTarget{
 closed=0;sent=[];listeners=new Set();
 addEventListener(t,f,o){this.listeners.add(f);super.addEventListener(t,f,o)}
 removeEventListener(t,f,o){this.listeners.delete(f);super.removeEventListener(t,f,o)}
 emit(frame){this.dispatchEvent(new MessageEvent("message",{data:JSON.stringify(frame)}))}
 send(raw){this.sent.push(JSON.parse(raw));}
 close(){this.closed++;this.dispatchEvent(new Event("close"))}
}
function fixture(t,{response,publish,helloTimeoutMs=1000,heartbeatMs=1000,now}={}){
 const sockets=[],batches=[],calls=[];const controller=new AbortController();
 const client={async call(...args){calls.push(args);return response??{team:{id:"T123"},self:{id:"U123"},url:"wss://wss-primary.slack.com/?ticket=PRIVATE"}}};
 const watcher=new WebSessionWatch(client,{createSocket(url,headers){const socket=new Socket();sockets.push({socket,url,headers});return socket;},helloTimeoutMs,heartbeatMs,now});
 const running=watcher.watch({}, {connection:{id:"connection-exact",credentials},signal:controller.signal,publish:async b=>{batches.push(b);await publish?.(b)}});
 running.catch(()=>{});t.after(async()=>{controller.abort();await running.catch(()=>{});await watcher.dispose()});return{watcher,controller,running,sockets,batches,calls};
}
test("web RTM validates identity, uses cookie handshake and publishes metadata only",async t=>{
 const f=fixture(t);await until(()=>f.sockets.length);const {socket,url,headers}=f.sockets[0];assert.equal(headers.cookie,"d="+credentials.cookie);assert.equal(headers.origin,"https://app.slack.com");assert.equal(f.calls[0][1],"rtm.connect");assert.equal(f.calls[0][2].token,credentials.accessToken);
 socket.emit({type:"hello"});socket.emit({type:"message",channel:"CPRIVATE",event_ts:"123.456",text:"PRIVATE BODY",team:"T123"});await until(()=>f.batches.length===2);
 assert.equal(f.batches[0].events[0].event.type,"resync.required");assert.equal(f.batches[1].events[0].event.type,"invalidated");assert(!JSON.stringify(f.batches).includes("PRIVATE"));assert(!JSON.stringify(f.batches).includes("CPRIVATE"));
 f.controller.abort();await f.running;assert.equal(socket.closed,1);assert.equal(socket.listeners.size,0);
});
test("foreign identities and endpoints cannot receive cookie or start a socket",async t=>{
 for(const response of [{team:{id:"TOTHER"},self:{id:"U123"},url:"wss://wss-primary.slack.com/"},{team:{id:"T123"},self:{id:"OTHER"},url:"wss://wss-primary.slack.com/"},...['wss://evil.test/','wss://slack.com.evil.test/','ws://wss-primary.slack.com/','wss://user@wss-primary.slack.com/','wss://wss-primary.slack.com:444/'].map(url=>({team:{id:"T123"},self:{id:"U123"},url}))]){
 const f=fixture(t,{response});await assert.rejects(f.running);assert.equal(f.sockets.length,0);}
});
test("disconnect forces upstream resync on the next watch; replacement URLs are never followed",async t=>{
 const f=fixture(t);await until(()=>f.sockets.length);f.sockets[0].socket.emit({type:"hello"});await until(()=>f.batches.length===1);f.sockets[0].socket.emit({type:"reconnect_url",url:"wss://evil.test/secret"});await assert.rejects(f.running,e=>e.code==="native_socket_closed");assert.equal(f.sockets.length,1);
});
test("revocation stops with terminal authentication failure",async t=>{
 const f=fixture(t);await until(()=>f.sockets.length);f.sockets[0].socket.emit({type:"hello"});f.sockets[0].socket.emit({type:"team_access_revoked"});await assert.rejects(f.running,e=>e.status===401);
});
test("handshake timeout, malformed messages and foreign events close cleanly",async t=>{
 const f=fixture(t,{helloTimeoutMs:10});await assert.rejects(f.running,e=>e.code==="native_hello_timeout");assert.equal(f.sockets[0].socket.closed,1);
 const g=fixture(t);await until(()=>g.sockets.length);g.sockets[0].socket.emit({type:"hello"});g.sockets[0].socket.emit({type:"message",team:"TOTHER"});await assert.rejects(g.running,e=>e.status===401);
});
test("blocked publishing has a bounded receive queue",async t=>{
 let release;const blocked=new Promise(r=>release=r);const f=fixture(t,{publish:()=>blocked});await until(()=>f.sockets.length);const s=f.sockets[0].socket;s.emit({type:"hello"});for(let n=0;n<130;n++)s.emit({type:"message",event_ts:String(n)});release();await assert.rejects(f.running,e=>e.code==="native_receive_overflow");
});
test("OAuth-only credentials remain unsupported without an official app; dispose aborts idle watches",async t=>{
 const watcher=new WebSessionWatch({call(){throw Error("Must not call")}});await assert.rejects(watcher.watch({},{connection:{credentials:{kind:"oauth"}},signal:new AbortController().signal}),e=>e.status===501);
 const f=fixture(t);await until(()=>f.sockets.length);await f.watcher.dispose();await f.running;assert.equal(f.sockets[0].socket.closed,1);
});
