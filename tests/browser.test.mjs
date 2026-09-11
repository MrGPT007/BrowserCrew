import test from 'node:test';
import assert from 'node:assert/strict';
import { read, fill } from '../apps/extension/lib/browser.js';
test('cancellation recorded during an async site check prevents DOM dispatch', async () => {
  for (const operation of ['read','fill']) {
    let release, dispatched=0;
    const task={status:'running',resources:[{tabId:1,origin:'https://example.com'}],observations:[{id:'o1',tabId:1,url:'https://example.com/form',documentId:'d1'}]};
    globalThis.chrome={tabs:{get:async()=>({id:1,url:'https://example.com/form',active:true})},permissions:{contains:()=>new Promise(r=>{release=r;})},scripting:{executeScript:async()=>{dispatched++;return[];}}};
    const pending=operation==='read'?read(task,1):fill(task,{observationId:'o1',fields:[]});
    while(!release)await new Promise(r=>setImmediate(r));
    task.status='cancelled';release(true);
    await assert.rejects(pending,/stopped before/);
    assert.equal(dispatched,0);
  }
  delete globalThis.chrome;
});
