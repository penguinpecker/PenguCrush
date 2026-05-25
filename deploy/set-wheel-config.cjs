// Push the V2.8 daily wheel table + random pools to the live proxy (owner only).
// Run AFTER upgrading to an implementation that supports pool.dailyboost / pool.shards.
//
//   npx hardhat deploy-zksync --script set-wheel-config.cjs --network abstractMainnet
//
const { Wallet, Provider, Contract, utils } = require("zksync-ethers");
const { vars } = require("hardhat/config");

const DEPLOYER_PK = process.env.DEPLOYER_PRIVATE_KEY || vars.get("DEPLOYER_PRIVATE_KEY");
const PROXY = process.env.PENGUCRUSH_PROXY || "0x06aCb91c46aD1359825560B19A9556118Aeb1896";

// WheelPrizeKind: None=0, Currency=1, Booster=2, Shard=3, Lives=4, TryAgain=5
const KIND = { Currency: 1, Booster: 2, Shard: 3, Lives: 4, TryAgain: 5 };

function sku(name) {
  return utils.id(name);
}

const BOOSTERS = [
  sku("booster.row"),
  sku("booster.col"),
  sku("booster.colorBomb"),
  sku("booster.hammer"),
  sku("booster.shuffle"),
];

const SHARDS = [
  sku("shard.necklace"),
  sku("shard.crown"),
  sku("shard.plooshie"),
];

const WHEEL_SLOTS = [
  { kind: KIND.TryAgain, sku: utils.hexZeroPad("0x00", 32), amount: 0, weight: 3500, enabled: true },
  { kind: KIND.Currency, sku: sku("currency.xp"), amount: 100, weight: 3500, enabled: true },
  { kind: KIND.Currency, sku: sku("currency.xp"), amount: 250, weight: 800, enabled: true },
  { kind: KIND.Booster, sku: sku("pool.dailyboost"), amount: 1, weight: 1000, enabled: true },
  { kind: KIND.Lives, sku: sku("life.regular"), amount: 1, weight: 1000, enabled: true },
  { kind: KIND.Shard, sku: sku("pool.shards"), amount: 1, weight: 200, enabled: true },
];

const ABI = [
  "function batchSetWheel(tuple(uint8 kind, bytes32 sku, uint32 amount, uint16 weight, bool enabled)[] slots) external",
  "function setRandomPool(bytes32 alias_, bytes32[] members) external",
  "function wheelSlotCount() view returns (uint8)",
];

module.exports = async function () {
  if (!DEPLOYER_PK) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  const provider = new Provider("https://api.mainnet.abs.xyz");
  const wallet = new Wallet(DEPLOYER_PK, provider);
  const contract = new Contract(PROXY, ABI, wallet);

  console.log("Owner :", wallet.address);
  console.log("Proxy :", PROXY);
  console.log("Slots :", WHEEL_SLOTS.map((s, i) => `#${i} w=${s.weight}`).join(", "));

  console.log("Setting pool.dailyboost…");
  let tx = await contract.setRandomPool(sku("pool.dailyboost"), BOOSTERS);
  await tx.wait();

  console.log("Setting pool.shards…");
  tx = await contract.setRandomPool(sku("pool.shards"), SHARDS);
  await tx.wait();

  console.log("batchSetWheel…");
  tx = await contract.batchSetWheel(WHEEL_SLOTS);
  console.log("Tx:", tx.hash);
  await tx.wait();

  const count = await contract.wheelSlotCount();
  console.log("Done. wheelSlotCount =", count.toString());
};
