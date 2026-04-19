const { Wallet } = require("zksync-ethers");
const { Deployer } = require("@matterlabs/hardhat-zksync");
const { vars } = require("hardhat/config");

// Upgrade the PenguCrush proxy to a new implementation.
// Edit PROXY_ADDRESS to match your deployment, then run:
//   npx hardhat deploy-zksync --script upgrade-pengucrush.cjs --network abstractMainnet
//
// The proxy address stays the same; only the implementation bytecode
// changes. Player data, leaderboards, and event history are preserved.
const PROXY_ADDRESS = "0x0000000000000000000000000000000000000000"; // TODO: fill in after deploy

module.exports = async function (hre) {
  if (PROXY_ADDRESS === "0x0000000000000000000000000000000000000000") {
    throw new Error("Set PROXY_ADDRESS in deploy/upgrade-pengucrush.cjs first.");
  }
  const wallet = new Wallet(vars.get("DEPLOYER_PRIVATE_KEY"));
  const deployer = new Deployer(hre, wallet);

  const artifact = await deployer.loadArtifact("PenguCrush");
  console.log("Upgrading PenguCrush proxy at", PROXY_ADDRESS);
  const upgraded = await hre.zkUpgrades.upgradeProxy(
    deployer.zkWallet,
    PROXY_ADDRESS,
    artifact
  );
  await upgraded.waitForDeployment();
  console.log("Upgrade complete. Proxy still at:", PROXY_ADDRESS);
};
