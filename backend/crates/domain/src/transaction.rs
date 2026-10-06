use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransactionState {
    Prepared,
    Submitted,
    Confirmed,
    Finalized,
    Failed,
    Expired,
    VerificationFailed,
}
impl TransactionState {
    pub fn permits(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Prepared, Self::Submitted | Self::Expired)
                | (
                    Self::Submitted,
                    Self::Confirmed | Self::Finalized | Self::Failed | Self::Expired
                )
                | (
                    Self::Confirmed,
                    Self::Finalized | Self::Failed | Self::VerificationFailed
                )
                | (Self::Finalized, Self::VerificationFailed)
        ) || self == next
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finality_cannot_be_reversed_by_retry() {
        assert!(!TransactionState::Finalized.permits(TransactionState::Submitted));
        assert!(!TransactionState::Failed.permits(TransactionState::Confirmed));
        assert!(TransactionState::Submitted.permits(TransactionState::Finalized));
    }
}
