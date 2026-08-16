import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const db=new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
db.prepare('INSERT INTO sites(domain,created) VALUES (?,0)').run('example.test');
db.prepare("INSERT INTO automation_rules(id,site,network,country,city,kind) VALUES ('example-cdn-batch','example.test','Example CDN','US','Example City','batch')").run();
db.prepare("INSERT INTO automation_rules(id,site,network,country,city,kind,browser,os,device,screen,language) VALUES ('example-repeat','example.test','Example Hosting','US','Example Town','repeat','Chrome','Windows','Desktop',1600,'en-US')").run();
function seed(id,network,city,ts,ms=30000) {
  db.prepare("INSERT INTO session_quality(session_id,site,visitor_id,first_ts,last_ts,visible_ms,qualified,reason,first_page) VALUES (?,'example.test',?,?,?,?,1,'confirmed','/')").run(id,id,ts,ts,ms);
  db.prepare("INSERT INTO events(site,ts,name,path,visitor_id,session_id,person_id,country,network,city,channel,browser,os,device,screen,language) VALUES ('example.test',?,'pageview','/',?,?,?,'US',?,?,'Direct','Chrome','Windows','Desktop',1600,'en-US')").run(ts,id,id,id,network,city);
}
for(let i=0;i<3;i++)seed('batch'+i,'Example CDN','Example City',1000+i);
seed('repeat1','Example Hosting','Example Town',1100,15001);
seed('repeat2','Example Hosting','Example Town',1200,15002);
seed('human','Residential ISP','London',1250,9000);
let automationReads=0;
const adapter={prepare(sql){if(sql.startsWith('SELECT DISTINCT session_id FROM session_automation_exclusions'))automationReads++;return{bind(...binds){return statement(sql,binds);},...statement(sql,[]) };},async batch(statements){return Promise.all(statements.map(s=>s.all()));}};
function statement(sql,binds){return{async all(){return{results:db.prepare(sql).all(...binds)};},async first(){return db.prepare(sql).get(...binds)||null;},async run(){return db.prepare(sql).run(...binds);}};}
const context=vm.createContext({URL,Response,Headers,atob,TextEncoder,crypto:globalThis.crypto});
vm.runInContext(readFileSync(new URL('../src/worker.js',import.meta.url),'utf8').replace('export default {','var worker = {'),context);
const env={DB:adapter,DASH_PASSWORD:'local-test-only',ID_SALT:'local-test-only',ALLOWED_SITES:'example.test'};
const auth='Basic '+Buffer.from('admin:'+env.DASH_PASSWORD).toString('base64');
let checks=0;
async function call(path,{body,origin,anonymous=false,method}={}){
  const headers={};if(!anonymous)headers.Authorization=auth;if(origin)headers.Origin=origin;
  if(body!==undefined)headers['Content-Type']='application/json';
  const response=await context.worker.fetch(new Request('https://lucid.test'+path,{method:method||(body===undefined?'GET':'POST'),headers,body:body===undefined?undefined:JSON.stringify(body)}),env,{});
  let out;try{out=await response.json();}catch{}
  return{status:response.status,body:out};
}
function equal(actual,expected){assert.deepEqual(actual,expected);checks++;}
const query='site=example.test&from=0&to=2000';
equal((await call('/api/automation?'+query,{anonymous:true})).status,401);
const inspected=await call('/api/automation?'+query);equal(inspected.status,200);equal(inspected.body.sessions.length,5);
const t0=performance.now();
const stats=await call('/api/stats?'+query);
equal(automationReads,1); // one rule evaluation reused by every breakdown
equal(stats.status,200);equal(stats.body.totals.visits,1);equal(stats.body.totals.pageviews,1);
equal(stats.body.quality.likelyAutomatedSessions,5);
equal(stats.body.channels[0].v,1);equal(stats.body.networks[0].k,'Residential ISP');
equal((await call('/api/visits?'+query)).body.visits.length,1);
equal((await call('/api/events?'+query)).body.events.length,0);
equal((await call('/api/journey?'+query+'&start=%2F')).status,200);
// Date-filtered revenue and all dimension breakdowns use the shared gate.
equal((await call('/api/stats?'+query+'&filters='+encodeURIComponent(JSON.stringify([{field:'network',value:'Example CDN'}])))).body.totals.visits,0);
equal((await call('/api/automation?'+query,{body:{id:'example-cdn-batch',enabled:false},origin:'https://evil.test'})).status,403);
equal((await call('/api/automation?'+query,{body:{id:'example-cdn-batch',enabled:0},origin:'https://lucid.test'})).status,400);
equal((await call('/api/automation?'+query,{body:{id:'missing',enabled:false},origin:'https://lucid.test'})).status,404);
equal((await call('/api/automation?'+query,{method:'DELETE'})).status,405);
equal((await call('/api/automation?'+query,{body:{id:'example-cdn-batch',enabled:false},origin:'https://lucid.test'})).status,200);
equal((await call('/api/stats?'+query)).body.totals.visits,4);
// New raw events are immediately evaluated without a backfill/job/redeploy.
for(let i=0;i<3;i++)seed('future'+i,'Example CDN','Example City',1500+i);
equal((await call('/api/stats?'+query)).body.totals.visits,7);
await call('/api/automation?'+query,{body:{id:'example-cdn-batch',enabled:true},origin:'https://lucid.test'});
equal((await call('/api/stats?'+query)).body.totals.visits,1);
equal((await call('/api/automation?'+query)).body.sessions.length,8);
// A late product action rescues a session; whole-session evidence prevents
// an earlier date or dimension filter from hiding that action.
db.prepare("INSERT INTO events(site,ts,name,path,visitor_id,session_id) VALUES ('example.test',5000,'scan_start','/','batch0','batch0')").run();
equal((await call('/api/stats?'+query)).body.totals.visits,4); // whole original batch loses its third peer
equal(db.prepare('SELECT COUNT(*) n FROM events').get().n,10);
// Normal collector requests still insert; a legitimate engagement qualifies.
const collect=async(body)=>context.worker.fetch(new Request('https://lucid.test/event',{method:'POST',headers:{Origin:'https://example.test','Content-Type':'application/json','User-Agent':'Mozilla/5.0 Chrome/130.0'},body:JSON.stringify(body)}),env,{});
equal((await collect({d:'example.test',u:'https://example.test/',n:'pageview',delta_ms:0})).status,202);
equal((await collect({d:'example.test',u:'https://example.test/',n:'__lucid_engagement',delta_ms:2000})).status,202);
equal(db.prepare("SELECT COUNT(*) n FROM session_quality WHERE qualified=1").get().n,10);
equal((await call('/api/sites')).body.sites[0].visitors24h,1);
console.log(`${checks} API/integration checks passed; SQL-backed reports, auth, rule toggles, future traffic, rescue and normal ingestion verified (${Math.round(performance.now()-t0)}ms).`);
