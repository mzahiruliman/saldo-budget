import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from './model.mjs';
const item = (id='a', extra={}) => ({id,name:`Synthetic ${id}`,amount:100,category:'commitment',from:'bank',to:'external',credit:false,subscription:false,review:false,note:'',paid:false,...extra});
function fixture() {
  const s=model.initialState(), blank=structuredClone(s.months[s.selected]);
  s.selected='2027-02'; s.months={};
  for (const key of ['2026-09','2026-10','2026-12','2027-02']) s.months[key]={...structuredClone(blank),items:[item()],salary:12345,openingBalances:{bank:123},actualOpeningBalances:{bank:{amount:-50,asOf:`${key}-01`}},transfers:[{id:'t',from:'bank',to:'external',amount:10}]};
  return s;
}
test('new breakdown uses nearest chronological predecessor across year, not selected future',()=>{
  const s=fixture();s.months['2027-02'].items=[item('future')];
  s.months['2026-12'].items=[item('dec',{paid:true})];
  const n=model.nextMonth(s,'2027-01');
  assert.deepEqual(n.months['2027-01'].items,[item('dec')]);
  assert.equal(n.months['2027-01'].salary,s.months[s.selected].salary);
  assert.deepEqual(n.months['2027-01'].openingBalances,{});
  assert.deepEqual(n.months['2027-01'].actualOpeningBalances,{});
  assert.deepEqual(n.months['2027-01'].transfers,s.months[s.selected].transfers);
  assert.deepEqual(s.months['2026-12'].items,[item('dec',{paid:true})]);
});
test('creating before all saved months never pulls a future breakdown; existing month stays intact',()=>{
  const s=fixture();
  assert.deepEqual(model.nextMonth(s,'2026-01').months['2026-01'].items,[]);
  assert.deepEqual(model.nextMonth(s,'2026-10').months,s.months);
});
test('editing breakdown carries through inherited months only, retaining monthly paid and non-item state',()=>{
  const s=fixture(), original=structuredClone(s);
  s.months['2026-12'].items[0].paid=true;
  s.months['2027-02'].items=[item('override')];
  s.months['2027-03']=structuredClone(s.months['2026-10']);
  const before=structuredClone(s);
  const n=model.updateMonthItems(s,'2026-10',[item('a',{amount:321,credit:true,subscription:true,review:true,note:'Changed',category:'savings',to:'mum'}),item('added',{paid:true})]);
  assert.deepEqual(n.months['2026-09'],original.months['2026-09']);
  assert.equal(n.months['2026-12'].items[0].amount,321);
  assert.equal(n.months['2026-12'].items[0].paid,true);
  assert.equal(n.months['2026-12'].items[1].paid,false);
  for(const key of ['2026-10','2026-12']) {
    // Planning provenance/revision may change; unrelated monetary fields may not.
    const {planning: _new, ...newMonth} = n.months[key], {planning: _old, ...oldMonth} = s.months[key];
    assert.deepEqual({...newMonth,items:[]},{...oldMonth,items:[]});
    assert.deepEqual(n.months[key].items.map(({paid,...rest})=>rest),n.months['2026-10'].items.map(({paid,...rest})=>rest));
  }
  assert.deepEqual(n.months['2027-02'],s.months['2027-02']);
  assert.deepEqual(n.months['2027-03'],s.months['2027-03']);
  assert.deepEqual(s,before);
  assert.equal(model.validateState(n).valid,true);
});
test('deletion carries; paid-only edits and property order do not create boundaries',()=>{
  const s=fixture();s.months['2026-12'].items=[Object.fromEntries(Object.entries(item('a',{paid:true})).reverse())];
  const paid=model.updateMonthItems(s,'2026-10',[item('a',{paid:true})]);
  assert.deepEqual(paid.months['2026-12'],s.months['2026-12']);
  const n=model.updateMonthItems(paid,'2026-10',[]);
  assert.deepEqual(n.months['2026-12'].items,[]);
  assert.deepEqual(n.months['2027-02'].items,[]);
});
test('item edit rejects invalid state or item replacements without mutation',()=>{
  const s=fixture(),before=structuredClone(s);
  for(const items of [[item('a',{amount:-1})],[item('a',{from:'unknown'})],[item(),item()],null])
    assert.throws(()=>model.updateMonthItems(s,'2026-10',items),TypeError);
  assert.throws(()=>model.updateMonthItems({...s,version:2},'2026-10',[]),TypeError);
  assert.throws(()=>model.updateMonthItems(s,'2026-11',[]),TypeError);
  assert.deepEqual(s,before);
});
test('explicit one-time reset replaces only later existing breakdowns, clears paid, is idempotent and keeps v1',()=>{
  const s=fixture();s.selected='2026-09';
  s.months['2026-10'].items=[item('source',{paid:true,subscription:true,note:'Synthetic reset'})];
  const before=structuredClone(s),n=model.resetLaterBreakdowns(s,'2026-10');
  assert.deepEqual(Object.keys(n.months),Object.keys(s.months));
  assert.equal(n.selected,s.selected);assert.deepEqual(n.accounts,s.accounts);assert.equal(n.version,1);
  for (const key of Object.keys(s.months)) {
    if(key<='2026-10') assert.deepEqual(n.months[key],s.months[key]);
    else {
      assert.deepEqual(n.months[key].items,[item('source',{subscription:true,note:'Synthetic reset'})]);
      // Planning provenance/revision may change; unrelated monetary fields may not.
    const {planning: _new, ...newMonth} = n.months[key], {planning: _old, ...oldMonth} = s.months[key];
    assert.deepEqual({...newMonth,items:[]},{...oldMonth,items:[]});
    }
  }
  assert.deepEqual(model.resetLaterBreakdowns(n,'2026-10'),n);
  assert.deepEqual(s,before);assert.equal(model.validateState(n).valid,true);
  assert.throws(()=>model.resetLaterBreakdowns(s,'2026-11'),TypeError);
  assert.throws(()=>model.resetLaterBreakdowns(s,'2026-13'),TypeError);
  assert.throws(()=>model.resetLaterBreakdowns({...s,version:2},'2026-10'),TypeError);
});
test('explicit this-month-only item edit does not propagate, invalid scope fails closed',()=>{
  const s=fixture();
  const n=model.updateMonthItems(s,'2026-10',[item('a',{amount:555})],{scope:'month'});
  assert.equal(n.months['2026-10'].items[0].amount,555);
  for(const key of ['2026-09','2026-12','2027-02']) assert.deepEqual(n.months[key],s.months[key]);
  assert.throws(()=>model.updateMonthItems(s,'2026-10',[],{scope:'typo'}),TypeError);
});
export {item,fixture};
