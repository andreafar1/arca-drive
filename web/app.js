const seed=[
{id:1,name:'Progetto Aurora',kind:'folder',owner:'Luca Bianchi',date:'Oggi, 10:42',size:'—',shared:true},
{id:2,name:'Brand guidelines.pdf',kind:'pdf',owner:'Giulia Riva',date:'Oggi, 09:18',size:'2,4 MB',shared:true},
{id:3,name:'Budget Q4.xlsx',kind:'sheet',owner:'Luca Bianchi',date:'Ieri, 17:31',size:'840 KB'},
{id:4,name:'Team offsite.jpg',kind:'image',owner:'Elena Serra',date:'Ieri, 15:08',size:'4,8 MB',shared:true},
{id:5,name:'Contratti fornitori',kind:'folder',owner:'Marco Villa',date:'12 set 2026',size:'—'},
{id:6,name:'Roadmap prodotto.pdf',kind:'pdf',owner:'Luca Bianchi',date:'10 set 2026',size:'6,1 MB',shared:true}
];
let files=[...seed],trash=[{id:20,name:'Note riunione.txt',kind:'file',owner:'Luca Bianchi',date:'Eliminato ieri',size:'18 KB'}],view='files',filter='all',selected=null;
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const pdfjsPromise=import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs').then(p=>{p.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';return p});
function kindLabel(x){return x.kind==='folder'?'▰':x.kind==='pdf'?'PDF':x.kind==='sheet'?'XLS':x.kind==='image'?'IMG':'DOC'}
function toast(text){$('#toast span').textContent=text;$('#toast').classList.add('show');setTimeout(()=>$('#toast').classList.remove('show'),2500)}
function render(){
 let data=view==='trash'?trash:[...files];
 if(view==='shared')data=data.filter(x=>x.shared);
 if(view==='recent')data=data.slice(0,4);
 const q=$('#search').value.toLowerCase().trim();
 if(q)data=data.filter(x=>(x.name+' '+x.owner).toLowerCase().includes(q));
 if(filter!=='all')data=data.filter(x=>filter==='folder'?x.kind==='folder':x.kind!=='folder');
 $('#rows').innerHTML=data.map(x=>`<div class="row" data-id="${x.id}"><div class="filename"><i class="${x.kind}">${kindLabel(x)}</i><strong>${x.name}</strong></div><span>${x.owner}</span><span>${x.date}</span><span>${x.size}</span><button aria-label="Azioni">•••</button></div>`).join('');
 $('#count').textContent=`${data.length} elementi`;$('#trashCount').textContent=trash.length;$('#empty').style.display=data.length?'none':'block';
 $$('#rows .row').forEach(row=>row.onclick=e=>{const item=data.find(x=>x.id===Number(row.dataset.id));if(e.target.tagName==='BUTTON'||view==='trash')actions(item);else preview(item)});
}
function setView(next){view=next;$$('.nav').forEach(x=>x.classList.toggle('active',x.dataset.view===next));$('#drive').classList.toggle('hidden',['people','sync'].includes(next));$('#people').classList.toggle('hidden',next!=='people');$('#sync').classList.toggle('hidden',next!=='sync');$('#folder').style.display=['people','sync','trash'].includes(next)?'none':'block';const names={files:'I miei file',shared:'Condivisi',recent:'Recenti',people:'Persone e permessi',trash:'Cestino',sync:'Sincronizzazione'};$('#title').textContent=names[next];$('.sidebar').classList.remove('open');render()}
async function drawPdf(item){
 const host=$('#viewer');host.innerHTML='<strong>Apertura PDF…</strong>';
 try{const pdfjs=await pdfjsPromise;const data=await item.file.arrayBuffer();const pdf=await pdfjs.getDocument({data}).promise;let n=1,scale=1;
 host.innerHTML=`<div style="width:100%;height:100%;display:grid;grid-template-rows:44px 1fr"><div style="display:flex;align-items:center;justify-content:center;gap:10px;background:white"><button id="prev">‹</button><span id="pages"></span><button id="next">›</button><button id="minus">−</button><button id="plus">＋</button></div><div style="overflow:auto;padding:14px;text-align:center"><canvas id="pdfcanvas"></canvas></div></div>`;
 const draw=async()=>{const page=await pdf.getPage(n),vp=page.getViewport({scale:1.2*scale}),canvas=$('#pdfcanvas'),ctx=canvas.getContext('2d'),ratio=devicePixelRatio||1;canvas.width=vp.width*ratio;canvas.height=vp.height*ratio;canvas.style.width=vp.width+'px';canvas.style.height=vp.height+'px';await page.render({canvasContext:ctx,viewport:vp,transform:ratio===1?null:[ratio,0,0,ratio,0,0]}).promise;$('#pages').textContent=`${n} / ${pdf.numPages}`};
 $('#prev').onclick=()=>{if(n>1){n--;draw()}};$('#next').onclick=()=>{if(n<pdf.numPages){n++;draw()}};$('#minus').onclick=()=>{scale=Math.max(.6,scale-.2);draw()};$('#plus').onclick=()=>{scale=Math.min(2,scale+.2);draw()};draw();
 }catch(e){host.innerHTML='<div class="doc"><strong>PDF non disponibile</strong><p>Il file potrebbe essere protetto o danneggiato.</p></div>'}
}
function preview(item){selected=item;$('#previewName').textContent=item.name;$('#ptype').textContent=item.kind.toUpperCase();$('#psize').textContent=item.size;const host=$('#viewer');if(item.kind==='pdf'&&item.file)drawPdf(item);else if(item.kind==='image'&&item.url)host.innerHTML=`<img src="${item.url}" alt="" style="max-width:100%;max-height:100%">`;else host.innerHTML=`<div class="doc"><strong>${item.name.split('.')[0]}</strong><i></i><i></i><i></i><i></i><p style="font-size:12px;color:#7b8598">Carica un file reale per visualizzarne l’anteprima.</p></div>`;$('#preview').classList.add('open')}
function modal(tag,title,body,confirm){$('#modalTag').textContent=tag;$('#modalTitle').textContent=title;$('#modalBody').innerHTML=body;$('#confirm').onclick=confirm;$('#modal').classList.add('open')}
function closeModal(){$('#modal').classList.remove('open')}
function actions(item){modal('AZIONI','Gestisci elemento',`<p><strong>${item.name}</strong></p>`,()=>{if(view==='trash'){trash=trash.filter(x=>x.id!==item.id);files.unshift({...item,date:'Ripristinato adesso'});toast('Elemento ripristinato')}else{files=files.filter(x=>x.id!==item.id);trash.unshift({...item,date:'Eliminato adesso'});toast('Spostato nel cestino')}closeModal();render()})}
$$('.nav').forEach(x=>x.onclick=()=>setView(x.dataset.view));$$('.filter').forEach(x=>x.onclick=()=>{filter=x.dataset.filter;$$('.filter').forEach(y=>y.classList.toggle('active',y===x));render()});
$('#search').oninput=render;$('#menu').onclick=()=>$('.sidebar').classList.toggle('open');$('#closePreview').onclick=()=>$('#preview').classList.remove('open');$('#closeModal').onclick=$('#cancel').onclick=closeModal;
$('#folder').onclick=()=>modal('NUOVA CARTELLA','Crea una cartella','<input id="folderName" placeholder="Nome cartella">',()=>{const name=$('#folderName').value.trim();if(!name)return;files.unshift({id:Date.now(),name,kind:'folder',owner:'Luca Bianchi',date:'Adesso',size:'—'});closeModal();render();toast('Cartella creata')});
$('#upload').onchange=e=>{[...e.target.files].forEach((f,i)=>{const pdf=f.type==='application/pdf'||f.name.toLowerCase().endsWith('.pdf'),image=f.type.startsWith('image/');files.unshift({id:Date.now()+i,name:f.name,kind:pdf?'pdf':image?'image':/xlsx|csv/i.test(f.name)?'sheet':'file',owner:'Luca Bianchi',date:'Adesso',size:(f.size/1048576).toFixed(1)+' MB',file:f,url:image?URL.createObjectURL(f):null})});render();toast('Caricamento completato');e.target.value=''};
$('#download').onclick=()=>{if(selected?.file){const a=document.createElement('a');a.href=URL.createObjectURL(selected.file);a.download=selected.name;a.click()}toast('Download avviato')};
$('#invite').onclick=()=>modal('NUOVO ACCESSO','Invita una persona','<input id="email" type="email" placeholder="nome@azienda.it"><select><option>Collaboratore</option><option>Visualizzatore</option></select>',()=>{closeModal();toast('Invito simulato')});
$('#desktop').onclick=()=>toast('Client desktop disponibile nella versione server');
$('#members').innerHTML=['Luca Bianchi|Amministratore|Attivo','Giulia Riva|Collaboratore|Attivo','Elena Serra|Collaboratore|Attivo','Marco Villa|Visualizzatore|Attivo'].map(x=>{const p=x.split('|');return `<div class="member"><strong>${p[0]}</strong><span>${p[1]}</span><small>${p[2]}</small></div>`}).join('');
document.onkeydown=e=>{if(e.key==='Escape'){closeModal();$('#preview').classList.remove('open')}if((e.ctrlKey||e.metaKey)&&e.key==='k'){e.preventDefault();$('#search').focus()}};
render();