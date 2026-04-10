const { Wallet, Provider, Contract } = require("zksync-ethers");
const { vars } = require("hardhat/config");

module.exports = async function (hre) {
  const provider = new Provider("https://api.mainnet.abs.xyz");
  const wallet = new Wallet(vars.get("DEPLOYER_PRIVATE_KEY"), provider);

  const CONTRACT = "0x2ef63Ee603a6944396AA97DA35835807F96BA089";
  const RELAYER = "0x6cB7318BCb62bec46F4A48E0E8d4E4E9EB0Ce6d3";

  const abi = [
    "function setAuthorizedSubmitter(address submitter, bool authorized) external",
    "function authorizedSubmitters(address) view returns (bool)"
  ];

  const contract = new Contract(CONTRACT, abi, wallet);

  const alreadyAuthorized = await contract.authorizedSubmitters(RELAYER);
  if (alreadyAuthorized) {
    console.log("Relayer already authorized!");
    return;
  }

  console.log("Authorizing relayer:", RELAYER);
  const tx = await contract.setAuthorizedSubmitter(RELAYER, true);
  console.log("Tx hash:", tx.hash);
  await tx.wait();
  console.log("Relayer authorized!");
};
