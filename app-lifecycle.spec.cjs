const { test, expect } = require('@playwright/test');
const esbuild = require('esbuild');
async function app(page, options = {}) {
  const result = await esbuild.build({ entryPoints: ['main.mjs'], bundle: true, write: false, format: 'esm', loader: { '.html': 'text' }, plugins: [{ name: 'synthetic-auth', setup(build) {
    build.onResolve({filter: /^@supabase\/supabase-js$/}, () => ({path:'sdk',namespace:'fixture'}));
    build.onResolve({filter: /supabase-api\.mjs$/}, () => ({path:'api',namespace:'fixture'}));
    build.onLoad({filter: /.*/,namespace:'fixture'}, ({path}) => ({contents: path === 'sdk' ? `export function createClient(){return {auth:{onAuthStateChange(cb){window.switchSession=id=>cb('SIGNED_IN',{user:{id}})},async getSession(){return {data:{session:{user:{id:'A'}}}}}}}}` : `export function budgetApi(c,id){return {async load(){if(window.deferLoad)await new Promise(r=>window.finishLoad=r);return window.remote ?? null},async write(payload,revision){window.writes.push({id,payload,revision});window.remote={payload,revision:revision+1};return window.remote}}}` }));
  }}] });
  await page.addInitScript(options => { window.writes=[];window.deferLoad=options.deferLoad;localStorage.setItem('saldo-cloud-connection-v1','sb_publishable_SYNTHETIC_BROWSER_TEST_ONLY');if(options.cache)localStorage.setItem('saldo-cloud-draft-A',JSON.stringify(options.cache)); }, options);
  await page.route('**/main.js', r => r.fulfill({contentType:'text/javascript',body:result.outputFiles[0].text}));
  await page.goto('/saldo-budget/');
  await expect(page.locator('#workspace')).toBeVisible();
}
test('delayed import from A cannot open modal or write after switching to B',async({page})=>{
 await app(page);
 await page.evaluate(()=>{window.pendingImport=document.querySelector('#import').onchange({target:{files:[{size:1,text:()=>new Promise(r=>window.finishImport=r)}],value:''}});window.switchSession('B')});
 await expect.poll(()=>page.evaluate(()=>!!window.finishImport)).toBe(true);
 await page.waitForTimeout(50);
 const {initialState}=await import('./model.mjs');
 await page.evaluate(async payload=>{window.finishImport(JSON.stringify(payload));await window.pendingImport},initialState());
 await expect(page.locator('#modal')).not.toBeVisible();
 expect(await page.evaluate(()=>window.writes)).toEqual([]);
});
test('recovered draft is visible before deferred initial load and remains editable without replacement',async({page})=>{
 const {initialState}=await import('./model.mjs');const payload=initialState();payload.months[payload.selected].salary=54321;
 await app(page,{deferLoad:true,cache:{payload,revision:0,dirty:true}});
 await page.getByRole('button',{name:'Edit income'}).click();
 await expect(page.getByLabel('Monthly salary (RM)')).toHaveValue('543.21');
 await page.getByRole('button',{name:'Save income'}).click();
 expect(await page.evaluate(()=>window.writes)).toEqual([]);
 await page.evaluate(()=>{window.deferLoad=false;window.finishLoad()});
 await expect(page.locator('#save-status')).toContainText('Saved to cloud');
 expect(await page.evaluate(()=>window.writes[0].payload.months[window.writes[0].payload.selected].salary)).toBe(54321);
});
for (const editor of ['income', 'balance']) {
 test(`delayed remote load invalidates the open ${editor} editor and reopened edits persist`,async({page})=>{
  const {initialState}=await import('./model.mjs');
  const payload=initialState(),m=payload.months[payload.selected],account=m.salaryAccount;
  m.salary=345600;m.openingBalances={[account]:12000};
  await app(page,{deferLoad:true});
  await expect.poll(()=>page.evaluate(()=>!!window.finishLoad)).toBe(true);
  const open=async()=>{
   if(editor==='income')await page.getByRole('button',{name:'Edit income'}).click();
   else {
    await page.locator('[data-view="accounts"]').click();
    await page.locator(`[data-balance="${account}"]`).click();
   }
  };
  const input=page.getByLabel(editor==='income'?'Monthly salary (RM)':'Opening balance (RM)');
  await open();
  await input.fill('999');
  await page.evaluate(()=>{window.staleForm=document.querySelector('#modal form')});
  await page.evaluate(payload=>{window.remote={payload,revision:7};window.deferLoad=false;window.finishLoad()},payload);
  await expect(page.locator('#save-status')).toContainText('Ready');
  await expect(page.locator('#modal')).not.toBeVisible();
  await expect(page.locator('#toast')).toContainText('Budget data changed. Please reopen the editor.');
  expect(await page.evaluate(()=>window.writes)).toEqual([]);
  await open();
  await expect(input).toHaveValue(editor==='income'?'3456':'120');
  await input.fill('678.90');
  // A retained old form must not read the reopened editor's inputs or save stale data.
  await page.evaluate(()=>window.staleForm.dispatchEvent(new Event('submit',{cancelable:true})));
  await expect(page.locator('#modal')).toBeVisible();
  expect(await page.evaluate(()=>window.writes)).toEqual([]);
  await page.getByRole('button',{name:editor==='income'?'Save income':'Save balance'}).click();
  await expect(page.locator('#save-status')).toContainText('Saved to cloud');
  const remote=await page.evaluate(()=>window.remote);
  expect(remote.revision).toBe(8);
  expect(remote.payload.months[payload.selected][editor==='income'?'salary':'openingBalances'])
   .toEqual(editor==='income'?67890:{[account]:67890});
  expect(await page.evaluate(()=>window.writes.length)).toBe(1);
  await page.getByRole('button',{name:'Load latest',exact:true}).click();
  await expect(page.locator('#save-status')).toContainText('Ready');
  await open();
  await expect(input).toHaveValue('678.9');
 });
}
test('dirty primary status says Changes pending before debounce',async({page})=>{
 await app(page);
 await page.getByRole('button',{name:'Edit income'}).click();
 await page.getByLabel('Monthly salary (RM)').fill('123');
 await page.getByRole('button',{name:'Save income'}).click();
 await expect(page.locator('#save-status')).toContainText('Changes pending');
});
test('invalid cached payload is never rendered or written while remote load is pending',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await app(page,{deferLoad:true,cache:{payload:{privateMarker:'invalid-A'},revision:0,dirty:true}});
 await expect(page.locator('#cloud-message')).toContainText('Local cache unavailable');
 await page.evaluate(()=>{window.deferLoad=false;window.finishLoad()});
 await expect(page.locator('#save-status')).toContainText('Ready');
 expect(await page.evaluate(()=>window.writes)).toEqual([]);
 expect(errors).toEqual([]);
});
test('rejected delayed import cannot toast into the next account',async({page})=>{
 await app(page);
 await page.evaluate(()=>{window.pendingImport=document.querySelector('#import').onchange({target:{files:[{size:1,text:()=>new Promise((r,reject)=>window.rejectImport=reject)}],value:''}});window.switchSession('B')});
 await page.waitForTimeout(50);
 await page.evaluate(async()=>{window.rejectImport(new Error('private-A-error'));await window.pendingImport});
 await expect(page.locator('#toast')).not.toContainText('private-A-error');
 expect(await page.evaluate(()=>window.writes)).toEqual([]);
});
