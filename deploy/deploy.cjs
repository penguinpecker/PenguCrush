const { Wallet } = require("zksync-ethers");
const { Deployer } = require("@matterlabs/hardhat-zksync");
const { vars } = require("hardhat/config");

module.exports = async function (hre) {
  const wallet = new Wallet(vars.get("DEPLOYER_PRIVATE_KEY"));
  const deployer = new Deployer(hre, wallet);

  const artifact = await deployer.loadArtifact("PenguCrushScores");
  const MAX_LEVEL = 20;

  console.log("Deploying PenguCrushScores with maxLevel =", MAX_LEVEL);
  const contract = await deployer.deploy(artifact, [MAX_LEVEL]);
  const addr = await contract.getAddress();
  console.log("PenguCrushScores deployed to:", addr);
};
