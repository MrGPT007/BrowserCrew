import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../apps/extension/lib/engine.js';
const input = {goal:'Read the price',completionCriteria:'Exact price',workflow:'research',provider:{kind:'local',baseUrl:'http://127.0.0.1:1234/v1',model:'test'},resources:[{tabId:1,url:'https://example.com',origin:'https://example.com',title:'Test'}],maxSteps:5};
function harness(provider, browser = {}) {
  const saved = new Map();
  const store = { list:async()=>[...saved.values()].map(t=>structuredClone(t)), save:async t=>saved.set(t.id,structuredClone(t)), remove:async id=>saved.delete(id) };
  const engine = new Engine({store,provider,browser:{read:async()=>({id:'o1',tabId:1,documentId:'d1',url:'https://example.com',title:'Lamp',text:'Lamp $24',fields:[{ref:'f1',label:'Name',type:'text',value:''}],observedAt:new Date().toISOString()}),...browser}});
  return {engine,store,saved};
}
test('reads, verifies evidence and persists results', async () => {
  let n=0;
  const {engine,saved}=harness(async()=>({tokens:10,action:n++===0?{tool:'read_page',tabId:1}:{tool:'finish',summary:'Price found',findings:[{label:'Price',value:'$24',quote:'Lamp $24',observationId:'o1'}],missing:[]}}));
  await engine.init(); const id=await engine.start(input); await engine.running;
  assert.equal(engine.get(id).status,'completed'); assert.equal(saved.get(id).tokens,20);
});
test('cancellation during model request prevents every later browser dispatch', async () => {
  let release, reads=0;
  const {engine}=harness(()=>new Promise(r=>{release=r;}),{read:async()=>{reads++;}});
  await engine.init(); const id=await engine.start(input);
  while(!release) await new Promise(r=>setImmediate(r));
  await engine.control(id,'stop');
  release({tokens:1,action:{tool:'read_page',tabId:1}}); await engine.running;
  assert.equal(reads,0); assert.equal(engine.get(id).status,'cancelled');
});
test('one engine rejects concurrent starts before any await completes', async () => {
  const {engine}=harness(async()=>({tokens:0,action:{tool:'finish',summary:'Unavailable',findings:[],missing:['Not read']}}));
  await engine.init();
  const first=engine.start(input);
  await assert.rejects(engine.start(input),/current task/);
  await first; await engine.running;
});
test('form writes require approval and durable intent before dispatch', async () => {
  let n=0, writes=0, h;
  h=harness(async()=>({tokens:1,action:n++===0?{tool:'read_page',tabId:1}:{tool:'fill_fields',observationId:'o1',fields:[{ref:'f1',value:'Alex'}]}}),{fill:async(task)=>{writes++; assert.equal(h.saved.get(task.id).actions.at(-1).status,'intent'); return {fields:[{label:'Name',before:'',after:'Alex'}],verified:true};}});
  await h.engine.init(); const id=await h.engine.start({...input,workflow:'form'}); await h.engine.running;
  assert.equal(writes,0); assert.equal(h.engine.get(id).status,'awaiting_approval');
  await h.engine.approve(id); assert.equal(writes,1); assert.equal(h.engine.get(id).status,'completed');
  await assert.rejects(h.engine.approve(id)); assert.equal(writes,1);
});
test('unknown write outcomes survive a crash and can never auto-retry', async () => {
  const h=harness(async()=>({tokens:0,action:{tool:'finish',summary:'x',findings:[],missing:['x']}}));
  const task={...input,id:'crash',schemaVersion:1,status:'running',createdAt:new Date().toISOString(),events:[],actions:[{id:'a1',tool:'fill_fields',status:'intent'}],observations:[],pending:null};
  await h.store.save(task); await h.engine.init();
  assert.equal(h.engine.get('crash').status,'recovering');
  assert.equal(h.engine.get('crash').actions[0].status,'outcome_unknown');
  await assert.rejects(h.engine.resume('crash'));
});
test('storage failure prevents browser writes', async () => {
  let n=0,writes=0;
  const h=harness(async()=>({tokens:1,action:n++===0?{tool:'read_page',tabId:1}:{tool:'fill_fields',observationId:'o1',fields:[{ref:'f1',value:'Alex'}]}}),{fill:async()=>{writes++;}});
  await h.engine.init(); const id=await h.engine.start({...input,workflow:'form'}); await h.engine.running;
  h.store.save=async()=>{throw new Error('Disk unavailable');};
  await assert.rejects(h.engine.approve(id)); assert.equal(writes,0);
});
test('step budget is enforced and cannot be bypassed by resume', async () => {
  const h=harness(async()=>({tokens:1,action:{tool:'read_page',tabId:1}}));
  await h.engine.init(); const id=await h.engine.start({...input,maxSteps:3}); await h.engine.running;
  assert.equal(h.engine.get(id).status,'paused'); assert.equal(h.engine.get(id).steps,3);
  await assert.rejects(h.engine.resume(id),/limit/);
});
