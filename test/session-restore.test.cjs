const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../src/index.js'),'utf8');
const code=source.slice(source.indexOf('async function read('),source.indexOf('// Export the API'));
for (const known of [true,false]) {
 test(`restart restores only a stored token (match: ${known})`,async()=>{
  let query;
  const token='header.payload.signature';
  const crud={send:async data=>{if(data.method!=='object.read')return;query=data;return {object:data.host==='dev.example.test'&&known?[{session:{user_id:'user',token,expires:Date.now()+60000}}]:[]};}};
  const decode=vm.runInNewContext(code+'\ndecodeToken',{
   server:{organization_id:'platform',crud},
   sessions:new Map(),keyPairs:new Map(),sanitizeToken:value=>value,
   security:{base64urlDecode:value=>value==='header'?{kid:'previous-process'}:{user_id:'user',organization_id:'org',clientId:'client',exp:Date.now()/1000+60}},
   Date,console,tokenExpiration:60
  });
  const result=await decode(token,'org','client','dev.example.test');
  assert.equal(query.host,'dev.example.test');
  assert.equal(result.user_id,known?'user':undefined);
  const foreign = await decode(token,'different-org','client','dev.example.test');
  assert.equal(foreign.user_id,undefined);
  const platform = await decode(token,'platform','client','dev.example.test');
  assert.equal(platform.user_id,known?'user':undefined);
 });
}

test('a signed tenant token is accepted only when the expected organization is the platform',async()=>{
 const authenticate=(await import('../src/index.js')).default;
 authenticate.init({organization_id:'platform',crud:null});
 const token=authenticate.encodeToken('tenant','user','client','platform.test');
 const platform=await authenticate.decodeToken(token,'platform',undefined,'platform.test');
 assert.equal(platform.user_id,'user');
 const foreign=await authenticate.decodeToken(token,'other-tenant',undefined,'tenant.test');
 assert.equal(foreign.user_id,undefined);
});
