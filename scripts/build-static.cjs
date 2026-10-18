'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),dest=path.join(root,'public');
fs.rmSync(dest,{recursive:true,force:true});fs.mkdirSync(dest,{recursive:true});
const rootAssets=new Set(['navigation.js','sw.js','manifest.webmanifest','robots.txt','sitemap.xml']);
const folders=new Set(['images','assets','fonts','css','js','styles','scripts-public','audio','media']);
let count=0;
function copy(from,to){
 const stat=fs.lstatSync(from);if(stat.isSymbolicLink())throw Error('Static assets must not contain symlinks.');
 const name=path.basename(from);
 if(name.startsWith('.')||/service.?account|firebase-adminsdk|private.?key|credentials/i.test(name))return;
 if(stat.isDirectory()){fs.mkdirSync(to,{recursive:true});for(const x of fs.readdirSync(from))copy(path.join(from,x),path.join(to,x));}
 else{fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);count++;}
}
for(const item of fs.readdirSync(root)){
 const from=path.join(root,item),stat=fs.lstatSync(from);
 if(stat.isDirectory()&&folders.has(item))copy(from,path.join(dest,item));
 else if(stat.isFile()&&(item.endsWith('.html')||rootAssets.has(item)||/\.(png|jpe?g|webp|svg|ico|gif|avif|woff2?|ttf)$/i.test(item)))copy(from,path.join(dest,item));
}
if(!fs.existsSync(path.join(dest,'shamamsa-admin.html')))throw Error('Missing shamamsa-admin.html.');
console.log('Static build complete: '+count+' files. Backend source, tests and secrets are not in the public output.');
