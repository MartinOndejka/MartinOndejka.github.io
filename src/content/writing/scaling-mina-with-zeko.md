---
title: "Scaling Mina by putting Mina inside a zkApp"
summary: "How we design Zeko to scale Mina with independent rollups, transaction SNARK reuse, sequencer auctions, and bridges for withdrawals and cross-shard transfers."
date: 2023-11-16
draft: false
---

Mina has a throughput problem. Its mainnet has capacity for roughly **one transaction per second**—a very small budget for a network of applications. The Mina Foundation describes the configured capacity as [0.5–1 TPS](https://minaprotocol.com/blog/mina-token-unlock-retrospective). Succinct verification makes the chain cheap to verify, but applications still compete for space in it.

We are working on Zeko with a different place to put most of those transactions: independent ledgers that settle to Mina. Each ledger runs the familiar Mina transaction model, and a zkApp on L1 verifies proofs of its state transitions.

The part I find especially appealing is that Mina already contains the hardest component: a circuit that proves its transaction rules. We can reuse that work to put a Mina ledger inside a Mina smart contract. The [initial project plan](https://github.com/zeko-labs/zeko/blob/5891fb2c3089151235c841f7a154e4064469c7fc/README.md) starts from exactly this goal: reuse the ledger implementation and preserve the zkApp programming model.

That gives us an execution engine. Turning it into a useful network also requires deciding who gets to sequence transactions, where the data lives, and how users move money safely between ledgers.

## Scale by adding instances

Our design is a zk-rollup that can be deployed more than once. Each instance has its own ledger, sequencer, proving work, and settlement contract. Applications and users transact within an instance, while Mina verifies batches of those transactions through proofs.

It resembles blockchain sharding: activity within one shard can proceed independently of activity in another. Here, the shards are separate rollup instances sharing a settlement layer.

```text
Transactions in A → Ledger A → Batch proof → Mina zkApp A
Transactions in B → Ledger B → Batch proof → Mina zkApp B
Transactions in C → Ledger C → Batch proof → Mina zkApp C
```

Adding an instance adds another place to execute and prove transactions. A transfer that stays inside A does not need an individual Mina transaction. A transfer from A to B crosses a settlement boundary and needs a bridge protocol; it cannot simply be an atomic update to one shared ledger.

Cross-instance transfers therefore remain exposed to Mina's throughput and settlement latency. So do deposits, withdrawals, and the batch commitments themselves. Batching amortizes the L1 cost across many local transactions; it does not give us unlimited settlement capacity. The scaling benefit is greatest when most activity stays within an instance.

## Reuse the transaction SNARK

Mina represents its ledger as a Merkle tree of accounts. The root commits to the complete account state without requiring a smart contract to store every account directly.

Its transaction SNARK proves that applying transactions according to the ledger rules takes one state to another. Those rules include balance changes, authorization, and the execution rules for zkApp account updates. The statement contains more bookkeeping, but the useful abstraction is:

```text
Proof: valid transactions transform ledger root R₀ into ledger root R₁
```

Proofs can be composed recursively. If one proves `R₀ → R₁` and another proves `R₁ → R₂`, a merge circuit checks that the intermediate roots agree and produces a proof for `R₀ → R₂`. Repeating this gives us one proof covering a batch.

A zkApp is Mina's smart contract model. Its computation runs off-chain, and a proof authorizes an account update on-chain. Our rollup contract uses that model to verify the transaction proof recursively. It checks that the proof starts at the ledger root currently stored in its state, then replaces that root with the proof's target root.

Conceptually, the settlement rule is:

```text
verify the batch's transaction proof
require proof.source_root == stored_ledger_root
store proof.target_root
```

The real rule also needs the rollup's bridge state, data-availability authorization, and other constraints. But this is the core construction: **a proof of Mina transaction validity becomes part of a Mina zkApp proof**.

This is a clean fit because we can reuse the transaction rules, account model, and recursive proving machinery together. We do not need to independently reproduce every authorization and ledger rule in a new virtual machine. We still need rollup-specific rules and initialization checks; reuse reduces the new surface we have to design, rather than making that work disappear.

The same construction works for multiple independent starting roots. Each deployment tracks its own ledger. A valid transition for one state cannot advance another instance whose stored root does not match it.

This is the architecture we are building toward. Deployment on Mina mainnet depends on the upcoming zkApp upgrade.

## A valid state still needs available data

A ledger root and a proof are not enough to operate the ledger.

Suppose the sequencer produces a correct batch, publishes the new root, and withholds the accounts and transactions needed to reconstruct that state. Mina can verify the transition, but users may be unable to construct their next transaction or the witnesses needed to withdraw. Execution validity and data availability are separate requirements.

Our initial choice is a simple multisignature committee. The sequencer sends the data to committee members and collects a threshold of signatures attesting to its availability. The settlement contract requires that attestation alongside the transaction proof, bound to the state being committed.

The committee supplies an explicit trust assumption: enough members must retain and serve the data. The transaction SNARK continues to enforce execution validity, but it cannot make an uncooperative committee reveal information. With data held outside Mina, this is commonly described more precisely as a **validium** design, even though we use “rollup” for the execution and settlement architecture.

The committee is a practical first step. The more interesting direction is a separate blockchain built for publishing data.

## Put the data on Celestia

Celestia is designed to provide data availability for other chains. Our proposed use is to publish each instance's batch data as blobs and make the Mina commitment depend on authenticated inclusion of the corresponding data.

There are two things to prove. First, a light-client proof must authenticate Celestia's headers and data commitments by checking the relevant consensus rules and validator signatures. Second, an inclusion proof must connect the rollup's blob to one of those commitments.

The design we want combines these with the execution proof:

```text
Valid ledger transition
          +
Commitment to the data for that transition
          +
Inclusion of that data in an authenticated Celestia commitment
          ↓
Mina accepts the rollup commitment
```

The binding in the middle matters. Proving that *some* blob exists on Celestia says nothing about whether it contains the data for the ledger transition we are settling. The circuit must connect the published data to that same batch or state update.

A Groth16 SNARK is one possible way to package the Celestia light-client verification. To consume it in Mina, we also need to prove the Groth16 verification inside Mina's own proving system. Groth16's curve and pairing arithmetic do not become native Mina operations just because both systems use SNARKs; building that verifier is a substantial part of the integration.

This path would let each rollup instance publish its data independently while Mina checks a compact proof connecting execution and publication. Its availability guarantee still depends on Celestia's consensus and data-availability assumptions. A proof authenticates the commitment and inclusion; it does not itself serve the blob or guarantee permanent archival storage.

## Decentralize sequencing through an auction

A transaction proof tells us whether a ledger transition is valid. It does not decide who gets to order transactions or which transactions get included. Our initial implementation has a single sequencer, but we want the right to sequence to be open to competing operators.

The [sequencer auction proposal](https://github.com/zeko-labs/zeko/blob/f07434a924d8abc2374f134dba8d985214b50cdd/src/app/zeko/circuits/design/old/README.md#sequencer-election) divides time into **macroslots**, each covering a fixed number of Mina slots. Operators publish bids on L1 in ZEKO, specifying a range of macroslots and a price per macroslot. The highest eligible bid wins each period independently, so an operator bidding for several periods can win only part of the range.

Bidding happens within a window ahead of the sequencing period. We need enough time for the election to settle on Mina before the winner starts expensive proving work. Otherwise, a reorganization can change the winner after an operator has already begun building a batch.

The election itself is verifiable. A proof folds over the eligible bid actions to establish the winner, and the rollup contract records that operator as the authorized sequencer. Commits require the selected sequencer's authorization as well as a valid transaction proof. The operator earns transaction fees during its turn and can use expected revenue to decide how much to bid.

The difficult part is handing control to the next winner. That operator needs a definite ledger state to build on. If the outgoing sequencer presents different final states to different parties, the next sequencer can waste substantial work proving from the wrong root.

The [handover design](https://github.com/zeko-labs/zeko/blob/f07434a924d8abc2374f134dba8d985214b50cdd/src/app/zeko/circuits/design/old/rollup-decentralized-spec.md) therefore includes a signed final ledger commitment for the macroslot and collateral proportional to the bid. A normal handover returns the refundable collateral after the outgoing operator completes its turn. Failing to finalize, or signing conflicting final commitments for the same period, is grounds for losing it. The incoming operator also needs the underlying ledger data, which makes data availability part of a workable handover.

This is our proposed path beyond the initial sequencer. It makes sequencing rights contestable over time while keeping one operator responsible for a given turn. The transaction SNARK still enforces validity; the auction and handover rules address operator selection and coordination. An auction alone does not guarantee that every transaction is promptly included, so censorship and inactive winners remain liveness concerns the design has to handle.

## Why the sequencer cannot just pay withdrawals

The bridge has two jobs: establish that funds leave one side before they become claimable on the other, and ensure that the same claim cannot be paid twice.

At a high level, a deposit locks funds on L1 and records an action. Once the rollup synchronizes and accepts that action, the recipient can finalize the corresponding transfer on L2. A withdrawal runs in the other direction: funds are removed from the user's spendable L2 balance, a withdrawal action is recorded, and the user claims on L1 after the action is committed and the withdrawal delay has passed.

An action is an authenticated entry in the zkApp's action history. It gives the bridge something to prove inclusion of, tied to an amount and a recipient.

The tempting implementation is to make the sequencer process a queue and send everybody their money. Mina's account permissions make that unreliable.

An account can require authorization even to **receive** funds. Its `receive` permission need not be `None`, meaning “no authorization required.” A sequencer therefore cannot assume that an arbitrary recipient accepts a plain payment.

Checking the account first does not remove the problem. The recipient can change permissions before the payout transaction lands. Even if we manage to prove that receiving is allowed at a particular state, the user can front-run the payout and invalidate the transaction. The [bridge design discussion](https://github.com/zeko-labs/zeko/blob/c63a195054d34da15d5d9af3c95d7ea3081bbc6a/src/app/zkapps_examples/rollup/docs/docs/design.md#processing-transfers) describes why more elaborate account-history checks are also awkward.

If rollup progress depends on successfully paying every recipient, one hostile or incompatible account can obstruct unrelated work. We instead separate committing the withdrawal request from claiming the funds. The recipient participates in finalization and supplies the required authorization. A failed claim can then be retried without blocking the sequencer's next ledger commitment.

That separation creates the next question: how does the bridge remember which claims are already paid?

## A helper account as a nullifier

Proving that a withdrawal exists is not proof that it remains unspent. The same inclusion proof can be presented again.

We need a **nullifier**: persistent state that makes an already-consumed claim unusable. A single global “last withdrawal processed” cursor would give us that state, but it would also force everybody through the same ordered queue. A shared nullifier-tree root has a related problem: independently prepared claims compete to update the same root.

Our design distributes this state across **helper accounts belonging to individual recipients**. On L1, each recipient's helper records the index of their last finalized withdrawal. These are protocol-controlled token accounts, identified by the recipient and the bridge's helper token, so the recipient cannot simply reset the cursor through an ordinary account update.

For a withdrawal at action index `i`, the essential checks are:

```text
prove the withdrawal is in the accepted L2 action history
prove its recipient and amount
prove the required withdrawal delay has passed
require i > helper.last_finalized_index

atomically:
    pay the recipient
    set helper.last_finalized_index = i
```

The transaction must also require that the helper still contains the old index used to construct the proof. This binds the claim to the actual on-chain replay-protection state.

Suppose Alice's helper stores `12`, and she claims withdrawal `19`. Successful finalization pays her and moves the helper to `19`. Replaying the claim fails: `19` is no longer greater than the stored index. Two copies prepared against `12` cannot both succeed, because after the first succeeds, the second's old-state precondition is false.

The payout and cursor update belong to the same atomic operation. If receiving fails, the claim must not be marked as consumed; if paying succeeds, the cursor must advance with it.

This also requires the bridge rules to govern helper-account creation and updates. A recipient-specific account alone is not sufficient. The protocol must prevent resetting its state, substituting another recipient's helper, or advancing it through an unauthorized path.

The [index-based bridge design](https://github.com/zeko-labs/zeko/blob/76a4627782f64f89a9fd49deb3bc92ff8ea5c859/src/app/zeko/design.md#withdrawals) applies the same idea to deposit finalization, with separate bookkeeping for cancelled deposits.

## Independent users can finalize independently

Alice's claim changes Alice's helper. Bob's changes Bob's. They can prepare their claims concurrently without both depending on the same withdrawal-consumption cursor. Bob also does not have to wait for Alice to make her account able to receive funds.

The ordering requirement becomes local to each recipient. If Alice has pending withdrawals at indices `19` and `27`, she must process `19` first. Claiming `27` advances her cursor past `19`, making the earlier claim ineligible. A last-index scheme saves state by imposing this ordering; it is not an arbitrary set of independently spendable claims.

The helper accounts remove one source of contention. Mina still includes the finalization transactions within its L1 capacity, and a rollup-state change can still invalidate a prepared proof's state preconditions. We gain independent replay protection, not a guarantee that every prepared withdrawal survives every concurrent update.

## Moving funds between shards

Independent instances only get us so far if users cannot move between them. The same action-and-claim model gives us a way to connect the shards through a **canonical contract on Mina** that records cross-chain commitments.

The proposed flow is:

```text
Shard A: create an outbound withdrawal action
    → Commit A's transition on Mina
    → Canonical contract: dispatch the transfer action
    → Shard B: synchronize the canonical action state
    → Recipient: claim the funds on B
```

The user starts with something much like a withdrawal on A, except the destination is another shard. This operation removes the funds from the user's spendable balance on A and records the destination shard, recipient, asset, and amount. It also needs a unique transfer identity, such as A's identifier together with the withdrawal's index. The destination is part of the authenticated request: a transfer addressed to B must not also authorize an ordinary L1 withdrawal or a claim on another shard.

When A commits the transition to Mina, the commit would dispatch an action containing that withdrawal through the canonical contract. The contract must authenticate the source instance and bind the action to the accepted source commitment. As it publishes the action, it must record that source withdrawal identity as dispatched and reject any attempt to dispatch it again. Otherwise, two canonical actions could turn one withdrawal into two independently claimable transfers.

B would then synchronize a settled prefix of the canonical contract's action state into its own ledger. As with the L1-to-L2 bridge, this synchronization needs a proof connecting the imported history to the L1 contract, and the recorded history must only advance. A relayer can transport actions and witnesses, but cannot decide which transfers are valid.

Once the relevant action is synchronized, the recipient can prove its inclusion and claim on B. B checks that the action names B as its destination and that the asset, amount, and recipient match. Crediting the funds and recording that the transfer is consumed must happen together. We can adapt the helper-account nullifier mechanism to this history, taking care to use canonical action indices or source-scoped identifiers so withdrawals from different shards cannot be confused.

The bridge also needs a consistent mapping of assets and their backing between instances. The result is a transfer of the claim from A to B without requiring an intermediate payout to the user's L1 account.

This is asynchronous: the source transaction, Mina settlement, destination synchronization, and claim are separate stages. The canonical contract gives the instances a shared place to authenticate transfers; it also makes clear why cross-shard traffic remains bounded by Mina's capacity and finality.

For users, those stages should become one transfer flow. A wallet or SDK would select the destination, submit the outbound request, track settlement and synchronization, fetch the required witnesses, and prepare the claim with the appropriate authorization. Relayers and indexers would do much of the coordination. The protocol supplies the verifiable path; making it straightforward to use requires that tooling as well.

Independent Mina-compatible ledgers give applications room to execute locally. Recursive proofs connect those ledgers to Mina, auctions open sequencing to competing operators, and the canonical action history gives instances a way to exchange value. Mina's small transaction budget remains a constraint at the boundaries, while most application activity can happen inside the instances.

---

*This design account is dated to [my rollup implementation work in November 2023](https://github.com/zeko-labs/zeko/commit/bf8b274774075ec0c274e60781adaccedd9a40ac). It brings together decisions developed over the project; the linked bridge and auction designs include subsequent work. The cross-shard flow describes a proposed extension.*

*Further implementation reading, added later: [o1js-blobstream](https://o1js-blobstream.gitbook.io/o1js-blobstream) connects Celestia consensus and blob-inclusion proofs to Mina. Its [proving-system documentation](https://o1js-blobstream.gitbook.io/o1js-blobstream/proving-systems) covers both Groth16 verification infrastructure and the PLONK path used for its SP1 integration.*
