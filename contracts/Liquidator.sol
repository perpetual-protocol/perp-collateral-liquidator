// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { ISwapRouter } from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import { SwapRouter } from "@uniswap/v3-periphery/contracts/SwapRouter.sol";
import { Collateral } from "@perp/curie-contract/contracts/lib/Collateral.sol";
import { IVault } from "@perp/curie-contract/contracts/interface/IVault.sol";

contract Liquidator is IUniswapV3SwapCallback, Ownable {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    address internal _vault;
    address internal _swapRouter;

    struct SwapCallbackData {
        bytes path;
        address trader;
        address baseToken;
        address pool;
        uint256 minSettlementAmount;
    }

    function initialize(address vaultArg, address swapRouter) external {
        _vault = vaultArg;
        _swapRouter = swapRouter;
    }

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata _data
    ) external override {
        // swaps entirely within 0-liquidity regions are not supported -> 0 swap is forbidden
        // LH_F0S: forbidden 0 swap
        require((amount0Delta > 0 && amount1Delta < 0) || (amount0Delta < 0 && amount1Delta > 0), "L_F0S");

        SwapCallbackData memory data = abi.decode(_data, (SwapCallbackData));

        // positive: liquidator give pool the collateral
        // negative: liquidator receive from pool (pathTail[0], or USDC)
        // liquidator to liquidate the exact amount of collateral token he's expected to send back to the pool
        (uint256 exactOut, uint256 exactIn) =
            amount0Delta > amount1Delta
                ? (uint256(amount0Delta), uint256(-amount1Delta))
                : (uint256(amount1Delta), uint256(-amount0Delta));

        if (data.path.length > 0) {
            ISwapRouter.ExactInputParams memory params =
                ISwapRouter.ExactInputParams({
                    path: data.path, // abi.encodePacked(ETH, poolFee, USDC),
                    recipient: msg.sender,
                    deadline: block.timestamp,
                    amountIn: exactIn,
                    amountOutMinimum: data.minSettlementAmount
                });
            ISwapRouter(_swapRouter).exactInput(params);
        } else {
            // L_LTMSTP: less than minSettlementTokenProfit
            require(exactIn >= data.minSettlementAmount, "L_LTMSTP");
        }

        // should check if there is no data.path.length amountOutMinimum: data.minSettlementAmount

        IVault(_vault).liquidateCollateralExactOuput(data.trader, data.baseToken, exactOut);

        // transfer amount
        address token = amount0Delta > 0 ? IUniswapV3Pool(data.pool).token0() : IUniswapV3Pool(data.pool).token1();

        // L_TF: Transfer failed
        // TODO: should be safeTransfer, not sure why linter shows error.
        bool success = IERC20(token).transfer(data.pool, exactOut);
        require(success, "L_TF");
    }

    function flashLiquidate(
        address trader,
        uint256 maxSettlementTokenSpent,
        uint256 minSettlementTokenProfit,
        bytes memory pathHead, // [crv, fee, eth]
        bytes memory pathTail // [eth, fee, usdc]
    ) external {
        // TODO: wip

        (uint256 settlement, uint256 collateral) =
            IVault(_vault).getLiquidationAmountOut(trader, pathHead[0], maxSettlementTokenSpent);

        bool zeroForOne = pathHead[0] < pathTail[0];

        address pool = getPool(pathHead[0], pathTail[0], pathHead[1]);

        (int256 amount0, int256 amount1) =
            IUniswapV3Pool(pool).swap(
                msg.sender,
                zeroForOne,
                collateral.toInt256(),
                (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1),
                abi.encode(
                    SwapCallbackData({
                        path: pathTail,
                        trader: trader,
                        baseToken: pathHead[0],
                        pool: pool,
                        minSettlementAmount: settlement.add(minSettlementTokenProfit)
                    })
                )
            );
    }

    function getMaxProfitableCollateral(address trader) public view returns (address targetCollateral) {
        address[] memory collaterals = IVault(_vault).getCollateralTokens(trader);
        uint256 collateralLength = collaterals.length;
        uint256 maxValue = 0;
        targetCollateral = address(0x0);

        for (uint256 i = 0; i < collateralLength; i++) {
            uint256 value = IVault(_vault).getMaxLiquidationValue(trader, collaterals[i]);
            if (value > maxValue) {
                maxValue = value;
                targetCollateral = collaterals[i];
            }
        }
    }

    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) private view returns (address) {
        return SwapRouter(_swapRouter).getPool(tokenA, tokenB, fee);
    }
}
