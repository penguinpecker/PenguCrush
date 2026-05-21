// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

// PenguCrushPaymaster — gasless gameplay for PenguCrushV2.
//
// A minimal zkSync EIP-712 paymaster that sponsors gas for ANY tx whose
// destination is PenguCrushV2 (`target`). Players' AGW smart wallets call
// PenguCrushV2 directly for startLevel / submitLevel / etc., so those txs
// match the restriction and run gasless. Anything else (txs to other
// targets, AGW self-call batches, random spam) is refused, so an attacker
// can't drain the paymaster by pointing it at arbitrary contracts.
//
// Owner can withdraw at any time. No upgrade hook — if we need to change
// the policy we deploy a new paymaster and rotate the env var on the
// frontend.

uint256 constant PAYMASTER_VALIDATION_SUCCESS_MAGIC_VAL = uint256(uint32(0x038a24bc));
address constant BOOTLOADER_FORMAL_ADDRESS = 0x0000000000000000000000000000000000008001;
// IPaymasterFlow.general(bytes innerInput) selector
bytes4 constant GENERAL_FLOW_SELECTOR = 0x8c5a3445;

struct Transaction {
    uint256 txType;
    uint256 from;
    uint256 to;
    uint256 gasLimit;
    uint256 gasPerPubdataByteLimit;
    uint256 maxFeePerGas;
    uint256 maxPriorityFeePerGas;
    uint256 paymaster;
    uint256 nonce;
    uint256 value;
    uint256[4] reserved;
    bytes data;
    bytes signature;
    uint256[] factoryDeps;
    bytes paymasterInput;
    bytes reservedDynamic;
}

enum ExecutionResult { Revert, Success }

interface IPaymaster {
    function validateAndPayForPaymasterTransaction(
        bytes32 txHash,
        bytes32 suggestedSignedHash,
        Transaction calldata _transaction
    ) external payable returns (bytes4 magic, bytes memory context);

    function postTransaction(
        bytes calldata context,
        Transaction calldata _transaction,
        bytes32 txHash,
        bytes32 suggestedSignedHash,
        ExecutionResult txResult,
        uint256 maxRefundedGas
    ) external payable;
}

contract PenguCrushPaymaster is IPaymaster {
    address public owner;
    /// Address of PenguCrushV2 proxy. Set at construction and immutable —
    /// rotating the target requires deploying a new paymaster.
    address public immutable target;

    event Sponsored(address indexed from, uint256 gas);
    event Withdraw(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotBootloader();
    error NotOwner();
    error UnsupportedFlow();
    error InputTooShort();
    error TargetNotSponsored();
    error InsufficientFunds();
    error BootloaderPayFailed();
    error WithdrawFailed();
    error ZeroAddress();

    modifier onlyBootloader() {
        if (msg.sender != BOOTLOADER_FORMAL_ADDRESS) revert NotBootloader();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _target) payable {
        if (_target == address(0)) revert ZeroAddress();
        owner = msg.sender;
        target = _target;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function validateAndPayForPaymasterTransaction(
        bytes32 /* txHash */,
        bytes32 /* suggestedSignedHash */,
        Transaction calldata _transaction
    ) external payable onlyBootloader returns (bytes4 magic, bytes memory context) {
        if (_transaction.paymasterInput.length < 4) revert InputTooShort();
        bytes4 selector = bytes4(_transaction.paymasterInput[0:4]);
        if (selector != GENERAL_FLOW_SELECTOR) revert UnsupportedFlow();

        if (address(uint160(_transaction.to)) != target) revert TargetNotSponsored();

        uint256 requiredETH = _transaction.gasLimit * _transaction.maxFeePerGas;
        if (address(this).balance < requiredETH) revert InsufficientFunds();

        (bool ok, ) = payable(BOOTLOADER_FORMAL_ADDRESS).call{value: requiredETH}("");
        if (!ok) revert BootloaderPayFailed();

        magic = bytes4(uint32(PAYMASTER_VALIDATION_SUCCESS_MAGIC_VAL));
        context = "";

        emit Sponsored(address(uint160(_transaction.from)), requiredETH);
    }

    function postTransaction(
        bytes calldata /* context */,
        Transaction calldata /* _transaction */,
        bytes32 /* txHash */,
        bytes32 /* suggestedSignedHash */,
        ExecutionResult /* txResult */,
        uint256 /* maxRefundedGas */
    ) external payable onlyBootloader {
        // No-op. Refunds, if any, accumulate in the paymaster balance and are
        // available for withdrawal by the owner.
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit Withdraw(to, amount);
    }

    function withdrawAll(address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = address(this).balance;
        (bool ok, ) = to.call{value: bal}("");
        if (!ok) revert WithdrawFailed();
        emit Withdraw(to, bal);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    receive() external payable {}
}
