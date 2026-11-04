// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title ManualProposalFeeEscrow
 * @notice Holds the fixed Enugu testnet USDC proposal fee until an authorised
 *         reviewer approves the proposal (release to Treasury) or rejects it
 *         (refund to the original payer).
 * @dev This contract is deliberately separate from AssetOracleMarketManager.
 *      It has no owner withdrawal or rescue function: pending proposal fees
 *      cannot be swept or redirected. Deploy a new instance for each network.
 */
contract ManualProposalFeeEscrow is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant REVIEWER_ROLE = keccak256("REVIEWER_ROLE");
    uint256 public constant PROPOSAL_FEE = 10_000_000; // 10 USDC, 6 decimals

    enum Decision {
        NONE,
        PENDING,
        APPROVED,
        REJECTED
    }

    struct ProposalPayment {
        address payer;
        Decision decision;
    }

    IERC20 public usdc;
    address public treasury;
    mapping(bytes32 => ProposalPayment) public proposalPayments;

    event ProposalFeeEscrowed(bytes32 indexed proposalId, address indexed payer, uint256 amount);
    event ProposalFeeReleased(bytes32 indexed proposalId, address indexed payer, address indexed treasury, uint256 amount, address reviewer);
    event ProposalFeeRefunded(bytes32 indexed proposalId, address indexed payer, uint256 amount, address reviewer);
    event ReviewerUpdated(address indexed reviewer, bool enabled);

    error InvalidAddress();
    error InvalidToken();
    error InvalidProposalId();
    error ProposalAlreadyExists();
    error ProposalNotPending();
    error ExactTransferRequired();

    constructor(address initialAdmin, address usdc_, address treasury_) {
        if (initialAdmin == address(0) || treasury_ == address(0)) revert InvalidAddress();
        if (usdc_ == address(0) || usdc_.code.length == 0) revert InvalidToken();
        try IERC20Metadata(usdc_).decimals() returns (uint8 tokenDecimals) {
            if (tokenDecimals != 6) revert InvalidToken();
        } catch {
            revert InvalidToken();
        }

        usdc = IERC20(usdc_);
        treasury = treasury_;
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(REVIEWER_ROLE, initialAdmin);
    }

    /// @notice Allow the administrator to add or remove proposal reviewers.
    function setReviewer(address reviewer, bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (reviewer == address(0)) revert InvalidAddress();
        if (enabled) _grantRole(REVIEWER_ROLE, reviewer);
        else _revokeRole(REVIEWER_ROLE, reviewer);
        emit ReviewerUpdated(reviewer, enabled);
    }

    /// @notice Escrow exactly 10 USDC for one unique proposal identifier.
    /// @dev The caller must approve this contract to spend 10 USDC first.
    function submitProposalFee(bytes32 proposalId) external nonReentrant {
        if (proposalId == bytes32(0)) revert InvalidProposalId();
        if (proposalPayments[proposalId].decision != Decision.NONE) revert ProposalAlreadyExists();

        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), PROPOSAL_FEE);
        uint256 received = usdc.balanceOf(address(this)) - beforeBalance;
        if (received != PROPOSAL_FEE) revert ExactTransferRequired();

        proposalPayments[proposalId] = ProposalPayment({
            payer: msg.sender,
            decision: Decision.PENDING
        });
        emit ProposalFeeEscrowed(proposalId, msg.sender, PROPOSAL_FEE);
    }

    /// @notice Approve a proposal and release its fee to the configured Treasury.
    /// @dev State is updated before the external token transfer; a failed transfer
    ///      reverts the entire transaction and leaves the proposal pending.
    function approveAndRelease(bytes32 proposalId) external onlyRole(REVIEWER_ROLE) nonReentrant {
        ProposalPayment storage payment = proposalPayments[proposalId];
        if (payment.decision != Decision.PENDING) revert ProposalNotPending();

        payment.decision = Decision.APPROVED;
        uint256 beforeBalance = usdc.balanceOf(treasury);
        usdc.safeTransfer(treasury, PROPOSAL_FEE);
        if (usdc.balanceOf(treasury) - beforeBalance != PROPOSAL_FEE) revert ExactTransferRequired();

        emit ProposalFeeReleased(proposalId, payment.payer, treasury, PROPOSAL_FEE, msg.sender);
    }

    /// @notice Reject a proposal and refund the complete fee to its original payer.
    function rejectAndRefund(bytes32 proposalId) external onlyRole(REVIEWER_ROLE) nonReentrant {
        ProposalPayment storage payment = proposalPayments[proposalId];
        if (payment.decision != Decision.PENDING) revert ProposalNotPending();

        address payer = payment.payer;
        payment.decision = Decision.REJECTED;
        uint256 beforeBalance = usdc.balanceOf(payer);
        usdc.safeTransfer(payer, PROPOSAL_FEE);
        if (usdc.balanceOf(payer) - beforeBalance != PROPOSAL_FEE) revert ExactTransferRequired();

        emit ProposalFeeRefunded(proposalId, payer, PROPOSAL_FEE, msg.sender);
    }
}
