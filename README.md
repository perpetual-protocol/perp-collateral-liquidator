# perp-collateral-liquidator

## Local Development and Testing

### Requirements

You should have Node v16 installed. Use [nvm](https://github.com/nvm-sh/nvm) to install it.

### Development

Clone this repository, install NodeJS dependencies, and build the source code:

```bash
git clone git@github.com:perpetual-protocol/perp-collateral-liquidator.git
# hardhat-deploy-ethers@0.3.0-beta.11 needs --legacy-peer-deps
# otherwise there would be conflicting peer dependencies during installation
npm i --legacy-peer-deps
npm run build
```

Since there are some runtime environment dependencies, if the installation failed on your machine, please try a vanilla install instead:

```bash
npm run clean
rm -rf node_modules/
rm package-lock.json
npm install
npm run build
```

### Testing

To run all the test cases:

```bash
npm run test
```
