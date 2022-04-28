// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

interface IFactorySidechains {
    function get_coin_indices(
        address pool,
        address from,
        address to
    )
        external
        view
        returns (
            int128 fromIndex,
            int128 toIndex,
            bool isUnderlying
        );

    function get_decimals(address pool) external view returns (uint256[] memory);

    function get_balances(address pool) external view returns (uint256[] memory);

    function get_underlying_balances(address pool) external view returns (uint256[] memory);

    function get_underlying_decimals(address pool) external view returns (uint256[] memory);

    function find_pool_for_coins(
        address from,
        address to,
        uint256 index
    ) external view returns (address);
}
