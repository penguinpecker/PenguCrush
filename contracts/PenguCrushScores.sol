// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title PenguCrushScores
 * @notice Onchain score registry for PenguCrush on Abstract Chain
 * @dev Deployed via Hardhat + hardhat-zksync. Stores verified level completions,
 *      player stats, and provides leaderboard data.
 */
contract PenguCrushScores {
    // ═══════════════════════════════════════════════════
    //  STRUCTS
    // ═══════════════════════════════════════════════════
    struct LevelResult {
        uint16 level;
        uint32 score;
        uint8 stars;       // 0-3
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
    address public owner;
    uint16 public maxLevel;
    bool public paused;

    // player => level => best result
    mapping(address => mapping(uint16 => LevelResult)) public bestResults;
    // player => stats
    mapping(address => PlayerStats) public playerStats;
    // player => level => number of attempts
    mapping(address => mapping(uint16 => uint32)) public attempts;

    // Leaderboard tracking
    address[] public players;
    mapping(address => bool) public isRegistered;

    // Authorized submitters (backend/session keys can submit on behalf of players)
    mapping(address => bool) public authorizedSubmitters;

    // ═══════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════
    event ScoreSubmitted(
        address indexed player,
        uint16 indexed level,
        uint32 score,
        uint8 stars,
        uint16 movesUsed,
        bool newBest
    );

    event PlayerRegistered(address indexed player);
    event SubmitterUpdated(address indexed submitter, bool authorized);
    event MaxLevelUpdated(uint16 newMaxLevel);
    event Paused(bool isPaused);

    // ═══════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Contract paused");
        _;
    }

    modifier onlyAuthorized() {
        require(
            msg.sender == owner || authorizedSubmitters[msg.sender],
            "Not authorized"
        );
        _;
    }

    // ═══════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════
    constructor(uint16 _maxLevel) {
        owner = msg.sender;
        maxLevel = _maxLevel;
        authorizedSubmitters[msg.sender] = true;
    }

    // ═══════════════════════════════════════════════════
    //  PLAYER FUNCTIONS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Submit your own score for a level
     * @param level Level number (1-maxLevel)
     * @param score Points earned
     * @param stars Stars earned (0-3)
     * @param movesUsed Number of moves used
     */
    function submitScore(
        uint16 level,
        uint32 score,
        uint8 stars,
        uint16 movesUsed
    ) external whenNotPaused {
        _submitScore(msg.sender, level, score, stars, movesUsed);
    }

    /**
     * @notice Submit score on behalf of a player (for session keys / backend relay)
     * @param player The player's address
     * @param level Level number
     * @param score Points earned
     * @param stars Stars earned (0-3)
     * @param movesUsed Number of moves used
     */
    function submitScoreFor(
        address player,
        uint16 level,
        uint32 score,
        uint8 stars,
        uint16 movesUsed
    ) external whenNotPaused onlyAuthorized {
        _submitScore(player, level, score, stars, movesUsed);
    }

    /**
     * @notice Batch submit scores (for syncing multiple levels at once)
     */
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
            "Array length mismatch"
        );
        for (uint256 i = 0; i < levels.length; i++) {
            _submitScore(msg.sender, levels[i], scores[i], starsList[i], movesUsedList[i]);
        }
    }

    // ═══════════════════════════════════════════════════
    //  READ FUNCTIONS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Get a player's best result for a specific level
     */
    function getBestResult(address player, uint16 level)
        external view returns (LevelResult memory)
    {
        return bestResults[player][level];
    }

    /**
     * @notice Get a player's stats
     */
    function getPlayerStats(address player)
        external view returns (PlayerStats memory)
    {
        return playerStats[player];
    }

    /**
     * @notice Get all completed levels for a player (returns arrays)
     */
    function getPlayerProgress(address player)
        external view returns (
            uint16[] memory levelNums,
            uint32[] memory scores,
            uint8[] memory starsList
        )
    {
        // Count completed levels
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

    /**
     * @notice Get total registered players count
     */
    function getPlayerCount() external view returns (uint256) {
        return players.length;
    }

    /**
     * @notice Get a page of players for leaderboard (pagination)
     * @param offset Start index
     * @param limit Number of players to return
     */
    function getPlayers(uint256 offset, uint256 limit)
        external view returns (address[] memory)
    {
        if (offset >= players.length) return new address[](0);
        uint256 end = offset + limit;
        if (end > players.length) end = players.length;
        address[] memory result = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = players[i];
        }
        return result;
    }

    /**
     * @notice Get leaderboard data for a batch of players
     */
    function getLeaderboardBatch(address[] calldata addrs)
        external view returns (PlayerStats[] memory)
    {
        PlayerStats[] memory stats = new PlayerStats[](addrs.length);
        for (uint256 i = 0; i < addrs.length; i++) {
            stats[i] = playerStats[addrs[i]];
        }
        return stats;
    }

    // ═══════════════════════════════════════════════════
    //  ADMIN FUNCTIONS
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
        emit Paused(_paused);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
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

        // Register player if new
        if (!isRegistered[player]) {
            isRegistered[player] = true;
            players.push(player);
            playerStats[player].firstPlayedAt = uint64(block.timestamp);
            emit PlayerRegistered(player);
        }

        // Track attempt
        attempts[player][level]++;

        // Check if this is a new best
        LevelResult storage best = bestResults[player][level];
        bool newBest = false;

        if (stars > best.stars || (stars == best.stars && score > best.score)) {
            // Update best — recalculate stats delta
            uint32 oldScore = best.score;
            uint8 oldStars = best.stars;

            best.level = level;
            best.score = score;
            best.stars = stars;
            best.movesUsed = movesUsed;
            best.timestamp = uint64(block.timestamp);
            newBest = true;

            // Update aggregate stats
            PlayerStats storage stats = playerStats[player];
            stats.totalScore = stats.totalScore - oldScore + score;
            stats.totalStars = stats.totalStars - oldStars + stars;
            if (level > stats.highestLevel && stars > 0) {
                stats.highestLevel = level;
            }
        }

        // Always update play counts
        PlayerStats storage stats = playerStats[player];
        stats.gamesPlayed++;
        stats.lastPlayedAt = uint64(block.timestamp);

        emit ScoreSubmitted(player, level, score, stars, movesUsed, newBest);
    }
}
