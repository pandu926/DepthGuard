// End-to-end acceptance: real Rust HTTP API/worker/Postgres against official local SBF.
// TypeScript implements the independent test RPC only; it is not a production service.
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const http=require('node:http');const crypto=require('node:crypto');const{spawn,spawnSync}=require('node:child_process');
const bs58=require('bs58').default;const{ProofVm}=require('../../proof/src/vm.ts');const{buildPair}=require('../../proof/src/curves.ts');const{decimalJson}=require('../../proof/src/run.ts');
const{Transaction,PublicKey,SystemProgram}=require('@solana/web3.js');const{FailedTransactionMetadata}=require('litesvm');
const dbc=require('@meteora-ag/dynamic-bonding-curve-sdk');const BN=require('bn.js');
const{NATIVE_MINT,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createSyncNativeInstruction}=require('@solana/spl-token');
const ROOT=path.resolve(__dirname,'../..');fs.mkdirSync(path.join(ROOT,'.local'),{recursive:true});const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 assert(process.env.DATABASE_URL,'DATABASE_URL is required');const db=new URL(process.env.DATABASE_URL);
 const database='depthguard_e2e_'+crypto.randomBytes(8).toString('hex');
 const pg={...process.env,PGHOST:db.hostname,PGPORT:db.port||'5432',PGUSER:decodeURIComponent(db.username),PGPASSWORD:decodeURIComponent(db.password),PGDATABASE:database};
 let rpc,api,worker;const directory=fs.mkdtempSync(path.join(os.tmpdir(),'depthguard-e2e-'));
 function command(name,args){const p=spawnSync(name,args,{env:pg,encoding:'utf8'});assert.equal(p.status,0,`${name} failed`);return p.stdout;}
 command('createdb',[database]);db.pathname='/'+database;
 try {
  const vm=new ProofVm();vm.svm.addProgramFromFile(new PublicKey('dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh'),path.join(ROOT,'proof/fixtures/dynamic_fee_sharing.so'));
  const wallet=vm.wallet(),platform=vm.wallet();const history=new Map();
  const damm=dbc.createDammV2Program(vm.connection);const operator=PublicKey.findProgramAddressSync([Buffer.from('operator'),wallet.publicKey.toBuffer()],dbc.DAMM_V2_PROGRAM_ID)[0];
  vm.send('operator',await damm.methods.createOperatorAccount(new BN(1)).accountsPartial({operator,whitelistedAddress:wallet.publicKey,signer:wallet.publicKey,payer:wallet.publicKey}).transaction(),[wallet]);
  const config=PublicKey.findProgramAddressSync([Buffer.from('config'),new BN(101).toArrayLike(Buffer,'le',8)],dbc.DAMM_V2_PROGRAM_ID)[0];
  vm.send('migration-config',await damm.methods.createDynamicConfig(new BN(101),{poolCreatorAuthority:dbc.deriveDbcPoolAuthority(),permission:new BN(1)}).accountsPartial({config,operator,signer:wallet.publicKey,payer:wallet.publicKey}).transaction(),[wallet]);
  const account=address=>{const a=vm.svm.getAccount(new PublicKey(address));return a?{data:[Buffer.from(a.data).toString('base64'),'base64'],owner:a.owner.toBase58(),lamports:Number(a.lamports),executable:a.executable}:null;};
  rpc=http.createServer(async(req,res)=>{
   let body='';for await(const chunk of req)body+=chunk;let r=JSON.parse(body),result;
   try{
    const p=r.params||[];
    switch(r.method){
     case'getGenesisHash':result='11111111111111111111111111111111';break;
     case'getAccountInfo':result={context:{slot:100},value:account(p[0])};break;
     case'getMultipleAccounts':result={context:{slot:100},value:p[0].map(account)};break;
     case'getLatestBlockhash':result={context:{slot:100},value:{blockhash:vm.svm.latestBlockhash(),lastValidBlockHeight:10000}};break;
     case'getBlockHeight':result=100;break;
     case'simulateTransaction':{
      const transaction=Transaction.from(Buffer.from(p[0],'base64'));transaction.serialize=()=>Buffer.from(p[0],'base64');vm.svm.withSigverify(Boolean(p[1].sigVerify));
      const sim=vm.svm.simulateTransaction(transaction);vm.svm.withSigverify(true);
      result={context:{slot:100},value:{err:sim instanceof FailedTransactionMetadata?{local_error:sim.toString()}:null}};break;
     }
     case'sendTransaction':{
      const transaction=Transaction.from(Buffer.from(p[0],'base64'));assert(transaction.verifySignatures());const signature=bs58.encode(transaction.signature);
      if(!history.has(signature)){
       const meta=vm.svm.sendTransaction(transaction);assert(!(meta instanceof FailedTransactionMetadata),meta.toString());
       const message=transaction.compileMessage();
       const innerInstructions=meta.innerInstructions().map((instructions,index)=>({index,instructions:instructions.map(inner=>{const ix=inner.instruction();return{programIdIndex:ix.programIdIndex(),accounts:Array.from(ix.accounts()),data:bs58.encode(ix.data()),stackHeight:inner.stackHeight()};})}));
       history.set(signature,{slot:100,transaction:{signatures:[signature],message:{accountKeys:message.accountKeys.map(k=>k.toBase58())}},meta:{err:null,innerInstructions}});
      }
      result=signature;break;
     }
     case'getSignatureStatuses':result={context:{slot:100},value:p[0].map(signature=>history.has(signature)?{slot:100,err:null,confirmationStatus:'finalized'}:null)};break;
     case'getTransaction':result=history.get(p[0])||null;break;
     case'getSignaturesForAddress':{
      let matches=[...history].reverse().filter(([,v])=>v.transaction.message.accountKeys.includes(p[0])).map(([signature])=>({signature,slot:100,err:null,confirmationStatus:'finalized'}));
      if(p[1].before){const index=matches.findIndex(v=>v.signature===p[1].before);matches=index>=0?matches.slice(index+1):[];}
      if(p[1].until){const index=matches.findIndex(v=>v.signature===p[1].until);if(index>=0)matches=matches.slice(0,index);}
      result=matches.slice(0,p[1].limit||20);break;
     }
     default:throw Error('Unsupported local RPC method '+r.method);
    }
    res.end(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
   }catch(error){console.error('Local RPC method failed:',r.method,String(error));res.end(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32603,message:String(error)}}));}
  });await new Promise(resolve=>rpc.listen(0,'127.0.0.1',resolve));
  const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const env={...process.env,DATABASE_URL:db.toString(),BIND_ADDRESS:`127.0.0.1:${port}`,APP_ORIGIN:origin,SOLANA_CLUSTER:'localnet',SOLANA_RPC_URLS:`http://127.0.0.1:${rpc.address().port}`,ENABLE_CHAIN_WRITES:'true',KEY_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),PLATFORM_FEE_WALLET:platform.publicKey.toBase58(),DAMM_MIGRATION_CONFIG:config.toBase58(),ARTIFACTS_DIR:directory,NATIVE_HELPER_PATH:path.join(ROOT,'backend/native/target/debug/depthguard-native'),SBF_HELPER_PATH:path.join(ROOT,'backend/sbf/target/debug/depthguard-sbf'),SBF_FIXTURES_DIR:path.join(ROOT,'proof/fixtures')};
  const apiPath=path.join(ROOT,'backend/target/debug/depthguard-api');const workerPath=path.join(ROOT,'backend/target/debug/depthguard-worker');
  const migrated=spawnSync(apiPath,['migrate'],{env,encoding:'utf8'});assert.equal(migrated.status,0,migrated.stderr);
  if(process.env.APP_DB_PASSWORD){const runtime=new URL(env.DATABASE_URL);runtime.username='depthguard_app';runtime.password=process.env.APP_DB_PASSWORD;env.DATABASE_URL=runtime.toString();}
  const log=fs.openSync(path.join(directory,'services.log'),'a');api=spawn(apiPath,[],{env,stdio:['ignore',log,log]});worker=spawn(workerPath,[],{env,stdio:['ignore',log,log]});
  for(let n=0;n<100;n++){try{if((await fetch(origin+'/health/ready')).ok)break;}catch{}await sleep(100);}
  let cookie='',csrf='';
  async function call(method,url,body,key){const response=await fetch(origin+url,{method,headers:{origin,'content-type':'application/json',...(cookie?{cookie,'x-csrf-token':csrf}:{}),...(key?{'idempotency-key':key}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});const value=await response.json();assert(response.ok,`${response.status}: ${JSON.stringify(value)}`);if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return value;}
  const challenge=await call('POST','/api/v1/auth/challenges',{wallet:wallet.publicKey.toBase58()});
  const privateKey=crypto.createPrivateKey({format:'der',type:'pkcs8',key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(wallet.secretKey.slice(0,32))])});
  const login=await call('POST','/api/v1/auth/verify',{id:challenge.id,signature:bs58.encode(crypto.sign(null,Buffer.from(challenge.message),privateKey))});csrf=login.csrf_token;
  const params=decimalJson(buildPair().baseline);
  const economy={schema_version:1,mechanism:'meme',base_decimals:6,quote_decimals:9,supply:params.tokenSupply.preMigrationTokenSupply,sqrt_start_price:params.sqrtStartPrice,curve:params.curve.map(s=>({sqrt_price:s.sqrtPrice,liquidity:s.liquidity})),migration_quote_threshold:params.migrationQuoteThreshold,trade_fee_bps:25,migration_fee_pct:0,compounding_fee_bps:Number(process.env.E2E_COMPOUND_BPS||0),fee_policy:{author:wallet.publicKey.toBase58(),launcher_bps:8000,author_bps:1000,platform_bps:1000}};
  const model=await call('POST','/api/v1/models',{name:'HTTP Economy',economy});const version=await call('POST',`/api/v1/models/${model.id}/publish`);
  const launch=await call('POST','/api/v1/launches',{model_version_id:version.id,name:'HTTP Token',symbol:'HTT',uri:'https://example.com/http.json',quote_mint:NATIVE_MINT.toBase58()});
  async function signed(prepared){const tx=Transaction.from(Buffer.from(prepared.transaction,'base64'));tx.partialSign(wallet);assert(tx.verifySignatures());const submitted=await call('POST',`/api/v1/transactions/${prepared.id}/submit`,{transaction:tx.serialize().toString('base64')});for(let n=0;n<120;n++){const status=await call('GET',`/api/v1/transactions/${prepared.id}`);if(status.state==='finalized')return submitted;if(['failed','expired','verification_failed'].includes(status.state))throw Error('Transaction '+status.state);await sleep(250);}throw Error('Transaction receipt deadline exceeded');}
  async function step(name,target){const prepared=await call('POST',`/api/v1/launches/${launch.id}/steps/${name}/prepare`);await signed(prepared);for(let n=0;n<120;n++){const current=await call('GET',`/api/v1/launches/${launch.id}`);if(current.state===target)return current;assert(current.state!=='verification_failed',JSON.stringify(current));await sleep(250);}throw Error('Launch verification deadline exceeded');}
  await step('fee_vault','fee_vault_ready');await step('config','config_ready');await step('pool','trading');
  const mint=new PublicKey(launch.accounts.mint);const wsol=getAssociatedTokenAddressSync(NATIVE_MINT,wallet.publicKey);
  vm.send('user-funds-wsol',new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey,wsol,wallet.publicKey,NATIVE_MINT),SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:wsol,lamports:12000000000n}),createSyncNativeInstruction(wsol)),[wallet]);
  const pool=dbc.deriveDbcPoolAddress(NATIVE_MINT,mint,new PublicKey(launch.accounts.config));
  const swap=protocol=>({protocol,pool:pool.toBase58(),amount:'1000000000',base_for_quote:false,mode:'exact_in',slippage_bps:100});
  await signed(await call('POST','/api/v1/swaps/prepare',swap('dbc')));
  await signed(await call('POST',`/api/v1/launches/${launch.id}/fees/sweep/prepare`,{protocol:'dbc'}));
  const current=await call('GET',`/api/v1/launches/${launch.id}`);

  const transaction=await call('GET',`/api/v1/transactions/${current.steps.find(s=>s.step==='fee_vault').transaction_id}`);const address=transaction.summary.fee_vault;
  await signed(await call('POST',`/api/v1/fee-vaults/${address}/claims/prepare`));
  const graduate=swap('dbc');graduate.mode='partial_fill';graduate.amount='10000000000';await signed(await call('POST','/api/v1/swaps/prepare',graduate));
  await step('migration','migrated');
  const markets=await call('GET','/api/v1/markets');const destination=markets.items.find(m=>m.protocol==='damm_v2');assert(destination);
  const postSwap=swap('damm_v2');postSwap.pool=destination.address;postSwap.amount='100000000';await signed(await call('POST','/api/v1/swaps/prepare',postSwap));
  await signed(await call('POST',`/api/v1/launches/${launch.id}/fees/sweep/prepare`,{protocol:'damm_v2'}));
  const earnings=await call('GET','/api/v1/me/earnings');assert(earnings.finalized_claims.length>0);assert(earnings.vaults.length===1);assert(earnings.funding_sources.length>0);assert(earnings.funding_sources.every(source=>source.trading_fee_source===true));
  const research=await call('POST','/api/v1/simulations',{evidence:'analytical',seed:'42',clock:100,cases:[{scenario:'graduation',economy}]},'http-research');
  for(let n=0;n<100;n++){const job=await call('GET',`/api/v1/simulations/${research.id}`);if(job.status==='completed')break;await sleep(100);}
  const exported=await call('GET',`/api/v1/simulations/${research.id}/export`);assert.equal(exported.artifact.results[0].status,'completed');
  const consumed=command('psql',['--no-psqlrc','--tuples-only','--command','SELECT count(*) FROM launch_account_signers WHERE consumed_at IS NOT NULL AND octet_length(encrypted_key)=0;']).trim();assert.equal(consumed,'4');
  const duplicate=command('psql',['--no-psqlrc','--tuples-only','--command',"SELECT count(*) FROM (SELECT signature,event_index,entry_type,count(*) FROM fee_accounting_entries GROUP BY 1,2,3 HAVING count(*)>1) x;"]).trim();assert.equal(duplicate,'0');
  console.log('PASS Rust HTTP lifecycle (compound '+economy.compounding_fee_bps+' bps): wallet auth, model publish, encrypted signers, DBC swaps/fee claims, verified DAMM migration, post-migration fees, durable research and receipt deduplication');
 }finally{
  for(const process of [api,worker])if(process){process.kill('SIGTERM');await Promise.race([new Promise(resolve=>process.once('exit',resolve)),sleep(5000)]);if(process.exitCode===null)process.kill('SIGKILL');}
  if(rpc)await new Promise(resolve=>rpc.close(resolve));if(fs.existsSync(path.join(directory,'services.log')))fs.copyFileSync(path.join(directory,'services.log'),path.join(ROOT,'.local/backend-http-lifecycle-services.log'));command('dropdb',['--force',database]);fs.rmSync(directory,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
