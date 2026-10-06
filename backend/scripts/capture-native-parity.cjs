// Verification harness only. Production services and native quotes run entirely in Rust.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dbc = require('@meteora-ag/dynamic-bonding-curve-sdk');
const { PublicKey } = require('@solana/web3.js');
const { ProofVm } = require('../../proof/src/vm.ts');
const { buildPair } = require('../../proof/src/curves.ts');
const { experiment } = require('../../proof/src/run.ts');
const helper = process.env.NATIVE_HELPER_PATH || path.resolve(__dirname, '../native/target/debug/depthguard-native');
const snapshots = [];
const sbfCases = [];
const original = ProofVm.prototype.trialOutput;
ProofVm.prototype.trialOutput = function(tx, signers, outputAta) {
  const ix = tx.instructions.find(ix => ix.programId.equals(dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID) || ix.programId.equals(dbc.DAMM_V2_PROGRAM_ID));
  assert(ix, 'Native swap instruction required');
  const isDbc = ix.programId.equals(dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID);
  const coder = isDbc ? dbc.createDbcProgram(this.connection).program.coder.accounts : dbc.createDammV2Program(this.connection).coder.accounts;
  let pool, address, data;
  for (const key of ix.keys) {
    const account = this.svm.getAccount(key.pubkey);
    if (!account || !account.owner.equals(ix.programId)) continue;
    try {pool = coder.decode(isDbc ? 'virtualPool' : 'pool', Buffer.from(account.data)); address = key.pubkey; data = Buffer.from(account.data); break;} catch {}
  }
  assert(pool && address && data, 'Pool account located by discriminator');
  const input = {protocol: isDbc ? 'dbc' : 'damm_v2', pool_data: data.toString('base64'), slot: this.svm.getClock().slot.toString(), timestamp: this.svm.getClock().unixTimestamp.toString(), amount: ix.data.readBigUInt64LE(8).toString(), mode:'exact_in', base_for_quote:true};
  if (isDbc) {
    input.config_address = pool.poolState.config.toBase58();
    input.config_data = Buffer.from(this.svm.getAccount(new PublicKey(input.config_address)).data).toString('base64');
  }
  const initialAccounts = tx.instructions.flatMap(ix => ix.keys).map(k => k.pubkey)
    .filter((key,i,all) => all.findIndex(other=>other.equals(key))===i)
    .map(key=>({key,account:this.svm.getAccount(key)}))
    .filter(({account})=>account && !account.executable)
    .map(({key,account})=>({address:key.toBase58(),owner:account.owner.toBase58(),data:Buffer.from(account.data).toString('base64'),lamports:String(account.lamports),executable:false}));
  const actual = original.call(this, tx, signers, outputAta);
  // The output ATA close instruction is omitted so output can be inspected after simulation.
  const simulatedTx = tx;
  simulatedTx.instructions = simulatedTx.instructions.filter(ix=>!(ix.programId.toBase58()==='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' && ix.data[0]===9));
  sbfCases.push({accounts:initialAccounts,transaction:simulatedTx.serialize().toString('base64'),slot:input.slot,timestamp:input.timestamp,output_account:outputAta.toBase58(),expected_output:actual.toString()});
  const run = spawnSync(helper, {input:JSON.stringify(input),encoding:'utf8',timeout:5000});
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.result.output, actual.toString(), `${input.protocol} Rust/SDK/SBF output parity`);
  snapshots.push({input, expected_output:actual.toString(), native_result:result.result, binary_hashes:this.binaryHashes});
  return actual;
};
(async()=>{
  for (const [name,config] of [['baseline',buildPair().baseline],['optimized',buildPair().optimized],['migration-fee',buildPair(5).optimized],['compound50',buildPair(0,5,.7,20,5000).optimized],['compound100',buildPair(0,5,.7,20,10000).optimized]]) await experiment(`rust-parity-${name}`,config);
  fs.writeFileSync(path.resolve(__dirname,'../tests/fixtures/native-quotes.json'),JSON.stringify({scope:'Local official SBF + pinned TypeScript + pinned native Rust SDK quotes',snapshots},null,2)+'\n');
  fs.writeFileSync(path.resolve(__dirname,'../tests/fixtures/sbf-swaps.json'),JSON.stringify({cases:sbfCases},null,2)+'\n');
  console.log(`Native Rust parity passed: ${snapshots.length} exact-in quotes.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
