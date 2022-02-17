import { ethers, waffle } from "hardhat"
import WETH9 from "@uniswap/v3-periphery/test/contracts/WETH9.json"
import {
    Liquidator,
    UniswapV3Factory,
    SwapRouter as UniswapRouter,
    IWETH9,
} from "../typechain"
import { Signer } from "ethers"

export interface Fixture {
    // liquidator: Liquidator
    uniV3Factory: UniswapV3Factory
    uniV3Router: UniswapRouter
}

export function createFixture(): () => Promise<Fixture> {
    return async (): Promise<Fixture> => {
        const [admin] = waffle.provider.getWallets()

        // deploy UniV3 ecosystem
        // TODO WIP: this will fail due to WaffleMockProviderAdapter does not implement getFeeData(). Maybe upgrade would help?
        const weth9 = (await waffle.deployContract(admin as Signer, {
            bytecode: WETH9.bytecode,
            abi: WETH9.abi,
        })) as unknown as IWETH9
        const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
        const uniV3Factory = (await factoryFactory.deploy()) as unknown as UniswapV3Factory
        const uniV3Router = (await (await ethers.getContractFactory('SwapRouter')).deploy(
          uniV3Factory.address,
          weth9.address
        )) as unknown as UniswapRouter

        return {
            uniV3Factory,
            uniV3Router,
        }
    }
}
