/// When the sim stepped and committed a tick, for timing each hop of its way
/// to the browser. It follows the header when the header's timed flag is set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Timing {
    /// When this tick's commit started: microseconds since the Unix epoch on
    /// the sim's clock.
    pub(crate) commit_start_us: u64,
    /// From the tick falling due to its commit starting: the sim's step.
    pub(crate) step_us: u32,
    /// How long the previous tick's commit took to be answered, or 0 when it
    /// failed or there was none. A tick cannot carry its own.
    pub(crate) previous_commit_us: u32,
}

impl Timing {
    pub(crate) const LEN: usize = 16;

    /// Little-endian: commit start (8 bytes), step (4), previous commit (4).
    pub(crate) fn encode(&self) -> [u8; Self::LEN] {
        let mut out = [0; Self::LEN];
        out[0..8].copy_from_slice(&self.commit_start_us.to_le_bytes());
        out[8..12].copy_from_slice(&self.step_us.to_le_bytes());
        out[12..16].copy_from_slice(&self.previous_commit_us.to_le_bytes());
        out
    }

    #[cfg(test)]
    pub(crate) fn decode(bytes: &[u8]) -> Option<Self> {
        let bytes: &[u8; Self::LEN] = bytes.get(..Self::LEN)?.try_into().ok()?;
        Some(Self {
            commit_start_us: u64::from_le_bytes(bytes[0..8].try_into().ok()?),
            step_us: u32::from_le_bytes(bytes[8..12].try_into().ok()?),
            previous_commit_us: u32::from_le_bytes(bytes[12..16].try_into().ok()?),
        })
    }
}

/// A tick record: the header, then the timing block when there is one.
pub(crate) fn record(header: &Header, timing: Option<&Timing>) -> Vec<u8> {
    let mut header = *header;
    header.timed = timing.is_some();
    let mut record = header.encode().to_vec();
    if let Some(timing) = timing {
        record.extend_from_slice(&timing.encode());
    }
    record
}

/// The fixed part at the front of every tick record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Header {
    /// Which run of the simulation wrote the tick; a restart takes the next.
    pub(crate) epoch: u16,
    /// Whether the tick holds the whole match state.
    pub(crate) keyframe: bool,
    /// Whether a [`Timing`] block follows the header.
    pub(crate) timed: bool,
    pub(crate) match_number: u32,
    pub(crate) tick: u32,
}

impl Header {
    pub(crate) const LEN: usize = 12;
    const KEYFRAME: u8 = 1;
    const TIMED: u8 = 2;

    /// Little-endian: epoch (2 bytes), flags (1), reserved (1), match (4),
    /// tick (4).
    pub(crate) fn encode(&self) -> [u8; Self::LEN] {
        let mut out = [0; Self::LEN];
        out[0..2].copy_from_slice(&self.epoch.to_le_bytes());
        out[2] = if self.keyframe { Self::KEYFRAME } else { 0 }
            | if self.timed { Self::TIMED } else { 0 };
        out[4..8].copy_from_slice(&self.match_number.to_le_bytes());
        out[8..12].copy_from_slice(&self.tick.to_le_bytes());
        out
    }

    #[cfg(test)]
    pub(crate) fn decode(bytes: &[u8]) -> Option<Self> {
        let bytes: &[u8; Self::LEN] = bytes.get(..Self::LEN)?.try_into().ok()?;
        Some(Self {
            epoch: u16::from_le_bytes([bytes[0], bytes[1]]),
            keyframe: bytes[2] & Self::KEYFRAME != 0,
            timed: bytes[2] & Self::TIMED != 0,
            match_number: u32::from_le_bytes(bytes[4..8].try_into().ok()?),
            tick: u32::from_le_bytes(bytes[8..12].try_into().ok()?),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Header, Timing, record};

    #[test]
    fn round_trips() {
        let header = Header {
            epoch: 7,
            keyframe: true,
            timed: false,
            match_number: 3,
            tick: 0x0102_0304,
        };
        let bytes = header.encode();
        assert_eq!(bytes, [7, 0, 1, 0, 3, 0, 0, 0, 4, 3, 2, 1]);
        assert_eq!(Header::decode(&bytes), Some(header));
    }

    #[test]
    fn a_timed_record_carries_its_timing_after_the_header() {
        let header = Header {
            epoch: 1,
            keyframe: false,
            timed: false,
            match_number: 0,
            tick: 9,
        };
        let timing = Timing {
            commit_start_us: 1_700_000_000_000_000,
            step_us: 40,
            previous_commit_us: 2_500,
        };
        let bytes = record(&header, Some(&timing));
        assert_eq!(bytes.len(), Header::LEN + Timing::LEN);
        assert_eq!(bytes[2], 2, "the timed flag");
        assert_eq!(Header::decode(&bytes).map(|h| h.tick), Some(9));
        assert_eq!(Timing::decode(&bytes[Header::LEN..]), Some(timing));
        assert_eq!(record(&header, None).len(), Header::LEN);
    }

    #[test]
    fn short_input_is_not_a_header() {
        assert_eq!(Header::decode(&[0; 11]), None);
    }
}
