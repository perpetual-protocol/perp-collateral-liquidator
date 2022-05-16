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
import { IUniswapV3FlashCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { ISwapRouter } from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import { PoolAddress } from "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";
import { CallbackValidation } from "@uniswap/v3-periphery/contracts/libraries/CallbackValidation.sol";
import { IVault } from "@perp/curie-contract/contracts/interface/IVault.sol";
import { ICollateralManager } from "@perp/curie-contract/contracts/interface/ICollateralManager.sol";
import { IPoolCurveSwap } from "./Interfaces/IPoolCurveSwap.sol";
import { IFactorySidechains } from "./Interfaces/IFactorySidechains.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";

contract Liquidator is IUniswapV3SwapCallback, IUniswapV3FlashCallback, Ownable {
    using SafeMath for uint256;
    using SafeCast for uint256;
    using SignedSafeMath for int256;
    using SafeCast for int256;
    using PerpSafeCast for int128;
    using SafeERC20 for IERC20;

    struct SwapCallbackData {
        bytes path;
        address trader;
        address baseToken;
        PoolAddress.PoolKey uniPoolKey;
        uint256 minSettlementAmount;
    }

    struct FlashCallbackData {
        address trader;
        address crvFactory;
        address crvPool;
        PoolAddress.PoolKey uniPoolKey;
        address token;
        uint256 settlementAmount;
        uint256 collateralAmount;
        uint256 minSettlementAmount;
    }

    struct Hop {
        address tokenIn;
        uint24 fee;
        address tokenOut;
    }

    struct FlashLiquidateThroughCurveParams {
        address trader;
        uint256 maxSettlementTokenSpent;
        int256 minSettlementTokenProfit;
        address uniPool;
        address crvFactory;
        address crvPool;
        address token;
    }

    address internal immutable _vault;
    address internal immutable _swapRouter;
    address internal immutable _uniFactory;
    address internal immutable _settlementToken;
    address[] internal _crvFactories;

    //
    // EXTERNAL NON-VIEW
    //

    constructor(
        address vaultArg,
        address swapRouterArg,
        address uniFactoryArg,
        address[] memory crvFactoriesArg
    ) {
        _vault = vaultArg;
        _swapRouter = swapRouterArg;
        _uniFactory = uniFactoryArg;
        _crvFactories = crvFactoriesArg;

        address settlementTokenAddress = IVault(vaultArg).getSettlementToken();
        _settlementToken = settlementTokenAddress;
        IERC20(settlementTokenAddress).safeApprove(vaultArg, uint256(-1));
    }

    function withdraw(address token) external onlyOwner {
        IERC20(token).safeTransfer(owner(), IERC20(token).balanceOf(address(this)));
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata _data
    ) external override {
        SwapCallbackData memory data = abi.decode(_data, (SwapCallbackData));

        CallbackValidation.verifyCallback(_uniFactory, data.uniPoolKey);

        // swaps entirely within 0-liquidity regions are not supported -> 0 swap is forbidden
        // L_F0S: forbidden 0 swap
        require((amount0Delta > 0 && amount1Delta < 0) || (amount0Delta < 0 && amount1Delta > 0), "L_F0S");

        address poolAddress = msg.sender;
        address token0 = IUniswapV3Pool(poolAddress).token0();
        address token1 = IUniswapV3Pool(poolAddress).token1();

        // positive: liquidator give pool the collateral
        // negative: liquidator receive from pool (pathTail[0], or USDC)
        // liquidator to liquidate the exact amount of collateral token he's expected to send back to the pool
        (uint256 collateralAmount, uint256 firstHopOutAmount, address collateralToken, address firstHopOutToken) =
            amount0Delta > amount1Delta
                ? (uint256(amount0Delta), uint256(-amount1Delta), token0, token1)
                : (uint256(amount1Delta), uint256(-amount0Delta), token1, token0);

        if (data.path.length > 0) {
            // multi-hop, perform the rest hops
            IERC20(firstHopOutToken).safeApprove(_swapRouter, firstHopOutAmount);
            ISwapRouter.ExactInputParams memory params =
                ISwapRouter.ExactInputParams({
                    path: data.path, // abi.encodePacked(ETH, poolFee, USDC),
                    recipient: address(this),
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

        IVault(_vault).liquidateCollateral(data.trader, data.baseToken, collateralAmount, false);

        // transfer the collateral to uniswap pool
        IERC20(collateralToken).safeTransfer(poolAddress, collateralAmount);
    }

    /// @notice Liquidate tradedr's collateral by using flash swap on uniswap v3
    /// @param trader The address of the liquidatable trader
    /// @param maxSettlementTokenSpent The maximum amount of the settlement token
    ///                                should be paid to the Vault
    /// @param minSettlementTokenProfit The minimum amount of the settlement token
    ///                                 should be earned (negative = allow liquidation at a loss)
    /// @param pathHead Path for swapping tokens
    ///                 For single swaps, it's somewhat like { tokenIn: eth, fee, tokenOut: usdc }
    ///                 For multihop swaps, it's somewhat like { tokenIn: perp, fee, tokenOut: eth }
    /// @param pathTail To fulfill multihop swaps, this is the path after `pathHead`
    ///                 For single swaps, directly pass `0x`
    ///                 For multihop swaps, it's somewhat like `abi.encodePacked(eth, fee, usdc)`
    function flashLiquidate(
        address trader,
        uint256 maxSettlementTokenSpent,
        int256 minSettlementTokenProfit,
        Hop memory pathHead,
        bytes memory pathTail
    ) external {
        (uint256 settlement, uint256 collateral) =
            IVault(_vault).getMaxRepaidSettlementAndLiquidatableCollateral(trader, pathHead.tokenIn);
        // L_NL: not liquidatable
        require(settlement > 0, "L_NL");

        if (settlement > maxSettlementTokenSpent) {
            collateral = IVault(_vault).getLiquidatableCollateralBySettlement(
                pathHead.tokenIn,
                maxSettlementTokenSpent
            );
            settlement = maxSettlementTokenSpent;
        }
        bool zeroForOne = pathHead.tokenIn < pathHead.tokenOut;
        int256 minSettlementAmount = settlement.toInt256().add(minSettlementTokenProfit);

        PoolAddress.PoolKey memory poolKey = PoolAddress.getPoolKey(pathHead.tokenIn, pathHead.tokenOut, pathHead.fee);

        bytes memory data =
            abi.encode(
                SwapCallbackData({
                    path: pathTail,
                    trader: trader,
                    baseToken: pathHead.tokenIn,
                    uniPoolKey: poolKey,
                    minSettlementAmount: minSettlementAmount < 0 ? 0 : minSettlementAmount.toUint256()
                })
            );

        // call the swap, which will trigger the swap callback
        IUniswapV3Pool(PoolAddress.computeAddress(_uniFactory, poolKey)).swap(
            address(this),
            zeroForOne,
            collateral.toInt256(),
            (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1),
            data
        );
    }

    /// @inheritdoc IUniswapV3FlashCallback
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata _data
    ) external override {
        FlashCallbackData memory data = abi.decode(_data, (FlashCallbackData));

        CallbackValidation.verifyCallback(_uniFactory, data.uniPoolKey);

        // borrow two assets or borrow 0 assets is forbidden
        // L_FBA: forbidden borrow amount
        require((fee0 == 0 || fee1 == 0) || !(fee0 == 0 && fee1 == 0), "L_FBA");

        // liquidate
        IVault(_vault).liquidateCollateral(data.trader, data.token, data.collateralAmount, false);

        // exchange
        IPoolCurveSwap crvPool = IPoolCurveSwap(data.crvPool);
        IFactorySidechains factory = IFactorySidechains(data.crvFactory);

        (int128 fromIndex, int128 toIndex, bool isUnderlying) =
            factory.get_coin_indices(data.crvPool, data.token, _settlementToken);

        IERC20(data.token).safeApprove(address(crvPool), data.collateralAmount);

        if (isUnderlying) {
            crvPool.exchange_underlying(fromIndex, toIndex, data.collateralAmount, data.minSettlementAmount);
        } else {
            crvPool.exchange(fromIndex, toIndex, data.collateralAmount, data.minSettlementAmount);
        }

        // return money
        uint256 uniFee = fee1 > fee0 ? fee1 : fee0;
        uint256 amountOwned = data.settlementAmount.add(uniFee);

        IERC20(_settlementToken).safeTransfer(msg.sender, amountOwned);
    }

    function flashLiquidateThroughCurve(FlashLiquidateThroughCurveParams calldata params) external {
        (uint256 settlement, uint256 collateral) =
            IVault(_vault).getMaxRepaidSettlementAndLiquidatableCollateral(params.trader, params.token);
        // L_NL: not liquidatable
        require(settlement > 0, "L_NL");

        if (settlement > params.maxSettlementTokenSpent) {
            collateral = IVault(_vault).getLiquidatableCollateralBySettlement(
                params.token,
                params.maxSettlementTokenSpent
            );
            settlement = params.maxSettlementTokenSpent;
        }

        int256 minSettlementAmount = settlement.toInt256().add(params.minSettlementTokenProfit);

        IUniswapV3Pool pool = IUniswapV3Pool(params.uniPool);

        address token0 = IUniswapV3Pool(pool).token0();
        address token1 = IUniswapV3Pool(pool).token1();
        uint24 fee = IUniswapV3Pool(pool).fee();

        bool isSettlementTokenAt0 = token0 == _settlementToken;

        IUniswapV3Pool(pool).flash(
            address(this),
            isSettlementTokenAt0 ? settlement : 0,
            isSettlementTokenAt0 ? 0 : settlement,
            abi.encode(
                FlashCallbackData({
                    trader: params.trader,
                    crvFactory: params.crvFactory,
                    crvPool: params.crvPool,
                    uniPoolKey: PoolAddress.getPoolKey(token0, token1, fee),
                    token: params.token,
                    settlementAmount: settlement,
                    collateralAmount: collateral,
                    minSettlementAmount: minSettlementAmount < 0 ? 0 : minSettlementAmount.toUint256()
                })
            )
        );
    }

    //
    // EXETERNAL VIEW
    //

    /// @notice Get the most profitable collateral from the liquidatable trader
    /// @param trader The address of the liquidatable trader
    /// @return targetCollateral The most profitable collateral from the liquidatable trader
    function getMaxProfitableCollateral(address trader) external view returns (address targetCollateral) {
        address[] memory collaterals = IVault(_vault).getCollateralTokens(trader);
        uint256 collateralLength = collaterals.length;
        uint256 maxValue = 0;
        targetCollateral = address(0x0);
        for (uint256 i = 0; i < collateralLength; i++) {
            (uint256 value, ) = IVault(_vault).getMaxRepaidSettlementAndLiquidatableCollateral(trader, collaterals[i]);
            if (value > maxValue) {
                maxValue = value;
                targetCollateral = collaterals[i];
            }
        }
    }

    /// @notice Get the most profitable collateral from the liquidatable trader and only accept specific collaterals
    /// @param trader The address of the liquidatable trader
    /// @param collateralList Specific collateral list
    /// @return targetCollateral The most profitable collateral from the liquidatable trader
    function getMaxProfitableCollateralFromCollaterals(address trader, address[] memory collateralList)
        external
        view
        returns (address targetCollateral)
    {
        uint256 collateralLength = collateralList.length;
        uint256 maxValue = 0;
        targetCollateral = address(0x0);
        for (uint256 i = 0; i < collateralLength; i++) {
            if (!ICollateralManager(IVault(_vault).getCollateralManager()).isCollateral(collateralList[i])) {
                // skip the collateral if not registered
                continue;
            }
            (uint256 value, ) =
                IVault(_vault).getMaxRepaidSettlementAndLiquidatableCollateral(trader, collateralList[i]);
            if (value > maxValue) {
                maxValue = value;
                targetCollateral = collateralList[i];
            }
        }
    }

    function getVault() external view returns (address) {
        return _vault;
    }

    function findCurveFactoryAndPoolForCoins(address from, address to) external view returns (address, address) {
        uint256 largestBalance = 0;
        address targetPool = address(0x0);
        address targetFactory = address(0x0);

        for (uint256 i = 0; i < _crvFactories.length; i++) {
            IFactorySidechains factory = IFactorySidechains(_crvFactories[i]);

            uint256 index = 0;

            while (index < factory.pool_count()) {
                address pool = factory.find_pool_for_coins(from, to, index);

                if (pool == address(0x0)) {
                    break;
                }

                (int128 fromIndex, , bool isUnderlying) = factory.get_coin_indices(pool, from, to);
                uint256 tmpBalance = 0;
                if (isUnderlying) {
                    tmpBalance = factory.get_underlying_balances(pool)[fromIndex.toUint256()];
                } else {
                    tmpBalance = factory.get_balances(pool)[fromIndex.toUint256()];
                }

                if (tmpBalance > largestBalance) {
                    largestBalance = tmpBalance;
                    targetFactory = _crvFactories[i];
                    targetPool = pool;
                }

                index++;
            }
        }

        return (targetFactory, targetPool);
    }
}
