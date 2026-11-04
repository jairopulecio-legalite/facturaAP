'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const ROOT = path.join(__dirname,'..');

async function freePort() {
  const srv=net.createServer(); await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
  const port=srv.address().port;await new Promise(resolve=>srv.close(resolve));return port;
}
async function launch(port, dir) {
 const child=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,PORT:String(port),DATA_DIR:dir,
  SESSION_SECRET:'0123456789abcdef'.repeat(4),
  USERS_JSON:JSON.stringify([{username:'admin1',password:'Administrador-123456!',role:'admin'}, {username:'operador1',password:'Operador-123456!',role:'operador'}])},stdio:'pipe'});
 const base=`http://127.0.0.1:${port}`;
 for(let i=0;i<60;i++){
  if(child.exitCode!==null)throw Error('Servidor terminó prematuramente');
  try{const r=await fetch(base+'/health');if(r.ok)return child;}catch{}
  await new Promise(r=>setTimeout(r,50));
 }
 child.kill();throw Error('Timeout servidor');
}
function cookieOf(resp){return resp.headers.get('set-cookie').split(';')[0];}
function api(base,endpoint,method='GET',data=null,cookie=null){
 const o={method,headers:{...(cookie?{Cookie:cookie}:{})}};
 if(data!==null){o.headers['Content-Type']='application/json';o.body=JSON.stringify(data);}
 return fetch(base+endpoint,o);
}

test('Acceso y persistencia compartida con usuarios de distintos roles',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'legalite-test-'));
 const port=await freePort();const base=`http://127.0.0.1:${port}`;
 let child=await launch(port,dir);
 try{
  let r=await api(base,'/');assert.equal(r.url,base+'/login');
  r=await api(base,'/api/bootstrap');assert.equal(r.status,401);
  r=await api(base,'/api/login','POST',{username:'admin1',password:'incorrecta'});assert.equal(r.status,401);
  r=await api(base,'/api/login','POST',{username:'admin1',password:'Administrador-123456!'});assert.equal(r.status,200);const admin=cookieOf(r);
  r=await api(base,'/api/login','POST',{username:'operador1',password:'Operador-123456!'});assert.equal(r.status,200);const op=cookieOf(r);
  const data={periodo:'2026-NOVIEMBRE',mes:'NOVIEMBRE',anio:'2026',archivo:'facturacion-limpia.xlsx',cargado:new Date().toISOString(),rows:[
   {key:'101_1',nit:101,empresa:'CLIENTE DEMO',sucursal:'NDS',empleados:2,valorAp:1000,nomina:250,total:1250,tipoAp:'FIJO',tipoNe:'FIJO',obs:'IGUAL 0'}]};
  const payload={data,fileBase64:Buffer.concat([Buffer.from('PK'),Buffer.alloc(300,0)]).toString('base64')};
  r=await api(base,'/api/upload','POST',payload,op);assert.equal(r.status,403);
  r=await api(base,'/api/upload','POST',payload,admin);assert.equal(r.status,200);
  r=await api(base,'/api/bootstrap','GET',null,op);let bootstrap=await r.json();
  assert.equal(bootstrap.data.rows[0].empresa,'CLIENTE DEMO');assert.equal(bootstrap.estados['101_1'],undefined);
  r=await api(base,'/api/estado','PATCH',{periodo:'2026-NOVIEMBRE',key:'101_1',val:'confirmado'},op);assert.equal(r.status,200);
  r=await api(base,'/api/bootstrap','GET',null,admin);bootstrap=await r.json();assert.equal(bootstrap.estados['101_1'],'confirmado');
  assert(bootstrap.logs.some(e=>e.nombre==='operador1' && e.accion==='estado'));
  r=await api(base,'/api/latest-excel','GET',null,op);assert.equal(r.status,200);assert.equal((await r.arrayBuffer()).byteLength,302);
  r=await api(base,'/api/upload','POST',payload,op);assert.equal(r.status,403);
  r=await api(base,'/api/estado','PATCH',{periodo:'2025-ENERO',key:'101_1',val:'confirmado'},op);assert.equal(r.status,409);
  r=await api(base,'/');const html=await r.text();assert(!html.includes('CLIENTE DEMO'));assert(!html.includes('ACOTES INVERSIONISTAS'));
  child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));
  child=await launch(port,dir);
  r=await api(base,'/api/bootstrap','GET',null,admin);bootstrap=await r.json();
  assert.equal(bootstrap.data.periodo,'2026-NOVIEMBRE');assert.equal(bootstrap.estados['101_1'],'confirmado');
  r=await api(base,'/api/logout','POST',null,admin);assert.equal(r.status,200);
 }finally{child.kill('SIGTERM');fs.rmSync(dir,{recursive:true,force:true});}
});
