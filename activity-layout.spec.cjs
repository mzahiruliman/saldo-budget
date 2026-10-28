const {test,expect}=require('@playwright/test');
const HOST='https://cxezfmlzvyodmjxtjtzb.supabase.co';
const UID='11111111-1111-4111-8111-111111111111';
// Full compiled app + global/cloud/Activity CSS. HTTP and sessions are synthetic.
async function openActivity(page,context){
 const {initialState}=await import('./model.mjs');const budget=initialState();
 await context.routeWebSocket('**',ws=>ws.close());
 await context.addInitScript(({UID})=>{
  localStorage.setItem('saldo-cloud-connection-v1','sb_publishable_SYNTHETIC_LAYOUT_TEST_ONLY');
  localStorage.setItem('sb-cxezfmlzvyodmjxtjtzb-auth-token',JSON.stringify({access_token:btoa('{}')+'.'+btoa(JSON.stringify({sub:UID,role:'authenticated',exp:2100000000}))+'.synthetic',refresh_token:'synthetic',token_type:'bearer',expires_at:2100000000,user:{id:UID,aud:'authenticated',role:'authenticated'}}));
 },{UID});
 await context.route(HOST+'/**',async route=>{
  const path=new URL(route.request().url()).pathname;let data;
  if(path==='/rest/v1/budget_documents')data=[{user_id:UID,payload:budget,revision:1}];
  else if(path==='/rest/v1/rpc/tracker_metadata')data={accounts:budget.accounts.filter(a=>!['recipient','external'].includes(a.type)),categories:['commitment','entertainment','savings']};
  else if(path==='/rest/v1/rpc/tracker_summary')data={income_cents:0,expense_cents:0,transfer_cents:0,unassigned_income_cents:0,unassigned_expense_cents:0,movements:{}};
  else if(path==='/rest/v1/rpc/list_shortcut_devices'||path==='/rest/v1/transactions')data=[];
  else return route.fulfill({status:400,json:{message:'Unexpected synthetic layout request '+path}});
  return route.fulfill({json:data,headers:{'access-control-allow-origin':'*'}});
 });
 await page.goto('/saldo-budget/');await expect(page.locator('#save-status')).toContainText('Ready');
 await page.getByRole('button',{name:'Activity',exact:true}).click();
 await expect(page.locator('.activity-summary')).toContainText('RM 0.00');await page.evaluate(()=>document.fonts.ready);await expect(page.locator('[data-metadata-message]')).toBeEmpty();
}
for(const engine of ['chromium','webkit'])test.describe('Full-style Activity layout '+engine,()=>{
 for(const width of [375,393,430,768,1440])test('aligned at '+width+'px',async({playwright},testInfo)=>{
  const browser=await playwright[engine].launch({headless:true,args:engine==='chromium'?['--no-sandbox']:[]});
  const context=await browser.newContext({viewport:{width,height:1000},isMobile:width<=700,hasTouch:width<=700});const page=await context.newPage();
  try {
  await page.setViewportSize({width,height:1000});await openActivity(page,context);
  const boxes=await page.evaluate(()=>{
   const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
   return {header:rect('.activity-heading'),title:rect('.activity-heading > div:first-child'),actions:rect('.activity-heading .activity-actions'),month:rect('.activity-view > [data-month]'),panel:rect('.activity-panel'),type:rect('.activity-form select[name="type"]'),from:rect('.activity-form select[name="from"]'),amount:rect('.activity-form input[name="amount"]'),date:rect('.activity-form input[name="occurred"]'),fits:document.documentElement.scrollWidth<=innerWidth};
  });
  expect(boxes.title.y,'title must stay inside its own header').toBeGreaterThanOrEqual(boxes.header.y-1);
  expect(boxes.title.bottom,'description must fit inside auto-sized header').toBeLessThanOrEqual(boxes.header.bottom+1);
  expect(boxes.actions.bottom,'actions must fit inside header').toBeLessThanOrEqual(boxes.header.bottom+1);
  expect(boxes.header.bottom,'empty metadata must not reserve a phantom grid row').toBeLessThanOrEqual(Math.max(boxes.title.bottom,boxes.actions.bottom)+1);
  expect(boxes.month.y,'month must not overlap heading or controls').toBeGreaterThanOrEqual(Math.max(boxes.title.bottom,boxes.actions.bottom)+7);
  expect(Math.abs(boxes.header.x-boxes.panel.x),'heading must align with cards').toBeLessThanOrEqual(1);
  const heights=[boxes.type.height,boxes.from.height,boxes.amount.height,boxes.date.height];
  expect(Math.min(...heights),'every field must have a usable touch height').toBeGreaterThanOrEqual(44);
  expect(Math.max(...heights)-Math.min(...heights),'native select/date/text heights must match').toBeLessThanOrEqual(1);
  expect(boxes.fits,'no horizontal page overflow').toBe(true);
  if(width<=700){expect(boxes.actions.y).toBeGreaterThanOrEqual(boxes.title.bottom+7);expect(boxes.from.y).toBeGreaterThan(boxes.type.bottom)}
  else expect(Math.abs(boxes.type.y-boxes.from.y),'desktop row alignment').toBeLessThanOrEqual(1);
  if(width===393||width===1440){
   await page.screenshot({path:`test-results/activity-layout-${engine}-${width}.png`,fullPage:false});
   await page.locator('.activity-panel').first().screenshot({path:`test-results/activity-form-${engine}-${width}.png`});
  }
  } finally {await browser.close()}
 });
});
