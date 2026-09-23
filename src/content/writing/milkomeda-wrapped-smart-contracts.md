---
title: "Bringing EVM dapps to Cardano wallets"
summary: "How I built Milkomeda’s wrapped smart contract layer: a browser provider, Cardano signature verification, and smart contract accounts that reimburse transaction relayers."
date: 2023-04-19
draft: false
---

Milkomeda brings Solidity contracts to the Cardano ecosystem through an EVM sidechain. But deploying a familiar application on that sidechain solves only part of the problem. The usual way for a Cardano user to interact with these applications still means installing an Ethereum-compatible wallet.

My goal is to remove that requirement. A user should be able to connect their existing Cardano wallet, authorize an action, and interact with a Solidity contract on Milkomeda without installing another wallet.

I’ve been working on the provider, transaction-signing flow, smart contract accounts, and backend execution service that make this possible. We call the system **wrapped smart contracts**. The work spans several boundaries: browser APIs, signature schemes, the EVM execution model, and the economics of paying for someone else’s transaction.

## Two wallet interfaces

Ethereum dapps expect an [EIP-1193 provider](https://eips.ethereum.org/EIPS/eip-1193): a JavaScript object through which they can request accounts and submit transactions. Wallets commonly expose it as `window.ethereum`, although that particular global is a convention rather than a requirement of the standard.

Cardano wallets expose a different interface, [CIP-30](https://cips.cardano.org/cip/CIP-30). It includes account access and message signing, but it does not define Ethereum JSON-RPC methods such as `eth_sendTransaction`.

I built a JavaScript adapter that exposes an Ethereum-style provider in the page and routes requests to the appropriate place. It lives in `packages/provider` in the repository.

The adapter handles three methods specially:

| Request from the dapp | What the provider does |
| --- | --- |
| `eth_requestAccounts` | Connects to the Cardano wallet and returns the user’s Actor address on Milkomeda. |
| `eth_accounts` | Resolves the Cardano account to that same EVM account. |
| `eth_sendTransaction` | Encodes an Actor operation, requests a Cardano message signature, and submits it to the relayer. |

Other requests go to a normal Milkomeda JSON-RPC node. Reading a contract or querying a block does not require the Cardano wallet. This keeps the adapter small and lets applications continue using familiar libraries such as ethers. The [provider implementation](https://github.com/dcSpark/wrapped-smartcontracts/blob/865d7333ff4200ce1c0fff93e16a86a09d39dd92/packages/provider/src/provider.ts) contains that routing logic.

The dapp still needs to integrate the provider. It also needs to understand that the returned account is a contract. The adapter supports the usual contract-interaction flow with a Cardano wallet; arbitrary Ethereum wallet features do not automatically become supported.

## Signing an EVM action with a Cardano key

Adapting the browser API was the first step. Authentication was harder.

Ethereum’s ordinary externally owned accounts, or EOAs, authenticate transactions with **ECDSA over secp256k1**. Cardano’s CIP-30 message-signing API uses **Ed25519**, an EdDSA scheme over a different curve. The EVM’s existing `ecrecover` precompile cannot verify those signatures. The schemes are specified in the [Ethereum Yellow Paper](https://ethereum.github.io/yellowpaper/paper.pdf) and [CIP-30’s signing requirements](https://cips.cardano.org/cip/CIP-30#apisigndataaddr-address-payload-bytes-promisedatasignature).

We wanted to use the wallet’s existing capabilities. CIP-30 already provides `signData`, so the provider can ask a Cardano wallet to authorize an encoded EVM operation as a message.

The signed payload contains:

```text
Actor address
Actor nonce
Destination address
Value
Gas limit
Gas price
Calldata
```

These fields are ABI-encoded. The wallet returns a [CIP-8](https://cips.cardano.org/cip/CIP-8) `COSE_Sign1` object and a `COSE_Key`; the signature covers the COSE signing structure, including the payload and protected headers. The [transaction adapter](https://github.com/dcSpark/wrapped-smartcontracts/blob/865d7333ff4200ce1c0fff93e16a86a09d39dd92/packages/provider/src/methods/eth_sendTransaction.ts) assembles the payload and requests the signature.

This is an authorization for a contract to execute an action. It is not a native Ethereum transaction signed with a Cardano key, and signing the message does not itself submit a transaction to Cardano.

Verification then needs to happen on Milkomeda. Implementing the missing cryptography inside the EVM would add cost to every operation. Because our team maintains the Milkomeda nodes, we can extend the execution client instead.

I implemented Cardano message verification in our Besu fork. The contract-facing interface, [`L1MsgVerify` at address `0x67`](https://github.com/dcSpark/wrapped-smartcontracts/blob/865d7333ff4200ce1c0fff93e16a86a09d39dd92/packages/contracts/contracts/IL1MsgVerify.sol), accepts the signed message, public-key data, and expected Cardano address. It returns a verification result and the authenticated payload.

The [native verifier](https://github.com/dcSpark/besu/blob/a40a858d743a41180ad359a426f85d2547a58a8f/evm/src/main/java/org/hyperledger/besu/evm/precompile/L1MsgVerifyPrecompiledContract.java) checks both the signature and ownership: the signing key must correspond to the address in the signed envelope, and that address must match the one controlling the Actor.

A precompile makes that verification available to Solidity while implementing it in the node. The tradeoff is portability: these accounts depend on functionality supplied by Milkomeda’s client, so deploying the same contracts on an unmodified Ethereum node is not enough.

## Actor: a contract as the user’s account

An EOA cannot apply our Cardano-specific authorization rules. We need an account whose verification logic we control.

That account is **Actor**, a smart contract tied to a Cardano address. It holds funds, maintains its own nonce, verifies signed operations, and calls destination contracts. From the destination contract’s perspective, the caller is the Actor.

This is a custom account-abstraction design. Contract-controlled accounts are an established idea, and [ERC-4337 was proposed in September 2021](https://eips.ethereum.org/EIPS/eip-4337). Our implementation uses a Milkomeda-specific precompile and execution service rather than ERC-4337’s `UserOperation` and `EntryPoint` architecture.

The execution path looks like this:

```text
EVM dapp
  → WSC provider
  → Cardano wallet: sign the operation
  → Relayer: submit an ordinary EVM transaction
  → Actor: verify authorization through the precompile
  → Destination contract: execute the call
  → Actor: reimburse the relayer
```

The backend is called an “oracle” in the repository. **Relayer** describes its role more accurately: it transports a signed authorization and pays for its inclusion on the EVM chain.

Before executing, [Actor](https://github.com/dcSpark/wrapped-smartcontracts/blob/865d7333ff4200ce1c0fff93e16a86a09d39dd92/packages/contracts/contracts/Actor.sol) checks the signature, the signed Actor address, its nonce, and the gas parameters. A valid signature for one Actor cannot simply authorize a different Actor. Advancing the nonce prevents the same operation from executing repeatedly on that account.

## A deterministic EVM address for each Cardano account

The provider needs to return a stable EVM address as soon as a user connects their Cardano wallet. Requiring an account-deployment transaction first would introduce another onboarding step, before the user even knows where to send funds.

We use **`CREATE2`** in [ActorFactory](https://github.com/dcSpark/wrapped-smartcontracts/blob/865d7333ff4200ce1c0fff93e16a86a09d39dd92/packages/contracts/contracts/ActorFactory.sol) to derive that address deterministically. The factory builds Actor’s initialization code from its creation bytecode and the Cardano address passed to its constructor:

```text
initCode = Actor.creationCode ++ abi.encode(cardanoAddress)

actorAddress = last20Bytes(keccak256(
    0xff ++ factoryAddress ++ salt ++ keccak256(initCode)
))
```

Here `++` means byte concatenation. The Cardano address is part of the hashed initialization code; it is not itself the `CREATE2` salt. For a fixed factory, Actor bytecode, and salt, the same Cardano address produces the same Actor address. Changing those deployment parameters can produce a different account.

The factory’s `getActorAddress` method lets the provider return this address before deployment. Users can bridge funds to it in advance, and `deployAndExecute` can create the Actor and run its first signed operation in one transaction. Deterministic deployment connects the Cardano identity, the address shown to the dapp, and the account that will execute on Milkomeda.

## Someone still has to pay for gas

A contract account cannot originate an ordinary EVM transaction. The relayer therefore submits one from its own EOA and pays the network fee upfront. Actor reimburses it from the user’s balance on Milkomeda.

That makes gas accounting part of the protocol’s correctness. The relayer needs confidence that it will recover the cost of executing an authorized request. The user needs confidence that the relayer cannot change the signed gas price or provide less gas and charge for a failed attempt.

The [relayer prevalidates each request](https://github.com/dcSpark/wrapped-smartcontracts/blob/865d7333ff4200ce1c0fff93e16a86a09d39dd92/packages/oracle/src/methods/eth_sendActorTransaction.ts). It checks the signature and address binding, decodes the operation, checks the Actor address and nonce, and requires enough balance for the value transfer plus `gasLimit × gasPrice`. These checks avoid spending gas on requests that are already invalid. Actor repeats the authorization checks on-chain.

The implementation reimburses calculated gas consumption at the transaction’s gas price. It does not add a separate service-fee percentage. The user still pays for the work; the relayer changes who can submit it.

### Keeping enough gas to pay the relayer

The difficult case is a destination contract that reverts or runs out of gas.

If the entire outer transaction reverts, the reimbursement reverts too, while the relayer still owes the network fee. Forwarding all available gas to an arbitrary destination is therefore unsuitable.

Actor uses a low-level call with an explicit reserve:

```solidity
(bool destCallSuccess, ) = to.call{
    value: value,
    gas: gasleft() - G_REFUND_RESERVE
}(payload);
```

`G_REFUND_RESERVE` is 15,000 gas. The intention is to leave Actor enough gas to record the result and reimburse the relayer after the destination returns. Actual forwarding also follows the EVM’s call costs and [EIP-150 gas cap](https://eips.ethereum.org/EIPS/eip-150).

Actor does not require the destination call to succeed. It emits `Response(false)` on failure and continues to the reimbursement. Its nonce advances before the call, so an authorized attempt that fails inside the destination cannot be replayed for another charge.

Actor also discards the destination’s returned bytes and emits only the success flag. Copying an arbitrarily large return value can consume the gas reserved for reimbursement after the destination has finished. Keeping the result small is part of preserving the accounting path.

This creates two distinct results: the outer transaction can succeed while the requested dapp action fails. An integration needs to inspect Actor’s response event, not just the transaction receipt’s status.

The distinction also defines the guarantee’s boundary. If Actor itself exhausts its gas, or the reimbursement fails, the outer transaction still reverts. Reserving gas isolates an inner call’s failure; it does not eliminate every way a relayer can lose money.

### Measuring gas before Solidity gets control

There is another problem: how can Actor check the gas budget supplied by the relayer?

Calling `gasleft()` at the start of a Solidity function is already too late. The generated runtime has spent gas on dispatch and other setup. The EVM exposes remaining gas, but no opcode directly returns the transaction’s original gas limit.

I customized the compilation pipeline to capture the measurement earlier. The [Hardhat compile task](https://github.com/dcSpark/wrapped-smartcontracts/blob/865d7333ff4200ce1c0fff93e16a86a09d39dd92/packages/contracts/tasks/compile.ts) generates optimized Yul, inserts code at the start of Actor’s deployed runtime, and compiles the modified Yul back into bytecode.

The injected Yul code is:

```text
let gas_limit := gas()

mstore(0, "tx.gasLimit")
let storage_slot := keccak256(0, 11)
mstore(0, 0)

sstore(storage_slot, gas_limit)
```

The key instruction is **`GAS` (`0x5a`)**, expressed as `gas()` in Yul. The injected code captures the remaining gas before the normal runtime executes, then stores it in a dedicated slot derived from `keccak256("tx.gasLimit")`. Actor adds back the two-gas cost of the measurement itself.

For the direct EOA-to-Actor transactions submitted by this relayer, the contract reconstructs the outer gas limit by adding intrinsic gas: the 21,000 transaction base cost, plus 4 per zero calldata byte and 16 per nonzero byte. It compares that reconstructed limit with the user’s signed limit and separately checks `tx.gasprice`.

The factory’s first-call path needs different treatment because Actor is entered through a nested call. The factory explicitly forwards the signed gas budget, and the first operation can validate that entry budget instead. The Actor measurement does not cover all the factory’s earlier deployment work, so this path does not reimburse the full deployment cost.

The build patches Actor’s runtime both in its own artifact and inside the factory’s embedded creation code. That matters because the factory deploys the account, and `CREATE2` address derivation depends on the exact bytecode.

After execution, Actor calculates reimbursement from the reconstructed budget, remaining gas, and fixed allowances for the final payment and instructions that follow the measurement. Those allowances depend on the compiler output and gas schedule. The final overhead adjustment is still ad hoc and needs a more robust accounting method.

## What the implementation enables

The repository includes an example dapp using ethers, along with wrapping, contract interaction, and unwrapping flows. A Cardano signature can authorize an Actor to transfer value or call a Solidity contract, with the relayer submitting the EVM transaction.

The [Actor tests](https://github.com/dcSpark/wrapped-smartcontracts/blob/865d7333ff4200ce1c0fff93e16a86a09d39dd92/packages/contracts/test/actor.test.ts) cover the most important behavior. They check successful calls and transfers, along with rejection of mismatched gas limits and prices, invalid signatures, addresses, and nonces. An infinite-loop destination test checks that the inner operation fails while the Actor pays the gas cost and the relayer’s balance remains unchanged.

That last test expresses the core requirement particularly well: failure of the requested action should still have a defined payer.

## Limitations and next steps

The largest user-facing limitation is the signing screen. The Cardano wallets we support can sign our payload, but they do not decode it into a readable description of the EVM action. A user can approve a cryptographically valid authorization without being able to inspect its meaning comfortably.

CIP-30 provides message signing and calls for informative consent; it does not define how a wallet should interpret arbitrary EVM calldata. Our binary ABI encoding makes the gap especially visible.

A better design would use a canonical authorization format that the wallet could display clearly: the destination, value, network, nonce, and fee budget, with a decoded operation where possible. The verifier would need to bind those displayed fields to the exact action executed. Showing friendly text beside an unrelated payload would not solve the problem. Changing the encoding could help, but useful contract descriptions would also require wallet or decoding support.

There are other boundaries worth making explicit. The Actor needs funds and assets on Milkomeda, which means bridging remains part of the workflow. Applications that assume an EOA or expect Ethereum message-signing methods need additional integration. Relayer availability remains an operational dependency even though authorization is checked on-chain.

The signed operation also lacks an explicit chain ID or expiry. Its Actor address and nonce scope authorization to an account, but those fields alone are not a general cross-chain replay defense. I would include an explicit network domain and validity window in a revised format.

Finally, we need to maintain the custom precompile and compiler modifications together. Changes to the client, compiler, or gas schedule require checking the assumptions behind verification and reimbursement again.

The project has taught me how much work sits between “this chain can run Solidity” and “these users can use its applications.” The browser adapter makes the interfaces fit. The precompile makes the signatures usable. Actor and the relayer make execution possible. The signing screen remains the place where the user needs a clearer explanation of what all that machinery is about to do.

---

*Code links point to the [implementation described in this article](https://github.com/dcSpark/wrapped-smartcontracts/tree/865d7333ff4200ce1c0fff93e16a86a09d39dd92).*
