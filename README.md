# Hotel Reservation Service

This is Hotel Reservation DApp, that allows users to be able to make reservations to nice hotels for their trips. Users pay the booking price for the hotel room and the amount is usually calculated by the number of nights the user wishes to stay in the hotel. For testing purposes a night is equivalent to 60 seconds. User's also have to pay a reservation holding fee which is then refunded back to the user after the user ends the reservation, a form of incentive to make users not hold down rooms after their reservation has ended.



## How to deploy canisters

- Start the Local Internet Computer

    ```bash
    dfx start --background --clean
    ```

- Deploy the Ledger Canister

    ```bash
    npm run deploy-ledger
    ```

- Deploy the Internet Identity Canister

    ```bash
    npm run deploy-identity
    ```

- Deploy the DAO Backend Canister

    ```bash
	# run with dfx and set the registrationFee in e8s

	dfx deploy dfinity_js_backend --argument '(record {registrationFee <amount in e8s> })'

	# or run using npm with preset values
	# registraionFee = 2_0000_0000 i.e 2 ICP tokens
	npm run deploy-backend

    ```

- Deploy the DAO Frontend Canister

    ```bash
    npm run deploy-frontend
    ```

- Run Frontend Locally

    ```bash
    npm run start
    ```

## Minting Tokens to your account

This next step shows how to mint icp tokens from the locally deployed Ledger canister.

- Copy your dfx address from the wallet on the doc reg frontend by clicking on it.

    ![gettokens](./assets/img/dfxaddress.png)

- Run the mint script.

    ```bash
    # npm run mint:tokens <amount in e8s> <dfx address>
   npm run mint:tokens 500_0000_0000 aa3d50ea7b070d4349eda6ff4b0318c4f896ff4b0318c4f89

	# N/B: This mints 500 ICP tokens from the locally deployed ledger to the address.
    ```
