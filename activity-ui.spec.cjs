const {test,expect}=require('@playwright/test');
const esbuild=require('esbuild');
const fs=require('node:fs');
test.use({timezoneId:'UTC'});
// Synthetic fixtures only; no user budget or device data.
async function fixture(page, options={}) {
 const built=await esbuild.build({entryPoints:['activity-ui.mjs'],bundle:true,write:false,format:'esm'});
 await page.route('**/activity-fixture',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fs.existsSync('activity.css')?fs.readFileSync('activity.css','utf8'):''}</style><main id="content"></main><script type="module" src="/activity-fixture.mjs"></script>`}));
 await page.route('**/activity-fixture.mjs',route=>route.fulfill({contentType:'text/javascript',body:built.outputFiles[0].text+`\nwindow.mountActivity=mountActivity;`}));
 await page.goto('/activity-fixture');
 await page.waitForFunction(()=>window.mountActivity);
 await page.evaluate(options=>{
 window.calls=[];window.unsubscribed=0;window.listCalls=[];window.month='2026-10';window.defer=options.defer;window.failCreate=options.failCreate;
 const accounts=[{id:'own-a',name:'Synthetic bank',type:'bank'},{id:'own-b',name:'Synthetic wallet',type:'wallet'},{id:'other',name:'External excluded',type:'recipient'}];
 window.syntheticBudget={selected:window.month,accounts};
 window.api={metadata:async()=>({accounts,categories:['commitment','entertainment','savings']}),list:async(month,cursor=null)=>{const offset=cursor?.position||0;window.listCalls.push({month,offset,cursor});if(window.defer)await new Promise(r=>window.finishList=r);return {entries:Array.from({length:offset===0?50:1},(_,n)=>({id:'row-'+(offset+n),type:'expense',amount_cents:100,occurred_at:'2026-10-02T12:00:00Z',from_account_id:'own-a',to_account_id:null,external_party:'Synthetic shop',category:'commitment',status:'active',source:'manual'})),hasMore:offset===0,nextCursor:offset===0?{position:50}:null}},summary:async()=>({income_cents:123400,expense_cents:567800,transfer_cents:90100,unassigned_income_cents:1200,unassigned_expense_cents:0,movements:{'own-a':-444400}}),create:async payload=>{window.calls.push(structuredClone(payload));if(window.deferCreate)await new Promise(r=>window.finishCreate=r);if(window.failCreate){window.failCreate=false;throw Error('Synthetic network uncertainty')}return {transaction:{id:'new'},duplicate:window.calls.length>1}},void:async id=>{window.voidId=id;return {id}},devices:async()=>window.syntheticDevices||[{id:'device-a',name:'Synthetic phone',time_zone:'UTC',expires_at:'2020-01-01T00:00:00Z',revoked_at:null}],mint:async payload=>{window.mintPayload=payload;return {device:{id:'device-new'},token:'SYNTHETIC-PRIVATE-TOKEN'}},revoke:async id=>{window.revoked=id;window.syntheticDevices=[];return true},exportAll:async()=>[{id:'synthetic-export'}],subscribe:(cb,status)=>{window.changed=cb;window.connectionStatus=status;return ()=>window.unsubscribed++}};
 window.controller=window.mountActivity({root:document.querySelector('#content'),api:window.api,getBudget:()=>window.syntheticBudget,functionUrl:'https://synthetic.invalid/functions/v1/tracker',userId:'synthetic-user'});window.controller.open();
 },options);
}
test('deleted account routes display the stored historical name',async({page})=>{await fixture(page);await page.evaluate(async()=>{window.api.list=async()=>({entries:[{id:'old',type:'expense',amount_cents:100,occurred_at:'2026-10-02T12:00:00Z',from_account_id:'deleted-id',from_account_name:'Historical bank',external_party:'Shop'}],hasMore:false});await window.controller.refresh()});await expect(page.locator('[data-history]')).toContainText('Historical bank');});
test('uncertain save retries the exact frozen request and distinguishes duplicate acknowledgement',async({page})=>{
 await page.setViewportSize({width:390,height:844});await fixture(page,{failCreate:true});
 page.on('dialog',dialog=>dialog.accept());
 await page.getByLabel('Type',{exact:true}).selectOption('income');
 await page.getByLabel('To account').selectOption('own-b');
 await page.getByLabel('External party').fill('  Synthetic client  ');
 await page.getByLabel('Amount (RM)').fill('12.34');
 await page.getByLabel('Note').fill(' Synthetic note ');
 await page.getByRole('button',{name:'Save entry',exact:true}).click();
 await expect(page.locator('[data-save-message]')).toContainText('uncertain');
 await expect(page.getByLabel('Amount (RM)')).toBeDisabled();
 await page.getByRole('button',{name:'Retry same entry',exact:true}).click();
 await expect(page.locator('[data-save-message]')).toContainText('already recorded');
 const calls=await page.evaluate(()=>window.calls);
 expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);
 expect(calls[0]).toMatchObject({type:'income',amount_cents:1234,currency:'MYR',from_account_id:null,to_account_id:'own-b',external_party:'Synthetic client',category:null,note:'Synthetic note'});
 expect(calls[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
});
test('void requires confirmation and refreshes actual totals without touching the plan',async({page})=>{
 await fixture(page);const original=await page.evaluate(()=>JSON.stringify(window.syntheticBudget));
 page.once('dialog',dialog=>dialog.dismiss());
 await page.getByRole('button',{name:'Void',exact:true}).first().click();
 expect(await page.evaluate(()=>window.voidId)).toBeUndefined();
 page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Void',exact:true}).first().click();
 await expect.poll(()=>page.evaluate(()=>window.voidId)).toBe('row-0');
 await expect.poll(()=>page.evaluate(()=>window.listCalls.length)).toBe(2);
 expect(await page.evaluate(()=>JSON.stringify(window.syntheticBudget))).toBe(original);
});
test('transfer rejects same account and records distinct owned IDs on phone',async({page})=>{
 await page.setViewportSize({width:390,height:844});await fixture(page);
 await page.getByLabel('Type',{exact:true}).selectOption('transfer');
 await page.getByLabel('Amount (RM)').fill('1.23');
 await page.getByRole('button',{name:'Save entry',exact:true}).click();
 await expect(page.locator('[data-save-message]')).toContainText('two different');
 expect(await page.evaluate(()=>window.calls)).toEqual([]);
 await page.getByLabel('To account').selectOption('own-b');
 page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Save entry',exact:true}).click();
 await expect(page.locator('[data-save-message]')).toContainText('Entry recorded');
 expect(await page.evaluate(()=>window.calls[0])).toMatchObject({type:'transfer',from_account_id:'own-a',to_account_id:'own-b',external_party:'',category:null,amount_cents:123});
});
test('pairing reveals credential once, revokes with confirmation, and clears token on hide',async({page})=>{
 await fixture(page);
 await expect(page.locator('[data-devices]')).toContainText('Expired');
 await page.getByLabel('Device name').fill('Synthetic shortcut');
 await page.getByRole('button',{name:'Generate private token',exact:true}).click();
 await expect(page.getByLabel('Private device token')).toHaveValue('SYNTHETIC-PRIVATE-TOKEN');
 expect(await page.evaluate(()=>window.mintPayload)).toMatchObject({name:'Synthetic shortcut',days:90});
 await expect(page.locator('[data-pair]')).toContainText('not a project publishable key');
 page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Revoke Synthetic phone',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.revoked)).toBe('device-a');
 await expect(page.locator('[data-devices]')).toContainText('No paired devices');
 await page.evaluate(()=>window.controller.hide());
 await expect(page.getByLabel('Private device token')).toHaveCount(0);
 await page.evaluate(()=>window.controller.open());
 await expect(page.getByLabel('Private device token')).toHaveCount(0);
});
test('transaction export downloads all API pages separately from budget backup and excludes credentials',async({page})=>{
 await fixture(page);
 await page.getByRole('button',{name:'Generate private token',exact:true}).click();
 await expect(page.getByLabel('Private device token')).toBeVisible();
 const downloadPromise=page.waitForEvent('download');
 await page.getByRole('button',{name:'Export all transactions (JSON)',exact:true}).click();
 const download=await downloadPromise;
 const data=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
 expect(data).toEqual({version:1,kind:'saldo-transactions',entries:[{id:'synthetic-export'}]});
 expect(JSON.stringify(data)).not.toContain('TOKEN');
});
test('retained old controls cannot write into a reopened view and old token references are cleared',async({page})=>{
 await fixture(page);
 await page.getByRole('button',{name:'Generate private token',exact:true}).click();
 await expect(page.getByLabel('Private device token')).toBeVisible();
 await page.evaluate(()=>{
 window.oldToken=document.querySelector('[data-token] textarea');
 window.oldMore=[...document.querySelectorAll('button')].find(b=>b.textContent==='Load more');
 window.oldType=document.querySelector('select[name="type"]');
 window.controller.open();
 });
 await expect(page.locator('[data-entry]')).toHaveCount(50);
 expect(await page.evaluate(()=>window.oldToken.value)).toBe('');
 const count=await page.evaluate(()=>window.listCalls.length);
 await page.evaluate(()=>{window.oldMore.click();window.oldType.value='transfer';window.oldType.dispatchEvent(new Event('change'));});
 expect(await page.evaluate(()=>window.listCalls.length)).toBe(count);
 await expect(page.getByLabel('From account')).toBeVisible();
 await expect(page.getByLabel('External party')).toBeVisible();
});
test('late async completions never mutate hidden DOM and destroy is terminal with one unsubscribe',async({page})=>{
 await fixture(page,{defer:true});
 await page.evaluate(()=>{
 window.api.mint=()=>new Promise(resolve=>window.finishMint=resolve);
 document.querySelector('[data-pair] form').requestSubmit();
 window.controller.hide();window.mutations=0;
 window.observer=new MutationObserver(records=>window.mutations+=records.length);window.observer.observe(document.querySelector('#content'),{subtree:true,childList:true,attributes:true,characterData:true});
 window.finishList();window.finishMint({token:'SYNTHETIC-LATE-TOKEN',device:{id:'late'}});
 window.changed();
 });
 await page.waitForTimeout(40);
 expect(await page.evaluate(()=>window.mutations)).toBe(0);
 await expect(page.getByLabel('Private device token')).toHaveCount(0);
 const count=await page.evaluate(()=>window.listCalls.length);
 await page.evaluate(()=>{window.controller.destroy();window.controller.destroy();window.controller.open();window.changed();});
 expect(await page.evaluate(()=>window.listCalls.length)).toBe(count);
 expect(await page.evaluate(()=>window.unsubscribed)).toBe(1);
});
test('manual refresh remains available when realtime disconnects and exposes honest status',async({page})=>{
 await fixture(page);
 await page.evaluate(()=>window.connectionStatus?.('CHANNEL_ERROR'));
 await expect(page.locator('[data-connection]')).toContainText('disconnected');
 const count=await page.evaluate(()=>window.listCalls.length);
 await page.getByRole('button',{name:'Refresh activity',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.listCalls.length)).toBe(count+1);
 await page.evaluate(()=>window.connectionStatus('SUBSCRIBED'));
 await expect(page.locator('[data-connection]')).toContainText('Connected');
});
test('ledger identifies the external side honestly and escapes arbitrary text labels',async({page})=>{
 await fixture(page);
 await page.evaluate(()=>{window.api.list=async()=>({entries:[{id:'synthetic-html',type:'income',amount_cents:1234,occurred_at:'2026-10-01T00:00:00Z',from_account_id:null,to_account_id:null,external_party:'<img src=x onerror=alert(1)>',category:null,source:'ios_shortcuts'}],hasMore:false});return window.controller.refresh();});
 const route=page.locator('[data-entry] td').nth(2);
 await expect(route).toHaveText('<img src=x onerror=alert(1)> → Unassigned');
 expect(await page.locator('[data-entry] img').count()).toBe(0);
});
test('failed pagination retains entries with explicit error and a working retry',async({page})=>{
 await fixture(page);
 await page.evaluate(()=>{window.originalList=window.api.list;window.api.list=async()=>{throw Error('Synthetic page unavailable')};});
 await page.getByRole('button',{name:'Load more',exact:true}).click();
 await expect(page.locator('[data-history]')).toContainText('Synthetic page unavailable');
 await expect(page.locator('[data-entry]')).toHaveCount(50);
 await page.evaluate(()=>window.api.list=window.originalList);
 await page.getByRole('button',{name:'Retry history',exact:true}).click();
 await expect(page.locator('[data-entry]')).toHaveCount(51);
});
test('pairing instructions use integer cents and display owned account IDs without exposing excluded recipients',async({page})=>{
 await fixture(page);
 await expect(page.locator('[data-pair]')).toContainText('amount_cents');
 await expect(page.locator('[data-pair]')).toContainText('own-a');
 await expect(page.locator('[data-pair]')).not.toContainText('External excluded');
 await expect(page.getByLabel('External party')).toHaveAttribute('maxlength','160');
 await expect(page.getByLabel('Device name')).toHaveAttribute('maxlength','80');
});
test('phone expense accepts an unassigned owned side, uses editable occurrence time, and preserves the budget',async({page})=>{
 await page.setViewportSize({width:390,height:844});await fixture(page);
 const budget=await page.evaluate(()=>JSON.stringify(window.syntheticBudget));
 await page.getByLabel('External party').fill('Synthetic street stall');
 await page.getByLabel('Amount (RM)').fill('5.67');
 await page.getByLabel('Date and time').fill('2026-09-05T08:30');
 await page.getByLabel('Category').selectOption('entertainment');
 page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Save entry',exact:true}).click();
 await expect(page.locator('[data-save-message]')).toContainText('Entry recorded');
 expect(await page.evaluate(()=>window.calls[0])).toMatchObject({type:'expense',amount_cents:567,from_account_id:null,to_account_id:null,external_party:'Synthetic street stall',category:'entertainment',occurred_at:'2026-09-05T08:30:00.000Z'});
 expect(await page.evaluate(()=>JSON.stringify(window.syntheticBudget))).toBe(budget);
});
test('pending save survives hiding and a late acknowledgement cannot overwrite reopened editor state',async({page})=>{
 await fixture(page);await page.evaluate(()=>window.deferCreate=true);
 page.on('dialog',dialog=>dialog.accept());
 await page.getByLabel('Amount (RM)').fill('4.56');
 await page.getByRole('button',{name:'Save entry',exact:true}).click();
 await expect(page.getByRole('button',{name:'Save entry',exact:true})).toBeDisabled();
 await page.evaluate(()=>{window.controller.hide();window.controller.open();window.deferCreate=false;window.finishCreate();});
 await expect(page.locator('[data-save-message]')).toContainText('uncertain');
 await page.getByRole('button',{name:'Retry same entry',exact:true}).click();
 await expect(page.locator('[data-save-message]')).toContainText('already recorded');
 const calls=await page.evaluate(()=>window.calls);expect(calls[0]).toEqual(calls[1]);
});
test('late metadata failure cannot erase an uncertain entry retry',async({page})=>{
 await fixture(page,{failCreate:true});
 await page.evaluate(()=>{window.api.metadata=()=>new Promise((resolve,reject)=>window.rejectMetadata=reject);window.controller.open();});
 page.once('dialog',dialog=>dialog.accept());
 await page.getByLabel('Amount (RM)').fill('2.34');
 await page.getByRole('button',{name:'Save entry',exact:true}).click();
 await expect(page.getByRole('button',{name:'Retry same entry',exact:true})).toBeVisible();
 await page.evaluate(()=>window.rejectMetadata(Error('Synthetic metadata unavailable')));
 await expect(page.getByRole('button',{name:'Retry same entry',exact:true})).toBeVisible();
 await expect(page.locator('[data-metadata-message]')).toContainText('Synthetic metadata unavailable');
});
test('unassigned active entry can be assigned to an owned account only after acknowledgement',async({page})=>{
 await page.setViewportSize({width:390,height:844});await fixture(page);
 await page.evaluate(()=>{
 window.assignRow={id:'synthetic-unassigned',type:'expense',amount_cents:234,occurred_at:'2026-10-03T12:00:00Z',from_account_id:null,to_account_id:null,external_party:'Synthetic vendor',category:null,source:'manual'};
 window.api.list=async()=>({entries:[window.assignRow,{...window.assignRow,id:'voided',voided_at:'2026-10-04T12:00:00Z'},{...window.assignRow,id:'transfer',type:'transfer',from_account_id:'own-a',to_account_id:'own-b'}],hasMore:false});
 window.api.assign=async(id,details)=>{window.assignment={id,details};await new Promise(resolve=>window.finishAssign=resolve);window.assignRow={...window.assignRow,from_account_id:details.accountId,category:details.category};return window.assignRow};
 return window.controller.refresh();
 });
 await expect(page.getByRole('button',{name:'Assign account',exact:true})).toHaveCount(1);
 await page.getByRole('button',{name:'Assign account',exact:true}).click();
 await page.getByLabel('Assign owned account').selectOption('own-b');
 await page.getByLabel('Assignment category').selectOption('commitment');
 await page.getByRole('button',{name:'Confirm assignment',exact:true}).click();
 await expect(page.getByRole('button',{name:'Confirm assignment',exact:true})).toBeDisabled();
 await expect(page.locator('[data-entry="synthetic-unassigned"]')).toContainText('Unassigned → Synthetic vendor');
 expect(await page.evaluate(()=>window.assignment)).toEqual({id:'synthetic-unassigned',details:{accountId:'own-b',category:'commitment'}});
 await page.evaluate(()=>window.finishAssign());
 await expect(page.locator('[data-entry="synthetic-unassigned"]')).toContainText('Synthetic wallet → Synthetic vendor');
 await expect(page.getByRole('button',{name:'Assign account',exact:true})).toHaveCount(0);
});
test('assignment drafts survive realtime and late assignment errors cannot write after hiding',async({page})=>{
 await fixture(page);
 await page.evaluate(()=>{window.api.list=async()=>({entries:[{id:'synthetic-income',type:'income',amount_cents:100,occurred_at:'2026-10-03T00:00:00Z',to_account_id:null,from_account_id:null,external_party:'Synthetic sender'}],hasMore:false});window.api.assign=()=>new Promise((resolve,reject)=>window.rejectAssign=reject);return window.controller.refresh();});
 await page.getByRole('button',{name:'Assign account',exact:true}).click();
 await page.getByLabel('Assign owned account').selectOption('own-b');
 await page.evaluate(()=>window.changed());
 await expect(page.getByLabel('Assign owned account')).toHaveValue('own-b');
 await expect(page.getByLabel('Assignment category')).toHaveCount(0);
 await page.getByRole('button',{name:'Confirm assignment',exact:true}).click();
 await expect(page.getByRole('button',{name:'Confirm assignment',exact:true})).toBeDisabled();
 await page.evaluate(()=>{window.controller.hide();window.assignMutations=0;new MutationObserver(records=>window.assignMutations+=records.length).observe(document.querySelector('#content'),{subtree:true,childList:true,characterData:true,attributes:true});window.rejectAssign(Error('Synthetic stale assignment failure'));});
 await page.waitForTimeout(30);
 expect(await page.evaluate(()=>window.assignMutations)).toBe(0);
});
test('phone history uses full database summary and loads all pages without resetting editor',async({page},testInfo)=>{
 await page.setViewportSize({width:390,height:844});await fixture(page);
 await expect(page.getByRole('heading',{name:'Money tracker'})).toBeVisible();
 await expect(page.locator('[data-summary]')).toContainText('RM 5,678.00');
 await expect(page.locator('[data-entry]')).toHaveCount(50);
 await page.getByLabel('Note').fill('Synthetic draft');
 await page.getByRole('button',{name:'Load more',exact:true}).click();
 await expect(page.locator('[data-entry]')).toHaveCount(51);
 await page.evaluate(()=>window.changed());
 await expect(page.locator('[data-entry]')).toHaveCount(50);
 await expect(page.getByLabel('Note')).toHaveValue('Synthetic draft');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect(await page.getByLabel('From account').locator('option').allTextContents()).not.toContain('External excluded');
 await page.locator('.activity-form').first().screenshot({path:testInfo.outputPath('synthetic-phone-form.png')});
 await page.getByRole('heading',{name:'Money tracker'}).scrollIntoViewIfNeeded();
 await page.screenshot({path:testInfo.outputPath('synthetic-phone-summary.png')});
});

test('repeated pairing zeroizes detached prior tokens before replacement and hide',async({page})=>{
 await fixture(page);await page.evaluate(()=>{let count=0;window.api.mint=async()=>({device:{id:'synthetic-device-'+(++count)},token:'SYNTHETIC-TOKEN-'+count})});
 await page.getByRole('button',{name:'Generate private token',exact:true}).click();
 await expect(page.getByLabel('Private device token')).toHaveValue('SYNTHETIC-TOKEN-1');
 await page.evaluate(()=>window.firstToken=document.querySelector('[data-token] textarea'));
 await page.getByRole('button',{name:'Generate private token',exact:true}).click();
 await expect(page.getByLabel('Private device token')).toHaveValue('SYNTHETIC-TOKEN-2');
 expect(await page.evaluate(()=>window.firstToken.value)).toBe('');
 await page.evaluate(()=>{window.secondToken=document.querySelector('[data-token] textarea');window.controller.hide()});
 expect(await page.evaluate(()=>[window.firstToken.value,window.secondToken.value])).toEqual(['','']);
});


test('disconnected concurrent inserts do not duplicate cursor-paged history and refresh admits new rows',async({page})=>{
 await fixture(page);await page.evaluate(async()=>{
  window.cursorRows=Array.from({length:60},(_,i)=>({id:'history-'+i,type:'expense',amount_cents:100,occurred_at:'2026-10-10T12:00:00Z',from_account_id:'own-a',external_party:'Historical shop'}));
  window.api.list=async(month,cursor=null)=>{const start=cursor?window.cursorRows.findIndex(r=>r.id===cursor.id)+1:0;const entries=window.cursorRows.slice(start,start+50);const hasMore=start+entries.length<window.cursorRows.length;return {entries,hasMore,nextCursor:hasMore?{id:entries.at(-1).id,occurred_at:entries.at(-1).occurred_at}:null}};
  window.connectionStatus('CHANNEL_ERROR');await window.controller.refresh();
 });
 await expect(page.locator('[data-entry]')).toHaveCount(50);
 await page.evaluate(()=>window.cursorRows.unshift({...window.cursorRows[0],id:'newer-entry',external_party:'Newer shop',occurred_at:'2026-10-11T00:00:00Z'}));
 await page.getByRole('button',{name:'Load more',exact:true}).click();
 await expect(page.locator('[data-entry]')).toHaveCount(60);
 expect(await page.locator('[data-entry]').evaluateAll(rows=>new Set(rows.map(r=>r.dataset.entry)).size)).toBe(60);
 await expect(page.locator('[data-entry="newer-entry"]')).toHaveCount(0);
 await expect(page.locator('[data-history]')).toContainText('Refresh activity loads new entries');
 await page.getByRole('button',{name:'Refresh activity',exact:true}).click();
 await expect(page.locator('[data-entry="newer-entry"]')).toHaveCount(1);
 await page.getByRole('button',{name:'Load more',exact:true}).click();
 await expect(page.locator('[data-entry]')).toHaveCount(61);
 expect(await page.locator('[data-entry]').evaluateAll(rows=>new Set(rows.map(r=>r.dataset.entry)).size)).toBe(61);
});
