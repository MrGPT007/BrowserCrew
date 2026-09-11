import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const captured = [];
const secret = 'CANARY_PASSWORD_DO_NOT_SEND_78261';
const server = createServer(async (req, res) => {
  if (req.url === '/v1/chat/completions') {
    let raw=''; for await (const chunk of req) raw += chunk;
    captured.push(raw);
    const body=JSON.parse(raw), context=JSON.parse(body.messages.at(-1).content);
    let name, args;
    if (context.goal.startsWith('Connection test')) {name='read_page';args={tabId:1};}
    else {
      const next=context.selectedTabs.find(r=>!context.observations.some(o=>o.tabId===r.tabId));
      if(next){name='read_page';args={tabId:next.tabId};}
      else if(context.workflow==='form'){
        name='fill_fields';const o=context.observations[0];args={observationId:o.id,fields:o.fields.filter(f=>f.label==='Name').map(f=>({ref:f.ref,value:'Alex Morgan'}))};
      } else {
        name='finish';args={summary:'The selected product prices are ready.',findings:context.observations.map(o=>({label:o.title,value:'$24',quote:'Price: $24',observationId:o.id})),missing:[]};
      }
    }
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({choices:[{message:{tool_calls:[{id:'fixture-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{total_tokens:100}})); return;
  }
  res.writeHead(200,{'Content-Type':'text/html'});
  const isForm=req.url.startsWith('/form');
  res.end('<!doctype html><html><head><title>'+ (isForm?'Inquiry form':'Supplier '+req.url) +'</title></head><body><h1>'+ (isForm?'Inquiry':'Desk lamp') +'</h1><p>Price: $24</p><label>Name<input name="name"></label><label>Password<input type="password" value="'+secret+'"></label><input type="hidden" value="'+secret+'"><textarea hidden>'+secret+'</textarea><p hidden>'+secret+'</p><script>window.changes=[];document.querySelector("[name=name]").addEventListener("input",e=>window.changes.push(e.target.value));</script></body></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const temp=await mkdtemp(join(tmpdir(),'browsercrew-'));
await mkdir('artifacts',{recursive:true});
let context;
const launch=async extension => chromium.launchPersistentContext(join(temp,'profile'),{channel:'chromium',headless:true,args:['--no-sandbox','--disable-extensions-except='+extension,'--load-extension='+extension],viewport:{width:1440,height:1100}});
const wait = async fn => { const deadline=Date.now()+20000; while(Date.now()<deadline){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out waiting for extension state.'); };
const getWorker=async ctx=>ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
const send=async(page,type,rest={})=> {const r=await page.evaluate(m=>chrome.runtime.sendMessage(m),{type,...rest});assert.equal(r.ok,true,r.error);return r.value;};
try {
  // Load the exact production manifest first: no automatic site grants.
  context=await launch(resolve('dist/extension'));
  let worker=await getWorker(context);
  const extensionId=new URL(worker.url()).host;
  let panel=await context.newPage(); await panel.goto('chrome-extension://'+extensionId+'/index.html');
  await panel.locator('h1').filter({hasText:'Give your browser'}).waitFor();
  assert.deepEqual(await worker.evaluate(()=>chrome.runtime.getManifest().host_permissions),undefined);
  const permission = await worker.evaluate(origin=>chrome.permissions.contains({origins:[origin+'/*']}),base);
  assert.equal(permission,false,'Production extension must not start with site access');
  await context.close();

  // Test-only copy grants only the local fixture origin, standing in for Chrome's user grant dialog.
  // Browser adapter, worker, policy, provider transport, DOM and UI are unchanged.
  const fixtureExtension=join(temp,'fixture-extension');
  await cp(resolve('dist/extension'),fixtureExtension,{recursive:true});
  const manifest=JSON.parse(await readFile(join(fixtureExtension,'manifest.json'),'utf8'));
  manifest.host_permissions=[base+'/*'];
  await writeFile(join(fixtureExtension,'manifest.json'),JSON.stringify(manifest));
  context=await launch(fixtureExtension);
  worker=await getWorker(context);
  const id=new URL(worker.url()).host;
  const pages=[];
  for(let i=1;i<=5;i++){const page=await context.newPage();await page.goto(base+'/supplier-'+i);pages.push(page);}
  panel=await context.newPage();await panel.goto('chrome-extension://'+id+'/index.html');
  await panel.locator('h1').filter({hasText:'Give your browser'}).waitFor();
  await panel.screenshot({path:'artifacts/workspace-light.png',fullPage:true});
  await panel.locator('#theme').click();
  assert.equal(await panel.locator('html').getAttribute('data-theme'),'dark');
  await panel.screenshot({path:'artifacts/workspace-dark.png',fullPage:true});
  await panel.locator('#theme').click();
  for(const width of [320,390,768]){
    await panel.setViewportSize({width,height:1000});
    assert.ok(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow at '+width);
    await panel.screenshot({path:'artifacts/workspace-'+width+'.png',fullPage:true});
  }
  await panel.emulateMedia({reducedMotion:'reduce',forcedColors:'active'});
  await panel.locator('html').evaluate(el=>el.dir='rtl');
  assert.ok(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await panel.screenshot({path:'artifacts/workspace-rtl-forced-colors.png',fullPage:true});
  await panel.locator('html').evaluate(el=>el.dir='ltr');
  await panel.emulateMedia({reducedMotion:'no-preference',forcedColors:'none'});
  await panel.setViewportSize({width:1440,height:1100});
  await panel.locator('nav [data-view=connect]').click();
  await panel.locator('[data-provider=local]').click();
  await panel.locator('#server').fill(base+'/v1');await panel.locator('#model').fill('scripted-fixture-model');
  await panel.locator('#connect').click();
  await wait(async()=> (await send(panel,'state')).provider.testedAt);
  await panel.locator('nav [data-view=task]').click();await panel.locator('#refresh-tabs').click();
  await wait(async()=> (await panel.locator('.tab-option').count())===5);
  await panel.locator('#example').click();
  for(const checkbox of await panel.locator('.tab-option input').all())await checkbox.check();
  await panel.locator('#start').click();
  const research=await wait(async()=>{const tasks=(await send(panel,'state')).tasks;return tasks.find(t=>t.status==='completed');});
  assert.equal(research.findings.length,5);assert.equal(research.observations.length,5);
  assert.ok(captured.every(raw=>!raw.includes(secret)),'Secret form values must not reach provider transport');
  await wait(async()=> await panel.locator('.finding').count()===5);
  await panel.screenshot({path:'artifacts/research-result.png',fullPage:true});

  const form=await context.newPage();await form.goto(base+'/form');
  const tabs=await send(panel,'tabs');const formTab=tabs.find(t=>t.url===base+'/form');
  assert.ok(formTab);
  const startForm=async()=>send(panel,'start',{goal:'Fill the Name field with Alex Morgan. Do not submit.',completionCriteria:'Name field equals Alex Morgan.',workflow:'form',tabIds:[formTab.tabId],maxSteps:5});
  const formId=await startForm();
  await wait(async()=> (await send(panel,'state')).tasks.find(t=>t.id===formId)?.status==='awaiting_approval');
  assert.equal(await form.locator('[name=name]').inputValue(),'');
  await form.bringToFront();
  await send(panel,'approve',{id:formId});
  assert.equal(await form.locator('[name=name]').inputValue(),'Alex Morgan');
  assert.deepEqual(await form.evaluate(()=>window.changes),['Alex Morgan']);
  const formResult=(await send(panel,'state')).tasks.find(t=>t.id===formId);
  assert.equal(formResult.actions.at(-1).status,'verified');

  await form.locator('[name=name]').fill('');
  const staleId=await startForm();
  await wait(async()=> (await send(panel,'state')).tasks.find(t=>t.id===staleId)?.status==='awaiting_approval');
  await form.locator('[name=name]').fill('User changed this');
  await form.bringToFront();await send(panel,'approve',{id:staleId});
  assert.equal(await form.locator('[name=name]').inputValue(),'User changed this');
  assert.equal((await send(panel,'state')).tasks.find(t=>t.id===staleId).status,'recovering');
  const retry=await panel.evaluate(id=>chrome.runtime.sendMessage({type:'resume',id}),staleId);
  assert.equal(retry.ok,false,'Uncertain writes cannot be resumed');
  await context.close();
  context=await launch(fixtureExtension);worker=await getWorker(context);
  panel=await context.newPage();await panel.goto('chrome-extension://'+new URL(worker.url()).host+'/index.html');
  const recovered=await send(panel,'state');
  assert.ok(recovered.tasks.some(t=>t.id===research.id),'Research history survives browser restart');
  assert.equal(recovered.tasks.find(t=>t.id===staleId).status,'recovering');
  await send(panel,'delete',{id:research.id});
  assert.ok(!(await send(panel,'state')).tasks.some(t=>t.id===research.id),'Delete removes task and dependent observations');
  const version=context.browser()?.version() || await worker.evaluate(()=>navigator.userAgent);
  await writeFile('artifacts/browser-evidence.json',JSON.stringify({browser:version,provider:'scripted local HTTP fixture, not an LLM',tests:['production manifest loads without automatic site access','five-page research via actual browser adapter','password/hidden-field canaries absent from provider requests','approved form fill with exact field check','stale-target rejection','uncertain-write resume blocked','history survives browser restart','task deletion','light/dark captures','320/390/768 layout checks','RTL/forced-colors/reduced-motion capture'],limitations:['fixture copy has explicit local host grant','no real cloud or LM Studio/Ollama model run','no human screen-reader review','screenshots need human visual review']},null,2));
  console.log('Packaged extension and deterministic browser scenarios passed.');
  // Fixture-only previews allow visual review when an authoring workspace is offline.
  for (const name of ['workspace-light.png','workspace-320.png','workspace-dark.png']) console.log('BROWSERCREW_VISUAL:' + name + ':' + (await readFile('artifacts/' + name)).toString('base64'));
} finally { if(context)await context.close();server.close();await rm(temp,{recursive:true,force:true}); }
