> **Frozen repository.** As of the Spiral Protocol's Pré TCC (tag `v0.3-tokenomics`), this
> repository is frozen as a project reference. Active development continues in
> [`spiralhq/spiral-programs`](https://github.com/spiralhq/spiral-programs) (on-chain) and
> [`spiralhq/spiral-backbone`](https://github.com/spiralhq/spiral-backbone) (off-chain). This
> repository resumes for the TCC, with tokenomics, DAO/Realms, and the `preservation` program.

---

# 🌀 Spiral Anchor

<div align="center">

[![Solana](https://img.shields.io/badge/Solana-Devnet-blueviolet?style=for-the-badge&logo=solana&logoColor=white)](https://solana.com)
[![Anchor](https://img.shields.io/badge/Anchor-0.32.1-informational?style=for-the-badge)](https://book.anchor-lang.com/)
[![License](https://img.shields.io/github/license/spiralhq/spiral-anchor?style=for-the-badge)](LICENSE)

**On-chain programs powering the Spiral protocol**

_Decentralized governance, film registration and long-term audiovisual preservation on Solana._

</div>

---

## ✨ Overview

**Spiral** is a decentralized protocol focused on the **preservation of audiovisual works** through cryptographic guarantees, on-chain governance, and incentive-aligned storage.

This repository contains the **core Anchor programs** that define Spiral’s on-chain logic.

---

## 🧱 Protocol Architecture

```

Organization ──┐
├──▶ Film (Token-2022 NFTs)
│
└──▶ Preservation (Storage Deals)

```

Each program is:
- Independently deployable
- Explicitly permissioned
- Designed for CPI-based interoperability

---

## 📦 Programs

### 🏛️ Organization

**Purpose**  
Manages organizations, members, and permissions across the Spiral ecosystem.

**Highlights**
- Deterministic organization & member PDAs
- Role-based access control (`Admin`, `Uploader`)
- Cross-program authorization
- On-chain counters (members, films)

---

### 🎞️ Film (Token-2022)

**Purpose**  
Registers audiovisual works as **Token-2022 NFTs**, optimized for long-term metadata preservation.

**Highlights**
- Token-2022 NFTs (supply = 1)
- Metadata Pointer + Metadata Interface
- Custom on-chain fields:
  - `organization_key`
  - `file_hash`
  - `inclusion_date`
- Controlled mint authority
- CPI integration with Organization

**Why Token-2022?**
- Native extensions
- Reduced reliance on external programs
- Future-proof metadata model

---

### 🛡️ Preservation

**Purpose**  
Implements a decentralized storage marketplace backed by economic incentives.

**Highlights**
- Storage provider registration with stake
- Stake locking & slashing
- Film-specific storage deals
- Time-based verification
- Reward distribution
- DAO-compatible treasury flows

#### Deal lifecycle

```

Pending ──▶ Active ──▶ Completed
│
└────▶ Slashed

```

---

## 🔐 Security Model

- PDA-based authorities everywhere
- No implicit trust between programs
- Explicit CPI authorization
- Stake-backed guarantees for providers
- Deterministic account derivation
- Strict role enforcement at instruction level

---

## 🧪 Testing & Coverage

The protocol is fully covered by **Anchor-based integration tests**, validating both happy paths and failure modes.

```

tests/
├── organization/
├── film/
└── preservation/

````

### Organization tests
- Organization creation
- Admin and member lifecycle
- Role assignment & revocation
- Permission enforcement
- Cross-organization access protection

### Film tests
- Minting restricted to authorized members
- Film count synchronization with Organization
- Metadata updates and validation
- Burn restrictions and ownership checks
- CPI authorization failures

### Preservation tests
- SpiralCoin mint initialization
- Storage provider registration
- Stake deposit & top-up
- Deal proposal, acceptance and cancellation
- Time-based deal maturation
- Payment release and stake unlock
- Slashing logic on failed deals
- Partial stake withdrawal

✔ All critical state transitions are validated  
✔ Failure paths are explicitly tested  
✔ CPI boundaries are enforced and verified

---

## 🏛️ DAO

Spiral governance is managed via **Realms**.

🔗 **Spiral DAO (Devnet)**  
https://app.realms.today/dao/WqRqAoSZvoojkbsSbzS3uAPZt8bpooS5PsLSdZfqdkf?cluster=devnet

---

## 🛠️ Development

### Requirements

| Tool        | Version                  |
|------------|--------------------------|
| Node.js    | ≥ 20 (24 recommended)    |
| Rust       | ≥ 1.75                   |
| Solana CLI | ≥ 3.0 (Agave)            |
| Anchor CLI | 0.32.1                   |
| Yarn       | 1.22.x                   |
| SPL Token  | ≥ 5.x                    |

---

### Install dependencies
```bash
yarn install
````

### Build programs

```bash
anchor build
```

### Run tests

```bash
anchor test --skip-local-validator
```

---

## 🌐 Networks

Designed for:

* **Devnet** — development & testing
* **Mainnet-beta** — production

Program IDs are defined explicitly per network.

---

## 📜 License

MIT License.

---

<div align="center">

**Spiral is building public infrastructure for the preservation of human audiovisual memory.**

Made with 🌀 by **spiralhq**

</div>