const log=[];const W=ms=>new Promise(r=>setTimeout(r,ms));
const vis=s=>[...document.querySelectorAll(s)].filter(e=>e.offsetParent);
const btn=t=>vis('button').find(b=>b.innerText.trim()===t);
const B='https://andrew-pellegrino.github.io/prompted/_import/';
const M=(await (await fetch(B+'meta.json',{cache:'no-store'})).json()).find(x=>x.n==N);
const h=await (await fetch(B+M.file,{cache:'no-store'})).text();
const ed=document.querySelector('.ProseMirror').editor;ed.chain().setContent(h).run();log.push('content '+ed.state.doc.childCount);
const TS=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
const setTA=(t,v)=>{t.focus();TS.call(t,v);t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new Event('change',{bubbles:true}));t.blur();};
setTA(document.querySelector('textarea.editor-title-textarea'),M.title);await W(800);
const sp=[...document.querySelectorAll('span')].find(e=>e.textContent==='Title & subtitle');(sp.closest('button,[role=button],a,div[tabindex]')||sp).click();await W(1200);
const st=vis('textarea').find(e=>e.placeholder==='Add a subtitle...');setTA(st,M.dek);log.push('sub');
document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await W(3500);
btn('Next').click();await W(3500);
btn('Web only').click();await W(1500);btn('Next').click();await W(3500);
let adv=btn('Advanced settings');if(!vis('button[aria-label="Choose date"]').length&&adv){adv.click();await W(800)}
vis('button[aria-label="Choose date"]')[0].click();await W(900);
const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
const hdr=()=>[...document.querySelectorAll('*')].find(e=>e.children.length==0&&/^(January|February|March|April|May|June|July|August|September|October|November|December) 20\d\d$/.test(e.textContent.trim()));
const [mm,dd,yy]=M.date.split('/').map(Number);
for(let i=0;i<14;i++){const [hm,hy]=hdr().textContent.trim().split(' ');const cur=(+hy)*12+months.indexOf(hm), tgt=yy*12+mm-1;if(cur==tgt)break;const re=cur>tgt?/prev/i:/next/i;const b=[...document.querySelectorAll('button')].find(b=>re.test((b.getAttribute('aria-label')||'')+(b.className||'')+(b.getAttribute('name')||'')));b.click();await W(400)}
document.querySelector(`button[data-day="${M.date}"]`).click();await W(800);
log.push('date '+vis('input').find(e=>/single-date/.test(e.id))?.value);
document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await W(2500);
btn('Review').click();await W(3500);
const body=document.body.innerText;log.push(/Web Only/.test(body)?'webonly':'NOT WEB ONLY');
if(!/Web Only/.test(body)) return log;
vis('button').find(b=>b.innerText.trim()==='Schedule').click();await W(1500);
vis('button').find(b=>/^Publish now\s*\n/.test(b.innerText)).click();await W(800);
vis('button').filter(b=>b.innerText.trim()==='Publish now').pop().click();await W(6000);
log.push(location.href);log
