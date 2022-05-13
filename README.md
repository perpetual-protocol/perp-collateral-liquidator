# perp-collateral-liquidator

## Local Development and Testing

### Requirements

You should have Node v16 installed. Use [nvm](https://github.com/nvm-sh/nvm) to install it.

### Deploy Contract

Prerequisite:
1. duplicate `.env.build.example`
2. rename it to `.env.build`
3. fill all of the fields

To deploy the contract:

```bash
# to Optimism Kovan (testnet)
npm run deploy-contract-optimism-kovan

# to Optimism (mainnet)
npm run deploy-contract-optimism
```

### Run App

Prerequisite:
1. duplicate `.env.runtime.example`
2. rename it to `.env.runtime.optimism` (or `.env.runtime.optimism-kovan` for testnet)
3. fill all of the fields

```bash
# build contract
npm run build

# on Optimism Kovan (testnet)
npm run start:optimism-kovan

# on Optimism (mainnet)
npm run start:optimism
```

### Development

Clone this repository, install NodeJS dependencies, and build the source code:

```bash
git clone git@github.com:perpetual-protocol/perp-collateral-liquidator.git
# hardhat-deploy-ethers@0.3.0-beta.11 needs --legacy-peer-deps
# otherwise there would be conflicting peer dependencies during installation
npm i --legacy-peer-deps
npm run build

# on Optimism Kovan (testnet)
npm run aoo:optimism-kovan

# on Optimism (mainnet)
npm run app:optimism
```

### Testing

To run all the test cases:

```bash
npm run test
```
