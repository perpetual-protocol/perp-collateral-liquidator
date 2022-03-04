// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { IPeripheryImmutableState } from "@uniswap/v3-periphery/contracts/interfaces/IPeripheryImmutableState.sol";
import { ISwapRouter } from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import { PoolAddress } from "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";
// import { Collateral } from "@perp/curie-contract/contracts/lib/Collateral.sol";
import { IVault } from "@perp/curie-contract/contracts/interface/IVault.sol";

import "hardhat/console.sol";

contract Liquidator is IUniswapV3SwapCallback, Ownable {
    using SafeMath for uint256;
    using SafeCast for uint256;
    using SignedSafeMath for int256;
    using SafeCast for int256;
    using SafeERC20 for IERC20;

    struct SwapCallbackData {
        bytes path;
        address trader;
        address baseToken;
        address pool;
        uint256 minSettlementAmount;
    }

    struct Hop {
        address tokenIn;
        uint24 fee;
        address tokenOut;
    }

    address internal _vault;
    address internal _swapRouter;

    //
    // EXTERNAL NON-VIEW
    //

    function initialize(address vaultArg, address swapRouter) external {
        _vault = vaultArg;
        _swapRouter = swapRouter;

        address settlementToken = IVault(_vault).getSettlementToken();
        IERC20(settlementToken).safeApprove(vaultArg, uint256(-1));
    }

    function withdraw(address token) external onlyOwner {
        IERC20(token).safeTransfer(owner(), IERC20(token).balanceOf(address(this)));
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
        (uint256 collateralAmount, uint256 firstHopOutAmount, address collateralToken) =
            amount0Delta > amount1Delta
                ? (uint256(amount0Delta), uint256(-amount1Delta), IUniswapV3Pool(data.pool).token0())
                : (uint256(amount1Delta), uint256(-amount0Delta), IUniswapV3Pool(data.pool).token1());

        if (data.path.length > 0) {
            // multi-hop, perform the rest hops
            ISwapRouter.ExactInputParams memory params =
                ISwapRouter.ExactInputParams({
                    path: data.path, // abi.encodePacked(ETH, poolFee, USDC),
                    recipient: msg.sender,
                    deadline: block.timestamp,
                    amountIn: firstHopOutAmount,
                    amountOutMinimum: data.minSettlementAmount
                });
            ISwapRouter(_swapRouter).exactInput(params);
        } else {
            // single-hop, firstHopOutAmount = settlement token received from swap
            // L_LTMSTP: less than minSettlementTokenProfit
            require(firstHopOutAmount >= data.minSettlementAmount, "L_LTMSTP");
        }

        IVault(_vault).liquidateCollateralExactOutput(data.trader, data.baseToken, collateralAmount);

        // transfer the collateral to uniswap pool
        IERC20(collateralToken).safeTransfer(data.pool, collateralAmount);
    }

    function flashLiquidate(
        address trader,
        uint256 maxSettlementTokenSpent,
        int256 minSettlementTokenProfit, // negative = allow liquidation at a loss
        Hop memory pathHead, // [crv, fee, eth]
        bytes memory pathTail // [eth, fee, usdc]
    ) external {
        (uint256 settlement, uint256 collateral) = IVault(_vault).getMaxLiquidationAmounts(trader, pathHead.tokenIn);
        if (settlement > maxSettlementTokenSpent) {
            collateral = IVault(_vault).getLiquidationAmountOut(pathHead.tokenIn, maxSettlementTokenSpent);
        }
        bool zeroForOne = pathHead.tokenIn < pathHead.tokenOut;
        address pool = _getPool(pathHead.tokenIn, pathHead.tokenOut, pathHead.fee);
        int256 minSettlementAmount = settlement.toInt256().add(minSettlementTokenProfit);
        bytes memory data = abi.encode(
            SwapCallbackData({
                path : pathTail,
                trader : trader,
                baseToken : pathHead.tokenIn,
                pool : pool,
                minSettlementAmount : minSettlementAmount < 0 ? 0 : minSettlementAmount.toUint256()
            })
        );
        IUniswapV3Pool(pool).swap(
            address(this),
            zeroForOne,
            collateral.toInt256(),
            (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1),
            data
        );
    }

    function getMaxProfitableCollateral(address trader) external view returns (address targetCollateral) {
        address[] memory collaterals = IVault(_vault).getCollateralTokens(trader);
        uint256 collateralLength = collaterals.length;
        uint256 maxValue = 0;
        targetCollateral = address(0x0);
        for (uint256 i = 0; i < collateralLength; i++) {
            (uint256 value, ) = IVault(_vault).getMaxLiquidationAmounts(trader, collaterals[i]);
            if (value > maxValue) {
                maxValue = value;
                targetCollateral = collaterals[i];
            }
        }
    }

    //
    // PRIVATE VIEW
    //

    function _getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) private view returns (address) {
        return
            PoolAddress.computeAddress(
                IPeripheryImmutableState(_swapRouter).factory(),
                PoolAddress.getPoolKey(tokenA, tokenB, fee)
            );
    }
}
