import test from 'node:test';
import assert from 'node:assert/strict';
import {loadAccount,retryAccountWrite} from './postgres-store.mjs';
import {createApp} from './app.mjs';
import {createStore} from './store.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function recorder(){
  const queries=[];
  function sql(parts,...values){
    if(typeof parts==='string')return {text:'"'+parts+'"',params:[]};
    let text=parts[0],params=[];
    values.forEach((value,i)=>{if(value?.text){text+=value.text;params.push(...value.params);}else{text+='?';params.push(value);}text+=parts[i+1];});
    return {text,params,then(resolve){queries.push({text,params});resolve([]);}};
  }
  return {sql,queries};
}
test('password lookup reads only one parameterized account and ignores injected identity fields',async()=>{
  const {sql,queries}=recorder();
  await loadAccount(sql,{path:'/api/auth/login',input:{email:'OWNER@example.test',authUserId:'foreign',authEmail:'foreign@example.test',authSubject:'fake',userId:'foreign'}});
  assert.equal(queries.length,1);assert.ok(queries[0].text.includes('users WHERE email=?'));
  assert.deepEqual(queries[0].params,['owner@example.test']);
});
test('Google lookup uses verified context and never reads job, transcript, or other session histories',async()=>{
  const {sql,queries}=recorder();
  await loadAccount(sql,{path:'/api/auth/google',input:{authSubject:'fake',authEmail:'foreign@example.test'},account:{subject:'verified',email:'owner@example.test',handle:'owner'}});
  assert.equal(queries.length,3);assert.ok(queries.every(q=>q.text.includes('WHERE')));
  assert.ok(queries.some(q=>q.params.includes('verified')));assert.ok(queries.every(q=>!q.params.includes('fake')&&!q.params.includes('foreign@example.test')));
  assert.ok(queries.every(q=>!/jobs|meeting|SELECT \* FROM board_private.sessions/.test(q.text)));
});
test('Google linking scopes identity conflicts to current subject/account and checks expiry',async()=>{
  const {sql,queries}=recorder();
  await loadAccount(sql,{path:'/api/auth/google/link',sessionTokenHash:'sid-hash',account:{subject:'verified',email:'owner@example.test'}});
  assert.equal(queries.length,3);
  assert.ok(queries.find(q=>q.text.includes('users WHERE')).text.includes('expires_at>now()'));
  assert.ok(queries.find(q=>q.text.includes('auth_identities WHERE')).params.includes('verified'));
  assert.ok(queries.find(q=>q.text.startsWith('SELECT * FROM board_private.sessions')).text.includes('token_hash=?'));
  await assert.rejects(loadAccount(sql,{path:'/api/auth/unknown'}),{status:404});
});
test('handle collision retries are bounded and identity collisions never silently link',async()=>{
  let attempts=0;
  assert.equal(await retryAccountWrite(async()=>{attempts++;if(attempts<3)throw {code:'23505',constraint_name:'users_handle_key'};return 'ok';},'/api/auth/register'),'ok');
  assert.equal(attempts,3);
  attempts=0;await assert.rejects(retryAccountWrite(async()=>{attempts++;throw Object.assign(Error('Collision'),{code:'23505',constraint_name:'users_handle_key'});},'/api/auth/google'),/Collision/);assert.equal(attempts,4);
  await assert.rejects(retryAccountWrite(async()=>{throw {code:'23505',constraint_name:'auth_identities_provider_subject_key'};},'/api/auth/google'),{status:409});
});
test('HTTP identity context comes from validated credentials, and expired sessions cannot link',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'crewyard-account-scope-')),baseStore=createStore(join(dir,'board.json')),seen=[];
  const store={...baseStore,read:(fn,options)=>{seen.push(options);return baseStore.read(fn);},write:(fn,options)=>{seen.push(options);return baseStore.write(fn);}};
  const server=createApp({store,googleClientId:'test',verifyGoogleToken:async credential=>JSON.parse(credential)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const origin='http://127.0.0.1:'+server.address().port;
  async function request(path,body,cookies=[]){const res=await fetch(origin+'/api'+path,{method:body?'POST':'GET',headers:{origin,...(body?{'content-type':'application/json'}:{}),cookie:cookies.join('; ')},body:body?JSON.stringify(body):undefined});return {status:res.status,data:await res.json(),cookies:res.headers.getSetCookie().map(c=>c.split(';')[0])};}
  const signup=await request('/auth/register',{name:'Owner',email:'owner@example.test',password:'long-password-123',authUserId:'foreign'});assert.equal(signup.status,201);
  assert.deepEqual(seen.at(-1).account,{});
  const invalid=await request('/auth/login',{email:'owner@example.test',password:'wrong',authUserId:signup.data.user.id});assert.equal(invalid.status,401);
  const login=await request('/auth/login',{email:'owner@example.test',password:'long-password-123',authUserId:'foreign'});assert.equal(login.status,200);assert.equal(seen.at(-1).account.userId,signup.data.user.id);
  const config=await request('/auth/google/config');
  const claims={nonce:config.data.nonce,sub:'verified-subject',email:'owner@example.test',email_verified:true,name:'Owner'};
  await baseStore.write(db=>{db.sessions.forEach(s=>s.expiresAt='2000-01-01T00:00:00Z');});
  const expired=await request('/auth/google/link',{credential:JSON.stringify(claims),authSubject:'fake'},[...login.cookies,...config.cookies]);assert.equal(expired.status,401);
  assert.equal(seen.at(-1).account.subject,'verified-subject');assert.equal((await baseStore.read(db=>db.authIdentities)).length,0);
});
