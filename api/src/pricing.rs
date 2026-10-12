//! Canonical list rates live in model-pricing.json. Regenerate the web copy
//! with pnpm gen:pricing in web/; a web test guards against drift.
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRate {
    input: f64,
    output: f64,
    cache_read: Option<f64>,
    cache_write: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LongContext {
    threshold: i64,
    #[serde(flatten)]
    rate: TokenRate,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRate {
    #[serde(flatten)]
    base: TokenRate,
    #[serde(skip_serializing_if = "Option::is_none")]
    long_context: Option<LongContext>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingSnapshot {
    verified_on: String,
    source: String,
    rate: ModelRate,
}

#[derive(Deserialize)]
struct Entry {
    models: Vec<String>,
    #[serde(flatten)]
    rate: ModelRate,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    verified_on: String,
    sources: HashMap<String, String>,
    rates: Vec<Entry>,
}

static CATALOG: Lazy<Catalog> = Lazy::new(|| {
    serde_json::from_str(include_str!("model-pricing.json")).expect("valid pricing catalog")
});

pub fn lookup_pricing(model: &str) -> Option<PricingSnapshot> {
    let name = model.to_ascii_lowercase();
    let entry = CATALOG.rates.iter().find(|r| r.models.contains(&name))?;
    let (provider, _) = name.split_once(':')?;
    Some(PricingSnapshot {
        verified_on: CATALOG.verified_on.clone(),
        source: CATALOG.sources.get(provider)?.clone(),
        rate: entry.rate.clone(),
    })
}

/// Disjoint token counts, normalized by the runner protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tokens {
    pub input: i32,
    pub output: i32,
    pub cache_read: i32,
    pub cache_write: i32,
}

impl PricingSnapshot {
    pub fn request_cost(&self, tokens: Tokens) -> Option<f64> {
        let Tokens {
            input,
            output,
            cache_read,
            cache_write,
        } = tokens;
        if [input, output, cache_read, cache_write]
            .iter()
            .any(|n| *n < 0)
        {
            return None;
        }
        let prompt = i64::from(input) + i64::from(cache_read) + i64::from(cache_write);
        let rate = match &self.rate.long_context {
            Some(tier) if prompt > tier.threshold => &tier.rate,
            _ => &self.rate.base,
        };
        let read_cost = if cache_read == 0 {
            0.0
        } else {
            f64::from(cache_read) * rate.cache_read?
        };
        let write_cost = if cache_write == 0 {
            0.0
        } else {
            f64::from(cache_write) * rate.cache_write?
        };
        Some(
            (f64::from(input) * rate.input
                + f64::from(output) * rate.output
                + read_cost
                + write_cost)
                / 1_000_000.0,
        )
    }

    pub fn run_cost(&self, total: Tokens, requests: &[Tokens]) -> Option<f64> {
        if self.rate.long_context.is_none() {
            return self.request_cost(total);
        }
        // Resumed/incomplete traces can lack earlier requests. Never guess which
        // tier applied using aggregate run tokens.
        let sums = requests.iter().fold([0_i64; 4], |mut sums, t| {
            for (sum, count) in
                sums.iter_mut()
                    .zip([t.input, t.output, t.cache_read, t.cache_write])
            {
                *sum += i64::from(count);
            }
            sums
        });
        if requests.is_empty()
            || sums
                != [
                    total.input,
                    total.output,
                    total.cache_read,
                    total.cache_write,
                ]
                .map(i64::from)
        {
            return None;
        }
        requests.iter().map(|t| self.request_cost(*t)).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Case {
        model: String,
        input: i32,
        output: i32,
        read: i32,
        write: i32,
        expected: Option<f64>,
    }

    #[test]
    fn shared_pricing_cases() {
        let cases: Vec<Case> = serde_json::from_str(include_str!("pricing-cases.json")).unwrap();
        for c in cases {
            let actual = lookup_pricing(&c.model).and_then(|p| {
                p.request_cost(Tokens {
                    input: c.input,
                    output: c.output,
                    cache_read: c.read,
                    cache_write: c.write,
                })
            });
            match (actual, c.expected) {
                (Some(actual), Some(expected)) => assert!(
                    (actual - expected).abs() < 1e-9,
                    "{}: {actual} != {expected}",
                    c.model
                ),
                (None, None) => {}
                _ => panic!("{}: {:?} != {:?}", c.model, actual, c.expected),
            }
        }
    }

    #[test]
    fn tiers_apply_per_request_not_per_run() {
        let pricing = lookup_pricing("openai:gpt-5.5").unwrap();
        let request = Tokens {
            input: 200_000,
            output: 1_000,
            cache_read: 0,
            cache_write: 0,
        };
        let total = Tokens {
            input: 400_000,
            output: 2_000,
            cache_read: 0,
            cache_write: 0,
        };
        assert_eq!(pricing.run_cost(total, &[request, request]), Some(2.06));
        assert_eq!(pricing.run_cost(total, &[request]), None);
        assert_eq!(pricing.run_cost(total, &[]), None);
    }

    #[test]
    fn snapshot_survives_round_trip_and_catalog_changes() {
        let mut pricing = lookup_pricing("anthropic:claude-sonnet-5").unwrap();
        pricing.verified_on = "2026-10-07".into();
        pricing.rate.base.input = 99.0;
        let json = serde_json::to_value(&pricing).unwrap();
        assert_eq!(json["verifiedOn"], "2026-10-07");
        assert_eq!(json["rate"]["cacheRead"], 0.2);
        let saved: PricingSnapshot = serde_json::from_value(json).unwrap();
        let tokens = Tokens {
            input: 1_000_000,
            output: 0,
            cache_read: 0,
            cache_write: 0,
        };
        assert_eq!(saved.run_cost(tokens, &[]), Some(99.0));
        assert_eq!(
            lookup_pricing("anthropic:claude-sonnet-5")
                .unwrap()
                .run_cost(tokens, &[]),
            Some(2.0)
        );
    }

    #[test]
    fn saved_sonnet_5_5_cache_rate_is_not_repriced() {
        let mut historical = lookup_pricing("anthropic:claude-sonnet-5-5").unwrap();
        historical.verified_on = "2026-10-07".into();
        historical.rate.base.cache_read = Some(0.2);
        let saved: PricingSnapshot =
            serde_json::from_value(serde_json::to_value(historical).unwrap()).unwrap();
        let tokens = Tokens {
            input: 0,
            output: 0,
            cache_read: 1_000_000,
            cache_write: 0,
        };
        assert_eq!(saved.run_cost(tokens, &[]), Some(0.2));
        assert_eq!(
            lookup_pricing("anthropic:claude-sonnet-5-5")
                .unwrap()
                .run_cost(tokens, &[]),
            Some(0.1)
        );
    }

    #[test]
    fn catalog_aliases_are_unique() {
        let mut names = std::collections::HashSet::new();
        for entry in &CATALOG.rates {
            for model in &entry.models {
                assert!(names.insert(model), "duplicate model {model}");
            }
        }
    }
}
