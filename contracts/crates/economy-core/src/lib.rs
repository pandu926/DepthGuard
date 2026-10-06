#![forbid(unsafe_code)]
use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};
pub const REGISTRY_ID: Pubkey = pubkey!("5sUGNQ5pymevqfVmg99rgQ2jM4aVSo6RqhJtSK7VrPYz");
pub const MAX_MODEL_BYTES: usize = 8192;
pub const MAX_MILESTONES: usize = 16;
pub const MAX_REVIEWERS: usize = 5;
pub const MEME: u8 = 0;
pub const FUNDING: u8 = 1;
pub const BACKED: u8 = 2;
pub const ASSET_QUOTE: u8 = 3;
pub const PENDING: u8 = 0;
pub const ACTIVE: u8 = 1;
pub const REFUNDING: u8 = 2;
pub const COMPLETED: u8 = 3;
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Milestone {
    pub weight_bps: u16,
    pub deadline_offset: i64,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ModelSpec {
    pub schema_version: u16,
    pub mechanism: u8,
    pub quote_decimals: u8,
    pub launcher_bps: u16,
    pub author_bps: u16,
    pub platform_bps: u16,
    pub reviewer_threshold: u8,
    pub milestones: Vec<Milestone>,
    pub native_config: Vec<u8>,
}
impl ModelSpec {
    pub fn validate(&self) -> Result<()> {
        require!(
            self.schema_version == 2 && self.mechanism <= ASSET_QUOTE && self.quote_decimals == 9,
            EconomyError::InvalidTerms
        );
        require!(
            self.launcher_bps > 0
                && self.author_bps > 0
                && self.platform_bps > 0
                && u32::from(self.launcher_bps)
                    + u32::from(self.author_bps)
                    + u32::from(self.platform_bps)
                    == 10000,
            EconomyError::InvalidTerms
        );
        require!(
            !self.native_config.is_empty() && self.native_config.len() <= 4096,
            EconomyError::InvalidTerms
        );
        if self.mechanism == FUNDING {
            require!(
                !self.milestones.is_empty()
                    && self.milestones.len() <= MAX_MILESTONES
                    && (2..=3).contains(&self.reviewer_threshold),
                EconomyError::InvalidTerms
            );
            let mut total = 0u32;
            let mut previous = 0;
            for m in &self.milestones {
                require!(
                    m.weight_bps > 0
                        && m.deadline_offset > previous
                        && m.deadline_offset <= 315_360_000,
                    EconomyError::InvalidTerms
                );
                total += u32::from(m.weight_bps);
                previous = m.deadline_offset;
            }
            require!(total == 10000, EconomyError::InvalidTerms);
        } else {
            require!(
                self.milestones.is_empty() && self.reviewer_threshold == 0,
                EconomyError::InvalidTerms
            );
        }
        Ok(())
    }
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ModuleState {
    pub launch: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub beneficiary: Pubkey,
    pub reviewers: Vec<Pubkey>,
    pub threshold: u8,
    pub milestones: Vec<Milestone>,
    pub budgets: Vec<u64>,
    pub state: u8,
    pub activated_at: i64,
    pub initial_funding: u64,
    pub current: u8,
    pub approve_mask: u8,
    pub reject_mask: u8,
    pub bump: u8,
}
impl ModuleState {
    // Initialization mirrors the immutable account terms supplied by the registry CPI.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        launch: Pubkey,
        base_mint: Pubkey,
        quote_mint: Pubkey,
        beneficiary: Pubkey,
        reviewers: Vec<Pubkey>,
        threshold: u8,
        milestones: Vec<Milestone>,
        bump: u8,
        funding: bool,
    ) -> Result<Self> {
        if funding {
            require!(
                (3..=MAX_REVIEWERS).contains(&reviewers.len())
                    && usize::from(threshold) > reviewers.len() / 2
                    && usize::from(threshold) <= reviewers.len(),
                EconomyError::InvalidReviewers
            );
            require!(
                !milestones.is_empty() && milestones.len() <= MAX_MILESTONES,
                EconomyError::InvalidTerms
            );
            for (i, key) in reviewers.iter().enumerate() {
                require!(
                    *key != Pubkey::default()
                        && *key != beneficiary
                        && !reviewers[..i].contains(key),
                    EconomyError::InvalidReviewers
                );
            }
            let mut previous = 0;
            let mut sum = 0u32;
            for m in &milestones {
                require!(
                    m.weight_bps > 0
                        && m.deadline_offset > previous
                        && m.deadline_offset <= 315_360_000,
                    EconomyError::InvalidTerms
                );
                previous = m.deadline_offset;
                sum += u32::from(m.weight_bps);
            }
            require!(sum == 10000, EconomyError::InvalidTerms);
        } else {
            require!(
                reviewers.is_empty() && threshold == 0 && milestones.is_empty(),
                EconomyError::InvalidTerms
            );
        }
        Ok(Self {
            launch,
            base_mint,
            quote_mint,
            beneficiary,
            reviewers,
            threshold,
            milestones,
            budgets: Vec::new(),
            state: PENDING,
            activated_at: 0,
            initial_funding: 0,
            current: 0,
            approve_mask: 0,
            reject_mask: 0,
            bump,
        })
    }
    pub fn activate(&mut self, balance: u64, now: i64) -> Result<()> {
        require!(
            self.state == PENDING && balance > 0,
            EconomyError::InvalidState
        );
        self.budgets = budgets(balance, &self.milestones)?;
        for m in &self.milestones {
            now.checked_add(m.deadline_offset)
                .ok_or(EconomyError::Overflow)?;
        }
        self.initial_funding = balance;
        self.activated_at = now;
        self.state = ACTIVE;
        Ok(())
    }
    pub fn deadline(&self) -> Result<i64> {
        self.activated_at
            .checked_add(
                self.milestones
                    .get(usize::from(self.current))
                    .ok_or(EconomyError::InvalidState)?
                    .deadline_offset,
            )
            .ok_or_else(|| error!(EconomyError::Overflow))
    }
    pub fn vote(&mut self, reviewer: Pubkey, approve: bool, now: i64) -> Result<Option<u64>> {
        require!(
            self.state == ACTIVE && now < self.deadline()?,
            EconomyError::InvalidState
        );
        let index = self
            .reviewers
            .iter()
            .position(|p| *p == reviewer)
            .ok_or(EconomyError::Unauthorized)?;
        let bit = 1u8 << index;
        require!(
            (self.approve_mask | self.reject_mask) & bit == 0,
            EconomyError::DuplicateVote
        );
        if approve {
            self.approve_mask |= bit;
        } else {
            self.reject_mask |= bit;
        }
        if self.reject_mask.count_ones() >= u32::from(self.threshold) {
            self.state = REFUNDING;
            return Ok(None);
        }
        if self.approve_mask.count_ones() >= u32::from(self.threshold) {
            let amount = self.budgets[usize::from(self.current)];
            self.current += 1;
            self.approve_mask = 0;
            self.reject_mask = 0;
            if usize::from(self.current) == self.milestones.len() {
                self.state = COMPLETED;
            }
            return Ok(Some(amount));
        }
        Ok(None)
    }
    pub fn fail_expired(&mut self, now: i64) -> Result<()> {
        require!(
            self.state == ACTIVE && now >= self.deadline()?,
            EconomyError::InvalidState
        );
        self.state = REFUNDING;
        Ok(())
    }
}
pub fn budgets(balance: u64, milestones: &[Milestone]) -> Result<Vec<u64>> {
    if milestones.is_empty() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    let mut remaining = balance;
    for (i, m) in milestones.iter().enumerate() {
        let amount = if i + 1 == milestones.len() {
            remaining
        } else {
            ((u128::from(balance) * u128::from(m.weight_bps)) / 10000) as u64
        };
        require!(amount > 0, EconomyError::ZeroPayout);
        remaining = remaining
            .checked_sub(amount)
            .ok_or(EconomyError::Overflow)?;
        result.push(amount);
    }
    require!(remaining == 0, EconomyError::InvalidTerms);
    Ok(result)
}
pub fn payout(burn: u64, reserve: u64, supply: u64, min_payout: u64) -> Result<u64> {
    require!(
        burn > 0 && supply > 0 && burn <= supply && min_payout > 0,
        EconomyError::InvalidAmount
    );
    let out = (u128::from(burn) * u128::from(reserve) / u128::from(supply)) as u64;
    require!(out > 0 && out >= min_payout, EconomyError::Slippage);
    Ok(out)
}
pub fn executable_digest(
    publisher: Pubkey,
    parent: Pubkey,
    author: Pubkey,
    spec: &[u8],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"depthguard:model:v2");
    h.update(publisher.as_ref());
    h.update(parent.as_ref());
    h.update(author.as_ref());
    h.update(spec);
    h.finalize().into()
}
#[error_code]
pub enum EconomyError {
    #[msg("Invalid immutable terms")]
    InvalidTerms,
    #[msg("Invalid reviewer set or threshold")]
    InvalidReviewers,
    #[msg("Unauthorized authority")]
    Unauthorized,
    #[msg("Invalid lifecycle state")]
    InvalidState,
    #[msg("Reviewer has already voted")]
    DuplicateVote,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid atomic amount")]
    InvalidAmount,
    #[msg("Payout below minimum or zero")]
    Slippage,
    #[msg("Milestone budget rounds to zero")]
    ZeroPayout,
}
#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    proptest! {#[test]fn payout_conserves(s in 1u64..=u64::MAX,r in 1u64..=u64::MAX,b in 1u64..=u64::MAX){let b=b.min(s);if let Ok(p)=payout(b,r,s,1){prop_assert!(p<=r);prop_assert_eq!(u128::from(p),u128::from(b)*u128::from(r)/u128::from(s));if b==s{prop_assert_eq!(p,r);}}}}
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2048))]
        #[test]
        fn sequential_redemptions_conserve(s in 2u64..=u64::MAX, r in 2u64..=u64::MAX, fraction in 1u64..10000) {
            let b = ((u128::from(s) * u128::from(fraction)) / 10000) as u64;
            if let Ok(first) = payout(b, r, s, 1) {
                let remaining = payout(s-b, r-first, s-b, 1).unwrap();
                prop_assert_eq!(u128::from(first)+u128::from(remaining),u128::from(r));
            }
        }
        #[test]
        fn milestone_budgets_conserve(r in 10000u64..=u64::MAX, weight in 1u16..10000) {
            let terms = vec![Milestone {weight_bps:weight,deadline_offset:1},Milestone {weight_bps:10000-weight,deadline_offset:2}];
            let split = budgets(r,&terms).unwrap();
            prop_assert_eq!(u128::from(split[0])+u128::from(split[1]),u128::from(r));
            prop_assert!(split.iter().all(|v| *v > 0));
        }
    }
    #[test]
    fn reject_invalid_amounts_and_tiny_budgets() {
        assert!(payout(0, 100, 100, 1).is_err());
        assert!(payout(101, 100, 100, 1).is_err());
        assert!(payout(1, 1, 100, 1).is_err());
        assert!(payout(1, 100, 100, 0).is_err());
        assert!(payout(1, u64::MAX, 1, u64::MAX).is_ok());
        assert!(budgets(
            1,
            &[
                Milestone {
                    weight_bps: 5000,
                    deadline_offset: 1
                },
                Milestone {
                    weight_bps: 5000,
                    deadline_offset: 2
                }
            ]
        )
        .is_err());
    }
    #[test]
    fn reject_reviewer_capture_and_deadline_overflow() {
        let b = Pubkey::new_unique();
        let r = (0..3).map(|_| Pubkey::new_unique()).collect::<Vec<_>>();
        let init = |reviewers, threshold| {
            ModuleState::initialize(
                Pubkey::new_unique(),
                Pubkey::new_unique(),
                Pubkey::new_unique(),
                b,
                reviewers,
                threshold,
                vec![Milestone {
                    weight_bps: 10000,
                    deadline_offset: 10,
                }],
                0,
                true,
            )
        };
        assert!(init(vec![r[0], r[0], r[1]], 2).is_err());
        assert!(init(vec![b, r[0], r[1]], 2).is_err());
        assert!(init(r.clone(), 1).is_err());
        assert!(init(r.clone(), 4).is_err());
        let mut state = init(r, 2).unwrap();
        assert!(state.activate(10, i64::MAX).is_err());
        assert_eq!(state.state, PENDING);
    }
    #[test]
    fn digest_binds_author_parent_and_exact_bytes() {
        let p = Pubkey::new_unique();
        let a = Pubkey::new_unique();
        let parent = Pubkey::new_unique();
        let h = executable_digest(p, parent, a, b"terms");
        assert_ne!(h, executable_digest(a, parent, a, b"terms"));
        assert_ne!(h, executable_digest(p, Pubkey::default(), a, b"terms"));
        assert_ne!(h, executable_digest(p, parent, p, b"terms"));
        assert_ne!(h, executable_digest(p, parent, a, b"termS"));
    }
    #[test]
    fn irreversible_refund_and_boundary() {
        let beneficiary = Pubkey::new_unique();
        let reviewers = (0..3).map(|_| Pubkey::new_unique()).collect::<Vec<_>>();
        let mut s = ModuleState::initialize(
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            beneficiary,
            reviewers.clone(),
            2,
            vec![
                Milestone {
                    weight_bps: 4000,
                    deadline_offset: 10,
                },
                Milestone {
                    weight_bps: 6000,
                    deadline_offset: 20,
                },
            ],
            0,
            true,
        )
        .unwrap();
        s.activate(1001, 100).unwrap();
        assert_eq!(s.budgets, vec![400, 601]);
        assert_eq!(s.vote(reviewers[0], true, 109).unwrap(), None);
        assert!(s.vote(reviewers[0], true, 109).is_err());
        assert!(s.vote(reviewers[1], true, 110).is_err());
        s.fail_expired(110).unwrap();
        assert!(s.vote(reviewers[1], true, 111).is_err());
    }
    #[test]
    fn approval_and_rejection_quorums() {
        let b = Pubkey::new_unique();
        let r = (0..3).map(|_| Pubkey::new_unique()).collect::<Vec<_>>();
        let mut s = ModuleState::initialize(
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            b,
            r.clone(),
            2,
            vec![
                Milestone {
                    weight_bps: 5000,
                    deadline_offset: 10,
                },
                Milestone {
                    weight_bps: 5000,
                    deadline_offset: 20,
                },
            ],
            0,
            true,
        )
        .unwrap();
        s.activate(10, 100).unwrap();
        s.vote(r[0], true, 101).unwrap();
        assert_eq!(s.vote(r[1], true, 102).unwrap(), Some(5));
        s.vote(r[0], false, 111).unwrap();
        s.vote(r[1], false, 112).unwrap();
        assert_eq!(s.state, REFUNDING);
    }
}
