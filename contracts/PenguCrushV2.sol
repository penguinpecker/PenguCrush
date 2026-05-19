// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
// ReentrancyGuard is inlined below — OZ's variants both trip the upgrades-plugin
// safety validator due to constructor logic.
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title PenguCrushV2
 * @notice Unified on-chain authority for PenguCrush:
 *   • items registry (boosters, shards, currencies, lives) — admin-mutable
 *     so new catalogue entries don't require a contract upgrade
 *   • per-player balances (boosters, shards, currencies, lives + 8h regen)
 *   • level completion / journal (score, stars, tiles cleared, boosters used)
 *   • shop in ETH and USDC, gated by EIP-712 signed quotes from a backend
 *     price relayer (no on-chain oracle dependency by default; Pyth
 *     ETH/USD can be enabled as a sanity guardrail)
 *   • daily wheel with server-signed RNG (anti-tamper)
 *   • crush pass (weekly subscription) with streak tracking
 *   • mid-game checkpoint event for anti-cheat trail
 *
 * AGW session keys: in-game actions (startLevel, submitLevel, consumeBooster,
 * awardShards, claimRegen, spinDailyWheel) are designed to be invoked via
 * AGW's built-in session-key validator at 0x34ca1501FAE231cC2ebc995CE013Dbe882d7d081
 * so users do not see a wallet prompt mid-play. Shop functions are intentionally
 * excluded from the recommended session-key policy so they always require the
 * user to sign explicitly.
 *
 * Storage is flat with a __gap reserve. New variables must be appended above
 * __gap and the gap shrunk by the same count.
 *
 * Solidity 0.8.24: `require(cond, CustomError())` is not supported — all
 * checks use the `if (!cond) revert CustomError();` form.
 */
contract PenguCrushV2 is
    Initializable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable
{
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════
    //  REENTRANCY GUARD — inline (proxy-safe, no constructor)
    // ═══════════════════════════════════════════════════════════════

    /// 0 = not entered (initial state on proxy), 1 = entered.
    uint256 private _reentryStatus;
    error Reentrant();
    modifier nonReentrant() {
        if (_reentryStatus == 1) revert Reentrant();
        _reentryStatus = 1;
        _;
        _reentryStatus = 0;
    }

    // ═══════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════

    /// Hard storage ceiling on regular lives. V2.5 product decision kept
    /// in V2.7: total HUD slots are 5. Purchases above 5 regular waste.
    /// Existing wallets at >5 from the V2.4 window are NOT auto-rebased.
    uint8  public constant MAX_REGULAR_LIVES = 5;
    /// V2.7 — regen fills all regular slots, matching MAX_REGULAR_LIVES.
    /// Previously this was 3 (only the "regen zone" topped up, ice slots
    /// were a separate pass-granted bonus) which let the HUD render 4/5
    /// while still saying "Full!" — confusing players. Now the timer
    /// keeps ticking until every regular slot is full.
    /// Invariant: lastConsumedAt == 0 iff regular >= REGEN_CAP_REGULAR.
    uint8  public constant REGEN_CAP_REGULAR = 5;
    uint8  public constant MAX_FROZEN_LIVES  = 2;
    uint64 public constant REGEN_PERIOD      = 8 hours;
    uint8  public constant USDC_DECIMALS     = 6;
    uint8  public constant MAX_STARS         = 3;
    /// Wheel slot count is mutable, but capped to avoid griefing via gas.
    uint8  public constant WHEEL_SLOT_HARD_CAP = 16;
    /// Audit fix #9: cap submitLevel shard journal so a modified client can't
    /// mint an arbitrarily large bag of shards in one call.
    uint8  public constant MAX_SHARDS_PER_SUBMIT = 16;
    /// Pyth guardrail tolerance in basis points (200 = 2%). NOTE V2.1: the
    /// `pyth`, `pythEthUsdId`, `pythGuardEnabled` state vars + setPythConfig
    /// setter are RESERVED for a future on-chain price-check feature. They are
    /// NOT currently consulted in `_verifyShopQuote` — there is no Pyth read
    /// path on chain today. Setting `pythGuardEnabled = true` therefore does
    /// nothing. Do not rely on this guardrail until a future upgrade wires
    /// `IPyth.getPriceUnsafe(...)` into the shop quote flow.
    uint16 public constant PYTH_GUARD_TOLERANCE_BPS = 200;

    // ═══════════════════════════════════════════════════════════════
    //  ENUMS
    // ═══════════════════════════════════════════════════════════════

    enum ItemKind { None, Booster, Shard, Currency, Lives }
    enum WheelPrizeKind { None, Currency, Booster, Shard, Lives, TryAgain }
    enum Currency { ETH, USDC }

    // ═══════════════════════════════════════════════════════════════
    //  STRUCTS
    // ═══════════════════════════════════════════════════════════════

    struct ItemConfig {
        ItemKind kind;
        bool enabled;
        uint32 maxBalance;     // 0 = uncapped
        uint8  rarity;         // shards: 1 common, 2 rare, 3 legendary
        uint16 mintRateBps;    // shard drop rate in basis points (display only; rolling happens in submitLevel)
    }

    struct LevelResult {
        uint16 level;
        uint32 score;
        uint8  stars;
        uint16 movesUsed;
        uint64 timestamp;
    }

    struct PlayerStats {
        uint16 highestLevel;
        uint32 totalScore;
        uint16 totalStars;
        uint32 gamesPlayed;
        uint32 gamesWon;
        uint32 gamesFailed;
        uint64 firstPlayedAt;
        uint64 lastPlayedAt;
    }

    struct LifeAccount {
        uint8  regular;
        uint8  frozen;
        uint64 lastConsumedAt;   // 0 iff regular >= REGEN_CAP_REGULAR
    }

    struct CrushPass {
        uint64 expiresAt;        // 0 = inactive
        uint16 streakWeeks;
        uint64 lastPurchaseWeekMonday; // Julian day of Monday-of-week (UTC), 0 = never purchased
    }

    struct WheelSlot {
        WheelPrizeKind kind;
        bytes32 sku;             // references items registry; ignored for TryAgain/None
        uint32 amount;
        uint16 weight;
        bool enabled;
    }

    /// Per-level journal submitted at end of run.
    struct LevelJournal {
        uint16   level;
        uint32   score;
        uint8    stars;
        uint16   movesUsed;
        bool     completed;
        uint32   durationMs;
        bytes32[] boostersUsed;  // sku per consumption
        bytes32[] shardsEarned;
        uint16   bigCombos;      // combos ≥ 5
        uint16   fallerPenalties;
    }

    struct ShopQuote {
        address buyer;
        bytes32 sku;
        uint32  qty;
        Currency currency;
        uint256 amount;          // wei for ETH, micros (6dec) for USDC
        uint256 nonce;
        uint256 deadline;
    }

    struct WheelRoll {
        address player;
        uint64  dayUtc;          // julian day = block.timestamp / 86400
        uint8   slotIndex;
        uint256 nonce;
        uint256 deadline;
    }

    // ═══════════════════════════════════════════════════════════════
    //  STORAGE
    // ═══════════════════════════════════════════════════════════════

    // -- Player progress --
    mapping(address => mapping(uint16 => LevelResult)) public bestResults;
    mapping(address => PlayerStats) public playerStats;
    mapping(address => mapping(uint16 => uint32)) public attempts;
    address[] public players;
    mapping(address => bool) public isRegistered;
    uint16 public maxLevel;

    // -- Items registry --
    mapping(bytes32 => ItemConfig) public items;
    bytes32[] public itemSkus;
    /// Random pools (e.g. "ice_boost" → [row, col, colorBomb, hammer, shuffle])
    mapping(bytes32 => bytes32[]) public randomPools;

    // -- Per-player balances (by registered sku) --
    mapping(address => mapping(bytes32 => uint32)) public boosterBalance;
    mapping(address => mapping(bytes32 => uint32)) public shardBalance;
    mapping(address => mapping(bytes32 => uint64)) public currencyBalance;

    // -- Lives + crush pass --
    mapping(address => LifeAccount) public lifeAccount;
    mapping(address => CrushPass) public crushPass;
    /// Crush-pass price in USD cents (stored as uint64 micros for consistency).
    uint64 public crushPassPriceUsdMicros; // e.g. 4_990_000 == $4.99

    // -- Daily wheel --
    mapping(uint8 => WheelSlot) public wheelConfig;
    uint8 public wheelSlotCount;
    mapping(address => uint64) public lastWheelDay; // julian day of last spin

    // -- Shop --
    /// USD-denominated price per SKU, in micros (6dec). qty=1 unit price.
    mapping(bytes32 => uint64) public skuPriceUsdMicros;
    address public treasury;
    address public priceRelayer;
    address public wheelRelayer;
    IERC20  public usdc;
    bool public shopPaused;
    bool public gameplayPaused;

    // -- Quote replay protection --
    mapping(uint256 => bool) public usedNonces;

    // -- Pyth guardrail (optional, off by default) --
    address public pyth;            // 0x8739d5…58F1 on Abstract mainnet
    bytes32 public pythEthUsdId;    // 0xff61491a…fd0ace
    bool public pythGuardEnabled;

    // -- Authorized submitters (server-side relayers can call submitLevelFor) --
    mapping(address => bool) public authorizedSubmitters;

    // -- Crush pass perks (admin-tunable) --
    uint8 public passBoostersEach;       // boosters of each sku granted per purchase
    uint8 public passFrozenLivesGrant;   // frozen hearts granted per purchase
    uint16 public passShardBonusBps;     // 1500 = 15% chance
    uint32 public passDurationSeconds;   // 7 days default

    // ── V2.1 additions (audit fixes #8, #15) ──
    // Tracks the timestamp at which startLevel was successfully called for
    // (player, level). submitLevel requires this to be non-zero (closes the
    // exploit where a modified client could call submitLevel without ever
    // consuming a life via startLevel). Cleared after each submitLevel so
    // retrying a level requires another startLevel.
    mapping(address => mapping(uint16 => uint64)) public levelStartedAt;
    // Wheel-roll nonces live in their own map so a shop nonce can never
    // collide with a wheel nonce (each relayer can issue nonces independently).
    // Shop nonces continue to live in `usedNonces` above for storage compat.
    mapping(uint256 => bool) public usedWheelNonces;

    // ── V2.2 additions (audit fix #10) ──
    // Server-side validator signs off on a journal before the player calls
    // submitLevelValidated. The contract verifies the validator signature so
    // that a modified client can't claim arbitrary score/stars on chain even
    // though the journal itself is still authored by the player.
    address public validatorRelayer;

    // ── V2.3 additions (starter pack) ──
    // True after a wallet has called `claimStarterPack` once. The starter
    // pack grants 1 of every enabled Booster-kind item on chain so the HUD
    // doesn't have to lie about default inventory. Permissionless + idempotent.
    mapping(address => bool) public claimedStarterPack;

    // -- Reserved for upgrades --
    uint256[36] private __gap; // shrunk from 37 to make room for claimedStarterPack

    // ═══════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════

    // -- Player progress --
    event PlayerRegistered(address indexed player, uint64 at);
    event LevelStarted(address indexed player, uint16 indexed level, uint64 at);
    /// V2.1: added `journalHash` so off-chain indexers can detect calldata
    /// rewrites without decoding the full struct from each tx (audit fix #16).
    event LevelSubmitted(
        address indexed player,
        uint16 indexed level,
        uint32 score,
        uint8 stars,
        uint16 movesUsed,
        bool completed,
        bool newBest,
        bytes32 journalHash
    );
    event HighestLevelAdvanced(address indexed player, uint16 newHighest);
    event LevelCheckpoint(address indexed player, uint16 indexed level, uint16 moveNum, bytes32 snapshotHash);
    /// V2.2: emitted alongside LevelSubmitted whenever a submission passed
    /// validator-signed approval. Off-chain leaderboards should filter on
    /// matching journalHash entries (audit fix #10).
    event LevelValidated(address indexed player, uint16 indexed level, bytes32 indexed journalHash);
    event ValidatorRelayerUpdated(address oldRelayer, address newRelayer);
    /// V2.3: emitted on the one-time per-wallet starter-pack grant.
    event StarterPackClaimed(address indexed player);

    // -- Items / inventory --
    event BoosterUsed(address indexed player, bytes32 indexed sku, uint16 atLevel, uint32 balanceAfter);
    event ShardEarned(address indexed player, bytes32 indexed sku, uint16 atLevel, uint32 balanceAfter);
    event CurrencyChanged(address indexed player, bytes32 indexed sku, int128 delta, uint64 balanceAfter);
    event BoosterGranted(address indexed player, bytes32 indexed sku, uint32 qty, uint32 balanceAfter);
    event ShardGranted(address indexed player, bytes32 indexed sku, uint32 qty, uint32 balanceAfter);

    // -- Lives --
    event LifeSpent(address indexed player, uint16 atLevel, uint8 regularAfter, uint8 frozenAfter, uint64 at);
    event LifeRegenerated(address indexed player, uint8 ticks, uint8 regularAfter, uint64 at);
    event LivesPurchased(address indexed player, uint8 qty, uint8 regularAfter);
    event FrozenLifeGranted(address indexed player, uint8 qty, uint8 frozenAfter);
    event FrozenLivesExpired(address indexed player, uint8 lost, uint64 expiredAt);

    // -- Crush pass --
    event CrushPassPurchased(
        address indexed player,
        uint64 weekMonday,
        uint64 expiresAt,
        uint16 streakWeeks,
        Currency currency,
        uint256 paid
    );
    event CrushPassCancelled(address indexed player);
    event CrushPassExpired(address indexed player);
    event CrushPassShardBonus(address indexed player, bytes32 indexed sku);

    // -- Shop --
    event ShopPurchase(
        address indexed buyer,
        bytes32 indexed sku,
        uint32 qty,
        Currency currency,
        uint256 paid,
        uint256 nonce
    );

    // -- Daily wheel --
    event DailySpin(address indexed player, uint64 day, uint8 slotIndex, WheelPrizeKind kind, bytes32 sku, uint32 amount);

    // -- Items registry admin --
    event ItemRegistered(bytes32 indexed sku, ItemKind kind, uint32 maxBalance, uint8 rarity, uint16 mintRateBps);
    event ItemUpdated(bytes32 indexed sku, ItemKind kind, bool enabled, uint32 maxBalance, uint8 rarity, uint16 mintRateBps);
    event ItemDisabled(bytes32 indexed sku);
    event RandomPoolSet(bytes32 indexed alias_, bytes32[] members);

    // -- Wheel admin --
    event WheelSlotUpdated(uint8 indexed idx, WheelPrizeKind kind, bytes32 sku, uint32 amount, uint16 weight, bool enabled);
    event WheelSlotCountUpdated(uint8 newCount);

    // -- Shop admin --
    event SkuPriceUpdated(bytes32 indexed sku, uint64 priceUsdMicros);
    event CrushPassPriceUpdated(uint64 priceUsdMicros);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event PriceRelayerUpdated(address oldRelayer, address newRelayer);
    event WheelRelayerUpdated(address oldRelayer, address newRelayer);
    event UsdcTokenSet(address token);
    event ShopPausedSet(bool paused);
    event GameplayPausedSet(bool paused);
    event PausedSet(bool paused);
    event MaxLevelUpdated(uint16 newMaxLevel);
    event SubmitterUpdated(address indexed submitter, bool authorized);
    event PythConfigUpdated(address pyth, bytes32 ethUsdId, bool enabled);
    event PassPerksUpdated(uint8 boostersEach, uint8 frozenLivesGrant, uint16 shardBonusBps, uint32 durationSeconds);

    // ═══════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════

    error InvalidLevel();
    error InvalidStars();
    error ZeroAddress();
    error NotAuthorized();
    error ShopPausedError();
    error GameplayPausedError();
    error InvalidItemKind();
    error ItemNotFound();
    error ItemDisabled_();
    error ItemMaxExceeded();
    error InsufficientBalance();
    error NoLives();
    error QuoteExpired();
    error QuoteNonceUsed();
    error QuoteBadSigner();
    error QuoteBuyerMismatch();
    error QuoteSkuMismatch();
    error QuoteAmountMismatch();
    error PythGuardFailed();
    error WheelSlotInvalid();
    error WheelAlreadySpun();
    error WheelRollExpired();
    error WheelBadSigner();
    error WheelPlayerMismatch();
    error WheelDayMismatch();
    error BadToken();
    error ForwardFailed();
    error InsufficientPayment();
    error ArrayLengthMismatch();
    error ZeroQty();
    error TooManySlots();
    error EthForUsdcCall();
    // V2.1 additions (audit fixes #8, #9, #13)
    error LevelNotStarted();      // submitLevel without prior startLevel
    error TooManyShards();        // shardsEarned.length > MAX_SHARDS_PER_SUBMIT
    error ExactPaymentRequired(); // msg.value != quote.amount on ETH shop fns
    // V2.2 (audit fix #10)
    error ValidatorNotConfigured(); // validatorRelayer is the zero address
    error ValidatorBadSigner();     // sig didn't recover to validatorRelayer
    error ValidatorPlayerMismatch();// signed payload's player != msg.sender
    // V2.3 (starter pack)
    error StarterPackAlreadyClaimed();

    // ═══════════════════════════════════════════════════════════════
    //  INITIALIZER
    // ═══════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        address treasury_,
        address priceRelayer_,
        address wheelRelayer_,
        address usdc_,
        uint16 maxLevel_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();
        if (priceRelayer_ == address(0)) revert ZeroAddress();
        if (wheelRelayer_ == address(0)) revert ZeroAddress();
        if (usdc_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Ownable2Step_init();
        // OZ v5 UUPSUpgradeable needs no __init (uses ERC-7201 namespaced storage)
        __Pausable_init();
        __EIP712_init("PenguCrush", "1");

        treasury     = treasury_;
        priceRelayer = priceRelayer_;
        wheelRelayer = wheelRelayer_;
        usdc         = IERC20(usdc_);
        maxLevel     = maxLevel_;

        // Sanity: USDC must report 6 decimals (defensive, prevents misconfig)
        if (IERC20Metadata(usdc_).decimals() != USDC_DECIMALS) revert BadToken();

        // Default pass perks (matches today's UI)
        passBoostersEach     = 3;
        passFrozenLivesGrant = 2;
        passShardBonusBps    = 1500;       // 15%
        passDurationSeconds  = 7 * 86400;  // 7 days
        crushPassPriceUsdMicros = 4_990_000; // $4.99

        // Authorize the owner as submitter (server-side relays can be added later)
        authorizedSubmitters[owner_] = true;
        emit SubmitterUpdated(owner_, true);

        // Seed items registry with current UI catalogue
        _seedInitialItems();
        _seedInitialWheel();
        _seedInitialPrices();
    }

    function _authorizeUpgrade(address newImpl) internal override onlyOwner {}

    // ═══════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════

    modifier whenGameplayActive() {
        if (gameplayPaused) revert GameplayPausedError();
        _;
    }

    modifier whenShopActive() {
        if (shopPaused) revert ShopPausedError();
        _;
    }

    modifier onlyAuthorized() {
        if (msg.sender != owner() && !authorizedSubmitters[msg.sender]) revert NotAuthorized();
        _;
    }

    // ═══════════════════════════════════════════════════════════════
    //  ITEMS REGISTRY — admin
    // ═══════════════════════════════════════════════════════════════

    function registerItem(bytes32 sku, ItemConfig calldata cfg) external onlyOwner {
        if (cfg.kind == ItemKind.None) revert InvalidItemKind();
        if (items[sku].kind != ItemKind.None) revert ItemNotFound(); // already exists
        items[sku] = cfg;
        itemSkus.push(sku);
        emit ItemRegistered(sku, cfg.kind, cfg.maxBalance, cfg.rarity, cfg.mintRateBps);
    }

    function updateItem(bytes32 sku, ItemConfig calldata cfg) external onlyOwner {
        if (items[sku].kind == ItemKind.None) revert ItemNotFound();
        if (cfg.kind != items[sku].kind) revert InvalidItemKind(); // can't change kind after register
        items[sku] = cfg;
        emit ItemUpdated(sku, cfg.kind, cfg.enabled, cfg.maxBalance, cfg.rarity, cfg.mintRateBps);
    }

    function setItemEnabled(bytes32 sku, bool enabled) external onlyOwner {
        if (items[sku].kind == ItemKind.None) revert ItemNotFound();
        items[sku].enabled = enabled;
        if (!enabled) emit ItemDisabled(sku);
        else emit ItemUpdated(sku, items[sku].kind, true, items[sku].maxBalance, items[sku].rarity, items[sku].mintRateBps);
    }

    function setRandomPool(bytes32 alias_, bytes32[] calldata members) external onlyOwner {
        randomPools[alias_] = members;
        emit RandomPoolSet(alias_, members);
    }

    function getItemSkus() external view returns (bytes32[] memory) {
        return itemSkus;
    }

    function getRandomPool(bytes32 alias_) external view returns (bytes32[] memory) {
        return randomPools[alias_];
    }

    // ═══════════════════════════════════════════════════════════════
    //  WHEEL CONFIG — admin
    // ═══════════════════════════════════════════════════════════════

    function setWheelSlotCount(uint8 count) external onlyOwner {
        if (count > WHEEL_SLOT_HARD_CAP) revert TooManySlots();
        wheelSlotCount = count;
        emit WheelSlotCountUpdated(count);
    }

    function setWheelSlot(uint8 idx, WheelSlot calldata slot) external onlyOwner {
        if (idx >= WHEEL_SLOT_HARD_CAP) revert TooManySlots();
        wheelConfig[idx] = slot;
        emit WheelSlotUpdated(idx, slot.kind, slot.sku, slot.amount, slot.weight, slot.enabled);
    }

    function batchSetWheel(WheelSlot[] calldata slots) external onlyOwner {
        if (slots.length > WHEEL_SLOT_HARD_CAP) revert TooManySlots();
        wheelSlotCount = uint8(slots.length);
        for (uint256 i = 0; i < slots.length; i++) {
            wheelConfig[uint8(i)] = slots[i];
            emit WheelSlotUpdated(uint8(i), slots[i].kind, slots[i].sku, slots[i].amount, slots[i].weight, slots[i].enabled);
        }
        emit WheelSlotCountUpdated(uint8(slots.length));
    }

    function getWheelConfig() external view returns (WheelSlot[] memory slots) {
        slots = new WheelSlot[](wheelSlotCount);
        for (uint8 i = 0; i < wheelSlotCount; i++) slots[i] = wheelConfig[i];
    }

    // ═══════════════════════════════════════════════════════════════
    //  PLAYER — start / submit / checkpoint
    // ═══════════════════════════════════════════════════════════════

    /// Begin a level. Consumes 1 life (regular first, then frozen) and stamps
    /// `levelStartedAt[player][level]` so that `submitLevel` knows a startLevel
    /// actually happened (audit fix #8). Session-key safe.
    ///
    /// If a previous startLevel was never followed by a submitLevel, calling
    /// startLevel again consumes another life and overwrites the timestamp —
    /// the previous attempt is silently abandoned.
    function startLevel(uint16 level) external whenGameplayActive {
        if (level < 1 || level > maxLevel) revert InvalidLevel();
        _materializePassExpiry(msg.sender);
        _consumeLife(msg.sender);
        _registerIfNeeded(msg.sender);
        levelStartedAt[msg.sender][level] = uint64(block.timestamp);
        emit LevelStarted(msg.sender, level, uint64(block.timestamp));
    }

    /// Submit per-level journal at end of run (win OR fail).
    function submitLevel(LevelJournal calldata j) external whenGameplayActive {
        _submitLevelInternal(msg.sender, j);
    }

    /// Authorized server-side relay can submit on behalf of a player.
    function submitLevelFor(address player, LevelJournal calldata j) external whenGameplayActive onlyAuthorized {
        _submitLevelInternal(player, j);
    }

    /// V2.2 (audit fix #10): player-paid submission gated by a validator
    /// signature. The validator (off-chain edge function) applies bounds
    /// checks against the level config before signing. The contract verifies
    /// the EIP-712 signature recovers to `validatorRelayer` and emits an
    /// extra LevelValidated event so off-chain leaderboards can filter on
    /// validated submissions only.
    ///
    /// `submitLevel` (unvalidated) remains available for legacy/non-leaderboard
    /// flows. The on-chain stats record both unconditionally; consumers decide
    /// whether to trust unvalidated ones.
    function submitLevelValidated(LevelJournal calldata j, bytes calldata validatorSig) external whenGameplayActive {
        if (validatorRelayer == address(0)) revert ValidatorNotConfigured();
        bytes32 jHash = keccak256(abi.encode(j));
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            VALIDATION_TYPEHASH, msg.sender, jHash
        )));
        if (ECDSA.recover(digest, validatorSig) != validatorRelayer) revert ValidatorBadSigner();
        _submitLevelInternal(msg.sender, j);
        emit LevelValidated(msg.sender, j.level, jHash);
    }

    /// V2.6 — fused submit + startLevel(nextLevel) in a single tx. Backs the
    /// "Next" / "Replay" buttons on the level-complete popup so the player
    /// only ever prompts/waits once. Atomicity: if the next-level start
    /// reverts (e.g. NoLives), the submit also reverts and nothing changes
    /// on chain.
    function submitAndStartNext(
        LevelJournal calldata j,
        bytes calldata validatorSig,
        uint16 nextLevel
    ) external whenGameplayActive {
        // ── validate + submit (same body as submitLevelValidated) ──
        if (validatorRelayer == address(0)) revert ValidatorNotConfigured();
        bytes32 jHash = keccak256(abi.encode(j));
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            VALIDATION_TYPEHASH, msg.sender, jHash
        )));
        if (ECDSA.recover(digest, validatorSig) != validatorRelayer) revert ValidatorBadSigner();
        _submitLevelInternal(msg.sender, j);
        emit LevelValidated(msg.sender, j.level, jHash);

        // ── start next level (same body as startLevel) ──
        if (nextLevel < 1 || nextLevel > maxLevel) revert InvalidLevel();
        _materializePassExpiry(msg.sender);
        _consumeLife(msg.sender);
        _registerIfNeeded(msg.sender);
        levelStartedAt[msg.sender][nextLevel] = uint64(block.timestamp);
        emit LevelStarted(msg.sender, nextLevel, uint64(block.timestamp));
    }

    /// Mid-game tamper-detection trail. Frontend hashes snapshot before persisting
    /// to off-chain storage; if the off-chain row is later edited, hash mismatches.
    function levelCheckpoint(uint16 level, uint16 moveNum, bytes32 snapshotHash) external whenGameplayActive {
        if (level < 1 || level > maxLevel) revert InvalidLevel();
        emit LevelCheckpoint(msg.sender, level, moveNum, snapshotHash);
    }

    /// V2.3: one-time per-wallet starter pack — 1 of every enabled Booster-kind
    /// item. Permissionless (any player can call for themselves). Idempotent
    /// guard via `claimedStarterPack[msg.sender]`. Iterates `itemSkus[]` so
    /// new Booster items registered later via `registerItem` get included
    /// automatically.
    function claimStarterPack() external whenGameplayActive {
        if (claimedStarterPack[msg.sender]) revert StarterPackAlreadyClaimed();
        claimedStarterPack[msg.sender] = true;
        _registerIfNeeded(msg.sender);
        uint256 n = itemSkus.length;
        for (uint256 i = 0; i < n; i++) {
            bytes32 sku = itemSkus[i];
            ItemConfig memory cfg = items[sku];
            if (cfg.kind != ItemKind.Booster || !cfg.enabled) continue;
            // Only grant if balance is currently 0 — protects against
            // re-claim via a future upgrade that adds a `resetStarterPack`
            // path. Today the `claimedStarterPack` flag already prevents
            // double-claim, so this is belt-and-suspenders.
            if (boosterBalance[msg.sender][sku] == 0) {
                boosterBalance[msg.sender][sku] = 1;
                emit BoosterGranted(msg.sender, sku, 1, 1);
            }
        }
        emit StarterPackClaimed(msg.sender);
    }

    function _submitLevelInternal(address player, LevelJournal calldata j) internal {
        if (j.level < 1 || j.level > maxLevel) revert InvalidLevel();
        if (j.stars > MAX_STARS) revert InvalidStars();
        if (player == address(0)) revert ZeroAddress();
        // Audit fix #8: submitLevel only valid if the player (or an authorized
        // submitter on their behalf) consumed a life via startLevel for this
        // level. Closes the "skip startLevel → infinite plays" exploit.
        if (levelStartedAt[player][j.level] == 0) revert LevelNotStarted();
        // Clear before doing any work so a retry needs a fresh startLevel.
        levelStartedAt[player][j.level] = 0;
        // Audit fix #9: hard-cap the shard array so a modified client cannot
        // mint an arbitrary bag of shards in one submission.
        if (j.shardsEarned.length > MAX_SHARDS_PER_SUBMIT) revert TooManyShards();
        _registerIfNeeded(player);

        // Booster + shard journal — emit per item, update balances
        uint256 nBoosters = j.boostersUsed.length;
        for (uint256 i = 0; i < nBoosters; i++) {
            bytes32 sku = j.boostersUsed[i];
            ItemConfig memory cfg = items[sku];
            if (cfg.kind != ItemKind.Booster || !cfg.enabled) revert ItemDisabled_();
            uint32 cur = boosterBalance[player][sku];
            if (cur == 0) revert InsufficientBalance();
            unchecked { boosterBalance[player][sku] = cur - 1; }
            emit BoosterUsed(player, sku, j.level, boosterBalance[player][sku]);
        }

        uint256 nShards = j.shardsEarned.length;
        for (uint256 i = 0; i < nShards; i++) {
            bytes32 sku = j.shardsEarned[i];
            ItemConfig memory cfg = items[sku];
            if (cfg.kind != ItemKind.Shard || !cfg.enabled) revert ItemDisabled_();
            uint32 newBal = shardBalance[player][sku] + 1;
            if (cfg.maxBalance != 0 && newBal > cfg.maxBalance) revert ItemMaxExceeded();
            shardBalance[player][sku] = newBal;
            emit ShardEarned(player, sku, j.level, newBal);
        }

        // Update best result + aggregate stats
        LevelResult storage best = bestResults[player][j.level];
        bool newBest;
        if (j.completed && (j.stars > best.stars || (j.stars == best.stars && j.score > best.score))) {
            uint32 oldScore = best.score;
            uint8 oldStars = best.stars;
            best.level = j.level;
            best.score = j.score;
            best.stars = j.stars;
            best.movesUsed = j.movesUsed;
            best.timestamp = uint64(block.timestamp);
            newBest = true;

            PlayerStats storage st = playerStats[player];
            // Audit fix #14: saturating add. uint32 totalScore caps at max
            // instead of reverting; preserves elite players' ability to keep
            // improving best-results without locking out their PlayerStats.
            unchecked {
                uint64 next = uint64(st.totalScore) - uint64(oldScore) + uint64(j.score);
                st.totalScore = next > type(uint32).max ? type(uint32).max : uint32(next);
            }
            st.totalStars = uint16(uint256(st.totalStars) - oldStars + j.stars);
            if (j.level > st.highestLevel && j.stars > 0) {
                st.highestLevel = j.level;
                emit HighestLevelAdvanced(player, j.level);
            }
        }

        PlayerStats storage ps = playerStats[player];
        ps.gamesPlayed++;
        if (j.completed) ps.gamesWon++;
        else ps.gamesFailed++;
        ps.lastPlayedAt = uint64(block.timestamp);
        attempts[player][j.level]++;

        // Audit fix #16: include journal hash so indexers can detect calldata
        // rewrites without decoding the full struct per-tx.
        bytes32 journalHash = keccak256(abi.encode(j));
        emit LevelSubmitted(player, j.level, j.score, j.stars, j.movesUsed, j.completed, newBest, journalHash);
    }

    function _registerIfNeeded(address player) internal {
        if (!isRegistered[player]) {
            isRegistered[player] = true;
            players.push(player);
            playerStats[player].firstPlayedAt = uint64(block.timestamp);
            emit PlayerRegistered(player, uint64(block.timestamp));
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  LIVES — 8h regen subsystem
    // ═══════════════════════════════════════════════════════════════

    function _eligibleRegular(LifeAccount memory la)
        internal view
        returns (uint8 effective, uint8 ticks, uint64 newAnchor)
    {
        // Regen ceiling is REGEN_CAP_REGULAR (3), not the storage cap (10).
        // Purchases can stack `regular` above REGEN_CAP_REGULAR; regen never
        // will. lastConsumedAt is cleared once at/above the regen cap.
        if (la.regular >= REGEN_CAP_REGULAR) return (la.regular, 0, 0);
        if (la.lastConsumedAt == 0) return (REGEN_CAP_REGULAR, 0, 0);
        uint256 elapsed = block.timestamp - la.lastConsumedAt;
        uint256 t = elapsed / REGEN_PERIOD;
        if (t == 0) return (la.regular, 0, la.lastConsumedAt);
        uint256 e = uint256(la.regular) + t;
        if (e >= REGEN_CAP_REGULAR) {
            return (REGEN_CAP_REGULAR, uint8(REGEN_CAP_REGULAR - la.regular), 0);
        }
        return (uint8(e), uint8(t), la.lastConsumedAt + uint64(t * REGEN_PERIOD));
    }

    function _consumeLife(address player) internal {
        LifeAccount storage la = lifeAccount[player];

        // Seed the regen-cap on first touch. `_eligibleRegular` reports
        // REGEN_CAP_REGULAR effective lives to `getLives` for a fresh wallet
        // (lastConsumedAt == 0) but cannot write them — the seed has to be
        // materialized by a state-changing path, otherwise every brand-new
        // wallet reverts NoLives on its first startLevel despite the UI
        // showing a full heart row.
        if (la.regular == 0 && la.lastConsumedAt == 0 && la.frozen == 0) {
            la.regular = REGEN_CAP_REGULAR;
            la.lastConsumedAt = uint64(block.timestamp);
            emit LifeRegenerated(player, REGEN_CAP_REGULAR, REGEN_CAP_REGULAR, uint64(block.timestamp));
        }

        // Materialize regen first
        (uint8 eff, uint8 ticks, uint64 anc) = _eligibleRegular(la);
        if (ticks > 0) {
            la.regular = eff;
            la.lastConsumedAt = anc;
            emit LifeRegenerated(player, ticks, eff, uint64(block.timestamp));
        }

        uint16 total = uint16(la.regular) + la.frozen;
        if (total == 0) revert NoLives();

        if (la.regular > 0) {
            la.regular -= 1;
            if (la.lastConsumedAt == 0) la.lastConsumedAt = uint64(block.timestamp);
        } else {
            la.frozen -= 1;
        }

        emit LifeSpent(player, 0, la.regular, la.frozen, uint64(block.timestamp));
    }

    /// Self-claim materialized regen. No-op if no tick is due.
    function claimRegen() external {
        _claimRegenFor(msg.sender);
    }

    /// Anyone can pay gas to materialize anyone's regen.
    function claimRegenFor(address player) external {
        if (_pendingTicks(player) == 0) revert NoLives(); // no-op-not-allowed: cheap sentinel
        _claimRegenFor(player);
    }

    /// Batched version for the hourly cron sweeper.
    function claimRegenBatch(address[] calldata playersBatch) external {
        for (uint256 i = 0; i < playersBatch.length; i++) {
            if (_pendingTicks(playersBatch[i]) > 0) _claimRegenFor(playersBatch[i]);
        }
    }

    function _claimRegenFor(address p) internal {
        _materializePassExpiry(p);
        LifeAccount storage la = lifeAccount[p];
        (uint8 eff, uint8 ticks, uint64 anc) = _eligibleRegular(la);
        if (ticks == 0) return;
        la.regular = eff;
        la.lastConsumedAt = anc;
        emit LifeRegenerated(p, ticks, eff, uint64(block.timestamp));
    }

    function _pendingTicks(address p) internal view returns (uint8) {
        LifeAccount memory la = lifeAccount[p];
        if (la.regular >= REGEN_CAP_REGULAR || la.lastConsumedAt == 0) return 0;
        uint256 elapsed = block.timestamp - la.lastConsumedAt;
        return uint8(elapsed / REGEN_PERIOD);
    }

    function getLives(address p)
        external view
        returns (uint8 regular, uint8 frozen, uint8 total, uint64 secondsToNext)
    {
        LifeAccount memory la = lifeAccount[p];
        CrushPass memory cp = crushPass[p];
        // Virtual pass-expiry: zero frozen if pass has ended
        uint8 effFrozen = (cp.expiresAt > 0 && cp.expiresAt <= block.timestamp) ? 0 : la.frozen;
        (uint8 eff, , uint64 anchor) = _eligibleRegular(la);
        regular = eff;
        frozen = effFrozen;
        total = uint8(uint16(eff) + effFrozen);
        if (eff >= REGEN_CAP_REGULAR || anchor == 0) {
            secondsToNext = 0;
        } else {
            uint256 elapsed = block.timestamp - anchor;
            secondsToNext = uint64(REGEN_PERIOD - elapsed);
        }
    }

    function _grantRegularLives(address p, uint8 qty) internal {
        LifeAccount storage la = lifeAccount[p];
        // Same seed materialization as _consumeLife — a fresh wallet that
        // buys lives before its first startLevel should have the seed
        // included, not lose it.
        if (la.regular == 0 && la.lastConsumedAt == 0 && la.frozen == 0) {
            la.regular = REGEN_CAP_REGULAR;
            la.lastConsumedAt = uint64(block.timestamp);
            emit LifeRegenerated(p, REGEN_CAP_REGULAR, REGEN_CAP_REGULAR, uint64(block.timestamp));
        }
        (uint8 eff, uint8 ticks, uint64 anc) = _eligibleRegular(la);
        if (ticks > 0) {
            la.regular = eff;
            la.lastConsumedAt = anc;
            emit LifeRegenerated(p, ticks, eff, uint64(block.timestamp));
        }
        uint16 next = uint16(la.regular) + qty;
        // Purchases use the HARD cap (10). Regen anchor is cleared as soon
        // as we cross the REGEN cap (3), since there's nothing left for the
        // regen loop to refill.
        la.regular = next > MAX_REGULAR_LIVES ? MAX_REGULAR_LIVES : uint8(next);
        if (la.regular >= REGEN_CAP_REGULAR) la.lastConsumedAt = 0;
        emit LivesPurchased(p, qty, la.regular);
    }

    function _grantFrozenLives(address p, uint8 qty) internal {
        LifeAccount storage la = lifeAccount[p];
        uint16 next = uint16(la.frozen) + qty;
        la.frozen = next > MAX_FROZEN_LIVES ? MAX_FROZEN_LIVES : uint8(next);
        emit FrozenLifeGranted(p, qty, la.frozen);
    }

    function _materializePassExpiry(address p) internal {
        CrushPass storage cp = crushPass[p];
        if (cp.expiresAt != 0 && cp.expiresAt <= block.timestamp) {
            LifeAccount storage la = lifeAccount[p];
            if (la.frozen > 0) {
                uint8 lost = la.frozen;
                la.frozen = 0;
                emit FrozenLivesExpired(p, lost, cp.expiresAt);
            }
            cp.expiresAt = 0;
            emit CrushPassExpired(p);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  SHOP — signed-quote oracle pattern
    // ═══════════════════════════════════════════════════════════════

    bytes32 private constant SHOP_QUOTE_TYPEHASH = keccak256(
        "ShopQuote(address buyer,bytes32 sku,uint32 qty,uint8 currency,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    // V2.2 — validator EIP-712 typehash. Server signs (player, journalHash);
    // contract verifies before recording a "validated" submission.
    bytes32 private constant VALIDATION_TYPEHASH = keccak256(
        "Validation(address player,bytes32 journalHash)"
    );

    function _verifyShopQuote(ShopQuote calldata q, bytes calldata sig, bytes32 expectedSku, Currency expectedCurrency) internal {
        if (block.timestamp > q.deadline) revert QuoteExpired();
        if (usedNonces[q.nonce]) revert QuoteNonceUsed();
        if (q.buyer != msg.sender) revert QuoteBuyerMismatch();
        if (q.sku != expectedSku) revert QuoteSkuMismatch();
        if (q.currency != expectedCurrency) revert QuoteSkuMismatch();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            SHOP_QUOTE_TYPEHASH,
            q.buyer, q.sku, q.qty, uint8(q.currency), q.amount, q.nonce, q.deadline
        )));
        address signer = ECDSA.recover(digest, sig);
        if (signer != priceRelayer) revert QuoteBadSigner();
        usedNonces[q.nonce] = true;
    }

    /// Buy `qty` of a booster sku with ETH. Quote signed by priceRelayer.
    function buyBoosterETH(
        bytes32 sku,
        ShopQuote calldata q,
        bytes calldata sig
    ) external payable whenShopActive nonReentrant {
        ItemConfig memory cfg = items[sku];
        if (cfg.kind != ItemKind.Booster || !cfg.enabled) revert ItemDisabled_();
        if (q.qty == 0) revert ZeroQty();
        _verifyShopQuote(q, sig, sku, Currency.ETH);
        if (msg.value != q.amount) revert ExactPaymentRequired();

        _registerIfNeeded(msg.sender);
        uint32 newBal = boosterBalance[msg.sender][sku] + q.qty;
        if (cfg.maxBalance != 0 && newBal > cfg.maxBalance) revert ItemMaxExceeded();
        boosterBalance[msg.sender][sku] = newBal;
        emit BoosterGranted(msg.sender, sku, q.qty, newBal);
        emit ShopPurchase(msg.sender, sku, q.qty, Currency.ETH, msg.value, q.nonce);

        _forwardEth(msg.value);
    }

    function buyBoosterUSDC(
        bytes32 sku,
        ShopQuote calldata q,
        bytes calldata sig
    ) external whenShopActive nonReentrant {
        ItemConfig memory cfg = items[sku];
        if (cfg.kind != ItemKind.Booster || !cfg.enabled) revert ItemDisabled_();
        if (q.qty == 0) revert ZeroQty();
        _verifyShopQuote(q, sig, sku, Currency.USDC);

        _registerIfNeeded(msg.sender);
        uint32 newBal = boosterBalance[msg.sender][sku] + q.qty;
        if (cfg.maxBalance != 0 && newBal > cfg.maxBalance) revert ItemMaxExceeded();
        boosterBalance[msg.sender][sku] = newBal;
        emit BoosterGranted(msg.sender, sku, q.qty, newBal);
        emit ShopPurchase(msg.sender, sku, q.qty, Currency.USDC, q.amount, q.nonce);

        usdc.safeTransferFrom(msg.sender, treasury, q.amount);
    }

    function buyLivesETH(
        ShopQuote calldata q,
        bytes calldata sig
    ) external payable whenShopActive nonReentrant {
        bytes32 sku = keccak256("life.regular");
        if (q.qty == 0) revert ZeroQty();
        _verifyShopQuote(q, sig, sku, Currency.ETH);
        if (msg.value != q.amount) revert ExactPaymentRequired();

        _registerIfNeeded(msg.sender);
        _grantRegularLives(msg.sender, uint8(q.qty));
        emit ShopPurchase(msg.sender, sku, q.qty, Currency.ETH, msg.value, q.nonce);

        _forwardEth(msg.value);
    }

    function buyLivesUSDC(
        ShopQuote calldata q,
        bytes calldata sig
    ) external whenShopActive nonReentrant {
        bytes32 sku = keccak256("life.regular");
        if (q.qty == 0) revert ZeroQty();
        _verifyShopQuote(q, sig, sku, Currency.USDC);

        _registerIfNeeded(msg.sender);
        _grantRegularLives(msg.sender, uint8(q.qty));
        emit ShopPurchase(msg.sender, sku, q.qty, Currency.USDC, q.amount, q.nonce);

        usdc.safeTransferFrom(msg.sender, treasury, q.amount);
    }

    function buyCrushPassETH(
        ShopQuote calldata q,
        bytes calldata sig
    ) external payable whenShopActive nonReentrant {
        bytes32 sku = keccak256("pass.weekly");
        _verifyShopQuote(q, sig, sku, Currency.ETH);
        if (msg.value != q.amount) revert ExactPaymentRequired();
        _registerIfNeeded(msg.sender);
        _applyCrushPassPurchase(msg.sender, Currency.ETH, msg.value);
        emit ShopPurchase(msg.sender, sku, 1, Currency.ETH, msg.value, q.nonce);
        _forwardEth(msg.value);
    }

    function buyCrushPassUSDC(
        ShopQuote calldata q,
        bytes calldata sig
    ) external whenShopActive nonReentrant {
        bytes32 sku = keccak256("pass.weekly");
        _verifyShopQuote(q, sig, sku, Currency.USDC);
        _registerIfNeeded(msg.sender);
        _applyCrushPassPurchase(msg.sender, Currency.USDC, q.amount);
        emit ShopPurchase(msg.sender, sku, 1, Currency.USDC, q.amount, q.nonce);
        usdc.safeTransferFrom(msg.sender, treasury, q.amount);
    }

    function _applyCrushPassPurchase(address player, Currency currency, uint256 paid) internal {
        _materializePassExpiry(player);
        CrushPass storage cp = crushPass[player];

        uint64 baseExpiry = uint64(block.timestamp);
        if (cp.expiresAt > baseExpiry) baseExpiry = cp.expiresAt;
        cp.expiresAt = baseExpiry + passDurationSeconds;

        // Streak math — Monday-of-week as julian day
        uint64 today = uint64(block.timestamp / 86400);
        uint64 thisMonday = today - (today + 3) % 7;       // 1970-01-01 was Thursday (dow=3)
        uint64 prevMonday = thisMonday - 7;
        if (cp.lastPurchaseWeekMonday == thisMonday) {
            // same-week renewal, keep streak
        } else if (cp.lastPurchaseWeekMonday == prevMonday) {
            cp.streakWeeks += 1;
        } else {
            cp.streakWeeks = 1;
        }
        cp.lastPurchaseWeekMonday = thisMonday;

        // Grant boosters: passBoostersEach of every Booster-kind item
        uint256 nItems = itemSkus.length;
        for (uint256 i = 0; i < nItems; i++) {
            bytes32 sku = itemSkus[i];
            ItemConfig memory cfg = items[sku];
            if (cfg.kind != ItemKind.Booster || !cfg.enabled) continue;
            uint32 newBal = boosterBalance[player][sku] + passBoostersEach;
            if (cfg.maxBalance != 0 && newBal > cfg.maxBalance) newBal = cfg.maxBalance;
            boosterBalance[player][sku] = newBal;
            emit BoosterGranted(player, sku, passBoostersEach, newBal);
        }

        // 15% shard bonus — weighted by item rarity (legendary rarer; we use mintRateBps inverted via rarity tier)
        // Roll uses block-derived randomness — fine for cosmetic bonus, NOT for high-value RNG
        uint256 r = uint256(keccak256(abi.encodePacked(block.timestamp, block.prevrandao, player, paid))) % 10000;
        if (r < passShardBonusBps) {
            bytes32 shardSku = _pickWeightedShard(uint256(keccak256(abi.encodePacked(r, player))));
            if (shardSku != bytes32(0)) {
                ItemConfig memory cfg = items[shardSku];
                uint32 newBal = shardBalance[player][shardSku] + 1;
                if (cfg.maxBalance != 0 && newBal > cfg.maxBalance) newBal = cfg.maxBalance;
                shardBalance[player][shardSku] = newBal;
                emit ShardGranted(player, shardSku, 1, newBal);
                emit CrushPassShardBonus(player, shardSku);
            }
        }

        // Grant frozen lives
        _grantFrozenLives(player, passFrozenLivesGrant);

        emit CrushPassPurchased(player, thisMonday, cp.expiresAt, cp.streakWeeks, currency, paid);
    }

    function _pickWeightedShard(uint256 seed) internal view returns (bytes32) {
        // Sum mintRateBps over all enabled Shard items (inverse rarity weight handled via mintRateBps)
        uint256 totalW;
        uint256 nItems = itemSkus.length;
        for (uint256 i = 0; i < nItems; i++) {
            ItemConfig memory cfg = items[itemSkus[i]];
            if (cfg.kind == ItemKind.Shard && cfg.enabled) totalW += cfg.mintRateBps;
        }
        if (totalW == 0) return bytes32(0);
        uint256 r = seed % totalW;
        for (uint256 i = 0; i < nItems; i++) {
            ItemConfig memory cfg = items[itemSkus[i]];
            if (cfg.kind != ItemKind.Shard || !cfg.enabled) continue;
            if (r < cfg.mintRateBps) return itemSkus[i];
            r -= cfg.mintRateBps;
        }
        return bytes32(0);
    }

    function cancelCrushPass() external {
        CrushPass storage cp = crushPass[msg.sender];
        cp.expiresAt = 0;
        // Frozen lives wiped immediately
        LifeAccount storage la = lifeAccount[msg.sender];
        if (la.frozen > 0) {
            uint8 lost = la.frozen;
            la.frozen = 0;
            emit FrozenLivesExpired(msg.sender, lost, uint64(block.timestamp));
        }
        emit CrushPassCancelled(msg.sender);
    }

    function _forwardEth(uint256 amount) internal {
        (bool ok,) = treasury.call{value: amount}("");
        if (!ok) revert ForwardFailed();
    }

    // ═══════════════════════════════════════════════════════════════
    //  DAILY WHEEL — server-signed RNG
    // ═══════════════════════════════════════════════════════════════

    bytes32 private constant WHEEL_ROLL_TYPEHASH = keccak256(
        "WheelRoll(address player,uint64 dayUtc,uint8 slotIndex,uint256 nonce,uint256 deadline)"
    );

    function spinDailyWheel(WheelRoll calldata roll, bytes calldata sig) external whenGameplayActive {
        if (block.timestamp > roll.deadline) revert WheelRollExpired();
        // Audit fix #15: wheel nonces are now in their own map so a shop nonce
        // collision cannot block a wheel roll (each relayer picks nonces
        // independently). `usedNonces` is reserved for shop quotes only.
        if (usedWheelNonces[roll.nonce]) revert QuoteNonceUsed();
        if (roll.player != msg.sender) revert WheelPlayerMismatch();
        uint64 today = uint64(block.timestamp / 86400);
        if (roll.dayUtc != today) revert WheelDayMismatch();
        if (lastWheelDay[msg.sender] == today) revert WheelAlreadySpun();
        if (roll.slotIndex >= wheelSlotCount) revert WheelSlotInvalid();

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            WHEEL_ROLL_TYPEHASH, roll.player, roll.dayUtc, roll.slotIndex, roll.nonce, roll.deadline
        )));
        if (ECDSA.recover(digest, sig) != wheelRelayer) revert WheelBadSigner();
        usedWheelNonces[roll.nonce] = true;
        lastWheelDay[msg.sender] = today;

        WheelSlot memory s = wheelConfig[roll.slotIndex];
        if (!s.enabled) revert WheelSlotInvalid();

        // Apply prize
        if (s.kind == WheelPrizeKind.TryAgain || s.kind == WheelPrizeKind.None) {
            // nothing
        } else if (s.kind == WheelPrizeKind.Currency) {
            uint64 nb = currencyBalance[msg.sender][s.sku] + uint64(s.amount);
            currencyBalance[msg.sender][s.sku] = nb;
            emit CurrencyChanged(msg.sender, s.sku, int128(uint128(uint32(s.amount))), nb);
        } else if (s.kind == WheelPrizeKind.Booster) {
            // s.sku may be a random pool alias — resolve if so
            bytes32 actualSku = _resolveSkuOrPool(s.sku, uint256(keccak256(abi.encodePacked(roll.nonce, msg.sender))));
            ItemConfig memory cfg = items[actualSku];
            if (cfg.kind == ItemKind.Booster && cfg.enabled) {
                uint32 nb = boosterBalance[msg.sender][actualSku] + s.amount;
                if (cfg.maxBalance != 0 && nb > cfg.maxBalance) nb = cfg.maxBalance;
                boosterBalance[msg.sender][actualSku] = nb;
                emit BoosterGranted(msg.sender, actualSku, s.amount, nb);
            }
        } else if (s.kind == WheelPrizeKind.Shard) {
            ItemConfig memory cfg = items[s.sku];
            if (cfg.kind == ItemKind.Shard && cfg.enabled) {
                uint32 nb = shardBalance[msg.sender][s.sku] + s.amount;
                if (cfg.maxBalance != 0 && nb > cfg.maxBalance) nb = cfg.maxBalance;
                shardBalance[msg.sender][s.sku] = nb;
                emit ShardGranted(msg.sender, s.sku, s.amount, nb);
            }
        } else if (s.kind == WheelPrizeKind.Lives) {
            _grantRegularLives(msg.sender, uint8(s.amount));
        }

        emit DailySpin(msg.sender, today, roll.slotIndex, s.kind, s.sku, s.amount);
    }

    function _resolveSkuOrPool(bytes32 skuOrAlias, uint256 seed) internal view returns (bytes32) {
        bytes32[] memory pool = randomPools[skuOrAlias];
        if (pool.length == 0) return skuOrAlias;
        return pool[seed % pool.length];
    }

    // ═══════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════

    function setMaxLevel(uint16 m) external onlyOwner {
        maxLevel = m;
        emit MaxLevelUpdated(m);
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, t);
        treasury = t;
    }

    function setPriceRelayer(address r) external onlyOwner {
        if (r == address(0)) revert ZeroAddress();
        emit PriceRelayerUpdated(priceRelayer, r);
        priceRelayer = r;
    }

    function setWheelRelayer(address r) external onlyOwner {
        if (r == address(0)) revert ZeroAddress();
        emit WheelRelayerUpdated(wheelRelayer, r);
        wheelRelayer = r;
    }

    /// V2.2: admin sets the EOA whose EIP-712 signatures `submitLevelValidated`
    /// will accept. Setting to address(0) disables validated submissions; the
    /// `submitLevel` path stays available regardless.
    function setValidatorRelayer(address r) external onlyOwner {
        emit ValidatorRelayerUpdated(validatorRelayer, r);
        validatorRelayer = r;
    }

    function setUsdcToken(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        if (IERC20Metadata(t).decimals() != USDC_DECIMALS) revert BadToken();
        usdc = IERC20(t);
        emit UsdcTokenSet(t);
    }

    function setShopPaused(bool p) external onlyOwner {
        shopPaused = p;
        emit ShopPausedSet(p);
    }

    function setGameplayPaused(bool p) external onlyOwner {
        gameplayPaused = p;
        emit GameplayPausedSet(p);
    }

    function setAuthorizedSubmitter(address s, bool a) external onlyOwner {
        authorizedSubmitters[s] = a;
        emit SubmitterUpdated(s, a);
    }

    function setSkuPrice(bytes32 sku, uint64 priceUsdMicros) external onlyOwner {
        skuPriceUsdMicros[sku] = priceUsdMicros;
        emit SkuPriceUpdated(sku, priceUsdMicros);
    }

    function setCrushPassPrice(uint64 priceUsdMicros) external onlyOwner {
        crushPassPriceUsdMicros = priceUsdMicros;
        emit CrushPassPriceUpdated(priceUsdMicros);
    }

    function setPassPerks(uint8 boostersEach, uint8 frozenLivesGrant, uint16 shardBonusBps, uint32 durationSeconds) external onlyOwner {
        passBoostersEach = boostersEach;
        passFrozenLivesGrant = frozenLivesGrant;
        passShardBonusBps = shardBonusBps;
        passDurationSeconds = durationSeconds;
        emit PassPerksUpdated(boostersEach, frozenLivesGrant, shardBonusBps, durationSeconds);
    }

    function setPythConfig(address pyth_, bytes32 ethUsdId_, bool enabled_) external onlyOwner {
        pyth = pyth_;
        pythEthUsdId = ethUsdId_;
        pythGuardEnabled = enabled_;
        emit PythConfigUpdated(pyth_, ethUsdId_, enabled_);
    }

    // ═══════════════════════════════════════════════════════════════
    //  READS
    // ═══════════════════════════════════════════════════════════════

    function getBestResult(address p, uint16 level) external view returns (LevelResult memory) {
        return bestResults[p][level];
    }

    function getPlayerStats(address p) external view returns (PlayerStats memory) {
        return playerStats[p];
    }

    function getPlayerCount() external view returns (uint256) {
        return players.length;
    }

    function getPlayers(uint256 offset, uint256 limit) external view returns (address[] memory) {
        if (offset >= players.length) return new address[](0);
        uint256 end = offset + limit;
        if (end > players.length) end = players.length;
        address[] memory out = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) out[i - offset] = players[i];
        return out;
    }

    function getLeaderboardBatch(address[] calldata addrs) external view returns (PlayerStats[] memory) {
        PlayerStats[] memory s = new PlayerStats[](addrs.length);
        for (uint256 i = 0; i < addrs.length; i++) s[i] = playerStats[addrs[i]];
        return s;
    }

    function getInventory(address p) external view returns (
        bytes32[] memory skus,
        ItemKind[] memory kinds,
        uint32[] memory balances
    ) {
        uint256 n = itemSkus.length;
        skus = new bytes32[](n);
        kinds = new ItemKind[](n);
        balances = new uint32[](n);
        for (uint256 i = 0; i < n; i++) {
            bytes32 sku = itemSkus[i];
            skus[i] = sku;
            kinds[i] = items[sku].kind;
            if (items[sku].kind == ItemKind.Booster) balances[i] = boosterBalance[p][sku];
            else if (items[sku].kind == ItemKind.Shard) balances[i] = shardBalance[p][sku];
            else if (items[sku].kind == ItemKind.Currency) balances[i] = uint32(currencyBalance[p][sku]); // truncated
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  INTERNAL — seed catalogue at initialize() time
    // ═══════════════════════════════════════════════════════════════

    function _seedInitialItems() internal {
        // Boosters
        _seedItem("booster.row",       ItemKind.Booster,  0, 0, 0);
        _seedItem("booster.col",       ItemKind.Booster,  0, 0, 0);
        _seedItem("booster.colorBomb", ItemKind.Booster,  0, 0, 0);
        _seedItem("booster.hammer",    ItemKind.Booster,  0, 0, 0);
        _seedItem("booster.shuffle",   ItemKind.Booster,  0, 0, 0);
        // Shards
        _seedItem("shard.necklace", ItemKind.Shard, 0, 1, 2000); // common 20%
        _seedItem("shard.crown",    ItemKind.Shard, 0, 2, 1000); // rare 10%
        _seedItem("shard.plooshie", ItemKind.Shard, 0, 3,  500); // legendary 5%
        // Currencies
        _seedItem("currency.coins", ItemKind.Currency, 0, 0, 0);
        _seedItem("currency.gems",  ItemKind.Currency, 0, 0, 0);
        _seedItem("currency.xp",    ItemKind.Currency, 0, 0, 0);
        // Lives metadata (balances handled in lifeAccount struct, not boosterBalance)
        _seedItem("life.regular", ItemKind.Lives, MAX_REGULAR_LIVES, 0, 0);
        _seedItem("life.frozen",  ItemKind.Lives, MAX_FROZEN_LIVES,  0, 0);
        // Random pool: ice boost = any booster
        bytes32[] memory pool = new bytes32[](5);
        pool[0] = keccak256("booster.row");
        pool[1] = keccak256("booster.col");
        pool[2] = keccak256("booster.colorBomb");
        pool[3] = keccak256("booster.hammer");
        pool[4] = keccak256("booster.shuffle");
        bytes32 alias_ = keccak256("pool.iceboost");
        randomPools[alias_] = pool;
        emit RandomPoolSet(alias_, pool);
    }

    function _seedItem(string memory name, ItemKind kind, uint32 maxBal, uint8 rarity, uint16 rate) internal {
        bytes32 sku = keccak256(bytes(name));
        items[sku] = ItemConfig({
            kind: kind, enabled: true, maxBalance: maxBal, rarity: rarity, mintRateBps: rate
        });
        itemSkus.push(sku);
        emit ItemRegistered(sku, kind, maxBal, rarity, rate);
    }

    function _seedInitialWheel() internal {
        WheelSlot[6] memory s = [
            WheelSlot({kind: WheelPrizeKind.Currency, sku: keccak256("currency.gems"),  amount:   5, weight: 2000, enabled: true}),
            WheelSlot({kind: WheelPrizeKind.TryAgain, sku: bytes32(0),                  amount:   0, weight: 2000, enabled: true}),
            WheelSlot({kind: WheelPrizeKind.Currency, sku: keccak256("currency.xp"),    amount: 100, weight: 2000, enabled: true}),
            WheelSlot({kind: WheelPrizeKind.Currency, sku: keccak256("currency.coins"), amount:  50, weight: 1500, enabled: true}),
            WheelSlot({kind: WheelPrizeKind.Booster,  sku: keccak256("pool.iceboost"),  amount:   1, weight: 1500, enabled: true}),
            WheelSlot({kind: WheelPrizeKind.Currency, sku: keccak256("currency.xp"),    amount: 250, weight: 1000, enabled: true})
        ];
        wheelSlotCount = 6;
        for (uint8 i = 0; i < 6; i++) {
            wheelConfig[i] = s[i];
            emit WheelSlotUpdated(i, s[i].kind, s[i].sku, s[i].amount, s[i].weight, s[i].enabled);
        }
        emit WheelSlotCountUpdated(6);
    }

    function _seedInitialPrices() internal {
        // Today's UI: $2.98 boosters, $2.99 lives, $4.99 pass
        skuPriceUsdMicros[keccak256("booster.row")]       = 2_980_000;
        skuPriceUsdMicros[keccak256("booster.col")]       = 2_980_000;
        skuPriceUsdMicros[keccak256("booster.colorBomb")] = 2_980_000;
        skuPriceUsdMicros[keccak256("booster.hammer")]    = 2_980_000;
        skuPriceUsdMicros[keccak256("booster.shuffle")]   = 2_980_000;
        skuPriceUsdMicros[keccak256("life.regular")]      = 2_990_000;
        skuPriceUsdMicros[keccak256("pass.weekly")]       = 4_990_000;
    }

    // ═══════════════════════════════════════════════════════════════
    //  RECEIVE / FALLBACK — refuse ETH except via shop functions
    // ═══════════════════════════════════════════════════════════════

    receive() external payable { revert ForwardFailed(); }
    fallback() external payable { revert ForwardFailed(); }
}
