import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber, BigNumberish, Wallet } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { Liquidator, TestUniswapV3Callee } from "../typechain"
import { BaseToken, ClearingHouse, Exchange, MarketRegistry, Vault } from "../typechain/perp-curie"
import { TestERC20, WETH9 } from "../typechain/test"
import { UniswapV3Pool } from "../typechain/uniswap-v3-core"
import { createFixture } from "./fixtures"
import { deposit } from "./helper/token"
import { encodePriceSqrt, syncIndexToMarketPrice } from "./shared/utilities"

describe("Liquidator", () => {
    const [admin, alice, bob, carol, davis] = waffle.provider.getWallets()

    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])

    const nullAddress = "0x0000000000000000000000000000000000000000"

    let vault: Vault
    let clearingHouse: ClearingHouse
    let exchange: Exchange
    let pool: UniswapV3Pool
    let marketRegistry: MarketRegistry
    let baseToken: BaseToken
    let mockedBaseAggregator: MockContract
    let liquidator: Liquidator
    let usdc: TestERC20
    let weth: WETH9
    let poolWethUsdc: UniswapV3Pool
    let poolWbtcWeth: UniswapV3Pool
    let wbtc: TestERC20
    let usdcDecimal: number
    let uniV3Callee: TestUniswapV3Callee

    function setPoolIndexPrice(price: BigNumberish) {
        const oracleDecimals = 6
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits(price.toString(), oracleDecimals), 0, 0, 0]
        })
    }

    async function makeAliceNonUsdCollateralCanBeLiquidated() {
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

        // non-settlement value threshold: 1 * 100 * 0.8 * 0.75 = 60
        // alice position size = 100 / 151.3733069 = 0.6606184541
        // desired alice loss > 60
        // (151.3733069 - v) * 0.6606184541 > 60
        // v < 151.3733069 - 60 / 0.6606184541 = 60.5493227566
        setPoolIndexPrice("60")
    }

    async function addLiquidity({
        pool,
        receipient,
        tickPriceUpper,
        tickPriceLower,
        token0,
        token1,
        amount0,
        amount1,
    }: {
        pool: UniswapV3Pool
        receipient: Wallet
        token0: WETH9
        token1: TestERC20
        tickPriceUpper: number
        tickPriceLower: number
        amount0: BigNumber
        amount1: BigNumber
    }) {
        await token0.connect(receipient).approve(uniV3Callee.address, ethers.constants.MaxUint256)
        await token1.connect(receipient).approve(uniV3Callee.address, ethers.constants.MaxUint256)

        const isToken0Weth = token0.address > token1.address ? true : false
        const actualAmount0 = isToken0Weth ? amount0 : amount1
        const actualAmount1 = !isToken0Weth ? amount0 : amount1
        const tickLower = Math.trunc(Math.log(tickPriceLower) / Math.log(1.0001)).toString()
        const tickUpper = Math.trunc(Math.log(tickPriceUpper) / Math.log(1.0001)).toString()
        // mint function will get reverted
        await uniV3Callee.mint(pool.address, receipient.address, tickLower, tickUpper, actualAmount0, actualAmount1)
    }

    beforeEach(async () => {
        // TODO setup Vault to be multi-collateral
        const _fixture = await loadFixture(createFixture())

        usdc = _fixture.USDC
        usdcDecimal = await usdc.decimals()
        weth = _fixture.WETH
        wbtc = _fixture.WBTC
        poolWethUsdc = _fixture.poolWethUsdc
        poolWbtcWeth = _fixture.poolWbtcWeth
        vault = _fixture.vault
        clearingHouse = _fixture.clearingHouse
        exchange = _fixture.exchange
        baseToken = _fixture.baseToken
        mockedBaseAggregator = _fixture.mockedBaseAggregator
        marketRegistry = _fixture.marketRegistry
        pool = _fixture.pool
        liquidator = _fixture.liquidator
        uniV3Callee = _fixture.uniV3Callee

        const usdcDecimals = await usdc.decimals()

        // initialize usdc/weth pool
        await weth.connect(carol).deposit({ value: parseEther("1000") })
        await usdc.mint(carol.address, parseUnits("100000", usdcDecimals))
        await poolWethUsdc.initialize(encodePriceSqrt("100", "1"))
        await poolWethUsdc.increaseObservationCardinalityNext((2 ^ 16) - 1)

        await addLiquidity({
            pool: poolWethUsdc,
            receipient: carol,
            token0: weth,
            token1: usdc,
            tickPriceLower: 50,
            tickPriceUpper: 150,
            amount0: parseEther("1000"),
            amount1: parseUnits("100000", usdcDecimals),
        })

        // initialize wbtc/weth pool
        await wbtc.mint(carol.address, parseUnits("100", await wbtc.decimals()))
        await usdc.mint(carol.address, parseUnits("100000", usdcDecimals))
        await poolWbtcWeth.initialize(encodePriceSqrt("1000", "1"))
        await poolWbtcWeth.increaseObservationCardinalityNext((2 ^ 16) - 1)
        // await addLiquidity({
        //     pool: poolWbtcWeth,
        //     receipient: carol,
        //     token0: weth,
        //     token1: wbtc,
        //     tickPriceLower: 900,
        //     tickPriceUpper: 1100,
        //     amount0: parseEther("100"),
        //     amount1: parseUnits("100000", usdcDecimals),
        // })

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
        await weth.connect(alice).deposit({ value: parseEther("10") })
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
                await makeAliceNonUsdCollateralCanBeLiquidated()
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(nullAddress)
            })
        })

        describe("deposit only one non-settlement token", () => {
            beforeEach(async () => {
                // TODO need to add eth as collateral in fixture
                await deposit(alice, vault, 1, weth)
            })

            it("get the correct collateral when no debt", async () => {
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(nullAddress)
            })

            it("get the correct collateral when has debt", async () => {
                await makeAliceNonUsdCollateralCanBeLiquidated()
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(weth.address)
            })
        })

        describe("deposit only multiple non-settlement tokens", () => {
            beforeEach(async () => {
                await deposit(alice, vault, 1, weth)
                await deposit(alice, vault, 1, wbtc)
            })

            it("get the correct collateral when no debt", async () => {
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(nullAddress)
            })

            it("get the correct collateral when has debt", async () => {
                await makeAliceNonUsdCollateralCanBeLiquidated()
                expect(await liquidator.getMaxProfitableCollateral(alice.address)).to.eq(wbtc.address)
            })
        })
    })

    describe("flashLiquidate", () => {
        beforeEach(async () => {
            await makeAliceNonUsdCollateralCanBeLiquidated()
        })

        it("profit on single-hop swap", async () => {
            // await liquidator.flashLiquidate(
            //     alice.address,
            //     parseUnits("100", usdcDecimal),
            //     parseUnits("1", usdcDecimal),
            //     { tokenIn: weth.address, fee: await poolWethUsdc.fee(), tokenOut: usdc.address },
            //     "0x0"
            // )
        })

        it("profit on multi-hop swap", async () => {})

        it("force trade on non-profitable single-hop swap", async () => {})

        it("force trade on non-profitable multi-hop swap", async () => {})

        it("force error, abort on non-profitable single-hop swap", async () => {})

        it("force error, abort on non-profitable multi-hop swap", async () => {})
    })

    describe("withdraw", () => {
        it("transfer specified token to owner", async () => {
            const balanceBefore = await usdc.balanceOf(admin.address)
            usdc.mint(liquidator.address, parseUnits("100", usdcDecimal))
            await liquidator.withdraw(usdc.address)
            const balanceAfter = await usdc.balanceOf(admin.address)

            expect(balanceAfter.sub(balanceBefore)).to.eq(parseUnits("100", usdcDecimal))
        })

        it("forced error, called by non-owner", async () => {
            await expect(liquidator.connect(alice).withdraw(usdc.address)).revertedWith(
                "Ownable: caller is not the owner",
            )
        })
    })
})
