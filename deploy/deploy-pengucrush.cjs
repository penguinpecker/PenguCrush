const { Wallet } = require("zksync-ethers");
const { Deployer } = require("@matterlabs/hardhat-zksync");
const { vars } = require("hardhat/config");

// Deploys the unified PenguCrush contract as a UUPS proxy.
// Run with:
//   npx hardhat deploy-zksync --script deploy-pengucrush.cjs --network abstractMainnet
//
// After deploy:
//   1. Paste the proxy address into src/onchain.js (PENGUCRUSH_ADDRESS).
//   2. Copy the ABI from artifacts-zk/contracts/PenguCrush.sol/PenguCrush.json
//      into contracts/PenguCrushABI.json.
//   3. Authorize any relayer / session-key address via setAuthorizedSubmitter.
module.exports = async function (hre) {
  const wallet = new Wallet(vars.get("DEPLOYER_PRIVATE_KEY"));
  const deployer = new Deployer(hre, wallet);

  const artifact = await deployer.loadArtifact("PenguCrush");
  const MAX_LEVEL = 20;

  console.log("Deploying PenguCrush (UUPS proxy)…");
  const proxy = await hre.zkUpgrades.deployProxy(
    deployer.zkWallet,
    artifact,
    [MAX_LEVEL],
    { initializer: "initialize" }
  );
  await proxy.waitForDeployment();
  const addr = await proxy.getAddress();
  console.log("PenguCrush proxy deployed to:", addr);
  console.log("Initial maxLevel:", MAX_LEVEL);
  console.log("Implementation (via ERC1967): inspect with abstractscan or `zkUpgrades.erc1967.getImplementationAddress`");
};
