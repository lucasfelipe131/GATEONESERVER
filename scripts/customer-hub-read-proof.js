import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createDb, getSetting, setSetting } from '../src/db.js';
import { getRuntimeConfig } from '../src/integrations/runtime-config.js';
import { testBitPanelConnection, readBitPanelLinkedAccess, readBitPanelCustomerInformation, previewBitPanelRenewal, isGateOneOwner } from '../src/integrations/bitpanel.js';
import { CustomerAccessSync } from '../src/services/customer-access-sync.js';
import { expirationForPlan } from '../src/core/renewal-orchestrator.js';
import { dateOnlyInTimezone } from '../src/domain/billing.js';
import { buildCustomerHelp } from '../src/services/customer-help-content.js';

const plansToProve = [['monthly',1,3000],['quarterly',3,8500],['semiannual',6,15000],['annual',12,27000]];
const fail = code => Object.assign(new Error(code), {code});
// Receipts are process-local. JSON output cannot be replayed to enable automation.
const receipts = new WeakMap();
const MAX_RECEIPT_AGE_MS = 60_000;
const allowedErrors = new Set(['READ_PROOF_PROJECT_MISMATCH','READ_PROOF_ENVIRONMENT_MISMATCH','READ_PROOF_VERSION_MISMATCH',
  'READ_PROOF_MIGRATION_REQUIRED','READ_PROOF_SESSION_REQUIRED','READ_PROOF_PLANS_MISMATCH','READ_PROOF_CONTENT_UNAVAILABLE','READ_PROOF_NO_VERIFIED_CUSTOMER',
  'READ_PROOF_UNAVAILABLE','READ_PROOF_RECEIPT_REQUIRED','READ_PROOF_STALE','READ_PROOF_RUNTIME_CHANGED',
  'READ_PROOF_CONTENT_CACHE_UNAVAILABLE','READ_PROOF_BALANCE_UNVERIFIED','BITPANEL_READ_LINK_UNVERIFIED','BITPANEL_READ_REAUTH_REQUIRED','BITPANEL_READ_UNAVAILABLE',
  'BITPANEL_READ_TIMEOUT','RENEWAL_PROVIDER_QUOTE_MISMATCH','RENEWAL_PROVIDER_EXPIRATION_MISMATCH',
  'RENEWAL_PREVIEW_UNAVAILABLE','RENEWAL_PREVIEW_CLOSE_FAILED']);
const safeCode = error => allowedErrors.has(error?.code) ? error.code : 'READ_PROOF_UNAVAILABLE';
export {safeCode as customerHubReadProofErrorCode};
const retryable = new Set(['BITPANEL_READ_LINK_UNVERIFIED','RENEWAL_PROVIDER_EXPIRATION_MISMATCH','RENEWAL_PROVIDER_QUOTE_MISMATCH']);
const sameBinding = (left,right) => ['customer_id','subscription_id','list_id','username','owner','whatsapp_e164','expires_on']
  .every(key => left?.[key] === right?.[key]);
const validBinding = binding => binding && /^[1-9]\d{0,19}$/.test(String(binding.list_id || '')) &&
  /^[1-9]\d{7,14}$/.test(String(binding.whatsapp_e164 || '')) && isGateOneOwner(binding.owner) &&
  typeof binding.username === 'string' && binding.username.trim() === binding.username &&
  binding.username.length > 0 && binding.username.length <= 120 && !/[\r\n\x00]/.test(binding.username) &&
  /^\d{4}-\d{2}-\d{2}$/.test(String(binding.expires_on || ''));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const runtimeDigest = runtime => digest(Object.fromEntries(Object.entries(runtime).filter(([key]) =>
  /^BITPANEL_(?:BASE_URL|LOGIN_URL|USERNAME|PASSWORD|STORAGE_STATE|PLAN_LABEL|DEFAULT_CONNECTIONS|TV_PACKAGE)$/.test(key))));
const contentSnapshot = catalog => ({bitpanelSync:catalog?.bitpanelSync,
  posts:(Array.isArray(catalog?.posts) ? catalog.posts : []).filter(post => post.source === 'bitpanel'),dns:catalog?.dns});

export async function readCustomerHubProofPlans(db,{lock=false}={}) {
  const plans={};
  for(const [code,months,price] of plansToProve) {
    const rows=(await db.query(`SELECT duration_months,price_cents FROM plans WHERE code=$1 AND active=true${lock ? ' FOR SHARE' : ''}`,[code])).rows;
    if(rows.length!==1 || rows[0].duration_months!==months || rows[0].price_cents!==price) throw fail('READ_PROOF_PLANS_MISMATCH');
    plans[code]={durationMonths:months,priceCents:price,creditCost:months};
  }
  return plans;
}

export function normalizeCustomerHubReadProofContent(information, source, date) {
  const raw=Array.isArray(information?.posts) ? information.posts : [];
  const noticesUrl=`${source.origin}/notices`,newsUrl=`${source.origin}/news`;
  const fresh=value=>{
    const age=date.getTime()-new Date(value).getTime();
    return Number.isFinite(age) && age>=0 && age<=60_000;
  };
  const eligible=raw.slice(0,80).filter(post=>post?.source==='bitpanel' &&
    [noticesUrl,newsUrl].includes(post.url) && fresh(post.verifiedAt));
  const help=buildCustomerHelp({catalog:{posts:eligible,bitpanelSync:{status:'READY'}},now:date});
  // The public boundary owns text/link/date filtering. Reuse only its accepted
  // records; never cache a blocked raw post or loosen that boundary for proof.
  const posts=help.telegram.posts.map(post=>({...post,source:'bitpanel'}));
  const acceptedNotices=posts.filter(post=>post.url===noticesUrl).length;
  const acceptedNews=posts.filter(post=>post.url===newsUrl).length;
  const rawNotices=raw.filter(post=>post?.url===noticesUrl).length;
  const rawNews=raw.filter(post=>post?.url===newsUrl).length;
  return {information:{...information,posts},metadata:{rawPosts:raw.length,acceptedPosts:posts.length,
    rejectedPosts:raw.length-posts.length,acceptedNotices,acceptedNews,
    rejectedNotices:rawNotices-acceptedNotices,rejectedNews:rawNews-acceptedNews}};
}

function assertFreshContent(information, source, date) {
  const help=buildCustomerHelp({catalog:{posts:information.posts,dns:information.dns,bitpanelSync:{status:'READY'}},now:date});
  const age=value => date.getTime()-new Date(value).getTime();
  if(information.status!=='READY' || !Number.isFinite(age(information.verifiedAt)) || age(information.verifiedAt)<0 ||
    age(information.verifiedAt)>60_000 ||
    !information.posts.some(post=>post.url===`${source.origin}/notices`) ||
    !information.posts.some(post=>post.url===`${source.origin}/news`) ||
    help.telegram.posts.length!==information.posts.length || help.dns.length!==information.dns.length ||
    help.telegram.posts.some(post=>!Number.isFinite(age(post.verifiedAt)) || age(post.verifiedAt)<0 || age(post.verifiedAt)>60_000) ||
    help.dns.some(item=>item.status!=='current' || item.sourceUrl!==`${source.origin}/notices` ||
      !Number.isFinite(age(item.verifiedAt)) || age(item.verifiedAt)<0 || age(item.verifiedAt)>60_000))
    throw fail('READ_PROOF_CONTENT_UNAVAILABLE');
}

async function cacheInformation(db,information,date) {
  return db.transaction(async client=>{
    await client.query("INSERT INTO system_settings(key,value) VALUES('customer_help_catalog','{}'::jsonb) ON CONFLICT(key) DO NOTHING");
    const row=(await client.query("SELECT value FROM system_settings WHERE key='customer_help_catalog' FOR UPDATE")).rows[0];
    const previous=row?.value && typeof row.value==='object' ? row.value : {};
    const catalog={...previous,bitpanelSync:{status:'READY',sourceUrl:information.source,
      syncedAt:date.toISOString(),attemptedAt:date.toISOString(),lastErrorCode:null},
      posts:[...(Array.isArray(previous.posts)?previous.posts.filter(post=>post.source!=='bitpanel'):[]),...information.posts].slice(-60),
      dns:information.dns};
    if(information.telegram) catalog.telegram=information.telegram;
    if(information.downloadsUrl) catalog.downloadsUrl=information.downloadsUrl;
    await setSetting(client,'customer_help_catalog',catalog);
    return digest(contentSnapshot(catalog));
  });
}

export async function assertCustomerHubReadProofReady({db,config,proof,expectedSha,env=process.env,
  runtimeConfig=()=>getRuntimeConfig(db,config),now=()=>new Date(),lock=false,requireBalance=false}={}) {
  assertCustomerHubReadProofEnvironment({env,expectedSha});
  const receipt=receipts.get(proof);
  if(!receipt || receipt.sha!==expectedSha || proof?.proved!==true || !receipt.contentDigest ||
    proof.proofs?.renewalPreview?.validated!==4 || proof.proofs.renewalPreview.submitted!==0 ||
    proof.proofs.content?.cacheStatus!=='READY') throw fail('READ_PROOF_RECEIPT_REQUIRED');
  if(requireBalance && receipt.balanceVerified!==4) throw fail('READ_PROOF_BALANCE_UNVERIFIED');
  const age=now().getTime()-new Date(receipt.completedAt).getTime();
  if(!Number.isFinite(age) || age<0 || age>MAX_RECEIPT_AGE_MS) throw fail('READ_PROOF_STALE');
  if(runtimeDigest(await runtimeConfig())!==receipt.runtimeDigest) throw fail('READ_PROOF_RUNTIME_CHANGED');
  if(digest(await readCustomerHubProofPlans(db,{lock}))!==digest(receipt.plans)) throw fail('READ_PROOF_PLANS_MISMATCH');
  const sync=new CustomerAccessSync({db,config:{...config,BITPANEL_BASE_URL:receipt.sourceOrigin},now,readInformation:null});
  const {binding,metadata}=await sync.view(db,receipt.binding.customer_id,lock);
  if(!sameBinding(binding,receipt.binding) || await sync.conflicting(db,binding) || metadata.status!=='READY' ||
    metadata.passwordAvailable!==true || digest(binding.access_password_encrypted)!==receipt.accessCipherDigest ||
    new Date(metadata.syncedAt).toISOString()!==receipt.accessSyncedAt)
    throw fail('BITPANEL_READ_LINK_UNVERIFIED');
  if(lock) await db.query("SELECT value FROM system_settings WHERE key='customer_help_catalog' FOR SHARE");
  if(digest(contentSnapshot(await getSetting(db,'customer_help_catalog',{})))!==receipt.contentDigest)
    throw fail('READ_PROOF_CONTENT_CACHE_UNAVAILABLE');
  assertCustomerHubReadProofEnvironment({env,expectedSha});
  return {plans:receipt.plans,validatedAt:receipt.completedAt,sourceUrl:`${receipt.sourceOrigin}/list`};
}

export function assertCustomerHubReadProofEnvironment({env=process.env,expectedSha}={}) {
  if (env.RAILWAY_PROJECT_ID !== 'a0f107fe-acaf-459f-a640-38ef6010d1e5') throw fail('READ_PROOF_PROJECT_MISMATCH');
  if (env.RAILWAY_ENVIRONMENT_ID !== '697f58fb-5084-4cb3-bd9a-ecdbc921b7bc') throw fail('READ_PROOF_ENVIRONMENT_MISMATCH');
  if (!/^[a-f0-9]{40}$/.test(expectedSha || '') || env.RAILWAY_GIT_COMMIT_SHA !== expectedSha) throw fail('READ_PROOF_VERSION_MISMATCH');
}

export async function runCustomerHubReadProof({db,config,runtimeConfig=()=>getRuntimeConfig(db,config),
  testConnection=testBitPanelConnection,readAccess=readBitPanelLinkedAccess,previewRenewal=previewBitPanelRenewal,
  readInformation=readBitPanelCustomerInformation,
  now=()=>new Date(),expectedSha,env=process.env,cacheContent=false}={}) {
  const proofs={session:{status:'UNAVAILABLE'},customerAccess:{status:'UNAVAILABLE',attempted:0,cached:0,conflictsSkipped:0},
    renewalPreview:{status:'UNAVAILABLE',plans:4,validated:0,submitted:0},content:{status:'UNAVAILABLE',posts:0,dns:0,sources:[]}};
  const failures={};
  const result=()=>({proved:false,proofs,failures,realTestCharges:0,realTestMessages:0,realTestRenewals:0});
  const recordFailure=error=>{const code=safeCode(error);failures[code]=(failures[code] || 0)+1;return code;};
  try {
    if(expectedSha || cacheContent) assertCustomerHubReadProofEnvironment({env,expectedSha});
    if (!(await db.query("SELECT to_regclass('customer_access_sync') AS access_table")).rows[0]?.access_table)
      throw fail('READ_PROOF_MIGRATION_REQUIRED');
    const runtime={...await runtimeConfig(),BITPANEL_READ_TIMEOUT_MS:30_000};
    if (!runtime.BITPANEL_STORAGE_STATE) throw fail('READ_PROOF_SESSION_REQUIRED');
    let source;
    try {source=new URL(runtime.BITPANEL_BASE_URL);} catch {throw fail('BITPANEL_READ_LINK_UNVERIFIED');}
    if (source.protocol!=='https:' || !['bitpanel.vip','www.bitpanel.vip'].includes(source.hostname) ||
      source.username || source.password || source.port || source.search || source.hash || source.pathname!=='/')
      throw fail('BITPANEL_READ_LINK_UNVERIFIED');
    if ((await testConnection(runtime))?.ok !== true) throw fail('BITPANEL_READ_REAUTH_REQUIRED');
    proofs.session={status:'READY',protectedSession:true};
    const rawInformation=await readInformation(runtime);
    const normalized=normalizeCustomerHubReadProofContent(rawInformation,source,now());
    const information=normalized.information;
    proofs.content={...proofs.content,...normalized.metadata};
    const contentSources=new Set([`${source.origin}/notices`,`${source.origin}/news`]);
    if(information?.source!==`${source.origin}/notices` || !Array.isArray(information.posts) || !information.posts.length ||
      information.dnsVerified!==true || !Array.isArray(information.dns) || !information.dns.length ||
      information.posts.some(post=>!contentSources.has(post.url)) ||
      information.dns.some(dns=>dns.sourceUrl!==`${source.origin}/notices` || dns.status!=='READY'))
      throw fail('READ_PROOF_CONTENT_UNAVAILABLE');
    proofs.content={status:'UNAVAILABLE',...normalized.metadata,posts:information.posts.length,dns:information.dns.length,
      sources:[...new Set([...information.posts.map(post=>post.url),...information.dns.map(dns=>dns.sourceUrl)])]};
    assertFreshContent(information,source,now());
    proofs.content.status='READY';
    const plans=await readCustomerHubProofPlans(db);
    // Proposed quote policy stays in memory. This proof cannot activate it.
    const policy={enabled:true,planLabel:'30',unitPriceCents:3000,maxConnections:1,maxCreditsPerRenewal:12,plans};
    const previewConfig={...runtime,BITPANEL_AUTOMATIC_RENEWAL_POLICY:policy};
    const sync=new CustomerAccessSync({db,config:{...config,BITPANEL_BASE_URL:source.origin},now,readInformation:null});
    // A matching recent cache only chooses which account to try first. The
    // live read and all four provider quotes below remain mandatory.
    const candidates=(await db.query(`SELECT c.id FROM customers c
      JOIN LATERAL (SELECT id,bitpanel_list_id FROM subscriptions WHERE customer_id=c.id
        ORDER BY created_at DESC,id DESC LIMIT 1) s ON true
      LEFT JOIN customer_access_sync a ON a.customer_id=c.id
      WHERE c.automation_eligible IS TRUE AND c.whatsapp_e164 ~ '^[1-9][0-9]{7,14}$'
        AND c.bitpanel_reference IS NOT NULL AND trim(c.bitpanel_reference)<>''
        AND regexp_replace(lower(normalize(c.bitpanel_owner,NFD)),'[^a-z0-9]','','g') IN ('gateoneproserver','gateoneserver')
        AND s.bitpanel_list_id ~ '^[1-9][0-9]{0,19}$'
      ORDER BY CASE WHEN a.status='READY' AND a.subscription_id=s.id AND a.list_id=s.bitpanel_list_id
        AND a.username=c.bitpanel_reference AND a.owner=c.bitpanel_owner AND a.verified_whatsapp_e164=c.whatsapp_e164
        AND a.source_url=$2 || '/list/view/' || s.bitpanel_list_id
        AND a.verified_at IS NOT NULL AND a.verified_at <= $1::timestamptz
        AND a.verified_at >= $1::timestamptz - interval '24 hours'
        THEN 0 ELSE 1 END,c.id LIMIT 5`,[now().toISOString(),source.origin])).rows;
    for(const candidate of candidates) {
      if(proofs.customerAccess.attempted>=3) break;
      const binding=await sync.binding(db,candidate.id);
      if(!validBinding(binding) || await sync.conflicting(db,binding)) {
        proofs.customerAccess.conflictsSkipped++;
        continue;
      }
      proofs.customerAccess.attempted++;
      try {
        const observed=await readAccess(runtime,{listId:binding.list_id,username:binding.username,owner:binding.owner});
        await sync.saveSuccess(binding,observed,runtime);
        const metadata=await sync.metadata(candidate.id);
        if(metadata.status!=='READY' || metadata.passwordAvailable!==true) throw fail('BITPANEL_READ_LINK_UNVERIFIED');
        proofs.customerAccess.cached++;
        proofs.customerAccess.status='READY';
        let validated=0,balanceVerified=0;
        for(const [code,months] of plansToProve) {
          const today=dateOnlyInTimezone(now(),config.TIMEZONE || 'America/Sao_Paulo');
          const expected=expirationForPlan(binding.expires_on>today?binding.expires_on:today,{durationMonths:months});
          const preview=await previewRenewal(previewConfig,{bitpanel_list_id:binding.list_id,bitpanel_reference:binding.username,
            bitpanel_owner:binding.owner,current_expiry:binding.expires_on,expected_expiration:expected,
            duration_months:months,plan_code:code,expected_credit_cost:months,automatic_renewal:true,charge_stage:'manual'});
          const quote=preview?.quote;
          if(preview?.prepared!==true || preview.submitted!==false || preview.sourceUrl!==`${source.origin}/list/view/${binding.list_id}` ||
            quote?.listId!==binding.list_id || quote.planLabel!==policy.planLabel || quote.months!==months ||
            quote.connections!==1 || quote.credits!==months || quote.unitPriceCents!==3000 || quote.totalPriceCents!==3000*months)
            throw fail('RENEWAL_PROVIDER_QUOTE_MISMATCH');
          validated++;
          const balance=preview.balance;
          if(balance?.status==='verified' && Number.isSafeInteger(balance.availableCredits) && balance.availableCredits>=0 &&
            balance.sufficient===(balance.availableCredits>=quote.credits)) balanceVerified++;
        }
        const finalMetadata=await sync.metadata(candidate.id),finalBinding=await sync.binding(db,candidate.id);
        if(!sameBinding(binding,finalBinding) || finalMetadata.status!=='READY' || finalMetadata.passwordAvailable!==true)
          throw fail('BITPANEL_READ_LINK_UNVERIFIED');
        proofs.renewalPreview={status:'READY',plans:4,validated,submitted:0,balanceVerified};
        if(expectedSha || cacheContent) assertCustomerHubReadProofEnvironment({env,expectedSha});
        const completedAt=now().toISOString();
        const contentDigest=cacheContent ? await cacheInformation(db,information,new Date(completedAt)) : null;
        if(expectedSha || cacheContent) assertCustomerHubReadProofEnvironment({env,expectedSha});
        if(cacheContent) proofs.content.cacheStatus='READY';
        const proof={...result(),proved:true,...(expectedSha ? {sha:expectedSha,validatedAt:completedAt} : {})};
        receipts.set(proof,{sha:expectedSha,completedAt,contentDigest,plans,balanceVerified,sourceOrigin:source.origin,runtimeDigest:runtimeDigest(runtime),
          binding:Object.fromEntries(['customer_id','subscription_id','list_id','username','owner','whatsapp_e164','expires_on'].map(key=>[key,binding[key]])),
          accessCipherDigest:digest(finalBinding.access_password_encrypted),
          accessSyncedAt:new Date(finalMetadata.syncedAt).toISOString()});
        return proof;
      } catch(error) {if(!retryable.has(recordFailure(error))) return result();}
    }
    recordFailure(fail('READ_PROOF_NO_VERIFIED_CUSTOMER'));
  } catch(error) {recordFailure(error);}
  return result();
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  let db;
  try {
    const expectedSha=process.argv[2];
    assertCustomerHubReadProofEnvironment({expectedSha});
    const config=loadConfig();
    db=createDb(config.DATABASE_URL,{ssl:config.DATABASE_SSL});
    const proof=await runCustomerHubReadProof({db,config,expectedSha});
    console.log(JSON.stringify({sha:expectedSha,...proof}));
    if(!proof.proved) process.exitCode=1;
  } catch(error) {console.log(JSON.stringify({proved:false,errorCode:safeCode(error)}));process.exitCode=1;}
  finally {if(db) await db.close().catch(()=>{process.exitCode=1;});}
}
