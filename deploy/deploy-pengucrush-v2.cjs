const { Wallet, Provider } = require("zksync-ethers");
const { Deployer } = require("@matterlabs/hardhat-zksync");
const { vars } = require("hardhat/config");
const fs = require("fs");
const path = require("path");

// Deploys PenguCrushV2 as a fresh UUPS proxy on Abstract mainnet.
// Run with:
//   npx hardhat deploy-zksync --script deploy-pengucrush-v2.cjs --network abstractMainnet
//
// Required env (in .env.local, loaded by hardhat.config.cjs):
//   DEPLOYER_PRIVATE_KEY    — funds the deploy
//   TREASURY_ADDRESS        — receives shop revenue
//   PRICE_RELAYER_ADDRESS   — signs EIP-712 shop quotes (also wheel rolls for now)
//   USDC_ADDRESS_ABSTRACT   — bridged USDC on Abstract mainnet
//   PYTH_CONTRACT_ABSTRACT  — Pyth pull-oracle (configured but guard off by default)
//   PYTH_ETH_USD_PRICEID    — ETH/USD price id on Pyth

const DEPLOYER_PK = process.env.DEPLOYER_PRIVATE_KEY || vars.get("DEPLOYER_PRIVATE_KEY");
const TREASURY    = process.env.TREASURY_ADDRESS;
const PRICE_RLY   = process.env.PRICE_RELAYER_ADDRESS;
const WHEEL_RLY   = process.env.WHEEL_RELAYER_ADDRESS || PRICE_RLY; // can be split later
const USDC        = process.env.USDC_ADDRESS_ABSTRACT;
const PYTH        = process.env.PYTH_CONTRACT_ABSTRACT;
const PYTH_ID     = process.env.PYTH_ETH_USD_PRICEID;
const MAX_LEVEL   = 20;

function required(name, val) {
  if (!val) throw new Error(`Missing required env: ${name}`);
  return val;
}

module.exports = async function (hre) {
  required("DEPLOYER_PRIVATE_KEY", DEPLOYER_PK);
  required("TREASURY_ADDRESS", TREASURY);
  required("PRICE_RELAYER_ADDRESS", PRICE_RLY);
  required("USDC_ADDRESS_ABSTRACT", USDC);

  const wallet = new Wallet(DEPLOYER_PK);
  const deployer = new Deployer(hre, wallet);

  // Pre-flight: deployer balance sanity check
  const provider = new Provider("https://api.mainnet.abs.xyz");
  const balance = await provider.getBalance(wallet.address);
  console.log("Deployer       :", wallet.address);
  console.log("Balance        :", (Number(balance) / 1e18).toFixed(6), "ETH");
  console.log("Treasury       :", TREASURY);
  console.log("Price relayer  :", PRICE_RLY);
  console.log("Wheel relayer  :", WHEEL_RLY);
  console.log("USDC token     :", USDC);
  console.log("Max level      :", MAX_LEVEL);
  console.log("");

  if (balance < 1_000_000_000_000_000n) {
    throw new Error(`Balance too low (<0.001 ETH); fund ${wallet.address} on Abstract.`);
  }

  const artifact = await deployer.loadArtifact("PenguCrushV2");

  console.log("Deploying PenguCrushV2 (UUPS proxy)…");
  const proxy = await hre.zkUpgrades.deployProxy(
    deployer.zkWallet,
    artifact,
    [
      wallet.address, // owner_
      TREASURY,
      PRICE_RLY,
      WHEEL_RLY,
      USDC,
      MAX_LEVEL,
    ],
    { initializer: "initialize" }
  );
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();

  // Pyth config (off by default — admin can flip on later via setPythConfig)
  if (PYTH && PYTH_ID) {
    console.log("Setting Pyth config (guard disabled by default)…");
    const tx = await proxy.setPythConfig(PYTH, PYTH_ID, false);
    await tx.wait();
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("PenguCrushV2 proxy deployed →", proxyAddr);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Owner          :", wallet.address);
  console.log("");
  console.log("Next steps (manual):");
  console.log("  1. Copy this proxy address into .env.local as VITE_PENGUCRUSH_ADDRESS.");
  console.log("  2. Update src/onchain.js to read from import.meta.env.VITE_PENGUCRUSH_ADDRESS.");
  console.log("  3. Verify on Abscan (needs ABSCAN_API_KEY in .env.local).");
  console.log("  4. Build edge functions (pengu-quote-price, pengu-wheel-roll, pengu-regen-sweep).");

  // Persist to a json file the frontend can also consume
  const outPath = path.resolve(__dirname, "..", "deployments.json");
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(outPath, "utf8")); } catch (_) {}
  existing.abstractMainnet = existing.abstractMainnet || {};
  existing.abstractMainnet.PenguCrushV2 = {
    proxy: proxyAddr,
    owner: wallet.address,
    treasury: TREASURY,
    priceRelayer: PRICE_RLY,
    wheelRelayer: WHEEL_RLY,
    usdc: USDC,
    pyth: PYTH,
    pythEthUsdId: PYTH_ID,
    deployedAt: new Date().toISOString(),
    deployedBy: wallet.address,
  };
  fs.writeFileSync(outPath, JSON.stringify(existing, null, 2));
  console.log("Wrote deployments.json");
};
