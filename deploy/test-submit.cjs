const { Wallet, Provider, Contract } = require("zksync-ethers");
const { vars } = require("hardhat/config");

module.exports = async function (hre) {
  const provider = new Provider("https://api.mainnet.abs.xyz");
  const wallet = new Wallet(vars.get("DEPLOYER_PRIVATE_KEY"), provider);

  const CONTRACT = "0xAF2ED337AAF8c3FF4AF5600C15F1C8C7042ec517"; // PenguCrush proxy
  const TEST_PLAYER = "0x000000000000000000000000000000000000dEaD";

  const abi = [
    "function submitScoreFor(address player, uint16 level, uint32 score, uint8 stars, uint16 movesUsed) external",
    "function getBestResult(address player, uint16 level) view returns (tuple(uint16 level, uint32 score, uint8 stars, uint16 movesUsed, uint64 timestamp))",
    "function getPlayerStats(address player) view returns (tuple(uint16 highestLevel, uint32 totalScore, uint16 totalStars, uint32 gamesPlayed, uint64 firstPlayedAt, uint64 lastPlayedAt))",
    "function getPlayerCount() view returns (uint256)",
    "function paused() view returns (bool)"
  ];

  const contract = new Contract(CONTRACT, abi, wallet);

  // 1. Check contract state
  const paused = await contract.paused();
  console.log("Contract paused:", paused);
  if (paused) {
    console.log("FAIL: Contract is paused!");
    return;
  }

  const playerCountBefore = await contract.getPlayerCount();
  console.log("Players before:", playerCountBefore.toString());

  // 2. Submit a test score (level 1, score 1500, 2 stars, 15 moves)
  console.log("\nSubmitting test score for dead address...");
  console.log("  Player:", TEST_PLAYER);
  console.log("  Level: 1, Score: 1500, Stars: 2, Moves: 15");

  const tx = await contract.submitScoreFor(TEST_PLAYER, 1, 1500, 2, 15);
  console.log("  Tx hash:", tx.hash);
  await tx.wait();
  console.log("  Confirmed!");

  // 3. Read it back
  const result = await contract.getBestResult(TEST_PLAYER, 1);
  console.log("\nRead back from contract:");
  console.log("  Level:", result.level.toString());
  console.log("  Score:", result.score.toString());
  console.log("  Stars:", result.stars.toString());
  console.log("  Moves used:", result.movesUsed.toString());
  console.log("  Timestamp:", result.timestamp.toString());

  const stats = await contract.getPlayerStats(TEST_PLAYER);
  console.log("\nPlayer stats:");
  console.log("  Highest level:", stats.highestLevel.toString());
  console.log("  Total score:", stats.totalScore.toString());
  console.log("  Total stars:", stats.totalStars.toString());
  console.log("  Games played:", stats.gamesPlayed.toString());

  const playerCountAfter = await contract.getPlayerCount();
  console.log("\nPlayers after:", playerCountAfter.toString());

  // 4. Test update (better score same level)
  console.log("\nSubmitting better score (3 stars, 2500 points)...");
  const tx2 = await contract.submitScoreFor(TEST_PLAYER, 1, 2500, 3, 12);
  console.log("  Tx hash:", tx2.hash);
  await tx2.wait();
  console.log("  Confirmed!");

  const result2 = await contract.getBestResult(TEST_PLAYER, 1);
  console.log("\nUpdated result:");
  console.log("  Score:", result2.score.toString(), "(should be 2500)");
  console.log("  Stars:", result2.stars.toString(), "(should be 3)");

  const stats2 = await contract.getPlayerStats(TEST_PLAYER);
  console.log("  Games played:", stats2.gamesPlayed.toString(), "(should be 2)");
  console.log("  Total stars:", stats2.totalStars.toString(), "(should be 3, not 5)");

  console.log("\n=== ALL TESTS PASSED ===");
};
