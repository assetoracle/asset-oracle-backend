// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title AssetOracleMarketManager
 * @notice Testnet-first binary market escrow for Asset Oracle.
 * @dev Do not deploy with real funds before independent review and full test coverage.
 *      Token addresses are configured before the first market and cannot be changed later.
 */
contract AssetOracleMarketManager is Ownable, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant MARKET_CREATOR_ROLE = keccak256("MARKET_CREATOR_ROLE");
    bytes32 public constant ORACLE_RESOLVER_ROLE = keccak256("ORACLE_RESOLVER_ROLE");

    uint256 public constant BPS = 10_000;
    uint256 public constant TRADING_FEE_BPS = 25; // 0.25% per stake
    uint256 public constant SETTLEMENT_FEE_BPS = 200; // 2% on eligible winning settlements
    uint256 public constant VALIDATOR_SHARE_OF_SETTLEMENT_FEE_BPS = 2_500; // 25% of the 2% fee
    uint256 public constant NO_WINNER_REFUND_BPS = 7_500; // 75% returned pro rata; 25% retained
    uint256 public constant NO_WINNER_RETAINED_BPS = 2_500;

    enum Stablecoin { CNGN, USDT, USDC }
    enum Outcome { UNRESOLVED, YES, NO, INVALID }
    enum Status { OPEN, CLOSED, DISPUTED, SETTLED, REFUNDABLE, CANCELLED }

    struct StablecoinConfig {
        address token;
        uint8 decimals;
        bool enabled;
    }

    struct Market {
        uint256 id;
        address creator;
        Stablecoin stablecoin;
        string question;
        string resolutionRules;
        string evidenceSource;
        uint64 closeTime;
        uint64 challengePeriod;
        uint64 resolvedAt;
        uint256 totalYes;
        uint256 totalNo;
        uint256 totalStaked;
        Outcome outcome;
        Status status;
        bytes32 evidenceHash;
    }

    struct Position {
        uint256 yes;
        uint256 no;
        bool claimed;
    }

    mapping(Stablecoin => StablecoinConfig) public stablecoins;
    mapping(uint256 => Market) private markets;
    mapping(uint256 => mapping(address => Position)) public positions;
    mapping(uint256 => mapping(address => uint256)) public refunds;
    mapping(address => bool) public hasCreatedMarket;

    uint256 public marketCount;
    uint256 public totalMarketsCreated;
    bool public marketCreationStarted;

    address public treasury;
    address public validatorRewardPool;
    uint16 public minimumStakeBps = 1; // 0.01% is not used as a cap; see createMarket's minStake.
    uint64 public defaultChallengePeriod = 1 days;

    event StablecoinConfigured(Stablecoin indexed kind, address indexed token, uint8 decimals);
    event MarketCreatorUpdated(address indexed account, bool enabled);
    event OracleResolverUpdated(address indexed account, bool enabled);
    event MarketCreated(uint256 indexed marketId, address indexed creator, Stablecoin stablecoin, uint64 closeTime, string question);
    event Staked(uint256 indexed marketId, address indexed user, bool yesSide, uint256 grossAmount, uint256 fee, uint256 netAmount);
    event MarketClosed(uint256 indexed marketId);
    event MarketResolved(uint256 indexed marketId, Outcome outcome, bytes32 evidenceHash, address indexed resolver);
    event MarketDisputed(uint256 indexed marketId, address indexed disputant, bytes32 evidenceHash);
    event MarketFinalized(uint256 indexed marketId, Outcome outcome);
    event Claimed(uint256 indexed marketId, address indexed user, uint256 amount);
    event Refunded(uint256 indexed marketId, address indexed user, uint256 amount);
    event FeesDistributed(uint256 indexed marketId, uint256 validatorAmount, uint256 treasuryAmount);
    event MarketCancelled(uint256 indexed marketId, bytes32 reasonHash);

    error InvalidAddress();
    error InvalidToken();
    error TokenDecimalsMismatch();
    error StablecoinConfigurationLocked();
    error MarketNotFound();
    error InvalidMarketParameters();
    error MarketNotOpen();
    error MarketNotClosable();
    error UnauthorizedMarketCreator();
    error UnauthorizedResolver();
    error InvalidOutcome();
    error ChallengeWindowActive();
    error ChallengeWindowClosed();
    error AlreadyClaimed();
    error NothingToClaim();
    error InvalidStatus();
    error ExactTransferRequired();
    error DisputeRequiresParticipant();
    error AlreadyDisputed();

    constructor(address initialOwner, address treasury_, address validatorRewardPool_)
        Ownable(initialOwner)
    {
        if (initialOwner == address(0) || treasury_ == address(0) || validatorRewardPool_ == address(0)) {
            revert InvalidAddress();
        }
        treasury = treasury_;
        validatorRewardPool = validatorRewardPool_;
        _grantRole(DEFAULT_ADMIN_ROLE, initialOwner);
        _grantRole(MARKET_CREATOR_ROLE, initialOwner);
        _grantRole(ORACLE_RESOLVER_ROLE, initialOwner);
    }

    function configureStablecoin(Stablecoin kind, address token, uint8 expectedDecimals) external onlyOwner {
        if (marketCreationStarted) revert StablecoinConfigurationLocked();
        if (token == address(0) || token.code.length == 0) revert InvalidToken();
        if (expectedDecimals == 0 || expectedDecimals > 18) revert TokenDecimalsMismatch();
        try IERC20Metadata(token).decimals() returns (uint8 actualDecimals) {
            if (actualDecimals != expectedDecimals) revert TokenDecimalsMismatch();
        } catch {
            revert InvalidToken();
        }
        for (uint8 i = 0; i < 3; i++) {
            StablecoinConfig memory existing = stablecoins[Stablecoin(i)];
            if (existing.enabled && existing.token == token && Stablecoin(i) != kind) revert InvalidToken();
        }
        stablecoins[kind] = StablecoinConfig(token, expectedDecimals, true);
        emit StablecoinConfigured(kind, token, expectedDecimals);
    }

    function setMarketCreator(address account, bool enabled) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        if (enabled) _grantRole(MARKET_CREATOR_ROLE, account);
        else _revokeRole(MARKET_CREATOR_ROLE, account);
        emit MarketCreatorUpdated(account, enabled);
    }

    function setOracleResolver(address account, bool enabled) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        if (enabled) _grantRole(ORACLE_RESOLVER_ROLE, account);
        else _revokeRole(ORACLE_RESOLVER_ROLE, account);
        emit OracleResolverUpdated(account, enabled);
    }

    function setFeeRecipients(address treasury_, address validatorPool_) external onlyOwner {
        if (treasury_ == address(0) || validatorPool_ == address(0)) revert InvalidAddress();
        treasury = treasury_;
        validatorRewardPool = validatorPool_;
    }

    function setDefaultChallengePeriod(uint64 seconds_) external onlyOwner {
        if (seconds_ < 1 hours || seconds_ > 7 days) revert InvalidMarketParameters();
        defaultChallengePeriod = seconds_;
    }

    function createMarket(
        Stablecoin stablecoin,
        string calldata question,
        string calldata resolutionRules,
        string calldata evidenceSource,
        uint64 closeTime,
        uint64 challengePeriod
    ) external onlyRole(MARKET_CREATOR_ROLE) returns (uint256 marketId) {
        StablecoinConfig memory tokenConfig = stablecoins[stablecoin];
        if (!tokenConfig.enabled) revert InvalidToken();
        if (
            bytes(question).length < 12 || bytes(resolutionRules).length < 20 ||
            bytes(evidenceSource).length == 0 || closeTime <= block.timestamp ||
            challengePeriod < 1 hours || challengePeriod > 7 days
        ) revert InvalidMarketParameters();

        marketCreationStarted = true;
        marketId = ++marketCount;
        markets[marketId] = Market({
            id: marketId,
            creator: msg.sender,
            stablecoin: stablecoin,
            question: question,
            resolutionRules: resolutionRules,
            evidenceSource: evidenceSource,
            closeTime: closeTime,
            challengePeriod: challengePeriod,
            resolvedAt: 0,
            totalYes: 0,
            totalNo: 0,
            totalStaked: 0,
            outcome: Outcome.UNRESOLVED,
            status: Status.OPEN,
            evidenceHash: bytes32(0)
        });
        totalMarketsCreated++;
        hasCreatedMarket[msg.sender] = true;
        emit MarketCreated(marketId, msg.sender, stablecoin, closeTime, question);
    }

    function stake(uint256 marketId, bool yesSide, uint256 grossAmount) external nonReentrant {
        Market storage market = markets[marketId];
        if (market.id == 0) revert MarketNotFound();
        if (market.status != Status.OPEN || block.timestamp >= market.closeTime) revert MarketNotOpen();
        if (grossAmount == 0) revert InvalidMarketParameters();

        StablecoinConfig memory tokenConfig = stablecoins[market.stablecoin];
        IERC20 token = IERC20(tokenConfig.token);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), grossAmount);
        uint256 received = token.balanceOf(address(this)) - beforeBalance;
        if (received != grossAmount) revert ExactTransferRequired();

        uint256 tradingFee = (grossAmount * TRADING_FEE_BPS) / BPS;
        uint256 netAmount = grossAmount - tradingFee;
        if (netAmount == 0) revert InvalidMarketParameters();

        Position storage position = positions[marketId][msg.sender];
        if (yesSide) {
            position.yes += netAmount;
            market.totalYes += netAmount;
        } else {
            position.no += netAmount;
            market.totalNo += netAmount;
        }
        market.totalStaked += netAmount;

        if (tradingFee > 0) token.safeTransfer(treasury, tradingFee);
        emit Staked(marketId, msg.sender, yesSide, grossAmount, tradingFee, netAmount);
    }

    function closeMarket(uint256 marketId) external {
        Market storage market = markets[marketId];
        if (market.id == 0) revert MarketNotFound();
        if (market.status != Status.OPEN) revert InvalidStatus();
        if (block.timestamp < market.closeTime) revert MarketNotClosable();
        if (msg.sender != market.creator && msg.sender != owner()) revert UnauthorizedMarketCreator();
        market.status = Status.CLOSED;
        emit MarketClosed(marketId);
    }

    function resolveMarket(uint256 marketId, Outcome outcome, bytes32 evidenceHash) external onlyRole(ORACLE_RESOLVER_ROLE) {
        Market storage market = markets[marketId];
        if (market.id == 0) revert MarketNotFound();
        if (market.status != Status.CLOSED) revert InvalidStatus();
        if (outcome != Outcome.YES && outcome != Outcome.NO && outcome != Outcome.INVALID) revert InvalidOutcome();
        if (evidenceHash == bytes32(0)) revert InvalidMarketParameters();
        market.outcome = outcome;
        market.evidenceHash = evidenceHash;
        market.resolvedAt = uint64(block.timestamp);
        market.status = Status.DISPUTED;
        emit MarketResolved(marketId, outcome, evidenceHash, msg.sender);
    }

    function disputeResolution(uint256 marketId, bytes32 evidenceHash) external {
        Market storage market = markets[marketId];
        if (market.id == 0) revert MarketNotFound();
        if (market.status != Status.DISPUTED) revert InvalidStatus();
        if (block.timestamp >= uint256(market.resolvedAt) + market.challengePeriod) revert ChallengeWindowClosed();
        Position memory position = positions[marketId][msg.sender];
        if (position.yes == 0 && position.no == 0) revert DisputeRequiresParticipant();
        if (evidenceHash == bytes32(0)) revert InvalidMarketParameters();
        market.status = Status.REFUNDABLE;
        emit MarketDisputed(marketId, msg.sender, evidenceHash);
    }

    function finalizeMarket(uint256 marketId) external {
        Market storage market = markets[marketId];
        if (market.id == 0) revert MarketNotFound();
        if (market.status != Status.DISPUTED) revert InvalidStatus();
        if (block.timestamp < uint256(market.resolvedAt) + market.challengePeriod) revert ChallengeWindowActive();
        market.status = Status.SETTLED;
        emit MarketFinalized(marketId, market.outcome);
    }

    function claim(uint256 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        if (market.id == 0) revert MarketNotFound();
        if (market.status != Status.SETTLED) revert InvalidStatus();
        Position storage position = positions[marketId][msg.sender];
        if (position.claimed) revert AlreadyClaimed();
        uint256 amount;
        IERC20 token = IERC20(stablecoins[market.stablecoin].token);

        if (market.outcome == Outcome.INVALID) {
            amount = position.yes + position.no;
            if (amount == 0) revert NothingToClaim();
            position.claimed = true;
            token.safeTransfer(msg.sender, amount);
            emit Refunded(marketId, msg.sender, amount);
            return;
        }

        uint256 winningPool = market.outcome == Outcome.YES ? market.totalYes : market.totalNo;
        if (winningPool == 0) {
            // All participants receive 75% of their net stake; retained 25% is sent once.
            amount = ((position.yes + position.no) * NO_WINNER_REFUND_BPS) / BPS;
            if (amount == 0) revert NothingToClaim();
            position.claimed = true;
            token.safeTransfer(msg.sender, amount);
            emit Refunded(marketId, msg.sender, amount);
            return;
        }

        uint256 fee = (market.totalStaked * SETTLEMENT_FEE_BPS) / BPS;
        uint256 validatorFee = (fee * VALIDATOR_SHARE_OF_SETTLEMENT_FEE_BPS) / BPS;
        uint256 treasuryFee = fee - validatorFee;
        uint256 userWinningStake = market.outcome == Outcome.YES ? position.yes : position.no;
        if (userWinningStake == 0) {
            position.claimed = true;
            return;
        }

        amount = (userWinningStake * (market.totalStaked - fee)) / winningPool;
        position.claimed = true;
        // Fees are disbursed once, on the first winning claim; no arbitrary admin withdrawal exists.
        if (market.totalStaked > 0 && !feesPaid[marketId]) {
            feesPaid[marketId] = true;
            token.safeTransfer(validatorRewardPool, validatorFee);
            token.safeTransfer(treasury, treasuryFee);
            emit FeesDistributed(marketId, validatorFee, treasuryFee);
        }
        token.safeTransfer(msg.sender, amount);
        emit Claimed(marketId, msg.sender, amount);
    }

    mapping(uint256 => bool) public feesPaid;
    mapping(uint256 => bool) public noWinnerRetentionPaid;

    function payNoWinnerRetention(uint256 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        if (market.id == 0) revert MarketNotFound();
        if (market.status != Status.SETTLED || market.outcome == Outcome.INVALID) revert InvalidStatus();
        uint256 winningPool = market.outcome == Outcome.YES ? market.totalYes : market.totalNo;
        if (winningPool != 0) revert InvalidOutcome();
        if (noWinnerRetentionPaid[marketId]) revert AlreadyClaimed();
        uint256 retained = (market.totalStaked * NO_WINNER_RETAINED_BPS) / BPS;
        noWinnerRetentionPaid[marketId] = true;
        if (retained > 0) IERC20(stablecoins[market.stablecoin].token).safeTransfer(treasury, retained);
    }

    function cancelMarket(uint256 marketId, bytes32 reasonHash) external onlyOwner {
        Market storage market = markets[marketId];
        if (market.id == 0) revert MarketNotFound();
        if (market.status != Status.OPEN && market.status != Status.CLOSED) revert InvalidStatus();
        market.status = Status.CANCELLED;
        market.evidenceHash = reasonHash;
        emit MarketCancelled(marketId, reasonHash);
    }

    /// @notice Allows users to recover their net stake if a closed market is never resolved.
    /// @dev This path charges no settlement fee and cannot be used before the resolution timeout.
    function refundTimedOutMarket(uint256 marketId) external {
        Market storage market = markets[marketId];
        if (market.id == 0) revert MarketNotFound();
        if (market.status != Status.CLOSED) revert InvalidStatus();
        if (block.timestamp < uint256(market.closeTime) + market.challengePeriod) revert ChallengeWindowActive();
        market.status = Status.REFUNDABLE;
    }

    function refundCancelled(uint256 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        if (market.id == 0) revert MarketNotFound();
        if (market.status != Status.CANCELLED && market.status != Status.REFUNDABLE) revert InvalidStatus();
        Position storage position = positions[marketId][msg.sender];
        if (position.claimed) revert AlreadyClaimed();
        uint256 amount = position.yes + position.no;
        if (amount == 0) revert NothingToClaim();
        position.claimed = true;
        IERC20(stablecoins[market.stablecoin].token).safeTransfer(msg.sender, amount);
        emit Refunded(marketId, msg.sender, amount);
    }

    function getMarket(uint256 marketId) external view returns (Market memory) {
        if (markets[marketId].id == 0) revert MarketNotFound();
        return markets[marketId];
    }

    function getPosition(uint256 marketId, address user) external view returns (Position memory) {
        if (markets[marketId].id == 0) revert MarketNotFound();
        return positions[marketId][user];
    }
}
