// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract BlitzLeaderboard {
    using ECDSA for bytes32;

    address public signer; // backend attestor
    mapping(uint256 => uint256) public best; // gameId => best score

    event NewBest(uint256 indexed gameId, uint256 score);

    constructor(address _signer) {
        signer = _signer;
    }

    function setSigner(address s) external {
        require(msg.sender == signer, "only signer can rotate");
        signer = s;
    }

    function submit(
        uint256 gameId,
        uint256 score,
        bytes calldata sig
    ) external {
        // Domain tag avoids replay between games
        bytes32 digest = keccak256(
            abi.encodePacked("BLOCKTIME_BLITZ", gameId, score)
        ).toEthSignedMessageHash();

        address rec = digest.recover(sig);
        require(rec == signer, "bad sig");

        if (score > best[gameId]) {
            best[gameId] = score;
            emit NewBest(gameId, score);
        }
    }
}
