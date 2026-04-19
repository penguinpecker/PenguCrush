// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title PenguCrushActivity
 * @notice Event-only contract. Every meaningful player action in PenguCrush
 *         (booster use, booster purchase, daily wheel spin, session ping)
 *         is logged as an event so indexers / Abstract's portfolio trackers
 *         can count user on-chain activity without the player signing
 *         anything heavier than a minimal calldata tx.
 * @dev    No storage writes — just events. Gas per call is tiny.
 */
contract PenguCrushActivity {
    event BoosterUsed(address indexed player, bytes32 indexed booster, uint64 at);
    event BoosterPurchased(address indexed player, bytes32 indexed booster, uint32 qty, uint64 at);
    event DailySpin(address indexed player, bytes32 indexed reward, uint64 at);
    event SessionPing(address indexed player, bytes32 indexed tag, uint64 at);

    function logBoosterUsed(bytes32 booster) external {
        emit BoosterUsed(msg.sender, booster, uint64(block.timestamp));
    }

    function logBoosterPurchased(bytes32 booster, uint32 qty) external {
        emit BoosterPurchased(msg.sender, booster, qty, uint64(block.timestamp));
    }

    function logDailySpin(bytes32 reward) external {
        emit DailySpin(msg.sender, reward, uint64(block.timestamp));
    }

    function logSessionPing(bytes32 tag) external {
        emit SessionPing(msg.sender, tag, uint64(block.timestamp));
    }
}
