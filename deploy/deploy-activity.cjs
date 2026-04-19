const { Wallet } = require("zksync-ethers");
const { Deployer } = require("@matterlabs/hardhat-zksync");
const { vars } = require("hardhat/config");

// Deploy PenguCrushActivity to Abstract. After deploy, paste the address
// into src/onchain.js (ACTIVITY_ADDRESS) to enable booster/spin on-chain
// logging.
module.exports = async function (hre) {
  const wallet = new Wallet(vars.get("DEPLOYER_PRIVATE_KEY"));
  const deployer = new Deployer(hre, wallet);

  const artifact = await deployer.loadArtifact("PenguCrushActivity");
  console.log("Deploying PenguCrushActivity…");
  const contract = await deployer.deploy(artifact, []);
  const addr = await contract.getAddress();
  console.log("PenguCrushActivity deployed to:", addr);
};
