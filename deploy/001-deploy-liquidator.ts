import mainMetadataOptimismGoerli from "@perp/curie-deployments/optimism-goerli/core/metadata.json"
import mainMetadataOptimism from "@perp/curie-deployments/optimism/core/metadata.json"
import { DeployFunction } from "hardhat-deploy/types"
import { ChainId } from "../constants"
import { Liquidator } from "../typechain"

const liquidatorAddress = []
const uniswapV3SwapRouterAddress = "0xE592427A0AEce92De3Edee1F18E0157C05861564"
const uniswapV3Factory = "0x1F98431c8aD98523631AE4a59f267346ea31F984"
// you can get a list of factory addresses from registry contract 0x0000000022D53366457F9d5E68Ec105046FC4383
const crvFactories = ["0xC5cfaDA84E902aD92DD40194f0883ad49639b023", "0x2db0E83599a91b508Ac268a6197b8B14F5e72840"]

const func: DeployFunction = async function (hre: any) {
    const { deployments, getNamedAccounts } = hre
    const { deploy } = deployments

    const { deployer } = await getNamedAccounts()

    const chainId = hre.companionNetworks.fork ? await hre.companionNetworks.fork.getChainId() : await hre.getChainId()
    const metadata = +chainId === ChainId.OPTIMISM_CHAIN_ID ? mainMetadataOptimism : mainMetadataOptimismGoerli

    await deploy("Liquidator", {
        from: deployer,
        args: [metadata.contracts.Vault.address, uniswapV3SwapRouterAddress, uniswapV3Factory, crvFactories],
        log: true,
        autoMine: true, // speed up deployment on local network (ganache, hardhat), no effect on live networks
    })

    const { ethers } = hre
    const deployment = await deployments.get("Liquidator")
    const liquidatorFactory = await ethers.getContractFactory("Liquidator")
    const liquidator = liquidatorFactory.attach(deployment.address) as Liquidator

    // NOTE: if you'd like to remove deployer as liquidator, please remove below this line
    await liquidator.addWhitelistLiquidator(deployer)

    for (let i = 0; i < liquidatorAddress.length; i++) {
        await liquidator.addWhitelistLiquidator(liquidatorAddress[i])
        console.log(`Whitelist liquidator added: ${liquidatorAddress[i]}`)
    }

    // NOTE: if you'd like to transfer owner to another account, please comment out below code block
    // const newOwner = ""
    // const result = await liquidator.transferOwnership(newOwner)
    // console.log(`Owner transferred to ${newOwner}`)
}

export default func
