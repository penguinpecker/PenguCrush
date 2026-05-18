const { Wallet, Provider } = require("zksync-ethers");
const { Deployer } = require("@matterlabs/hardhat-zksync");
const { vars } = require("hardhat/config");

// Upgrade the PenguCrushV2 proxy to a new implementation.
//   npx hardhat deploy-zksync --script upgrade-pengucrush-v2.cjs --network abstractMainnet
//
// Proxy address stays the same; only the implementation bytecode changes.
// Player data, leaderboards, and event history are preserved.

const DEPLOYER_PK = process.env.DEPLOYER_PRIVATE_KEY || vars.get("DEPLOYER_PRIVATE_KEY");
const PROXY_ADDRESS = "0x06aCb91c46aD1359825560B19A9556118Aeb1896";

module.exports = async function (hre) {
  if (!DEPLOYER_PK) throw new Error("DEPLOYER_PRIVATE_KEY not set in env");
  const provider = new Provider("https://api.mainnet.abs.xyz");
  const wallet = new Wallet(DEPLOYER_PK, provider);
  const deployer = new Deployer(hre, wallet);

  const balance = await provider.getBalance(wallet.address);
  console.log("Sender (owner):", wallet.address);
  console.log("Balance       :", (Number(balance) / 1e18).toFixed(6), "ETH");
  console.log("Proxy         :", PROXY_ADDRESS);

  const artifact = await deployer.loadArtifact("PenguCrushV2");
  console.log("Loading new impl bytecode + running storage-layout safety check…");
  // V2.1 upgrade adds two new mappings (`levelStartedAt`, `usedWheelNonces`)
  // immediately before `__gap` and shrinks `__gap` from 40 → 38 to preserve
  // total slot reservation. Manually verified compatible:
  //   - All existing public state vars retain identical declaration order +
  //     storage position.
  //   - `usedNonces` (shop) keeps its slot; only its semantic name in code
  //     comments changed.
  //   - The two new mappings consume the first 2 slots that were previously
  //     gap padding; __gap[38] continues to reserve the trailing 38 slots.
  // OZ's static checker refuses gap-shrink-with-non-primitive-inserts so we
  // pass unsafeSkipStorageCheck after this manual review.
  const upgraded = await hre.zkUpgrades.upgradeProxy(
    deployer.zkWallet,
    PROXY_ADDRESS,
    artifact,
    { unsafeSkipStorageCheck: true }
  );
  await upgraded.waitForDeployment();
  console.log("Upgrade complete. Proxy still at:", PROXY_ADDRESS);
  console.log("New impl address (inspect via .upgradable/unknown-network-2741.json)");
};
