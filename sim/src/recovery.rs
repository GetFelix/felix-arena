//! Picking an arena's match up where a crashed sim left it, from the ticks in
//! the log (docs/design.md, "Failure modes").

use anyhow::{Context, Result};
use felix_arena_core::{Rules, Tick, World};
use felix_client::ClusterClient;

use crate::arena::KEYFRAME_KEY;

/// Records asked for at a time while reading the tail.
const PAGE: u32 = 256;

/// Where an arena carries on: the epoch to write its ticks under and, when
/// the log held a match, the world to resume.
pub(crate) struct Recovered {
    pub(crate) epoch: u16,
    pub(crate) world: Option<World>,
}

/// Read `arena`'s log from its newest keyframe to the tail and rebuild the
/// match. An arena with nothing in its log starts fresh in epoch 0.
pub(crate) async fn load(
    client: &ClusterClient,
    tenant: &str,
    namespace: &str,
    arena: &str,
    rules: Rules,
) -> Result<Recovered> {
    let stream = format!("arena.ticks.{arena}");
    let keyframe = client
        .state_get(tenant, namespace, &stream, stream.as_bytes(), KEYFRAME_KEY)
        .await
        .context("read the keyframe key")?;
    let Some(from) = keyframe.version else {
        return Ok(Recovered {
            epoch: 0,
            world: None,
        });
    };
    let mut ticks = Vec::new();
    let mut at = from;
    loop {
        let page = client
            .read(tenant, namespace, &stream, 0, at, None, PAGE)
            .await
            .context("read the tail")?;
        if page.records.is_empty() {
            break;
        }
        ticks.extend(
            page.records
                .iter()
                .filter_map(|record| Tick::decode(&record.payload))
                .map(|(tick, _)| tick),
        );
        if page.next_offset <= at {
            break;
        }
        at = page.next_offset;
    }
    Ok(rebuild(rules, ticks))
}

/// The world after `ticks`, which are in log order, and the epoch after theirs.
/// Only the newest epoch's ticks count, and a tick number seen twice (a commit
/// that landed twice) counts once. A tail with no keyframe in it gives a new
/// epoch and no world, so the new match is not mistaken for the old sim's.
fn rebuild(rules: Rules, ticks: Vec<Tick>) -> Recovered {
    let Some(newest) = ticks.iter().map(|tick| tick.epoch).max() else {
        return Recovered {
            epoch: 0,
            world: None,
        };
    };
    let mut kept: Vec<Tick> = Vec::new();
    for tick in ticks.into_iter().filter(|tick| tick.epoch == newest) {
        if kept.last().is_none_or(|last| tick.tick > last.tick) {
            kept.push(tick);
        }
    }
    let world = kept
        .iter()
        .rposition(Tick::is_keyframe)
        .and_then(|keyframe| World::recover(rules, &kept[keyframe], &kept[keyframe + 1..]));
    Recovered {
        epoch: newest.saturating_add(1),
        world,
    }
}

#[cfg(test)]
mod tests;
