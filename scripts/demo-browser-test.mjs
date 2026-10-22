import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE??'playwright');
const prefix='/agent-fault-lab/';
const server=createServer(async(req,res)=>{
  const name=req.url.slice(prefix.length)||'index.html';
  if(!req.url.startsWith(prefix)||!['index.html','app.mjs','demo.mjs','catalog.mjs','style.css','favicon.svg'].includes(name)){res.writeHead(404);res.end();return;}
  const mime=name.endsWith('.mjs')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html';
  res.setHeader('Content-Type',mime+'; charset=utf-8');res.end(await readFile(new URL('../dist/'+name,import.meta.url)));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}}), errors=[], apiCalls=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.url().includes('/api/'))apiCalls.push(r.url());});
  const base=process.env.DEMO_URL??`http://127.0.0.1:${server.address().port}${prefix}`;
  await page.goto(base);
  await page.locator('.scenario').last().waitFor();
  assert.match(await page.locator('.demo-banner').innerText(),/浏览器模拟/);
  for(const id of ['lost-response','network-partition','commit-disconnect','process-crash','duplicate-delivery','rate-limit','corrupt-response','baseline']){
    await page.locator(`.scenario[data-id="${id}"]`).click();
    await page.locator('#launch').click();
    await page.waitForFunction(()=>document.querySelector('#result-label').textContent==='已完成');
    assert.equal(await page.locator('.result-card .badge.passed').count(),['network-partition','rate-limit','baseline'].includes(id)?2:1,id);
    assert.equal(await page.locator('.result-card').count(),2);
  }
  await page.locator('#play').click();
  await page.waitForFunction(()=>Number(document.querySelector('#scrub').value)>2);
  await page.locator('#play').click();
  const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();
  const download=await downloadPromise;
  const exported=JSON.parse(await readFile(await download.path(),'utf8'));
  assert.equal(exported.mode,'browser-simulation');
  await page.reload();await page.locator('.scenario').last().waitFor();
  await page.locator('[data-view="history"]').click();
  await page.locator('.history-row').first().waitFor();assert.equal(await page.locator('.history-row').count(),16);
  await page.locator('.history-row').first().click();
  await page.locator('#rerun').click();await page.waitForFunction(()=>document.querySelector('#result-label').textContent==='已完成');
  await page.locator('.scenario[data-id="process-crash"]').click();await page.locator('#launch').click();await page.locator('#cancel').click();
  await page.waitForFunction(()=>document.querySelector('#result-label').textContent==='已完成');
  assert.equal(await page.locator('.result-card .badge.failed').count(),2);
  await mkdir('test-results',{recursive:true});
  await page.screenshot({path:'test-results/online-demo.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);assert.deepEqual(apiCalls,[]);
  console.log('Online demo passed: all 8 scenarios, nested URL, simulation disclosure, playback, JSON export, persistence, replay, cancellation, mobile; no API requests or JS errors.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
