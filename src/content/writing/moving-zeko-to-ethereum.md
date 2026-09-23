---
title: "Moving Zeko to Ethereum"
summary: "Keeping Mina’s client-side zkApp model while moving settlement to Ethereum: faster Pickles verification in SP1, a Keccak–Poseidon bridge, and the design for blob data availability."
date: 2026-08-10
draft: false
---

In [my previous article on Zeko](/writing/scaling-mina-with-zeko/), I described how we could reuse Mina’s ledger and transaction SNARK to build independent rollups settling to Mina. The next question was whether we could keep that execution environment and settle to Ethereum.

We wanted developers to keep writing **client-side zero-knowledge smart contracts in TypeScript with o1js**. An application runs its provable computation on the user’s device and produces a proof authorizing account updates. Zeko checks those updates against its ledger, then recursively proves batches of transactions. Ethereum would become the place that accepts the resulting state transitions and holds the bridged assets.

That meant adapting three parts of the system: the proof Ethereum verifies, the commitments used by the bridge, and the connection between our batch data and Ethereum’s data availability layer. I co-authored the [Zeko Ethereum technical litepaper](https://zeko.io/ethereumlitepaper.pdf), which lays out the broader design. Here I want to focus on the engineering: what we reused, what was unexpectedly expensive, and how we connected the different cryptographic representations.

## Keep execution, change settlement

The attraction of Mina’s execution model is that application computation happens before a transaction reaches the network. An o1js application proves that its proposed account updates satisfy the contract’s rules. The ledger checks the proof, authorization, and state preconditions. Private witnesses can stay on the user’s device, while the account updates needed to maintain the shared ledger remain public.

We wanted to preserve that division of work. Rewriting every application for the EVM would lose the programming model we were trying to bring to Ethereum.

Our settlement pipeline therefore looks like this:

```text
o1js application proof and account updates
    → Zeko ledger execution and recursive batch proving
    → Pickles proof of the Zeko commitment
    → Rust verifier running inside SP1
    → EVM-verifiable Groth16 proof
    → Ethereum settlement contract
```

The original Zeko implementation remains responsible for its ledger and transaction rules. The Ethereum integration verifies the resulting proof and translates its authenticated output into a state transition Solidity can accept. The [settlement implementation](https://github.com/zeko-labs/ethereum-settlement/blob/31c3cfc0d6303e0461f810936d2c99d7b073cc2b/program/settlement/src/main.rs) asserts that Pickles verification succeeds before deriving the settlement receipt.

This binding matters as much as proof verification. A wrapper that proves “some Pickles proof is valid” would be insufficient if the caller could independently choose the new ledger root. The receipt must come from the statement authenticated by that proof. Solidity then checks that its previous state matches the stored state before accepting the next one.

## Prove that a verifier ran

Ethereum does not have a convenient native verifier for Mina’s full Kimchi/Pickles stack. Implementing that verifier directly in Solidity would bring its curve arithmetic and recursive-proof bookkeeping into every settlement transaction.

Our approach was to run a Rust Pickles verifier inside a general-purpose zkVM, such as SP1 or RISC Zero, and prove its execution. We used **SP1** for this implementation, adapting o1Labs’ verifier. SP1 can wrap the result in a Groth16 proof that Ethereum can verify using its existing pairing machinery.

There are two different proofs involved. Pickles proves the Zeko computation. The outer proof establishes that the Rust program correctly verified Pickles and produced the public settlement output. Both checks are necessary.

The verifier also has to handle the complete Pickles statement. Checking the outer Kimchi proof alone does not cover all the recursive accumulator and deferred-value checks. Our [Rust verifier](https://github.com/zeko-labs/ethereum-settlement/blob/31c3cfc0d6303e0461f810936d2c99d7b073cc2b/crates/pickles-verifier/src/lib.rs) reconstructs those values and the wrap public input before completing verification.

This gave us a working route to Ethereum. It also gave us our first major performance problem.

## Almost an hour to wrap a proof

Our [original Succinct Network request](https://explorer.succinct.xyz/request/0xa619f46dc1520e18cf322c6fe6e770f607027ea6e4d1b81295931adaad5c964d) took **55 minutes and 49 seconds**. That was the time reported for the network proving job: producing a proof of the Rust verifier’s execution inside SP1. It was not a measurement of ordinary native Rust verification.

The distinction is important when optimizing a zkVM program. Code that is acceptable on a normal CPU can produce an enormous execution trace when every operation must be proved. Getting a cryptographic library to compile for the guest is only the beginning.

The expensive operation in our case was a **multi-scalar multiplication**, or MSM, used to check the Pickles accumulator. It has the form:

```text
C = s₀·G₀ + s₁·G₁ + ... + sₙ₋₁·Gₙ₋₁
```

The verifier reconstructs coefficients of a challenge polynomial and commits to them using the Vesta SRS, the verifier’s reference set of curve points. The real accumulator check involves **65,536 terms**.

Our zkVM-specific implementation had fallen back to multiplying each point by its scalar separately, then adding the results. This computes the right answer, but repeats expensive curve work across tens of thousands of terms.

### Restore an efficient algorithm inside the guest

The main change in [PR #7](https://github.com/zeko-labs/ethereum-settlement/pull/7) was to replace that fallback with an explicitly serial, windowed MSM.

Instead of processing every full scalar independently, the algorithm splits scalars into small windows of bits. For each window, it groups points into buckets according to their scalar digits, sums the buckets, and combines the window results with doublings. Sharing work this way greatly reduces the number of curve operations needed for the whole sum.

The [implementation in our arkworks fork](https://github.com/zeko-labs/ethereum-settlement/blob/31c3cfc0d6303e0461f810936d2c99d7b073cc2b/vendor/algebra/ec/src/scalar_mul/variable_base/mod.rs) keeps this efficient arithmetic while avoiding Rayon, parallel iterators, and thread-count queries in the guest. It stays serial even if Cargo feature unification enables the library’s parallel feature elsewhere in the dependency graph. The performance gain comes from doing less arithmetic, rather than adding threads.

We also tightened the accumulator’s size checks. The number of coefficients must match the expected domain size, and the SRS must contain enough generators. Silently truncating the computation to the shorter input would be the wrong way to make verification cheaper.

The validation compared the optimized MSM with the straightforward implementation on both Pasta curves, exercised the full accumulator, and checked that a corrupted recursive challenge was rejected inside SP1. The recursive check remained part of verification.

### From fifty-five minutes to about five

The [controlled execution benchmark](https://github.com/zeko-labs/ethereum-settlement/blob/31c3cfc0d6303e0461f810936d2c99d7b073cc2b/docs/content/status.md#settlement-cycle-optimization-benchmark) used the same valid mainnet fixture and verifier hash. The separate network requests show the change in elapsed proving time:

| Measurement | Before | After |
| --- | ---: | ---: |
| SP1 guest execution cycles | 52,159,229,071 | 5,072,572,223 |
| Time reported by the linked network runs | 55m 49s | 4m 54s |

That is about a **90% reduction in guest cycles**. The [optimized network run](https://explorer.succinct.xyz/request/0x496fb75738253156a8d142653818a0b5b97a0aa85ceca1e4df7f52b937005e65) completed in roughly five minutes. Network job duration also depends on the proving service, so the cycle comparison is the more direct measure of the code change.

These requests used a proof fixture to measure wrapping cost. They were not Ethereum settlement transactions, and the fixture output was not a Solidity-submittable settlement receipt. They established that the expensive cryptographic part could become substantially more practical without weakening the verifier.

## One deposit history, two hash functions

Once Ethereum can verify a Zeko proof, the bridge still needs a shared way to describe deposits.

On Zeko, the **action state** commits to an ordered history of actions using Mina’s Poseidon hashing rules. A deposit becomes an action that the rollup can synchronize and process. Solidity can maintain an analogous history cheaply with Keccak, but reproducing the Poseidon computation on Ethereum would add substantial cost.

We kept a commitment suited to each environment and proved that they describe the same history. Schematically:

```text
for deposit in orderedDeposits:
    ethereumState = appendKeccakDeposit(ethereumState, deposit)
    zekoActionState = appendMinaAction(zekoActionState, deposit)
```

The [bridge guest](https://github.com/zeko-labs/ethereum-settlement/blob/31c3cfc0d6303e0461f810936d2c99d7b073cc2b/program/bridge/src/main.rs) takes the initial states and one ordered sequence of deposits, then computes both transitions inside SP1. Its public output contains the starting and ending commitments, deposit nonces, and Zeko action checkpoints.

“Hash equivalence” here means **the two commitments authenticate the same ordered data**. The Keccak digest and Poseidon digest are different values; we never require them to be numerically equal.

The [Solidity bridge](https://github.com/zeko-labs/ethereum-settlement/blob/31c3cfc0d6303e0461f810936d2c99d7b073cc2b/contracts/src/EthereumZekoBridge.sol) checks the proof against its own recorded deposit accumulator and the previously accepted checkpoint. A prover cannot invent a deposit sequence and get it accepted merely by hashing that invented sequence consistently in two ways. The Ethereum side must match funds actually deposited through the contract.

The awkward work is reproducing the exact representation. Mina’s action state has domain-separated action, action-list, and running-state hashes. A generic `Poseidon(previous, deposit)` is only an illustration. Field encoding, action order, recipient representation, and amounts all have to agree with Zeko’s implementation.

Even units cross this boundary: native ETH has 18 decimal places, while the Zeko amount representation uses 9. The bridge requires amounts in whole gwei, converts by `10^9`, and checks the resulting integer range. A correct hash over the wrong amount encoding would still describe the wrong deposit.

Withdrawals use the same principle in reverse. The settlement guest binds the Zeko action history to a Keccak Merkle tree of inner actions, including claimable withdrawals. Ethereum accepts that root with the settlement, then users submit ordinary Merkle paths to claim their funds after the required delay. The expensive translation is shared across the batch. The [withdrawal path](https://github.com/zeko-labs/ethereum-settlement/blob/31c3cfc0d6303e0461f810936d2c99d7b073cc2b/docs/content/protocol/withdrawals.md) also checks that each claim has not already been consumed.

## Moving data availability to Ethereum blobs

Settlement validity and data availability are separate problems. A valid proof tells us that a state transition followed the rules. Users still need the published account updates to reconstruct the resulting ledger.

Our Ethereum design uses **EIP-4844 blobs** for that data. This is the next integration step: the August prototype still uses the existing 2-of-3 multisignature DA path, and [blob publication and commitment equivalence remain planned work](https://github.com/zeko-labs/ethereum-settlement/blob/31c3cfc0d6303e0461f810936d2c99d7b073cc2b/docs/content/architecture.md#data-availability-boundary). The litepaper describes how we intend to connect them.

The difficult part is proving that the data Zeko committed to is the data Ethereum made available. Publishing an unrelated blob alongside a valid state proof would not solve anything.

Ethereum represents a blob as 4,096 field elements and commits to them with KZG over BLS12-381. The EVM can obtain the blob’s versioned hash, but cannot directly read its contents. Zeko needs a commitment it can efficiently authenticate within its own proving system. In the [litepaper’s blob-validation design, section 4.3](https://zeko.io/ethereumlitepaper.pdf), that is a Merkle commitment to the encoded blob values.

This creates another equivalence problem: a KZG commitment and a Merkle root must refer to the same data.

### Meet at one polynomial evaluation

The design follows [Dankrad Feist’s Merkle-tree approach](https://notes.ethereum.org/@dankrad/kzg_commitments_in_proofs) and the [“moderate approach” in Vitalik’s proto-danksharding FAQ](https://notes.ethereum.org/@vbuterin/proto_danksharding_faq#Moderate-approach-works-with-any-ZK-SNARK).

Think of the blob values as evaluations of a polynomial `P` at a fixed set of points. There is a unique polynomial of degree below 4,096 that fits those values. We can evaluate it at another point without rebuilding the KZG commitment inside our proof.

The construction has four parts:

1. Authenticate the blob values against Zeko’s Merkle commitment `M`.
2. Derive a challenge point `x` by hashing both `M` and the KZG commitment `K`.
3. Inside the proof, compute `y = P(x)` from those authenticated values using barycentric interpolation.
4. On Ethereum, verify a KZG opening at the same `x` and require the same `y`.

The two commitments stay in their own formats. They meet at a common evaluation:

```text
Zeko Merkle root M → authenticated blob values → P(x) = y
                                                        ↕ same x and y
Ethereum KZG K    → point-evaluation precompile → P(x) = y
```

Two different polynomials of degree below 4,096 can agree at at most 4,095 points, a tiny fraction of the possible points in this field. The challenge must depend on **both commitments**: a freely chosen point could be one of those accidental matches. Deriving it from the commitments makes finding a false match infeasible under the construction’s cryptographic assumptions.

### Bind the opening to a published blob

A valid KZG opening alone does not establish data availability. Anyone can create a commitment off-chain.

The settlement transaction must connect `K` to an actual blob in that transaction. Solidity computes its versioned hash and compares it with `blobhash(blobIndex)`. It then uses Ethereum’s [point-evaluation precompile](https://eips.ethereum.org/EIPS/eip-4844#point-evaluation-precompile) to check the opening. The ZK proof’s public inputs must bind the same Merkle root, commitment, and evaluation value to the batch being settled.

This closes the intended chain:

```text
Accepted Zeko state transition
    ↔ committed batch data
    ↔ polynomial evaluation from that data
    ↔ KZG opening
    ↔ blob published on Ethereum
```

We still have to pay for arithmetic in the blob’s field. Mina’s native field and the BLS12-381 scalar field differ, so the interpolation requires non-native arithmetic or an appropriate zkVM implementation. Encoding must preserve every blob field element exactly, with consistent ordering and padding; reducing values into a different field would lose information. The benefit is that the proof can evaluate the polynomial while Ethereum handles the KZG opening check.

The data bound by this construction must also be the account-update data needed to reconstruct the accepted ledger. Proving equivalence between two commitments to an arbitrary byte sequence would leave the execution-to-data connection missing. Application-private witnesses need not be published, but the public state changes do. Blob availability also needs an archival plan for reconstructing old state after Ethereum’s retention window.

## What changed in the move

We could retain Zeko’s ledger rules, recursive transaction proofs, and o1js programming model. Most of the new work sits where that model meets Ethereum: wrapping Pickles efficiently, translating bridge histories, and connecting the execution commitment to available data.

The verifier work made that boundary measurable. One unsuitable arithmetic fallback turned a succinct proof into almost an hour of wrapping work; restoring an efficient MSM brought the measured job down to about five minutes. The bridge and blob designs apply a related principle: let each environment use its natural commitment, then prove that both representations describe the same underlying data.

The [Ethereum settlement repository](https://github.com/zeko-labs/ethereum-settlement) contains the implementation, and the [documentation](https://ethereum.docs.zeko.io/overview) tracks the evolving prototype.
