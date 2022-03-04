import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber, BigNumberish, Wallet } from "ethers"
import { formatEther, formatUnits, parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { Liquidator, TestUniswapV3Callee } from "../typechain"
import { AccountBalance, BaseToken, ClearingHouse, Exchange, MarketRegistry, Vault } from "../typechain/perp-curie"
import { TestERC20 } from "../typechain/test"
import { UniswapV3Pool } from "../typechain/uniswap-v3-core"
import { createFixture, Fixture } from "./fixtures"
import { deposit, mintAndDeposit } from "./helper/token"
import { encodePriceSqrt, formatSqrtPriceX96ToPrice, syncIndexToMarketPrice } from "./shared/utilities"

describe("Liquidator", () => {
    const [admin, alice, bob, carol, davis] = waffle.provider.getWallets()

    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])

    const nullAddress = "0x0000000000000000000000000000000000000000"

    let fixture: Fixture
    let vault: Vault
    let clearingHouse: ClearingHouse
    let exchange: Exchange
    let accountBalance: AccountBalance
    let pool: UniswapV3Pool
    let marketRegistry: MarketRegistry
    let baseToken: BaseToken
    let mockedBaseAggregator: MockContract
    let liquidator: Liquidator
    let usdc: TestERC20
    let weth: TestERC20
    let wbtc: TestERC20
    let usdcDecimals: number
    let wethDecimals: number
    let wbtcDecimals: number
    let poolWethUsdc: UniswapV3Pool
    let poolWbtcWeth: UniswapV3Pool
    let uniV3Callee: TestUniswapV3Callee

    function setPoolIndexPrice(price: BigNumberish) {
        const oracleDecimals = 6
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits(price.toString(), oracleDecimals), 0, 0, 0]
        })
    }

    async function makeAliceNonUsdCollateralLiquidatable(targetPrice: BigNumberish = "60") {
        // alice long 100 USDC worth of baseToken
        await clearingHouse.connect(alice).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false,
            isExactInput: true,
            oppositeAmountBound: 0,
            amount: parseEther("100"),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        // TODO test
        console.log(
            `alice position size: ${formatEther(
                await accountBalance.getTakerPositionSize(alice.address, baseToken.address),
            )}`,
        )

        console.log(`alice is liquidatable (before): ${await vault.isLiquidatable(alice.address)}`)
        console.log(`alice accountValue (before): ${formatEther(await clearingHouse.getAccountValue(alice.address))}`)
        console.log(
            `alice settlementTokenValue (before): ${formatUnits(
                await vault.getSettlementTokenValue(alice.address),
                usdcDecimals,
            )}`,
        )
        // case1: only has 1eth
        // non-settlement value threshold: 1 * 100 * 0.8 * 0.75 = 60
        // alice position size = 100 / 151.3733069 = 0.6606184541
        // desired alice loss > 60
        // (151.3733069 - v) * 0.6606184541 > 60
        // v < 151.3733069 - 60 / 0.6606184541 = 60.5493227566
        setPoolIndexPrice(targetPrice)

        console.log(`alice is liquidatable (after): ${await vault.isLiquidatable(alice.address)}`)
        console.log(`alice accountValue (after): ${formatEther(await clearingHouse.getAccountValue(alice.address))}`)
        console.log(
            `alice settlementTokenValue (after): ${formatUnits(
                await vault.getSettlementTokenValue(alice.address),
                usdcDecimals,
            )}`,
        )
    }

    async function addLiquidity({
        pool,
        receipient,
        tickPriceUpper, // note there is no safety guarded against MAX_TICK
        tickPriceLower, // note there is no safety guarded against MIN_TICK
        token0,
        token1,
        amount0,
        amount1,
    }: {
        pool: UniswapV3Pool
        receipient: Wallet
        token0: TestERC20
        token1: TestERC20
        tickPriceUpper: number
        tickPriceLower: number
        amount0: BigNumber
        amount1: BigNumber
    }) {
        await token0.connect(receipient).approve(uniV3Callee.address, ethers.constants.MaxUint256)
        await token1.connect(receipient).approve(uniV3Callee.address, ethers.constants.MaxUint256)

        const tickSpacing = await pool.tickSpacing()
        const tickLower = Math.trunc(Math.log(tickPriceLower) / Math.log(1.0001))
        const tickUpper = Math.trunc(Math.log(tickPriceUpper) / Math.log(1.0001))
        const tickOnSpaceLower = Math.trunc(tickLower / tickSpacing) * tickSpacing
        const tickOnSpaceUpper = Math.trunc(tickUpper / tickSpacing) * tickSpacing
        console.log(`tickOnSpaceLower: ${tickOnSpaceLower}, tickOnSpaceUpper: ${tickOnSpaceUpper}`)

        await uniV3Callee
            .connect(receipient)
            .mint(pool.address, receipient.address, tickOnSpaceLower, tickOnSpaceUpper, amount0, amount1)
    }

    beforeEach(async () => {
        fixture = await loadFixture(createFixture())

        usdc = fixture.USDC
        weth = fixture.WETH2
        wbtc = fixture.WBTC
        usdcDecimals = await usdc.decimals()
        wethDecimals = await weth.decimals()
        wbtcDecimals = await wbtc.decimals()
        poolWethUsdc = fixture.poolWethUsdc
        poolWbtcWeth = fixture.poolWbtcWeth
        vault = fixture.vault
        clearingHouse = fixture.clearingHouse
        exchange = fixture.exchange
        accountBalance = fixture.accountBalance
        baseToken = fixture.baseToken
        mockedBaseAggregator = fixture.mockedBaseAggregator
        marketRegistry = fixture.marketRegistry
        pool = fixture.pool
        liquidator = fixture.liquidator
        uniV3Callee = fixture.uniV3Callee

        // initialize usdc/weth pool
        await weth.mint(carol.address, parseEther("1000"))
        await usdc.mint(carol.address, parseUnits("100000", usdcDecimals))
        await poolWethUsdc.initialize(encodePriceSqrt(parseUnits("100", usdcDecimals), parseEther("1"))) // token1: USDC, token0: WETH
        await poolWethUsdc.increaseObservationCardinalityNext((2 ^ 16) - 1)

        // TODO test
        console.log(`usdcDecimals: ${usdcDecimals}`)
        console.log(`wethDecimals: ${wethDecimals}`)
        console.log(`wbtcDecimals: ${wbtcDecimals}`)

        await addLiquidity({
            pool: poolWethUsdc,
            receipient: carol,
            token0: weth,
            token1: usdc,
            tickPriceLower: (50 * 10 ** usdcDecimals) / (1 * 10 ** wethDecimals), // 50 USDC / 1 ETH
            tickPriceUpper: (150 * 10 ** usdcDecimals) / (1 * 10 ** wethDecimals), // 150 USDC / 1 ETH
            amount0: parseEther("1000"),
            amount1: parseUnits("100000", usdcDecimals),
        })

        // TODO test
        console.log(`pool ETH balance (before): ${formatEther(await weth.balanceOf(poolWethUsdc.address))}`)
        console.log(
            `pool USDC balance (before): ${formatUnits(await usdc.balanceOf(poolWethUsdc.address), usdcDecimals)}`,
        )
        console.log(
            `ETH-USDC pool spot price (before): ${formatSqrtPriceX96ToPrice(
                (await poolWethUsdc.slot0()).sqrtPriceX96,
            )}`,
        )

        // initialize wbtc/weth pool
        await weth.mint(carol.address, parseEther("1000"))
        await wbtc.mint(carol.address, parseUnits("100", wbtcDecimals))
        await poolWbtcWeth.initialize(encodePriceSqrt(parseEther("1000"), parseUnits("100", wbtcDecimals))) // token1: WETH, token0: WBTC
        await poolWbtcWeth.increaseObservationCardinalityNext((2 ^ 16) - 1)

        await addLiquidity({
            pool: poolWbtcWeth,
            receipient: carol,
            token0: wbtc,
            token1: weth,
            tickPriceLower: (5 * 10 ** wethDecimals) / (1 * 10 ** wbtcDecimals),
            tickPriceUpper: (15 * 10 ** wethDecimals) / (1 * 10 ** wbtcDecimals),
            amount0: parseUnits("100", wbtcDecimals),
            amount1: parseEther("1000"),
        })

        // TODO test
        console.log(`pool ETH balance (before): ${formatEther(await weth.balanceOf(poolWbtcWeth.address))}`)
        console.log(
            `pool WBTC balance (before): ${formatUnits(await wbtc.balanceOf(poolWbtcWeth.address), wbtcDecimals)}`,
        )
        console.log(
            `WBTC-WETH pool spot price (before): ${formatSqrtPriceX96ToPrice(
                (await poolWbtcWeth.slot0()).sqrtPriceX96,
            )}`,
        )

        // initialize baseToken pool
        await pool.initialize(encodePriceSqrt("151.3733069", "1"))
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

        // add pool after it's initialized
        await marketRegistry.addPool(baseToken.address, 10000)

        // set MaxTickCrossedWithinBlock to enable price checking before/after swap
        await exchange.setMaxTickCrossedWithinBlock(baseToken.address, 100)

        const usdcMillion = parseUnits("1000000", usdcDecimals)
        const usdcHundred = parseUnits("100", usdcDecimals)

        // mint
        await weth.mint(carol.address, parseEther("10"))
        await usdc.mint(alice.address, usdcHundred) // test subject
        await usdc.mint(bob.address, usdcMillion) // helper
        await usdc.mint(carol.address, usdcMillion) // maker

        await deposit(bob, vault, 1000000, usdc)
        await deposit(carol, vault, 1000000, usdc)

        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("15000"),
            lowerTick: 49000,
            upperTick: 51400,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        await syncIndexToMarketPrice(mockedBaseAggregator, pool)
    })

    describe("getMaxProfitableCollateral", () => {
        describe("no collaterals", () => {
            it("get the correct collateral", async () => {
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(nullAddress)
            })
        })

        describe("deposit only settlement token", () => {
            beforeEach(async () => {
                await deposit(alice, vault, 100, usdc)
            })

            it("get the correct collateral when no debt", async () => {
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(nullAddress)
            })

            it("get the correct collateral when has debt", async () => {
                await makeAliceNonUsdCollateralLiquidatable()
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(nullAddress)
            })
        })

        describe("deposit only one non-settlement token", () => {
            beforeEach(async () => {
                await mintAndDeposit(fixture, alice, 1, weth)
            })

            it("get the correct collateral when no debt", async () => {
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(nullAddress)
            })

            it("get the correct collateral when has debt", async () => {
                await makeAliceNonUsdCollateralLiquidatable()
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(weth.address)
            })
        })

        describe("deposit only multiple non-settlement tokens", () => {
            beforeEach(async () => {
                await mintAndDeposit(fixture, alice, 1, weth)
                await mintAndDeposit(fixture, alice, 0.05, wbtc)
            })

            it("get the correct collateral when no debt", async () => {
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(nullAddress)
            })

            it("get the correct collateral when has debt", async () => {
                // case2: has 1eth and 0.05btc:
                // non-settlement value threshold: (1 * 100 * 0.8 + 0.05 * 1000 * 0.8)* 0.75 = 90
                // alice position size = 100 / 151.3733069 = 0.6606184541
                // desired alice loss > 90
                // (151.3733069 - v) * 0.6606184541 > 90
                // v < 151.3733069 - 90 / 0.6606184541 = 15.1373306849
                await makeAliceNonUsdCollateralLiquidatable("15")
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(weth.address)
            })
        })
    })

    describe("flashLiquidate", () => {
        beforeEach(async () => {
            await mintAndDeposit(fixture, alice, 1, weth)
            await mintAndDeposit(fixture, alice, 0.05, wbtc)

            // prepare to manipulate the spot price
            await weth.mint(carol.address, parseEther("1000"))
        })

        describe("trader collateral is liquidatable", () => {
            beforeEach(async () => {
                // case2: has 1eth and 0.05btc:
                // non-settlement value threshold: (1 * 100 * 0.8 + 0.05 * 1000 * 0.8)* 0.75 = 90
                // alice position size = 100 / 151.3733069 = 0.6606184541
                // desired alice loss > 90
                // (151.3733069 - v) * 0.6606184541 > 90
                // v < 151.3733069 - 90 / 0.6606184541 = 15.1373306849

                // alice can be liqudiated at most 45 usd worth of non-usd collateral
                // maxSettlementTokenIn = 45 / (1 - 0.1) = 50
                // for ETH:
                //   maxCollateralTokenOut = 50 / 100 / (1 - 0.05) = 0.5263157895
                //   minProfitableSpotPrice = 50 / 0.5263157895 = 94.9999999953
                //
                // similarly, for BTC->ETH->USDC swap:
                //   maxCollateralTokenOut = 50 / 1000 / (1 - 0.05) = 0.05263157895
                //   0.05263157895 BTC -> 0.5263157895 ETH -> 49.473684213 USDC (unprofitable)
                await makeAliceNonUsdCollateralLiquidatable("15")
            })

            it.only("profit on single-hop swap", async () => {
                console.log(
                    `liquidator USDC balance (before): ${formatUnits(
                        await usdc.balanceOf(liquidator.address),
                        usdcDecimals,
                    )}`,
                )
                await liquidator.flashLiquidate(
                    alice.address,
                    parseUnits("100", usdcDecimals),
                    parseUnits("1", usdcDecimals),
                    { tokenIn: weth.address, fee: await poolWethUsdc.fee(), tokenOut: usdc.address },
                    "0x",
                )
                console.log(
                    `ETH-USDC pool spot price: ${formatSqrtPriceX96ToPrice((await poolWethUsdc.slot0()).sqrtPriceX96)}`,
                )
                console.log(`pool ETH balance: ${formatEther(await weth.balanceOf(poolWethUsdc.address))}`)
                console.log(
                    `pool USDC balance: ${formatUnits(await usdc.balanceOf(poolWethUsdc.address), usdcDecimals)}`,
                )

                const usdcBalance = await usdc.balanceOf(liquidator.address)
                console.log(`liquidator USDC balance: ${formatUnits(usdcBalance, usdcDecimals)}`)
                expect(usdcBalance).to.be.gt(0)
            })

            it("profit on multi-hop swap", async () => {
                await liquidator.flashLiquidate(
                    alice.address,
                    parseUnits("100", usdcDecimals),
                    parseUnits("1", usdcDecimals),
                    { tokenIn: wbtc.address, fee: await poolWbtcWeth.fee(), tokenOut: weth.address },
                    ethers.utils.solidityPack(
                        ["address", "uint24", "address"],
                        [weth.address, await poolWethUsdc.fee(), usdc.address],
                    ),
                )
            })

            describe("non-profitable swap", () => {
                beforeEach(async () => {
                    // manipulate ETH-USDC spot price so the trade is no longer profitable
                    await uniV3Callee
                        .connect(carol)
                        .swapToLowerSqrtPrice(poolWethUsdc.address, encodePriceSqrt("94", "1"), carol.address)
                })

                it("force trade on non-profitable single-hop swap", async () => {
                    await liquidator.flashLiquidate(
                        alice.address,
                        parseUnits("100", usdcDecimals),
                        parseUnits("-100", usdcDecimals), // small enough so we force the losing trade
                        { tokenIn: wbtc.address, fee: await poolWbtcWeth.fee(), tokenOut: weth.address },
                        ethers.utils.solidityPack(
                            ["address", "uint24", "address"],
                            [weth.address, await poolWethUsdc.fee(), usdc.address],
                        ),
                    )
                })

                it("force trade on non-profitable multi-hop swap", async () => {
                    await liquidator.flashLiquidate(
                        alice.address,
                        parseUnits("100", usdcDecimals),
                        parseUnits("-100", usdcDecimals), // small enough so we force the losing trade
                        { tokenIn: wbtc.address, fee: await poolWbtcWeth.fee(), tokenOut: weth.address },
                        ethers.utils.solidityPack(
                            ["address", "uint24", "address"],
                            [weth.address, await poolWethUsdc.fee(), usdc.address],
                        ),
                    )
                })

                it("force error, abort on non-profitable single-hop swap", async () => {
                    await expect(
                        liquidator.flashLiquidate(
                            alice.address,
                            parseUnits("100", usdcDecimals),
                            parseUnits("0", usdcDecimals),
                            { tokenIn: wbtc.address, fee: await poolWbtcWeth.fee(), tokenOut: weth.address },
                            ethers.utils.solidityPack(
                                ["address", "uint24", "address"],
                                [weth.address, await poolWethUsdc.fee(), usdc.address],
                            ),
                        ),
                    ).to.be.revertedWith("L_LTMSTP")
                })

                it("force error, abort on non-profitable multi-hop swap", async () => {
                    await expect(
                        liquidator.flashLiquidate(
                            alice.address,
                            parseUnits("100", usdcDecimals),
                            parseUnits("0", usdcDecimals),
                            { tokenIn: wbtc.address, fee: await poolWbtcWeth.fee(), tokenOut: weth.address },
                            ethers.utils.solidityPack(
                                ["address", "uint24", "address"],
                                [weth.address, await poolWethUsdc.fee(), usdc.address],
                            ),
                        ),
                    ).to.be.revertedWith("L_LTMSTP")
                })
            })
        })

        describe("trader collateral is not liquidatable", () => {
            it("force error, not liquidatable", async () => {
                await expect(
                    liquidator.flashLiquidate(
                        alice.address,
                        parseUnits("100", usdcDecimals),
                        parseUnits("0", usdcDecimals),
                        { tokenIn: wbtc.address, fee: await poolWbtcWeth.fee(), tokenOut: weth.address },
                        ethers.utils.solidityPack(
                            ["address", "uint24", "address"],
                            [weth.address, await poolWethUsdc.fee(), usdc.address],
                        ),
                    ),
                ).to.be.revertedWith("V_NL")
            })
        })
    })

    describe("withdraw", () => {
        it("transfer specified token to owner", async () => {
            const balanceBefore = await usdc.balanceOf(admin.address)
            usdc.mint(liquidator.address, parseUnits("100", usdcDecimals))
            await liquidator.withdraw(usdc.address)
            const balanceAfter = await usdc.balanceOf(admin.address)

            expect(balanceAfter.sub(balanceBefore)).to.eq(parseUnits("100", usdcDecimals))
        })

        it("forced error, called by non-owner", async () => {
            await expect(liquidator.connect(alice).withdraw(usdc.address)).revertedWith(
                "Ownable: caller is not the owner",
            )
        })
    })
})
