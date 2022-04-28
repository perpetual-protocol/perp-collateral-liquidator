// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

interface IPoolCurveSwap {
    function exchange_underlying(
        int128 from,
        int128 to,
        uint256 amount,
        uint256 minAmount
    ) external returns (uint256);

    function exchange(
        int128 from,
        int128 to,
        uint256 amount,
        uint256 minAmount
    ) external returns (uint256);
}
