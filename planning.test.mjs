import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from './model.mjs';
const item=(extra={})=>({id:'a',name:'Synthetic rent',amount:100,category:'commitment',from:'bank',to:'external',credit:false,subscription:false,review:false,note:'',paid:false,...extra});
function fixture(){const s=m.initialState(),blank=s.months[s.selected];s.selected='2026-10';s.months={};for(const key of ['2026-10','2026-11','2026-12'])s.months[key]={...structuredClone(blank),items:[item()]};return s;}
test('persisted provenance records creation and identical explicit future overrides block older edits',()=>{
 let s=fixture();s=m.nextMonth(s,'2027-01');assert.equal(s.months['2027-01'].planning.source,'2026-12');
 assert.equal(s.months['2027-01'].planning.ownChanges,false);
 s=m.updateMonthItems(s,'2026-11',s.months['2026-11'].items,{scope:'month'});
 s=m.updateMonthItems(s,'2026-10',[item({amount:200})]);
 assert.equal(s.months['2026-11'].items[0].amount,100);assert.equal(s.months['2026-11'].planning.ownChanges,true);
 assert.equal(s.months['2026-10'].planning.source,null);assert.equal(m.validateState(JSON.parse(JSON.stringify(s))).valid,true);
});
test('onward propagation records actual source; malformed optional planning is rejected',()=>{
 const s=fixture(),n=m.updateMonthItems(s,'2026-10',[item({amount:234})]);
 assert.equal(n.months['2026-11'].planning.source,'2026-10');
 assert.equal(n.months['2026-11'].planning.ownChanges,false);
 for(const planning of [null,[],{source:'2027-01',ownChanges:false,boundary:false,revision:0},{source:null,ownChanges:'yes',boundary:false,revision:0},{source:null,ownChanges:false,boundary:false,revision:-1}]){
 const bad=fixture();bad.months['2026-10'].planning=planning;assert.equal(m.validateState(bad).valid,false);
 }
});
test('review checklist is explicit, month-local, nonmonetary and starts unconfirmed',()=>{
 const s=fixture(),before=structuredClone(s);
 const n=m.updateMonthReview(s,'2026-10','income',true);
 assert.equal(n.months['2026-10'].reviewChecklist.income,true);
 assert.deepEqual({...n.months['2026-10'],reviewChecklist:undefined},{...s.months['2026-10'],reviewChecklist:undefined});
 assert.deepEqual(n.months['2026-11'],s.months['2026-11']);assert.deepEqual(s,before);
 const fresh=m.nextMonth(n,'2027-01');assert.deepEqual(fresh.months['2027-01'].reviewChecklist,{});
 for(const [field,value] of [['madeUp',true],['income','yes']])assert.throws(()=>m.updateMonthReview(s,'2026-10',field,value),TypeError);
 const bad=fixture();bad.months['2026-10'].reviewChecklist={income:'yes'};assert.equal(m.validateState(bad).valid,false);
});
test('new months inherit legacy recurring items but never one-offs or this-month-only edits',()=>{
 let s=fixture();s.months['2026-12'].items.push(item({id:'once',recurrence:'one-off',paid:true}));
 let n=m.nextMonth(s,'2027-01');assert.deepEqual(n.months['2027-01'].items,[item()]);
 s=m.updateMonthItems(s,'2026-12',[item({amount:222}),item({id:'once',recurrence:'one-off'})],{scope:'month'});
 n=m.nextMonth(JSON.parse(JSON.stringify(s)),'2027-01');assert.deepEqual(n.months['2027-01'].items,[item()]);
 s=m.updateMonthItems(s,'2026-12',[item({amount:333})],{scope:'month'});
 assert.equal(m.nextMonth(s,'2027-01').months['2027-01'].items[0].amount,100);
});
test('onward adds only recurring definitions, recurrence conversions and explicit override boundaries survive reload',()=>{
 let s=fixture();
 s=m.updateMonthItems(s,'2026-10',[item(),item({id:'once',recurrence:'one-off'}),item({id:'repeat',recurrence:'recurring'})]);
 assert.deepEqual(s.months['2026-11'].items.map(i=>i.id),['a','repeat']);
 s=m.updateMonthItems(s,'2026-10',[item({recurrence:'one-off'}),item({id:'once',recurrence:'one-off'}),item({id:'repeat',recurrence:'recurring'})]);
 assert.deepEqual(s.months['2026-11'].items.map(i=>i.id),['repeat']);
 s=m.updateMonthItems(s,'2026-11',s.months['2026-11'].items,{scope:'month'});
 s=m.updateMonthItems(JSON.parse(JSON.stringify(s)),'2026-10',[item({amount:444})]);
 assert.deepEqual(s.months['2026-11'].items.map(i=>i.id),['repeat']);
 assert.deepEqual(s.months['2026-12'].items.map(i=>i.id),['repeat']);
 assert.equal(m.nextMonth(s,'2027-01').months['2027-01'].items[0].id,'repeat');
});
test('recurrence and persisted forward plans validate nested shapes, amounts, accounts and bounds',()=>{
 for(const recurrence of ['daily',null,false]){const s=fixture();s.months['2026-10'].items[0].recurrence=recurrence;assert.equal(m.validateState(s).valid,false);}
 for(const forwardItems of [null,[item({from:'missing'})],[item({amount:-1})],[item({recurrence:'one-off'})],[item({paid:true})],Array.from({length:1001},(_,i)=>item({id:`i${i}`}))]){
 const s=fixture();s.months['2026-10'].planning={source:null,ownChanges:true,boundary:true,revision:1,forwardItems};
 assert.equal(m.validateState(s).valid,false);
 }
 const s=m.updateMonthItems(fixture(),'2026-10',[item({recurrence:'recurring'})],{scope:'month'});assert.equal(m.validateState(s).valid,true);
});
test('explicit replacement previews exact saved targets, excludes one-offs, snapshots only breakdown and undo preserves newer non-item data',()=>{
 const s=fixture();s.months['2026-10'].items=[item({amount:789}),item({id:'once',recurrence:'one-off'})];
 s.months['2026-11'].items[0].paid=true;s.months['2026-12'].items[0].amount=900;
 const before=structuredClone(s),preview=m.previewLaterBreakdowns(s,'2026-10');
 assert.equal(preview.source,'2026-10');assert.deepEqual(preview.targets.map(t=>t.key),['2026-11','2026-12']);assert.equal(preview.targets[0].afterTotal,789);
 const {state:n,undo}=m.replaceLaterBreakdowns(s,'2026-10');
 assert.equal(n.months['2026-11'].items[0].amount,789);assert.equal(n.months['2026-11'].items[0].paid,false);assert.equal(n.months['2026-11'].items.length,1);
 assert.equal(n.months['2026-12'].planning.source,'2026-10');
 for(const entry of undo.entries){assert.deepEqual(Object.keys(entry.before).sort(),['items','planning']);}
 n.months['2026-11'].salary=555;n.months['2026-11'].openingBalances={bank:999};
 const restored=m.undoBreakdownReplacement(n,undo);
 assert.deepEqual(restored.months['2026-11'].items,before.months['2026-11'].items);
 assert.equal(restored.months['2026-11'].planning,undefined);assert.equal(restored.months['2026-11'].salary,555);assert.deepEqual(restored.months['2026-11'].openingBalances,{bank:999});
 assert.deepEqual(restored.months['2026-10'],before.months['2026-10']);assert.deepEqual(s,before);
});
test('undo rejects conflicting, identical explicit and paid edits, invalid tokens and oversized snapshots atomically',()=>{
 const s=fixture(),{state:n,undo}=m.replaceLaterBreakdowns(s,'2026-10');
 for(const changed of [m.updateMonthItems(n,'2026-11',[item({amount:999})],{scope:'month'}),m.updateMonthItems(n,'2026-11',n.months['2026-11'].items,{scope:'month'})]){
 const before=structuredClone(changed);assert.throws(()=>m.undoBreakdownReplacement(changed,undo),/changed|conflict/i);assert.deepEqual(changed,before);
 }
 const paid=structuredClone(n);paid.months['2026-11'].items[0].paid=true;assert.throws(()=>m.undoBreakdownReplacement(paid,undo),/changed|conflict/i);
 const missing=structuredClone(n);delete missing.months['2026-11'];assert.throws(()=>m.undoBreakdownReplacement(missing,undo),TypeError);
 for(const token of [null,{}, {entries:[]},{entries:[{key:'2026-11',before:{items:[item({amount:-1})]},after:undo.entries[0].after}]}])assert.throws(()=>m.undoBreakdownReplacement(n,token),TypeError);
 const large=fixture();large.months['2026-11'].items[0].note='x'.repeat(1800001);assert.throws(()=>m.replaceLaterBreakdowns(large,'2026-10'),/large|limit|size/i);
 assert.throws(()=>m.replaceLaterBreakdowns(s,'2026-12'),/later|target/i);
});
test('legacy explicit reset helper applies recurring-only truthful metadata and stays idempotent',()=>{
 const s=fixture();s.months['2026-10'].items.push(item({id:'once',recurrence:'one-off'}));
 const n=m.resetLaterBreakdowns(s,'2026-10');assert.deepEqual(n.months['2026-11'].items,[item()]);
 assert.equal(n.months['2026-11'].planning.source,'2026-10');assert.deepEqual(m.resetLaterBreakdowns(n,'2026-10'),n);
});
test('legacy reset rejects an oversized generated forward plan without changing input',()=>{
 const s=fixture();s.months['2026-10'].items=Array.from({length:1001},(_,i)=>item({id:`i${i}`}));const before=structuredClone(s);
 assert.equal(m.validateState(s).valid,true);assert.throws(()=>m.resetLaterBreakdowns(s,'2026-10'),TypeError);assert.deepEqual(s,before);
});
test('onward edits reject invalid generated future revisions atomically',()=>{
 const s=fixture();s.months['2026-11'].planning={source:'2026-10',ownChanges:false,boundary:false,revision:Number.MAX_SAFE_INTEGER};
 const before=structuredClone(s);assert.equal(m.validateState(s).valid,true);
 assert.throws(()=>m.updateMonthItems(s,'2026-10',[item({amount:200})]),TypeError);assert.deepEqual(s,before);
});
// Sequential scopes must compose operations, not promote the entire visible snapshot.
for (const local of ['edit','add','delete']) for (const onward of ['edit','add','delete']) {
 test(`month-only ${local} A then onward ${onward} B isolates the forward delta through JSON reload`,()=>{
  let s=fixture();delete s.months['2026-12'];
  for(const month of Object.values(s.months))month.items=[item(),item({id:'b',name:'Synthetic B'})];
  s.months['2026-11'].items[1].paid=true;
  const once=item({id:'local-once',recurrence:'one-off',paid:true});
  s.months['2026-11'].items.push(once);
  const initial=structuredClone(s),a=item({amount:900});
  const localItems=local==='edit'?[a,item({id:'b',name:'Synthetic B'})]
   :local==='add'?[...s.months['2026-10'].items,item({id:'local-added'})]
   :s.months['2026-10'].items.filter(i=>i.id!=='a');
  s=m.updateMonthItems(s,'2026-10',localItems,{scope:'month'});
  s=JSON.parse(JSON.stringify(s));
  const visible=s.months['2026-10'].items;
  const changed=onward==='edit'?visible.map(i=>i.id==='b'?{...i,amount:200}:i)
   :onward==='add'?[...visible,item({id:'new-b',amount:300})]:visible.filter(i=>i.id!=='b');
  const before=structuredClone(s),n=m.updateMonthItems(s,'2026-10',changed);
  const expected=onward==='edit'?[item(),item({id:'b',name:'Synthetic B',amount:200})]
   :onward==='add'?[...initial.months['2026-10'].items,item({id:'new-b',amount:300})]:[item()];
  assert.deepEqual(n.months['2026-10'].items,changed);
  assert.deepEqual(n.months['2026-10'].planning.forwardItems,expected);
  assert.deepEqual(n.months['2026-11'].items,[...expected.map(i=>({...i,paid:i.id==='b'})),once]);
  const restored=JSON.parse(JSON.stringify(n)),fresh=m.nextMonth(restored,'2026-12');
  assert.deepEqual(fresh.months['2026-12'].items,expected);
  assert.deepEqual(s,before);assert.equal(m.validateState(fresh).valid,true);
 });
}
test('sequential scopes preserve unrelated local one-offs and isolate recurrence conversions',()=>{
 let s=fixture();delete s.months['2026-12'];
 for(const month of Object.values(s.months))month.items=[item(),item({id:'b'})];
 const once=item({id:'x',name:'Future local one-off',recurrence:'one-off',paid:true});
 s.months['2026-11'].items.push(once);
 s=m.updateMonthItems(s,'2026-10',[item({amount:900}),item({id:'b'}),item({id:'x'})],{scope:'month'});
 s=m.updateMonthItems(JSON.parse(JSON.stringify(s)),'2026-10',s.months['2026-10'].items.map(i=>i.id==='b'?{...i,recurrence:'one-off'}:i));
 assert.deepEqual(s.months['2026-11'].items,[item(),once]);
 s=m.updateMonthItems(JSON.parse(JSON.stringify(s)),'2026-10',s.months['2026-10'].items.map(i=>i.id==='b'?{...i,recurrence:'recurring'}:i));
 assert.deepEqual(s.months['2026-11'].items,[item(),item({id:'b',recurrence:'recurring'}),once]);
 assert.deepEqual(m.nextMonth(JSON.parse(JSON.stringify(s)),'2026-12').months['2026-12'].items,[item(),item({id:'b',recurrence:'recurring'})]);
});
test('sequential scopes stop at persisted identical boundaries without skipping to later matching snapshots',()=>{
 let s=fixture();for(const month of Object.values(s.months))month.items=[item(),item({id:'b'})];
 s=m.nextMonth(s,'2027-01');
 s=m.updateMonthItems(s,'2026-12',s.months['2026-12'].items,{scope:'month'});
 s=m.updateMonthItems(s,'2026-10',[item({amount:900}),item({id:'b'})],{scope:'month'});
 const before=JSON.parse(JSON.stringify(s));
 s=m.updateMonthItems(before,'2026-10',before.months['2026-10'].items.map(i=>i.id==='b'?{...i,amount:200}:i));
 assert.deepEqual(s.months['2026-11'].items,[item(),item({id:'b',amount:200})]);
 for(const key of ['2026-12','2027-01'])assert.deepEqual(s.months[key],before.months[key]);
 assert.deepEqual(m.nextMonth(JSON.parse(JSON.stringify(s)),'2027-02').months['2027-02'].items,[item(),item({id:'b'})]);
});
export {fixture,item};
