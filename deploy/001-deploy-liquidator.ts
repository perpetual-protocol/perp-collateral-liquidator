import mainMetadataOptimismKovan from "@perp/curie-deployments/optimism-kovan-dev1/core/metadata.json"
import mainMetadataOptimism from "@perp/curie-deployments/optimism-kovan/core/metadata.json"
import { DeployFunction } from "hardhat-deploy/types"

const uniswapV3SwapRouterAddress = "0xE592427A0AEce92De3Edee1F18E0157C05861564"

const func: DeployFunction = async function (hre: any) {
    const { deployments, getNamedAccounts } = hre
    const { deploy } = deployments

    const { deployer } = await getNamedAccounts()
    const metadata = +process.env.NETWORK === 10 ? mainMetadataOptimism : mainMetadataOptimismKovan

    await deploy("Liquidator", {
        from: deployer,
        args: [metadata.contracts.Vault.address, uniswapV3SwapRouterAddress],
        log: true,
        autoMine: true, // speed up deployment on local network (ganache, hardhat), no effect on live networks
    })
}
export default func
