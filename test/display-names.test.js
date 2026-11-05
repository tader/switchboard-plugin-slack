import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisplayNames } from '../plugins/slack/lib/display-names.js';
const context = (team='T1') => ({connection:{id:'one',credentials:{teamId:team,userId:'U12345678'}},signal:new AbortController().signal});
const id='U044LUL965V';
test('display name precedence, exact identity, account cache and expiry',async()=>{
 let now=0,calls=0;
 const n=new DisplayNames({now:()=>now});
 const lookup=async user=>{calls++;return {id:user,profile:{display_name:'Daan',real_name:'Daan Heikens'},name:'daan.heikens'}};
 assert.equal(await n.resolve(context(),id,lookup),'Daan');
 assert.equal(await n.resolve(context(),id,lookup),'Daan');assert.equal(calls,1);
 await n.resolve(context('T2'),id,lookup);assert.equal(calls,2);
 now=3600001;await n.resolve(context(),id,lookup);assert.equal(calls,3);
 assert.equal(await n.resolve(context(),'U99999999',async()=>({id:'U00000000',name:'Wrong'})),null);
});
test('negative results retry after five minutes; auth and rate errors propagate',async()=>{
 let now=0,calls=0;const n=new DisplayNames({now:()=>now});
 const lookup=async()=>{calls++;throw {code:'not_found'}};
 await n.resolve(context(),id,lookup);await n.resolve(context(),id,lookup);assert.equal(calls,1);
 now=300001;await n.resolve(context(),id,lookup);assert.equal(calls,2);
 for(const code of ['authentication_required','rate_limited']) await assert.rejects(n.resolve(context(), 'U99999999',async()=>{throw Object.assign(new Error(code),{code})}),e=>e.code===code);
});
test('concurrent lookups deduplicate and stay at four active requests',async()=>{
 const n=new DisplayNames();let active=0,max=0,calls=0;
 const lookup=async id=>{calls++;active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,2));active--;return {id,name:id}};
 await Promise.all([...Array(20)].map((_,i)=>n.resolve(context(),`U0000000${i%10}`,lookup)));
 assert.equal(calls,10);assert.equal(max,4);
});
import { createMessaging } from '../plugins/slack/lib/messaging.js';
import Ajv from 'ajv';
import { messagingOperations } from '../plugins/slack/lib/messaging-schema.js';
const ajv = new Ajv({strict:false});
function contractContext(overrides={}) {
 const ctx=context();ctx.connection.credentials.kind='web';ctx.connection.config={access:'read'};
 const calls=[];
 ctx.request=async input=>{
  const u=new URL(input.url,'http://fixture');calls.push(u);
  let data;
  if(u.pathname==='/users/info') data={id:u.searchParams.get('user'),profile:{display_name:'Daan'}};
  else if(u.pathname==='/conversations') data={items:[{id:'D12345678',is_im:true,user:id},{id:'C12345678',name:'channel'}]};
  else if(u.pathname==='/conversation')data={id:'C12345678',name:'channel'};
  else if(u.pathname==='/messages'||u.pathname==='/thread')data={items:[{ts:'1700000000.000001',user:id,text:'Hi',thread_ts:'1700000000.000001'},{ts:'1700000001.000001',bot_id:'B12345678',bot_profile:{name:'Build bot'},text:'Done'}]};
  else if(u.pathname==='/message')data={ts:'1700000000.000001',user:id,text:'Hi'};
  else throw Error(u.pathname);
  const override=overrides[u.pathname];if(override)data=override;
  return new Response(JSON.stringify(data),{status:data.error?.status||200});
 };
 return {ctx,calls};
}
test('contract reads show names in DMs and threads while retaining IDs and named channels',async()=>{
 const api=createMessaging('/tmp/slack-display-test'),{ctx,calls}=contractContext();
 const list=await api.operations['messaging.conversations.list'].invoke({},ctx);
 assert.equal(list.items[0].title,'Daan');assert.equal(list.items[1].title,'channel');
 const messages=await api.operations['messaging.messages.list'].invoke({conversationId:'C12345678',threadId:'1700000000.000001'},ctx);
 assert.equal(messages.items[0].authorId,id);assert.equal(messages.items[0].authorDisplayName,'Daan');
 assert.equal(messages.items[1].authorDisplayName,'Build bot');
 assert.equal(calls.filter(u=>u.pathname==='/users/info').length,1);
 const validate=ajv.compile(messagingOperations['messaging.messages.list'].outputSchema);assert.ok(validate(messages),JSON.stringify(validate.errors));
 const exact=await api.operations['messaging.messages.get'].invoke({conversationId:'C12345678',id:'1700000000.000001'},ctx);assert.equal(exact.authorDisplayName,'Daan');
});
test('profile permission errors fall back; authentication and rate errors stop the read',async()=>{
 for(const [status,code,expected] of [[403,'missing_scope',null],[401,'invalid_auth','authentication_required'],[429,'ratelimited','rate_limited']]){
  const {ctx}=contractContext({'/users/info':{error:{status,code}}});
  const read=createMessaging('/tmp/slack-display-test').operations['messaging.messages.get'].invoke({conversationId:'C12345678',id:'1700000000.000001'},ctx);
  if(expected)await assert.rejects(read,e=>e.code===expected);else assert.equal((await read).authorDisplayName,null);
 }
});
