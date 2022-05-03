import mainMetadataOptimismKovan from "@perp/curie-deployments/optimism-kovan/core/metadata.json"
import mainMetadataOptimism from "@perp/curie-deployments/optimism/core/metadata.json"
import { DeployFunction } from "hardhat-deploy/types"

const uniswapV3SwapRouterAddress = "0xE592427A0AEce92De3Edee1F18E0157C05861564"

const func: DeployFunction = async function (hre: any) {
    const { deployments, getNamedAccounts } = hre
    const { deploy } = deployments

    const { deployer } = await getNamedAccounts()
    const metadata = +process.env.NETWORK === 10 ? mainMetadataOptimism : mainMetadataOptimismKovan

    await deploy("Liquidator", {
        from: deployer,
        args: [metadata.contracts.Vault.address, uniswapV3SwapRouterAddress, uniswapV3SwapRouterAddress],
        log: true,
        autoMine: true, // speed up deployment on local network (ganache, hardhat), no effect on live networks
    })

    // NOTE: if you'd like to transfer owner to another account, please comment out below code block
    //   import { Liquidator } from "../typechain"

    // const { ethers } = hre
    // const newOwner = ""
    // const deployment = await deployments.get("Liquidator")
    // const liquidatorFactory = await ethers.getContractFactory("Liquidator")
    // const liquidator = liquidatorFactory.attach(deployment.address) as Liquidator
    // const result = await liquidator.transferOwnership(newOwner)
    // console.log(`Owner transferred to ${newOwner}`)
}

export default func
