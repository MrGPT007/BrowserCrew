import test from 'node:test';
import assert from 'node:assert/strict';
import { proposal } from '../apps/extension/lib/contracts.js';
import { scoped, allowed, providerConfig, verifyFindings, csvCell } from '../apps/extension/lib/policy.js';
import { decode, generate } from '../apps/extension/lib/providers.js';
const task = { workflow: 'research', resources: [{ tabId: 1, origin: 'https://example.com' }], observations: [{ id: 'o1', tabId: 1, text: 'Blue lamp costs $24.', fields: [{ ref: 'f1' }] }], actions: [] };
test('rejects arbitrary tools and malformed model arguments', () => {
  for (const value of [{ tool: 'eval', code: 'alert(1)' }, { tool: 'read_page', tabId: '1' }, { tool: 'fill_fields', observationId: 'o1', fields: [{ref:'f1',value:'x'},{ref:'f1',value:'y'}] }]) assert.throws(() => proposal(value));
  assert.throws(() => decode({ choices: [{ message: { tool_calls: [{ function: { name: 'read_page', arguments: 'broken' } }] } }] }));
  assert.throws(() => decode({ choices: [{ message: { content: 'Done!' } }] }));
});
test('enforces tab and origin scope outside model output', () => {
  assert.throws(() => scoped(task, 2, 'https://example.com'));
  assert.throws(() => scoped(task, 1, 'https://evil.example'));
  assert.throws(() => scoped(task, 1, 'chrome://settings'));
  assert.doesNotThrow(() => scoped(task, 1, 'https://example.com/products'));
  assert.throws(() => allowed(task, {tool:'read_page',tabId:2}));
  assert.throws(() => allowed(task, {tool:'fill_fields',observationId:'o1',fields:[{ref:'f1',value:'hi'}]}));
});
test('local connections cannot route to cloud or non-loopback networks', () => {
  for (const baseUrl of ['https://cloud.example/v1','http://192.168.1.2/v1','http://localhost.evil.com/v1']) assert.throws(() => providerConfig({kind:'local',baseUrl,model:'m'}));
  assert.throws(() => providerConfig({kind:'cloud',baseUrl:'http://cloud.example/v1',model:'m'}));
  assert.throws(() => providerConfig({kind:'cloud',baseUrl:'https://user:pass@cloud.example/v1',model:'m'}));
  assert.equal(providerConfig({kind:'local',baseUrl:'http://127.0.0.1:1234/v1/',model:'m'}).baseUrl, 'http://127.0.0.1:1234/v1');
});
test('completion requires exact source quotes and coverage of selected pages', () => {
  const action = {tool:'finish',summary:'One fact',findings:[{label:'Price',value:'$24',quote:'Blue lamp costs $24.',observationId:'o1'}],missing:[]};
  assert.equal(verifyFindings(task, action), true);
  assert.throws(() => verifyFindings(task, {...action, findings:[{...action.findings[0],value:'$12'}]}));
  assert.equal(verifyFindings({...task,resources:[...task.resources,{tabId:2,origin:'https://other.example'}]}, action), false);
  assert.equal(verifyFindings(task, {...action,missing:['Delivery date missing']}), false);
});
test('CSV blocks formula-like values including leading whitespace', () => {
  for (const value of ['=1+1','+SUM(A1:A3)','-2','@IMPORT',' \t=cmd']) assert.ok(csvCell(value).startsWith('"\''), value);
  assert.equal(csvCell('a"b'), '"a""b"');
});
test('provider redirects are rejected and errors never echo server bodies or credentials', async () => {
  let request;
  const fetcher = async (url, options) => { request = {url,options}; return {ok:false,status:401,text:async()=> 'SECRET_KEY_ECHO'}; };
  await assert.rejects(generate({baseUrl:'https://model.example/v1',model:'fixture'}, 'TEST_KEY', {...task,goal:'read',completionCriteria:'price'}, new AbortController().signal, fetcher), /key was not accepted/);
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, 'Bearer TEST_KEY');
  assert.ok(!request.options.body.includes('TEST_KEY'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(generate({baseUrl:'http://127.0.0.1:1234/v1',model:'m'}, '', {...task,goal:'read'}, controller.signal, async()=>{throw new Error('SECRET');}), /stopped/);
});
