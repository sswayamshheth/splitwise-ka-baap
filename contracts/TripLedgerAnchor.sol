// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GroupTrip Ledger — on-chain anchors
/// @notice Stores a fingerprint of each trip's hash-chained ledger: how many
///         blocks it had, the last block's hash and the Merkle root of all
///         block hashes. No names, amounts or ids ever go on-chain — only
///         hashes, and the trip itself is identified by a salted hash.
/// @dev    Anchors are append-only and the block count must grow, mirroring
///         the ledger: history can be added to, never rewritten.
contract TripLedgerAnchor {
    struct Anchor {
        uint64 blocks;       // number of ledger blocks covered
        uint64 anchoredAt;   // block.timestamp when anchored
        bytes32 headHash;    // hash of the last ledger block
        bytes32 merkleRoot;  // Merkle root over every ledger block hash
    }

    address public immutable owner;
    mapping(bytes32 => Anchor[]) private anchors;

    event Anchored(bytes32 indexed tripKey, uint256 indexed index, uint64 blocks, bytes32 headHash, bytes32 merkleRoot);

    error NotOwner();
    error NotNewer(uint64 lastBlocks, uint64 newBlocks);

    constructor() {
        owner = msg.sender;
    }

    /// @notice Record a new fingerprint for a trip. Only the app's wallet may write.
    function anchor(bytes32 tripKey, uint64 blocks, bytes32 headHash, bytes32 merkleRoot) external {
        if (msg.sender != owner) revert NotOwner();
        Anchor[] storage list = anchors[tripKey];
        if (list.length > 0 && blocks <= list[list.length - 1].blocks) revert NotNewer(list[list.length - 1].blocks, blocks);
        list.push(Anchor(blocks, uint64(block.timestamp), headHash, merkleRoot));
        emit Anchored(tripKey, list.length - 1, blocks, headHash, merkleRoot);
    }

    function count(bytes32 tripKey) external view returns (uint256) {
        return anchors[tripKey].length;
    }

    function get(bytes32 tripKey, uint256 index) external view returns (Anchor memory) {
        return anchors[tripKey][index];
    }
}
