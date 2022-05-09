import fs from "fs"
import { glob, runTypeChain } from "typechain"

async function main() {
    const cwd = process.cwd()

    let allFiles = glob(cwd, [
        `${__dirname}/../node_modules/@perp/curie-deployments/optimism/core/artifacts/contracts/**/*.json`,
    ])
    await runTypeChain({
        cwd,
        filesToProcess: allFiles,
        allFiles,
        outDir: "typechain/perp-curie",
        target: "ethers-v5",
    })

    allFiles = glob(cwd, [`${__dirname}/../node_modules/@perp/perp-oracle-contract/artifacts/contracts/**/*.json`])
    await runTypeChain({
        cwd,
        filesToProcess: allFiles,
        allFiles,
        outDir: "typechain/perp-oracle",
        target: "ethers-v5",
    })

    allFiles = glob(cwd, [`${__dirname}/../node_modules/@uniswap/v3-periphery/artifacts/contracts/**/*.json`])
    await runTypeChain({
        cwd,
        filesToProcess: allFiles,
        allFiles,
        outDir: "typechain/uniswap-v3-periphery",
        target: "ethers-v5",
    })

    allFiles = glob(cwd, [`${__dirname}/../node_modules/@uniswap/v3-core/artifacts/contracts/**/*.json`])
    await runTypeChain({
        cwd,
        filesToProcess: allFiles,
        allFiles,
        outDir: "typechain/uniswap-v3-core",
        target: "ethers-v5",
    })

    allFiles = glob(cwd, [`${__dirname}/../test/artifacts/**/*.json`])
    await runTypeChain({
        cwd,
        filesToProcess: allFiles,
        allFiles,
        outDir: "typechain/test",
        target: "ethers-v5",
    })

    const targetNoCheckFiles = [
        `${cwd}/typechain/factories/StableSwap__factory.ts`,
        `${cwd}/typechain/factories/Plain4Basic__factory.ts`,
        `${cwd}/typechain/factories/FactorySidechains__factory.ts`,
        `${cwd}/typechain/factories/Registry__factory.ts`,
        `${cwd}/typechain/factories/RegistryAddressProvider__factory.ts`,
        `${cwd}/typechain/factories/StableSwap3Pool__factory.ts`,
    ]

    for (let i = 0; i < targetNoCheckFiles.length; i++) {
        try {
            const filepath = targetNoCheckFiles[i]
            const data = fs.readFileSync(filepath)
            fs.writeFileSync(filepath, "// @ts-nocheck\n\n" + data)
        } catch (e) {
            console.warn(e.toString())
        }
    }

    console.log(`type generated`)
}

main().catch(console.error)
