import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(process.argv[2] || sourceRoot);
const fixture = pathToFileURL(resolve(sourceRoot, 'scripts/release-qa-fixture.mjs')).href;
const env = { ...process.env, KOSIS_API_KEY: 'qa-fixture-only', DOTENV_CONFIG_PATH: resolve(target, '.qa-no-env') };
const checks = [];
const transcripts = [];
function check(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`);
}
function session() {
  const child = spawn(process.execPath, ['--import', fixture, resolve(target, 'dist/index.js')], { cwd: target, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', counter = 0;
  const pending = new Map();
  child.stderr.on('data', b => { stderr += b; });
  child.stdout.on('data', b => {
    buffer += b;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        transcripts.push({ transport: 'stdio', response: message });
        pending.get(message.id ?? null)?.(message);
      } catch { check('stdout JSON only', false, line); }
    }
  });
  child.on('error', e => check('child startup', false, e.message));
  const raw = (text, id, timeout = 5000) => new Promise(resolveReply => {
    const timer = setTimeout(() => { pending.delete(id); resolveReply(null); }, timeout);
    pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolveReply(message); });
    transcripts.push({ transport: 'stdio', request: text });
    child.stdin.write(`${text}\n`);
  });
  const request = (method, params, timeout) => {
    const id = ++counter;
    return raw(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }), id, timeout);
  };
  const notify = method => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  return { child, raw, request, notify, stderr: () => stderr, stop: async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    await new Promise(resolveStop => {
      const timer = setTimeout(() => child.kill(), 2000);
      child.once('exit', () => { clearTimeout(timer); resolveStop(); });
    });
  } };
}
const init = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'release-qa', version: '1' } };
const s = session();
try {
  const result = await s.request('initialize', init);
  check('initialize', result?.result?.protocolVersion === init.protocolVersion, result);
  s.notify('notifications/initialized');
  check('ping', Boolean((await s.request('ping'))?.result), 'same STDIO process');
  const inventories = {};
  for (const [method, field] of [['tools/list','tools'], ['resources/list','resources'], ['resources/templates/list','resourceTemplates'], ['prompts/list','prompts']]) {
    const entries = []; let cursor;
    do {
      const reply = await s.request(method, cursor ? { cursor } : {});
      check(method, Array.isArray(reply?.result?.[field]), reply?.error || reply?.result?.[field]?.length);
      entries.push(...(reply?.result?.[field] || [])); cursor = reply?.result?.nextCursor;
    } while (cursor);
    inventories[field] = entries;
  }
  const src = await readFile(resolve(sourceRoot, 'src/server.ts'), 'utf8');
  const docs = await readFile(resolve(target, 'README.md'), 'utf8');
  check('tool inventory parity', inventories.tools.length === (src.match(/registerTool\(server,/g) || []).length && inventories.tools.every(t => docs.includes(t.name)), inventories.tools.map(t=>t.name));
  check('tool annotations', inventories.tools.every(t=>t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false), 'all discovered tools');
  for (const item of inventories.resources) {
    const reply = await s.request('resources/read', { uri: item.uri });
    check(`read ${item.uri}`, Boolean(reply?.result?.contents?.[0]?.text), reply?.error || 'contents present');
  }
  const prompt = await s.request('prompts/get', { name: 'statistics_assistant', arguments: { question: 'QA 질문' } });
  check('prompt', JSON.stringify(prompt?.result).includes('QA 질문'), prompt?.error || 'question preserved');
  const args = { orgId: '101', tableId: 'QA', objL1: '00', itemId: 'T1', periodType: 'Y', yearCount: 2 };
  const tool = await s.request('tools/call', { name: 'analyze_time_series', arguments: args });
  const data = JSON.parse(tool?.result?.content?.[0]?.text || '{}');
  check('tool invocation fixture', data.success && data.dataPoints?.length === 2, data);
  for (const [name, method, params] of [
    ['unknown method','qa/unknown',{}], ['unknown tool','tools/call',{name:'qa_unknown',arguments:{}}],
    ['unknown resource','resources/read',{uri:'qa://missing'}], ['unknown prompt','prompts/get',{name:'qa_unknown'}],
    ['missing prompt arg','prompts/get',{name:'statistics_assistant',arguments:{}}],
    ['missing tool arg','tools/call',{name:'analyze_time_series',arguments:{}}],
    ['wrong type','tools/call',{name:'analyze_time_series',arguments:{...args,yearCount:'2'}}],
    ['out of bounds','tools/call',{name:'analyze_time_series',arguments:{...args,yearCount:31}}],
  ]) {
    const reply = await s.request(method, params);
    check(name, reply?.error || reply?.result?.isError, reply);
  }
  const extra = await s.request('tools/call', { name:'analyze_time_series', arguments:{...args,qaExtra:true} });
  transcripts.push({ observation: 'extra arguments', response: extra });
  const failure = await s.request('tools/call', { name:'analyze_time_series', arguments:{...args,tableId:'QA_FAILURE'} });
  check('controlled upstream failure', failure?.result?.isError || JSON.parse(failure?.result?.content?.[0]?.text || '{}').success === false, failure);
  const malformed = await s.raw('{broken', null, 1000);
  check('malformed JSON error', malformed?.error?.code === -32700, malformed);
  const envelope = await s.raw(JSON.stringify({jsonrpc:'invalid',id:900,method:'ping'}), null, 1000);
  check('invalid envelope error', envelope?.error?.code === -32600, envelope);
  check('healthy after invalid input', Boolean((await s.request('ping'))?.result), 'ping');
  const repeated = await s.request('initialize', init);
  transcripts.push({ observation:'repeated initialization', response:repeated });
  check('startup log count', s.stderr().includes('(14개)'), s.stderr());
} finally { await s.stop(); }
for (const [name,method,params] of [['before initialization','tools/list',{}],['unsupported version','initialize',{...init,protocolVersion:'1900-01-01'}]]) {
  const probe = session();
  try { transcripts.push({observation:name,response:await probe.request(method,params)}); }
  finally { await probe.stop(); }
}
const reservation = createServer();
await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
const port = reservation.address().port;
await new Promise(r=>reservation.close(r));
const http = spawn(process.execPath, ['--import',fixture,resolve(target,'dist/server-http.js')], {cwd:target,env:{...env,PORT:String(port),MCP_AUTH_TOKEN:'qa-token',RATE_LIMIT_RPM:'0',TRUST_PROXY:'false'},stdio:['ignore','pipe','pipe']});
let httpLogs=''; http.stdout.on('data',b=>{httpLogs+=b;}); http.stderr.on('data',b=>{httpLogs+=b;});
const base=`http://127.0.0.1:${port}`;
try {
  let ready=false;
  for(let i=0;i<100;i++) { try { if((await fetch(`${base}/health`)).ok){ready=true;break;} }catch{} await new Promise(r=>setTimeout(r,100)); }
  check('HTTP startup',ready,httpLogs);
  const post=async(body,auth=true)=>{
    const response=await fetch(`${base}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(auth?{authorization:'Bearer qa-token'}:{})},body});
    const text=await response.text(); const record={status:response.status,body:text}; transcripts.push({transport:'http',requestBytes:Buffer.byteLength(body),response:record}); return record;
  };
  check('HTTP auth rejection',(await post(JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'}),false)).status===401,'401');
  const batch=await post('[]'); check('HTTP batch rejection',batch.status===400,batch);
  const bad=await post('{broken'); check('HTTP malformed JSON',bad.status===400 && !bad.body.includes('node_modules'),bad);
  const initBody=JSON.stringify({jsonrpc:'2.0',id:5,method:'initialize',params:init});
  const atLimit=await post(initBody+' '.repeat(200*1024-Buffer.byteLength(initBody)));
  check('HTTP exactly 200 KiB',atLimit.status===200,atLimit);
  const over=await post(initBody+' '.repeat(200*1024+1-Buffer.byteLength(initBody)));
  check('HTTP over 200 KiB',over.status===413 && !over.body.includes('node_modules'),over);
} finally { http.kill(); }
const out=resolve(sourceRoot,'.cache/release-qa',target===sourceRoot?'report.json':'installed-report.json');
await mkdir(dirname(out),{recursive:true});
await writeFile(out,JSON.stringify({target,checks,transcripts},null,2));
console.log(`Report: ${out}`);
process.exitCode=checks.some(c=>!c.passed)?1:0;
