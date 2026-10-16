//! Players' inputs: read from the arena's input stream, checked, and turned
//! into one input per craft each tick.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use felix_arena_core::{Input, InputRecord, World, player_key};
use felix_client::ClusterClient;
use tokio::time::Instant;
use tracing::warn;

/// A player whose inputs stop is held on the last one this long, then coasts.
pub(crate) const HOLD: Duration = Duration::from_millis(100);
/// A player silent this long leaves the arena.
pub(crate) const LEAVE_AFTER: Duration = Duration::from_secs(10);
/// An input this many sequence numbers behind the last one applied is taken
/// as a client that started counting again, not as a late arrival.
const RESTART_GAP: u16 = 90;

/// An input record from the input stream, and who sent it.
#[derive(Clone, Debug)]
pub(crate) struct Received {
    pub(crate) principal: String,
    pub(crate) record: InputRecord,
    pub(crate) at: Instant,
}

/// Why an event on the input stream was not taken as an input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refused {
    /// No sender stamp, or not one input record after it.
    Malformed,
    /// The broker did not say who published it, or it says someone other
    /// than the stamp.
    Unvouched,
}

/// Split an input event into the gateway's sender stamp and the record. The
/// stamp is a 2-byte big-endian length and the principal. `publisher` is who
/// the broker accepted the publish from, and must be the same principal.
pub(crate) fn parse(
    payload: &[u8],
    publisher: Option<&str>,
) -> Result<(String, InputRecord), Refused> {
    let (length, rest) = payload.split_first_chunk::<2>().ok_or(Refused::Malformed)?;
    let length = usize::from(u16::from_be_bytes(*length));
    let (principal, record) = rest.split_at_checked(length).ok_or(Refused::Malformed)?;
    let principal = std::str::from_utf8(principal).map_err(|_| Refused::Malformed)?;
    let record = InputRecord::decode(record).ok_or(Refused::Malformed)?;
    if principal.is_empty() || publisher != Some(principal) {
        return Err(Refused::Unvouched);
    }
    Ok((principal.to_owned(), record))
}

/// Inputs received since the arena last took them.
#[derive(Default)]
pub(crate) struct Inbox {
    pub(crate) received: Vec<Received>,
    /// Events that were not inputs, counted since the arena last took them.
    pub(crate) refused: u64,
}

/// More than this many waiting inputs means the arena has stalled; newer
/// ones are refused rather than held without bound.
const INBOX_LIMIT: usize = 4096;

/// Read `stream` forever, putting each input into `inbox`. A lost
/// subscription is opened again from the live tail: inputs are at most once,
/// and a missed one is superseded by the next.
pub(crate) async fn follow(
    client: Arc<ClusterClient>,
    tenant: String,
    namespace: String,
    stream: String,
    inbox: Arc<Mutex<Inbox>>,
) {
    loop {
        let mut subscription = match client.subscribe(&tenant, &namespace, &stream).await {
            Ok(subscription) => subscription,
            Err(err) => {
                warn!(stream, error = %format!("{err:#}"), "cannot subscribe to inputs");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        loop {
            let event = match subscription.next_event().await {
                Ok(Some(event)) => event,
                Ok(None) => break,
                Err(err) => {
                    warn!(stream, error = %format!("{err:#}"), "input subscription failed");
                    break;
                }
            };
            let at = Instant::now();
            let parsed = parse(&event.payload, event.publisher.as_deref());
            let mut inbox = inbox
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match parsed {
                Ok((principal, record)) if inbox.received.len() < INBOX_LIMIT => {
                    inbox.received.push(Received {
                        principal,
                        record,
                        at,
                    });
                }
                _ => inbox.refused += 1,
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// One player's place in the world and its newest input.
struct Seat {
    slot: u8,
    applied: Option<u16>,
    newest: Option<Input>,
    heard: Instant,
}

/// The arena's players, by principal.
#[derive(Default)]
pub(crate) struct Players {
    seats: HashMap<String, Seat>,
}

impl Players {
    /// Take in the inputs received since the last tick, joining new players
    /// and removing silent ones, and answer the input for each slot at `now`.
    pub(crate) fn update(
        &mut self,
        world: &mut World,
        received: Vec<Received>,
        now: Instant,
    ) -> [Option<Input>; 8] {
        for Received {
            principal,
            record,
            at,
        } in received
        {
            let seat = match self.seats.get_mut(&principal) {
                Some(seat) => seat,
                None => {
                    let Some(slot) = world.join(player_key(&principal)) else {
                        continue;
                    };
                    self.seats.entry(principal).or_insert(Seat {
                        slot,
                        applied: None,
                        newest: None,
                        heard: at,
                    })
                }
            };
            // After a silence the client may have started counting again,
            // as a reloaded page does, so its numbers are not compared with
            // the old ones.
            let applied = seat
                .applied
                .filter(|_| at.duration_since(seat.heard) <= HOLD);
            let behind = applied.map(|applied| applied.wrapping_sub(record.inputs[0].seq));
            let input = match record.since(applied) {
                Some(input) => input,
                None if behind.is_some_and(|behind| behind > RESTART_GAP) => record.inputs[0],
                None => continue,
            };
            seat.applied = Some(input.seq);
            seat.newest = Some(input);
            seat.heard = seat.heard.max(at);
        }
        self.seats.retain(|_, seat| {
            let stays = now.duration_since(seat.heard) < LEAVE_AFTER;
            if !stays {
                world.leave(seat.slot);
            }
            stays
        });
        let mut controls = [None; 8];
        for seat in self.seats.values() {
            if now.duration_since(seat.heard) <= HOLD {
                controls[usize::from(seat.slot)] = seat.newest;
            }
        }
        controls
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use felix_arena_core::{Input, InputRecord, World, player_key};
    use tokio::time::Instant;

    use super::{HOLD, LEAVE_AFTER, Players, Received, Refused, parse};

    fn stamped(principal: &str, body: &[u8]) -> Vec<u8> {
        let mut out = (principal.len() as u16).to_be_bytes().to_vec();
        out.extend_from_slice(principal.as_bytes());
        out.extend_from_slice(body);
        out
    }

    fn record(seq: u16, move_x: i8) -> InputRecord {
        let input = Input {
            seq,
            move_x,
            move_z: 0,
            aim: 0,
            buttons: 0,
        };
        InputRecord::new(input, [input; 2])
    }

    #[test]
    fn parses_the_stamp_and_the_record() {
        let body = record(5, 127).encode();
        assert_eq!(
            parse(&stamped("ana", &body), Some("ana")),
            Ok(("ana".into(), record(5, 127)))
        );
    }

    #[test]
    fn a_stamp_the_broker_does_not_vouch_for_is_refused() {
        let body = record(5, 127).encode();
        assert_eq!(
            parse(&stamped("ana", &body), Some("ben")),
            Err(Refused::Unvouched)
        );
        assert_eq!(parse(&stamped("ana", &body), None), Err(Refused::Unvouched));
    }

    #[test]
    fn a_forged_stamp_inside_the_payload_is_not_an_input() {
        // What reaches the sim when ben's client sends a stamp of its own:
        // the gateway's stamp, then ben's bytes.
        let forged = stamped("ana", &record(5, 127).encode());
        assert_eq!(
            parse(&stamped("ben", &forged), Some("ben")),
            Err(Refused::Malformed)
        );
        assert_eq!(parse(&[0, 9, b'a'], Some("a")), Err(Refused::Malformed));
        assert_eq!(
            parse(&stamped("", &record(1, 0).encode()), Some("")),
            Err(Refused::Unvouched)
        );
    }

    #[test]
    fn players_join_hold_their_last_input_then_coast_and_leave() {
        let mut world = World::new(0);
        let mut players = Players::default();
        let start = Instant::now();
        let got = |principal: &str, record: InputRecord, at: Instant| Received {
            principal: principal.into(),
            record,
            at,
        };

        let controls = players.update(&mut world, vec![got("ana", record(1, 127), start)], start);
        assert_eq!(controls[0].map(|i| i.seq), Some(1));
        assert_eq!(world.crafts().len(), 1);
        world.step(|slot| controls[usize::from(slot)]);

        let controls = players.update(&mut world, vec![], start + HOLD);
        assert_eq!(controls[0].map(|i| i.seq), Some(1), "held");
        let controls = players.update(&mut world, vec![], start + HOLD + Duration::from_millis(1));
        assert_eq!(controls[0], None, "coasting");

        // An older record than the one applied changes nothing.
        let later = start + Duration::from_millis(200);
        players.update(&mut world, vec![got("ana", record(3, 127), later)], later);
        let controls = players.update(&mut world, vec![got("ana", record(2, -127), later)], later);
        assert_eq!(controls[0].map(|i| (i.seq, i.move_x)), Some((3, 127)));

        let gone = later + LEAVE_AFTER;
        players.update(&mut world, vec![], gone);
        world.step(|_| None);
        assert!(world.crafts().is_empty());
        assert_eq!(player_key("ana"), player_key("ana"));
    }

    #[test]
    fn each_principal_moves_only_its_own_craft() {
        let mut world = World::new(0);
        let mut players = Players::default();
        let now = Instant::now();
        let received = vec![
            Received {
                principal: "ana".into(),
                record: record(1, 127),
                at: now,
            },
            Received {
                principal: "ben".into(),
                record: record(1, -127),
                at: now,
            },
        ];
        let controls = players.update(&mut world, received, now);
        assert_eq!(controls[0].map(|i| i.move_x), Some(127));
        assert_eq!(controls[1].map(|i| i.move_x), Some(-127));
    }

    #[test]
    fn a_client_that_starts_counting_again_is_heard() {
        let mut world = World::new(0);
        let mut players = Players::default();
        let now = Instant::now();
        let got = |seq, at| {
            vec![Received {
                principal: "ana".into(),
                record: record(seq, 1),
                at,
            }]
        };
        players.update(&mut world, got(5000, now), now);
        assert_eq!(
            players.update(&mut world, got(1, now), now)[0].map(|i| i.seq),
            Some(1)
        );
        assert_eq!(
            players.update(&mut world, got(2, now), now)[0].map(|i| i.seq),
            Some(2)
        );
        // A reload soon after, from a little behind, is heard once the client
        // has been quiet for longer than the hold.
        let later = now + HOLD * 2;
        assert_eq!(
            players.update(&mut world, got(1, later), later)[0].map(|i| i.seq),
            Some(1)
        );
    }
}
