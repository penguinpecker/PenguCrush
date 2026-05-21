// Deploys PenguCrushPaymaster and funds it with a small ETH balance so it
// can sponsor gameplay txs. Idempotent at the wallet level — running twice
// just deploys a second paymaster (you'd then point the frontend at
// whichever you want). Run:
//   npx hardhat deploy-zksync --script deploy-paymaster.cjs --network abstractMainnet

const { Wallet, Provider, utils } = require('zksync-ethers');
const { Deployer } = require('@matterlabs/hardhat-zksync');
const { vars } = require('hardhat/config');
const fs = require('fs');
const path = require('path');

const DEPLOYER_PK = process.env.DEPLOYER_PRIVATE_KEY || vars.get('DEPLOYER_PRIVATE_KEY');
const PENGU_TARGET = process.env.VITE_PENGUCRUSH_ADDRESS || '0x06aCb91c46aD1359825560B19A9556118Aeb1896';
// How much ETH to fund the paymaster with on deploy. Tunable via env.
// 0.005 ETH at typical Abstract gas covers ~50-100 gameplay txs.
const FUND_ETH = process.env.PAYMASTER_FUND_ETH || '0.005';

function required(name, val) {
  if (!val) throw new Error(`Missing required env: ${name}`);
  return val;
}

module.exports = async function (hre) {
  required('DEPLOYER_PRIVATE_KEY', DEPLOYER_PK);
  const provider = new Provider(hre.network.config.url);
  const wallet = new Wallet(DEPLOYER_PK, provider);
  const deployer = new Deployer(hre, wallet);

  const bal = await provider.getBalance(wallet.address);
  console.log('Deployer:', wallet.address);
  console.log('Balance:', (Number(bal) / 1e18).toFixed(6), 'ETH');

  console.log('Loading artifact: PenguCrushPaymaster');
  const artifact = await deployer.loadArtifact('PenguCrushPaymaster');

  console.log('Target (PenguCrushV2 proxy):', PENGU_TARGET);
  console.log('Deploying...');
  const contract = await deployer.deploy(artifact, [PENGU_TARGET]);
  const address = await contract.getAddress();
  console.log('Paymaster deployed at:', address);
  const deployTx = contract.deploymentTransaction();
  console.log('Deploy tx:', deployTx?.hash);

  // Fund the paymaster
  const fundWei = BigInt(Math.floor(Number(FUND_ETH) * 1e18));
  if (fundWei > 0n) {
    console.log(`Funding paymaster with ${FUND_ETH} ETH...`);
    const tx = await wallet.sendTransaction({ to: address, value: fundWei });
    console.log('Fund tx:', tx.hash);
    await tx.wait();
    const pmBal = await provider.getBalance(address);
    console.log('Paymaster balance:', (Number(pmBal) / 1e18).toFixed(6), 'ETH');
  } else {
    console.log('(Skipped funding — PAYMASTER_FUND_ETH=0)');
  }

  // Append to deployments.json
  const deploymentsPath = path.resolve(__dirname, '..', 'deployments.json');
  let deployments = {};
  try { deployments = JSON.parse(fs.readFileSync(deploymentsPath, 'utf8')); } catch (_) {}
  deployments.abstractMainnet ||= {};
  deployments.abstractMainnet.PenguCrushPaymaster = {
    address,
    target: PENGU_TARGET,
    owner: wallet.address,
    deployTx: deployTx?.hash || null,
    deployedAt: new Date().toISOString(),
    fundedEth: FUND_ETH,
  };
  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + '\n');
  console.log('Recorded in deployments.json');
  console.log('');
  console.log('NEXT STEPS:');
  console.log('  1. Add to .env.local:');
  console.log(`       VITE_ABSTRACT_PAYMASTER=${address}`);
  console.log('  2. Add the SAME var to Vercel project env (Production + Preview).');
  console.log('  3. Redeploy frontend.');
};
