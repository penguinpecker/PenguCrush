// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title PenguCrush
 * @notice Unified on-chain registry for PenguCrush.
 *         - Level score submissions (best result per player/level, aggregate stats)
 *         - Activity events: booster used/purchased, daily spin, session ping
 *         - UUPS upgradeable: new functions/events can be added later without
 *           migrating player data or changing the proxy address.
 *
 * Storage layout is append-only. New variables must go above __gap and the
 * gap size decreased by the same amount to preserve layout for upgrades.
 */
contract PenguCrush is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    // ═══════════════════════════════════════════════════
    //  STRUCTS
    // ═══════════════════════════════════════════════════
    struct LevelResult {
        uint16 level;
        uint32 score;
        uint8 stars;
        uint16 movesUsed;
        uint64 timestamp;
    }

    struct PlayerStats {
        uint16 highestLevel;
        uint32 totalScore;
        uint16 totalStars;
        uint32 gamesPlayed;
        uint64 firstPlayedAt;
        uint64 lastPlayedAt;
    }

    // ═══════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════
    uint16 public maxLevel;
    bool public paused;

    mapping(address => mapping(uint16 => LevelResult)) public bestResults;
    mapping(address => PlayerStats) public playerStats;
    mapping(address => mapping(uint16 => uint32)) public attempts;

    address[] public players;
    mapping(address => bool) public isRegistered;
    mapping(address => bool) public authorizedSubmitters;

    /// @dev Reserved slots for future upgrades. Shrink when adding variables.
    uint256[45] private __gap;

    // ═══════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════

    // Scoring
    event ScoreSubmitted(
        address indexed player,
        uint16 indexed level,
        uint32 score,
        uint8 stars,
        uint16 movesUsed,
        bool newBest
    );
    event PlayerRegistered(address indexed player);

    // Activity (light-weight, event-only — cheap gas per call)
    event BoosterUsed(address indexed player, bytes32 indexed booster, uint64 at);
    event BoosterPurchased(address indexed player, bytes32 indexed booster, uint32 qty, uint64 at);
    event DailySpin(address indexed player, bytes32 indexed reward, uint64 at);
    event SessionPing(address indexed player, bytes32 indexed tag, uint64 at);

    // Admin
    event SubmitterUpdated(address indexed submitter, bool authorized);
    event MaxLevelUpdated(uint16 newMaxLevel);
    event PausedSet(bool isPaused);

    // ═══════════════════════════════════════════════════
    //  INITIALIZER (replaces constructor for upgradeable contracts)
    // ═══════════════════════════════════════════════════
    function initialize(uint16 _maxLevel) public initializer {
        __Ownable_init(msg.sender);
        maxLevel = _maxLevel;
        authorizedSubmitters[msg.sender] = true;
    }

    /// @dev Only owner can authorize implementation upgrades.
    function _authorizeUpgrade(address /*newImpl*/) internal override onlyOwner {}

    // ═══════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════
    modifier whenNotPaused() {
        require(!paused, "Paused");
        _;
    }

    modifier onlyAuthorized() {
        require(
            msg.sender == owner() || authorizedSubmitters[msg.sender],
            "Not authorized"
        );
        _;
    }

    // ═══════════════════════════════════════════════════
    //  SCORE FUNCTIONS
    // ═══════════════════════════════════════════════════

    function submitScore(
        uint16 level,
        uint32 score,
        uint8 stars,
        uint16 movesUsed
    ) external whenNotPaused {
        _submitScore(msg.sender, level, score, stars, movesUsed);
    }

    function submitScoreFor(
        address player,
        uint16 level,
        uint32 score,
        uint8 stars,
        uint16 movesUsed
    ) external whenNotPaused onlyAuthorized {
        _submitScore(player, level, score, stars, movesUsed);
    }

    function batchSubmitScores(
        uint16[] calldata levels,
        uint32[] calldata scores,
        uint8[] calldata starsList,
        uint16[] calldata movesUsedList
    ) external whenNotPaused {
        require(
            levels.length == scores.length &&
            levels.length == starsList.length &&
            levels.length == movesUsedList.length,
            "Length mismatch"
        );
        for (uint256 i = 0; i < levels.length; i++) {
            _submitScore(msg.sender, levels[i], scores[i], starsList[i], movesUsedList[i]);
        }
    }

    // ═══════════════════════════════════════════════════
    //  ACTIVITY EVENTS (new)
    // ═══════════════════════════════════════════════════

    function logBoosterUsed(bytes32 booster) external whenNotPaused {
        emit BoosterUsed(msg.sender, booster, uint64(block.timestamp));
    }

    function logBoosterPurchased(bytes32 booster, uint32 qty) external whenNotPaused {
        emit BoosterPurchased(msg.sender, booster, qty, uint64(block.timestamp));
    }

    function logDailySpin(bytes32 reward) external whenNotPaused {
        emit DailySpin(msg.sender, reward, uint64(block.timestamp));
    }

    function logSessionPing(bytes32 tag) external whenNotPaused {
        emit SessionPing(msg.sender, tag, uint64(block.timestamp));
    }

    // ═══════════════════════════════════════════════════
    //  READS
    // ═══════════════════════════════════════════════════

    function getBestResult(address player, uint16 level)
        external view returns (LevelResult memory)
    {
        return bestResults[player][level];
    }

    function getPlayerStats(address player)
        external view returns (PlayerStats memory)
    {
        return playerStats[player];
    }

    function getPlayerProgress(address player)
        external view returns (
            uint16[] memory levelNums,
            uint32[] memory scores,
            uint8[] memory starsList
        )
    {
        uint16 count = 0;
        for (uint16 i = 1; i <= maxLevel; i++) {
            if (bestResults[player][i].stars > 0) count++;
        }
        levelNums = new uint16[](count);
        scores = new uint32[](count);
        starsList = new uint8[](count);
        uint16 idx = 0;
        for (uint16 i = 1; i <= maxLevel; i++) {
            if (bestResults[player][i].stars > 0) {
                levelNums[idx] = i;
                scores[idx] = bestResults[player][i].score;
                starsList[idx] = bestResults[player][i].stars;
                idx++;
            }
        }
    }

    function getPlayerCount() external view returns (uint256) {
        return players.length;
    }

    function getPlayers(uint256 offset, uint256 limit)
        external view returns (address[] memory)
    {
        if (offset >= players.length) return new address[](0);
        uint256 end = offset + limit;
        if (end > players.length) end = players.length;
        address[] memory out = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) out[i - offset] = players[i];
        return out;
    }

    function getLeaderboardBatch(address[] calldata addrs)
        external view returns (PlayerStats[] memory)
    {
        PlayerStats[] memory stats = new PlayerStats[](addrs.length);
        for (uint256 i = 0; i < addrs.length; i++) stats[i] = playerStats[addrs[i]];
        return stats;
    }

    // ═══════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════

    function setMaxLevel(uint16 _maxLevel) external onlyOwner {
        maxLevel = _maxLevel;
        emit MaxLevelUpdated(_maxLevel);
    }

    function setAuthorizedSubmitter(address submitter, bool authorized) external onlyOwner {
        authorizedSubmitters[submitter] = authorized;
        emit SubmitterUpdated(submitter, authorized);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    // ═══════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════

    function _submitScore(
        address player,
        uint16 level,
        uint32 score,
        uint8 stars,
        uint16 movesUsed
    ) internal {
        require(level >= 1 && level <= maxLevel, "Invalid level");
        require(stars <= 3, "Invalid stars");
        require(player != address(0), "Zero address");

        if (!isRegistered[player]) {
            isRegistered[player] = true;
            players.push(player);
            playerStats[player].firstPlayedAt = uint64(block.timestamp);
            emit PlayerRegistered(player);
        }

        attempts[player][level]++;

        LevelResult storage best = bestResults[player][level];
        bool newBest = false;

        if (stars > best.stars || (stars == best.stars && score > best.score)) {
            uint32 oldScore = best.score;
            uint8 oldStars = best.stars;

            best.level = level;
            best.score = score;
            best.stars = stars;
            best.movesUsed = movesUsed;
            best.timestamp = uint64(block.timestamp);
            newBest = true;

            PlayerStats storage stats = playerStats[player];
            stats.totalScore = stats.totalScore - oldScore + score;
            stats.totalStars = stats.totalStars - oldStars + stars;
            if (level > stats.highestLevel && stars > 0) {
                stats.highestLevel = level;
            }
        }

        PlayerStats storage pstats = playerStats[player];
        pstats.gamesPlayed++;
        pstats.lastPlayedAt = uint64(block.timestamp);

        emit ScoreSubmitted(player, level, score, stars, movesUsed, newBest);
    }
}
