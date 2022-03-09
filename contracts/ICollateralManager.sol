// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

interface ICollateralManager {
    function isCollateral(address token) external view returns (bool);
}
