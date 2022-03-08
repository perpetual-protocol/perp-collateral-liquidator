import mainMetadataOptimismKovan from "@perp/curie-deployments/optimism-kovan/core/metadata.json"
import mainMetadataOptimism from "@perp/curie-deployments/optimism/core/metadata.json"

export const chain = {
    optitmismEthereum: 10,
    optitmismKovan: 69,
}

const optitmismEthereum = {
    core: mainMetadataOptimism,
}

const optimismKovan = {
    core: mainMetadataOptimismKovan,
}

export default {
    [chain.optitmismEthereum]: optitmismEthereum,
    [chain.optitmismKovan]: optimismKovan,
}
