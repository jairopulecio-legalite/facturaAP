'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SECRET = process.env.SESSION_SECRET || '';
if (SECRET.length < 32) throw Error('SESSION_SECRET debe tener al menos 32 caracteres.');
let users;
try { users = JSON.parse(process.env.USERS_JSON || '[]'); } catch { throw Error('USERS_JSON debe contener un JSON válido.'); }
if (!Array.isArray(users) || !users.length || !users.every(u =>
  /^[a-zA-Z0-9_.-]{2,40}$/.test(u.username || '') &&
  typeof u.password === 'string' && u.password.length >= 12 &&
  ['admin', 'operador'].includes(u.role)
)) throw Error('USERS_JSON requiere usuarios con username, password (12+ caracteres) y role admin/operador.');
if (new Set(users.map(u => u.username)).size !== users.length) throw Error('Los nombres de usuario deben ser únicos.');
users = users.map(u => ({username: u.username, role: u.role,
  hash: crypto.scryptSync(u.password, 'legalite-facturacion:' + u.username, 64)}));
if (!users.some(u => u.role === 'admin')) throw Error('USERS_JSON debe incluir un administrador.');
fs.mkdirSync(DATA_DIR, {recursive: true, mode: 0o700});
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const EXCEL_PATH = path.join(DATA_DIR, 'ultimo.xlsx');
const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) :
  { revision: 0, data: null, estados: {}, logs: [] };
let revision = Number(state.revision || 0);
const failedLogins = new Map();
const ONE_DAY = 24 * 60 * 60 * 1000;
const SESSION_MS = 8 * 60 * 60 * 1000;
const MIME = {'/':'text/html; charset=utf-8', '/login':'text/html; charset=utf-8'};

function writeState() {
  state.revision = ++revision;
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state), {mode: 0o600});
  fs.renameSync(tmp, STATE_PATH);
}
function addLog(accion, usuario, archivo, detalle) {
  state.logs.unshift({accion, nombre: usuario, archivo: String(archivo || '').slice(0, 180),
    detalle: String(detalle || '').slice(0, 300), fecha: new Date().toISOString()});
  state.logs = state.logs.slice(0, 500);
}
function send(res, status, value, headers={}) {
  const payload = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8',
    'Content-Length': payload.length, 'Cache-Control': 'no-store', ...headers});
  res.end(payload);
}
function error(res, status, message) { send(res, status, {error: message}); }
function signedToken(username) {
  const payload = Buffer.from(JSON.stringify({u: username, e: Date.now()+SESSION_MS})).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function getUser(req) {
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('legalite_session='));
  if (!cookie) return null;
  const [payload, sig] = cookie.slice('legalite_session='.length).split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a=Buffer.from(sig), b=Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) return null;
  try {
    const d=JSON.parse(Buffer.from(payload,'base64url').toString());
    if (!Number.isFinite(d.e) || d.e < Date.now()) return null;
    return users.find(u => u.username === d.u) || null;
  } catch { return null; }
}
function cookie(token, secure) {
  return `legalite_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? Math.floor(SESSION_MS/1000) : 0}` + (secure ? '; Secure' : '');
}
function isSecure(req) { return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted); }
function readJSON(req, max=22 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size=0; const chunks=[];
    req.on('data', chunk=>{size+=chunk.length; if (size>max){reject(Object.assign(Error('Solicitud demasiado grande'), {status:413})); req.destroy(); return;} chunks.push(chunk);});
    req.on('end', ()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{reject(Object.assign(Error('JSON inválido'),{status:400}))}});
    req.on('error',reject);
  });
}
function verifyOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return (req.headers['sec-fetch-site'] !== 'cross-site');
  try {
    const o = new URL(origin);
    return o.host === req.headers.host && ['https:', 'http:'].includes(o.protocol);
  } catch { return false; }
}
function validateUpload(input) {
  const d=input && input.data;
  if (!d || !Array.isArray(d.rows) || d.rows.length > 10000 ||
      !/^\d{4}-[A-ZÁÉÍÓÚÜÑ]{3,20}$/.test(d.periodo || '') ||
      typeof d.mes !== 'string' || typeof d.anio !== 'string' ||
      typeof d.archivo !== 'string' || d.archivo.length > 180 ||
      d.rows.some(r=>!r || typeof r.key !== 'string' || r.key.length > 150 || !r.key.trim()))
    throw Object.assign(Error('Datos de facturación inválidos'),{status:400});
  if (typeof input.fileBase64 !== 'string' || input.fileBase64.length > 20 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(input.fileBase64))
    throw Object.assign(Error('Archivo Excel inválido o demasiado grande'),{status:400});
  const buf=Buffer.from(input.fileBase64, 'base64');
  if (buf.length < 200 || buf.subarray(0,2).toString() !== 'PK')
    throw Object.assign(Error('El archivo Excel no tiene formato .xlsx'),{status:400});
  return {d,buf};
}
function servePage(res, file) {
  fs.readFile(path.join(__dirname, 'public', file), (err, content)=>{
    if (err) { error(res,500,'No se puede abrir la interfaz'); return; }
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8',
      'Content-Length':content.length, 'Cache-Control':'no-store'});
    res.end(content);
  });
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('X-Frame-Options','DENY');
  const url=new URL(req.url, 'http://localhost');
  const p=url.pathname;
  if(req.method === 'GET' && p === '/health') return send(res,200,{status:'ok'});
  if (p === '/api/login' && req.method === 'POST') {
    if (!verifyOrigin(req)) return error(res,403,'Origen no permitido');
    try {
      const body=await readJSON(req,4000);
      const ip=(req.socket.remoteAddress || '').slice(0,100);
      const f=failedLogins.get(ip) || {count:0,until:0};
      if (Date.now() > f.until) {f.count=0; f.until=Date.now()+15*60*1000;}
      if (f.count >= 10) return error(res,429,'Demasiados intentos. Intenta más tarde.');
      const u=users.find(u=>u.username === body.username);
      const candidate=crypto.scryptSync(String(body.password||''), 'legalite-facturacion:' + String(body.username||''), 64);
      if (!u || !crypto.timingSafeEqual(u.hash,candidate)) {
        f.count++; failedLogins.set(ip,f);
        return error(res,401,'Usuario o contraseña incorrectos');
      }
      failedLogins.delete(ip);
      return send(res,200,{username:u.username,role:u.role},{'Set-Cookie':cookie(signedToken(u.username),isSecure(req))});
    }catch(e){return error(res,e.status||500,e.status?e.message:'No se pudo iniciar sesión');}
  }
  const user=getUser(req);
  if(req.method === 'GET' && p === '/login') {
    if(user){res.writeHead(302,{'Location':'/'});res.end();return;}
    return servePage(res,'login.html');
  }
  if(!user) {
    if(p.startsWith('/api/')) return error(res,401,'Sesión vencida o no autorizada');
    res.writeHead(302,{'Location':'/login','Cache-Control':'no-store'});res.end();return;
  }
  if(req.method === 'GET' && (p === '/' || p === '/index.html')) return servePage(res,'index.html');
  if(req.method === 'GET' && p === '/api/session') return send(res,200,{username:user.username,role:user.role});
  if (req.method === 'GET' && p === '/api/bootstrap') return send(res,200,{revision:state.revision,data:state.data,estados:state.estados,logs:state.logs,user:{username:user.username,role:user.role}});
  if(req.method === 'GET' && p === '/api/latest-excel') {
    if(!fs.existsSync(EXCEL_PATH)) return error(res,404,'Aún no hay Excel compartido');
    const filename=path.basename(state.data?.archivo||'facturacion.xlsx').replace(/[\r\n"\\]/g,'_');
    addLog('descarga',user.username,filename,'Excel compartido'); writeState();
    res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control':'no-store'});
    fs.createReadStream(EXCEL_PATH).pipe(res); return;
  }
  if(req.method === 'POST' && p === '/api/logout') {
    if(!verifyOrigin(req)) return error(res,403,'Origen no permitido');
    return send(res,200,{ok:true},{'Set-Cookie':cookie('',isSecure(req))});
  }
  if(['POST','PATCH','PUT','DELETE'].includes(req.method) && !verifyOrigin(req)) return error(res,403,'Origen no permitido');
  try {
    if(req.method === 'POST' && p === '/api/upload') {
      if(user.role !== 'admin') return error(res,403,'Solo un administrador puede subir el Excel mensual');
      const incoming=await readJSON(req);
      const {d,buf}=validateUpload(incoming);
      const temp=EXCEL_PATH+'.tmp';
      fs.writeFileSync(temp,buf,{mode:0o600}); fs.renameSync(temp,EXCEL_PATH);
      state.data=d;
      state.estados={};
      addLog('subida',user.username,d.archivo,`${d.rows.length} filas · confirmaciones reiniciadas`);
      writeState();
      return send(res,200,{ok:true,revision:state.revision});
    }
    if(req.method === 'PATCH' && p === '/api/estado') {
      if(!state.data) return error(res,409,'No hay una facturación cargada');
      const body=await readJSON(req,4000);
      if(body.periodo !== state.data.periodo) return error(res,409,'Periodo desactualizado; recarga los datos');
      if(typeof body.key !== 'string' || !state.data.rows.some(r=>r.key === body.key)) return error(res,404,'Cliente no encontrado');
      if(!['','pendiente','confirmado'].includes(body.val)) return error(res,400,'Estado no permitido');
      if(body.val) state.estados[body.key]=body.val; else delete state.estados[body.key];
      addLog('estado',user.username,body.key,`Cambió a ${body.val || 'sin estado'} · ${body.periodo}`);
      writeState();
      return send(res,200,{ok:true,revision:state.revision});
    }
    if(req.method === 'POST' && p === '/api/audit') {
      const b=await readJSON(req,2000);
      if(!['descarga'].includes(b.accion)) return error(res,400,'Acción no permitida');
      addLog('descarga',user.username,b.archivo,b.detalle);writeState();
      return send(res,200,{ok:true});
    }
  } catch(e) {
    console.error('Solicitud fallida:', e.message);
    return error(res,e.status||500, e.status ? e.message : 'Error al guardar. Revisa el servidor.');
  }
  error(res,404,'Ruta no encontrada');
});
server.listen(PORT, '0.0.0.0',()=>console.log(`Facturación AP escuchando en el puerto ${PORT}`));
