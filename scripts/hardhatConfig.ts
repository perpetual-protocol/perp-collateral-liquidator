import {
    COMPANION_NETWORK,
    OPTIMISM_DEPLOYER_MNEMONIC,
    OPTIMISM_GOERLI_DEPLOYER_MNEMONIC,
    OPTIMISM_GOERLI_WEB3_ENDPOINT,
    OPTIMISM_WEB3_ENDPOINT,
} from "../constants"

export function getUrl(network: string) {
    const NetworkUrl = {
        optimism: OPTIMISM_WEB3_ENDPOINT,
        optimismGoerli: OPTIMISM_GOERLI_WEB3_ENDPOINT,
    }

    return NetworkUrl[network] ? NetworkUrl[network] : ""
}

export function getMnemonic(network: string) {
    const NetworkMnemonic = {
        optimism: OPTIMISM_DEPLOYER_MNEMONIC,
        optimismGoerli: OPTIMISM_GOERLI_DEPLOYER_MNEMONIC,
    }

    return NetworkMnemonic[network] ? NetworkMnemonic[network] : ""
}

export function hardhatForkConfig() {
    return COMPANION_NETWORK
        ? {
              forking: {
                  enabled: true,
                  url: getUrl(COMPANION_NETWORK),
              },
              accounts: {
                  mnemonic: getMnemonic(COMPANION_NETWORK),
              },
              companionNetworks: {
                  fork: COMPANION_NETWORK,
              },
          }
        : {}
}
