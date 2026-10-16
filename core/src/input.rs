//! What a player sends each tick, and the record it travels in.

/// One tick of a player's controls.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Input {
    /// The input's sequence number, which the tick that applies it echoes.
    pub seq: u16,
    /// The move stick: -127 to 127 on each axis, a length over 127 is cut to 127.
    pub move_x: i8,
    pub move_z: i8,
    /// Where the craft aims, as a heading: 65536 is a full turn, 0 is +x and
    /// a quarter turn is +z.
    pub aim: u16,
    /// [`FIRE`] and [`BOOST`].
    pub buttons: u8,
}

/// Fire the weapon, held.
pub const FIRE: u8 = 1;
/// Dash, when the boost has cooled down.
pub const BOOST: u8 = 2;

/// An input record: the newest input and the two before it, so that one lost
/// record is covered by the next.
///
/// Little-endian: kind (1 byte, [`InputRecord::KIND`]), the newest sequence
/// number (2), then three inputs, newest first, each the move vector (2),
/// aim (2) and buttons (1). The older two carry the sequence numbers before
/// the newest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputRecord {
    /// Newest first.
    pub inputs: [Input; 3],
}

impl InputRecord {
    pub const LEN: usize = 18;
    pub const KIND: u8 = 1;

    /// A record of `newest` and the two inputs before it, newest first.
    pub fn new(newest: Input, previous: [Input; 2]) -> Self {
        let mut inputs = [newest, previous[0], previous[1]];
        for (i, input) in inputs.iter_mut().enumerate() {
            input.seq = newest.seq.wrapping_sub(i as u16);
        }
        Self { inputs }
    }

    pub fn encode(&self) -> [u8; Self::LEN] {
        let mut out = [0; Self::LEN];
        out[0] = Self::KIND;
        out[1..3].copy_from_slice(&self.inputs[0].seq.to_le_bytes());
        for (input, at) in self.inputs.iter().zip((3..).step_by(5)) {
            out[at] = input.move_x as u8;
            out[at + 1] = input.move_z as u8;
            out[at + 2..at + 4].copy_from_slice(&input.aim.to_le_bytes());
            out[at + 4] = input.buttons;
        }
        out
    }

    /// The record in `bytes`, which must be exactly one record.
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        let bytes: &[u8; Self::LEN] = bytes.try_into().ok()?;
        if bytes[0] != Self::KIND {
            return None;
        }
        let seq = u16::from_le_bytes([bytes[1], bytes[2]]);
        let mut inputs = [Input::default(); 3];
        for (i, (input, at)) in inputs.iter_mut().zip((3..).step_by(5)).enumerate() {
            *input = Input {
                seq: seq.wrapping_sub(i as u16),
                move_x: bytes[at] as i8,
                move_z: bytes[at + 1] as i8,
                aim: u16::from_le_bytes([bytes[at + 2], bytes[at + 3]]),
                buttons: bytes[at + 4],
            };
        }
        Some(Self { inputs })
    }

    /// The input to apply after `applied`, the last sequence number applied:
    /// the newest input, with the buttons of every input since `applied` it
    /// covers, so a press in a lost record still counts. `None` when the
    /// record is not newer than `applied`.
    pub fn since(&self, applied: Option<u16>) -> Option<Input> {
        let newer = |seq: u16| applied.is_none_or(|applied| (seq.wrapping_sub(applied) as i16) > 0);
        if !newer(self.inputs[0].seq) {
            return None;
        }
        let mut input = self.inputs[0];
        for older in &self.inputs[1..] {
            if newer(older.seq) {
                input.buttons |= older.buttons;
            }
        }
        Some(input)
    }
}

#[cfg(test)]
mod tests {
    use super::{BOOST, FIRE, Input, InputRecord};

    fn input(seq: u16, buttons: u8) -> Input {
        Input {
            seq,
            move_x: -127,
            move_z: 5,
            aim: 40_000,
            buttons,
        }
    }

    #[test]
    fn round_trips() {
        let record = InputRecord::new(input(1, FIRE), [input(0, 0), input(65535, BOOST)]);
        let bytes = record.encode();
        assert_eq!(bytes.len(), 18);
        assert_eq!(InputRecord::decode(&bytes), Some(record));
        assert_eq!(record.inputs[2].seq, 65535);
        assert_eq!(InputRecord::decode(&bytes[..17]), None);
        let mut wrong = bytes;
        wrong[0] = 9;
        assert_eq!(InputRecord::decode(&wrong), None);
    }

    #[test]
    fn a_press_in_a_lost_record_still_counts() {
        let record = InputRecord::new(input(10, 0), [input(9, BOOST), input(8, FIRE)]);
        assert_eq!(record.since(Some(8)).map(|i| i.buttons), Some(BOOST));
        assert_eq!(record.since(Some(7)).map(|i| i.buttons), Some(BOOST | FIRE));
        assert_eq!(record.since(Some(9)).map(|i| i.buttons), Some(0));
        assert_eq!(record.since(Some(10)), None);
        assert_eq!(record.since(Some(11)), None);
        assert_eq!(record.since(None).map(|i| i.seq), Some(10));
    }

    #[test]
    fn sequence_numbers_wrap() {
        let record = InputRecord::new(input(1, 0), [input(0, FIRE), input(65535, 0)]);
        assert_eq!(
            record.since(Some(65535)).map(|i| (i.seq, i.buttons)),
            Some((1, FIRE))
        );
    }
}
