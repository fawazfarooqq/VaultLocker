require('dotenv').config();
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const WebSocket = require('ws');
const {createClient} = require('@supabase/supabase-js');

for (const key of ['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY']) if (!process.env[key]) throw new Error(`${key} is required in backend/.env`);
if (process.env.SUPABASE_PUBLISHABLE_KEY.includes('YOUR_')) console.warn('WARNING: SUPABASE_PUBLISHABLE_KEY in backend/.env is still a placeholder; every authenticated request will fail.');
const app = express();
app.disable('x-powered-by');
app.use(helmet({crossOriginResourcePolicy:{policy:'cross-origin'},referrerPolicy:{policy:'no-referrer'}}));
const origins=(process.env.CLIENT_URL||'http://localhost:5500').split(',').map(s=>s.trim());
app.use(cors({origin(origin,cb){if(!origin||origins.includes(origin))return cb(null,true);cb(new Error('Origin not allowed.'));},methods:['GET','POST','PATCH','DELETE','OPTIONS'],allowedHeaders:['Content-Type','Authorization']}));
app.use(express.json({limit:'32kb'}));
app.use(rateLimit({windowMs:15*60*1000,limit:150,standardHeaders:true,legacyHeaders:false}));
const baseClient=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},realtime:{transport:WebSocket}});
const MAX=25*1024*1024, BUCKET='vault_documents';
const TYPES={ 'application/pdf':'.pdf','image/png':'.png','image/jpeg':'.jpg','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'.docx' };
const FOLDERS=new Set(['General','Identity','Education','Finance','Work','Medical','Personal']);
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX,files:1},fileFilter(req,file,cb){cb(null,Object.hasOwn(TYPES,file.mimetype));}});
const appError=(res,status,error)=>res.status(status).json({error});
function userClient(token){return createClient(process.env.SUPABASE_URL,process.env.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},realtime:{transport:WebSocket},global:{headers:{Authorization:`Bearer ${token}`}}});}
async function auth(req,res,next){try{const value=req.get('authorization')||'';if(!value.startsWith('Bearer '))return appError(res,401,'Authentication required.');const token=value.slice(7).trim();const {data,error}=await baseClient.auth.getUser(token);if(error||!data.user)return appError(res,401,'Invalid or expired session.');req.user=data.user;req.token=token;req.supabase=userClient(token);next();}catch{return appError(res,401,'Authentication failed.');}}
function safeName(name){return name.replace(/[\\/\0-\x1f]/g,'_').replace(/[^\p{L}\p{N}._() -]/gu,'').trim().replace(/\s+/g,'_').slice(0,180)||'document';}
function validSignature(buf,mime){if(mime==='application/pdf')return buf.subarray(0,5).toString()==='%PDF-';if(mime==='image/png')return buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));if(mime==='image/jpeg')return buf[0]===255&&buf[1]===216&&buf[2]===255;if(mime==='application/vnd.openxmlformats-officedocument.wordprocessingml.document')return buf[0]===0x50&&buf[1]===0x4b&&buf.includes(Buffer.from('[Content_Types].xml'))&&buf.includes(Buffer.from('word/document.xml'));return false;}
app.param('id',(req,res,next,id)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)?next():appError(res,404,'Document not found.'));
app.get('/api/health',(req,res)=>res.json({status:'ok',service:'VaultLock API'}));
app.get('/api/profile',auth,async(req,res)=>{const {data,error}=await req.supabase.from('profiles').select('id,full_name,email,avatar_url,phone,created_at').eq('id',req.user.id).maybeSingle();if(error)return appError(res,500,'Could not load profile.');if(!data)return appError(res,404,'Profile not found.');res.json({profile:data});});
app.patch('/api/profile',auth,async(req,res)=>{const full_name=String(req.body.full_name??'').trim().slice(0,120),phone=String(req.body.phone??'').trim().slice(0,30);const {data,error}=await req.supabase.from('profiles').update({full_name:full_name||null,phone:phone||null}).eq('id',req.user.id).select('id,full_name,email,avatar_url,phone,created_at').single();if(error)return appError(res,500,'Could not save profile.');res.json({profile:data});});
app.get('/api/documents',auth,async(req,res)=>{let query=req.supabase.from('documents').select('id,file_name,file_size,mime_type,category,label,notes,folder,is_confidential,created_at,updated_at').order('created_at',{ascending:false});if(req.query.folder){const folder=String(req.query.folder);if(!FOLDERS.has(folder))return appError(res,400,'Invalid folder.');query=query.eq('folder',folder);}const {data,error}=await query;if(error)return appError(res,500,'Could not load documents.');res.json({documents:data||[]});});
async function storeDocument(req,res){try{if(!req.file)return appError(res,400,'Choose a supported PDF, PNG, JPG or DOCX document.');if(!Object.hasOwn(TYPES,req.file.mimetype)||!validSignature(req.file.buffer,req.file.mimetype))return appError(res,400,'File content does not match a supported file type.');const folder=String(req.body.folder||'General');if(!FOLDERS.has(folder))return appError(res,400,'Invalid folder.');const category=String(req.body.category||'General').trim().slice(0,50)||'General';const label=String(req.body.label||'').trim().slice(0,100)||null;const notes=String(req.body.notes||'').trim().slice(0,2000)||null;const fileName=String(req.file.originalname).replace(/[\\/\0-\x1f]/g,'_').slice(0,255)||'document';const path=`${req.user.id}/${folder}/${crypto.randomUUID()}-${safeName(fileName)}`;
  const {error:uploadError}=await req.supabase.storage.from(BUCKET).upload(path,req.file.buffer,{contentType:req.file.mimetype,upsert:false});if(uploadError)return appError(res,400,'Could not store the document. Check private bucket setup and storage policies.');
  const {data,error}=await req.supabase.from('documents').insert({user_id:req.user.id,file_name:fileName,file_path:path,file_size:req.file.size,mime_type:req.file.mimetype,category,label,notes,folder,is_confidential:true}).select('id,file_name,file_size,mime_type,category,label,notes,folder,is_confidential,created_at,updated_at').single();
  if(error){await req.supabase.storage.from(BUCKET).remove([path]);return appError(res,500,'Could not save document metadata.');}return res.status(201).json({document:data});
}catch{return appError(res,500,'Upload failed.');}}
app.post('/api/documents',auth,upload.single('document'),storeDocument);app.post('/api/upload',auth,upload.single('document'),storeDocument);
app.get('/api/documents/:id/download',auth,async(req,res)=>{const {data:doc,error}=await req.supabase.from('documents').select('file_path').eq('id',req.params.id).maybeSingle();if(error||!doc)return appError(res,404,'Document not found.');const {data,error:signError}=await req.supabase.storage.from(BUCKET).createSignedUrl(doc.file_path,60);if(signError||!data?.signedUrl)return appError(res,500,'Could not create a temporary viewing link.');res.json({downloadUrl:data.signedUrl,expiresIn:60});});
app.patch('/api/documents/:id',auth,async(req,res)=>{const patch={};for(const key of ['category','label','notes'])if(Object.hasOwn(req.body,key))patch[key]=String(req.body[key]??'').trim().slice(0,key==='category'?50:key==='label'?100:2000)||null;if(!Object.keys(patch).length)return appError(res,400,'No editable metadata provided.');if(patch.category===null)return appError(res,400,'Category is required.');const {data,error}=await req.supabase.from('documents').update(patch).eq('id',req.params.id).select('id,file_name,file_size,mime_type,category,label,notes,folder,is_confidential,created_at,updated_at').maybeSingle();if(error)return appError(res,500,'Could not update document.');if(!data)return appError(res,404,'Document not found.');res.json({document:data});});
app.delete('/api/documents/:id',auth,async(req,res)=>{const {data:doc,error}=await req.supabase.from('documents').select('id,file_path').eq('id',req.params.id).maybeSingle();if(error||!doc)return appError(res,404,'Document not found.');const {error:storageError}=await req.supabase.storage.from(BUCKET).remove([doc.file_path]);if(storageError)return appError(res,500,'Could not remove the stored file.');const {error:dbError}=await req.supabase.from('documents').delete().eq('id',doc.id);if(dbError)return appError(res,500,'File removed but metadata could not be deleted.');res.json({success:true});});
app.use((err,req,res,next)=>{if(res.headersSent)return next(err);if(err?.code==='LIMIT_FILE_SIZE')return appError(res,413,'File exceeds the 25 MB limit.');if(err instanceof multer.MulterError)return appError(res,400,'Upload could not be processed.');if(err?.message==='Origin not allowed.')return appError(res,403,'Origin not allowed.');if(err?.type==='entity.too.large')return appError(res,413,'Request body too large.');if(err?.type==='entity.parse.failed')return appError(res,400,'Invalid JSON body.');
  // Never echo stack traces or internal messages in production. Log only the message, never tokens or file contents.
  console.error('Unhandled error:',err?.message);return appError(res,500,process.env.NODE_ENV==='production'?'Internal server error.':(err?.message||'Internal server error.'));});
app.use((req,res)=>appError(res,404,'Not found.'));
const port=Number(process.env.PORT)||5000;app.listen(port,()=>console.log(`VaultLock API listening on port ${port}`));
