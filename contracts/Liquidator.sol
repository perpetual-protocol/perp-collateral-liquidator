// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";

// import { Collateral } from "@perp/lushan/artifacts/contracts/lib/Collateral.sol";

contract Liquidator is IUniswapV3SwapCallback, Ownable {
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override {
        // TODO: wip
    }

    function flashLiquidate(
        address trader,
        address baseToken,
        uint256 maxSettlementTokenSpent,
        uint256 minSettlementTokenProfit
    ) external {
        // TODO: wip
    }

    function getMaxProfitableCollateral(address trader) external {
        // TODO: wip
        // 1. This loops thorugh liquidatable account’s collaterals (Vault.getCollateralTokensMap(trader))
        //    and get the most valuable collateral (Vault.getMaxLiquidationAmount(trader, token))
        // 2. return the collateral (Collateral.Config)
    }
}
