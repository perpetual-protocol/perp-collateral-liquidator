// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;

library PerpSafeCast {
    function toUint256(int128 num) internal pure returns (uint256) {
        require(num >= 0, "SafeCast: value must be positive");
        return uint256(num);
    }
}
