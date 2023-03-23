import { FakeContract } from "@defi-wonderland/smock"
import { expect } from "chai"
import { BigNumber, BigNumberish, Wallet } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { Liquidator as LiquidatorApp } from "../src/liquidator"
import { LiquidationType } from "../src/metadata"
import {
    FactorySidechains,
    Liquidator,
    Plain4Basic,
    Registry,
    StableSwap3Pool,
    TestUniswapV3Callee,
} from "../typechain"
import { BaseToken, ClearingHouse, Exchange, MarketRegistry, Vault } from "../typechain/perp-curie"
import { TestAggregatorV3, TestERC20 } from "../typechain/test"
import { UniswapV3Pool } from "../typechain/uniswap-v3-core"
import { createFixture, Fixture } from "./fixtures"
import { deposit, mintAndDeposit } from "./helper/token"
import { encodePriceSqrt, syncIndexToMarketPrice } from "./shared/utilities"

describe("Liquidator", () => {
    const [admin, alice, bob, carol, davis] = waffle.provider.getWallets()

    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])

    const nullAddress = "0x0000000000000000000000000000000000000000"

    let fixture: Fixture
    let vault: Vault
    let clearingHouse: ClearingHouse
    let exchange: Exchange
    let pool: UniswapV3Pool
    let marketRegistry: MarketRegistry
    let baseToken: BaseToken
    let mockedBaseAggregator: FakeContract<TestAggregatorV3>
    let liquidator: Liquidator
    let usdc: TestERC20
    let weth: TestERC20
    let wbtc: TestERC20
    let UST: TestERC20
    let FRAX: TestERC20
    let USDT: TestERC20
    let usdcDecimals: number
    let wethDecimals: number
    let wbtcDecimals: number
    let poolWethUsdc: UniswapV3Pool
    let poolWbtcWeth: UniswapV3Pool
    let uniV3Callee: TestUniswapV3Callee
    let plain4Basic: Plain4Basic
    let stableSwap3Pool: StableSwap3Pool
    let factorySidechains: FactorySidechains
    let curveRegistry: Registry

    function setPoolIndexPrice(price: BigNumberish) {
        const oracleDecimals = 6
        mockedBaseAggregator.latestRoundData.returns(async () => {
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

        // default case: only has 1eth
        // non-settlement value threshold: 1 * 100 * 0.8 * 0.75 = 60
        // alice position size = 100 / 151.3733069 = 0.6606184541
        // desired alice loss > 60
        // (151.3733069 - v) * 0.6606184541 > 60
        // v < 151.3733069 - 60 / 0.6606184541 = 60.5493227566
        setPoolIndexPrice(targetPrice)
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
        baseToken = fixture.baseToken
        mockedBaseAggregator = fixture.mockedBaseAggregator
        marketRegistry = fixture.marketRegistry
        pool = fixture.pool
        liquidator = fixture.liquidator
        uniV3Callee = fixture.uniV3Callee
        plain4Basic = fixture.plain4Basic
        stableSwap3Pool = fixture.stableSwap3Pool
        factorySidechains = fixture.factorySidechains
        curveRegistry = fixture.curveRegistry
        UST = fixture.UST
        FRAX = fixture.FRAX
        USDT = fixture.USDT

        // initialize usdc/weth pool
        await weth.mint(carol.address, parseEther("1000"))
        await usdc.mint(carol.address, parseUnits("100000", usdcDecimals))
        await poolWethUsdc.initialize(encodePriceSqrt(parseUnits("100", usdcDecimals), parseEther("1"))) // token1: USDC, token0: WETH
        await poolWethUsdc.increaseObservationCardinalityNext((2 ^ 16) - 1)

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

        await syncIndexToMarketPrice(mockedBaseAggregator, pool)

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

        // add curve liquidity
        const fraxMillion = parseUnits("1000000", 18)
        const ustMillion = parseUnits("1000000", 6)
        const usdtMillion = parseUnits("1000000", 6)

        await usdc.mint(carol.address, usdcMillion)
        await UST.mint(carol.address, ustMillion)
        await FRAX.mint(carol.address, fraxMillion)
        await USDT.mint(carol.address, usdtMillion)

        await usdc.connect(carol).approve(plain4Basic.address, usdcMillion)
        await UST.connect(carol).approve(plain4Basic.address, ustMillion)
        await FRAX.connect(carol).approve(plain4Basic.address, fraxMillion)
        await USDT.connect(carol).approve(plain4Basic.address, usdtMillion)

        await plain4Basic
            .connect(carol)
            ["add_liquidity(uint256[4],uint256)"]([usdcMillion, ustMillion, fraxMillion, usdtMillion], 0)

        // add whitelist liquidator
        await liquidator.addWhitelistLiquidator(admin.address)
    })

    describe("constructor", () => {
        it("owns by the deployer", async () => {
            expect(await liquidator.owner()).to.eq(admin.address)
        })
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
                // alice has 1eth and 0.05btc:
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

    describe("findCurveFactoryAndPoolForCoins", () => {
        describe("get the factory and plain pool correctly", () => {
            it("from factory", async () => {
                const [factoryAddress, poolAddress] = await liquidator.findCurveFactoryAndPoolForCoins(
                    UST.address,
                    usdc.address,
                )

                expect(factoryAddress).to.eq(factorySidechains.address)
                expect(poolAddress).to.eq(plain4Basic.address)
            })

            it("from registry", async () => {
                const usdcTwoMillion = parseUnits("2000000", 6)
                const usdtTwoMillion = parseUnits("2000000", 6)
                const fraxTwoMillion = parseUnits("2000000", 18)

                await usdc.mint(carol.address, usdcTwoMillion)
                await USDT.mint(carol.address, usdtTwoMillion)
                await FRAX.mint(carol.address, fraxTwoMillion)

                await usdc.connect(carol).approve(stableSwap3Pool.address, usdcTwoMillion)
                await USDT.connect(carol).approve(stableSwap3Pool.address, usdtTwoMillion)
                await FRAX.connect(carol).approve(stableSwap3Pool.address, fraxTwoMillion)

                await stableSwap3Pool
                    .connect(carol)
                    ["add_liquidity(uint256[3],uint256)"]([fraxTwoMillion, usdcTwoMillion, usdtTwoMillion], 0)

                const [factoryAddress, poolAddress] = await liquidator.findCurveFactoryAndPoolForCoins(
                    USDT.address,
                    usdc.address,
                )

                expect(factoryAddress).to.eq(curveRegistry.address)
                expect(poolAddress).to.eq(stableSwap3Pool.address)
            })
        })

        describe.skip("get the factory and meta pool correctly", () => {
            // NOTE: it's hard to test meta pool, just test it at fork environment instead.
            it("from factory", async () => {
                const [factoryAddress, poolAddress] = await liquidator.findCurveFactoryAndPoolForCoins(
                    "0x8c6f28f2f1a3c87f0f938b96d27520d9751ec8d9", // susd
                    "0x7f5c764cbc14f9669b88837ca1490cca17c31607", // usdc
                )

                expect(factoryAddress).to.eq("0x2db0E83599a91b508Ac268a6197b8B14F5e72840")
                expect(poolAddress).to.eq("0x061b87122Ed14b9526A813209C8a59a633257bAb") // sUSD3CRV-f
            })
        })

        it("when a token is not exist", async () => {
            const [factoryAddressZero, poolAddressZero] = await liquidator.findCurveFactoryAndPoolForCoins(
                wbtc.address,
                usdc.address,
            )
            expect(factoryAddressZero).to.eq(ethers.constants.AddressZero)
            expect(poolAddressZero).to.eq(ethers.constants.AddressZero)
        })
    })

    describe("getMaxProfitableCollateralFromCollaterals", () => {
        describe("no collaterals", () => {
            it("get the correct collateral", async () => {
                expect(await liquidator.getMaxProfitableCollateralFromCollaterals(alice.address, [])).to.eq(nullAddress)
                expect(
                    await liquidator.getMaxProfitableCollateralFromCollaterals(alice.address, [
                        weth.address,
                        wbtc.address,
                    ]),
                ).to.eq(nullAddress)
            })

            it("ignore non-registered collaterals", async () => {
                expect(
                    await liquidator.getMaxProfitableCollateralFromCollaterals(alice.address, [
                        "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
                    ]),
                ).to.eq(nullAddress)
            })
        })

        describe("deposit only settlement token", () => {
            beforeEach(async () => {
                await deposit(alice, vault, 100, usdc)
            })

            it("get the correct collateral when no debt", async () => {
                expect(
                    await liquidator.getMaxProfitableCollateralFromCollaterals(alice.address, [
                        weth.address,
                        wbtc.address,
                    ]),
                ).to.eq(nullAddress)
            })

            it("get the correct collateral when has debt", async () => {
                await makeAliceNonUsdCollateralLiquidatable()
                expect(
                    await liquidator.getMaxProfitableCollateralFromCollaterals(alice.address, [
                        weth.address,
                        wbtc.address,
                    ]),
                ).to.eq(nullAddress)
            })
        })

        describe("deposit only one non-settlement token", () => {
            beforeEach(async () => {
                await mintAndDeposit(fixture, alice, 1, weth)
            })

            it("get the correct collateral when no debt", async () => {
                expect(
                    await liquidator.getMaxProfitableCollateralFromCollaterals(alice.address, [
                        weth.address,
                        wbtc.address,
                    ]),
                ).to.eq(nullAddress)
            })

            it("get the correct collateral when has debt", async () => {
                await makeAliceNonUsdCollateralLiquidatable()

                expect(await liquidator.getMaxProfitableCollateralFromCollaterals(alice.address, [wbtc.address])).to.eq(
                    nullAddress,
                )

                expect(
                    await liquidator.getMaxProfitableCollateralFromCollaterals(alice.address, [
                        weth.address,
                        wbtc.address,
                    ]),
                ).to.eq(weth.address)
            })
        })

        describe("deposit only multiple non-settlement tokens", () => {
            beforeEach(async () => {
                await mintAndDeposit(fixture, alice, 1, weth)
                await mintAndDeposit(fixture, alice, 0.05, wbtc)
            })

            it("get the correct collateral when no debt", async () => {
                expect(
                    await liquidator.getMaxProfitableCollateralFromCollaterals(alice.address, [
                        weth.address,
                        wbtc.address,
                    ]),
                ).to.eq(nullAddress)
            })

            it("get the correct collateral when has debt", async () => {
                // alice has 1eth and 0.05btc:
                // non-settlement value threshold: (1 * 100 * 0.8 + 0.05 * 1000 * 0.8)* 0.75 = 90
                // alice position size = 100 / 151.3733069 = 0.6606184541
                // desired alice loss > 90
                // (151.3733069 - v) * 0.6606184541 > 90
                // v < 151.3733069 - 90 / 0.6606184541 = 15.1373306849
                await makeAliceNonUsdCollateralLiquidatable("15")

                it("get the correct collateral when no debt", async () => {
                    expect(
                        await liquidator.getMaxProfitableCollateralFromCollaterals(alice.address, [wbtc.address]),
                    ).to.eq(nullAddress)
                })

                expect(
                    await liquidator.getMaxProfitableCollateralFromCollaterals(alice.address, [
                        weth.address,
                        wbtc.address,
                    ]),
                ).to.eq(weth.address)
            })
        })
    })

    describe("uniswapV3SwapCallback", () => {
        it("force error, called by non-unipool address", async () => {
            await expect(liquidator.uniswapV3SwapCallback(1, -1, "0x")).to.be.reverted
        })
    })

    describe("uniswapV3FlashCallback", () => {
        it("force error, called by non-unipool address", async () => {
            await expect(liquidator.uniswapV3FlashCallback(0, 0, "0x")).to.be.reverted
        })

        it("force error, called by invalid crv factory", async () => {
            await mintAndDeposit(fixture, alice, 100, UST)
            await mintAndDeposit(fixture, alice, 0.05, wbtc)
            await makeAliceNonUsdCollateralLiquidatable("10")
            await expect(
                liquidator.flashLiquidateThroughCurve({
                    trader: alice.address,
                    maxSettlementTokenSpent: parseUnits("100", usdcDecimals),
                    minSettlementTokenProfit: parseUnits("1", usdcDecimals),
                    uniPool: poolWethUsdc.address,
                    crvFactory: ethers.constants.AddressZero,
                    crvPool: plain4Basic.address,
                    token: UST.address,
                }),
            ).to.be.revertedWith("L_FCF")
        })
    })

    describe("flashLiquidate", () => {
        beforeEach(async () => {
            // Alice has 1 eth and 0.05 btc:
            // non-settlement value threshold: (1 * 100 * 0.8 + 0.05 * 1000 * 0.8) * 0.75 = 90
            await mintAndDeposit(fixture, alice, 1, weth)
            await mintAndDeposit(fixture, alice, 0.05, wbtc)
        })

        describe("trader collateral is liquidatable", () => {
            beforeEach(async () => {
                // alice position size = 100 / 151.3733069 = 0.6606184541
                // push down the index price to v so alice loss > 90 (non-settlement value threshold)
                // (151.3733069 - v) * 0.6606184541 > 90
                // v < 151.3733069 - 90 / 0.6606184541 = 15.1373306849
                // est. unrealizedPnl = (10 - 151.3733069) * 0.6606184541 = -93.3938154553
                await makeAliceNonUsdCollateralLiquidatable("10")
            })

            it("profit on single-hop swap", async () => {
                // alice:
                // maxRepayNotional = 93.3938154553 * 0.5 = 46.6969077277
                // maxRepayNotionalAndIFFee = 46.6969077277 / (1 - 0.03) = 48.1411419873
                // for ETH:
                //   maxLiquidatableCollateral = 48.1411419873 / (100 * (1 - 0.1)) = 0.5349015776
                //   maxRepaidSettlement = 0.5349015776 * (100 * (1 - 0.1)) = 48.141141984
                //   actualRepaidSettlement = min(48.141141984, 100) = 48.141141984
                //   actualLiquidatableCollateral = 48.141141984 / (100 * (1 - 0.1)) = 0.5349015776
                //   est. profit (without slippage) = 0.5349015776 * 100 - 48.141141984 = 5.349015776
                await liquidator.flashLiquidate(
                    alice.address,
                    parseUnits("100", usdcDecimals),
                    parseUnits("1", usdcDecimals),
                    { tokenIn: weth.address, fee: await poolWethUsdc.fee(), tokenOut: usdc.address },
                    "0x",
                )

                const usdcBalance = await usdc.balanceOf(liquidator.address)
                expect(usdcBalance).to.be.gt(0)
            })

            it("profit on single-hop swap twice", async () => {
                // alice:
                // maxRepayNotional = 93.3938154553 * 0.5 = 46.6969077277
                // maxRepayNotionalAndIFFee = 46.6969077277 / (1 - 0.03) = 48.1411419873
                // for ETH:
                //   maxLiquidatableCollateral = 48.1411419873 / (100 * (1 - 0.1)) = 0.5349015776
                //   maxRepaidSettlement = 0.5349015776 * (100 * (1 - 0.1)) = 48.141141984
                //   actualRepaidSettlement = min(48.141141984, 1) = 1
                //   actualLiquidatableCollateral = 1 / (100 * (1 - 0.1)) = 0.01111111111
                //   est. profit (without slippage) = 0.01111111111 * 100 - 1 = 0.111111111
                await liquidator.flashLiquidate(
                    alice.address,
                    parseUnits("1", usdcDecimals),
                    parseUnits("0", usdcDecimals),
                    { tokenIn: weth.address, fee: await poolWethUsdc.fee(), tokenOut: usdc.address },
                    "0x",
                )

                const usdcBalance1 = await usdc.balanceOf(liquidator.address)
                expect(usdcBalance1).to.be.gt(0)

                // alice:
                // maxRepayNotional = (93.3938154553 - 1) * 0.5 = 46.1969077277
                // maxRepayNotionalAndIFFee = 46.1969077277 / (1 - 0.03) = 47.6256780698
                // for ETH:
                //   maxLiquidatableCollateral = 47.6256780698 / (100 * (1 - 0.1)) = 0.5291742008
                //   maxRepaidSettlement = 0.5291742008 * (100 * (1 - 0.1)) = 47.625678072
                //   actualRepaidSettlement = min(47.625678072, 1) = 1
                //   actualLiquidatableCollateral = 1 / (100 * (1 - 0.1)) = 0.01111111111
                //   est. profit (without slippage) = 0.01111111111 * 100 - 1 = 0.111111111
                await liquidator.flashLiquidate(
                    alice.address,
                    parseUnits("1", usdcDecimals),
                    parseUnits("0", usdcDecimals),
                    { tokenIn: weth.address, fee: await poolWethUsdc.fee(), tokenOut: usdc.address },
                    "0x",
                )

                const usdcBalance2 = await usdc.balanceOf(liquidator.address)
                expect(usdcBalance2.sub(usdcBalance1)).to.be.gt(0)
            })

            it("profit on multi-hop swap", async () => {
                // alice:
                // maxRepayNotional = 93.3938154553 * 0.5 = 46.6969077277
                // maxRepayNotionalAndIFFee = 46.6969077277 / (1 - 0.03) = 48.1411419873
                // for BTC:
                //   maxLiquidatableCollateral = min(48.1411419873 / (1000 * (1 - 0.1)), 0.05) = 0.05
                //   maxRepaidSettlement = 0.05 * (1000 * (1 - 0.1)) = 45
                //   actualRepaidSettlement = min(45, 100) = 45
                //   actualLiquidatableCollateral = 45 / (1000 * (1 - 0.1)) = 0.05
                //   est. profit (without slippage) = 0.05 * 1000 - 45 = 5
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

                const usdcBalance = await usdc.balanceOf(liquidator.address)
                expect(usdcBalance).to.be.gt(0)
            })

            it("profit on multi-hop swap twice", async () => {
                // alice:
                // maxRepayNotional = 93.3938154553 * 0.5 = 46.6969077277
                // maxRepayNotionalAndIFFee = 46.6969077277 / (1 - 0.03) = 48.1411419873
                // for BTC:
                //   maxLiquidatableCollateral = min(48.1411419873 / (1000 * (1 - 0.1)), 0.05) = 0.05
                //   maxRepaidSettlement = 0.05 * (1000 * (1 - 0.1)) = 45
                //   actualRepaidSettlement = min(45, 1) = 1
                //   actualLiquidatableCollateral = 1 / (1000 * (1 - 0.1)) = 0.001111111111
                //   est. profit (without slippage) = 0.001111111111 * 1000 - 1 = 0.111111111
                await liquidator.flashLiquidate(
                    alice.address,
                    parseUnits("1", usdcDecimals),
                    parseUnits("0", usdcDecimals),
                    { tokenIn: wbtc.address, fee: await poolWbtcWeth.fee(), tokenOut: weth.address },
                    ethers.utils.solidityPack(
                        ["address", "uint24", "address"],
                        [weth.address, await poolWethUsdc.fee(), usdc.address],
                    ),
                )

                const usdcBalance1 = await usdc.balanceOf(liquidator.address)
                expect(usdcBalance1).to.be.gt(0)

                // alice:
                // maxRepayNotional = (93.3938154553 - 1) * 0.5 = 46.1969077277
                // maxRepayNotionalAndIFFee = 46.1969077277 / (1 - 0.03) = 47.6256780698
                // for BTC:
                //   maxLiquidatableCollateral = min(47.6256780698 / (1000 * (1 - 0.1)), 0.05) = 0.05
                //   maxRepaidSettlement = 0.05 * (1000 * (1 - 0.1)) = 45
                //   actualRepaidSettlement = min(45, 1) = 1
                //   actualLiquidatableCollateral = 1 / (1000 * (1 - 0.1)) = 0.001111111111
                //   est. profit (without slippage) = 0.001111111111 * 1000 - 1 = 0.111111111
                await liquidator.flashLiquidate(
                    alice.address,
                    parseUnits("1", usdcDecimals),
                    parseUnits("0", usdcDecimals),
                    { tokenIn: wbtc.address, fee: await poolWbtcWeth.fee(), tokenOut: weth.address },
                    ethers.utils.solidityPack(
                        ["address", "uint24", "address"],
                        [weth.address, await poolWethUsdc.fee(), usdc.address],
                    ),
                )

                const usdcBalance2 = await usdc.balanceOf(liquidator.address)
                expect(usdcBalance2.sub(usdcBalance1)).to.be.gt(0)
            })

            it("non-whitelistLiquidator can't do liquidate", async () => {
                await expect(
                    liquidator
                        .connect(davis)
                        .flashLiquidate(
                            alice.address,
                            parseUnits("100", usdcDecimals),
                            parseUnits("1", usdcDecimals),
                            { tokenIn: weth.address, fee: await poolWethUsdc.fee(), tokenOut: usdc.address },
                            "0x",
                        ),
                ).to.be.revertedWith("L_OWL")
            })

            describe("non-profitable swap", () => {
                beforeEach(async () => {
                    // prepare to manipulate the spot price
                    await weth.mint(carol.address, parseEther("1000"))
                    // manipulate ETH-USDC spot price so the trade is no longer profitable
                    await uniV3Callee
                        .connect(carol)
                        .swapToLowerSqrtPrice(
                            poolWethUsdc.address,
                            encodePriceSqrt(parseUnits("75", usdcDecimals), parseEther("1")),
                            carol.address,
                        )

                    // prepare Liquidator contract for non-profitable trades
                    await usdc.mint(liquidator.address, parseUnits("100", usdcDecimals))
                })

                it("force trade on non-profitable single-hop swap", async () => {
                    // alice:
                    // maxRepayNotional = 90.193584 * 0.5 = 45.096792
                    // maxRepayNotionalAndIFFee = 45.096792 / (1 - 0.03) = 46.4915381443
                    // for ETH:
                    //   maxLiquidatableCollateral = 46.4915381443 / (100 * (1 - 0.1)) = 0.516572646
                    //   maxRepaidSettlement = 0.516572646 * (100 * (1 - 0.1)) = 46.49153814
                    //   est. profit (without slippage) = 0.516572646 * 75 - 46.49153814 = -7.74858969
                    const usdcBalanceBefore = await usdc.balanceOf(liquidator.address)

                    await liquidator.flashLiquidate(
                        alice.address,
                        parseUnits("100", usdcDecimals),
                        parseUnits("-100", usdcDecimals), // small enough so we force the losing trade
                        { tokenIn: weth.address, fee: await poolWethUsdc.fee(), tokenOut: usdc.address },
                        "0x",
                    )

                    const usdcBalanceAfter = await usdc.balanceOf(liquidator.address)
                    expect(usdcBalanceAfter).to.be.lt(usdcBalanceBefore)
                })

                it("force trade on non-profitable multi-hop swap", async () => {
                    // alice:
                    // maxRepayNotional = 90.193584 * 0.5 = 45.096792
                    // maxRepayNotionalAndIFFee = 45.096792 / (1 - 0.03) = 46.4915381443
                    // for BTC:
                    //   maxLiquidatableCollateral = min(46.4915381443 / (1000 * (1 - 0.1)), 0.05) = 0.05
                    //   maxRepaidSettlement = 0.05 * (1000 * (1 - 0.1)) = 45
                    //   est. profit (without slippage) = 0.05 * 1000 * 0.75 - 45 = -7.5
                    const usdcBalanceBefore = await usdc.balanceOf(liquidator.address)

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

                    const usdcBalanceAfter = await usdc.balanceOf(liquidator.address)
                    expect(usdcBalanceAfter).to.be.lt(usdcBalanceBefore)
                })

                it("force error, abort on non-profitable single-hop swap", async () => {
                    // alice:
                    // maxRepayNotional = 90.193584 * 0.5 = 45.096792
                    // maxRepayNotionalAndIFFee = 45.096792 / (1 - 0.03) = 46.4915381443
                    // for ETH:
                    //   maxLiquidatableCollateral = 46.4915381443 / (100 * (1 - 0.1)) = 0.516572646
                    //   maxRepaidSettlement = 0.516572646 * (100 * (1 - 0.1)) = 46.49153814
                    //   est. profit (without slippage) = 0.516572646 * 75 - 46.49153814 = -7.74858969
                    await expect(
                        liquidator.flashLiquidate(
                            alice.address,
                            parseUnits("100", usdcDecimals),
                            parseUnits("0", usdcDecimals),
                            { tokenIn: weth.address, fee: await poolWethUsdc.fee(), tokenOut: usdc.address },
                            "0x",
                        ),
                    ).to.be.revertedWith("L_LTMSTP")
                })

                it("force error, abort on non-profitable multi-hop swap", async () => {
                    // alice:
                    // maxRepayNotional = 90.193584 * 0.5 = 45.096792
                    // maxRepayNotionalAndIFFee = 45.096792 / (1 - 0.03) = 46.4915381443
                    // for BTC:
                    //   maxLiquidatableCollateral = min(46.4915381443 / (1000 * (1 - 0.1)), 0.05) = 0.05
                    //   maxRepaidSettlement = 0.05 * (1000 * (1 - 0.1)) = 45
                    //   est. profit (without slippage) = 0.05 * 1000 * 0.75 - 45 = -7.5
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
                    ).to.be.revertedWith("Too little received")
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
                ).to.be.revertedWith("L_NL")
            })
        })
    })

    describe("flashLiquidateThroughCurve", () => {
        beforeEach(async () => {
            // Alice has 100 ust and 0.05 btc:
            // non-settlement value threshold: (100 * 1 * 0.8 + 1000 * 0.05 * 0.8) * 0.75 = 90
            await mintAndDeposit(fixture, alice, 100, UST)
            await mintAndDeposit(fixture, alice, 0.05, wbtc)
        })

        describe("trader collateral is liquidatable", () => {
            beforeEach(async () => {
                // alice position size = 100 / 151.3733069 = 0.6606184541
                // push down the index price to v so alice loss > 90 (non-settlement value threshold)
                // (151.3733069 - v) * 0.6606184541 > 90
                // v < 151.3733069 - 90 / 0.6606184541 = 15.1373306849
                // est. unrealizedPnl = (10 - 151.3733069) * 0.6606184541 = -93.3938154553
                await makeAliceNonUsdCollateralLiquidatable("10")
            })

            it("profit on plain pool", async () => {
                // alice:
                // maxRepayNotional = 93.3938154553 * 0.5 = 46.6969077277
                // maxRepayNotionalAndIFFee = 46.6969077277 / (1 - 0.03) = 48.1411419873
                // for UST:
                //   maxLiquidatableCollateral = 48.1411419873 / (1 * (1 - 0.1)) = 53.4901577637
                //   maxRepaidSettlement = 53.4901577637 * (1 * (1 - 0.1)) = 48.1411419873
                //   actualRepaidSettlement = min(48.1411419873, 100) = 48.1411419873
                //   actualLiquidatableCollateral = 48.1411419873 / (1 * (1 - 0.1)) = 53.4901577637
                //   est. profit (without slippage) = 53.4901577637 * 1 - 48.141141984 = 5.3490157797
                await liquidator.flashLiquidateThroughCurve({
                    trader: alice.address,
                    maxSettlementTokenSpent: parseUnits("100", usdcDecimals),
                    minSettlementTokenProfit: parseUnits("1", usdcDecimals),
                    uniPool: poolWethUsdc.address,
                    crvFactory: factorySidechains.address,
                    crvPool: plain4Basic.address,
                    token: UST.address,
                })

                const usdcBalance = await usdc.balanceOf(liquidator.address)
                expect(usdcBalance).to.be.gt(0)
            })

            it("profit on plain pool twice", async () => {
                // alice:
                // maxRepayNotional = 93.3938154553 * 0.5 = 46.6969077277
                // maxRepayNotionalAndIFFee = 46.6969077277 / (1 - 0.03) = 48.1411419873
                // for UST:
                //   maxLiquidatableCollateral = 48.1411419873 / (1 * (1 - 0.1)) = 53.4901577637
                //   maxRepaidSettlement = 53.4901577637 * (1 * (1 - 0.1)) = 48.1411419873
                //   actualRepaidSettlement = min(48.1411419873, 1) = 1
                //   actualLiquidatableCollateral = 1 / (1 * (1 - 0.1)) = 1.1111111111
                //   est. profit (without slippage) = 1.1111111111 * 1 - 1 = 0.111111111
                await liquidator.flashLiquidateThroughCurve({
                    trader: alice.address,
                    maxSettlementTokenSpent: parseUnits("1", usdcDecimals),
                    minSettlementTokenProfit: parseUnits("0", usdcDecimals),
                    uniPool: poolWethUsdc.address,
                    crvFactory: factorySidechains.address,
                    crvPool: plain4Basic.address,
                    token: UST.address,
                })

                const usdcBalance1 = await usdc.balanceOf(liquidator.address)
                expect(usdcBalance1).to.be.gt(0)

                // alice:
                // maxRepayNotional = (93.3938154553 - 1) * 0.5 = 46.1969077277
                // maxRepayNotionalAndIFFee = 46.1969077277 / (1 - 0.03) = 47.6256780698
                // for UST:
                //   maxLiquidatableCollateral = 47.6256780698 / (1 * (1 - 0.1)) = 52.9174200776
                //   maxRepaidSettlement = 52.9174200776 * (1 * (1 - 0.1)) = 47.6256780698
                //   actualRepaidSettlement = min(47.6256780698, 1) = 1
                //   actualLiquidatableCollateral = 1 / (1 * (1 - 0.1)) = 1.1111111111
                //   est. profit (without slippage) = 1.1111111111 * 1 - 1 = 0.111111111
                await liquidator.flashLiquidateThroughCurve({
                    trader: alice.address,
                    maxSettlementTokenSpent: parseUnits("1", usdcDecimals),
                    minSettlementTokenProfit: parseUnits("0", usdcDecimals),
                    uniPool: poolWethUsdc.address,
                    crvFactory: factorySidechains.address,
                    crvPool: plain4Basic.address,
                    token: UST.address,
                })

                const usdcBalance2 = await usdc.balanceOf(liquidator.address)
                expect(usdcBalance2.sub(usdcBalance1)).to.be.gt(0)
            })

            it("profit on meta pool", async () => {})

            it("profit on meta pool twice", async () => {})

            it("non-whitelistLiquidator can't do liquidate", async () => {
                await expect(
                    liquidator.connect(davis).flashLiquidateThroughCurve({
                        trader: alice.address,
                        maxSettlementTokenSpent: parseUnits("100", usdcDecimals),
                        minSettlementTokenProfit: parseUnits("1", usdcDecimals),
                        uniPool: poolWethUsdc.address,
                        crvFactory: factorySidechains.address,
                        crvPool: plain4Basic.address,
                        token: UST.address,
                    }),
                ).to.be.revertedWith("L_OWL")
            })

            describe("non-profitable swap", () => {
                beforeEach(async () => {
                    // break balance of 4 plain pools
                    // ust: 1001000000, usdt: 1000000, usdc: 1000000, frax: 1000000
                    // 1 ust -> 0.002196 usdc
                    const ustBillion = parseUnits("1000000000", 6)
                    await UST.mint(carol.address, ustBillion)
                    await UST.connect(carol).approve(plain4Basic.address, ustBillion)
                    await plain4Basic.connect(carol)["add_liquidity(uint256[4],uint256)"]([0, ustBillion, 0, 0], 0)

                    // prepare Liquidator contract for non-profitable trades
                    await usdc.mint(liquidator.address, parseUnits("100", usdcDecimals))
                })

                it("force trade on non-profitable plain pool", async () => {
                    // alice:
                    // maxRepayNotional = 90.193584 * 0.5 = 45.096792
                    // maxRepayNotionalAndIFFee = 45.096792 / (1 - 0.03) = 46.4915381443
                    // for UST:
                    //   maxLiquidatableCollateral = 46.4915381443 / (1 * (1 - 0.1)) = 51.6572646048
                    //   maxRepaidSettlement = 51.6572646048 * (1 * (1 - 0.1)) = 46.4915381443
                    //   est. profit (without slippage) = 51.6572646048 * 0.002196 - 46.4915381443 = -46.3780987912
                    const usdcBalanceBefore = await usdc.balanceOf(liquidator.address)

                    await liquidator.flashLiquidateThroughCurve({
                        trader: alice.address,
                        maxSettlementTokenSpent: parseUnits("100", usdcDecimals),
                        minSettlementTokenProfit: parseUnits("-100", usdcDecimals),
                        uniPool: poolWethUsdc.address,
                        crvFactory: factorySidechains.address,
                        crvPool: plain4Basic.address,
                        token: UST.address,
                    })

                    const usdcBalanceAfter = await usdc.balanceOf(liquidator.address)
                    expect(usdcBalanceAfter).to.be.lt(usdcBalanceBefore)
                })

                it("force trade on non-profitable meta pool", async () => {})

                it("force error, abort on non-profitable plain pool", async () => {
                    // alice:
                    // maxRepayNotional = 90.193584 * 0.5 = 45.096792
                    // maxRepayNotionalAndIFFee = 45.096792 / (1 - 0.03) = 46.4915381443
                    // for UST:
                    //   maxLiquidatableCollateral = 46.4915381443 / (1 * (1 - 0.1)) = 51.6572646048
                    //   maxRepaidSettlement = 51.6572646048 * (1 * (1 - 0.1)) = 46.4915381443
                    //   est. profit (without slippage) = 51.6572646048 * 0.002196 - 46.4915381443 = -46.3780987912
                    await expect(
                        liquidator.flashLiquidateThroughCurve({
                            trader: alice.address,
                            maxSettlementTokenSpent: parseUnits("100", usdcDecimals),
                            minSettlementTokenProfit: parseUnits("0", usdcDecimals),
                            uniPool: poolWethUsdc.address,
                            crvFactory: factorySidechains.address,
                            crvPool: plain4Basic.address,
                            token: UST.address,
                        }),
                    ).to.be.revertedWith("Exchange resulted in fewer coins than expected")
                })

                it("force error, abort on non-profitable meta pool", async () => {})
            })
        })

        describe("trader collateral is not liquidatable", () => {
            it("force error when flashLiquidateThroughCurve()", async () => {
                await expect(
                    liquidator.flashLiquidateThroughCurve({
                        trader: alice.address,
                        maxSettlementTokenSpent: parseUnits("100", usdcDecimals),
                        minSettlementTokenProfit: parseUnits("0", usdcDecimals),
                        uniPool: poolWethUsdc.address,
                        crvFactory: factorySidechains.address,
                        crvPool: plain4Basic.address,
                        token: UST.address,
                    }),
                ).to.be.revertedWith("L_NL")
            })
        })
    })

    describe("withdraw", () => {
        it("transfer specified token to owner", async () => {
            const balanceBefore = await usdc.balanceOf(admin.address)
            await usdc.mint(liquidator.address, parseUnits("100", usdcDecimals))
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

    describe("whiteListLiquidator testing", () => {
        it("add liquidator", async () => {
            await expect(liquidator.addWhitelistLiquidator(davis.address))
                .to.emit(liquidator, "WhitelistLiquidatorAdded")
                .withArgs(davis.address)
        })

        it("remove liquidator", async () => {
            await expect(liquidator.removeWhitelistLiquidator(admin.address))
                .to.emit(liquidator, "WhitelistLiquidatorRemoved")
                .withArgs(admin.address)
        })

        it("isWhitelistLiquidator", async () => {
            expect(await liquidator.isWhitelistLiquidator(admin.address)).to.be.eq(true)
        })
    })

    describe("app", () => {
        let liquidatorApp: LiquidatorApp

        describe("correct config", () => {
            beforeEach(async () => {
                // initialize liquidator app
                liquidatorApp = new LiquidatorApp()
                await liquidatorApp.setup({
                    subgraphEndPt: "",
                    wallet: admin,
                    liquidatorContractAddr: liquidator.address,
                    maxSettlementTokenSpent: "100",
                    minSettlementTokenProfit: "1",
                    pathMap: {
                        [wbtc.address]: {
                            method: LiquidationType.FlashLiquidate,
                            params: {
                                head: {
                                    tokenIn: wbtc.address,
                                    fee: "10000",
                                    tokenOut: weth.address,
                                },
                                tail: ethers.utils.solidityPack(
                                    ["address", "uint24", "address"],
                                    [weth.address, "10000", usdc.address],
                                ),
                            },
                        },
                        [weth.address]: {
                            method: LiquidationType.FlashLiquidate,
                            params: {
                                head: {
                                    tokenIn: weth.address,
                                    fee: "10000",
                                    tokenOut: usdc.address,
                                },
                                tail: "0x",
                            },
                        },
                        [UST.address]: {
                            method: LiquidationType.FlashLiquidateThroughCurve,
                            params: {
                                uniPool: poolWethUsdc.address,
                            },
                        },
                    },
                })
            })

            describe("trader collateral is liquidatable", () => {
                it("flashLiquidate", async () => {
                    // Alice has 1 eth and 0.05 btc:
                    // non-settlement value threshold: (1 * 100 * 0.8 + 0.05 * 1000 * 0.8) * 0.75 = 90
                    await mintAndDeposit(fixture, alice, 1, weth)
                    await mintAndDeposit(fixture, alice, 0.05, wbtc)

                    // alice position size = 100 / 151.3733069 = 0.6606184541
                    // push down the index price to v so alice loss > 90 (non-settlement value threshold)
                    // (151.3733069 - v) * 0.6606184541 > 90
                    // v < 151.3733069 - 90 / 0.6606184541 = 15.1373306849
                    // est. unrealizedPnl = (10 - 151.3733069) * 0.6606184541 = -93.3938154553
                    await makeAliceNonUsdCollateralLiquidatable("10")
                    const usdcBalanceBefore = await usdc.balanceOf(liquidator.address)
                    await liquidatorApp.liquidate(alice.address)
                    const usdcBalanceAfter = await usdc.balanceOf(liquidator.address)
                    expect(usdcBalanceAfter).to.be.gt(usdcBalanceBefore)
                })

                it("flashLiquidateThroughCurve", async () => {
                    // Alice has 100 UST and 0.05 btc:
                    // non-settlement value threshold: (100 * 1 * 0.8 + 0.05 * 1000 * 0.8) * 0.75 = 90
                    await mintAndDeposit(fixture, alice, 100, UST)
                    await mintAndDeposit(fixture, alice, 0.05, wbtc)

                    // alice position size = 100 / 151.3733069 = 0.6606184541
                    // push down the index price to v so alice loss > 90 (non-settlement value threshold)
                    // (151.3733069 - v) * 0.6606184541 > 90
                    // v < 151.3733069 - 90 / 0.6606184541 = 15.1373306849
                    // est. unrealizedPnl = (10 - 151.3733069) * 0.6606184541 = -93.3938154553
                    await makeAliceNonUsdCollateralLiquidatable("10")
                    const usdcBalanceBefore = await usdc.balanceOf(liquidator.address)
                    await liquidatorApp.liquidate(alice.address)
                    const usdcBalanceAfter = await usdc.balanceOf(liquidator.address)
                    expect(usdcBalanceAfter).to.be.gt(usdcBalanceBefore)
                })
            })

            describe("trader collateral is not liquidatable", () => {
                it("does not liquidate", async () => {
                    // Alice has 1 eth and 0.05 btc:
                    // non-settlement value threshold: (1 * 100 * 0.8 + 0.05 * 1000 * 0.8) * 0.75 = 90
                    await mintAndDeposit(fixture, alice, 1, weth)
                    await mintAndDeposit(fixture, alice, 0.05, wbtc)

                    const blockNumber = await waffle.provider.getBlockNumber()
                    // suppose to pass without any exception
                    await liquidatorApp.liquidate(alice.address)
                    expect(await waffle.provider.getBlockNumber()).to.be.eq(blockNumber)
                })
            })
        })

        describe("incorrect config", () => {
            beforeEach(async () => {
                // initialize liquidator app
                liquidatorApp = new LiquidatorApp()
                await liquidatorApp.setup({
                    subgraphEndPt: "",
                    wallet: admin,
                    liquidatorContractAddr: liquidator.address,
                    maxSettlementTokenSpent: "100",
                    minSettlementTokenProfit: "1",
                    pathMap: {
                        "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeea": {
                            method: LiquidationType.FlashLiquidate,
                            params: {
                                head: {
                                    tokenIn: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
                                    fee: "10000",
                                    tokenOut: usdc.address,
                                },
                                tail: "0x",
                            },
                        },
                        "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef": {
                            method: LiquidationType.FlashLiquidateThroughCurve,
                            params: {
                                uniPool: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
                            },
                        },
                    },
                })

                // Alice has 1 eth and 0.05 btc:
                // non-settlement value threshold: (1 * 100 * 0.8 + 0.05 * 1000 * 0.8) * 0.75 = 90
                await mintAndDeposit(fixture, alice, 1, weth)
                await mintAndDeposit(fixture, alice, 0.05, wbtc)
            })

            it("does not liquidate", async () => {
                await makeAliceNonUsdCollateralLiquidatable("10")

                const blockNumber = await waffle.provider.getBlockNumber()
                // suppose to pass without any exception
                await liquidatorApp.liquidate(alice.address)
                expect(await waffle.provider.getBlockNumber()).to.be.eq(blockNumber)
            })
        })
    })
})
