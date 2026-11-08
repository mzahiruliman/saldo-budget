const {test,expect}=require('@playwright/test');
const fs=require('node:fs');
const UID='11111111-1111-4111-8111-111111111111';
// Entire shipped docs app, real SDK, synthetic intercepted HTTP only.
async function open(page,context,setup=()=>{}){
 const {initialState}=await import('./model.mjs');const state=initialState();
 const blank=structuredClone(state.months[state.selected]);state.selected='2026-10';state.months={};
 for(const key of ['2026-09','2026-10','2026-11','2026-12','2027-01'])state.months[key]={...structuredClone(blank),salary:12300,items:[{id:'a',name:'Synthetic rent',amount:100,category:'commitment',from:'bank',to:'external',paid:key==='2026-11',credit:false,subscription:false,review:false,note:''}]};
 state.months['2026-12'].items[0].amount=900;
 setup(state);
 let row={user_id:UID,payload:state,revision:1};
 await context.routeWebSocket('**',ws=>ws.close());
 await context.addInitScript(({UID})=>{
 localStorage.setItem('saldo-cloud-connection-v1','sb_publishable_SYNTHETIC_TEST_ONLY');
 localStorage.setItem('sb-cxezfmlzvyodmjxtjtzb-auth-token',JSON.stringify({access_token:btoa('{}')+'.'+btoa(JSON.stringify({sub:UID,role:'authenticated',exp:2100000000}))+'.synthetic',refresh_token:'synthetic',token_type:'bearer',expires_at:2100000000,user:{id:UID,aud:'authenticated',role:'authenticated'}}));
 },{UID});
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.hostname==='127.0.0.1')return route.continue();
  if(u.pathname==='/rest/v1/budget_documents')return route.fulfill({json:[row]});
  if(u.pathname==='/rest/v1/rpc/save_budget'){
    const body=route.request().postDataJSON();expect(body.p_expected_revision).toBe(row.revision);
    row={...row,payload:body.p_payload,revision:row.revision+1};return route.fulfill({json:[row]});
  }
  return route.abort();
 });
 await page.goto('/saldo-budget/');await expect(page.locator('#save-status')).toContainText('Ready');
 return ()=>structuredClone(row.payload);
}
function phoneTest(name, run) {
 for (const engine of ['chromium','webkit']) test(`${name} ${engine}`, async ({playwright}) => {
  const browser = await playwright[engine].launch({headless:true,args:engine==='chromium'?['--no-sandbox']:[]});
  const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page = await context.newPage(), errors=[];page.on('pageerror',error=>errors.push(error.message));
  try { await run({page,context,engine});expect(errors).toEqual([]); }
  finally {await context.close();await browser.close();}
 });
}
for(const action of ['edit','add','delete'])phoneTest(`phone item ${action} validation failure stays actionable and atomic`,async({page,context})=>{
 const errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('request',request=>{if(new URL(request.url()).pathname==='/rest/v1/rpc/save_budget')writes.push(request.postDataJSON());});
 const saved=await open(page,context,state=>{
  state.months['2026-11'].planning={source:'2026-10',ownChanges:false,boundary:false,revision:Number.MAX_SAFE_INTEGER};
 });
 const before=saved();
 if(action==='add')await page.getByRole('button',{name:'Add item',exact:false}).click();
 else await page.getByRole('button',{name:'Edit Synthetic rent',exact:true}).click();
 if(action==='delete'){
  await page.getByRole('button',{name:'Delete item',exact:true}).click();
  await page.getByRole('button',{name:'Confirm deletion',exact:true}).click();
 }else{
  await page.getByLabel('Item name').fill('Synthetic attempted');
  await page.getByLabel('Amount (RM)',{exact:true}).fill('2');
  await page.getByRole('button',{name:'Save item',exact:true}).click();
 }
 await expect(page.locator('#modal')).toBeVisible();
 await expect(page.locator('#item-error')).toContainText(/unable.*(save|delete)/i);
 await expect(page.locator('#item-error')).toContainText(/backup|latest/i);
 expect(errors).toEqual([]);expect(saved()).toEqual(before);expect(writes).toHaveLength(0);
 await expect(page.locator('#save-status')).toContainText('Ready');
 if(action!=='delete')await expect(page.getByLabel('Item name')).toHaveValue('Synthetic attempted');
 // The failure leaves scope controls and draft usable: month-only avoids overflowing the future revision.
 await page.getByLabel(action==='delete'?'Apply deletion to':'Apply changes to').selectOption('month');
 await page.getByRole('button',{name:action==='delete'?'Confirm deletion':'Save item',exact:true}).click();
 await expect(page.locator('#modal')).not.toBeVisible();await expect(page.locator('#save-status')).toContainText('Saved');
 expect(writes).toHaveLength(1);expect(saved().months['2026-11']).toEqual(before.months['2026-11']);
 expect(errors).toEqual([]);
});
phoneTest('phone oversized legacy forward plan rejection preserves the item draft',async({page,context})=>{
 const writes=[];page.on('request',r=>{if(new URL(r.url()).pathname==='/rest/v1/rpc/save_budget')writes.push(r.postDataJSON());});
 const saved=await open(page,context,state=>{
  const original=state.months['2026-10'].items[0];
  state.months['2026-10'].items=Array.from({length:1001},(_,i)=>({...original,id:i?`legacy-${i}`:'a',name:i?`Synthetic legacy ${i}`:original.name}));
 });
 const before=saved();await page.getByRole('button',{name:'Edit Synthetic rent',exact:true}).click();
 await page.getByLabel('Item name').fill('Synthetic oversized attempt');
 await page.getByRole('button',{name:'Save item',exact:true}).click();
 await expect(page.locator('#item-error')).toContainText('Unable to save item');
 await expect(page.locator('#item-error')).toContainText('backup');
 await expect(page.getByLabel('Item name')).toHaveValue('Synthetic oversized attempt');
 expect(saved()).toEqual(before);expect(writes).toHaveLength(0);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
});
phoneTest('phone sequential month-only edit then unrelated onward edit keeps both future baselines',async({page,context})=>{
 const saved=await open(page,context,state=>{
  delete state.months['2026-12'];delete state.months['2027-01'];
  for(const month of Object.values(state.months))month.items.push({...month.items[0],id:'b',name:'Synthetic B'});
 });
 const waitSaved=()=>expect(page.locator('#save-status')).toContainText('Saved');
 await page.getByRole('button',{name:'Edit Synthetic rent',exact:true}).click();
 await page.getByLabel('Amount (RM)',{exact:true}).fill('9');await page.getByLabel('Apply changes to').selectOption('month');
 await page.getByRole('button',{name:'Save item',exact:true}).click();await waitSaved();
 await page.reload();await expect(page.locator('#save-status')).toContainText('Ready');
 await page.getByRole('button',{name:'Edit Synthetic B',exact:true}).click();
 await page.getByLabel('Amount (RM)',{exact:true}).fill('2');
 await page.getByRole('button',{name:'Save item',exact:true}).click();await waitSaved();
 expect(saved().months['2026-10'].items.map(i=>i.amount)).toEqual([900,200]);
 expect(saved().months['2026-11'].items.map(i=>i.amount)).toEqual([100,200]);
 expect(saved().months['2026-11'].items.every(i=>i.paid)).toBe(true);
 await page.reload();await expect(page.locator('#save-status')).toContainText('Ready');
 await page.locator('#month').fill('2026-12');await page.locator('#month').press('Tab');await waitSaved();
 expect(saved().months['2026-12'].items.map(i=>i.amount)).toEqual([100,200]);
 expect(saved().months['2026-12'].items.every(i=>!i.paid)).toBe(true);
});
phoneTest('phone nonblocking explicit month-start review persists without changing money',async({page,context,engine})=>{
 await page.setViewportSize({width:390,height:844});const saved=await open(page,context);
 await page.getByLabel('Mark Synthetic rent paid').check();await expect(page.locator('#save-status')).toContainText('Saved');
 await page.getByText('Month-start review', {exact:false}).click();
 await expect(page.getByLabel('Confirm income')).not.toBeChecked();
 await expect(page.getByLabel('Review recurring items')).not.toBeChecked();
 await page.getByRole('button',{name:'Edit salary',exact:true}).click();
 await page.getByRole('button',{name:'Save income',exact:true}).click();
 await page.getByText('Month-start review',{exact:false}).click();
 await expect(page.getByLabel('Confirm income')).not.toBeChecked();
 await page.getByLabel('Confirm income').check();
 await page.getByLabel('Enter opening balances if needed').check();
 await page.getByLabel('Review recurring items').check();await page.getByLabel('Start unpaid',{exact:true}).check();
 await expect(page.getByLabel('Mark Synthetic rent paid')).toBeChecked();
 await expect(page.locator('#save-status')).toContainText('Saved');
 expect(saved().months['2026-10'].salary).toBe(12300);expect(saved().months['2026-10'].items[0].amount).toBe(100);
 expect(saved().months['2026-11'].items[0].paid).toBe(true);
 await page.reload();await page.getByText('Month-start review',{exact:false}).click();
 await expect(page.getByLabel('Confirm income')).toBeChecked();
 await page.locator('#month').fill('2027-02');await page.locator('#month').press('Tab');
 await page.getByText('Month-start review',{exact:false}).click();
 for(const label of ['Confirm income','Review recurring items','Enter opening balances if needed','Start unpaid'])await expect(page.getByLabel(label,{exact:true})).not.toBeChecked();
 await expect(page.getByLabel('Mark Synthetic rent paid')).not.toBeChecked();
 await page.screenshot({path:`verification/monthly-breakdown/review-${engine}.png`,fullPage:true});
});
phoneTest('phone truthful persisted provenance and own-change labels',async({page,context,engine})=>{
 await page.setViewportSize({width:390,height:844});await open(page,context);
 await expect(page.locator('[data-provenance]')).toContainText('Carry source not recorded');
 await page.getByRole('button',{name:'Edit Synthetic rent',exact:true}).click();
 await page.getByLabel('Apply changes to').selectOption('month');await page.getByRole('button',{name:'Save item',exact:true}).click();
 await expect(page.locator('[data-provenance]')).toContainText('Carry source not recorded');
 await expect(page.locator('[data-provenance]')).toContainText('Own changes');
 await page.locator('#month').fill('2027-02');await page.locator('#month').press('Tab');
 await expect(page.locator('[data-provenance]')).toContainText('Carried forward from January 2027');
 await page.getByRole('button',{name:'Edit Synthetic rent',exact:true}).click();
 await page.getByLabel('Apply changes to').selectOption('month');
 await page.getByRole('button',{name:'Save item',exact:true}).click();
 await expect(page.locator('[data-provenance]')).toContainText('Own changes');
 await expect(page.locator('#save-status')).toContainText('Saved');await page.reload();
 await expect(page.locator('[data-provenance]')).toContainText('Carried forward from January 2027');
 await expect(page.locator('[data-provenance]')).toContainText('Own changes');
 await page.screenshot({path:`verification/monthly-breakdown/provenance-${engine}.png`,fullPage:true});
});
for(const engine of ['chromium','webkit'])test(`phone recurrence and future inheritance ${engine}`,async({playwright})=>{
 const browser=await playwright[engine].launch({headless:true,args:engine==='chromium'?['--no-sandbox']:[]});
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage();
 try{
 const saved=await open(page,context);const waitSaved=()=>expect(page.locator('#save-status')).toContainText('Saved');
 await page.getByRole('button',{name:'Add item',exact:false}).click();
 await expect(page.getByLabel('Repeat item')).toHaveValue('recurring');
 await page.getByLabel('Item name').fill('Synthetic one-off');await page.getByLabel('Repeat item').selectOption('one-off');
 await page.getByRole('button',{name:'Save item',exact:true}).click();await waitSaved();
 await expect(page.locator('#rows')).toContainText('One-off');expect(saved().months['2026-11'].items).toHaveLength(1);
 await page.getByRole('button',{name:'Edit Synthetic rent',exact:true}).click();
 await page.getByLabel('Repeat item').selectOption('one-off');
 await page.getByRole('button',{name:'Save item',exact:true}).click();await waitSaved();
 expect(saved().months['2026-11'].items).toHaveLength(0);expect(saved().months['2026-12'].items).toHaveLength(1);
 await page.locator('#month').fill('2026-11');await page.locator('#month').press('Tab');await waitSaved();
 await expect(page.getByLabel('Mark Synthetic rent paid')).toHaveCount(0);
 await page.locator('#month').fill('2027-02');await page.locator('#month').press('Tab');await waitSaved();
 await page.getByRole('button',{name:'Edit Synthetic rent',exact:true}).click();await page.getByLabel('Amount (RM)',{exact:true}).fill('4.56');
 await page.getByLabel('Apply changes to').selectOption('month');await page.getByRole('button',{name:'Save item',exact:true}).click();await waitSaved();
 await page.reload();await expect(page.locator('#save-status')).toContainText('Ready');
 await expect(page.locator('#rows')).toContainText('4.56');
 await page.locator('#month-next').click();await waitSaved();await expect(page.locator('#rows')).toContainText('1.00');
 expect(saved().months['2027-03'].items[0].amount).toBe(100);
 }finally{await context.close();await browser.close();}
});
for(const engine of ['chromium','webkit'])test(`phone replacement preview confirmation undo and conflict ${engine}`,async({playwright})=>{
 const browser=await playwright[engine].launch({headless:true,args:engine==='chromium'?['--no-sandbox']:[]});
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage();
 try{
 const saved=await open(page,context),before=saved();const waitSaved=()=>expect(page.locator('#save-status')).toContainText('Saved');
 await page.locator('[data-view="settings"]').click();await page.getByRole('button',{name:'Replace later breakdowns',exact:true}).click();
 await page.getByLabel('Replacement source month').selectOption('2026-09');
 await expect(page.locator('#replacement-preview')).toContainText('October 2026');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();expect(saved()).toEqual(before);
 await page.getByRole('button',{name:'Replace later breakdowns',exact:true}).click();
 await page.getByLabel('Replacement source month').selectOption('2026-10');
 await expect(page.locator('#replacement-preview')).toContainText('November 2026');
 await expect(page.locator('#replacement-preview')).toContainText('December 2026');
 await expect(page.locator('#replacement-preview')).toContainText('January 2027');
 await expect(page.locator('#replacement-preview')).not.toContainText('September 2026');
 await expect(page.locator('#replacement-preview')).toContainText('RM 9.00');
 await expect(page.locator('#confirm-replacement')).toBeDisabled();
 await page.getByLabel('I understand this replaces the listed saved breakdowns').check();
 await expect(page.locator('#confirm-replacement')).toBeEnabled();
 await page.getByLabel('Replacement source month').selectOption('2027-01');
 await expect(page.getByLabel('I understand this replaces the listed saved breakdowns')).not.toBeChecked();
 await expect(page.locator('#replacement-preview')).toContainText('No later saved months');
 await page.getByLabel('I understand this replaces the listed saved breakdowns').check();
 await expect(page.locator('#confirm-replacement')).toBeDisabled();
 await page.getByLabel('Replacement source month').selectOption('2026-10');
 await expect(page.getByLabel('I understand this replaces the listed saved breakdowns')).not.toBeChecked();
 await expect(page.locator('#confirm-replacement')).toBeDisabled();
 await page.getByLabel('I understand this replaces the listed saved breakdowns').check();
 await page.screenshot({path:`verification/monthly-breakdown/replacement-${engine}.png`,fullPage:true});
 await page.locator('#confirm-replacement').click();await waitSaved();
 for(const key of ['2026-11','2026-12','2027-01']){
 expect(saved().months[key].items[0].amount).toBe(100);expect(saved().months[key].items[0].paid).toBe(false);
 const {items,planning,...other}=saved().months[key];const {items:oldItems,planning:oldPlanning,...oldOther}=before.months[key];expect(other).toEqual(oldOther);
 }
 expect(saved().months['2026-10']).toEqual(before.months['2026-10']);
 await page.locator('#month').fill('2026-11');await page.locator('#month').press('Tab');await waitSaved();
 await page.locator('[data-view="budget"]').click();await page.getByRole('button',{name:'Edit salary',exact:true}).click();
 await page.getByLabel('Monthly salary (RM)').fill('333');await page.getByRole('button',{name:'Save income',exact:true}).click();await waitSaved();
 await page.locator('[data-view="settings"]').click();await page.getByRole('button',{name:'Undo last replacement',exact:true}).click();
 await expect(page.locator('#modal')).toContainText('November 2026');await page.locator('#confirm-undo-replacement').click();await waitSaved();
 expect(saved().months['2026-11'].items[0].paid).toBe(true);expect(saved().months['2026-12'].items[0].amount).toBe(900);expect(saved().months['2026-11'].salary).toBe(33300);
 await page.getByRole('button',{name:'Replace later breakdowns',exact:true}).click();await page.getByLabel('Replacement source month').selectOption('2026-10');
 await page.getByLabel('I understand this replaces the listed saved breakdowns').check();await page.locator('#confirm-replacement').click();await waitSaved();
 await page.locator('[data-view="budget"]').click();await page.getByRole('button',{name:'Edit Synthetic rent',exact:true}).click();
 await page.getByLabel('Apply changes to').selectOption('month');await page.getByRole('button',{name:'Save item',exact:true}).click();await waitSaved();
 const changed=saved();await page.locator('[data-view="settings"]').click();await page.getByRole('button',{name:'Undo last replacement',exact:true}).click();
 await page.locator('#confirm-undo-replacement').click();await expect(page.locator('#replacement-error')).toContainText('changed since replacement');
 expect(saved()).toEqual(changed);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.reload();await expect(page.locator('#save-status')).toContainText('Ready');
 await page.locator('[data-view="settings"]').click();await expect(page.getByRole('button',{name:'Undo last replacement',exact:true})).toBeDisabled();
 expect(saved()).toEqual(changed);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }finally{await context.close();await browser.close();}
});
for(const operation of ['import','load latest'])test(`replacement undo clears on ${operation} and stale dialog handlers cannot edit reopened preview`,async({page,context})=>{
 const saved=await open(page,context),original=saved();
 await page.locator('[data-view="settings"]').click();await page.getByRole('button',{name:'Replace later breakdowns',exact:true}).click();
 await page.getByLabel('I understand this replaces the listed saved breakdowns').check();await page.locator('#confirm-replacement').click();
 await expect(page.locator('#save-status')).toContainText('Saved');
 await expect(page.getByRole('button',{name:'Undo last replacement',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Replace later breakdowns',exact:true}).click();
 await page.evaluate(()=>{window.staleSource=document.querySelector('#replacement-source')});await page.keyboard.press('Escape');
 if(operation==='import'){
 await page.locator('#import').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(original))});
 await page.getByRole('button',{name:'Replace with backup',exact:true}).click();await expect(page.locator('#save-status')).toContainText('Saved');
 expect(saved()).toEqual(original);
 }else{await page.getByRole('button',{name:'Load latest',exact:true}).click();await expect(page.locator('#save-status')).toContainText('Ready');}
 await expect(page.getByRole('button',{name:'Undo last replacement',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Replace later breakdowns',exact:true}).click();await page.getByLabel('I understand this replaces the listed saved breakdowns').check();
 await page.evaluate(()=>window.staleSource.dispatchEvent(new Event('change')));
 await expect(page.getByLabel('I understand this replaces the listed saved breakdowns')).toBeChecked();
});
for(const action of ['edit','add','delete'])test(`phone explicit this-month-only ${action}`,async({page,context})=>{
 await page.setViewportSize({width:390,height:844});const saved=await open(page,context);
 if(action==='add') await page.getByRole('button',{name:'Add item',exact:false}).click();
 else await page.getByRole('button',{name:'Edit Synthetic rent',exact:true}).click();
 if(action==='delete'){
  await page.getByRole('button',{name:'Delete item',exact:true}).click();
  await page.getByLabel('Apply deletion to').selectOption('month');
  await page.getByRole('button',{name:'Confirm deletion',exact:true}).click();
 } else {
  await expect(page.getByLabel('Apply changes to')).toHaveValue('onward');
  await page.getByLabel('Apply changes to').selectOption('month');
  await page.getByLabel('Item name').fill('Synthetic local');
  await page.getByRole('button',{name:'Save item',exact:true}).click();
 }
 await expect(page.locator('#save-status')).toContainText('Saved');
 expect(saved().months['2026-11'].items).toHaveLength(1);
 expect(saved().months['2026-11'].items[0].name).toBe('Synthetic rent');
 if(action==='delete')expect(saved().months['2026-10'].items).toHaveLength(0);
 else expect(saved().months['2026-10'].items.some(i=>i.name==='Synthetic local')).toBe(true);
});
for(const engine of ['chromium','webkit'])test(`phone compiled app chronological item edits/add/delete/paid/reload ${engine}`,async({playwright},info)=>{
 const browser=await playwright[engine].launch({headless:true,args:engine==='chromium'?['--no-sandbox']:[]});
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const page=await context.newPage();
 try {
  const saved=await open(page,context);
  const waitSaved=()=>expect(page.locator('#save-status')).toContainText('Saved');
  await page.getByRole('button',{name:'Edit Synthetic rent',exact:true}).click();
  await page.getByLabel('Amount (RM)',{exact:true}).fill('2.34');
  await page.getByRole('button',{name:'Save item',exact:true}).click();await waitSaved();
  expect(saved().months['2026-11'].items[0].amount).toBe(234);
  expect(saved().months['2026-11'].items[0].paid).toBe(true);
  expect(saved().months['2026-09'].items[0].amount).toBe(100);
  expect(saved().months['2026-12'].items[0].amount).toBe(900);
  expect(saved().months['2027-01'].items[0].amount).toBe(100);
  await page.getByLabel('Mark Synthetic rent paid').check();await waitSaved();
  await page.getByLabel('Mark Synthetic rent paid').uncheck();await waitSaved();
  expect(saved().months['2026-11'].items[0].paid).toBe(true);
  await page.locator('#month-next').click();await waitSaved();
  await expect(page.getByLabel('Mark Synthetic rent paid')).toBeChecked();
  await expect(page.locator('#rows')).toContainText('2.34');
  await page.locator('#month-prev').click();await waitSaved();
  await page.getByRole('button',{name:'Add item',exact:false}).click();
  await page.getByLabel('Item name').fill('Synthetic added');await page.getByLabel('Amount (RM)',{exact:true}).fill('3.21');
  await page.getByRole('button',{name:'Save item',exact:true}).click();await waitSaved();
  expect(saved().months['2026-11'].items).toHaveLength(2);expect(saved().months['2026-11'].items[1].paid).toBe(false);
  await page.getByRole('button',{name:'Edit Synthetic added',exact:true}).click();
  await page.getByRole('button',{name:'Delete item',exact:true}).click();
  await page.getByRole('button',{name:'Confirm deletion',exact:true}).click();await waitSaved();
  expect(saved().months['2026-11'].items).toHaveLength(1);
  // From selected October, create February: January is its nearest predecessor.
  await page.locator('#month').fill('2027-02');await page.locator('#month').press('Tab');await waitSaved();
  expect(saved().months['2027-02'].items[0].amount).toBe(100);
  await page.reload();await expect(page.locator('#save-status')).toContainText('Ready');
  await expect(page.locator('#month')).toHaveValue('2027-02');await expect(page.locator('#rows')).toContainText('1.00');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`verification/monthly-breakdown/phone-${engine}.png`,fullPage:true});
 } finally {await context.close();await browser.close()}
});
