use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct DeliveryDeclaration {
    pub note: String,
    pub destinations: Vec<DeliveryDestination>,
}

impl DeliveryDeclaration {
    pub fn validate(&self) -> Result<(), String> {
        if self.note.trim().is_empty() || self.destinations.is_empty() {
            return Err("delivery requires a note and at least one destination".into());
        }
        let mut keys = HashSet::new();
        for destination in &self.destinations {
            if destination.key.trim().is_empty() || destination.label.trim().is_empty() {
                return Err("delivery destinations require non-empty keys and labels".into());
            }
            if !keys.insert(destination.key.as_str()) {
                return Err(format!(
                    "duplicate delivery destination key: {}",
                    destination.key
                ));
            }
            if let DeliveryEvidence::ToolCall { tool } = &destination.evidence {
                if tool.trim().is_empty() {
                    return Err("tool-call delivery evidence requires a tool name".into());
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct DeliveryDestination {
    pub key: String,
    pub label: String,
    pub evidence: DeliveryEvidence,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DeliveryEvidence {
    InboxItem,
    ToolCall { tool: String },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    Confirmed,
    Partial,
    Failed,
    Unobserved,
    Undeclared,
}

impl DeliveryStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Partial => "partial",
            Self::Failed => "failed",
            Self::Unobserved => "unobserved",
            Self::Undeclared => "undeclared",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DestinationStatus {
    Confirmed,
    Failed,
    Unobserved,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DeliveryObservation {
    pub key: String,
    pub status: DestinationStatus,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DeliveryEvidenceSnapshot {
    pub destinations: Vec<DeliveryObservation>,
}

pub fn derive_delivery_status(
    declaration: Option<&DeliveryDeclaration>,
    tool_calls: &[(String, Option<bool>)],
    produced_inbox_item: bool,
) -> (DeliveryStatus, DeliveryEvidenceSnapshot) {
    let Some(declaration) = declaration else {
        return (
            DeliveryStatus::Undeclared,
            DeliveryEvidenceSnapshot {
                destinations: Vec::new(),
            },
        );
    };

    let destinations = declaration
        .destinations
        .iter()
        .map(|destination| {
            let status = match &destination.evidence {
                DeliveryEvidence::InboxItem => {
                    if produced_inbox_item {
                        DestinationStatus::Confirmed
                    } else {
                        DestinationStatus::Unobserved
                    }
                }
                DeliveryEvidence::ToolCall { tool } => {
                    let matching = tool_calls.iter().filter(|(name, _)| name == tool);
                    let mut saw_success = false;
                    let mut saw_failure = false;
                    for (_, ok) in matching {
                        saw_success |= *ok == Some(true);
                        saw_failure |= *ok == Some(false);
                    }
                    if saw_success {
                        DestinationStatus::Confirmed
                    } else if saw_failure {
                        DestinationStatus::Failed
                    } else {
                        DestinationStatus::Unobserved
                    }
                }
            };
            DeliveryObservation {
                key: destination.key.clone(),
                status,
            }
        })
        .collect::<Vec<_>>();

    let confirmed = destinations
        .iter()
        .filter(|d| d.status == DestinationStatus::Confirmed)
        .count();
    let failed = destinations
        .iter()
        .any(|d| d.status == DestinationStatus::Failed);
    let status = if !destinations.is_empty() && confirmed == destinations.len() {
        DeliveryStatus::Confirmed
    } else if confirmed > 0 {
        DeliveryStatus::Partial
    } else if failed {
        DeliveryStatus::Failed
    } else {
        DeliveryStatus::Unobserved
    };

    (status, DeliveryEvidenceSnapshot { destinations })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn declaration() -> DeliveryDeclaration {
        DeliveryDeclaration {
            note: "Daily brief".into(),
            destinations: vec![
                DeliveryDestination {
                    key: "inbox".into(),
                    label: "Tasks Inbox".into(),
                    evidence: DeliveryEvidence::InboxItem,
                },
                DeliveryDestination {
                    key: "email".into(),
                    label: "Email".into(),
                    evidence: DeliveryEvidence::ToolCall {
                        tool: "GMAIL_SEND_EMAIL".into(),
                    },
                },
            ],
        }
    }

    #[test]
    fn undeclared_runs_are_explicit() {
        let (status, evidence) = derive_delivery_status(None, &[], false);
        assert_eq!(status, DeliveryStatus::Undeclared);
        assert!(evidence.destinations.is_empty());
    }

    #[test]
    fn all_declared_evidence_confirmed() {
        let (status, evidence) = derive_delivery_status(
            Some(&declaration()),
            &[("GMAIL_SEND_EMAIL".into(), Some(true))],
            true,
        );
        assert_eq!(status, DeliveryStatus::Confirmed);
        assert!(evidence
            .destinations
            .iter()
            .all(|d| d.status == DestinationStatus::Confirmed));
    }

    #[test]
    fn mixed_evidence_is_partial() {
        let (status, _) = derive_delivery_status(Some(&declaration()), &[], true);
        assert_eq!(status, DeliveryStatus::Partial);
    }

    #[test]
    fn failed_tool_call_is_failed_when_nothing_confirmed() {
        let (status, _) = derive_delivery_status(
            Some(&declaration()),
            &[("GMAIL_SEND_EMAIL".into(), Some(false))],
            false,
        );
        assert_eq!(status, DeliveryStatus::Failed);
    }

    #[test]
    fn absent_evidence_is_unobserved() {
        let (status, _) = derive_delivery_status(Some(&declaration()), &[], false);
        assert_eq!(status, DeliveryStatus::Unobserved);
    }

    #[test]
    fn declarations_require_unique_destination_keys() {
        let mut value = declaration();
        value.destinations[1].key = value.destinations[0].key.clone();
        assert!(value.validate().unwrap_err().contains("duplicate"));
    }
}
