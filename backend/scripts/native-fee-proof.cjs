// Verification harness: Rust instruction builders executed against the official DFS SBF.
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const{spawnSync}=require('node:child_process');
const {CpAmm}=require('@meteora-ag/cp-amm-sdk');
const BN=require('bn.js');const dbc=require('@meteora-ag/dynamic-bonding-curve-sdk');
const{Keypair,PublicKey,Transaction,TransactionInstruction,ComputeBudgetProgram,SystemProgram}=require('@solana/web3.js');
const{createSyncNativeInstruction,NATIVE_MINT,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction}=require('@solana/spl-token');
const{decimalJson}=require('../../proof/src/run.ts');
const{ProofVm}=require('../../proof/src/vm.ts');const{buildPair}=require('../../proof/src/curves.ts');
const helper=path.resolve(__dirname,'../native/target/debug/depthguard-native');
const DFS=new PublicKey('dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh');
function native(input){const p=spawnSync(helper,{input:JSON.stringify(input),encoding:'utf8',timeout:5000});assert.equal(p.status,0,p.stderr);const r=JSON.parse(p.stdout);assert(r.ok,r.error);return r.result;}
function ix(value){return new TransactionInstruction({programId:new PublicKey(value.program_id),data:Buffer.from(value.data,'base64'),keys:value.accounts.map(a=>({pubkey:new PublicKey(a.address),isSigner:a.signer,isWritable:a.writable}))});}
function ixJson(ix){return {program_id:ix.programId.toBase58(),data:ix.data.toString('base64'),accounts:ix.keys.map(k=>({address:k.pubkey.toBase58(),signer:k.isSigner,writable:k.isWritable}))};}
(async()=>{
 const vm=new ProofVm();vm.svm.addProgramFromFile(DFS,path.resolve('proof/fixtures/dynamic_fee_sharing.so'));
 const launcher=vm.wallet(),author=vm.wallet(),platform=vm.wallet(),base=Keypair.generate(),mint=Keypair.generate();
 const created=native({operation:'fee_create',base:base.publicKey.toBase58(),wallet:launcher.publicKey.toBase58(),quote_mint:NATIVE_MINT.toBase58(),recipients:[{wallet:launcher.publicKey.toBase58(),share:8000},{wallet:author.publicKey.toBase58(),share:1000},{wallet:platform.publicKey.toBase58(),share:1000}]});
 const vault=new PublicKey(created.vault);const tokenVault=new PublicKey(created.token_vault);
 vm.send('rust-dfs-create',new Transaction().add(ix(created)),[launcher,base]);
 const client=new dbc.DynamicBondingCurveClient(vm.connection,'confirmed');
 const snake=value=>Array.isArray(value)?value.map(snake):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),snake(v)])):value;
 const parameters=snake(decimalJson(buildPair().baseline));parameters.padding=[0,0];
 const configIx=native({operation:'dbc_config',config:base.publicKey.toBase58(),fee_vault:vault.toBase58(),wallet:launcher.publicKey.toBase58(),quote_mint:NATIVE_MINT.toBase58(),parameters});
 vm.send('rust-dbc-config-routed-to-dfs',new Transaction().add(ix(configIx)),[launcher,base]);
 const poolIx=native({operation:'dbc_pool',config:base.publicKey.toBase58(),base_mint:mint.publicKey.toBase58(),wallet:launcher.publicKey.toBase58(),quote_mint:NATIVE_MINT.toBase58(),name:'Native Fee Proof',symbol:'NFP',uri:'https://example.com/nfp.json'});
 vm.send('rust-dbc-pool',new Transaction().add(ix(poolIx)),[launcher,mint]);

 const pool=dbc.deriveDbcPoolAddress(NATIVE_MINT,mint.publicKey,base.publicKey);
 async function rustSwap(protocol,address,amount,mode='exact_in',sell=false){
  const clock=vm.svm.getClock();
  const input={operation:'swap_prepare',protocol,pool:address.toBase58(),wallet:launcher.publicKey.toBase58(),pool_data:Buffer.from(vm.svm.getAccount(address).data).toString('base64'),amount:String(amount),mode,base_for_quote:sell,slot:clock.slot.toString(),timestamp:clock.unixTimestamp.toString(),slippage_bps:100};
  if(protocol==='dbc'){input.config_data=Buffer.from(vm.svm.getAccount(base.publicKey).data).toString('base64');input.config_address=base.publicKey.toBase58();}
  if(!sell){const wsol=getAssociatedTokenAddressSync(NATIVE_MINT,launcher.publicKey);vm.send('fund-user-wsol',new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(launcher.publicKey,wsol,launcher.publicKey,NATIVE_MINT),SystemProgram.transfer({fromPubkey:launcher.publicKey,toPubkey:wsol,lamports:BigInt(amount)}),createSyncNativeInstruction(wsol)),[launcher]);}
  const prepared=native(input);return new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:600000}),...prepared.instructions.map(ix));
 }

 vm.send('buy-accrues-quote-fees',await rustSwap('dbc',pool,1000000000),[launcher]);
 const encoded=()=>Buffer.from(vm.svm.getAccount(vault).data).toString('base64');
 const claim=await client.partner.claimPartnerTradingFee2({feeClaimer:vault,payer:launcher.publicKey,pool,maxBaseAmount:new BN(0),maxQuoteAmount:new BN('18446744073709551615'),receiver:vault});
 const inner=claim.instructions.find(i=>i.programId.equals(dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID));assert(inner);
 // DFS uses a program-owned token vault, rather than an ATA, as the quote receiver.
 inner.keys[4].pubkey=tokenVault;
 const swept=native({operation:'fee_sweep',protocol:'dbc',pool:pool.toBase58(),pool_data:Buffer.from(vm.svm.getAccount(pool).data).toString('base64'),config_data:Buffer.from(vm.svm.getAccount(base.publicKey).data).toString('base64'),vault:vault.toBase58(),vault_data:encoded(),wallet:platform.publicKey.toBase58()});
 const before=vm.balance(tokenVault);vm.send('rust-fund-by-native-dbc-claim',new Transaction().add(...swept.instructions.map(ix)),[platform]);
 const actualFunding=vm.balance(tokenVault)-before;assert(actualFunding>0n);
 const snapshot=native({operation:'fee_vault',vault_data:encoded()});assert.equal(snapshot.total_funded,actualFunding.toString());
 const payouts=[];
 for(const [wallet,index]of [[launcher,0],[author,1],[platform,2]]){
  const prepared=native({operation:'fee_claim',vault:vault.toBase58(),vault_data:encoded(),wallet:wallet.publicKey.toBase58()});
  const ata=getAssociatedTokenAddressSync(NATIVE_MINT,wallet.publicKey);const balance=vm.balance(ata);
  vm.send(`rust-recipient-claim-${index}`,new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey,ata,wallet.publicKey,NATIVE_MINT),ix(prepared)),[wallet]);
  const payout=vm.balance(ata)-balance;assert.equal(payout.toString(),prepared.pending);payouts.push(payout);
  assert.throws(()=>native({operation:'fee_claim',vault:vault.toBase58(),vault_data:encoded(),wallet:wallet.publicKey.toBase58()}),/No claimable fee/);
 }
 const dust=actualFunding-payouts.reduce((a,b)=>a+b,0n);assert(dust>=0n&&dust<=3n);
 // Graduation preserves the partner position authority as the native DFS vault.
 const dammProgram=dbc.createDammV2Program(vm.connection);
 const operator=PublicKey.findProgramAddressSync([Buffer.from('operator'),launcher.publicKey.toBuffer()],dbc.DAMM_V2_PROGRAM_ID)[0];
 vm.send('damm-operator',await dammProgram.methods.createOperatorAccount(new BN(1)).accountsPartial({operator,whitelistedAddress:launcher.publicKey,signer:launcher.publicKey,payer:launcher.publicKey}).transaction(),[launcher]);
 const dammConfig=PublicKey.findProgramAddressSync([Buffer.from('config'),new BN(99).toArrayLike(Buffer,'le',8)],dbc.DAMM_V2_PROGRAM_ID)[0];
 vm.send('damm-migration-config',await dammProgram.methods.createDynamicConfig(new BN(99),{poolCreatorAuthority:dbc.deriveDbcPoolAuthority(),permission:new BN(1)}).accountsPartial({config:dammConfig,operator,signer:launcher.publicKey,payer:launcher.publicKey}).transaction(),[launcher]);
 vm.send('graduate',await rustSwap('dbc',pool,10000000000,'partial_fill'),[launcher]);
 const first=Keypair.generate(),second=Keypair.generate();
 const migration=native({operation:'dbc_migrate',wallet:launcher.publicKey.toBase58(),config:base.publicKey.toBase58(),base_mint:mint.publicKey.toBase58(),quote_mint:NATIVE_MINT.toBase58(),damm_config:dammConfig.toBase58(),first_position_mint:first.publicKey.toBase58(),second_position_mint:second.publicKey.toBase58()});
 vm.send('rust-migrate-damm-native-dfs-owner',new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:600000}),ix(migration)),[launcher,first,second]);
 const dammPool=new PublicKey(migration.damm_pool);const cp=new CpAmm(vm.connection);
 const position=dbc.derivePositionAddress(first.publicKey),nftAccount=dbc.derivePositionNftAccount(first.publicKey);
 const raw=address=>Buffer.from(vm.svm.getAccount(address).data).toString('base64');
 const verified=native({operation:'verify_launch',step:'migration',wallet:launcher.publicKey.toBase58(),fee_vault:vault.toBase58(),config:base.publicKey.toBase58(),base_mint:mint.publicKey.toBase58(),quote_mint:NATIVE_MINT.toBase58(),parameters,config_data:raw(base.publicKey),pool_data:raw(pool),damm_data:raw(dammPool),position_data:raw(position),position_nft_data:raw(nftAccount),damm_pool:dammPool.toBase58(),first_position_mint:first.publicKey.toBase58()});
 assert(verified.verified&&verified.native_fee_authority_verified&&verified.permanent_lock_verified);
 const migrated=await cp.fetchPoolState(dammPool);
 vm.send('post-migration-buy',await rustSwap('damm_v2',dammPool,100000000),[launcher]);
 const dammInner=await cp.buildClaimPositionFeeInstruction({owner:vault,poolAuthority:cp.poolAuthority,position,pool:dammPool,positionNftAccount:nftAccount,tokenAAccount:getAssociatedTokenAddressSync(mint.publicKey,vault,true),tokenBAccount:tokenVault,tokenAMint:mint.publicKey,tokenBMint:NATIVE_MINT,tokenAVault:migrated.tokenAVault,tokenBVault:migrated.tokenBVault,tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:TOKEN_PROGRAM_ID});
 const dammFund=native({operation:'fee_sweep',protocol:'damm_v2',pool:dammPool.toBase58(),pool_data:raw(dammPool),position:position.toBase58(),position_nft_account:nftAccount.toBase58(),vault:vault.toBase58(),vault_data:encoded(),wallet:platform.publicKey.toBase58()});
 const beforeDamm=vm.balance(tokenVault);vm.send('rust-fund-by-native-damm-claim',new Transaction().add(...dammFund.instructions.map(ix)),[platform]);
 const dammFunding=vm.balance(tokenVault)-beforeDamm;assert(dammFunding>0n);
 const result={environment:'Local official DFS and DBC SBF; Rust-generated DFS instructions; no public transactions',funded:actualFunding.toString(),payouts:payouts.map(String),rounding_dust:dust.toString(),recipient_shares:[8000,1000,1000],migration_verification:verified,damm_funded:dammFunding.toString(),native_authority_verified:true,replay_rejected:true,binary_manifest:require('../native/fixture-manifest.json'),receipts:vm.receipts};
 fs.writeFileSync(path.resolve(__dirname,'../tests/fixtures/native-fee-sharing.json'),JSON.stringify(result,null,2)+'\n');console.log('Native DFS proof passed:',result.funded,result.payouts);
})().catch(error=>{console.error(error);process.exitCode=1;});
